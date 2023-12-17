import type {
  CacheNodeSeedData,
  FlightRouterState,
  FlightSegmentPath,
  Segment,
} from '../../../server/app-render/types'
import type {
  CacheNode,
  ChildSegmentMap,
  LazyCacheNode,
  ReadyCacheNode,
} from '../../../shared/lib/app-router-context.shared-runtime'
import { matchSegment } from '../match-segments'
import { createRouterCacheKey } from './create-router-cache-key'
import type { FetchServerResponseResult } from './fetch-server-response'

// This is yet another tree type that is used to track pending promises that
// need to be fulfilled once the dynamic data is received. The terminal nodes of
// this tree represent the new Cache Node trees that were created during this
// request. We can't use the Cache Node tree or Route State tree directly
// because those include reused nodes, too. This tree is discarded as soon as
// the navigation response is received.
type Task = {
  route: FlightRouterState
  node: CacheNode
  children: Map<string, Task> | null
}

// Creates a new Cache Node tree (i.e. copy-on-write) that represents the
// optimistic result of a navigation, using both the current Cache Node tree and
// data that was prefetched prior to navigation.
//
// At the moment we call this function, we haven't yet received the navigation
// response from the server. It could send back something completely different
// from the tree that was prefetched — due to rewrites, default routes, parallel
// routes, etc.
//
// But in most cases, it will return the same tree that we prefetched, just with
// the dynamic holes filled in. So we optimistically assume this will happen,
// and accept that the real result could be arbitrarily different.
//
// We'll reuse anything that was already in the previous tree, since that's what
// the server does.
//
// New segments (ones that don't appear in the old tree) are assigned an
// unresolved promise. The data for these promises will be fulfilled later, when
// the navigation response is received.
//
// The tree can be rendered immediately after it is created (that's why this is
// a synchronous function). Any new trees that do not have prefetch data will
// suspend during rendering, until the dynamic data streams in.
//
// Returns a Task object, which contains both the updated Cache Node and a path
// to the pending subtrees that need to be resolved by the navigation response.
//
// A return value of `null` means there were no changes, and the previous tree
// can be reused without initiating a server request.
export function updateCacheNodeOnNavigation(
  oldCacheNode: CacheNode,
  oldRouterState: FlightRouterState,
  newRouterState: FlightRouterState,
  prefetchData: CacheNodeSeedData
): Task | null {
  // Diff the old and new trees to reuse the shared layouts.
  const oldRouterStateChildren = oldRouterState[1]
  const newRouterStateChildren = newRouterState[1]
  const prefetchDataChildren = prefetchData[1]

  const oldParallelRoutes = oldCacheNode.parallelRoutes

  // Clone the current set of segment children, even if they aren't active in
  // the new tree.
  // TODO: We currently retain all the inactive segments indefinitely, until
  // there's an explicit refresh, or a parent layout is lazily refreshed. We
  // rely on this for popstate navigations, which update the Router State Tree
  // but do not eagerly perform a data fetch, because they expect the segment
  // data to already be in the Cache Node tree. For highly static sites that
  // are mostly read-only, this may happen only rarely, causing memory to
  // leak. We should figure out a better model for the lifetime of inactive
  // segments, so we can maintain instant back/forward navigations without
  // leaking memory indefinitely.
  const prefetchParallelRoutes = new Map(oldParallelRoutes)

  let taskChildren = null
  for (let parallelRouteKey in newRouterStateChildren) {
    const newRouterStateChild: FlightRouterState =
      newRouterStateChildren[parallelRouteKey]
    const oldRouterStateChild: FlightRouterState | void =
      oldRouterStateChildren[parallelRouteKey]
    const oldSegmentMapChild = oldParallelRoutes.get(parallelRouteKey)
    const prefetchDataChild: CacheNodeSeedData | void | null =
      prefetchDataChildren[parallelRouteKey]

    const newSegmentChild = newRouterStateChild[0]
    const newSegmentKeyChild = createRouterCacheKey(newSegmentChild)

    const oldCacheNodeChild =
      oldSegmentMapChild !== undefined
        ? oldSegmentMapChild.get(newSegmentKeyChild)
        : undefined

    let taskChild: Task | null
    if (
      oldRouterStateChild !== undefined &&
      matchSegment(newSegmentChild, oldRouterStateChild[0])
    ) {
      if (oldCacheNodeChild !== undefined) {
        // This segment exists in both the old and new trees.
        if (prefetchDataChild !== undefined && prefetchDataChild !== null) {
          // Recursively update the children.
          taskChild = updateCacheNodeOnNavigation(
            oldCacheNodeChild,
            oldRouterStateChild,
            newRouterStateChild,
            prefetchDataChild
          )
        } else {
          // The server didn't send any prefetch data for this segment. This
          // shouldn't happen because the Route Tree and the Seed Data tree
          // should always be the same shape, but until we unify those types
          // it's still possible. For now we're going to deopt and trigger a
          // lazy fetch during render. The main case I'm aware of where this
          // happens is default pages.
          // TODO: Special case default pages for now?
          const missingChild: LazyCacheNode = {
            lazyData: null,
            rsc: null,
            prefetchRsc: null,
            head: null,
            parallelRoutes: new Map(),
          }
          taskChild = {
            route: newRouterStateChild,
            node: missingChild,
            children: null,
          }
        }
      } else {
        // This segment exists in both the old and the new Router State Tree,
        // but there's no existing Cache Node for it. The server likely won't
        // send any data for it.
        const missingChild: LazyCacheNode = {
          lazyData: null,
          rsc: null,
          prefetchRsc: null,
          head: null,
          parallelRoutes: new Map(),
        }
        taskChild = {
          route: newRouterStateChild,
          node: missingChild,
          children: null,
        }
      }
    } else {
      // This segment doesn't exist in the current Router State tree. Switch to
      // the "create" path.
      const pendingCacheNode = createPendingCacheNode(
        newRouterStateChild,
        prefetchDataChild !== undefined ? prefetchDataChild : null
      )
      const newTask: Task = {
        route: newRouterStateChild,
        node: pendingCacheNode,
        children: null,
      }
      taskChild = newTask
    }

    if (taskChild !== null) {
      if (taskChildren === null) {
        taskChildren = new Map()
      }
      taskChildren.set(parallelRouteKey, taskChild)

      const newCacheNodeChild = taskChild.node
      const newSegmentMapChild: ChildSegmentMap = new Map(oldSegmentMapChild)
      newSegmentMapChild.set(newSegmentKeyChild, newCacheNodeChild)
      prefetchParallelRoutes.set(parallelRouteKey, newSegmentMapChild)
    }
  }

  if (taskChildren === null) {
    // No new tasks were spawned.
    return null
  }

  const newCacheNode: ReadyCacheNode = {
    lazyData: null,
    rsc: oldCacheNode.rsc,
    // We intentionally aren't updating the prefetchRsc field, since this node
    // is already part of the current tree, because it would be weird for
    // prefetch data to be newer than the final data. It probably won't ever be
    // observable anyway, but it could happen if the segment is unmounted then
    // mounted again, because LayoutRouter will momentarily switch to rendering
    // prefetchRsc, via useDeferredValue.
    prefetchRsc: oldCacheNode.prefetchRsc,
    head: oldCacheNode.head,

    // Everything is cloned except for the children, which we computed above.
    parallelRoutes: prefetchParallelRoutes,
  }

  return {
    route: newRouterState,
    node: newCacheNode,
    children: taskChildren,
  }
}

