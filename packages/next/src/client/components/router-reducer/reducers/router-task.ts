import type { FlightRouterState } from '../../../../shared/lib/app-router-types'
import { invalidateBfCache } from '../../segment-cache/bfcache'
import {
  EntryStatus,
  readRouteCacheEntry,
  requestOptimisticRouteCacheEntry,
  revalidateEntireCache,
  type FulfilledRouteCacheEntry,
} from '../../segment-cache/cache'
import { createCacheKey } from '../../segment-cache/cache-key'
import {
  type NavigationSeed,
  completeHardNavigation,
  convertServerPatchToFullTree,
  navigateToKnownRoute,
} from '../../segment-cache/navigation'
import { setAppRouterState } from '../../use-action-queue'
import { createHrefFromUrl } from '../create-href-from-url'
import {
  fetchServerResponse,
  type FetchServerResponseResult,
} from '../fetch-server-response'
import { FreshnessPolicy } from '../ppr-navigations'
import {
  ACTION_HMR_REFRESH,
  ACTION_NAVIGATE,
  ACTION_REFRESH,
  ACTION_RESTORE,
  ACTION_SERVER_ACTION,
  ACTION_SERVER_PATCH,
  type AppRouterState,
  type ReducerActions,
} from '../router-reducer-types'
import {
  scheduleServerActionRequest,
  type ServerActionCall,
} from './server-action-scheduler'

type RouterTaskShared = {
  baseState: AppRouterState

  phase: RouterTaskPhase

  navigationType: NavigationType
  shouldScroll: boolean
  shouldHardNavigate: boolean
  freshness: FreshnessPolicy

  prev: RouterTask | null

  firstSquashed: RouterTask | null
  nextSquashed: RouterTask | null

  then: (onFulfilled: (state: AppRouterState) => void) => void
  status: 'pending' | 'fulfilled'
  value: AppRouterState | null
  pings: Array<(_state: AppRouterState) => void>

  debugInfo: Array<unknown> | null
}

const enum RouterTaskPhase {
  ServerAction,
  Pending,
  Ready,
}

export type ServerActionRouterTask = RouterTaskShared & {
  phase: RouterTaskPhase.ServerAction
  url: URL
  data: ServerActionCall<unknown>
  nextAction: ServerActionRouterTask | null
}

type PendingRouterTask = RouterTaskShared & {
  phase: RouterTaskPhase.Pending
  url: URL | null
  data: AbortController | null
  nextAction: null
}

type ReadyRouterTask = RouterTaskShared & {
  phase: RouterTaskPhase.Ready
  url: URL
  // If a task is marked finished, but there's no route data, then it represents
  // an MPA (hard) navigation.
  data: NavigationSeed | null
  nextAction: null
}

type RouterTask = ServerActionRouterTask | PendingRouterTask | ReadyRouterTask

// A LIFO queue of pending tasks. The algorithm for squashing multiple pending
// navigations into a single task traverses through the tasks from newest
// to oldest.
let queue: RouterTask | null = null
let didScheduleMicrotask = false

// The most recent task that finished. It may not have finished rendering yet.
let lastFinishedState: AppRouterState | null = null
// The committed state of the router. It's updated (via useEffect) once React
// has finished rendering the update. It corresponds to the current state of
// the UI.
let lastCommittedState: AppRouterState | null = null

export function initializeRouterTaskQueue(initialState: AppRouterState): void {
  lastFinishedState = initialState
}

export function setLastCommittedState(state: AppRouterState): void {
  lastCommittedState = state
}

export function getLastFinishedState(): AppRouterState | null {
  return lastFinishedState
}

