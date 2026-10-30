import { PageHeader } from '@/components/Section';
import { apiGet } from '@/lib/api';
import { IMPORT_KINDS, type MappedImportType } from '@/lib/import-mapping';
import type { SourceListItem } from '@/lib/types';
import { ImportWizard, type ListOption } from './ImportWizard';

const LIMIT = 200;
const TITLES: Record<MappedImportType, string> = {
  companies: 'Import companies',
  ats_boards: 'Import known ATS boards',
  jobs: 'Import job links',
};

/** Server half of the mapped import pages: loads the existing lists of the provider. */
export async function MappedImportPage({ type, subtitle }: { type: MappedImportType; subtitle: string }) {
  const kind = IMPORT_KINDS[type];
  const res = await apiGet<{ items: SourceListItem[]; nextCursor: string | null }>('/api/sources', {
    provider: kind.provider,
    sort: 'name',
    limit: LIMIT,
    count: 'none',
  });
  const lists: ListOption[] = res.ok
    ? res.data.items.map((src) => {
        const config = src.acquisition.config ?? {};
        const country = config.defaultCountry;
        return {
          id: src._id,
          name: src.name,
          columns: config.columns,
          ...(typeof country === 'string' ? { defaultCountry: country } : {}),
        };
      })
    : [];
  const listsNote = !res.ok
    ? `Existing lists could not be loaded (${res.error.code}). You can still import into a new list.`
    : res.data.nextCursor
      ? `Showing the first ${LIMIT} lists by name.`
      : undefined;
  return (
    <>
      <PageHeader title={TITLES[type]} subtitle={subtitle} />
      <ImportWizard type={type} lists={lists} listsNote={listsNote} />
    </>
  );
}
