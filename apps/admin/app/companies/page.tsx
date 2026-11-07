import { companiesObject } from '@/components/records/registry/companies';
import { RecordList } from '@/components/records/table/RecordList';
import { PageHeader } from '@/components/Section';

export const metadata = { title: 'Companies' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function CompaniesPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <PageHeader title="Companies" subtitle="Manage and monitor partner companies and their activity." />
      <RecordList def={companiesObject} params={await searchParams} />
    </>
  );
}