export function dispatchAppRouterAction(action: ReducerActions): void {
  // TODO: We don't need to express these operations as "actions" anymore.
  // Callers should invoke requestNavigation, requestRefresh, et al directly.
  // Will do this in a separate PR so it can be reviewed separately.
  if (lastCommittedState === null) {
    return
  }
  const baseState = lastCommittedState
  switch (action.type) {
    case ACTION_NAVIGATE: {
      const shouldHardNavigate = action.isExternalUrl
      requestNavigation(
        baseState,
        action.url,
        action.navigateType,
        action.shouldScroll,
        shouldHardNavigate,
        FreshnessPolicy.Default
      )
      return
    }
    case ACTION_SERVER_PATCH: {
      const retryUrl = new URL(action.url, location.origin)
      const retrySeed = action.seed
      const shouldHardNavigate = false
      requestRefreshOfKnownRoute(
        baseState,
        retryUrl,
        shouldHardNavigate,
        FreshnessPolicy.RefreshAll,
        retrySeed
      )
      return
    }
    case ACTION_RESTORE: {
      const navigationType = 'traverse'
      requestNavigation(
        baseState,
        action.url,
        navigationType,
        false,
        false,
        FreshnessPolicy.Restore
      )
      return
    }
    case ACTION_REFRESH: {
      invalidateBfCache()
      revalidateEntireCache(baseState.nextUrl, baseState.tree)
      requestRefresh(baseState, null, false, FreshnessPolicy.RefreshAll)
      return
    }
    case ACTION_HMR_REFRESH: {
      invalidateBfCache()
      requestRefresh(baseState, null, false, FreshnessPolicy.HMRRefresh)
      return
    }
    case ACTION_SERVER_ACTION: {
      const urlOfPageToInvokeActionOn = new URL(
        baseState.canonicalUrl,
        location.origin
      )
      const serverActionTask = requestServerActionNavigation(
        baseState,
        urlOfPageToInvokeActionOn,
        action.actionId,
        action.actionArgs,
        action.resolve,
        action.reject
      )
      scheduleServerActionRequest(serverActionTask)
      return
    }
    default:
      action satisfies never
      return
  }
}

function requestRefresh(
  baseState: AppRouterState,
  url: URL | null,
  shouldHardNavigate: boolean,
  freshness: FreshnessPolicy
): RouterTask {
  const newTask = requestRouterTask(baseState) as PendingRouterTask

  newTask.phase = RouterTaskPhase.Pending
  newTask.url = url
  newTask.navigationType = 'reload'
  newTask.shouldScroll = true
  newTask.shouldHardNavigate = shouldHardNavigate
  newTask.freshness = freshness

  return newTask
}

function requestRefreshOfKnownRoute(
  baseState: AppRouterState,
  url: URL,
  shouldHardNavigate: boolean,
  freshness: FreshnessPolicy,
  seed: NavigationSeed | null
): RouterTask {
  const newTask = requestRouterTask(baseState) as ReadyRouterTask

  newTask.phase = RouterTaskPhase.Ready
  newTask.url = url
  newTask.navigationType = 'reload'
  newTask.shouldScroll = true
  newTask.shouldHardNavigate = shouldHardNavigate
  newTask.freshness = freshness

  newTask.data = seed

  return newTask
}

function requestNavigation(
  baseState: AppRouterState,
  url: URL,
  navigationType: NavigationType,
  shouldScroll: boolean,
  shouldHardNavigate: boolean,
  freshness: FreshnessPolicy
): RouterTask {
  const newTask = requestRouterTask(baseState) as PendingRouterTask

  newTask.phase = RouterTaskPhase.Pending
  newTask.url = url
  newTask.navigationType = navigationType
  newTask.shouldScroll = shouldScroll
  newTask.shouldHardNavigate = shouldHardNavigate
  newTask.freshness = freshness

  return newTask
}

function requestServerActionNavigation(
  baseState: AppRouterState,
  urlOfPageToInvokeActionOn: URL,
  actionId: string,
  actionArgs: any[],
  fulfill: (value: unknown) => void,
  reject: (error: unknown) => void
): ServerActionRouterTask {
  const newTask = requestRouterTask(baseState) as ServerActionRouterTask

  newTask.phase = RouterTaskPhase.ServerAction
  newTask.url = urlOfPageToInvokeActionOn

  const call: ServerActionCall<unknown> = {
    actionId,
    actionArgs,
    shouldDropData: false,

    fulfill,
    reject,
  }

  newTask.data = call

  return newTask
}

