import { ApiErrorPanel } from '@/components/ApiError';
import { SnapshotImportForm } from '@/components/imports/SnapshotImportForm';
import { PageHeader } from '@/components/Section';
import { apiGet } from '@/lib/api';
import { sp } from '@/lib/format';
import type { SourceListItem } from '@/lib/types';

export const metadata = { title: 'Import a source snapshot' };

const LIMIT = 200;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ImportSnapshotPage({ searchParams }: { searchParams: SearchParams }) {
  const [params, res] = await Promise.all([
    searchParams,
    apiGet<{ items: SourceListItem[]; nextCursor: string | null }>('/api/sources', {
      system: 'false',
      sort: 'name',
      limit: LIMIT,
      count: 'none',
    }),
  ]);
  return (
    <>
      <PageHeader title="Import a source snapshot" subtitle="Send a file to one source, exactly as it is." />
      {res.ok ? (
        <>
          <SnapshotImportForm
            sources={res.data.items.map((x) => ({ id: x._id, name: x.name, provider: x.provider }))}
            initialSourceId={sp(params.sourceId)}
          />
          {res.data.nextCursor ? (
            <p className="small muted">Showing the first {LIMIT} sources by name.</p>
          ) : null}
        </>
      ) : (
        <ApiErrorPanel error={res.error} title="Sources could not be loaded" />
      )}
    </>
  );
}
