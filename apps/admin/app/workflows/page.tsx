import Link from 'next/link';
import { ApiErrorPanel } from '@/components/ApiError';
import { Badge } from '@/components/Badge';
import { DataTable } from '@/components/DataTable';
import { SchedulesTable } from '@/components/SchedulesTable';
import { PageHeader, Section } from '@/components/Section';
import { RelTime } from '@/components/Time';
import { apiGet } from '@/lib/api';
import type { Schedule, WorkflowDefinition } from '@/lib/types';

export const metadata = { title: 'Workflows' };

export default async function WorkflowsPage() {
  const [defs, schedules] = await Promise.all([
    apiGet<{ items: WorkflowDefinition[] }>('/api/workflows'),
    apiGet<{ items: Schedule[] }>('/api/schedules'),
  ]);
  return (
    <>
      <PageHeader
        title="Workflows"
        subtitle="Registered workflow definitions (immutable versions) and schedule triggers."
      />
      <Section title="Definitions" id="definitions">
        {!defs.ok ? (
          <ApiErrorPanel error={defs.error} />
        ) : (
          <DataTable
            caption="Workflow definitions"
            rows={defs.data.items}
            rowKey={(r) => r._id}
            columns={[
              {
                key: 'key',
                header: 'Workflow',
                cell: (r) => (
                  <>
                    <Link href={`/workflows/${encodeURIComponent(r._id)}`}>
                      <strong>{r.title}</strong>
                    </Link>
                    <div className="mono small muted">{r._id}</div>
                  </>
                ),
              },
              {
                key: 'desc',
                header: 'Description',
                className: 'wrap-cell',
                cell: (r) => <span className="small">{r.description || '—'}</span>,
              },
              { key: 'ver', header: 'Latest', numeric: true, cell: (r) => `v${r.latestVersion}` },
              {
                key: 'labels',
                header: 'Labels',
                cell: (r) =>
                  Object.entries(r.labels ?? {}).map(([k, v]) => (
                    <span key={k} className="label-chip small">
                      {k}={v}
                    </span>
                  )),
              },
              {
                key: 'sched',
                header: 'Schedules',
                cell: (r) =>
                  r.schedules.length ? (
                    <span className="small">
                      {r.schedules.filter((s) => s.enabled).length} enabled / {r.schedules.length}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  ),
              },
              {
                key: 'arch',
                header: 'Status',
                cell: (r) =>
                  r.archived ? <Badge tone="muted">archived</Badge> : <Badge tone="ok">active</Badge>,
              },
              { key: 'upd', header: 'Updated', cell: (r) => <RelTime iso={r.updatedAt} /> },
              {
                key: 'runs',
                header: '',
                cell: (r) => (
                  <Link href={`/runs?workflowKey=${encodeURIComponent(r._id)}`} className="small">
                    runs →
                  </Link>
                ),
              },
            ]}
          />
        )}
      </Section>
      <Section title="Schedules" id="schedules">
        {!schedules.ok ? (
          <ApiErrorPanel error={schedules.error} />
        ) : (
          <SchedulesTable schedules={schedules.data.items} revalidate="/workflows" />
        )}
      </Section>
    </>
  );
}
