import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/Badge';
import { SourceLink, type SourceNames } from '@/components/links';
import { Time } from '@/components/ui/Time';
import { enumLabel, fmtDuration } from '@/lib/format';
import type { WorkflowRun } from '@/lib/types';
import type { FilterSpec } from '@/lib/views';
import type { ObjectDef } from './types';

/*
 * Workflow runs (`GET /api/runs`, runtime-owned; contract `market-runs.md`). This is a v1 list:
 * offset paging with a total, one fixed order (newest first), single-value filters, top-level
 * runs unless `all=true`. Labels are local until `/api/meta/enums` (Market PR #22).
 */

const enc = encodeURIComponent;
export const RUN_STATES = [
  'PENDING',
  'RUNNING',
  'WAITING',
  'CANCELLING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
const KEY = /^[A-Za-z0-9_.:-]{1,200}$/;

const RUN_FILTERS: FilterSpec[] = [
  { param: 'state', label: 'State', kind: 'choice', values: RUN_STATES },
  {
    param: 'workflowKey',
    label: 'Workflow',
    kind: 'codes',
    pattern: KEY,
    max: 1,
    placeholder: 'market.ats.refresh',
  },
  { param: 'sourceId', label: 'Source (run label)', kind: 'codes', pattern: KEY, max: 1 },
  { param: 'parentRunId', label: 'Parent run', kind: 'codes', pattern: KEY, max: 1 },
  {
    param: 'all',
    label: 'Child runs',
    kind: 'choice',
    values: ['true', 'false'],
    // No parameter = top-level runs only (the runtime default); `all=false` says the same.
    apiDefault: 'false',
    formValues: ['true'],
    emptyLabel: 'Top-level only',
    labels: { true: 'Included' },
  },
];

function Labels({ r, hide }: { r: WorkflowRun; hide?: Set<string> }) {
  const entries = Object.entries(r.labels ?? {}).filter(([k]) => !hide?.has(k));
  if (!entries.length) return <span className="muted">—</span>;
  const href = (k: string, v: string) =>
    k === 'sourceId'
      ? `/sources/${enc(v)}`
      : k === 'companyId'
        ? `/companies/${enc(v)}`
        : k === 'jobId'
          ? `/jobs/${enc(v)}`
          : null;
  return (
    <span className="small">
      {entries.map(([k, v], i) => {
        const h = href(k, v);
        return (
          <span key={k}>
            {i ? ' · ' : null}
            {k}: {h ? <Link href={h}>{v}</Link> : v}
          </span>
        );
      })}
    </span>
  );
}

/** "Manual" / "Schedule"… in the table; the actor is shown in the preview only. */
const triggerKind = (r: WorkflowRun) => enumLabel(r.trigger.kind);

function TriggerFull({ r }: { r: WorkflowRun }) {
  return (
    <>
      {triggerKind(r)}
      {r.trigger.actor ? <span className="muted small"> ({r.trigger.actor.id})</span> : null}
    </>
  );
}

/** Labels other than the ones shown as columns (source) and the routing ones (domain, stream). */
const HIDDEN_LABELS = new Set(['sourceId', 'domain', 'stream']);

/**
 * The runs object. `sources` (from the sources list) names the source a run belongs to; a run's
 * own free-form labels never outrank it, and without it the source id is shown.
 */
export function runsObject(sources: SourceNames = new Map()): ObjectDef<WorkflowRun> {
  const sourceId = (r: WorkflowRun) => r.labels?.sourceId;
  const sourceName = (r: WorkflowRun) => {
    const id = sourceId(r);
    return id ? (sources.get(id)?.name ?? id) : undefined;
  };
  // The row name is the short workflow key (narrow, so State and Source show at 390); the full
  // title (tooltip, preview heading) adds the source, which is what tells rows apart.
  const shortKey = (r: WorkflowRun) => r.workflowKey.replace(/^market\./, '');
  const title = (r: WorkflowRun) => {
    const src = sourceName(r);
    return src ? `${shortKey(r)} · ${src}` : r.workflowKey;
  };
  const source = (r: WorkflowRun) => <SourceLink id={sourceId(r)} names={sources} />;
  return {
    key: 'runs',
    label: 'Runs',
    singular: 'run',
    path: '/runs',
    apiPath: '/api/runs',
    paging: 'offset',
    search: false,
    searchLabel: '',
    searchHint: '',
    filterNote: 'Filters are the runtime API’s own: one value each; child runs are hidden unless included.',
    emptyAll: 'No runs yet. Runs appear when a source runs or an action starts a workflow.',
    // The runtime orders runs newest first and offers no other sort.
    defaultSort: '',
    sorts: [],
    filters: RUN_FILTERS,
    views: [
      { id: 'all-runs', label: 'Top-level runs' },
      { id: 'failed', label: 'Failed', filters: { state: ['FAILED'] }, empty: 'No failed runs.' },
      {
        id: 'running',
        label: 'Running',
        filters: { state: ['RUNNING'] },
        empty: 'Nothing is running right now.',
      },
      { id: 'waiting', label: 'Waiting', filters: { state: ['WAITING'] }, empty: 'No run is waiting.' },
      {
        id: 'children',
        label: 'Including child runs',
        filters: { all: ['true'] },
        // Lineage only means something once child runs are listed.
        cols: ['workflow', 'state', 'source', 'created', 'duration', 'lineage'],
      },
    ],
    columns: [
      { key: 'workflow', label: 'Run', identity: true, maxWidth: 200, cell: shortKey },
      // State before Source: a failed run is visible without scrolling on a phone.
      { key: 'state', label: 'State', defaultVisible: true, cell: (r) => <StatusBadge value={r.state} /> },
      { key: 'source', label: 'Source', defaultVisible: true, maxWidth: 360, cell: source },
      { key: 'created', label: 'Created', defaultVisible: true, cell: (r) => <Time value={r.createdAt} /> },
      {
        key: 'duration',
        label: 'Duration',
        numeric: true,
        defaultVisible: true,
        cell: (r) => fmtDuration(r.durationMs),
      },
      { key: 'trigger', label: 'Trigger', defaultVisible: true, cell: triggerKind },
      {
        key: 'lineage',
        label: 'Lineage',
        cell: (r) =>
          r.parent ? (
            <span className="small">
              child of <Link href={`/runs/${enc(r.parent.runId)}`}>parent run</Link>
              {r.parent.itemIndex !== undefined ? <> #{r.parent.itemIndex}</> : null}
            </span>
          ) : (
            <span className="muted small">top-level</span>
          ),
      },
      {
        key: 'workflowKey',
        label: 'Workflow',
        cell: (r) => <span className="mono small">{r.workflowKey}</span>,
      },
      { key: 'labels', label: 'Labels', cell: (r) => <Labels r={r} hide={HIDDEN_LABELS} /> },
      { key: 'version', label: 'Version', numeric: true, cell: (r) => r.workflowVersion },
      {
        key: 'failedNodes',
        label: 'Failed nodes',
        cell: (r) => (r.failedNodeIds.length ? r.failedNodeIds.join(', ') : <span className="muted">—</span>),
      },
      { key: 'finished', label: 'Finished', cell: (r) => <Time value={r.finishedAt} /> },
      { key: 'id', label: 'Run id', cell: (r) => <span className="mono small">{r._id}</span> },
    ],
    rowId: (r) => r._id,
    rowHref: (r) => `/runs/${enc(r._id)}`,
    rowTitle: title,
    peek: (r) => {
      const items: { label: string; value: ReactNode }[] = [
        { label: 'Workflow', value: <span className="mono">{r.workflowKey}</span> },
        { label: 'State', value: <StatusBadge value={r.state} /> },
        { label: 'Source', value: source(r) },
        { label: 'Trigger', value: <TriggerFull r={r} /> },
        { label: 'Created', value: <Time value={r.createdAt} mode="absolute" /> },
        { label: 'Duration', value: fmtDuration(r.durationMs) },
      ];
      if (r.error?.message) items.push({ label: 'Error', value: r.error.message });
      items.push({ label: 'Run id', value: <span className="mono nowrap">{r._id}</span> });
      return items;
    },
  };
}
