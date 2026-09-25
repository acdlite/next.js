import { LinkAccordion } from '../../../../components/link-accordion'

/**
 * Navigation reuse: a path param change under a static layout. The [id]
 * layout below is prerendered and never reads the param; its page reads it.
 * A prefetch of another id should fetch the page but not the layout, whose
 * current data the navigation keeps.
 */
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ul>
        <li>
          <LinkAccordion href="/navigation-reuse/static-layout-param/a">
            a
          </LinkAccordion>
        </li>
        <li>
          <LinkAccordion href="/navigation-reuse/static-layout-param/b">
            b
          </LinkAccordion>
        </li>
      </ul>
      {children}
    </>
  )
}
