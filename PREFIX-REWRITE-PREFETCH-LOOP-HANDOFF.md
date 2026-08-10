# Handoff: infinite prefetch loop when a proxy injects a leading path segment

Status: **reproduced, root-caused, not fixed.** There is a failing e2e test on this
branch that pins the bug. Nothing in `packages/` has been touched.

Reported as "next-intl causes a request waterfall":
<https://github.com/MarkBekooy/prefetching-request-waterfall-bug/pull/1>.
next-intl is incidental — the bug reproduces on plain Next with a 15-line proxy.

## Symptom

On a production build, loading a deep catch-all URL makes the client prefetch one
of the links on the page in a tight, serial loop — about **140 requests/second,
indefinitely**. Because the prefetch queue is serial, the stuck task also starves
every other link on the page, so those never get prefetched at all.

## Reproduce

```
nxt test-start-turbo test/e2e/app-dir/proxy-prefix-rewrite-prefetch-loop/proxy-prefix-rewrite-prefetch-loop.test.ts
```

Fails on `16.3.1-canary.10` with ~500–2000 requests for `/one/two`. The first
assertion prints the offending request state tree:

```json
["",{"children":[["locale","one","d",null],{"children":[["pages","two","c",null], …
```

The fixture is a locale-injecting proxy (`/one/two` → `/en/one/two`) plus
`app/[locale]/[...pages]`, with `cacheComponents` and `partialPrefetching` on.

That tree is the whole bug in one line: the browser asked for
`/one/two/three/four`, the proxy rewrote it to `/en/one/two/three/four`, so the
truth is `locale=en, pages=['one','two','three','four']`. The client instead
believes `locale=one, pages=['two']`.

## Root cause

Three links in a chain. The first two produce the wrong prediction; the third is
why it never recovers.

**1. The pattern is learned against the wrong pathname.**
`fetchRouteOnCacheMiss` (`packages/next/src/client/components/segment-cache/cache.ts:2032`)
builds the route tree from the _rendered_ pathname —
`getRenderedPathname(response)`, i.e. the `x-nextjs-rewritten-path` header, so
`/en/one/two` — but then calls `discoverKnownRoute` with `pathname`, which is
`key.pathname`, the _requested_ `/one/two` (`cache.ts:2217`). The initial-load
seed does the same thing with `location.pathname`
(`router-reducer/create-initial-router-state.ts:109`).

So the trie is indexed by requested-URL parts while its shape came from the
rendered path. For `/[locale]/[...pages]` the two happen to have compatible
shapes, so nothing looks wrong: the trie learns "at the root, a dynamic child
named `locale` consumes URL part 0."

**2. Rewrite detection cannot fire for this shape.**
`discoverKnownRoutePart` only bails out when a **static** segment fails to match
its URL part (`optimistic-routes.ts:384`, `handleMismatchDueToRewrite` at
`:288`). Here every segment is dynamic, so there is no static segment to
disagree, and a dynamic segment happily consumes whatever part is in front of
it. The existing `mayBeSkippedInURL` TODO at `optimistic-routes.ts:119` is
exactly this gap — a part that "may not appear in the candidate URL because it
was injected by a rewrite."

**3. Nothing ever corrects a mispredicted _prefetch_.**
`matchKnownRoute` (`optimistic-routes.ts:614`) matches `/one/two`, reifies the
pattern with `locale=one, pages=two`, and installs the synthetic entry as the
new pattern. Its comment states the intended safety net:

> Why replace the pattern? We intentionally update the pattern with this
> synthetic entry so that if our prediction was wrong (server returns a
> different pathname due to dynamic rewrite), the entry gets marked with
> hasDynamicRewrite.

That net never engages here. `markRouteEntryAsDynamicRewrite`
(`cache.ts:1625`) has exactly **one** caller, and it is on the _navigation_
mismatch-retry path (`router-reducer/ppr-navigations.ts:1698`). The prefetch
path never compares the response's rendered pathname against the pathname it
predicted, and every `discoverKnownRoute` call in the prefetch path passes
`hasDynamicRewrite: false` as a literal (`cache.ts:2228`, `cache.ts:3496`).

So the bad pattern stays fresh and valid, the synthetic entry gets re-derived,
the request goes out again, and the task spins. Note the navigation path also has
a `previousNavigationDidMismatch` → hard-refresh circuit breaker; the prefetch
path has no equivalent bound, which is why this presents as an unbounded loop
rather than one wasted request.

## Fix directions

