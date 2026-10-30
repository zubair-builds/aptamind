import Link from 'next/link';
import { BoolBadge, StatusBadge } from '@/components/Badge';
import { WorkflowLink } from '@/components/links';
import { Time } from '@/components/ui/Time';
import { enumLabel, fmtMinutes } from '@/lib/format';
import type { SourceListItem } from '@/lib/types';
import type { FilterSpec } from '@/lib/views';
import type { ObjectDef } from './types';

/*
 * Sources (`GET /api/sources`, list v2; contract `market-sources.md`). Rows are the full source
 * plus the server-computed `freshnessState` — the UI never classifies freshness itself.
 */

const enc = encodeURIComponent;
const BOOL = ['true', 'false'] as const;

const SOURCE_FILTERS: FilterSpec[] = [
  {
    param: 'category',
    label: 'Category',
    kind: 'enum',
    values: ['company_universe', 'job_source', 'signal_source', 'manual_import'],
  },
  { param: 'health', label: 'Health', kind: 'enum', values: ['never_run', 'healthy', 'degraded', 'failing'] },
  {
    param: 'freshness',
    label: 'Freshness',
    kind: 'enum',
    values: ['fresh', 'due', 'overdue', 'never_succeeded', 'disabled'],
  },
  {
    param: 'enabled',
    label: 'Enabled',
    kind: 'choice',
    values: BOOL,
    labels: { true: 'enabled', false: 'disabled' },
  },
  {
    param: 'system',
    label: 'Built-in system sources',
    kind: 'choice',
    values: BOOL,
    labels: { true: 'only system', false: 'hide system' },
  },
  {
    param: 'provider',
    label: 'Provider',
    kind: 'codes',
    pattern: /^[a-z0-9_]{1,64}$/,
    transform: 'lower',
    placeholder: 'greenhouse',
  },
  { param: 'companyId', label: 'Company', kind: 'codes', pattern: /^[A-Za-z0-9_:.-]{1,200}$/ },
];

export const sourcesObject: ObjectDef<SourceListItem> = {
  key: 'sources',
  label: 'Sources',
  singular: 'source',
  path: '/sources',
  apiPath: '/api/sources',
  searchLabel: 'Search sources',
  searchHint: 'The name or key starts with it (also the key after its provider), or the company name does.',
  emptyAll: 'No sources yet. Register an information origin to start collecting evidence.',
  defaultSort: 'category',
  sorts: [
    { key: 'category', label: 'Category, then name' },
    { key: 'name', label: 'Name' },
    { key: 'lastSuccessAt', label: 'Last success' },
    { key: 'createdAt', label: 'Created' },
  ],
  filters: SOURCE_FILTERS,
  views: [
    { id: 'all', label: 'All sources' },
    { id: 'attention', label: 'Degraded or failing', filters: { health: ['degraded', 'failing'] } },
    {
      id: 'overdue',
      label: 'Overdue',
      filters: { freshness: ['overdue', 'never_succeeded'], system: ['false'] },
    },
    { id: 'jobs', label: 'Job sources', filters: { category: ['job_source'] } },
    { id: 'disabled', label: 'Disabled', filters: { enabled: ['false'] } },
  ],
  columns: [
    { key: 'name', label: 'Source', identity: true, sort: 'name', cell: (r) => r.name },
    {
      key: 'key',
      label: 'Key',

      cell: (r) => <span className="mono small">{r.key}</span>,
    },
    {
      key: 'category',
      label: 'Category',
      sort: 'category',
      defaultVisible: true,
      cell: (r) => enumLabel(r.category),
    },
    {
      key: 'provider',
      label: 'Provider',
      defaultVisible: true,
      cell: (r) => <span className="mono small">{r.provider}</span>,
    },
    {
      key: 'health',
      label: 'Health',
      defaultVisible: true,
      cell: (r) => (
        <>
          <StatusBadge value={r.health.status} />
          {r.health.consecutiveFailures ? (
            <span className="small muted"> {r.health.consecutiveFailures} in a row</span>
          ) : null}
        </>
      ),
    },
    {
      key: 'freshness',
      label: 'Freshness',
      defaultVisible: true,
      cell: (r) => <StatusBadge value={r.freshnessState} />,
    },
    {
      key: 'lastSuccess',
      label: 'Last success',
      sort: 'lastSuccessAt',
      defaultVisible: true,
      cell: (r) =>
        r.health.lastSuccessAt ? (
          <Time value={r.health.lastSuccessAt} />
        ) : (
          <span className="muted">never</span>
        ),
    },
    {
      key: 'company',
      label: 'Company',
      defaultVisible: true,
      cell: (r) =>
        r.companyId ? (
          <Link href={`/companies/${enc(r.companyId)}`}>{r.companyName ?? 'Unnamed company'}</Link>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: 'enabled',
      label: 'Enabled',
      cell: (r) => <BoolBadge value={r.enabled} yes="enabled" no="disabled" />,
    },
    { key: 'authority', label: 'Authority', cell: (r) => enumLabel(r.authority.tier) },
    { key: 'workflow', label: 'Workflow', cell: (r) => <WorkflowLink id={r.acquisition.workflowKey} /> },
    { key: 'maxAge', label: 'Max age', numeric: true, cell: (r) => fmtMinutes(r.freshness.maxAgeMinutes) },
    {
      key: 'schedule',
      label: 'Schedule',
      cell: (r) =>
        r.schedule?.cron ? (
          <span className="mono small">{r.schedule.cron}</span>
        ) : r.schedule?.intervalMinutes ? (
          `every ${fmtMinutes(r.schedule.intervalMinutes)}`
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: 'nextRun',
      label: 'Next run',
      // Also says when the source is off, so the Enabled column can stay hidden by default.
      defaultVisible: true,
      cell: (r) =>
        !r.enabled ? (
          <span className="muted">source disabled</span>
        ) : !r.schedule ? (
          <span className="muted">—</span>
        ) : !r.schedule.enabled ? (
          <span className="muted">paused</span>
        ) : r.schedule.nextRunAt ? (
          <Time value={r.schedule.nextRunAt} />
        ) : (
          <span className="muted">not planned</span>
        ),
    },
    {
      key: 'lastError',
      label: 'Last error',
      wrap: true,
      cell: (r) =>
        r.health.lastError ? (
          <span className="text-bad small">{r.health.lastError.slice(0, 140)}</span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    { key: 'created', label: 'Created', sort: 'createdAt', cell: (r) => <Time value={r.createdAt} /> },
  ],
  rowId: (r) => r._id,
  rowHref: (r) => `/sources/${enc(r._id)}`,
  rowTitle: (r) => r.name,
  peek: (r) => [
    { label: 'Key', value: <span className="mono">{r.key}</span> },
    { label: 'Category', value: enumLabel(r.category) },
    { label: 'Health', value: <StatusBadge value={r.health.status} /> },
    { label: 'Freshness', value: <StatusBadge value={r.freshnessState} /> },
    {
      label: 'Last success',
      value: r.health.lastSuccessAt ? <Time value={r.health.lastSuccessAt} mode="absolute" /> : 'never',
    },
    { label: 'Last error', value: r.health.lastError ? r.health.lastError.slice(0, 200) : '—' },
    { label: 'Workflow', value: <WorkflowLink id={r.acquisition.workflowKey} /> },
    { label: 'Enabled', value: r.enabled ? 'yes' : 'no' },
  ],
};