function requestRouterTask(baseState: AppRouterState): RouterTask {
  const pings: Array<(_state: AppRouterState) => void> = []
  const then = (ping: (_state: AppRouterState) => void) => {
    pings.push(ping)
  }
  const newTask: PendingRouterTask = {
    baseState,

    phase: RouterTaskPhase.Pending,
    data: null,
    url: null,

    navigationType: 'replace',
    shouldScroll: false,
    shouldHardNavigate: false,
    freshness: FreshnessPolicy.Restore,

    prev: null,

    firstSquashed: null,
    nextSquashed: null,

    nextAction: null,

    then,
    pings,
    status: 'pending',
    value: null,

    debugInfo: null,
  }

  if (queue !== null) {
    newTask.prev = queue
  }
  queue = newTask

  pingRouterQueue()

  // The task object itself acts like a thenable.
  const statePromise = newTask as unknown as PromiseLike<AppRouterState>
  setAppRouterState(statePromise)

  return newTask
}

export function pingRouterQueue() {
  if (didScheduleMicrotask) {
    // Already scheduled a task to process the queue
    return
  }
  didScheduleMicrotask = true
  scheduleMicrotask(performWork)
}

function performWork() {
  didScheduleMicrotask = false

  const target = resolveNavigationTarget()
  if (target === null) {
    // The queue is either suspended or empty.
    return
  }

  // We have a navigation target.
  const now = Date.now()
  const newState = performNavigation(now, target)

  lastFinishedState = newState

  fulfillRouterTask(target, newState)
}

function performNavigation(
  now: number,
  target: ReadyRouterTask
): AppRouterState {
  const navigationType = target.navigationType
  const baseState = target.baseState
  const url = target.url
  const seed = target.data
  if (seed === null || url.origin !== location.origin) {
    // This is an MPA navigation.
    return completeHardNavigation(baseState, url, navigationType)
  }
  const baseUrl = new URL(baseState.canonicalUrl, location.origin)
  const freshness = target.freshness
  if (navigationType === 'reload' && freshness === FreshnessPolicy.Restore) {
    // This is a refresh, and the freshness policy is Restore. This is
    // equivalent to a no-op. Return the base state unchanged.
    return baseState
  }
  return navigateToKnownRoute(
    now,
    baseState,
    target.url,
    createHrefFromUrl(target.url),
    seed,
    baseUrl,
    baseState.renderedSearch,
    baseState.cache,
    baseState.tree,
    freshness,
    getNextURLForNavigation(target),
    target.shouldScroll,
    navigationType,
    target.debugInfo
  )
}

