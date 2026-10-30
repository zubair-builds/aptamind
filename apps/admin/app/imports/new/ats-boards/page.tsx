import { MappedImportPage } from '@/components/imports/MappedImportPage';

export const metadata = { title: 'Import known ATS boards' };

export default function ImportAtsBoardsPage() {
  return (
    <MappedImportPage
      type="ats_boards"
      subtitle="Each row names a Greenhouse, Ashby or Lever board and its company. A board whose company is unclear goes to review."
    />
  );
}
