import React, { Suspense } from 'react'
import { TriggerBadSuspenseFallback } from './client'

async function Dynamic({ dataKey }) {
  return <div id="dynamic">{await getDynamic(`${dataKey} [dynamic]`)}</div>
}

async function Static({ dataKey }) {
  return <div id="static">{await getStatic(`${dataKey} [static]`)}</div>
}

export default async function Page({
  params: { dataKey },
}: {
  params: { dataKey: string }
}) {
  return (
    <>
      <div id="container">
        <Suspense fallback="Loading dynamic...">
          <Dynamic dataKey={dataKey} />
        </Suspense>
        <Suspense fallback="Loading static...">
          <Static dataKey={dataKey} />
        </Suspense>
      </div>
      <TriggerBadSuspenseFallback />
    </>
  )
}

// NOTE: I've intentionally not yet moved these helpers into a separate
// module, to avoid early abstraction. I will if/when we start using them for
// other tests. They are based on the testing patterns we use all over the React
// codebase, so I'm reasonably confident in them.
const TEST_DATA_SERVICE_URL = process.env.TEST_DATA_SERVICE_URL
const ARTIFICIAL_DELAY = 200

async function getDynamic(key: string) {
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
      cache: 'no-store',
    }
  )
  const text = await response.text()
  if (response.status !== 200) {
    throw new Error(text)
  }
  return text
}

async function getStatic(key: string) {
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
      cache: 'force-cache',
    }
  )
  const text = await response.text()
  if (response.status !== 200) {
    throw new Error(text)
  }
  return text
}
