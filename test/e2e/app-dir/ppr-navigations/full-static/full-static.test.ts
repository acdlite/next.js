import { createNext } from 'e2e-utils'
import { findPort } from 'next-test-utils'
import { createTestDataServer } from 'test-data-service/writer'
import { createTestLog } from 'test-log'

describe('full-static', () => {
  if ((global as any).isNextDev) {
    test('ppr is disabled in dev', () => {})
    return
  }

  let server
  let next
  afterEach(async () => {
    await next?.destroy()
    server?.close()
  })

  test(
    'no dynamic request is made if the prefetched data contained no ' +
      'dynamic holes',
    async () => {
      const TestLog = createTestLog()
      let isBuilding = true
      server = createTestDataServer(async (key, res) => {
        if (isBuilding) {
          TestLog.log('REQUEST: ' + key)
          res.resolve()
        } else {
          // In this test, we don't expect any requests except during build.
          TestLog.log('UNEXPECTED REQUEST: ' + key)
          res.reject(new Error('Unexpected request: ' + key))
        }
      })
      const port = await findPort()
      server.listen(port)
      next = await createNext({
        files: __dirname,
        env: { TEST_DATA_SERVICE_URL: `http://localhost:${port}` },
      })
      isBuilding = false
      TestLog.assert(['REQUEST: Some static data'])

      const browser = await next.browser('/')
      browser.on('request', (req) => {
        if (req.resourceType() === 'fetch') {
          TestLog.log('Client fetch request')
        }
      })

      // On initial load, a prefetch request is made for the target page.
      await TestLog.waitFor(['Client fetch request'])

      const link = await browser.elementByCss('a[href="/some-page"]')

      // Navigate to a page that was completely statically generated at
      // build time. This should not issue an additional fetch request.
      await link.click()

      const result = await browser.elementById('result')
      expect(await result.innerText()).toBe('Some static data')

      // There was no additional fetch request from the client.
      TestLog.assert([])
    }
  )
})