export function listenForDynamicRequest(
  task: Task,
  responsePromise: Promise<FetchServerResponseResult>
) {
  responsePromise.then(
    (response: FetchServerResponseResult) => {
      const flightData = response[0]
      if (flightData.length !== 1) {
        const error = new Error('Unexpected server response')
        abortTask(task, error)
        return
      }
      const flightDataPath = flightData[0]
      const segmentPath = flightDataPath.slice(0, -3)
      const serverRouterState = flightDataPath[flightDataPath.length - 3]
      const dynamicData = flightDataPath[flightDataPath.length - 2]
      // TODO: The head could postpone but we don't currently handle
      // that case. Right now it remains on the prefetched version and
      // does not update if there are dynamic holes.
      // const head = flightDataPath[flightDataPath.length - 1]

      if (typeof segmentPath === 'string') {
        // Happens when navigating to page in `pages` from `app`. We shouldn't
        // get here because would have already handled this during the prefetch.
        // But if we do, trigger a lazy fetch and fix it there.
        abortTask(task, null)
        return
      }

      finishTaskUsingDynamicServerResponse(
        task,
        segmentPath,
        serverRouterState,
        dynamicData
      )
    },
    (error: any) => {
      // This will trigger an error during render
      abortTask(task, error)
    }
  )
}

