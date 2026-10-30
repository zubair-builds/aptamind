import { PageHeader } from '@/components/Section';
import { SkeletonRows } from '@/components/ui/Skeleton';

export default function Loading() {
  return (
    <>
      <PageHeader title="Runs" />
      <SkeletonRows rows={10} label="Loading…" />
    </>
  );
}
