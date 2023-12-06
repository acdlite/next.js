import { getStaticTestData } from './test-data-service'

export default async function Loading() {
  return (
    <div id="loading-tsx">
      {await getStaticTestData('Loading... [provided by loading.tsx]')}
    </div>
  )
}