// Writes a dynamic server response into the tree created by
// updateCacheNodeOnNavigation. All pending promises that were spawned by the
// navigation will be resolved, either with dynamic data from the server, or
// `null` to indicate that the data is missing.
//
// A `null` value will trigger a lazy fetch during render, which will then patch
// up the tree using the same mechanism as the non-PPR implementation
// (serverPatchReducer).
//
// Usually, the server will respond with exactly the subset of data that we're
// waiting for — everything below the nearest shared layout. But technically,
// the server can return anything it wants.
//
// This does _not_ create a new tree; it modifies the existing one in place.
// Which means it must follow the Suspense rules of cache safety.
export function finishTaskUsingDynamicServerResponse(
  rootTask: Task,
  segmentPath: FlightSegmentPath,
  serverRouterState: FlightRouterState,
  dynamicData: CacheNodeSeedData
) {
  // The data sent by the server represents only a subtree of the app. We need
  // to find the part of the task tree that matches the server response, and
  // abort any sibling tasks that may exist outside that subtree.
  //
  // segmentPath represents the parent path of subtree. It's a repeating pattern
  // of parallel route key and segment:
  //
  //   [string, Segment, string, Segment, string, Segment, ...]
  //
  // Iterate through the path and abort all the sibling tasks that don't match.
  let task = rootTask
  for (let i = 0; i < segmentPath.length; i += 2) {
    const parallelRouteKey: string = segmentPath[i]
    const segment: Segment = segmentPath[i + 1]
    const taskChildren = task.children
    if (taskChildren === null) {
      // There are still segments remaining in the path, which means the
      // server sent back only a subset of the data we were missing. Since
      // this should never happen, and we won't be able to render the nested
      // data regardless because a parent is missing, we'll abort the rest of
      // this subtree.
      abortTask(task, null)
      return
    }
    let matchingTask = null
    for (const [parallelRouteKeyChild, taskChild] of taskChildren) {
      const taskSegment = taskChild.route[0]
      if (
        parallelRouteKeyChild === parallelRouteKey &&
        matchSegment(segment, taskSegment)
      ) {
        // Even though there can be only one match, we keep iterating through
        // the children so we can abort the sibling tasks.
        matchingTask = taskChild
      } else {
        abortTask(taskChild, null)
      }
    }
    if (matchingTask === null) {
      // Everyting was aborted. We didn't find any child task that matches.
      return
    }
    // Keep traversing down the task tree
    task = matchingTask
  }

  // The server returned more data than we need to finish the task. Skip over
  // the extra segments until we reach the leaf task node.
  finishTaskUsingDynamicDataPayload(serverRouterState, dynamicData, task)
}

