import { ActionForm } from './ActionForm';
import { BoolBadge } from './Badge';
import { DataTable } from './DataTable';
import { JsonView } from './Json';
import { EntityLink, RunLink, WorkflowLink } from './links';
import { RelTime } from './Time';
import { setScheduleEnabledAction } from '@/lib/actions';
import { fmtMinutes } from '@/lib/format';
import type { Schedule } from '@/lib/types';

export function SchedulesTable({ schedules, revalidate }: { schedules: Schedule[]; revalidate: string }) {
  return (
    <DataTable
      caption="Schedules"
      rows={schedules}
      rowKey={(r) => r._id}
      rowClassName={(r) => (r.lastError ? 'row-warn' : !r.enabled ? 'row-muted' : undefined)}
      columns={[
        { key: 'id', header: 'Schedule', cell: (r) => <code className="id">{r._id}</code> },
        {
          key: 'wf',
          header: 'Workflow',
          cell: (r) => (
            <>
              <WorkflowLink id={r.workflowKey} />
              <span className="muted">{r.workflowVersion ? `@${r.workflowVersion}` : ' (latest)'}</span>
            </>
          ),
        },
        {
          key: 'owner',
          header: 'Owner',
          cell: (r) =>
            r.owner ? <EntityLink kind={r.owner.kind} id={r.owner.id} /> : <span className="muted">—</span>,
        },
        {
          key: 'when',
          header: 'Trigger',
          cell: (r) => (r.cron ? <code>{r.cron}</code> : `every ${fmtMinutes(r.intervalMinutes)}`),
        },
        { key: 'tz', header: 'TZ', cell: (r) => r.timezone },
        {
          key: 'en',
          header: 'Enabled',
          cell: (r) => <BoolBadge value={r.enabled} yes="enabled" no="disabled" />,
        },
        { key: 'next', header: 'Next fire', cell: (r) => <RelTime iso={r.nextFireAt} /> },
        { key: 'last', header: 'Last fired', cell: (r) => <RelTime iso={r.lastFiredAt} /> },
        { key: 'lastRun', header: 'Last run', cell: (r) => <RunLink id={r.lastRunId} /> },
        { key: 'count', header: 'Fires', numeric: true, cell: (r) => r.fireCount },
        {
          key: 'err',
          header: 'Last error',
          className: 'error-cell',
          cell: (r) =>
            r.lastError ? (
              <span className="text-bad small">{r.lastError}</span>
            ) : (
              <span className="muted">—</span>
            ),
        },
        {
          key: 'input',
          header: 'Input',
          cell: (r) =>
            Object.keys(r.input ?? {}).length ? (
              <JsonView value={r.input} label="input" />
            ) : (
              <span className="muted">{'{}'}</span>
            ),
        },
        {
          key: 'act',
          header: 'Action',
          cell: (r) => (
            <ActionForm
              action={setScheduleEnabledAction}
              submitLabel={r.enabled ? 'Disable' : 'Enable'}
              variant={r.enabled ? 'danger' : 'default'}
              inline
              hidden={{ scheduleId: r._id, enabled: r.enabled ? 'false' : 'true', revalidate }}
            />
          ),
        },
      ]}
    />
  );
}
