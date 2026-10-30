import Link from 'next/link';
import { StatusBadge } from '@/components/Badge';
import { ConflictFields } from '@/components/records/facts/ConflictFields';
import { FactSummary } from '@/components/records/facts/FactSummary';
import { SponsorshipValue } from '@/components/SponsorshipValue';
import { Time } from '@/components/ui/Time';
import { enumLabel, fmtMoneyCompact } from '@/lib/format';
import type { JobSummary } from '@/lib/types';
import type { FilterSpec } from '@/lib/views';
import type { ObjectDef } from './types';

/*
 * Jobs (`GET /api/jobs`, list v2, `view=summary`; contract `market-jobs.md`). Every filter is an
 * API parameter with the contract's enum values; enum filters match the fact's value whatever its
 * status (the provenance contract) — the filter panel says so.
 */

const enc = encodeURIComponent;

export const JOB_STATES = [
  'DISCOVERED',
  'VERIFIED_LIVE',
  'CHANGED',
  'POSSIBLY_STALE',
  'CLOSED',
  'REOPENED',
  'REPOSTED',
] as const;
const WORK_MODELS = ['remote', 'hybrid', 'onsite', 'unclear'] as const;
const REMOTE_SCOPES = [
  'worldwide',
  'region',
  'country',
  'selected_countries',
  'timezone',
  'unclear',
  'not_applicable',
] as const;
const SPONSORSHIP = [
  'explicit_yes',
  'explicit_no',
  'company_capable',
  'historical_evidence',
  'unclear',
] as const;
const RELOCATION = ['explicit_yes', 'explicit_no', 'possible', 'unclear'] as const;
const EMPLOYMENT_TYPES = [
  'full_time',
  'part_time',
  'contract',
  'temporary',
  'internship',
  'apprenticeship',
  'freelance',
  'unclear',
] as const;
const SENIORITY = [
  'intern',
  'junior',
  'mid',
  'senior',
  'staff',
  'principal',
  'lead',
  'manager',
  'director',
  'vp',
  'executive',
  'unclear',
] as const;
const SALARY = ['parsed', 'unknown', 'ambiguous', 'malformed'] as const;
const VERIFICATION = ['live', 'not_found', 'inconclusive', 'none'] as const;
const CONFIDENCE_FIELDS =
  'title|seniority|employmentType|workModel|remoteScope|sponsorship|authorization|relocation|compensation';
const BOOL = ['true', 'false'] as const;