function finishTaskUsingDynamicDataPayload(
  serverRouterState: FlightRouterState,
  dynamicData: CacheNodeSeedData,
  task: Task
) {
  // dynamicData may represent a larger subtree than the task. Before we can
  // finish the task, we need to line them up.
  const taskChildren = task.children
  if (taskChildren === null) {
    // We've reached the leaf node of the pending task. We can now switch to
    // the normal algorithm.
    finishTask(task, dynamicData)
    return
  }
  // The server returned more data than we need to finish the task. Skip over
  // the extra segments until we reach the leaf task node.
  const serverChildren = serverRouterState[1]
  const dynamicDataChildren = dynamicData[1]
  for (const [parallelRouteKey, taskChild] of taskChildren) {
    const serverChild: FlightRouterState | void =
      serverChildren[parallelRouteKey]
    const dynamicDataChild: CacheNodeSeedData | null | void =
      dynamicDataChildren[parallelRouteKey]
    if (serverChild !== undefined && dynamicDataChild !== undefined) {
      const serverSegmentChild = serverChild[0]
      const taskSegmentChild = taskChild.route[0]
      if (matchSegment(serverSegmentChild, taskSegmentChild)) {
        // Keep traversing until we reach the leaf task node.
        finishTaskUsingDynamicDataPayload(serverChild, dynamicData, taskChild)
      } else {
        // We didn't receive any data for this segment.
        abortTask(taskChild, null)
      }
    } else {
      // We didn't receive any data for this segment.
      abortTask(taskChild, null)
    }
  }
}

function createPendingCacheNode(
  routerState: FlightRouterState,
  prefetchData: CacheNodeSeedData | null
): ReadyCacheNode {
  const routerStateChildren = routerState[1]
  const prefetchDataChildren = prefetchData !== null ? prefetchData[1] : null

  const parallelRoutes = new Map()
  for (let parallelRouteKey in routerStateChildren) {
    const routerStateChild: FlightRouterState =
      routerStateChildren[parallelRouteKey]
    const prefetchDataChild: CacheNodeSeedData | null | void =
      prefetchDataChildren !== null
        ? prefetchDataChildren[parallelRouteKey]
        : null

    const segmentChild = routerStateChild[0]
    const segmentKeyChild = createRouterCacheKey(segmentChild)

    const newCacheNodeChild = createPendingCacheNode(
      routerStateChild,
      prefetchDataChild === undefined ? null : prefetchDataChild
    )

    const newSegmentMapChild: ChildSegmentMap = new Map()
    newSegmentMapChild.set(segmentKeyChild, newCacheNodeChild)
    parallelRoutes.set(parallelRouteKey, newSegmentMapChild)
  }

  const maybePrefetchRsc = prefetchData !== null ? prefetchData[2] : null

  return {
    lazyData: null,
    parallelRoutes: parallelRoutes,
    head: null,

    prefetchRsc: maybePrefetchRsc === undefined ? null : maybePrefetchRsc,

    // Create a deferred promise. This will be fulfilled once the dynamic
    // response is received from the server.
    rsc: createDeferredRsc(),
  }
}

