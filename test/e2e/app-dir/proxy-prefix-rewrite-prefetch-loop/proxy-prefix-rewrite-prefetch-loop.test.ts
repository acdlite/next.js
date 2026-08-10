import { nextTestSetup } from 'e2e-utils'
import { waitFor } from 'next-test-utils'
import type { Page, Request } from 'playwright'

const NEXT_ROUTER_STATE_TREE_HEADER = 'next-router-state-tree'

function getPathname(url: string) {
  return new URL(url).pathname
}

function decodeStateTree(value: string | undefined): string | null {
  if (value === undefined) {
    return null
  }
  // The header is sent percent-encoded.
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

describe('proxy-prefix-rewrite-prefetch-loop', () => {
  const { next } = nextTestSetup({
    files: __dirname,
  })

  // Only reproduces in a production build; dev does not predict routes from a
  // learned pattern the same way.
  it('does not prefetch an ancestor link in a loop when the proxy injects a path segment', async () => {
    const rscRequests: Array<{ pathname: string; stateTree: string | null }> =
      []

    const browser = await next.browser('/one/two/three/four', {
      beforePageLoad(page: Page) {
        page.on('request', (request: Request) => {
          const headers = request.headers()
          if (headers['rsc'] === undefined) {
            return
          }
          rscRequests.push({
            pathname: getPathname(request.url()),
            stateTree: decodeStateTree(headers[NEXT_ROUTER_STATE_TREE_HEADER]),
          })
        })
      },
    })

    await browser.waitForElementByCss('#page-title')
    // The breadcrumbs are what render the ancestor links, so wait for the
    // Suspense boundary to resolve before timing the prefetches.
    await browser.waitForElementByCss('#crumb-two')
    // Give the prefetch scheduler time to settle. A looping task issues
    // hundreds of requests in this window.
    await waitFor(3000)

    // The browser asked for `/one/two/three/four`; the proxy rewrote it to
    // `/en/one/two/three/four`. So `locale` is `en` and `pages` is
    // `['one','two','three','four']`. If the client instead binds `locale` to
    // `one`, it has matched the URL against the `/[locale]/[...pages]` pattern
    // without accounting for the segment the proxy injected. The server can
    // never return the segments such a request asks for, so the prefetch never
    // settles and the task retries forever.
    //
    // Deduplicated because the loop produces thousands of identical requests.
    const mispredictedTrees = Array.from(
      new Set(
        rscRequests
          .map(({ stateTree }) => stateTree)
          .filter(
            (stateTree): stateTree is string =>
              stateTree !== null && /"locale","(?!en")/.test(stateTree)
          )
      )
    )

    expect(mispredictedTrees).toEqual([])

    // `/one/two` is an ancestor of the current page, and the first link with
    // enough URL parts to fully match the learned pattern.
    const requestsForAncestor = rscRequests.filter(
      ({ pathname }) => pathname === '/one/two'
    )

    expect(requestsForAncestor.length).toBeLessThanOrEqual(2)
  })
})
