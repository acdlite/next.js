import { Suspense } from 'react'
import Link from 'next/link'

// A breadcrumb trail: one link per ancestor of the current catch-all path. The
// link to `/one/two` is the interesting one — it has enough parts to fully
// match the `/[locale]/[...pages]` pattern the client learned, so the client
// predicts the route instead of asking the server for it.
async function Breadcrumbs({
  params,
}: Pick<PageProps<'/[locale]/[...pages]'>, 'params'>) {
  const { pages } = await params

  return (
    <nav>
      {pages.map((segment, index) => {
        const href = `/${pages.slice(0, index + 1).join('/')}`
        const isCurrentPage = index === pages.length - 1

        return isCurrentPage ? (
          <span key={href}>{segment}</span>
        ) : (
          <Link key={href} href={href} id={`crumb-${segment}`}>
            {segment}
          </Link>
        )
      })}
    </nav>
  )
}

export default function Page(props: PageProps<'/[locale]/[...pages]'>) {
  return (
    <main>
      <Suspense fallback={<p>loading breadcrumbs</p>}>
        <Breadcrumbs params={props.params} />
      </Suspense>
      <h1 id="page-title">Page content</h1>
    </main>
  )
}