These are not mutually exclusive, and I'd argue (3) is worth doing regardless of
which of (1)/(2) you pick.

1. **Teach the trie about rewrite-injected segments** — implement the
   `mayBeSkippedInURL` TODO. Compare the requested pathname against the rendered
   pathname at learn time; when they differ by a prefix, either refuse to store
   the pattern, or store the offset so matching can account for it. Most correct,
   most invasive. Note that "differ by a prefix" is the easy case — a rewrite can
   change the path arbitrarily, so the conservative version is closer to "if
   requested ≠ rendered, don't store a pattern."
2. **Close the prefetch-side detection gap** — have the prefetch response path
   compare rendered vs. predicted pathname and call
   `markRouteEntryAsDynamicRewrite` + `invalidateRouteCacheEntries`, mirroring
   what `ppr-navigations.ts` already does for navigations. Smaller and reuses an
   existing mechanism; costs one bad request per pattern instead of infinite.
   Careful: `invalidateRouteCacheEntries` bumps the cache version and calls
   `pingVisibleLinks`, so a bug here trades one loop for another.
3. **Bound the retry** — a mispredicted prefetch that can never be satisfied
   should back off or give up, the way `rejectSegmentEntriesIfStillPending`
   already backs off 10s on a server error. Whatever the routing fix, a client
   that can be made to issue 140 req/s forever by a rewrite is worth a
   backstop.

## Things that will mislead you

- **next-intl is a red herring.** I bisected it out entirely. Its middleware is
  not needed; a plain `NextResponse.rewrite` prefix injection reproduces it.
- **Dev mode passes.** Only `next start` reproduces. In webpack dev the trie's
  `staticChildren` is `null` (routes compile on demand), which already forces
  server resolution — see the comment at `optimistic-routes.ts:739`.
- **Shallow links look fine.** A one-part link like `/categories` does _not_
  loop, because a required catch-all needs ≥1 remaining part, so the match fails
  and it falls back to a `/_tree` request. You need a link with enough parts to
  fully match the pattern. Don't conclude from a passing shallow case that the
  bug is gone.
- **Removing the root-param read makes it vanish.** If the root layout doesn't
  actually read `locale`, it stops reproducing. Keep the `await locale()` in the
  fixture layout.
- **`x-nextjs-rewritten-path` is not the bug.** The header is correct and the
  server responses are byte-identical in structure with and without next-intl. I
  verified this by diffing `/_tree` responses. The bug is purely in how the
  client indexes what it learned.
- **The existing rewrite-detection coverage passes, and will keep passing.**
  `test/e2e/app-dir/optimistic-routing` covers rewrite detection, but only for
  _length-preserving_ rewrites (`/rewritten/[slug]` → `/actual/[slug]`), where a
  static segment differs and the `:384` check fires. There is no existing
  coverage for a rewrite that changes the number of path segments.

## Verification checklist

- `proxy-prefix-rewrite-prefetch-loop` passes in **start** mode (it already
  passes in dev, so a dev-only green run proves nothing).
- `test/e2e/app-dir/optimistic-routing` still passes — this is the suite most
  likely to regress, since any fix that makes learning more conservative can
  disable prediction where it is currently correct and asserted.
- `test/e2e/app-dir/segment-cache`, `app-prefetch`, `app-prefetch-false`,
  `partial-prefetching-config`.
- Watch for the opposite failure mode: a fix that bails out too eagerly turns
  prediction off for ordinary dynamic routes. The `optimistic-routing` tests
  assert that prediction _does_ happen (instant loading states), so a silent
  perf regression should show up there — confirm they fail for the right reason
  if you break them.
- Consider adding a length-changing rewrite case to `optimistic-routing` so the
  gap is covered where the rest of this behavior lives, rather than only in the
  standalone repro fixture.

## Open questions I did not chase

- Exactly which scheduler path re-issues the request with no delay. I established
  the loop empirically (~140 req/s, serial) and established that no
  `markRouteEntryAsDynamicRewrite` call exists on the prefetch side, but I did
  not trace the precise re-entry point in `segment-cache/scheduler.ts`. Worth
  pinning down before choosing (3), since it determines where a backoff belongs.
- Whether a navigation (not just a prefetch) to the mispredicted URL recovers
  correctly here. The navigation path has the marking + hard-refresh circuit
  breaker, so it probably does, but I only measured prefetch traffic.
- Whether non-prefix rewrites that change segment count (e.g. dropping a
  segment) produce the same loop. Likely, and worth a second fixture case.
