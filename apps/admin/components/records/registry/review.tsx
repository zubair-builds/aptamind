import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge, StatusBadge } from '@/components/Badge';
import { Time } from '@/components/ui/Time';
import { enumLabel, humanize } from '@/lib/format';
import type { ReviewListItem } from '@/lib/types';
import type { FilterSpec } from '@/lib/views';
import type { ObjectDef } from './types';

/*
 * Review queue (`GET /api/review`, list v2 M7.5; contract `market-review.md`). `queueState` is
 * server-computed (open / resolving / failed / resolved / dismissed) and rendered as returned.
 * Labels are local until `/api/meta/enums` (Market PR #22) lands.
 */

const enc = encodeURIComponent;
const BOOL = ['true', 'false'] as const;

export const REVIEW_TYPES = [
  'company_resolution',
  'company_duplicate',
  'job_duplicate',
  'field_conflict',
  'employment_conflict',
  'salary_suspicious',
  'parser_failure',
  'source_anomaly',
  'careers_discovery',
] as const;

const ID = /^[A-Za-z0-9_:.-]{1,200}$/;

const REVIEW_FILTERS: FilterSpec[] = [
  {
    param: 'status',
    label: 'Status',
    kind: 'choice',
    // The API default is `open` (no parameter); `all` returns every status.
    values: ['open', 'resolved', 'dismissed', 'all'],
    apiDefault: 'open',
    formValues: ['resolved', 'dismissed', 'all'],
    emptyLabel: 'Open',
    labels: { all: 'all statuses' },
  },
  { param: 'type', label: 'Type', kind: 'enum', values: REVIEW_TYPES },
  { param: 'severity', label: 'Severity', kind: 'enum', values: ['high', 'medium', 'low'] },
  {
    param: 'entityKind',
    label: 'Entity kind',
    kind: 'enum',
    values: ['company', 'job', 'observation', 'source'],
  },
  {
    param: 'resolving',
    label: 'Resolution in progress',
    kind: 'choice',
    values: BOOL,
    labels: { true: 'resolving', false: 'not resolving' },
  },
  {
    param: 'hasFailure',
    label: 'Previous decision failed',
    kind: 'choice',
    values: BOOL,
    labels: { true: 'failed', false: 'no failure' },
  },
  { param: 'entityId', label: 'Entity or candidate', kind: 'codes', pattern: ID, max: 1 },
  { param: 'scopeId', label: 'Record or source scope', kind: 'codes', pattern: ID, max: 1 },
  { param: 'createdAfter', label: 'Created on or after', kind: 'date' },
  { param: 'createdBefore', label: 'Created before', kind: 'date' },
  // ─── EXTENSION POINT: triage claims (Market PR #22, not merged) ──────────────────────────────
  // When #22 lands, add its filter here and a "Claimed by" column below (reading the item's
  // triage claim `holder`, per the supervisor ruling). Until then nothing is sent:
  //   { param: 'claimed', label: 'Claimed', kind: 'choice', values: ['true', 'false'] },
  ...triageClaimFilters(),
];

/** Filters for triage claims (Market PR #22). Empty until that contract is on main. */
function triageClaimFilters(): FilterSpec[] {
  return [];
}

const kindLabel = (k: string) => {
  const h = enumLabel(k);
  return h.charAt(0).toUpperCase() + h.slice(1);
};

const ENTITY_PATH: Record<string, string> = {
  company: '/companies/',
  job: '/jobs/',
  source: '/sources/',
  observation: '/observations/',
};

function Entity({ r }: { r: ReviewListItem }) {
  const base = ENTITY_PATH[r.entity.kind];
  // The item names no entity label; the link says what it is and the id is in the tooltip.
  return base ? (
    <Link href={`${base}${enc(r.entity.id)}`} title={r.entity.id}>
      {kindLabel(r.entity.kind)}
    </Link>
  ) : (
    <span title={r.entity.id}>{kindLabel(r.entity.kind)}</span>
  );
}

/**
 * The queue state as returned, plus what it means for this item (contract "States of an item").
 * The table leaves out who decided a decided item (`detail` = the preview shows it).
 */
function QueueState({ r, detail = false }: { r: ReviewListItem; detail?: boolean }) {
  // Colour is for items that need a second look (resolving, failed); a plain open item is text.
  if (r.queueState === 'open') return <span className="muted">Open</span>;
  return (
    <>
      <StatusBadge value={r.queueState} />
      {r.queueState === 'resolving' && r.claim ? (
        <span className="small muted">
          {' '}
          {enumLabel(r.claim.action)} by {r.claim.actor.id}
        </span>
      ) : null}
      {r.queueState === 'failed' && r.lastFailure ? (
        <span className="small text-warn" title={r.lastFailure.message}>
          {' '}
          previous {humanize(r.lastFailure.action)} failed
        </span>
      ) : null}
      {detail && (r.queueState === 'resolved' || r.queueState === 'dismissed') && r.resolution ? (
        <span className="small muted">
          {' '}
          {enumLabel(r.resolution.action)} by {r.resolution.actor.id}
        </span>
      ) : null}
    </>
  );
}

const decided = (r: ReviewListItem) => r.queueState === 'resolved' || r.queueState === 'dismissed';

