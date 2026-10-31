import { MappedImportPage } from '@/components/imports/MappedImportPage';

export const metadata = { title: 'Import job links' };

export default function ImportJobLinksPage() {
  return (
    <MappedImportPage
      type="jobs"
      subtitle="Each row is a job link (Greenhouse, Ashby or Lever). Boards are refreshed right away, so the jobs appear without waiting for the schedule."
    />
  );
}
