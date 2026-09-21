import { DYNAMIC_STALETIME_MS } from '../router-reducer/reducers/navigate-reducer'
import type { CacheNode } from '../../../shared/lib/app-router-types'
import type { ComponentData } from '../render-tree'
import type { VaryPath } from './vary-path'

/**
 * Sentinel value indicating that no per-page dynamic stale time was provided.
 * When this is the dynamicStaleTime, the default DYNAMIC_STALETIME_MS is used.
 */
export const UnknownDynamicStaleTime = -1

/**
 * Converts a dynamic stale time (in seconds, as sent by the server in the `d`
 * field of the Flight response) to an absolute staleAt timestamp. When the
 * value is unknown, falls back to the global DYNAMIC_STALETIME_MS.
 */
export function computeDynamicStaleAt(
  now: number,
  dynamicStaleTimeSeconds: number
): number {
  return dynamicStaleTimeSeconds !== UnknownDynamicStaleTime
    ? now + dynamicStaleTimeSeconds * 1000
    : now + DYNAMIC_STALETIME_MS
}
import {
  setInCacheMap,
  getFromCacheMap,
  EntryStatus,
  type UnknownMapEntry,
  type CacheMap,
  createCacheMap,
} from './cache-map'

/**
 * Holds the data a navigation rendered for a segment, keyed by the segment's
 * vary path, so a later navigation can render it again. The entry shares the
 * CacheNode's `rsc` object; when a pending one is fulfilled, the entry sees
 * the data, its vary params, and its stale time with nothing to patch.
 *
 * TODO: Consider merging this wrapper into the ComponentData it holds, so the
 * BFCache stores the shared data directly. Three things stood in the way:
 * MapValue.status is the numeric EntryStatus while React reads `status` as
 * a string; the CacheMap keeps a value under one key and moves it when it is
 * written again, but the same data is written under a new vary path when a
 * navigation reuses it for unread params; and bfcacheId follows the React
 * `key`, not the data, so it would need its own cache.
 *
 * TODO: Write entries at the most generic vary path their varyParams allow,
 * as writeSegmentDataIntoCache does with getFulfilledSegmentVaryPath, so a
 * history traversal to a URL that differs only in unread params hits the
 * entry. Today entries are keyed at the concrete path.
 */
export type BFCacheEntry = {
  rsc: ComponentData
  prefetchRsc: ComponentData | null

  // The bfcacheId of the CacheNode that wrote this entry. Restored on
  // history-traversal navigations so that `useRouter().bfcacheId` is stable
  // across back/forward, even without `cacheComponents` Activity preservation.
  bfcacheId: number

  ref: UnknownMapEntry | null
  size: number
  // The time at which this data was received. Used to compute the stale time
  // for dynamic prefetches (which use STATIC_STALETIME_MS instead of
  // DYNAMIC_STALETIME_MS). Stored explicitly because rsc.staleAt may be
  // overridden by a per-page unstable_dynamicStaleTime, which would break
  // any reverse calculation from it.
  navigatedAt: number
  // Freshness is judged from `rsc.staleAt`, which the response fills in; this
  // field only satisfies the MapValue protocol and never expires the entry.
  staleAt: number
  version: number
  // A BFCacheEntry always represents a completed navigation, so the status is
  // always Fulfilled. The field exists so that BFCacheEntry conforms to the
  // MapValue protocol.
  status: EntryStatus.Fulfilled
}

const bfcacheMap: CacheMap<BFCacheEntry> = createCacheMap()

let currentBfCacheVersion = 0

export function invalidateBfCache(): void {
  if (typeof window === 'undefined') {
    return
  }
  currentBfCacheVersion++
}

export function writeToBFCache(
  now: number,
  varyPath: VaryPath,
  cacheNode: CacheNode
): void {
  if (typeof window === 'undefined') {
    return
  }

  const entry: BFCacheEntry = {
    rsc: cacheNode.rsc,
    prefetchRsc: cacheNode.prefetchRsc,

    bfcacheId: cacheNode.bfcacheId,

    ref: null,
    // TODO: This is just a heuristic. Getting the actual size of the segment
    // isn't feasible because it's part of a larger streaming response. The
    // LRU will still evict it, we just won't have a fully accurate total
    // LRU size. However, we'll probably remove the size tracking from the LRU
    // entirely and use memory pressure events instead.
    size: 100,

    navigatedAt: now,

    staleAt: Infinity,
    version: currentBfCacheVersion,
    status: EntryStatus.Fulfilled,
  }
  const isRevalidation = false
  setInCacheMap(bfcacheMap, varyPath, entry, isRevalidation)
}

export function readFromBFCache(varyPath: VaryPath): BFCacheEntry | null {
  if (typeof window === 'undefined') {
    return null
  }
  const isRevalidation = false
  return getFromCacheMap(
    // During a back/forward navigation, it doesn't matter how stale the data
    // might be. Pass -1 instead of the actual current time to bypass
    // staleness checks.
    -1,
    currentBfCacheVersion,
    bfcacheMap,
    varyPath,
    isRevalidation,
    false
  )
}

export function readFromBFCacheDuringRegularNavigation(
  now: number,
  varyPath: VaryPath
): BFCacheEntry | null {
  if (typeof window === 'undefined') {
    return null
  }
  const isRevalidation = false
  const entry = getFromCacheMap(
    -1,
    currentBfCacheVersion,
    bfcacheMap,
    varyPath,
    isRevalidation,
    false
  )
  if (entry === null) {
    return null
  }
  // The stale time is only relevant when staleTimes.dynamic is enabled or
  // unstable_dynamicStaleTime is exported by a page.
  if (entry.rsc.staleAt <= now) {
    return null
  }
  return entry
}
