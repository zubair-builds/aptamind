import { PageHeader } from '@/components/Section';
import { SkeletonRows } from '@/components/ui/Skeleton';

export default function Loading() {
  return (
    <>
      <PageHeader title="Jobs" />
      <SkeletonRows rows={10} label="Loading jobs…" />
    </>
  );
}
