import Link from 'next/link';
import { StatusBadge } from '@/components/Badge';
import { ConflictFields } from '@/components/records/facts/ConflictFields';
import { FactSummary } from '@/components/records/facts/FactSummary';
import { Time } from '@/components/ui/Time';
import { enumLabel, fmtLocation } from '@/lib/format';
import type { CompanySummary } from '@/lib/types';
import type { FilterSpec } from '@/lib/views';
import type { ObjectDef } from './types';

/*
 * Companies (`GET /api/companies`, list v2, `view=summary`; contract `market-companies.md`).
 * `licenceStatus` is the company's sponsor-licence capability, never a role statement.
 */

const enc = encodeURIComponent;
const BOOL = ['true', 'false'] as const;
// Market's non-CLOSED job states, copied until the jobs API offers `state!=CLOSED` (Market ask,
// routed by the supervisor); activeJobCount counts exactly these.
const OPEN_JOB_STATES = ['DISCOVERED', 'VERIFIED_LIVE', 'CHANGED', 'POSSIBLY_STALE', 'REOPENED', 'REPOSTED']
  .map(encodeURIComponent)
  .join(',');

const COMPANY_FILTERS: FilterSpec[] = [
  {
    param: 'licenceStatus',
    label: 'Sponsor licence (company)',
    kind: 'enum',
    values: ['licensed', 'previously_licensed', 'none'],
    labels: { licensed: 'licensed', previously_licensed: 'previously licensed', none: 'none known' },
  },
  {
    param: 'sponsorCountry',
    label: 'Licence country',
    kind: 'codes',
    pattern: /^[A-Z]{2}$/,
    transform: 'upper',
    placeholder: 'GB',
  },
  {
    param: 'careersStatus',
    label: 'Careers discovery',
    kind: 'enum',
    values: ['not_attempted', 'found', 'not_found', 'failed', 'website_unknown'],
  },
  {
    param: 'hasActiveJobs',
    label: 'Active jobs',
    kind: 'choice',
    values: BOOL,
    labels: { true: 'has active jobs', false: 'none' },
  },
  {
    param: 'hasOpenReviews',
    label: 'Open reviews',
    kind: 'choice',
    values: BOOL,
    labels: { true: 'has open reviews', false: 'none' },
  },
  {
    param: 'hasConflicts',
    label: 'Conflict fields',
    kind: 'choice',
    values: BOOL,
    labels: { true: 'has conflict fields', false: 'none' },
  },
  {
    param: 'hasDomain',
    label: 'Domain',
    kind: 'choice',
    values: BOOL,
    labels: { true: 'known', false: 'not known' },
  },
  { param: 'sourceId', label: 'Source', kind: 'codes', pattern: /^[A-Za-z0-9_:.-]{1,200}$/ },
  { param: 'changedAfter', label: 'Changed on or after', kind: 'date' },
  { param: 'changedBefore', label: 'Changed before', kind: 'date' },
  { param: 'createdAfter', label: 'Created on or after', kind: 'date' },
  { param: 'createdBefore', label: 'Created before', kind: 'date' },
];

function Licence({ r }: { r: CompanySummary }) {
  const sp = r.employment.sponsorship;
  return (
    <FactSummary
      fact={sp.capability}
      render={(v) => (
        <>
          <StatusBadge value={v} />
          {sp.licenceCountries.length ? (
            <span className="small"> {sp.licenceCountries.join(', ')}</span>
          ) : null}
        </>
      )}
    />
  );
}