function finishPendingCacheNode(
  routerState: FlightRouterState,
  cacheNode: CacheNode,
  dynamicData: CacheNodeSeedData
): void {
  // Writes a dynamic response into an existing Cache Node tree. This does _not_
  // create a new tree, it updates the existing tree in-place. So it must follow
  // the Suspense rules of cache safety — it can resolve pending promises, but
  // it cannot overwrite existing data. It can add segments to the tree (because
  // a missing segment will cause the layout router to suspend).
  // but it cannot delete them.
  //
  // We must resolve every promise in the tree, or else it will suspend
  // indefinitely. If we did not receive data for a segment, we will resolve its
  // data promise to `null` to trigger a lazy fetch during render.
  const routerStateChildren = routerState[1]
  const dynamicDataChildren = dynamicData[1]

  // The router state that we traverse the tree with is the same one that we
  // used to construct the pending Cache Node tree. That way we're sure to
  // resolve all the pending promises.
  const parallelRoutes = cacheNode.parallelRoutes
  for (let parallelRouteKey in routerStateChildren) {
    const routerStateChild: FlightRouterState =
      routerStateChildren[parallelRouteKey]
    const dynamicDataChild: CacheNodeSeedData | null | void =
      dynamicDataChildren[parallelRouteKey]
    const segmentMapChild = parallelRoutes.get(parallelRouteKey)
    if (segmentMapChild === undefined) {
      // This shouldn't happen because we're traversing the same tree that was
      // used to construct the cache nodes in the first place. Since we're
      // skipping over it, if we do reach this case for some reason, it will
      // trigger a lazy fetch during render.
      continue
    }

    const segmentChild = routerStateChild[0]
    const segmentKeyChild = createRouterCacheKey(segmentChild)

    const cacheNodeChild = segmentMapChild.get(segmentKeyChild)
    if (cacheNodeChild !== undefined) {
      if (
        dynamicDataChild !== undefined &&
        dynamicDataChild !== null &&
        matchSegment(segmentChild, dynamicDataChild[0])
      ) {
        // This is the happy path. Recursively update all the children.
        finishPendingCacheNode(
          routerStateChild,
          cacheNodeChild,
          dynamicDataChild
        )
      } else {
        // The server never returned data for this segment. Trigger a lazy
        // fetch during render.
        abortPendingCacheNode(routerStateChild, cacheNodeChild, null)
      }
    } else {
      // There's no matching child cache node in the prefetched tree.
      if (
        dynamicDataChild !== null &&
        dynamicDataChild !== undefined &&
        matchSegment(segmentChild, dynamicDataChild[0])
      ) {
        // But we did receive data for it. Create a new cache node now.
        const newCacheNodeChild = createFinishedCacheNode(
          routerStateChild,
          dynamicDataChild
        )
        segmentMapChild.set(segmentKeyChild, newCacheNodeChild)
      } else {
        // The Cache Node tree is missing a segment. This will trigger a lazy
        // fetch during render.
      }
    }
  }

  // Use the dynamic data from the server to fulfill the deferred RSC promise
  // on the Cache Node.
  const rsc = cacheNode.rsc
  const dynamicSegmentData = dynamicData[2]
  if (rsc === null) {
    // This is a lazy cache node. We can overwrite it. This is only safe
    // because we know that the LayoutRouter suspends if `rsc` is `null`.
    cacheNode.rsc = dynamicSegmentData
  } else if (isDeferredRsc(rsc)) {
    // This is a deferred RSC promise. We can fulfill it with the data we just
    // received from the server. If it was already resolved by a different
    // navigation, then this does nothing because we can't overwrite data.
    rsc.resolve(dynamicSegmentData)
  } else {
    // This is not a deferred RSC promise, nor is it empty, so it must have
    // been populated by a different navigation. We must not overwrite it.
  }
}

function createFinishedCacheNode(
  routerState: FlightRouterState,
  dynamicData: CacheNodeSeedData
): ReadyCacheNode {
  // This creates brand new Cache Node tree and fills it in with dynamic data
  // from the server. We use this path when receiving dynamic data for a segment
  // that was not prefetched.
  const routerStateChildren = routerState[1]
  const dynamicDataChildren = dynamicData[1]

  const parallelRoutes = new Map()
  for (let parallelRouteKey in routerStateChildren) {
    const routerStateChild: FlightRouterState =
      routerStateChildren[parallelRouteKey]
    const dynamicDataChild: CacheNodeSeedData | null | void =
      dynamicDataChildren !== null
        ? dynamicDataChildren[parallelRouteKey]
        : null

    const segmentChild = routerStateChild[0]
    const segmentKeyChild = createRouterCacheKey(segmentChild)

    const newCacheNodeChild =
      dynamicDataChild !== null && dynamicDataChild !== undefined
        ? createFinishedCacheNode(routerStateChild, dynamicDataChild)
        : // No data was provided for the child segment. This will trigger a
          // lazy fetch during render.
          {
            lazyData: null,
            parallelRoutes: parallelRoutes,
            head: null,
            prefetchRsc: null,
            rsc: null,
          }

    const newSegmentMapChild: ChildSegmentMap = new Map()
    newSegmentMapChild.set(segmentKeyChild, newCacheNodeChild)
    parallelRoutes.set(parallelRouteKey, newSegmentMapChild)
  }

  return {
    lazyData: null,
    parallelRoutes: parallelRoutes,
    head: null,
    prefetchRsc: null,
    rsc: dynamicData[2],
  }
}

