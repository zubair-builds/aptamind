import { sourceNames } from '@/components/links';
import { runsObject } from '@/components/records/registry/runs';
import { RecordList } from '@/components/records/table/RecordList';
import { PageHeader } from '@/components/Section';
import { apiGet } from '@/lib/api';
import type { SourceListItem, WorkflowDefinition } from '@/lib/types';

export const metadata = { title: 'Runs' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function RunsPage({ searchParams }: { searchParams: SearchParams }) {
  // Workflow keys as suggestions for the Workflow filter (the filter itself accepts any key).
  // Source names so rows can say which source a run belongs to (runs carry only `labels.sourceId`).
  const [params, defs, sources] = await Promise.all([
    searchParams,
    apiGet<{ items: WorkflowDefinition[] }>('/api/workflows'),
    apiGet<{ items: SourceListItem[]; nextCursor: string | null }>('/api/sources?limit=200&count=none'),
  ]);
  const keys = defs.ok ? defs.data.items.map((d) => d._id).sort() : [];
  const names = sourceNames(sources.ok ? sources.data.items : []);
  // Names come from one page of sources; say so when some runs can only show a source id.
  const namesNote = !sources.ok
    ? 'Source names are unavailable (the sources list did not load): runs show source ids.'
    : sources.data.nextCursor
      ? 'Source names cover the first 200 sources; runs of other sources show their ids.'
      : null;
  return (
    <>
      <PageHeader
        title="Runs"
        subtitle="Workflow runs, newest first. Child runs (sub-workflows, fan-out items) are hidden unless included."
      />
      {namesNote ? <p className="small muted">{namesNote}</p> : null}
      <RecordList def={runsObject(names)} params={params} suggestions={{ workflowKey: keys }} />
    </>
  );
}
