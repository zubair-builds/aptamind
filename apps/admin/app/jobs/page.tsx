import { jobsObject } from '@/components/records/registry/jobs';
import { RecordList } from '@/components/records/table/RecordList';
import { PageHeader } from '@/components/Section';

export const metadata = { title: 'Jobs' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function JobsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <PageHeader
        title="Jobs"
        subtitle="Track and manage open roles across partner companies."
      />
      <RecordList def={jobsObject} params={await searchParams} />
    </>
  );
}