function resolveNavigationTarget(): ReadyRouterTask | null {
  // Collapses the queue into a single task that represents the
  while (queue !== null) {
    const task = queue
    switch (task.phase) {
      case RouterTaskPhase.ServerAction: {
        // This is a task representing a Server Action. The action may or may
        // not result in a navigation; we don't know until we receive a response
        // from the server. Once we do, it needs to behave the same as a
        // navigation that's initiated from the client.
        return null
      }
      case RouterTaskPhase.Pending: {
        // The most recent navigation is still pending.
        const url = task.url
        if (url === null || task.navigationType === 'reload') {
          // This is a refresh. Refreshes don't affect the URL; they just
          // re-fetch the existing dynamic data.
          const prev = task.prev
          if (prev !== null) {
            // There's an earlier task in the queue. Until it finishes, we
            // don't know which URL to refresh. Squash this task into the
            // previous one. For example, if the previous task is a regular
            // navigation, the combined task will perform both a navigation and
            // a refresh.
            queue = squashNewerTaskIntoOlder(prev, task)
            continue
          } else {
            // There's no earlier pending navigation. We can upgrade this to
            // a normal replace navigation; they are semantically equivalent.
            queue = markRefreshAsReady(task)
            continue
          }
        }

        // This is a pending navigation. It has a known location, so we can
        // squash all previous tasks into this one.
        squashAllPreviousTasks(task)

        if (
          // This is an external URL.
          url.origin !== location.origin ||
          // The initiator requested a hard navigation.
          task.shouldHardNavigate
        ) {
          // Mark the task as ready without resolving the route data. This will
          // trigger a hard navigation.
          queue = markTaskAsReady(task, url, null)
          continue
        }

        // Check the prefetch cache for a matching route
        const now = Date.now()
        const nextUrl = getNextURLForNavigation(task)
        const prefetchSeed = readRouteFromPrefetchCache(now, url, nextUrl)
        if (prefetchSeed !== null) {
          // The route is cached.
          queue = markTaskAsReady(task, url, prefetchSeed)
          continue
        }

        // This is a navigation to an unknown route. We must request it from
        // the server. The navigation will suspend until the server responds.

        // Get the route for this navigation.
        const controller = task.data
        if (controller !== null) {
          // There's a pending request. We can't proceed with the navigation
          // until it finishes.
          return null
        }

        spawnRequestForUnknownRoute(task, url, nextUrl)

        return null
      }
      case RouterTaskPhase.Ready: {
        const url = task.url
        if (task.navigationType === 'reload') {
          // This is a refresh task, but it's associated with a particular URL.
          // The server sent the refresh data optimistically, but if the
          // client's location changed in the meantime, then it's no longer
          // usable; we must drop the data and refresh from scratch.
          //
          // Compare the URL of the data sent from the server to the URL of the
          // previous navigation.
          const refreshUrl = resolveURLForRefresh(task)
          if (refreshUrl === null) {
            // The rest of the queue is suspended, so we don't yet know which
            // URL to refresh.
            return null
          }
          if (refreshUrl.href !== url.href) {
            // The data sent from the server no longer matches the current URL.
            // We must discard the server data and downgrade the task to
            // a client-side refresh.
            const pendingTask = task as unknown as PendingRouterTask
            pendingTask.phase = RouterTaskPhase.Pending
            pendingTask.url = null
            pendingTask.data = null
            queue = pendingTask
            continue
          }

          // The data sent from the server matches the current URL.
          if (lastFinishedState === null) {
            return null
          }
        }

        if (task.shouldHardNavigate) {
          task.data = null
        }

        squashAllPreviousTasks(task)

        // The queue is now empty.
        queue = null

        return task
      }
      default: {
        task satisfies never
        return null
      }
    }
  }
  return null
}

export function markTaskAsReady(
  task: RouterTask,
  url: URL,
  seed: NavigationSeed | null
): ReadyRouterTask {
  const finishedTask = task as unknown as ReadyRouterTask
  finishedTask.phase = RouterTaskPhase.Ready
  finishedTask.url = url
  finishedTask.data = seed
  return finishedTask
}

export function updateTaskFreshness(
  task: RouterTask,
  freshness: FreshnessPolicy
): void {
  task.freshness = task.freshness > freshness ? task.freshness : freshness
}

function markRefreshAsReady(task: PendingRouterTask): ReadyRouterTask | null {
  // When a refresh is requested and there's no previous pending navigation in
  // the queue, we can resolve it to a known URL.
  if (lastFinishedState === null) {
    // This is only null before hydration, when it's initialized to
    // a state that represents the page load. So in practice this
    // should never be reachable.
    return null
  }
  const baseState = lastFinishedState
  const baseUrl = new URL(baseState.canonicalUrl, location.origin)
  const baseSeed = convertServerPatchToFullTree(
    baseState.tree,
    null,
    baseState.renderedSearch
  )
  const finishedTask = markTaskAsReady(task, baseUrl, baseSeed)

  // Unlike a push or replace, the base state of a refresh is the most recent
  // finished state — not the state of the UI when the refresh was requested.
  // It's a subtle difference, because a refresh could occur after the router
  // has finished the task but before React has committed the update.
  finishedTask.baseState = baseState
  finishedTask.navigationType = 'reload'

  return finishedTask
}

function resolveURLForRefresh(prevTask: RouterTask): URL | null {
  let task: RouterTask | null = prevTask
  while (task !== null) {
    switch (task.phase) {
      case RouterTaskPhase.ServerAction: {
        return null
      }
      case RouterTaskPhase.Pending: {
        const url = task.url
        if (url !== null) {
          return url
        }
        break
      }
      case RouterTaskPhase.Ready:
        if (task.navigationType !== 'reload') {
          return task.url
        }
        break
      default: {
        task satisfies never
        return null
      }
    }
    task = task.prev
  }
  // Reached the end of the queue. Refresh the "last finished" state.
  if (lastFinishedState === null) {
    return null
  }
  return new URL(lastFinishedState.canonicalUrl, location.origin)
}

