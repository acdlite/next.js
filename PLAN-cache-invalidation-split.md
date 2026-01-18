# Plan: Split Cache Invalidation Strategy

**Status**: In Progress (Planning Phase)
**Branch**: `claude/plan-cache-invalidation-0ouNQ`
**Base Commit**: `7c6f6049`

---

## Goal

Split the segment cache invalidation into two separate strategies:
- **Route cache entries**: Contain structural/routing information (how URLs map to segments, params, etc.) — should persist across most invalidations
- **Segment cache entries**: Contain actual UI data (RSC payloads, loading states) — should be invalidated on revalidateTag/revalidatePath

The motivation is that route metadata rarely changes, so we can preserve it even when data is invalidated, improving performance and reducing unnecessary refetches.

---

## Key Files

| File | Purpose |
|------|---------|
| `packages/next/src/client/components/segment-cache-impl/cache.ts` | Main cache implementation with both entry types |
| `packages/next/src/client/components/segment-cache-impl/navigation.ts` | Navigation logic that reads from the cache |
| `packages/next/src/client/components/segment-cache.ts` | Public API / entry point with DCE wrappers |
| `packages/next/src/client/components/links.ts` | Link prefetching, tracks cache version |

---

## Current Implementation

### Single Global Version (cache.ts:249)
```typescript
let currentCacheVersion = 0
```

### revalidateEntireCache() (cache.ts:261-279)
Called when server actions invoke revalidateTag/revalidatePath:
1. Increments `currentCacheVersion`
2. Clears BOTH `routeCacheMap` and `segmentCacheMap`
3. Resets BOTH LRUs
4. Calls `pingVisibleLinks()` to re-prefetch

### Data Structures

**RouteCacheEntry** (lines 89-148):
- `canonicalUrl`, `tree` (RouteTree), `head`, `couldBeIntercepted`, `isPPREnabled`
- Does NOT contain displayable UI data
- Keyed by `[NormalizedHref, NormalizedNextUrl]`

**SegmentCacheEntry** (lines 156-209):
- `rsc` (React.ReactNode), `loading` (LoadingModuleData)
- `isPartial` flag
- Contains actual rendered content
- Keyed by `[segmentPath, NormalizedSearch]`

### Version Usage in links.ts
- Each link instance stores `cacheVersion` (line 33)
- Compared against `getCurrentCacheVersion()` to detect invalidation
- `pingVisibleLinks()` re-prefetches visible links after invalidation

---

## Proposed Changes

### 1. Split Version Numbers
```typescript
let routeCacheVersion = 0
let segmentCacheVersion = 0
```

### 2. Separate Invalidation Functions
- `revalidateSegmentCache()` — clears segment entries only, increments `segmentCacheVersion`
- `revalidateRouteCache()` — clears route entries only, increments `routeCacheVersion`
- `revalidateEntireCache()` — calls both (for cookie updates or backward compat)

### 3. Update links.ts
Track which version(s) to compare for re-prefetch decisions.

---

## Open Questions

### Q1: Version Tracking in Links
Currently links store one `cacheVersion`. With two versions:
- Track both on link instances?
- Or only trigger re-prefetch on segment invalidation (since routes don't have displayable data)?

### Q2: pingVisibleLinks Behavior
- Segment invalidation: should call `pingVisibleLinks()` (need fresh data)
- Route invalidation (rare, cookie case): also re-prefetch, or lazy fetch on navigation?

### Q3: Stale Time Relationship
Segment entries often inherit `staleAt` from their route (cache.ts:1174). Should they:
- Continue using route's `staleAt` as baseline?
- Have completely independent stale times?

### Q4: Cookie Exception
When a server action sets a cookie, what should happen?
- Invalidate both caches?
- Just route cache (cookies affect Next-Url / interception)?

### Q5: Interception Routes
Route entries have `couldBeIntercepted` flag and vary on `Next-Url`. Since interception can depend on cookies/state:
- Should interceptable routes be invalidated more aggressively?
- Or treat them the same as non-intercepted routes?

---

## Next Steps

1. Answer open questions above
2. Design the API changes
3. Implement version split in cache.ts
4. Update links.ts version tracking
5. Update callers (server-action-reducer, refresh-reducer)
6. Add tests

---

## Notes

- Exception for cookie updates will be handled separately (per user)
- This is a client-side only change; server behavior unchanged
