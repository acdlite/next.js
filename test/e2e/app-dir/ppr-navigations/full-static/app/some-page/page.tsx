import { getStaticTestData } from '../test-data-service'

export default async function Page() {
  return <div id="result">{await getStaticTestData('Some static data')}</div>
}