function squashNewerTaskIntoOlder(
  task: RouterTask,
  newerTask: PendingRouterTask
): RouterTask {
  addToSquashedList(task, newerTask)

  updateTaskFreshness(task, newerTask.freshness)

  // Any data associated with the newer task is no longer usable.
  dropDataFromTask(newerTask)

  // Also, because it's being squashed with a newer task, data received from the
  // server as part of the previous navigation is no longer usable (with some
  // exceptions, like if the newer task is a back/forward navigation, or a
  // Server Action that results in a no-op).
  if (newerTask.freshness > FreshnessPolicy.Restore) {
    dropDataFromTask(task)
  }

  return task
}

function squashOlderTaskIntoNewer(
  task: RouterTask,
  olderTask: RouterTask
): RouterTask {
  addToSquashedList(task, olderTask)

  updateTaskFreshness(task, olderTask.freshness)

  dropDataFromTask(olderTask)

  return task
}

function squashAllPreviousTasks(parentTask: RouterTask) {
  // Disconnect all the previous tasks from the queue, and squash them into the
  // parent task.
  let prev = parentTask.prev
  while (prev !== null) {
    const prevPrev = prev.prev
    squashOlderTaskIntoNewer(parentTask, prev)
    prev = prevPrev
  }
  return parentTask
}

function dropDataFromTask(task: RouterTask) {
  switch (task.phase) {
    case RouterTaskPhase.ServerAction: {
      const call = task.data
      call.shouldDropData = true
      break
    }
    case RouterTaskPhase.Pending: {
      const controller = task.data
      if (controller !== null) {
        // Cancel the request.
        controller.abort()
      }
      break
    }
    case RouterTaskPhase.Ready: {
      const seed = task.data
      if (seed !== null) {
        task.data = dropDynamicDataFromNavigationSeed(seed)
      }
      break
    }
    default: {
      task satisfies never
      break
    }
  }
}

function addToSquashedList(parent: RouterTask, child: RouterTask) {
  if (child.prev === null) {
    // The child task is not currently in the queue, which means it already
    // finished or it was already squashed into a different task. This is a
    // defensive check; it shouldn't be reachable.
    return
  }
  // Disconnect the child task from the queue.
  child.prev = null

  // Add the child to the parent's list of squashed tasks.
  const firstSquashed = parent.firstSquashed
  if (firstSquashed !== null) {
    firstSquashed.nextSquashed = child
  }
  parent.firstSquashed = child
}

function fulfillRouterTask(task: RouterTask, state: AppRouterState) {
  fulfillRouterTaskPromise(task, state)
  let child = task.firstSquashed
  while (child !== null) {
    fulfillRouterTaskPromise(child, state)
    child = child.nextSquashed
  }
}

function fulfillRouterTaskPromise(task: RouterTask, state: AppRouterState) {
  if (task.status === 'pending') {
    task.status = 'fulfilled'
    task.value = state
    task.pings.forEach((ping) => ping(state))
  }
}

function readRouteFromPrefetchCache(
  now: number,
  url: URL,
  nextUrl: string | null
): NavigationSeed | null {
  const href = url.href

  const cacheKey = createCacheKey(href, nextUrl)
  const route = readRouteCacheEntry(now, cacheKey)
  if (route !== null && route.status === EntryStatus.Fulfilled) {
    // We have a matching prefetch.
    return convertRouteCacheEntryToNavigationSeed(route)
  }

  // There was no matching route tree in the cache. Let's see if we can
  // construct an "optimistic" route tree.
  //
  // Do not construct an optimistic route tree if there was a cache hit, but
  // the entry has a rejected status, since it may have been rejected due to a
  // rewrite or redirect based on the search params.
  //
  // TODO: There are multiple reasons a prefetch might be rejected; we should
  // track them explicitly and choose what to do here based on that.
  if (route === null || route.status !== EntryStatus.Rejected) {
    const optimisticRoute = requestOptimisticRouteCacheEntry(now, url, nextUrl)
    if (optimisticRoute !== null) {
      // We have an optimistic route tree. Proceed with the normal flow.
      return convertRouteCacheEntryToNavigationSeed(optimisticRoute)
    }
  }

  return null
}

