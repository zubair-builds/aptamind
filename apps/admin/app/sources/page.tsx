import { sourcesObject } from '@/components/records/registry/sources';
import { RecordList } from '@/components/records/table/RecordList';
import { PageHeader } from '@/components/Section';

export const metadata = { title: 'Sources' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SourcesPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <PageHeader
        title="Sources"
        subtitle="Information origins: acquisition workflow, schedule, authority, governance and health."
      />
      <RecordList def={sourcesObject} params={await searchParams} />
    </>
  );
}
