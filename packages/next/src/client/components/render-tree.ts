import { use, useDeferredValue } from 'react'
import { unresolvedThenable } from './unresolved-thenable'
import type {
  FlightRouterState,
  Segment,
} from '../../shared/lib/app-router-types'
import type { CacheNode } from '../../shared/lib/app-router-types'
import type { ScrollRef } from '../../shared/lib/app-router-types'
import { PrefetchHint } from '../../shared/lib/app-router-types'
import {
  DEFAULT_SEGMENT_KEY,
  NOT_FOUND_SEGMENT_KEY,
  PAGE_SEGMENT_KEY,
} from '../../shared/lib/segment'
import { HEAD_REQUEST_KEY } from '../../shared/lib/segment-cache/segment-value-encoding'
import { createHrefFromUrl } from './router-reducer/create-href-from-url'
import { fetchServerResponse } from './router-reducer/fetch-server-response'
import { dispatchAppRouterAction } from './use-action-queue'
import {
  ACTION_SERVER_PATCH,
  type ServerPatchAction,
} from './router-reducer/router-reducer-types'
import { isNavigatingToNewRootLayout } from './router-reducer/is-navigating-to-new-root-layout'
import { getLastCommittedRoot } from './router-reducer/reducers/committed-state'
import {
  createNavigationSeed,
  createNavigationSeedFromRouteTree,
  type NavigationSeed,
} from './segment-cache/decode-server-response'
import {
  segmentCacheMap,
  type SegmentCacheEntry,
  type RouteTree,
  type RootRouteTree,
  type RSCSegmentData,
  type RefreshState,
  type FulfilledRouteCacheEntry,
  createRootRouteTree,
  rebaseInactiveRouteTree,
  doesRouteStructureMatch,
  readSegmentCacheEntryForNavigation,
  waitForSegmentCacheEntry,
  invalidateRouteCacheEntries,
  spawnStaticStageCacheWrite,
  writeRuntimePrefetchStreamIntoCache,
  EntryStatus,
  MetadataOnlyRequestTree,
} from './segment-cache/cache'
import { discoverKnownRoute } from './segment-cache/optimistic-routes'
import type { NormalizedSearch } from './segment-cache/cache-key'
import type { CacheMap } from './segment-cache/cache-map'
import {
  getRenderedSearchFromVaryPath,
  compareParams,
  ParamsChange,
  didReadChangedParam,
} from './segment-cache/vary-path'
import {
  readFromBFCache,
  readFromBFCacheDuringRegularNavigation,
  writeToBFCache,
  computeDynamicStaleAt,
} from './segment-cache/bfcache'
import type { VaryParams } from '../../shared/lib/segment-cache/vary-params-decoding'

export const enum FreshnessPolicy {
  Default,
  Hydration,
  HistoryTraversal,
  RefreshAll,
  HMRRefresh,
  Gesture,
}

/**
 * When a navigation's requests finish, there may or may not be data still
 * missing, necessitating a retry.
 */
const enum NavigationTaskExitStatus {
  /**
   * The request was superseded by a newer navigation and aborted. No retry is
   * needed; the newer request owns the tree from here.
   */
  Canceled = -1,
  /**
   * No additional navigation is required.
   */
  Done = 0,
  /**
   * Some data failed to load, presumably due to a route tree mismatch. Perform
   * a soft retry to reload the entire tree (re-fetching the dynamic data).
   */
  SoftRetry = 1,
  /**
   * Some data failed to load in an unrecoverable way, e.g. in an inactive
   * parallel route. Fall back to a hard (MPA-style) retry.
   */
  HardRetry = 2,
  /**
   * The route tree matched, but the request was redirected, so the navigation
   * committed the wrong canonical URL. The route cache is no longer reliable
   * (the redirect implies a server change the prediction couldn't account for),
   * so we re-resolve the route — but the data we already received is correct, so
   * the retry reuses it instead of re-fetching.
   */
  RedirectRetry = 3,
}

export type NavigationRequestAccumulation = {
  /**
   * Set when a navigation creates new leaf segments that should be
   * scrolled to. Stays null when no new segments are created (e.g.
   * during a refresh where the route structure didn't change).
   */
  scrollRef: ScrollRef | null
}

/**
 * A locked navigation's withheld-data gate, for the Instant Navigation Testing
 * API. Captured — as an immutable promise — when the navigation begins (via
 * `beginLockedNavigation`) or when router work spawns a dynamic write outside
 * a navigation (via `getCurrentNavigationLock`), and threaded to the write,
 * which awaits it before applying dynamic data. Resolves when a newer locked
 * navigation begins or the lock is released. Because the capture happens at
 * spawn time, a newer navigation's rollover releases this write rather than
 * re-gating it. Threaded as `NavigationLock | null`; null whenever the testing
 * API is not active.
 */
export type NavigationLock = Promise<void>

/**
 * One request for the data a render tree is missing, to one URL. It exists
 * before its request tree is derived, so the component data the derivation
 * flips to pending can name it as owner; the fetch starts once the tree is
 * derived, and a request whose tree has nothing to fetch is discarded.
 */
export type DynamicRequest = {
  url: URL
  nextUrl: string | null
  /** The fetch's outcome. Null until the fetch starts. */
  promise: Promise<DynamicRequestResult> | null
}

type DynamicRequestResult = {
  exitStatus: NavigationTaskExitStatus
  url: URL
  seed: NavigationSeed | null
}

function createDynamicRequest(
  url: URL,
  nextUrl: string | null
): DynamicRequest {
  return { url, nextUrl, promise: null }
}

const noop = () => {}

