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
        subtitle="Canonical jobs (active). Filters, sort and columns live in the URL, so a view is a link."
      />
      <RecordList def={jobsObject} params={await searchParams} />
    </>
  );
}