const JOB_FILTERS: FilterSpec[] = [
  { param: 'state', label: 'Lifecycle', kind: 'enum', values: JOB_STATES },
  { param: 'workModel', label: 'Work model', kind: 'enum', values: WORK_MODELS },
  { param: 'remoteScope', label: 'Remote scope', kind: 'enum', values: REMOTE_SCOPES },
  {
    param: 'sponsorship',
    label: 'Sponsorship status',
    kind: 'enum',
    values: SPONSORSHIP,
    labels: {
      explicit_yes: 'role says yes',
      explicit_no: 'role says no',
      company_capable: 'company capable (licence; role silent)',
      historical_evidence: 'historical evidence',
      unclear: 'unclear',
    },
  },
  { param: 'relocation', label: 'Relocation', kind: 'enum', values: RELOCATION },
  {
    param: 'authorizationRequired',
    label: 'Work authorization required',
    kind: 'choice',
    values: ['true', 'false', 'unknown'],
    labels: { true: 'yes', false: 'no', unknown: 'not known' },
  },
  { param: 'employmentType', label: 'Employment type', kind: 'enum', values: EMPLOYMENT_TYPES },
  { param: 'seniority', label: 'Seniority', kind: 'enum', values: SENIORITY },
  {
    param: 'country',
    label: 'Country (location or remote scope)',
    kind: 'codes',
    pattern: /^[A-Z]{2}$/,
    transform: 'upper',
    placeholder: 'GB, IE',
  },
  { param: 'salaryStatus', label: 'Salary status', kind: 'enum', values: SALARY },
  {
    param: 'currency',
    label: 'Currency',
    kind: 'codes',
    pattern: /^[A-Z]{3}$/,
    transform: 'upper',
    placeholder: 'GBP',
  },
  { param: 'minAnnual', label: 'Annual pay at least (one currency)', kind: 'number', min: 0 },
  {
    param: 'minConfidence',
    label: 'Minimum confidence (field:level)',
    kind: 'codes',
    pattern: new RegExp(`^(${CONFIDENCE_FIELDS}):(low|medium|high)$`),
    placeholder: 'workModel:high',
    max: 9,
  },
  { param: 'verificationOutcome', label: 'Last verification', kind: 'enum', values: VERIFICATION },
  {
    param: 'verificationDue',
    label: 'Verification due',
    kind: 'choice',
    values: BOOL,
    labels: { true: 'due', false: 'not due' },
  },
  {
    param: 'hasConflicts',
    label: 'Conflict fields',
    kind: 'choice',
    values: BOOL,
    labels: { true: 'has conflict fields', false: 'none' },
  },
  {
    param: 'hasOpenReviews',
    label: 'Open reviews',
    kind: 'choice',
    values: BOOL,
    labels: { true: 'has open reviews', false: 'none' },
  },
  {
    param: 'flag',
    label: 'Interpretation flag',
    kind: 'codes',
    pattern: /^[a-z0-9_]{1,64}$/,
    placeholder: 'remote_label_restricted',
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
  { param: 'sourceId', label: 'Source', kind: 'codes', pattern: /^[A-Za-z0-9_:.-]{1,200}$/ },
  { param: 'lastSeenAfter', label: 'Last seen on or after', kind: 'date' },
  { param: 'lastSeenBefore', label: 'Last seen before', kind: 'date' },
  { param: 'firstSeenAfter', label: 'First seen on or after', kind: 'date' },
  { param: 'firstSeenBefore', label: 'First seen before', kind: 'date' },
  { param: 'changedAfter', label: 'Changed on or after', kind: 'date' },
  { param: 'changedBefore', label: 'Changed before', kind: 'date' },
];

function Compensation({ v }: { v: JobSummary['compensation']['value'] & object }) {
  if (v.status !== 'parsed' || (v.min === null && v.max === null)) return <StatusBadge value={v.status} />;
  // Compact in the table ("£70k–£90k / year"); the record page has the exact amounts.
  const range =
    v.min !== null && v.max !== null && v.min !== v.max
      ? `${fmtMoneyCompact(v.min, v.currency)}–${fmtMoneyCompact(v.max, v.currency)}`
      : fmtMoneyCompact(v.min ?? v.max, v.currency);
  return (
    <span className="tabular">
      {range}
      {v.period ? <span className="muted"> / {v.period}</span> : null}
    </span>
  );
}

function Locations({ r }: { r: JobSummary }) {
  const g = r.geography;
  if (!g.listedLocations.length) return <span className="muted">—</span>;
  const more = g.locationCount - g.listedLocations.length;
  return (
    <span title={g.listedLocations.join(' · ')}>
      {g.listedLocations.join(' · ')}
      {more > 0 ? <span className="muted"> +{more}</span> : null}
    </span>
  );
}

function Quality({ r }: { r: JobSummary }) {
  return (
    <span className="small">
      {r.quality.sourceCount} src
      <ConflictFields record={r} fields={r.quality.conflictFields} variant="count" />
      {r.openReviewCount ? (
        <span className="text-warn">
          {' '}
          · {r.openReviewCount} open review{r.openReviewCount === 1 ? '' : 's'}
        </span>
      ) : null}
    </span>
  );
}

export const jobsObject: ObjectDef<JobSummary> = {
  key: 'jobs',
  label: 'Jobs',
  singular: 'job',
  path: '/jobs',
  apiPath: '/api/jobs',
  summaryView: true,
  searchLabel: 'Search jobs',
  searchHint: 'Every word matches the start of a title word, or the company name starts with it.',
  filterNote:
    "Filters are the list API's own. Enum filters match a fact's value whatever its status; for settled values only add “Conflict fields: none” or a minimum confidence.",
  emptyAll: 'No jobs yet. Jobs appear once a job source has run.',
  defaultSort: '-lastSeenAt',
  sorts: [
    { key: 'lastSeenAt', label: 'Last seen' },
    { key: 'firstSeenAt', label: 'First seen' },
    { key: 'lastChangedAt', label: 'Last changed' },
    { key: 'title', label: 'Title' },
  ],
  filters: JOB_FILTERS,
  crossCheck: (f) =>
    f.minAnnual && (f.currency?.length ?? 0) !== 1
      ? [{ param: 'minAnnual', reason: 'needs exactly one currency (pay is not converted)' }]
      : [],
  views: [
    { id: 'all', label: 'All jobs' },
    { id: 'remote', label: 'Remote', filters: { workModel: ['remote'] } },
    { id: 'sponsors', label: 'Role says it sponsors', filters: { sponsorship: ['explicit_yes'] } },
    { id: 'reviews', label: 'Open reviews', filters: { hasOpenReviews: ['true'] } },
    { id: 'conflicts', label: 'Conflict fields', filters: { hasConflicts: ['true'] } },
    { id: 'due', label: 'Verification due', filters: { verificationDue: ['true'] } },
    { id: 'stale', label: 'Possibly stale', filters: { state: ['POSSIBLY_STALE'] } },
  ],
  columns: [
    {
      key: 'title',
      label: 'Title',
      identity: true,
      sort: 'title',
      cell: (r) => r.identity.title.value ?? 'Untitled job',
    },
    {
      key: 'company',
      maxWidth: 180,
      label: 'Company',
      defaultVisible: true,
      cell: (r) => <Link href={`/companies/${enc(r.companyId)}`}>{r.companyName ?? 'Unnamed company'}</Link>,
    },
    {
      key: 'state',
      label: 'State',

      cell: (r) => <StatusBadge value={r.lifecycle.state} />,
    },
    {
      key: 'workModel',
      label: 'Work model',
      defaultVisible: true,
      cell: (r) => <FactSummary fact={r.geography.workModel} render={(v) => enumLabel(v)} />,
    },
    {
      key: 'remoteScope',
      label: 'Remote scope',

      cell: (r) => <FactSummary fact={r.geography.remoteScope} render={(v) => enumLabel(v.type)} />,
    },
    {
      key: 'locations',
      label: 'Locations',
      defaultVisible: true,
      maxWidth: 170,
      cell: (r) => <Locations r={r} />,
    },
    {
      key: 'sponsorship',
      maxWidth: 200,
      label: 'Sponsorship',
      defaultVisible: true,
      cell: (r) => (
        <FactSummary fact={r.immigration.sponsorship} render={(v) => <SponsorshipValue v={v} />} />
      ),
    },
    {
      key: 'salary',
      maxWidth: 150,
      label: 'Salary',
      defaultVisible: true,
      cell: (r) => <FactSummary fact={r.compensation} render={(v) => <Compensation v={v} />} />,
    },
    {
      key: 'lastSeen',
      label: 'Last seen',
      sort: 'lastSeenAt',
      defaultVisible: true,
      cell: (r) => <Time value={r.lifecycle.lastSeenAt} />,
    },
    { key: 'quality', label: 'Quality', cell: (r) => <Quality r={r} /> },
    {
      key: 'seniority',
      label: 'Seniority',
      cell: (r) => <FactSummary fact={r.identity.seniority} render={(v) => enumLabel(v)} />,
    },
    {
      key: 'employmentType',
      label: 'Employment type',
      cell: (r) => <FactSummary fact={r.employment.employmentType} render={(v) => enumLabel(v)} />,
    },
    {
      key: 'relocation',
      label: 'Relocation',
      cell: (r) => <FactSummary fact={r.immigration.relocation} render={(v) => enumLabel(v)} />,
    },
    {
      key: 'authorization',
      label: 'Authorization required',
      cell: (r) => (
        <FactSummary
          fact={r.immigration.authorization}
          render={(v) => (v.required === null ? 'not stated' : v.required ? 'yes' : 'no')}
        />
      ),
    },
    {
      key: 'firstSeen',
      label: 'First seen',
      sort: 'firstSeenAt',
      cell: (r) => <Time value={r.lifecycle.firstSeenAt} />,
    },
    {
      key: 'lastChanged',
      label: 'Last changed',
      sort: 'lastChangedAt',
      cell: (r) => <Time value={r.lifecycle.lastChangedAt} />,
    },
    {
      key: 'verification',
      label: 'Last verification',
      cell: (r) =>
        r.verification.lastOutcome ? (
          <StatusBadge value={r.verification.lastOutcome} />
        ) : (
          <span className="muted">never</span>
        ),
    },
    {
      key: 'providers',
      label: 'Providers',
      cell: (r) => (r.providers.length ? r.providers.join(', ') : <span className="muted">—</span>),
    },
    {
      key: 'flags',
      label: 'Flags',
      cell: (r) =>
        r.flags.length ? (
          <span title={r.flags.map((f) => `${f.code} (${f.severity})`).join(', ')}>
            {r.flags.map((f) => f.code).join(', ')}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
  ],
  rowId: (r) => r._id,
  rowHref: (r) => `/jobs/${enc(r._id)}`,
  rowTitle: (r) => r.identity.title.value ?? 'Untitled job',
  peek: (r) => [
    {
      label: 'Company',
      value: <Link href={`/companies/${enc(r.companyId)}`}>{r.companyName ?? 'Unnamed company'}</Link>,
    },
    { label: 'State', value: <StatusBadge value={r.lifecycle.state} /> },
    { label: 'Work model', value: <FactSummary fact={r.geography.workModel} render={(v) => enumLabel(v)} /> },
    {
      label: 'Remote scope',
      value: <FactSummary fact={r.geography.remoteScope} render={(v) => enumLabel(v.type)} />,
    },
    { label: 'Locations', value: <Locations r={r} /> },
    {
      label: 'Sponsorship',
      value: <FactSummary fact={r.immigration.sponsorship} render={(v) => <SponsorshipValue v={v} />} />,
    },
    { label: 'Salary', value: <FactSummary fact={r.compensation} render={(v) => <Compensation v={v} />} /> },
    { label: 'Last seen', value: <Time value={r.lifecycle.lastSeenAt} mode="absolute" /> },
    { label: 'Quality', value: <Quality r={r} /> },
  ],
  chipValue: (param, value, rows) =>
    param === 'companyId' ? (rows.find((r) => r.companyId === value)?.companyName ?? undefined) : undefined,
};
