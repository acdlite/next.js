// NOTE: I've intentionally not yet moved these helpers into a shared
// module, to avoid early abstraction. I will if/when we start using them for
// other tests. They are based on the testing patterns we use all over the React
// codebase, so I'm reasonably confident in them.
const TEST_DATA_SERVICE_URL = process.env.TEST_DATA_SERVICE_URL
const ARTIFICIAL_DELAY = 200

async function getTestData(key: string, isDynamic: boolean) {
  const searchParams = new URLSearchParams({
    key,
  })
  if (!TEST_DATA_SERVICE_URL) {
    // If environment variable is not set, resolve automatically after a delay.
    // This is so you can run the test app locally without spinning up a
    // data server.
    await new Promise<void>((resolve) =>
      setTimeout(() => resolve(), ARTIFICIAL_DELAY)
    )
    return key
  }
  const response = await fetch(
    TEST_DATA_SERVICE_URL + '?' + searchParams.toString(),
    {
      cache: isDynamic ? 'no-store' : 'force-cache',
    }
  )
  const text = await response.text()
  if (response.status !== 200) {
    throw new Error(text)
  }
  return text
}

export async function getDynamicTestData(key: string) {
  return getTestData(key, true)
}

export async function getStaticTestData(key: string) {
  return getTestData(key, false)
}
