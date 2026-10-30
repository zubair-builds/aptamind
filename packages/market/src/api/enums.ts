import { CAREERS_DISCOVERY_STATUSES } from '../companies/company.schema';
import { SOURCE_CATEGORIES } from '../contracts/common';
import {
  EMPLOYMENT_TYPES,
  PAY_PERIODS,
  RELOCATION_STATUSES,
  REMOTE_SCOPE_TYPES,
  SENIORITY_LEVELS,
  SPONSORSHIP_STATUSES,
  WORK_MODELS,
  compensationSchema,
  sponsorshipSchema,
} from '../contracts/employment';
import { SOURCE_FRESHNESS_STATES } from '../freshness/source-freshness';
import { JOB_STATES } from '../jobs/job.schema';
import { REVIEW_ACTIONS, REVIEW_TYPES } from '../review/schemas';
import { SOURCE_HEALTH_STATUSES } from '../sources/source.schema';
import { IDENTITY_NAMESPACE_DEFINITIONS, IDENTITY_NAMESPACES } from '../companies/external-ids';
import {
  REGISTER_ADAPTERS,
  REGISTER_EVIDENCE_TIERS,
  REGISTER_IDS,
  ROUTE_MEANINGS,
} from '../sources/providers/registers';
import { LICENCE_STATUSES } from './companies';
import { SALARY_STATUSES, VERIFICATION_OUTCOMES } from './jobs';
import { REVIEW_QUEUE_STATES, REVIEW_SEVERITIES } from './review';

/**
 * Market enums with display labels (Admin ask API-10, M7.7): the values the Market API returns
 * and accepts as filters, taken from the Market constants themselves, so the Admin stops
 * hard-coding them. Labels are plain English defaults; the UI may restyle them but must not
 * reinterpret the values (e.g. `company_capable` is company capability, never "sponsors").
 * Every catalog entry is exhaustive by construction: a label is required for every value.
 * Foundation enums (fact status, confidence, authority tiers, run states) are not Market's: the
 * API's `core.*` catalog serves them (`apps/admin/lib/api-server/routes/meta.ts`).
 */

interface EnumValue {
  value: string;
  label: string;
  /** Why the value must not be blurred (only where a label alone could mislead). */
  description?: string;
}
interface EnumEntry {
  /** Where the values appear: response paths and list filter parameters. */
  appliesTo: string[];
  values: EnumValue[];
}

type Labels<V extends string> = Record<V, string | { label: string; description: string }>;

function entry<const V extends string>(
  values: readonly V[],
  labels: Labels<V>,
  appliesTo: string[],
): EnumEntry {
  return {
    appliesTo,
    values: values.map((value) => {
      const l = labels[value];
      if (typeof l === 'string') return { value, label: l };
      const { label, description } = l as { label: string; description: string };
      return { value, label, description };
    }),
  };
}

/** Labels ruling (DECISION_LOG "Sponsor register adapters" (6)): never "Sponsored before". */
const HISTORY_DESCRIPTION =
  "The company's past visa petitions in this country (e.g. US H-1B approvals); not a current licence and not about this role.";

const UNCLEAR = { label: 'Unclear', description: 'The evidence does not decide it; not a "no".' };

const MEANING_TEXT = {
  labour: 'company capability for jobs in the register country only; never a role statement',
  history:
    'company hiring history for jobs in the register country only; never capability, never a role statement',
  ignored: 'not employment sponsorship; never evidence',
} as const;

/** Every route of every register taxonomy (by canonical label, as stored on licences). */
const REGISTER_ROUTES = [
  ...new Map(
    REGISTER_ADAPTERS.flatMap((a) =>
      a.routes.map(
        (r) =>
          [
            r.label,
            {
              label: r.label,
              description: `${a.scope.country} register (${a.id}): ${MEANING_TEXT[r.meaning]}.`,
            },
          ] as const,
      ),
    ),
  ),
];

