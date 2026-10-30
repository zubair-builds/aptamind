import { companiesObject } from '@/components/records/registry/companies';
import { RecordList } from '@/components/records/table/RecordList';
import { PageHeader } from '@/components/Section';

export const metadata = { title: 'Companies' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function CompaniesPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <PageHeader
        title="Companies"
        subtitle="Canonical companies (active). Every material field is a fact with provenance."
      />
      <RecordList def={companiesObject} params={await searchParams} />
    </>
  );
}
