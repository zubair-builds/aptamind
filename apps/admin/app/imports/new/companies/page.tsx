import { MappedImportPage } from '@/components/imports/MappedImportPage';

export const metadata = { title: 'Import companies' };

export default function ImportCompaniesPage() {
  return (
    <MappedImportPage
      type="companies"
      subtitle="Each row becomes a company observation. Matching, merging and reviews follow the normal company rules."
    />
  );
}
