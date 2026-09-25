import { readSetLedger, type SetLedgerValue } from '../ledger-decoding'
import { readFulfilledValue } from '../rsc-transport'

/**
 * The vary path id for search params. Path params are identified by their
 * name. Search params don't have a fixed set of names, so any access to them
 * is reported under this one id, and the segment is keyed by the whole search
 * string (see createVaryingSearchParams in app-render/vary-params.ts).
 *
 * It's a number so it can't collide with a param name. `app/[?]/page.tsx` is a
 * valid route.
 */
export const SEARCH_PARAMS_VARY_ID = 0

// Path param names, and SEARCH_PARAMS_VARY_ID for the search params.
export type VaryParamId = string | number

/**
 * The params a piece of rendered output depends on — the ids of the vary path
 * nodes it read: path param names, and SEARCH_PARAMS_VARY_ID for the search
 * params — as the source that reports them rather than a snapshot of it.
 *
 * A built-in Ledger total is the promise the server sent, kept as-is: it may
 * still be pending while the render that produced it is streaming, and it
 * settles with the final set once that render finishes. Userspace tracking
 * sends iterables that can only be drained from a fully-buffered response;
 * they are drained once at decode into an already-settled thenable. Both are
 * read the same way, at the point a decision needs the set (readVaryParams),
 * so a value stored while its render was in flight still reads correctly
 * later.
 */
export type VaryParams = PromiseLike<Set<VaryParamId>>

/**
 * Converts a segment's (or the head's) vary params off the wire, at the
 * decode boundary. Returns null when the dependency information is
 * unavailable: tracking was not enabled for the render, or, for userspace
 * tracking, the response has no root params to union in (a streaming
 * response). Readers treat null as "assume every param varies".
 */
export function decodeVaryParams(
  value: SetLedgerValue<VaryParamId> | null | undefined,
  rootValue: SetLedgerValue<VaryParamId> | null | undefined
): VaryParams | null {
  if (value == null) {
    return null
  }
  if (process.env.__NEXT_LEDGERS) {
    // A built-in total already includes the root-param reads that belong to
    // its scope, and it settles on its own when the render finishes.
    return value as Promise<Set<VaryParamId>>
  }
  // Userspace tracking sends root params once for the entire response.
  if (rootValue == null) {
    return null
  }
  const total = readSetLedger(value)
  if (total === null) {
    return null
  }
  const rootTotal = readSetLedger(rootValue)
  if (rootTotal === null) {
    return null
  }
  for (const name of rootTotal) {
    total.add(name)
  }
  return createVaryParams(total)
}

/**
 * Wraps an already-known set as a vary params source. Shaped like a settled
 * Flight promise so readVaryParams reads both implementations the same way.
 */
export function createVaryParams(total: Set<VaryParamId>): VaryParams {
  // TODO: Don't need to use a native promise. Just inline a thenable that
  // immediately calls its listener.
  const settled = Promise.resolve(total) as Promise<Set<VaryParamId>> & {
    status: 'fulfilled'
    value: Set<VaryParamId>
  }
  settled.status = 'fulfilled'
  settled.value = total
  return settled
}

/**
 * Reads the set from a vary params source. Null when it is not available
 * yet (the render is still in flight) or never will be (the render aborted);
 * either way the reader assumes every param varies.
 */
export function readVaryParams(
  varyParams: VaryParams
): Set<VaryParamId> | null {
  return readFulfilledValue(varyParams, null)
}