function Quality({ r }: { r: CompanySummary }) {
  return (
    <span className="small">
      {r.quality.observationCount} obs · {r.quality.sourceCount} src
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

const name = (r: CompanySummary) => r.identity.displayName.value ?? r.identity.normalizedName;

export const companiesObject: ObjectDef<CompanySummary> = {
  key: 'companies',
  label: 'Companies',
  singular: 'company',
  path: '/companies',
  apiPath: '/api/companies',
  summaryView: true,
  searchLabel: 'Search companies',
  searchHint: 'The name, an alias or (one word) the domain starts with it.',
  filterNote:
    "Filters are the list API's own. Enum filters match a fact's value whatever its status; for settled values only add “Conflict fields: none”.",
  emptyAll: 'No companies yet. Companies appear once a company source has run.',
  defaultSort: 'name',
  sorts: [
    { key: 'name', label: 'Name' },
    { key: 'createdAt', label: 'Created' },
    { key: 'lastChangedAt', label: 'Last changed' },
  ],
  filters: COMPANY_FILTERS,
  views: [
    { id: 'all', label: 'All companies' },
    { id: 'licensed', label: 'Sponsor licence', filters: { licenceStatus: ['licensed'] } },
    { id: 'hiring', label: 'With active jobs', filters: { hasActiveJobs: ['true'] } },
    { id: 'reviews', label: 'Open reviews', filters: { hasOpenReviews: ['true'] } },
    { id: 'conflicts', label: 'Conflict fields', filters: { hasConflicts: ['true'] } },
    { id: 'recent', label: 'Recently changed', sort: '-lastChangedAt' },
  ],
  columns: [
    { key: 'name', label: 'Company', identity: true, sort: 'name', cell: name },
    {
      key: 'domain',
      label: 'Domain',
      defaultVisible: true,
      cell: (r) => <FactSummary fact={r.identity.domain} />,
    },
    {
      key: 'hq',
      label: 'Headquarters',
      defaultVisible: true,
      cell: (r) => <FactSummary fact={r.geography.headquarters} render={(v) => fmtLocation(v)} />,
    },
    {
      key: 'licence',
      label: 'Sponsor licence (company)',
      defaultVisible: true,
      cell: (r) => <Licence r={r} />,
    },
    {
      key: 'activeJobs',
      label: 'Active jobs',
      numeric: true,
      defaultVisible: true,
      cell: (r) =>
        r.activeJobCount ? (
          // activeJobCount counts active jobs in any state but CLOSED: the link lists exactly those.
          <Link href={`/jobs?companyId=${enc(r._id)}&state=${OPEN_JOB_STATES}`}>{r.activeJobCount}</Link>
        ) : (
          <span className="muted">0</span>
        ),
    },
    {
      key: 'careers',
      label: 'Careers',
      defaultVisible: true,
      cell: (r) => <StatusBadge value={r.freshness.careersDiscoveryStatus} />,
    },
    {
      key: 'ats',
      label: 'ATS',

      cell: (r) => (
        <FactSummary
          fact={r.employment.ats}
          render={(v) => v.map((a) => `${a.provider}:${a.boardToken}`).join(', ') || '—'}
        />
      ),
    },
    { key: 'quality', label: 'Quality', defaultVisible: true, cell: (r) => <Quality r={r} /> },
    {
      key: 'lastChanged',
      label: 'Last changed',
      sort: 'lastChangedAt',
      defaultVisible: true,
      cell: (r) => <Time value={r.freshness.lastChangedAt} />,
    },
    { key: 'legalName', label: 'Legal name', cell: (r) => <FactSummary fact={r.identity.legalName} /> },
    {
      key: 'aliases',
      label: 'Aliases',
      cell: (r) =>
        r.identity.aliases.length ? r.identity.aliases.join(', ') : <span className="muted">—</span>,
    },
    { key: 'created', label: 'Created', sort: 'createdAt', cell: (r) => <Time value={r.createdAt} /> },
    {
      key: 'careersChecked',
      label: 'Careers checked',
      cell: (r) => <Time value={r.freshness.careersCheckedAt} />,
    },
  ],
  rowId: (r) => r._id,
  rowHref: (r) => `/companies/${enc(r._id)}`,
  rowTitle: name,
  peek: (r) => [
    { label: 'Domain', value: <FactSummary fact={r.identity.domain} /> },
    { label: 'Legal name', value: <FactSummary fact={r.identity.legalName} /> },
    {
      label: 'Headquarters',
      value: <FactSummary fact={r.geography.headquarters} render={(v) => fmtLocation(v)} />,
    },
    { label: 'Sponsor licence (company)', value: <Licence r={r} /> },
    { label: 'Active jobs', value: r.activeJobCount },
    { label: 'Careers', value: enumLabel(r.freshness.careersDiscoveryStatus) },
    { label: 'Quality', value: <Quality r={r} /> },
    { label: 'Last changed', value: <Time value={r.freshness.lastChangedAt} mode="absolute" /> },
  ],
};
