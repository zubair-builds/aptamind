import { reviewObject } from '@/components/records/registry/review';
import { RecordList } from '@/components/records/table/RecordList';
import { PageHeader } from '@/components/Section';

export const metadata = { title: 'Review queue' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ReviewQueuePage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <PageHeader
        title="Review queue"
        subtitle="Items that need a human decision. Open first, then recently decided."
      />
      <RecordList def={reviewObject} params={await searchParams} />
    </>
  );
}