/** The Market enum catalog, keyed `market.<name>`. */
export const MARKET_ENUMS: Record<string, EnumEntry> = {
  'market.jobState': entry(
    JOB_STATES,
    {
      DISCOVERED: 'Discovered',
      VERIFIED_LIVE: 'Verified live',
      CHANGED: 'Changed',
      POSSIBLY_STALE: 'Possibly stale',
      CLOSED: 'Closed',
      REOPENED: 'Reopened',
      REPOSTED: 'Reposted',
    },
    ['job.lifecycle.state', 'GET /api/jobs?state'],
  ),
  'market.workModel': entry(
    WORK_MODELS,
    { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site', unclear: UNCLEAR },
    ['job.geography.workModel.value', 'GET /api/jobs?workModel'],
  ),
  'market.remoteScope': entry(
    REMOTE_SCOPE_TYPES,
    {
      worldwide: 'Worldwide',
      region: 'Region',
      country: 'Country',
      selected_countries: 'Selected countries',
      timezone: 'Time-zone range',
      unclear: UNCLEAR,
      not_applicable: { label: 'Not applicable', description: 'The role is not remote.' },
    },
    ['job.geography.remoteScope.value.type', 'GET /api/jobs?remoteScope'],
  ),
  'market.sponsorship': entry(
    SPONSORSHIP_STATUSES,
    {
      explicit_yes: {
        label: 'Role offers sponsorship',
        description:
          'Asserted for the role by an operator (review correction); posting text never yields it (see flag sponsorship_stated).',
      },
      explicit_no: {
        label: 'Role excludes sponsorship',
        description:
          'Asserted for the role by an operator (review correction); posting text never yields it (see flag sponsorship_stated).',
      },
      company_capable: {
        label: 'Company licensed; role silent',
        description:
          'The company holds a relevant sponsor licence and the role says nothing. Not "this job sponsors".',
      },
      historical_evidence: {
        label: 'Sponsorship history',
        description: HISTORY_DESCRIPTION,
      },
      unclear: UNCLEAR,
    },
    ['job.immigration.sponsorship.value.status', 'GET /api/jobs?sponsorship'],
  ),
  'market.sponsorshipRoleStatement': entry(
    sponsorshipSchema.shape.roleStatement.options,
    { yes: 'Role says yes', no: 'Role says no', none: 'Role says nothing' },
    ['job.immigration.sponsorship.value.roleStatement'],
  ),
  'market.sponsorshipCompanyCapability': entry(
    sponsorshipSchema.shape.companyCapability.options,
    {
      licensed: 'Licensed',
      previously_licensed: {
        label: 'Previously licensed',
        description:
          'A licence no longer on the register: past capability only; never "Sponsorship history" and never a role signal.',
      },
      historical: { label: 'Sponsorship history', description: HISTORY_DESCRIPTION },
      none: {
        label: 'No licence known',
        description: 'No current or historical licence known for the company; not a role statement.',
      },
      unknown: { label: 'Unknown', description: 'Not known; not "no licence".' },
    },
    ['job.immigration.sponsorship.value.companyCapability'],
  ),
  'market.relocation': entry(
    RELOCATION_STATUSES,
    {
      explicit_yes: 'Relocation offered',
      explicit_no: 'No relocation',
      possible: 'Relocation possible',
      unclear: UNCLEAR,
    },
    ['job.immigration.relocation.value', 'GET /api/jobs?relocation'],
  ),
  'market.employmentType': entry(
    EMPLOYMENT_TYPES,
    {
      full_time: 'Full-time',
      part_time: 'Part-time',
      contract: 'Contract',
      temporary: 'Temporary',
      internship: 'Internship',
      apprenticeship: 'Apprenticeship',
      freelance: 'Freelance',
      unclear: UNCLEAR,
    },
    ['job.employment.employmentType.value', 'GET /api/jobs?employmentType'],
  ),
  'market.seniority': entry(
    SENIORITY_LEVELS,
    {
      intern: 'Intern',
      junior: 'Junior',
      mid: 'Mid-level',
      senior: 'Senior',
      staff: 'Staff',
      principal: 'Principal',
      lead: 'Lead',
      manager: 'Manager',
      director: 'Director',
      vp: 'VP',
      executive: 'Executive',
      unclear: UNCLEAR,
    },
    ['job.identity.seniority.value', 'GET /api/jobs?seniority'],
  ),
  'market.salaryStatus': entry(
    SALARY_STATUSES,
    {
      parsed: 'Parsed',
      unknown: { label: 'Not stated', description: 'No pay information; never 0.' },
      ambiguous: { label: 'Ambiguous', description: 'E.g. "$" outside the US: the currency is not certain.' },
      malformed: 'Could not be parsed',
    },
    ['job.compensation.value.status', 'GET /api/jobs?salaryStatus'],
  ),
  'market.payPeriod': entry(
    PAY_PERIODS,
    { hour: 'Per hour', day: 'Per day', week: 'Per week', month: 'Per month', year: 'Per year' },
    ['job.compensation.value.period'],
  ),
  'market.compensationBasis': entry(
    compensationSchema.shape.basis.options,
    {
      base_salary: 'Base salary',
      total_compensation: 'Total compensation',
      ote: 'On-target earnings',
      contract_rate: 'Contract rate',
      unknown: 'Unknown basis',
    },
    ['job.compensation.value.basis'],
  ),
  'market.verificationOutcome': entry(
    VERIFICATION_OUTCOMES,
    {
      live: 'Live',
      not_found: 'Not found',
      inconclusive: { label: 'Inconclusive', description: 'Never evidence of closure.' },
      none: 'Never verified',
    },
    ['job.verification.lastOutcome', 'GET /api/jobs?verificationOutcome'],
  ),
  'market.careersDiscoveryStatus': entry(
    CAREERS_DISCOVERY_STATUSES,
    {
      not_attempted: 'Not attempted',
      found: 'Found',
      not_found: 'Not found',
      failed: 'Failed',
      website_unknown: { label: 'No website known', description: 'Discovery never guesses a domain.' },
    },
    ['company.freshness.careersDiscoveryStatus', 'GET /api/companies?careersStatus'],
  ),
  'market.licenceStatus': entry(
    LICENCE_STATUSES,
    {
      licensed: 'Licensed',
      previously_licensed: 'Previously licensed',
      none: {
        label: 'No licence known',
        description:
          'No current or historical licence known for the company; company capability only, never role sponsorship.',
      },
    },
    ['company.employment.sponsorship.capability.value', 'GET /api/companies?licenceStatus'],
  ),
  'market.sponsorRegister': entry(
    REGISTER_IDS,
    Object.fromEntries(
      REGISTER_ADAPTERS.map((a) => [
        a.id,
        {
          label: a.title,
          description: `${a.publisher}. ${a.evidenceTier === 'history' ? 'Hiring history' : 'Company capability'} for ${a.scope.country} only; never role sponsorship.`,
        },
      ]),
    ),
    ['company.employment.sponsorship.licences[].register'],
  ),
  'market.registerRoute': entry(
    REGISTER_ROUTES.map(([value]) => value),
    Object.fromEntries(REGISTER_ROUTES),
    [
      "company.employment.sponsorship.licences[].route (registers with a route taxonomy; UK routes are the register's own labels)",
      'run node parse.output.routes[].route (market.sponsor_register.import)',
    ],
  ),
  'market.registerRouteMeaning': entry(
    ROUTE_MEANINGS,
    {
      labour: { label: 'Labour route', description: `Capability evidence: ${MEANING_TEXT.labour}.` },
      history: { label: 'Hiring history', description: `History evidence: ${MEANING_TEXT.history}.` },
      ignored: {
        label: 'Ignored route',
        description: `Study, au pair, exchange or unrecognised: ${MEANING_TEXT.ignored}.`,
      },
    },
    ['run node parse.output.routes[].meaning (market.sponsor_register.import)'],
  ),
  'market.registerEvidenceTier': entry(
    REGISTER_EVIDENCE_TIERS,
    {
      capability: {
        label: 'Company capability',
        description:
          'A current listing: the company may sponsor in the register country. Never "this job sponsors".',
      },
      history: {
        label: 'Hiring history',
        description:
          'Past sponsorship activity. Weaker than capability; never capability and never a role statement.',
      },
    },
    ['register adapters (docs/programme/contracts/market-sources.md "Sponsor registers")'],
  ),
  'market.identityNamespace': entry(
    IDENTITY_NAMESPACES,
    Object.fromEntries(
      IDENTITY_NAMESPACES.map((n) => [n, IDENTITY_NAMESPACE_DEFINITIONS[n].label]),
    ) as Record<(typeof IDENTITY_NAMESPACES)[number], string>,
    ['company.identity.externalIds[].namespace'],
  ),
  'market.sourceCategory': entry(
    SOURCE_CATEGORIES,
    {
      company_universe: 'Company universe',
      job_source: 'Job source',
      signal_source: 'Signal source',
      manual_import: 'Manual import',
    },
    ['source.category', 'GET /api/sources?category'],
  ),
  'market.sourceHealth': entry(
    SOURCE_HEALTH_STATUSES,
    {
      never_run: 'Never run',
      healthy: 'Healthy',
      degraded: { label: 'Degraded', description: 'The last logical run failed.' },
      failing: { label: 'Failing', description: 'Three or more logical runs failed in a row.' },
    },
    ['source.health.status', 'GET /api/sources?health'],
  ),
  'market.sourceFreshness': entry(
    SOURCE_FRESHNESS_STATES,
    {
      fresh: 'Fresh',
      due: 'Due',
      overdue: 'Overdue',
      never_succeeded: 'Never succeeded',
      disabled: 'Disabled',
    },
    ['source.freshnessState', 'GET /api/sources?freshness'],
  ),
  'market.reviewType': entry(
    REVIEW_TYPES,
    {
      company_resolution: 'Company resolution',
      company_duplicate: 'Possible duplicate company',
      job_duplicate: 'Possible duplicate job',
      field_conflict: 'Field conflict',
      employment_conflict: 'Employment conflict',
      salary_suspicious: 'Suspicious salary',
      parser_failure: 'Parser failure',
      source_anomaly: 'Source anomaly',
      careers_discovery: 'Careers discovery',
      lifecycle_failure: 'Lifecycle failure',
    },
    ['review.type', 'GET /api/review?type'],
  ),
  'market.reviewSeverity': entry(REVIEW_SEVERITIES, { low: 'Low', medium: 'Medium', high: 'High' }, [
    'review.severity',
    'GET /api/review?severity',
  ]),
  'market.reviewAction': entry(
    REVIEW_ACTIONS,
    {
      confirm: { label: 'Confirm', description: 'The current value is right; no domain effect.' },
      correct: 'Correct',
      merge: { label: 'Merge', description: 'Irreversible in v0.1.' },
      create_new: 'Create new company',
      keep_separate: 'Keep separate',
      reject: 'Reject',
      retry: 'Retry',
      dismiss: 'Dismiss',
    },
    ['review.allowedActions', 'review.supportedActions', 'POST /api/review/:id/resolve action'],
  ),
  'market.reviewQueueState': entry(
    REVIEW_QUEUE_STATES,
    {
      open: 'Open',
      resolving: 'Being resolved',
      failed: 'Previous decision failed',
      resolved: 'Resolved',
      dismissed: 'Dismissed',
    },
    ['review.queueState'],
  ),
};
