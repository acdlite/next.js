import { Suspense } from 'react'
import { connection } from 'next/server'

// Static, and never reads params. The head is kept across ids like the
// layout is.
export const metadata = { title: 'Static head for every id' }

async function PageId({ params }: { params: Promise<{ id: string }> }) {
  await connection()
  const { id } = await params
  return <p id="page-id">{`Page id: ${id}`}</p>
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <>
      <p id="page-static">Static page header</p>
      <Suspense fallback={<p data-loading="true">Loading page id...</p>}>
        <PageId params={params} />
      </Suspense>
    </>
  )
}
