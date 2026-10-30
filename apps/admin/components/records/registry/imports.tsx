import { StatusBadge } from '@/components/Badge';
import { countsSummary, importTypeLabel, IMPORT_TYPE_LABELS } from '@/components/imports/labels';
import { RunLink, SourceLink } from '@/components/links';
import { Time } from '@/components/ui/Time';
import { fmtBytes } from '@/lib/format';
import type { ImportSummary } from '@/lib/types';
import type { FilterSpec } from '@/lib/views';
import type { ObjectDef } from './types';

/*
 * Imports (`GET /api/imports`, contract `market-imports.md`): newest first, one value per filter,
 * cursor paging (`cursor` / `nextCursor`, no total). Status and counts come from the API.
 */

const enc = encodeURIComponent;
export const IMPORT_STATUSES = [
  'processing',
  'completed',
  'completed_with_issues',
  'failed',
  'cancelled',
] as const;

const IMPORT_FILTERS: FilterSpec[] = [
  {
    param: 'type',
    label: 'Type',
    kind: 'choice',
    values: Object.keys(IMPORT_TYPE_LABELS),
    labels: IMPORT_TYPE_LABELS,
  },
  { param: 'status', label: 'Status', kind: 'choice', values: IMPORT_STATUSES },
  { param: 'sourceId', label: 'Source', kind: 'codes', pattern: /^[A-Za-z0-9_:.-]{1,200}$/, max: 1 },
];

const source = (r: ImportSummary) => (
  <SourceLink id={r.source?.id ?? r.sourceId}>{r.source?.name}</SourceLink>
);

export const importsObject: ObjectDef<ImportSummary> = {
  key: 'imports',
  label: 'Imports',
  singular: 'import',
  path: '/imports',
  apiPath: '/api/imports',
  paging: 'keyset',
  cursorParam: 'cursor',
  countParam: false,
  search: false,
  searchLabel: '',
  searchHint: '',
  filterNote: 'One value per filter. Imports are listed newest first.',
  emptyAll:
    'No imports yet. Use New import to bring in a file of companies, ATS boards or a source snapshot.',
  defaultSort: '',
  sorts: [],
  filters: IMPORT_FILTERS,
  views: [
    { id: 'all-imports', label: 'All imports' },
    {
      id: 'processing',
      label: 'Processing',
      filters: { status: ['processing'] },
      empty: 'Nothing is processing right now.',
    },
    {
      id: 'issues',
      label: 'With issues',
      filters: { status: ['completed_with_issues'] },
      empty: 'No import finished with issues.',
    },
    { id: 'failed', label: 'Failed', filters: { status: ['failed'] }, empty: 'No failed imports.' },
  ],
  columns: [
    { key: 'file', label: 'File', identity: true, maxWidth: 260, cell: (r) => r.fileName },
    { key: 'type', label: 'Type', defaultVisible: true, cell: (r) => importTypeLabel(r.type) },
    { key: 'status', label: 'Status', defaultVisible: true, cell: (r) => <StatusBadge value={r.status} /> },
    { key: 'source', label: 'Source', defaultVisible: true, maxWidth: 240, cell: source },
    {
      key: 'counts',
      label: 'Results',
      defaultVisible: true,
      maxWidth: 320,
      cell: (r) => countsSummary(r.counts, r.type) || <span className="muted">—</span>,
    },
    { key: 'created', label: 'Created', defaultVisible: true, cell: (r) => <Time value={r.createdAt} /> },
    { key: 'finished', label: 'Finished', cell: (r) => <Time value={r.finishedAt} /> },
    { key: 'size', label: 'Size', numeric: true, cell: (r) => fmtBytes(r.bytes) },
    { key: 'run', label: 'Run', cell: (r) => <RunLink id={r.runId} /> },
    { key: 'id', label: 'Import id', cell: (r) => <span className="mono small">{r._id}</span> },
  ],
  rowId: (r) => r._id,
  rowHref: (r) => `/imports/${enc(r._id)}`,
  rowTitle: (r) => r.fileName,
  peek: (r) => [
    { label: 'Type', value: importTypeLabel(r.type) },
    { label: 'Status', value: <StatusBadge value={r.status} /> },
    { label: 'Source', value: source(r) },
    { label: 'Results', value: countsSummary(r.counts, r.type) },
    { label: 'Created', value: <Time value={r.createdAt} mode="absolute" /> },
    { label: 'Run', value: <RunLink id={r.runId} /> },
    ...(r.error ? [{ label: 'Error', value: r.error.message }] : []),
    { label: 'Import id', value: <span className="mono nowrap">{r._id}</span> },
  ],
};
