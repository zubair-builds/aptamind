import { importsObject } from '@/components/records/registry/imports';
import { RecordList } from '@/components/records/table/RecordList';
import { PageHeader } from '@/components/Section';

export const metadata = { title: 'Imports' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ImportsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <PageHeader
        title="Imports"
        subtitle="Files you brought in. Each import runs through the normal evidence path: snapshot, run, observations, records and reviews."
      />
      <RecordList def={importsObject} params={await searchParams} />
    </>
  );
}