// Used to request all the dynamic data for a route, rather than just a subset,
// e.g. during a refresh or a revalidation. Typically this gets constructed
// during the normal flow when diffing the route tree, but for an unprefetched
// navigation, where we don't know the structure of the target route, we use
// this instead.
const DynamicRequestTreeForEntireRoute: FlightRouterState = [
  '',
  {},
  null,
  'refetch',
]

function spawnRequestForUnknownRoute(
  task: PendingRouterTask,
  url: URL,
  nextUrl: string | null
) {
  fetchUnknownRoute(task, url, nextUrl).then(pingRouterQueue)
}

function getNextURLForNavigation(task: RouterTask): string | null {
  if (task.navigationType === 'reload') {
    return task.baseState.previousNextUrl
  }
  return task.baseState.nextUrl
}

export function getNextURLForServerAction(
  task: ServerActionRouterTask
): string | null {
  return task.baseState.previousNextUrl
}

async function fetchUnknownRoute(
  task: PendingRouterTask,
  url: URL,
  nextUrl: string | null
) {
  const baseState = task.baseState

  let dynamicRequestTree: FlightRouterState
  switch (task.freshness) {
    case FreshnessPolicy.Default:
    case FreshnessPolicy.Restore:
      dynamicRequestTree = baseState.tree
      break
    case FreshnessPolicy.Hydration: // <- shouldn't happen during client nav
    case FreshnessPolicy.RefreshAll:
    case FreshnessPolicy.HMRRefresh:
    case FreshnessPolicy.Unknown:
      dynamicRequestTree = DynamicRequestTreeForEntireRoute
      break
    default:
      task.freshness satisfies never
      dynamicRequestTree = baseState.tree
      break
  }

  const controller = new AbortController()
  const signal = controller.signal
  task.data = controller

  let result: FetchServerResponseResult | null = null
  try {
    result = await fetchServerResponse(url, {
      flightRouterState: dynamicRequestTree,
      nextUrl,
      signal,
    })
  } catch {}

  if (task.data !== controller || signal.aborted) {
    // The request was canceled.
    return
  }

  // The controller is no longer needed.
  task.data = null

  if (typeof result === 'string') {
    const redirectUrl = new URL(result, location.origin)
    markTaskAsReady(task, redirectUrl, null)
  } else if (result === null) {
    markTaskAsReady(task, url, null)
  } else {
    const flightData = result.flightData
    const canonicalUrl = result.canonicalUrl
    const renderedSearch = result.renderedSearch
    const debugInfo = result.debugInfo
    const seed = convertServerPatchToFullTree(
      task.baseState.tree,
      flightData,
      renderedSearch
    )
    markTaskAsReady(task, new URL(canonicalUrl, location.origin), seed)
    task.debugInfo = debugInfo
  }
}

function convertRouteCacheEntryToNavigationSeed(
  route: FulfilledRouteCacheEntry
): NavigationSeed {
  const routeTree = route.tree
  const renderedSearch = route.renderedSearch
  const prefetchSeed: NavigationSeed = {
    renderedSearch,
    routeTree,
    metadataVaryPath: route.metadata.varyPath as any,
    data: null,
    head: null,
  }
  return prefetchSeed
}

export function dropDynamicDataFromNavigationSeed(
  seed: NavigationSeed
): NavigationSeed {
  // The dynamic data associated with this server response is no longer usable,
  // usually due to a refresh or revalidation. Drop it to prevent it from being
  // used in subsequent navigations.
  return {
    data: null,
    head: null,

    // The route tree itself is not affected by a refresh. Keep it as-is.
    routeTree: seed.routeTree,
    metadataVaryPath: seed.metadataVaryPath,
    renderedSearch: seed.renderedSearch,
  }
}

const scheduleMicrotask =
  typeof queueMicrotask === 'function'
    ? queueMicrotask
    : (fn: () => unknown) =>
        Promise.resolve()
          .then(fn)
          .catch((error) =>
            setTimeout(() => {
              throw error
            })
          )
