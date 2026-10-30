import { SkeletonRows } from '@/components/ui/Skeleton';

/** Record-page loading (keeps the list skeleton of the parent segment off this route). */
export default function Loading() {
  return <SkeletonRows rows={8} label="Loading…" />;
}
