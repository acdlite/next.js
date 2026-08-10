import { locale } from 'next/root-params'

export function generateStaticParams() {
  return [{ locale: 'en' }]
}

export default async function RootLayout({
  children,
}: LayoutProps<'/[locale]'>) {
  // Reading the locale root param is what an i18n library does to pick up the
  // active locale (next-intl calls this from `getRequestConfig`). Without this
  // read the param is unused and the bug does not reproduce.
  const activeLocale = await locale()

  return (
    <html lang={activeLocale}>
      <body>{children}</body>
    </html>
  )
}