export function abortTask(task: Task, error: any): void {
  abortPendingCacheNode(task.route, task.node, error)
}

function finishTask(task: Task, dynamicData: CacheNodeSeedData): void {
  finishPendingCacheNode(task.route, task.node, dynamicData)
}

function abortPendingCacheNode(
  routerState: FlightRouterState,
  cacheNode: CacheNode,
  error: any
): void {
  // For every pending segment in the tree, resolve its `rsc` promise to `null`
  // to trigger a lazy fetch during render.
  //
  // Or, if an error object is provided, it will error instead.
  const routerStateChildren = routerState[1]
  const parallelRoutes = cacheNode.parallelRoutes
  for (let parallelRouteKey in routerStateChildren) {
    const routerStateChild: FlightRouterState =
      routerStateChildren[parallelRouteKey]
    const segmentMapChild = parallelRoutes.get(parallelRouteKey)
    if (segmentMapChild === undefined) {
      // This shouldn't happen because we're traversing the same tree that was
      // used to construct the cache nodes in the first place.
      continue
    }
    const segmentChild = routerStateChild[0]
    const segmentKeyChild = createRouterCacheKey(segmentChild)
    const cacheNodeChild = segmentMapChild.get(segmentKeyChild)
    if (cacheNodeChild !== undefined) {
      abortPendingCacheNode(routerStateChild, cacheNodeChild, error)
    } else {
      // This shouldn't happen because we're traversing the same tree that was
      // used to construct the cache nodes in the first place.
    }
  }
  const rsc = cacheNode.rsc
  if (isDeferredRsc(rsc)) {
    if (error === null) {
      // This will trigger a lazy fetch during render.
      rsc.resolve(null)
    } else {
      // This will trigger an error during rendering.
      rsc.reject(error)
    }
  }
}

const DEFERRED = Symbol()

type PendingDeferredRsc = Promise<React.ReactNode> & {
  status: 'pending'
  resolve: (value: React.ReactNode) => void
  reject: (error: any) => void
  tag: Symbol
}

type FulfilledDeferredRsc = Promise<React.ReactNode> & {
  status: 'fulfilled'
  value: React.ReactNode
  resolve: (value: React.ReactNode) => void
  reject: (error: any) => void
  tag: Symbol
}

type RejectedDeferredRsc = Promise<React.ReactNode> & {
  status: 'rejected'
  reason: any
  resolve: (value: React.ReactNode) => void
  reject: (error: any) => void
  tag: Symbol
}

type DeferredRsc =
  | PendingDeferredRsc
  | FulfilledDeferredRsc
  | RejectedDeferredRsc

// This type exists to distinguish a DeferredRsc from a Flight promise. It's a
// compromise to avoid adding an extra field on every Cache Node, which would be
// awkward because the pre-PPR parts of codebase would need to account for it,
// too. We can remove it once type Cache Node type is more settled.
function isDeferredRsc(value: any): value is DeferredRsc {
  return value && value.tag === DEFERRED
}

function createDeferredRsc(): PendingDeferredRsc {
  let resolve: any
  let reject: any
  const pendingRsc = new Promise<React.ReactNode>((res) => {
    resolve = res
  }) as PendingDeferredRsc
  pendingRsc.status = 'pending'
  pendingRsc.resolve = (value: React.ReactNode) => {
    if (pendingRsc.status === 'pending') {
      const fulfilledRsc: FulfilledDeferredRsc = pendingRsc as any
      fulfilledRsc.status = 'fulfilled'
      fulfilledRsc.value = value
      resolve(value)
    }
  }
  pendingRsc.reject = (error: any) => {
    if (pendingRsc.status === 'pending') {
      const rejectedRsc: RejectedDeferredRsc = pendingRsc as any
      rejectedRsc.status = 'rejected'
      rejectedRsc.reason = error
      reject(error)
    }
  }
  pendingRsc.tag = DEFERRED
  return pendingRsc
}