/** Severity; neutral once the item is decided (it no longer asks for attention). */
function Severity({ r }: { r: ReviewListItem }) {
  return decided(r) ? (
    <Badge tone="muted">{enumLabel(r.severity)}</Badge>
  ) : (
    <StatusBadge value={r.severity} kind="severity" />
  );
}

function Candidates({ r }: { r: ReviewListItem }) {
  if (!r.candidates.length) return <span className="muted">—</span>;
  const names = r.candidates.map((c) => c.label || c.id);
  return (
    <span title={names.join(' · ')}>
      {names[0]}
      {names.length > 1 ? <span className="muted"> +{names.length - 1}</span> : null}
    </span>
  );
}

export const reviewObject: ObjectDef<ReviewListItem> = {
  key: 'review',
  label: 'Review items',
  singular: 'review item',
  path: '/review',
  apiPath: '/api/review',
  searchLabel: '',
  searchHint: '',
  search: false,
  filterNote:
    'Filters are the review API’s own. Without a status the queue shows open items (resolving and failed ones included).',
  emptyAll: 'Nothing to review. Items appear when a source or decision needs a person.',
  defaultSort: 'priority',
  // The API orders decided items by last update by default (the v1 order).
  defaultSortFor: (f) =>
    f.status?.[0] === 'resolved' || f.status?.[0] === 'dismissed' ? '-updatedAt' : undefined,
  sorts: [
    {
      key: 'priority',
      label: 'Priority',
      // The API's `priority` is highest first (then oldest); `-priority` is lowest first.
      natural: 'desc',
      labels: ['Priority: highest first', 'Priority: lowest first'],
    },
    { key: 'createdAt', label: 'Created', labels: ['Created: oldest first', 'Created: newest first'] },
    { key: 'updatedAt', label: 'Updated', labels: ['Updated: oldest first', 'Updated: newest first'] },
  ],
  filters: REVIEW_FILTERS,
  views: [
    {
      id: 'open',
      label: 'Open',
      empty: 'Nothing to review. Items appear when a source or decision needs a person.',
    },
    {
      id: 'high',
      label: 'High severity',
      filters: { severity: ['high'] },
      empty: 'No open high-severity items.',
    },
    {
      id: 'failed',
      label: 'Failed decisions',
      filters: { hasFailure: ['true'] },
      empty: 'No item has a failed decision.',
    },
    {
      id: 'resolving',
      label: 'Resolving',
      filters: { resolving: ['true'] },
      empty: 'No decision is being applied right now.',
    },
    { id: 'resolved', label: 'Resolved', filters: { status: ['resolved'] }, empty: 'No resolved items yet.' },
    {
      id: 'dismissed',
      label: 'Dismissed',
      filters: { status: ['dismissed'] },
      empty: 'No dismissed items yet.',
    },
    { id: 'all', label: 'All', filters: { status: ['all'] } },
  ],
  columns: [
    // Two lines on phones: subjects differ at the end ("Resolve company "Dr J Smith"").
    { key: 'subject', label: 'Subject', identity: true, wrap: true, cell: (r) => r.subject },
    { key: 'severity', label: 'Severity', defaultVisible: true, cell: (r) => <Severity r={r} /> },
    { key: 'queue', label: 'State', defaultVisible: true, cell: (r) => <QueueState r={r} /> },
    { key: 'type', label: 'Type', defaultVisible: true, cell: (r) => enumLabel(r.type) },
    // The item gives only the entity's kind and id: not a default column.
    { key: 'entity', label: 'Entity', cell: (r) => <Entity r={r} /> },
    { key: 'candidates', label: 'Candidates', defaultVisible: true, cell: (r) => <Candidates r={r} /> },
    {
      key: 'created',
      label: 'Created',
      sort: 'createdAt',
      defaultVisible: true,
      cell: (r) => <Time value={r.createdAt} />,
    },
    { key: 'updated', label: 'Updated', sort: 'updatedAt', cell: (r) => <Time value={r.updatedAt} /> },
    { key: 'occurrences', label: 'Occurrences', numeric: true, cell: (r) => r.occurrences },
    { key: 'priority', label: 'Priority', numeric: true, sort: 'priority', cell: (r) => r.priority },
    { key: 'reason', label: 'Reason', wrap: true, cell: (r) => r.reason },
  ],
  rowId: (r) => r._id,
  rowHref: (r) => `/review/${enc(r._id)}`,
  rowTitle: (r) => r.subject,
  peek: (r) => {
    const items: { label: string; value: ReactNode }[] = [
      { label: 'Severity', value: <Severity r={r} /> },
      { label: 'State', value: <QueueState r={r} detail /> },
      { label: 'Type', value: enumLabel(r.type) },
      { label: 'Reason', value: r.reason },
      { label: 'Entity', value: <Entity r={r} /> },
      { label: 'Candidates', value: <Candidates r={r} /> },
    ];
    if (r.queueState === 'failed' && r.lastFailure)
      items.push({ label: 'Last failure', value: r.lastFailure.message });
    items.push(
      { label: 'Occurrences', value: r.occurrences },
      { label: 'Created', value: <Time value={r.createdAt} mode="absolute" /> },
    );
    return items;
  },
};