export function createInitialRenderTreeForHydration(
  navigatedAt: number,
  initialRoot: RootRouteTree<RSCSegmentData | null>,
  seedDynamicStaleAt: number
): RootRouteTree<CacheNode> {
  // Create the initial cache node tree, using the data embedded into the
  // HTML document.
  const accumulation: NavigationRequestAccumulation = {
    scrollRef: null,
  }
  const restrictToShell = false
  // Hydration is bound to the shared map.
  const map = segmentCacheMap
  const tree = createRenderTreeOnNavigation(
    navigatedAt,
    initialRoot.tree,
    FreshnessPolicy.Hydration,
    seedDynamicStaleAt,
    accumulation,
    map,
    restrictToShell
  )
  const head = createRenderTreeOnNavigation(
    navigatedAt,
    initialRoot.head,
    FreshnessPolicy.Hydration,
    seedDynamicStaleAt,
    accumulation,
    map,
    restrictToShell
  )
  return createRootRouteTree(tree, head)
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
// New segments (ones that don't appear in the old tree) are assigned empty
// component data. The data will be fulfilled later, when the navigation
// response is received (see spawnDynamicRequests).
//
// The tree can be rendered immediately after it is created (that's why this is
// a synchronous function). Any new trees that do not have prefetch data will
// suspend during rendering, until the dynamic data streams in.
//
// Returns the render trees for the route tree and the head.
//
// A return value of `null` means a full-page (MPA) navigation is required.
export function startPPRNavigation(
  navigatedAt: number,
  oldUrl: URL,
  oldRenderedSearch: string,
  oldRoot: RootRouteTree<CacheNode>,
  newRoot: RootRouteTree<RSCSegmentData | null>,
  freshness: FreshnessPolicy,
  seedDynamicStaleAt: number,
  isSamePageNavigation: boolean,
  accumulation: NavigationRequestAccumulation,
  // The segment cache map this navigation is bound to: a locked navigation's
  // driving-task map, or the shared map. See `segmentCacheMap` in cache.ts.
  map: CacheMap<SegmentCacheEntry>,
  // Instant Navigation Testing API only — restricts segment reads to shell
  // entries. Always false outside the testing API. See navigation-testing-lock.
  restrictToShell: boolean
): RootRouteTree<CacheNode> | null {
  const parentRefreshState = null
  const oldRootRefreshState: RefreshState = {
    canonicalUrl: createHrefFromUrl(oldUrl),
    renderedSearch: oldRenderedSearch as NormalizedSearch,
  }
  const tree = updateRenderTreeOnNavigation(
    navigatedAt,
    oldRoot.tree,
    newRoot.tree,
    freshness,
    seedDynamicStaleAt,
    isSamePageNavigation,
    oldRootRefreshState,
    parentRefreshState,
    accumulation,
    map,
    restrictToShell
  )
  if (tree === null) {
    // The route tree changed at or above the root layout. Perform a full-page
    // navigation.
    return null
  }
  const head = updateRenderTreeOnNavigation(
    navigatedAt,
    oldRoot.head,
    newRoot.head,
    freshness,
    seedDynamicStaleAt,
    isSamePageNavigation,
    oldRootRefreshState,
    parentRefreshState,
    accumulation,
    map,
    restrictToShell
  )
  if (head === null) {
    // Unreachable: a one-node tree has no root layout to change and no slots.
    return null
  }
  return createRootRouteTree(tree, head)
}

function updateRenderTreeOnNavigation(
  navigatedAt: number,
  oldRenderTree: RouteTree<CacheNode>,
  newRouteTree: RouteTree<RSCSegmentData | null>,
  freshness: FreshnessPolicy,
  seedDynamicStaleAt: number,
  isSamePageNavigation: boolean,
  oldRootRefreshState: RefreshState,
  parentRefreshState: RefreshState | null,
  accumulation: NavigationRequestAccumulation,
  map: CacheMap<SegmentCacheEntry>,
  // Instant Navigation Testing API only — restricts segment reads to shell
  // entries. Always false outside the testing API. See navigation-testing-lock.
  restrictToShell: boolean
): RouteTree<CacheNode> | null {
  // Check if the route structure changed. If only the params changed, that's
  // handled further down.
  const newSegment = newRouteTree.segment
  if (!doesRouteStructureMatch(oldRenderTree, newRouteTree)) {
    // This segment does not match the previous route. We're now entering the
    // new part of the target route. Switch to the "create" path.
    if (
      // Check if the route tree changed before we reached a layout. (The
      // highest-level layout in a route tree is referred to as the "root"
      // layout.) This could mean that we're navigating between two different
      // root layouts. When this happens, we perform a full-page (MPA-style)
      // navigation.
      //
      // However, the algorithm for deciding where to start rendering a route
      // (i.e. the one performed in order to reach this function) is stricter
      // than the one used to detect a change in the root layout. So just
      // because we're re-rendering a segment outside of the root layout does
      // not mean we should trigger a full-page navigation.
      //
      // Specifically, we handle dynamic parameters differently: two segments
      // are considered the same even if their parameter values are different.
      //
      // Refer to isNavigatingToNewRootLayout for details.
      //
      // Note that we only have to perform this extra traversal if this changed
      // segment is still at or above the root layout (IsRootLayoutOrAbove);
      // once we've descended past the root layout, a segment change can't alter
      // the root layout. We also only need to compare the subtree that is not
      // shared. In the common case, this branch is skipped completely.
      ((newRouteTree.prefetchHints & PrefetchHint.IsRootLayoutOrAbove) !== 0 &&
        isNavigatingToNewRootLayout(oldRenderTree, newRouteTree)) ||
      // The global Not Found route (app/global-not-found.tsx) is a special
      // case, because it acts like a root layout, but in the router tree, it
      // is rendered in the same position as app/layout.tsx.
      //
      // Any navigation to the global Not Found route should trigger a
      // full-page navigation.
      //
      // TODO: We should probably model this by changing the key of the root
      // segment when this happens. Then the root layout check would work
      // as expected, without a special case.
      newSegment === NOT_FOUND_SEGMENT_KEY
    ) {
      return null
    }
    return createRenderTreeOnNavigation(
      navigatedAt,
      newRouteTree,
      freshness,
      seedDynamicStaleAt,
      accumulation,
      map,
      restrictToShell
    )
  }

  const newSlots = newRouteTree.slots

  let shouldRefreshDynamicData: boolean = false
  switch (freshness) {
    case FreshnessPolicy.Default:
    case FreshnessPolicy.HistoryTraversal:
    case FreshnessPolicy.Hydration:
    case FreshnessPolicy.Gesture:
      shouldRefreshDynamicData = false
      break
    case FreshnessPolicy.RefreshAll:
    case FreshnessPolicy.HMRRefresh:
      shouldRefreshDynamicData = true
      break
    default:
      freshness satisfies never
      break
  }

  const isLeafSegment = newSlots === null

  // Get the data for this segment. Since it was part of the previous route,
  // usually we just reuse the data from the old render tree. If the params
  // changed, or during a refresh or revalidation, consult the prefetch cache
  // or response seed instead.
  let newRenderTree: RouteTree<CacheNode>
  const paramsChange = compareParams(
    oldRenderTree.varyPath,
    newRouteTree.varyPath
  )
  if (paramsChange !== ParamsChange.None) {
    // Path params are part of LayoutRouter's React key, so changing one
    // remounts this segment and everything below it. Generate a new bfcacheId
    // to match. Search params aren't part of the key, so a page whose search
    // params changed keeps its existing id.
    let bfcacheId: number
    if (paramsChange === ParamsChange.PathParam) {
      bfcacheId = generateBFCacheId(freshness)
    } else {
      bfcacheId = oldRenderTree.data.bfcacheId
    }
    switch (freshness) {
      case FreshnessPolicy.Default:
      case FreshnessPolicy.Gesture: {
        // If the existing data didn't read any of the params that changed, we
        // can keep using it. Refreshes always fetch new data, and back/forward
        // navigations restore the entry from the BFCache instead.
        const oldCacheNode = oldRenderTree.data
        const oldRsc = oldCacheNode.rsc
        if (
          !didReadChangedParam(
            oldRenderTree.varyPath,
            newRouteTree.varyPath,
            oldRsc.varyParams
          )
        ) {
          const cacheNode = createCacheNode(
            oldRsc,
            oldCacheNode.prefetchRsc,
            bfcacheId
          )
          if (freshness !== FreshnessPolicy.Gesture) {
            writeToBFCache(navigatedAt, newRouteTree.varyPath, cacheNode)
          }
          newRenderTree = createRenderTree(newRouteTree, cacheNode)
          break
        }
        // Intentional fallthrough
      }
      case FreshnessPolicy.Hydration:
      case FreshnessPolicy.HistoryTraversal:
      case FreshnessPolicy.RefreshAll:
      case FreshnessPolicy.HMRRefresh: {
        newRenderTree = createRenderTreeForSegment(
          navigatedAt,
          newRouteTree,
          freshness,
          seedDynamicStaleAt,
          bfcacheId,
          map,
          restrictToShell
        )
        break
      }
    }

    // A param change mostly acts the same as a refresh, except it does
    // trigger a scroll.
    if (isLeafSegment) {
      accumulateScrollRef(freshness, newRenderTree.data, accumulation)
    }
  } else if (
    shouldRefreshDynamicData ||
    // During a same-page navigation, we always refetch the page segments
    (isLeafSegment && isSamePageNavigation)
  ) {
    // This is a refresh of an existing segment. Ignore the existing render
    // tree and create a new one.
    newRenderTree = createRenderTreeForSegment(
      navigatedAt,
      newRouteTree,
      freshness,
      seedDynamicStaleAt,
      // Refreshing data preserves the identity of the active segment.
      oldRenderTree.data.bfcacheId,
      map,
      restrictToShell
    )

    // Carry forward the old node's scrollRef. This preserves scroll intent
    // when a prior navigation's render tree is replaced by a refresh before
    // the scroll handler has had a chance to fire — e.g. when router.push()
    // and router.refresh() are called in the same startTransition batch.
    newRenderTree.data.scrollRef = oldRenderTree.data.scrollRef
  } else {
    // This segment appears in both the old and new routes. Reuse the existing
    // data without triggering a request.
    // TODO: Consider adding a fast path where if this segment is unchanged and
    // all of its children are unchanged, we return the exact same RenderTree
    // object. Reusing the exact previous object gives React more of a chance to
    // bail out of rendering.
    newRenderTree = createRenderTree(newRouteTree, oldRenderTree.data)
  }

  // During a refresh navigation, there's a special case that happens when
  // entering a "default" slot. The default slot may not be part of the
  // current route; it may have been reused from an older route. If so,
  // we need to fetch its data from the old route's URL rather than current
  // route's URL. Keep track of this as we traverse the tree; the spawner
  // reads it to decide which URL to request each segment's data from.
  const maybeRefreshState = newRouteTree.refreshState
  const refreshState =
    maybeRefreshState !== undefined && maybeRefreshState !== null
      ? // This segment is not present in the current route. Track its
        // refresh URL as we continue traversing the tree.
        maybeRefreshState
      : // Inherit the refresh URL from the parent.
        parentRefreshState
  newRenderTree.refreshState = refreshState

  if (newSlots !== null) {
    const oldRenderTreeSlots = oldRenderTree.slots

    const newRenderTreeSlots = new Map<string, RouteTree<CacheNode>>()
    newRenderTree.slots = newRenderTreeSlots
    for (let [parallelRouteKey, newRouteTreeChild] of newSlots) {
      const oldRenderTreeChild = oldRenderTreeSlots?.get(parallelRouteKey)
      if (oldRenderTreeChild === undefined) {
        // This should never happen, but if it does, it suggests a malformed
        // server response. Trigger a full-page navigation.
        return null
      }

      const oldSegmentChild = oldRenderTreeChild.segment
      const newSegmentChild = newRouteTreeChild.segment
      if (
        // Skip this branch during a history traversal. We restore the tree that
        // was stashed in the history entry as-is.
        freshness !== FreshnessPolicy.HistoryTraversal &&
        newSegmentChild === DEFAULT_SEGMENT_KEY &&
        oldSegmentChild !== DEFAULT_SEGMENT_KEY &&
        // The active segment was rendered with this layout's params. If a
        // path param changed, we can't keep it. Use the default segment from
        // the server instead.
        paramsChange !== ParamsChange.PathParam
      ) {
        // This is a "default" segment. These are never sent by the server during
        // a soft navigation; instead, the client reuses whatever segment was
        // already active in that slot on the previous route.
        newRouteTreeChild = reuseActiveSegmentInDefaultSlot(
          oldRootRefreshState,
          oldRenderTreeChild
        )
      }

      const newRenderTreeChild = updateRenderTreeOnNavigation(
        navigatedAt,
        oldRenderTreeChild,
        newRouteTreeChild,
        freshness,
        seedDynamicStaleAt,
        isSamePageNavigation,
        oldRootRefreshState,
        refreshState,
        accumulation,
        map,
        restrictToShell
      )

      if (newRenderTreeChild === null) {
        // One of the children discovered a change to the root layout.
        // Immediately unwind from this recursive traversal. This will trigger a
        // full-page navigation.
        return null
      }

      newRenderTreeSlots.set(parallelRouteKey, newRenderTreeChild)
    }
  }

  return newRenderTree
}

/**
 * Assigns a ScrollRef to a new leaf CacheNode so the scroll handler
 * knows to scroll to it after navigation. All leaves in the same
 * navigation share the same ScrollRef — the first segment to scroll
 * consumes it, preventing others from also scrolling.
 *
 * Called for newly entered segments, and for segments whose params changed
 * (even if their data was reused). Refreshes keep the existing scroll ref.
 *
 * Skipped during hydration (initial render should not scroll) and
 * history traversal (scroll restoration is handled separately).
 *
 * The head passes through here as a leaf too; its `scrollRef` is never read
 * (only LayoutRouter reads one), and the page leaf sets the same shared ref.
 */
function accumulateScrollRef(
  freshness: FreshnessPolicy,
  cacheNode: CacheNode,
  accumulation: NavigationRequestAccumulation
): void {
  switch (freshness) {
    case FreshnessPolicy.Default:
    case FreshnessPolicy.Gesture:
    case FreshnessPolicy.RefreshAll:
    case FreshnessPolicy.HMRRefresh:
      if (accumulation.scrollRef === null) {
        accumulation.scrollRef = { current: true }
      }
      cacheNode.scrollRef = accumulation.scrollRef
      break
    case FreshnessPolicy.Hydration:
      // Initial render — no scroll.
      break
    case FreshnessPolicy.HistoryTraversal:
      // Back/forward — scroll restoration is handled separately.
      break
    default:
      freshness satisfies never
      break
  }
}

function createRenderTreeOnNavigation(
  navigatedAt: number,
  newRouteTree: RouteTree<RSCSegmentData | null>,
  freshness: FreshnessPolicy,
  seedDynamicStaleAt: number,
  accumulation: NavigationRequestAccumulation,
  map: CacheMap<SegmentCacheEntry>,
  // Instant Navigation Testing API only — restricts segment reads to shell
  // entries. Always false outside the testing API. See navigation-testing-lock.
  restrictToShell: boolean
): RouteTree<CacheNode> {
  // Same traversal as updateRenderTreeOnNavigation, but simpler. We switch to this
  // path once we reach the part of the tree that was not in the previous route.
  // We don't need to diff against the old tree, we just need to create a new
  // one. We also don't need to worry about any refresh-related logic.
  //
  // For the most part, this is a subset of updateRenderTreeOnNavigation, so any
  // change that happens in this function likely needs to be applied to that
  // one, too. However there are some places where the behavior intentionally
  // diverges, which is why we keep them separate.

  const newSlots = newRouteTree.slots

  const newRenderTree = createRenderTreeForSegment(
    navigatedAt,
    newRouteTree,
    freshness,
    seedDynamicStaleAt,
    // This segment was not part of the previous route, so mint a fresh
    // bfcacheId.
    generateBFCacheId(freshness),
    map,
    restrictToShell
  )

  const isLeafSegment = newSlots === null
  if (isLeafSegment) {
    accumulateScrollRef(freshness, newRenderTree.data, accumulation)
  }

  if (newSlots !== null) {
    const newRenderTreeSlots = new Map<string, RouteTree<CacheNode>>()
    newRenderTree.slots = newRenderTreeSlots
    for (const [parallelRouteKey, newRouteTreeChild] of newSlots) {
      newRenderTreeSlots.set(
        parallelRouteKey,
        createRenderTreeOnNavigation(
          navigatedAt,
          newRouteTreeChild,
          freshness,
          seedDynamicStaleAt,
          accumulation,
          map,
          restrictToShell
        )
      )
    }
  }

  // This route is not part of the current tree, so it has no refresh URL
  // (createRenderTree leaves `refreshState` null).
  return newRenderTree
}

/**
 * The router state a render tree commits: the form `state.tree` holds, the
 * history entry stores, and a retry starts from. A page's search params go in
 * their own slot.
 */
export function createRouterStateFromRenderTree(
  tree: RouteTree<CacheNode>
): FlightRouterState {
  const children: { [parallelRouteKey: string]: FlightRouterState } = {}
  const slots = tree.slots
  if (slots !== null) {
    for (const [parallelRouteKey, child] of slots) {
      children[parallelRouteKey] = createRouterStateFromRenderTree(child)
    }
  }
  const refreshState = tree.refreshState
  const routerState: FlightRouterState = [
    tree.segment,
    children,
    refreshState !== null
      ? [refreshState.canonicalUrl, refreshState.renderedSearch]
      : null,
    null,
    tree.prefetchHints,
  ]
  if (tree.segment === PAGE_SEGMENT_KEY) {
    const renderedSearch = getRenderedSearchFromVaryPath(tree.varyPath)
    if (renderedSearch !== null) {
      routerState[5] = renderedSearch
    }
  }
  return routerState
}

/**
 * The tree sent to the server to request the data a render tree is missing
 * from one URL. A node's data is requested from the URL that rendered it: the
 * navigation's own canonical URL, unless the node carries a refresh state
 * naming an older route's URL. The `refetch` marker is set on the topmost node
 * of each path that belongs to `requestUrl` and is still empty. Every empty
 * node that belongs is flipped to pending, owned by `request`, so the request
 * can later abort the ones its response didn't fulfill. Nodes that belong to
 * another URL, or whose data another request is already fetching, are emitted
 * as structure only.
 *
 * Already in the form the server accepts (what
 * stripClientOnlyDataFromFlightRouterState produces): no refresh state, no
 * page search, no static siblings. Returns `null` when nothing was requested.
 */
export function createRequestTreeFromRenderTree(
  tree: RouteTree<CacheNode>,
  request: DynamicRequest,
  canonicalUrl: string,
  requestUrl: string
): FlightRouterState | null {
  const requestTree = createRequestTreeNode(
    tree,
    request,
    canonicalUrl,
    requestUrl,
    'refetch'
  )
  if (!hasRequestMarker(requestTree)) {
    return null
  }
  return requestTree
}

// Whether the derivation requested anything: it marks the topmost requested
// node of each path, so a tree with no marker has nothing to fetch.
function hasRequestMarker(requestTree: FlightRouterState): boolean {
  if (requestTree[3] !== undefined) {
    return true
  }
  const children = requestTree[1]
  for (const parallelRouteKey in children) {
    if (hasRequestMarker(children[parallelRouteKey])) {
      return true
    }
  }
  return false
}

function createRequestTreeNode(
  tree: RouteTree<CacheNode>,
  request: DynamicRequest,
  canonicalUrl: string,
  requestUrl: string,
  // The marker this node carries if it is the first on its path to be
  // requested; null below a node that already carries one, since the server
  // renders the whole marked subtree.
  marker: 'refetch' | null
): FlightRouterState {
  const refreshState = tree.refreshState
  const nodeUrl =
    refreshState !== null ? refreshState.canonicalUrl : canonicalUrl
  const rsc = tree.data.rsc
  let requestMarker: 'refetch' | null = null
  let childMarker = marker
  if (rsc.status === 'empty' && nodeUrl === requestUrl) {
    markComponentDataAsPending(rsc, request)
    requestMarker = marker
    childMarker = null
  }

  const children: { [parallelRouteKey: string]: FlightRouterState } = {}
  const slots = tree.slots
  if (slots !== null) {
    for (const [parallelRouteKey, child] of slots) {
      children[parallelRouteKey] = createRequestTreeNode(
        child,
        request,
        canonicalUrl,
        requestUrl,
        childMarker
      )
    }
  }

  const requestTree: FlightRouterState = [
    stripStaticSiblings(tree.segment),
    children,
  ]
  if (requestMarker !== null) {
    requestTree[2] = null
    requestTree[3] = requestMarker
  }
  if (tree.prefetchHints !== 0) {
    requestTree[4] = tree.prefetchHints
  }
  return requestTree
}

// Static siblings are only read by the client's route prediction; the server
// ignores them (same as stripClientOnlyDataFromSegment).
function stripStaticSiblings(segment: Segment): Segment {
  if (typeof segment === 'string') {
    return segment
  }
  const [paramName, paramCacheKey, paramType] = segment
  return [paramName, paramCacheKey, paramType, null]
}

// The URLs other than the navigation's own that still have data to request:
// the refresh URLs of the empty nodes reused from older routes.
function collectRefreshUrls(
  tree: RouteTree<CacheNode>,
  canonicalUrl: string,
  refreshUrls: Set<string> | null
): Set<string> | null {
  const refreshState = tree.refreshState
  if (
    refreshState !== null &&
    refreshState.canonicalUrl !== canonicalUrl &&
    tree.data.rsc.status === 'empty'
  ) {
    if (refreshUrls === null) {
      refreshUrls = new Set([refreshState.canonicalUrl])
    } else {
      refreshUrls.add(refreshState.canonicalUrl)
    }
  }
  const slots = tree.slots
  if (slots !== null) {
    for (const [, child] of slots) {
      refreshUrls = collectRefreshUrls(child, canonicalUrl, refreshUrls)
    }
  }
  return refreshUrls
}

function reuseActiveSegmentInDefaultSlot(
  oldRootRefreshState: RefreshState,
  oldRenderTree: RouteTree<CacheNode>
): RouteTree<RSCSegmentData | null> {
  // This is a "default" segment. These are never sent by the server during a
  // soft navigation; instead, the client reuses whatever segment was already
  // active in that slot on the previous route. This means if we later need to
  // refresh the segment, it will have to be refetched from the previous route's
  // URL. We store the refresh context on the active render tree.

  let reusedUrl: string
  let reusedRenderedSearch: NormalizedSearch
  const oldRefreshState = oldRenderTree.refreshState
  if (oldRefreshState !== null) {
    // This segment was already reused from an even older route. Keep its
    // existing URL and refresh state.
    reusedUrl = oldRefreshState.canonicalUrl
    reusedRenderedSearch = oldRefreshState.renderedSearch
  } else {
    // Since this route didn't already have a refresh state, it must have been
    // reachable from the root of the old route. So we use the refresh state
    // that represents the old route.
    reusedUrl = oldRootRefreshState.canonicalUrl
    reusedRenderedSearch = oldRootRefreshState.renderedSearch
  }

  const reusedRouteTree = rebaseInactiveRouteTree(oldRenderTree)
  reusedRouteTree.refreshState = {
    canonicalUrl: reusedUrl,
    renderedSearch: reusedRenderedSearch,
  }
  return reusedRouteTree
}

function createRenderTree(
  routeTree: RouteTree<RSCSegmentData | null>,
  cacheNode: CacheNode
): RouteTree<CacheNode> {
  return {
    requestKey: routeTree.requestKey,
    segment: routeTree.segment,
    shellVaryPath: routeTree.shellVaryPath,
    refreshState: null,
    data: cacheNode,
    varyPath: routeTree.varyPath,
    slots: null,
    prefetchHints: routeTree.prefetchHints,
  }
}

function createRenderTreeForSegment(
  now: number,
  // A route tree node, or the one-node metadata tree that stands in for the
  // head (see createMetadataRouteTree).
  tree: RouteTree<RSCSegmentData | null>,
  freshness: FreshnessPolicy,
  dynamicStaleAt: number,
  bfcacheId: number,
  map: CacheMap<SegmentCacheEntry>,
  // Instant Navigation Testing API only — restricts segment reads to shell
  // entries. Always false outside the testing API. See navigation-testing-lock.
  restrictToShell: boolean
): RouteTree<CacheNode> {
  // Construct an owned render tree using data from the BFCache, the client's
  // Segment Cache, or seeded from a server response.
  //
  // If there's a cache miss, or if we only have a partial hit, we'll render
  // the partial state immediately, and leave the node's data empty for the
  // navigation to request from the server (see spawnDynamicRequests).
  //
  // If the segment is fully cached on the client already, we can omit this
  // segment from the server request.
  //
  // If we already have a dynamic data response associated with this navigation,
  // as in the case of a Server Action-initiated redirect or refresh, we may
  // also be able to use that data without spawning a new request. (This is
  // referred to as the "seed" data.)

  const seedData = tree.data
  const seedRsc = seedData !== null ? seedData.rsc : null
  const seedVaryParams = seedData !== null ? seedData.varyParams : null

  // During certain kinds of navigations, we may be able to render from
  // the BFCache.
  switch (freshness) {
    case FreshnessPolicy.Default: {
      // Check BFCache during regular navigations. The entry's staleAt
      // determines whether it's still fresh. This is used when
      // staleTimes.dynamic is configured globally or when a page exports
      // unstable_dynamicStaleTime for per-page control.
      const bfcacheEntry = readFromBFCacheDuringRegularNavigation(
        now,
        tree.varyPath
      )
      if (bfcacheEntry !== null) {
        // A regular navigation that happens to read cached data is still a
        // fresh navigation, so we use the caller-supplied bfcacheId — the
        // BFCacheEntry's id is only restored on history-traversal
        // navigations.
        return createRenderTree(
          tree,
          createCacheNode(bfcacheEntry.rsc, bfcacheEntry.prefetchRsc, bfcacheId)
        )
      }
      break
    }
    case FreshnessPolicy.Hydration: {
      // This is not related to the BFCache but it is a special case.
      //
      // We should never spawn network requests during hydration. We must treat
      // the initial payload as authoritative, because the initial page load is
      // used as a last-ditch mechanism for recovering the app.
      //
      // This is also an important safety check because if this leaks into the
      // server rendering path (which theoretically it never should because the
      // server payload should be consistent), the server would hang because these
      // promises would never resolve.
      //
      // TODO: There is an existing case where the global "not found" boundary
      // triggers this path. But it does render correctly despite that. That's an
      // unusual render path so it's not surprising, but we should look into
      // modeling it in a more consistent way. See also the /_notFound special
      // case in updateRenderTreeOnNavigation.
      const cacheNode = createCacheNode(
        createFulfilledComponentData(seedRsc, seedVaryParams, dynamicStaleAt),
        null,
        bfcacheId
      )
      writeToBFCache(now, tree.varyPath, cacheNode)
      return createRenderTree(tree, cacheNode)
    }
    case FreshnessPolicy.HistoryTraversal:
      const bfcacheEntry = readFromBFCache(tree.varyPath)
      if (bfcacheEntry !== null) {
        // Only show prefetched data if the dynamic data is still pending. This
        // avoids a flash back to the prefetch state in a case where it's highly
        // likely to have already streamed in.
        //
        // Tehnically, what we're actually checking is whether the dynamic
        // network response was received. But since it's a streaming response,
        // this does not mean that all the dynamic data has fully streamed in.
        // It just means that _some_ of the dynamic data was received. But as a
        // heuristic, we assume that the rest dynamic data will stream in
        // quickly, so it's still better to skip the prefetch state.
        const oldRsc = bfcacheEntry.rsc
        let prefetchRsc: ComponentData | null
        if (oldRsc.status === 'pending') {
          prefetchRsc = bfcacheEntry.prefetchRsc
        } else {
          prefetchRsc = null
        }
        // Restore the bfcacheId from the cached entry so that back/forward
        // navigations preserve the original id, regardless of whether
        // `cacheComponents` Activity preservation is enabled.
        return createRenderTree(
          tree,
          createCacheNode(oldRsc, prefetchRsc, bfcacheEntry.bfcacheId)
        )
      }
      break
    case FreshnessPolicy.RefreshAll:
    case FreshnessPolicy.HMRRefresh:
    case FreshnessPolicy.Gesture:
      // Don't consult the BFCache.
      break
    default:
      freshness satisfies never
      break
  }

  let cachedRsc: React.ReactNode | null = null
  let isCachedRscPartial: boolean = true
  let cachedVaryParams: VaryParams | null = null
  // The stale time of the cached data itself; the node's `rsc` uses the
  // navigation's dynamic stale time regardless.
  let cachedStaleAt: number = dynamicStaleAt

  const segmentEntry = readSegmentCacheEntryForNavigation(
    now,
    map,
    tree.varyPath,
    restrictToShell
  )
  if (segmentEntry !== null) {
    switch (segmentEntry.status) {
      case EntryStatus.Fulfilled: {
        // Happy path: a cache hit
        cachedRsc = segmentEntry.rsc
        isCachedRscPartial = segmentEntry.isPartial
        cachedVaryParams = segmentEntry.varyParams
        cachedStaleAt = segmentEntry.staleAt
        break
      }
      case EntryStatus.Pending: {
        // We haven't received data for this segment yet, but there's already
        // an in-progress request. Since it's extremely likely to arrive
        // before the dynamic data response, we might as well use it.
        const promiseForFulfilledEntry = waitForSegmentCacheEntry(segmentEntry)
        cachedRsc = promiseForFulfilledEntry.then((entry) =>
          entry !== null ? entry.rsc : null
        )
        // The entry's data hasn't arrived, and neither have the source of the
        // params it depends on or its stale time; `cachedVaryParams` and
        // `cachedStaleAt` keep their defaults.
        // Because the request is still pending, we typically don't know yet
        // whether the response will be partial. We shouldn't skip this segment
        // during the dynamic navigation request. Otherwise, we might need to
        // do yet another request to fill in the remaining data, creating
        // a waterfall.
        //
        // The one exception is if this segment is being fetched with via
        // prefetch={true} (i.e. the "force stale" or "full" strategy). If so,
        // we can assume the response will be full. This field is set to `false`
        // for such segments.
        isCachedRscPartial = segmentEntry.isPartial
        break
      }
      case EntryStatus.Empty:
      case EntryStatus.Rejected: {
        break
      }
      default: {
        segmentEntry satisfies never
        break
      }
    }
  }

  if (
    process.env.__NEXT_OPTIMISTIC_ROUTING &&
    tree.segment === HEAD_REQUEST_KEY &&
    isCachedRscPartial
  ) {
    // TODO: When optimistic routing is enabled, don't block on waiting for
    // the viewport to resolve. This is a temporary workaround until Vary
    // Params are tracked when rendering the metadata. We'll fix it before
    // this feature is stable. However, it's not a critical issue because 1)
    // it will stream in eventually anyway 2) metadata is wrapped in an
    // internal Suspense boundary, so is always non-blocking; this only
    // affects the viewport node, which is meant to blocking, however... 3)
    // before Segment Cache landed this wasn't always the case, anyway, so
    // it's unlikely that many people are relying on this behavior. Still,
    // will be fixed before stable. It's the very next step in the sequence of
    // work on this project.
    //
    // This line of code works because the App Router treats `null` as
    // "no renderable head available", rather than an empty head. React treats
    // an empty string as empty.
    cachedRsc = ''
  }

  // Now combine the cached data with the seed data to determine what we can
  // render immediately, versus what needs to stream in later.

  // A partial state to show immediately while we wait for the final data to
  // arrive. If `rsc` is already a complete value (not partial), or if we
  // don't have any useful partial state, this will be `null`.
  let prefetchRsc: ComponentData | null
  // The final segment data. If the data is missing, this is empty until the
  // navigation requests it and pending until the response arrives. A
  // fulfilled value of `null` means the data failed to load; the LayoutRouter
  // will suspend indefinitely until the router updates again (refer to
  // finishNavigationTask).
  let rsc: ComponentData

  if (seedRsc !== null) {
    // We already have a dynamic server response for this segment.
    if (isCachedRscPartial) {
      // The seed data may still be streaming in, so it's worth showing the
      // partial cached state in the meantime.
      if (cachedRsc !== null) {
        prefetchRsc = createFulfilledComponentData(
          cachedRsc,
          cachedVaryParams,
          cachedStaleAt
        )
      } else {
        prefetchRsc = null
      }
      rsc = createFulfilledComponentData(
        seedRsc,
        seedVaryParams,
        dynamicStaleAt
      )
    } else {
      // We already have a completely cached segment. Ignore the seed data,
      // which may still be streaming in. This shouldn't happen in the normal
      // case because the client will inform the server which segments are
      // already fully cached, and the server will skip rendering them.
      prefetchRsc = null
      rsc = createFulfilledComponentData(
        cachedRsc,
        cachedVaryParams,
        dynamicStaleAt
      )
    }
  } else {
    if (isCachedRscPartial) {
      // The cached data contains dynamic holes, or it's missing entirely. We'll
      // show the partial state immediately (if available), and stream in the
      // final data.
      if (cachedRsc !== null) {
        prefetchRsc = createFulfilledComponentData(
          cachedRsc,
          cachedVaryParams,
          cachedStaleAt
        )
      } else {
        prefetchRsc = null
      }
      rsc = createEmptyComponentData(dynamicStaleAt)
    } else {
      // The data is fully cached.
      prefetchRsc = null
      rsc = createFulfilledComponentData(
        cachedRsc,
        cachedVaryParams,
        dynamicStaleAt
      )
    }
  }

  // Now that we're creating a new segment, write its data to the BFCache. A
  // subsequent back/forward navigation will reuse this same data, until or
  // unless it's cleared by a refresh/revalidation.
  //
  // Skip BFCache writes for optimistic navigations since they are transient
  // and will be replaced by the canonical navigation.
  const cacheNode = createCacheNode(rsc, prefetchRsc, bfcacheId)
  if (freshness !== FreshnessPolicy.Gesture) {
    writeToBFCache(now, tree.varyPath, cacheNode)
  }

  return createRenderTree(tree, cacheNode)
}

function createCacheNode(
  rsc: ComponentData,
  prefetchRsc: ComponentData | null,
  bfcacheId: number,
  scrollRef: ScrollRef | null = null
): CacheNode {
  return {
    rsc,
    prefetchRsc,
    scrollRef,
    bfcacheId,
  }
}

// Globally-unique counter for fresh bfcacheIds. Incremented every time a new
// CacheNode is created on the client. The id surfaces to user code as a
// string via `useRouter().bfcacheId`.
let nextBFCacheId = 0

function generateBFCacheId(freshness: FreshnessPolicy): number {
  // Server-side rendering and the initial client-side hydration tree both
  // use a fixed sentinel so they reconcile cleanly across hydration. The
  // counter only advances on real client-side navigations after hydration.
  if (typeof window === 'undefined') return 0
  if (freshness === FreshnessPolicy.Hydration) return 0
  return ++nextBFCacheId
}

// Represents whether the previuos navigation resulted in a route tree mismatch.
// A mismatch results in a refresh of the page. If there are two successive
// mismatches, we will fall back to an MPA navigation, to prevent a retry loop.
let previousNavigationDidMismatch = false

// Requests the data a render tree is missing and writes the responses into
// it. Every empty node the navigation requests will be fulfilled, either with
// dynamic data from the server, or `null` to indicate that the data is
// missing.
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
export function spawnDynamicRequests(
  root: RootRouteTree<CacheNode>,
  primaryUrl: URL,
  nextUrl: string | null,
  freshnessPolicy: FreshnessPolicy,
  // The route cache entry used for this navigation, if it came from route
  // prediction. Passed through so it can be marked as having a dynamic rewrite
  // if the server returns a different pathname than expected (indicating
  // dynamic rewrite behavior that varies by param value).
  routeCacheEntry: FulfilledRouteCacheEntry | null,
  // The original navigation's push/replace intent. Threaded through to the
  // server-patch retry logic so it can inherit the intent if the original
  // transition hasn't committed yet.
  navigateType: 'push' | 'replace',
  navigationLock: NavigationLock | null,
  // The segment cache map this navigation is bound to. See `segmentCacheMap`
  // in cache.ts.
  map: CacheMap<SegmentCacheEntry>,
  signal: AbortSignal | undefined
): void {
  // This is intentionally not an async function to discourage the caller from
  // awaiting the result. Any subsequent async operations spawned by this
  // function should result in a separate navigation task, rather than
  // block the original one.
  //
  // In this function we spawn (but do not await) all the network requests that
  // block the navigation, and collect the promises. The next function,
  // `finishNavigationTask`, can await the promises in any order without
  // accidentally introducing a network waterfall.
  const tree = root.tree
  const head = root.head
  const headRsc = head.data.rsc
  const canonicalUrl = createHrefFromUrl(primaryUrl)
  const primaryRequest = createDynamicRequest(primaryUrl, nextUrl)
  let primaryRequestTree = createRequestTreeFromRenderTree(
    tree,
    primaryRequest,
    canonicalUrl,
    canonicalUrl
  )
  if (primaryRequestTree === null && headRsc.status === 'empty') {
    // Every segment is cached, but the head is not. Ask the server for the
    // head alone.
    primaryRequestTree = MetadataOnlyRequestTree
  }
  let startedPrimaryRequest: DynamicRequest | null = null
  if (primaryRequestTree !== null) {
    if (headRsc.status === 'empty') {
      // The primary response carries the head.
      markComponentDataAsPending(headRsc, primaryRequest)
    }
    primaryRequest.promise = fetchMissingDynamicData(
      primaryRequest,
      tree,
      head,
      primaryRequestTree,
      freshnessPolicy,
      routeCacheEntry,
      navigationLock,
      map,
      signal
    )
    startedPrimaryRequest = primaryRequest
  }

  // A "default" parallel route slot reused from an older route can't fetch
  // its data from the current route's URL; it's requested from the URL that
  // originally rendered it, with a request tree scoped to that URL.
  let refreshRequests: Array<DynamicRequest> | null = null
  const refreshUrls = collectRefreshUrls(tree, canonicalUrl, null)
  if (refreshUrls !== null) {
    for (const refreshUrl of refreshUrls) {
      const refreshRequest = createDynamicRequest(
        new URL(refreshUrl, location.origin),
        // TODO: Just noticed that this should actually the Next-Url at the
        // time the refresh URL was set, not the current Next-Url. Need to
        // start tracking this alongside the refresh URL. In the meantime,
        // if a refresh fails due to a mismatch, it will trigger a
        // hard refresh.
        nextUrl
      )
      const refreshRequestTree = createRequestTreeFromRenderTree(
        tree,
        refreshRequest,
        canonicalUrl,
        refreshUrl
      )
      if (refreshRequestTree !== null) {
        refreshRequest.promise = fetchMissingDynamicData(
          refreshRequest,
          tree,
          // The head belongs to the primary URL.
          null,
          refreshRequestTree,
          freshnessPolicy,
          routeCacheEntry,
          navigationLock,
          map,
          signal
        )
        if (refreshRequests === null) {
          refreshRequests = [refreshRequest]
        } else {
          refreshRequests.push(refreshRequest)
        }
      }
    }
  }

  if (startedPrimaryRequest === null && refreshRequests === null) {
    // This navigation was fully cached. There are no dynamic requests to spawn.
    previousNavigationDidMismatch = false
    return
  }

  // Further async operations are moved into this separate function to
  // discourage sequential network requests.
  const voidPromise = finishNavigationTask(
    root,
    primaryUrl,
    nextUrl,
    startedPrimaryRequest,
    refreshRequests,
    routeCacheEntry,
    navigateType
  )
  // `finishNavigationTask` is responsible for error handling, so we can attach
  // noop callbacks to this promise.
  voidPromise.then(noop, noop)
}

async function finishNavigationTask(
  root: RootRouteTree<CacheNode>,
  primaryUrl: URL,
  nextUrl: string | null,
  // Null when every node the navigation's own URL serves is already cached
  // and only refresh URLs have data to request.
  primaryRequest: DynamicRequest | null,
  refreshRequests: Array<DynamicRequest> | null,
  routeCacheEntry: FulfilledRouteCacheEntry | null,
  navigateType: 'push' | 'replace'
): Promise<void> {
  // Wait for all the requests to finish, or for the first one to fail. Each
  // request fulfilled or aborted the data it asked for as its response was
  // written, so nothing is left to check here.
  const exitStatus = await waitForRequestsToFinish(
    primaryRequest,
    refreshRequests
  )

  if (exitStatus === NavigationTaskExitStatus.Canceled) {
    // This navigation was superseded and its request aborted. Its cache nodes
    // may already be reused by the newer navigation, so leave them untouched
    // for the newer request to fulfill. If the tree was abandoned entirely,
    // it can be garbage collected along with its unresolved promises. We do
    // not retry or hard-navigate.
    return
  }
  if (exitStatus === NavigationTaskExitStatus.Done) {
    // The task has completely finished. There's no missing data. Exit.
    previousNavigationDidMismatch = false
    return
  }

  // The retry starts from the URL the primary request resolved to and reuses
  // the data it received. A navigation whose own URL had nothing to request
  // retries from that URL with no data to reuse.
  let retryUrl = primaryUrl
  let seed: NavigationSeed | null = null
  if (primaryRequest !== null && primaryRequest.promise !== null) {
    const primaryRequestResult = await primaryRequest.promise
    retryUrl = primaryRequestResult.url
    seed = primaryRequestResult.seed
  }

  switch (exitStatus) {
    case NavigationTaskExitStatus.SoftRetry: {
      // Some data failed to finish loading. Trigger a soft retry that re-fetches
      // the tree's dynamic data.
      // TODO: As an extra precaution against soft retry loops, consider
      // tracking whether a navigation was itself triggered by a retry. If two
      // happen in a row, fall back to a hard retry.
      const isHardRetry = false
      dispatchRetryDueToTreeMismatch(
        isHardRetry,
        retryUrl,
        nextUrl,
        seed,
        root,
        routeCacheEntry,
        navigateType,
        FreshnessPolicy.RefreshAll
      )
      return
    }
    case NavigationTaskExitStatus.RedirectRetry: {
      // The route matched, but the request was redirected, so we committed the
      // wrong canonical URL. Re-resolve the route to invalidate the now-stale
      // route cache and correct the URL — but reuse the data we already received
      // (HistoryTraversal) instead of re-fetching it. See issue #95195.
      const isHardRetry = false
      dispatchRetryDueToTreeMismatch(
        isHardRetry,
        retryUrl,
        nextUrl,
        seed,
        root,
        routeCacheEntry,
        navigateType,
        FreshnessPolicy.HistoryTraversal
      )
      return
    }
    case NavigationTaskExitStatus.HardRetry: {
      // Some data failed to finish loading in a non-recoverable way, such as a
      // network error. Trigger an MPA navigation.
      //
      // Hard navigating/refreshing is how we prevent an infinite retry loop
      // caused by a network error — when the network fails, we fall back to the
      // browser behavior for offline navigations. In the future, Next.js may
      // introduce its own custom handling of offline navigations, but that
      // doesn't exist yet.
      const isHardRetry = true
      dispatchRetryDueToTreeMismatch(
        isHardRetry,
        retryUrl,
        nextUrl,
        seed,
        root,
        routeCacheEntry,
        navigateType,
        FreshnessPolicy.RefreshAll
      )
      return
    }
    default: {
      return exitStatus satisfies never
    }
  }
}

function waitForRequestsToFinish(
  primaryRequest: DynamicRequest | null,
  refreshRequests: Array<DynamicRequest> | null
) {
  // Custom async combinator logic. This could be replaced by Promise.any but
  // we don't assume that's available.
  //
  // Each promise resolves once the server responsds and the data is written
  // into the render tree. Resolve the combined promise once all the
  // requests finish.
  //
  // Or, resolve as soon as one of the requests fails, without waiting for the
  // others to finish.
  return new Promise<NavigationTaskExitStatus>((resolve) => {
    const onFulfill = (result: DynamicRequestResult) => {
      if (result.exitStatus === NavigationTaskExitStatus.Done) {
        remainingCount--
        if (remainingCount === 0) {
          // All the requests finished successfully.
          resolve(NavigationTaskExitStatus.Done)
        }
      } else {
        // One of the requests failed. Exit with a failing status.
        // NOTE: It's possible for one of the requests to fail with SoftRetry
        // and a later one to fail with HardRetry. In this case, we choose to
        // retry immediately, rather than delay the retry until all the requests
        // finish. If it fails again, we will hard retry on the next
        // attempt, anyway.
        resolve(result.exitStatus)
      }
    }
    // onReject shouldn't ever be called because fetchMissingDynamicData's
    // entire body is wrapped in a try/catch. This is just defensive.
    const onReject = () => resolve(NavigationTaskExitStatus.HardRetry)

    // Attach the listeners to the promises. Only started requests reach here,
    // so each has one.
    let remainingCount = 0
    if (primaryRequest !== null && primaryRequest.promise !== null) {
      remainingCount++
      primaryRequest.promise.then(onFulfill, onReject)
    }
    if (refreshRequests !== null) {
      for (const refreshRequest of refreshRequests) {
        if (refreshRequest.promise !== null) {
          remainingCount++
          refreshRequest.promise.then(onFulfill, onReject)
        }
      }
    }
  })
}

function dispatchRetryDueToTreeMismatch(
  isHardRetry: boolean,
  retryUrl: URL,
  retryNextUrl: string | null,
  seed: NavigationSeed | null,
  root: RootRouteTree<CacheNode>,
  // The route cache entry used for this navigation, if it came from route
  // prediction. If the navigation results in a mismatch, we mark it as having
  // a dynamic rewrite so future predictions bail out.
  routeCacheEntry: FulfilledRouteCacheEntry | null,
  // The original navigation's push/replace intent.
  originalNavigateType: 'push' | 'replace',
  // Freshness policy for the retry navigation. `RefreshAll` re-fetches the
  // tree's dynamic data (used for genuine tree mismatches). `HistoryTraversal`
  // reuses the data already in the tree (used when only the URL needs
  // correcting after a redirect).
  retryFreshnessPolicy:
    | FreshnessPolicy.RefreshAll
    | FreshnessPolicy.HistoryTraversal
) {
  // If the navigation used a route prediction, mark the node it was predicted
  // from as having a dynamic rewrite since it resulted in a mismatch. A route
  // entry the server resolved has nothing to mark: nothing was predicted
  // from it.
  if (routeCacheEntry !== null) {
    const predictedFrom = routeCacheEntry.predictedFrom
    if (predictedFrom !== null) {
      predictedFrom.hasDynamicRewrite = true
    }
  } else if (seed !== null) {
    // Even without a direct reference to the route cache entry, we can still
    // mark the route as having a dynamic rewrite by traversing the known route
    // tree. This handles cases where the navigation didn't originate from a
    // route prediction, but still needs to mark the pattern.
    const now = Date.now()
    discoverKnownRoute(
      now,
      retryUrl.pathname,
      retryUrl.search as NormalizedSearch,
      retryNextUrl,
      null,
      seed.root,
      false, // couldBeIntercepted - doesn't matter, we're just marking hasDynamicRewrite
      createHrefFromUrl(retryUrl),
      seed.renderedSearch,
      false, // supportsPerSegmentPrefetching - doesn't matter, we're just marking hasDynamicRewrite
      true // hasDynamicRewrite
    )
  }

  // Invalidate all route cache entries. If the navigation used a route entry
  // the server resolved, its tree is what the server just contradicted, so
  // the retry must re-fetch it rather than navigate with it again. This also
  // triggers re-prefetching of visible links.
  invalidateRouteCacheEntries(retryNextUrl, root)

  // If this is the second time in a row that a navigation resulted in a
  // mismatch, fall back to a hard (MPA) refresh.
  isHardRetry = isHardRetry || previousNavigationDidMismatch
  previousNavigationDidMismatch = true

  // If the original navigation hasn't committed to the browser history yet
  // (the transition suspended before React committed), inherit its push/replace
  // intent. Otherwise, the pushState already ran, so use 'replace' to avoid
  // creating a duplicate history entry.
  //
  // This works because React entangles the retry's state update with the
  // original pending transition — they commit together as a single batch,
  // so the navigate type from the retry is what HistoryUpdater ultimately sees.
  //
  // TODO: Ideally this check would happen right before we schedule the React
  // update (i.e., closer to where the action is dispatched into the queue),
  // not here where the action is constructed. But the current action queue
  // doesn't provide a natural place for that. Revisit when we refactor the
  // action queue into a more reactive navigation model.
  const lastCommittedRoot = getLastCommittedRoot()
  const retryNavigateType: 'push' | 'replace' =
    lastCommittedRoot !== null && root !== lastCommittedRoot
      ? originalNavigateType
      : 'replace'

  const retryAction: ServerPatchAction = {
    type: ACTION_SERVER_PATCH,
    previousRoot: root,
    url: retryUrl,
    nextUrl: retryNextUrl,
    seed,
    mpa: isHardRetry,
    navigateType: retryNavigateType,
    freshnessPolicy: retryFreshnessPolicy,
  }
  dispatchAppRouterAction(retryAction)
}

async function fetchMissingDynamicData(
  request: DynamicRequest,
  tree: RouteTree<CacheNode>,
  head: RouteTree<CacheNode> | null,
  dynamicRequestTree: FlightRouterState,
  freshnessPolicy: FreshnessPolicy,
  routeCacheEntry: FulfilledRouteCacheEntry | null,
  navigationLock: NavigationLock | null,
  map: CacheMap<SegmentCacheEntry>,
  signal: AbortSignal | undefined
): Promise<DynamicRequestResult> {
  const url = request.url
  const nextUrl = request.nextUrl
  try {
    const result = await fetchServerResponse(url, {
      flightRouterState: dynamicRequestTree,
      nextUrl,
      isHmrRefresh: freshnessPolicy === FreshnessPolicy.HMRRefresh,
      signal,
    })
    if (typeof result === 'string') {
      // fetchServerResponse will return an href to indicate that the SPA
      // navigation failed. For example, if the server triggered a hard
      // redirect, or the fetch request errored. Initiate an MPA navigation
      // to the given href.
      return {
        exitStatus: NavigationTaskExitStatus.HardRetry,
        url: new URL(result, location.origin),
        seed: null,
      }
    }
    const now = Date.now()

    let seed: NavigationSeed
    const transportData = result.transportData
    if (transportData !== null) {
      seed = createNavigationSeed(
        now,
        tree,
        transportData,
        // Navigation responses stream in incrementally, so userspace vary
        // params can't be drained here; built-in totals pass through as the
        // promises they are and settle when the render finishes.
        null,
        result.isResponsePartial,
        // Navigation responses always include the param values in the tree,
        // so there's no pathname to parse them from (nor a need to).
        null,
        result.renderedSearch,
        null,
        result.dynamicStaleTime
      )
    } else {
      // The server rendered nothing for the request tree, so the response
      // carries no tree; the seed is the current tree's structure alone.
      seed = createNavigationSeedFromRouteTree(
        now,
        tree,
        result.renderedSearch,
        result.dynamicStaleTime
      )
    }

    // If the navigation lock is active, wait for it to be released before
    // writing the dynamic data. This allows tests to assert on the prefetched
    // UI state.
    if (process.env.__NEXT_EXPOSE_TESTING_API && navigationLock !== null) {
      await navigationLock
    }

    if (routeCacheEntry !== null && result.staticStageResponse !== null) {
      spawnStaticStageCacheWrite(
        now,
        result.staticStageResponse,
        result.isResponsePartial,
        result.responseHeaders,
        tree,
        result.renderedSearch,
        map
      )
    }

    if (routeCacheEntry !== null && result.runtimePrefetchStream !== null) {
      writeRuntimePrefetchStreamIntoCache(
        now,
        result.runtimePrefetchStream,
        tree,
        result.renderedSearch,
        map
      ).catch(() => {
        // The runtime prefetch cache write failed. Not fatal — the
        // navigation completed normally, we just won't cache runtime data.
      })
    }

    // result.dynamicStaleTime is in seconds (from the server's `d` field).
    // Convert to an absolute timestamp using the centralized helper.
    const dynamicStaleAt = computeDynamicStaleAt(now, result.dynamicStaleTime)

    let mismatchStatus = writeDynamicDataIntoRenderTree(
      tree,
      seed.root.tree,
      request,
      dynamicStaleAt,
      result.debugInfo,
      result.revealAfter
    )

    if (head !== null) {
      const headMismatchStatus = writeDynamicDataIntoRenderTree(
        head,
        seed.root.head,
        request,
        dynamicStaleAt,
        result.debugInfo,
        result.revealAfter
      )
      if (headMismatchStatus > mismatchStatus) {
        mismatchStatus = headMismatchStatus
      }
    }

    const resolvedUrl = new URL(result.canonicalUrl, location.origin)

    // Decide whether the navigation needs to be retried.
    //
    // - A tree mismatch (data this request asked for that the response didn't
    //   render, or a parallel route the client doesn't know) means the data is
    //   incomplete, so we retry and re-fetch the whole tree.
    // - Otherwise, the navigation committed the canonical URL from the route
    //   cache entry it used (a prediction or prefetch). If the request resolved
    //   to a *different* canonical URL — e.g. a middleware/proxy redirect the
    //   prediction didn't account for — then the committed URL is wrong and the
    //   route cache it came from is no longer reliable (the redirect implies a
    //   server change the prediction couldn't know about, like logging in or
    //   out). We re-resolve the route to invalidate the stale cache and correct
    //   the browser URL, reusing the data we just received rather than
    //   re-fetching it. When the entry already reflects the redirect (e.g. a
    //   prefetch that followed it), the committed URL matches and no retry is
    //   needed. See issue #95195.
    let didCommitWrongUrl = false
    if (routeCacheEntry !== null) {
      const committedUrl = new URL(
        routeCacheEntry.canonicalUrl,
        location.origin
      )
      didCommitWrongUrl =
        committedUrl.pathname !== resolvedUrl.pathname ||
        committedUrl.search !== resolvedUrl.search
    }

    let exitStatus: NavigationTaskExitStatus
    if (mismatchStatus !== NavigationTaskExitStatus.Done) {
      exitStatus = mismatchStatus
    } else if (didCommitWrongUrl) {
      exitStatus = NavigationTaskExitStatus.RedirectRetry
    } else {
      exitStatus = NavigationTaskExitStatus.Done
    }

    return {
      exitStatus,
      url: resolvedUrl,
      seed,
    }
  } catch {
    if (signal?.aborted) {
      // A newer HMR refresh superseded this one and aborted its request. Treat
      // it as canceled rather than a failure, so we don't retry or
      // hard-navigate.
      return {
        exitStatus: NavigationTaskExitStatus.Canceled,
        url,
        seed: null,
      }
    }

    // This shouldn't happen because fetchServerResponse's entire body is
    // wrapped in a try/catch. If it does, though, it implies the server failed
    // to respond with any tree at all. So we must fall back to a hard retry.
    return {
      exitStatus: NavigationTaskExitStatus.HardRetry,
      url: url,
      seed: null,
    }
  }
}

/**
 * Writes one response into the render tree in a single traversal: the data
 * `request` asked for is fulfilled where the response rendered it and aborted
 * where it didn't. Only the owner writes into pending data; data another
 * request asked for is left to that request's response, even when this one
 * happens to carry it. Below a node the response has no counterpart for (a
 * slot it didn't send, or a route or param mismatch), `serverRouteTree` is
 * null and the walk only aborts. Returns the retry the mismatches call for,
 * or Done.
 */
function writeDynamicDataIntoRenderTree(
  tree: RouteTree<CacheNode>,
  serverRouteTree: RouteTree<RSCSegmentData | null> | null,
  request: DynamicRequest,
  dynamicStaleAt: number,
  debugInfo: Array<any> | null,
  revealAfter: Promise<void> | null
): NavigationTaskExitStatus {
  let exitStatus = NavigationTaskExitStatus.Done

  const rsc = tree.data.rsc
  if (rsc.status === 'pending' && rsc.owner === request) {
    // The response rendered this segment when its data has rsc; a null data
    // object means it didn't account for the segment, and null rsc means it
    // accounted for it without rendering it (an intermediate segment on the
    // path to a rendered subtree).
    const dynamicData = serverRouteTree !== null ? serverRouteTree.data : null
    const dynamicSegmentData = dynamicData !== null ? dynamicData.rsc : null
    if (dynamicData !== null && dynamicSegmentData !== null) {
      if (revealAfter !== null) {
        // In the streaming dev render, defer the fill until `revealAfter`
        // settles, so React doesn't render the boundary's children before
        // their row has been decoded (otherwise it suspends on the
        // still-pending children and commits a premature fallback).
        const fulfill = () =>
          fulfillComponentData(
            rsc,
            dynamicSegmentData,
            dynamicData.varyParams,
            dynamicStaleAt,
            debugInfo
          )
        // Use the same callback for both outcomes: we don't expect
        // `revealAfter` to reject, but if it ever did (e.g. a connection drop
        // mid-stream) we'd still want to fulfill the rsc.
        revealAfter.then(fulfill, fulfill)
      } else {
        fulfillComponentData(
          rsc,
          dynamicSegmentData,
          dynamicData.varyParams,
          dynamicStaleAt,
          debugInfo
        )
      }
    } else {
      // The response didn't render the data this request asked for. It's
      // fulfilled with `null`, never rejected: the head renders at the app
      // root, so a rejection would hit the root error boundary while the
      // retry is in flight.
      abortPendingComponentData(rsc)

      // The server failing to render a segment implies that the route tree
      // received from the server mismatched the tree that was previously
      // prefetched.
      //
      // In an app with fully static routes and no proxy-driven redirects or
      // rewrites, this should never happen, because the route for a URL would
      // always be the same across multiple requests. So, this implies that
      // some runtime routing condition changed, likely in a proxy, without
      // being pushed to the client.
      //
      // When this happens, we treat this the same as a refresh(). The entire
      // tree will be re-rendered from the root.
      if (tree.refreshState === null) {
        // Trigger a "soft" refresh. Essentially the same as calling
        // `refresh()` in a Server Action.
        exitStatus = NavigationTaskExitStatus.SoftRetry
      } else {
        // The mismatch was discovered inside an inactive parallel route. This
        // implies the inactive parallel route is no longer reachable at the
        // URL that originally rendered it. Fall back to an MPA refresh.
        // TODO: An alternative could be to trigger a soft refresh but to
        // _not_ re-use the inactive parallel routes this time. Similar to
        // what would happen if were to do a hard refrehs, but without the
        // HTML page.
        exitStatus = NavigationTaskExitStatus.HardRetry
      }
    }
  }

  const slots = tree.slots
  const serverSlots = serverRouteTree !== null ? serverRouteTree.slots : null

  if (slots !== null) {
    for (const [parallelRouteKey, child] of slots) {
      // Check that the response is for the route we expected: same route
      // structure and same params, including the page's search params.
      const serverChild =
        serverSlots !== null ? serverSlots.get(parallelRouteKey) : undefined
      let matchedServerChild: RouteTree<RSCSegmentData | null> | null = null
      if (
        serverChild !== undefined &&
        doesRouteStructureMatch(child, serverChild) &&
        serverChild.data !== null &&
        compareParams(child.varyPath, serverChild.varyPath) ===
          ParamsChange.None
      ) {
        matchedServerChild = serverChild
      }
      const childExitStatus = writeDynamicDataIntoRenderTree(
        child,
        matchedServerChild,
        request,
        dynamicStaleAt,
        debugInfo,
        revealAfter
      )
      // The statuses are ordered by their precedence.
      if (childExitStatus > exitStatus) {
        exitStatus = childExitStatus
      }
    }
  }

  if (serverSlots !== null) {
    for (const parallelRouteKey of serverSlots.keys()) {
      if (slots === null || !slots.has(parallelRouteKey)) {
        // The server sent a child segment that the client doesn't know about.
        //
        // When we receive an unknown parallel route, we must consider it a
        // mismatch. This is unlike the case where the segment itself
        // mismatches, because multiple routes can be active simultaneously.
        // But a given layout should never have a mismatching set of
        // child slots.
        //
        // Theoretically, this should only happen in development during an HMR
        // refresh, because the set of parallel routes for a layout does not
        // change over the lifetime of a build/deployment. In production, we
        // should have already mismatched on either the build id or the segment
        // path. But as an extra precaution, we validate in prod, too.
        if (NavigationTaskExitStatus.SoftRetry > exitStatus) {
          exitStatus = NavigationTaskExitStatus.SoftRetry
        }
      }
    }
  }

  return exitStatus
}

/**
 * The rendered component output the server sends for a segment (or the head),
 * as opposed to the route structure it sends alongside: the RSC data, the
 * source of the params it depends on, and how long it stays fresh. One object
 * is shared by reference by every CacheNode that renders the same data and by
 * the BFCache entry written for it, so a pending navigation's response
 * fulfills all of them at once.
 *
 * Empty until a navigation asks the server for it, pending while that request
 * is in flight, then fulfilled by the response. A node created with data that
 * another navigation is already fetching shares the pending object and
 * doesn't request it again.
 *
 * Implements React's thenable protocol so a component can `use()` it:
 * `status`/`value` are read synchronously once fulfilled, and `then` is only
 * called before then. Never rejected — a response that omits a segment
 * fulfills it with `null`, which renders as a suspension until the router
 * updates again.
 */
export type ComponentData =
  | EmptyComponentData
  | PendingComponentData
  | FulfilledComponentData

export type EmptyComponentData = {
  status: 'empty'
  value: null
  varyParams: null
  /**
   * The request the data is in flight for, while pending. Only that request's
   * response writes into it, fulfilling or aborting it; a navigation sharing
   * the object leaves it alone. Null otherwise, so a fulfilled object that lives
   * on in the BFCache doesn't retain the request that fetched it.
   */
  owner: null
  /**
   * When the data stops being fresh for a regular navigation. Provisional
   * until fulfilled (the default dynamic stale time); the response's own
   * stale time replaces it on fulfill.
   */
  staleAt: number
  /** Profiling info for React DevTools; the response's is appended on fulfill. */
  _debugInfo: Array<any>
  /**
   * Callbacks waiting for the data, called on fulfill. Null until the first
   * `then` before fulfill; nodes are constructed during SSR, where nothing
   * calls `then`, so nothing is allocated there.
   */
  listeners: Array<(value: React.ReactNode) => void> | null
  /**
   * React's published types accept only a PromiseLike `then`, so it is typed
   * as one; the implementation records `onFulfill` in `listeners` and returns
   * nothing. React reads `status` and `value` first and calls `then` only
   * for a status it doesn't recognize as settled, ignoring its result.
   */
  then: PromiseLike<React.ReactNode>['then']
}

export type PendingComponentData = {
  status: 'pending'
  value: null
  varyParams: null
  owner: DynamicRequest
  staleAt: number
  _debugInfo: Array<any>
  listeners: Array<(value: React.ReactNode) => void> | null
  then: PromiseLike<React.ReactNode>['then']
}

export type FulfilledComponentData = {
  status: 'fulfilled'
  owner: null
  /**
   * The segment's RSC data. Null when the response did not include the
   * segment: because segment data is always a <LayoutRouter> component,
   * `null` can stand for missing data, and rendering suspends.
   */
  value: React.ReactNode
  /**
   * The source of the params `value` depends on, from the response that
   * produced it. Null when unknown: the data came from a render that didn't
   * track params. A navigation that only changes params this output did not
   * depend on can keep rendering it.
   */
  varyParams: VaryParams | null
  staleAt: number
  _debugInfo: Array<any>
  listeners: null
  then: PromiseLike<React.ReactNode>['then']
}

function createEmptyComponentData(provisionalStaleAt: number): ComponentData {
  return {
    status: 'empty',
    value: null,
    varyParams: null,
    owner: null,
    staleAt: provisionalStaleAt,
    _debugInfo: [],
    listeners: null,
    then: thenComponentData,
  }
}

// The one empty → pending transition: `owner` is asking the server for this
// data (see createRequestTreeFromRenderTree).
function markComponentDataAsPending(
  rsc: EmptyComponentData,
  owner: DynamicRequest
): void {
  const pendingRsc: PendingComponentData = rsc as any
  pendingRsc.status = 'pending'
  pendingRsc.owner = owner
}

function createFulfilledComponentData(
  value: React.ReactNode,
  varyParams: VaryParams | null,
  staleAt: number
): ComponentData {
  return {
    status: 'fulfilled',
    value,
    varyParams,
    owner: null,
    staleAt,
    _debugInfo: [],
    listeners: null,
    then: thenComponentData,
  }
}

// The `then` of every ComponentData. React only calls it before the data is
// fulfilled; the fulfilled branch is for any other caller. Typed as
// PromiseLike's `then` to satisfy React's `use` (see ComponentData); the
// result is never used.
const thenComponentData =
  thenComponentDataImpl as unknown as ComponentData['then']
function thenComponentDataImpl(
  this: ComponentData,
  onFulfill: (value: React.ReactNode) => unknown,
  // Nothing rejects a ComponentData, so `onReject` is never called.
  _onReject?: (reason: unknown) => unknown
): void {
  if (this.status === 'fulfilled') {
    onFulfill(this.value)
  } else {
    const listeners = this.listeners
    if (listeners === null) {
      this.listeners = [onFulfill]
    } else {
      listeners.push(onFulfill)
    }
  }
}

// The one pending → fulfilled transition. Every node and BFCache entry sharing
// the object sees the data, its vary params, and its stale time together.
// Empty data was never requested, so no response can be for it.
function fulfillComponentData(
  rsc: ComponentData,
  value: React.ReactNode,
  varyParams: VaryParams | null,
  staleAt: number,
  responseDebugInfo: Array<any> | null
): void {
  if (rsc.status === 'pending') {
    const fulfilledRsc: FulfilledComponentData = rsc as any
    fulfilledRsc.status = 'fulfilled'
    fulfilledRsc.value = value
    fulfilledRsc.varyParams = varyParams
    fulfilledRsc.owner = null
    fulfilledRsc.staleAt = staleAt
    if (responseDebugInfo !== null) {
      // The debug info represents the latency between the start of the
      // navigation and the start of rendering.
      fulfilledRsc._debugInfo.push.apply(
        fulfilledRsc._debugInfo,
        responseDebugInfo
      )
    }
    const listeners = rsc.listeners
    fulfilledRsc.listeners = null
    if (listeners !== null) {
      for (const listener of listeners) {
        listener(value)
      }
    }
  }
}

// Fulfills a segment whose data the server never sent with `null`, which
// renders as a suspension until the router updates again (see useRenderTree).
function abortPendingComponentData(rsc: ComponentData): void {
  fulfillComponentData(rsc, null, null, rsc.staleAt, null)
}

/**
 * Reads the data to render for a segment, suspending until it is fulfilled.
 * If the node has a `prefetchRsc`, that is rendered first and the final `rsc`
 * takes over in a deferred render once it is fulfilled; otherwise the final
 * data is rendered directly.
 */
export function useRenderTree(tree: RouteTree<CacheNode>): React.ReactNode {
  const cacheNode = tree.data
  // `useDeferredValue` returns the second argument on initial render, then
  // re-renders with the first.
  const rsc = useDeferredValue(
    cacheNode.rsc,
    cacheNode.prefetchRsc !== null ? cacheNode.prefetchRsc : cacheNode.rsc
  )
  // React's published `use` types admit only the statuses React itself sets;
  // at runtime it treats `'empty'` like any status it doesn't recognize as
  // settled (it calls `then` and suspends), so the data is passed as the
  // PromiseLike it is.
  const thenable: PromiseLike<React.ReactNode> = rsc
  const value = use(thenable)
  if (value === null) {
    // The server did not include this segment in its response. Suspend
    // indefinitely; the router is responsible for triggering a new state
    // update to un-suspend it.
    use(unresolvedThenable) as never
  }
  return value
}

/**
 * Helper for the Instant Navigation Testing API. Captures the withheld-data
 * gate of the locked navigation that is current when router work spawns a
 * dynamic write, so the write awaits that same gate even if a newer locked
 * navigation rolls the lock over before its response is applied.
 *
 * Not exposed in production builds by default.
 */
export function getCurrentNavigationLock(): NavigationLock | null {
  if (process.env.__NEXT_EXPOSE_TESTING_API) {
    const { getCurrentNavigationGate } =
      require('./segment-cache/navigation-testing-lock') as typeof import('./segment-cache/navigation-testing-lock')
    return getCurrentNavigationGate()
  }
  return null
}

/**
 * Helper for the Instant Navigation Testing API. Signals that a new locked
 * navigation is beginning: force-resolves the previous locked navigation's
 * withheld-data gate (without ending the scope) and returns a fresh gate for
 * this navigation, which the caller threads to its dynamic-data write. See
 * `beginLockedNavigation` in `navigation-testing-lock`.
 *
 * Not exposed in production builds by default.
 */
export function beginLockedNavigation(): NavigationLock | null {
  if (process.env.__NEXT_EXPOSE_TESTING_API) {
    const { beginLockedNavigation: begin } =
      require('./segment-cache/navigation-testing-lock') as typeof import('./segment-cache/navigation-testing-lock')
    return begin()
  }
  return null
}

/**
 * Helper for the Instant Navigation Testing API. Called during a history
 * traversal: resets the testing lock to a fresh pending scope, releasing any
 * withheld data from prior navigations. See `resetNavigationLockToPending` in
 * `navigation-testing-lock`.
 */
export function resetNavigationLockToPending(): void {
  if (process.env.__NEXT_EXPOSE_TESTING_API) {
    const { resetNavigationLockToPending: reset } =
      require('./segment-cache/navigation-testing-lock') as typeof import('./segment-cache/navigation-testing-lock')
    reset()
  }
}
