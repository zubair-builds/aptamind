import type { Db, Document, Filter } from 'mongodb';
import { z } from 'zod';
import { CONFIDENCE_LEVELS, type ConfidenceLevel } from '@aptamind/provenance';
import { companiesCollection } from '../companies/company.schema';
import {
  EMPLOYMENT_TYPES,
  PAY_PERIODS,
  RELOCATION_STATUSES,
  REMOTE_SCOPE_TYPES,
  remoteScopeSchema,
  SENIORITY_LEVELS,
  SPONSORSHIP_STATUSES,
  sponsorshipSchema,
  WORK_MODELS,
  authorizationSchema,
} from '../contracts/employment';
import { type JobDoc, JOB_STATES, jobsCollection } from '../jobs/job.schema';
import { isHiddenByProvider } from '../jobs/job.service';
import { titleTokens } from '../jobs/title-tokens';
import { escapeRegex } from '../sources/source.service';
import { companySearchFilter } from './companies';
import { jobDto, listPageDto } from './dto';
import {
  csvParam,
  dateParam,
  dateRange,
  explainList,
  type ListPage,
  type ListPlan,
  listPageShape,
  refinePaging,
  idSemiJoin,
  openReviewCounts,
  openReviewEntityIds,
  openReviewStages,
  runList,
  sortFields,
  type SortOptions,
  sortParam,
  viewParam,
} from './list';
import { boolParam, countryParam, idParam, searchParam } from './query';
import { factProjection, factsHash, type SummaryFact, summaryFact, summaryFactDto } from './summary';
import { isoDateTime } from './wire';

// ------------------------------------------------------------------ query (M7.3)

/** Sort keys of `GET /api/jobs` (each backed by a `list_*` index on `market_jobs`). */
export const JOB_SORTS = {
  lastSeenAt: [['lifecycle.lastSeenAt', 1]],
  firstSeenAt: [['lifecycle.firstSeenAt', 1]],
  lastChangedAt: [['lifecycle.lastChangedAt', 1]],
  title: [['identity.normalizedTitle', 1]],
} as const satisfies SortOptions;
export type JobSort = keyof typeof JOB_SORTS;

/** Job facts `minConfidence` can target, and their paths. */
export const JOB_CONFIDENCE_FIELDS = {
  title: 'identity.title',
  seniority: 'identity.seniority',
  employmentType: 'employment.employmentType',
  workModel: 'geography.workModel',
  remoteScope: 'geography.remoteScope',
  sponsorship: 'immigration.sponsorship',
  authorization: 'immigration.authorization',
  relocation: 'immigration.relocation',
  compensation: 'compensation',
} as const;
type ConfidenceField = keyof typeof JOB_CONFIDENCE_FIELDS;

const CONF_RANK: Record<ConfidenceLevel, number> = { unknown: 0, low: 1, medium: 2, high: 3 };

/** Levels a `minConfidence` item can require: the provenance levels except `unknown`. */
export const MIN_CONFIDENCE_LEVELS = CONFIDENCE_LEVELS.filter(
  (l): l is Exclude<ConfidenceLevel, 'unknown'> => l !== 'unknown',
);

/** `field:level`, e.g. `sponsorship:medium` = that fact's confidence is medium or high. */
const minConfidenceItem = z
  .string()
  .regex(/^[a-zA-Z]+:[a-z]+$/, `Expected <field>:<${MIN_CONFIDENCE_LEVELS.join('|')}>`)
  .refine((s) => Object.hasOwn(JOB_CONFIDENCE_FIELDS, s.split(':')[0]!), {
    message: `Field must be one of ${Object.keys(JOB_CONFIDENCE_FIELDS).join(', ')}`,
  })
  .refine((s) => (MIN_CONFIDENCE_LEVELS as readonly string[]).includes(s.split(':')[1]!), {
    message: `Level must be one of ${MIN_CONFIDENCE_LEVELS.join(', ')} (from CONFIDENCE_LEVELS)`,
  });

export const SALARY_STATUSES = ['parsed', 'unknown', 'ambiguous', 'malformed'] as const;
export const VERIFICATION_OUTCOMES = ['live', 'not_found', 'inconclusive', 'none'] as const;

/** `GET /api/jobs` (v2, a superset of v1). */
export const jobListQuerySchema = z
  .strictObject({
    ...listPageShape,
    view: viewParam,
    sort: sortParam(Object.keys(JOB_SORTS) as JobSort[], '-lastSeenAt'),
    q: searchParam.min(1).optional(),
    state: csvParam(z.enum(JOB_STATES)).optional(),
    companyId: csvParam(idParam).optional(),
    workModel: csvParam(z.enum(WORK_MODELS)).optional(),
    remoteScope: csvParam(z.enum(REMOTE_SCOPE_TYPES)).optional(),
    sponsorship: csvParam(z.enum(SPONSORSHIP_STATUSES)).optional(),
    relocation: csvParam(z.enum(RELOCATION_STATUSES)).optional(),
    employmentType: csvParam(z.enum(EMPLOYMENT_TYPES)).optional(),
    seniority: csvParam(z.enum(SENIORITY_LEVELS)).optional(),
    authorizationRequired: z.enum(['true', 'false', 'unknown']).optional(),
    country: csvParam(countryParam).optional(),
    minConfidence: csvParam(minConfidenceItem, 9).optional(),
    flag: csvParam(z.string().regex(/^[a-z0-9_]{1,64}$/, 'Expected a flag code')).optional(),
    verificationOutcome: csvParam(z.enum(VERIFICATION_OUTCOMES)).optional(),
    verificationDue: boolParam,
    salaryStatus: csvParam(z.enum(SALARY_STATUSES)).optional(),
    currency: csvParam(
      z
        .string()
        .toUpperCase()
        .regex(/^[A-Z]{3}$/, 'Expected an ISO 4217 currency code'),
    ).optional(),
    minAnnual: z.coerce.number().min(0).max(100_000_000).optional(),
    sourceId: csvParam(idParam).optional(),
    provider: csvParam(z.string().regex(/^[a-z0-9_]{1,64}$/, 'Expected a provider key')).optional(),
    hasConflicts: boolParam,
    hasOpenReviews: boolParam,
    lastSeenAfter: dateParam.optional(),
    lastSeenBefore: dateParam.optional(),
    firstSeenAfter: dateParam.optional(),
    firstSeenBefore: dateParam.optional(),
    changedAfter: dateParam.optional(),
    changedBefore: dateParam.optional(),
  })
  .superRefine((q, ctx) => {
    refinePaging(q, ctx);
    if (q.minAnnual !== undefined && q.currency?.length !== 1)
      ctx.addIssue({
        code: 'custom',
        path: ['minAnnual'],
        message: 'minAnnual needs exactly one currency (annualised pay is not converted between currencies)',
      });
  });
export type JobListV2Query = z.infer<typeof jobListQuerySchema>;

export const jobDetailQuerySchema = z.strictObject({ view: viewParam });

// ------------------------------------------------------------------ search

/**
 * Words of a title search, tokenised like titles (`titleTokens`), longest (most selective) first;
 * at most 8.
 */
export function titleSearchWords(q: string): string[] {
  return titleTokens(q)
    .sort((a, b) => b.length - a.length)
    .slice(0, 8);
}

/**
 * Title **and** company-name search: every word of `q` is an anchored prefix of some title token
 * (`by_title_tokens`, multikey: "eng" finds "Engineer", "c++" finds "C++ Developer"), or the job's
 * company matches `q` through the anchored company prefix search. Never an unanchored regex over
 * the collection.
 */
export async function jobSearchFilter(db: Db, q: string): Promise<Filter<Document>> {
  const branches: Document[] = [];
  const words = titleSearchWords(q);
  if (words.length) {
    const prefix = (w: string) => ({ 'identity.titleTokens': { $regex: `^${escapeRegex(w)}` } });
    branches.push(words.length === 1 ? prefix(words[0]!) : { $and: words.map(prefix) });
  }
  const companies = await db
    .collection(companiesCollection.name)
    .find({ status: 'active', ...companySearchFilter(q) }, { projection: { _id: 1 } })
    .limit(200)
    .toArray();
  if (companies.length) branches.push({ companyId: { $in: companies.map((c) => c._id) } });
  if (!branches.length) return { _id: { $exists: false } };
  return branches.length === 1 ? branches[0]! : { $or: branches };
}

// ------------------------------------------------------------------ summary view

type CompensationSummary = {
  status: (typeof SALARY_STATUSES)[number];
  min: number | null;
  max: number | null;
  currency: string | null;
  period: (typeof PAY_PERIODS)[number] | null;
  basis: string;
  annualized: { min: number | null; max: number | null } | null;
  /** Parser warnings (first `COMP_WARNINGS_MAX`). */
  warnings: string[];
  /** The pay statement as written (≤ `COMP_TEXT_MAX` chars; the full text is on the record). */
  originalText: string | null;
};

/** Size bounds of the compensation summary (a summary row stays within `SUMMARY_ROW_MAX`). */
export const COMP_WARNINGS_MAX = 3;
export const COMP_TEXT_MAX = 120;
const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);

export interface JobListSummary {
  _id: string;
  companyId: string;
  companyName: string | null;
  status: JobDoc['status'];
  mergedInto?: string;
  identity: {
    title: SummaryFact<string>;
    seniority: SummaryFact<(typeof SENIORITY_LEVELS)[number]>;
  };
  employment: { employmentType: SummaryFact<(typeof EMPLOYMENT_TYPES)[number]> };
  geography: {
    /** As the source wrote them (first 3; `locationCount` has the total). */
    listedLocations: string[];
    locationCount: number;
    /** Distinct ISO-2 countries of the normalised locations (for country chips). */
    countries: string[];
    workModel: SummaryFact<(typeof WORK_MODELS)[number]>;
    remoteScope: SummaryFact<z.infer<typeof remoteScopeSchema>>;
  };
  immigration: {
    sponsorship: SummaryFact<z.infer<typeof sponsorshipSchema>>;
    authorization: SummaryFact<z.infer<typeof authorizationSchema>>;
    relocation: SummaryFact<(typeof RELOCATION_STATUSES)[number]>;
  };
  compensation: SummaryFact<CompensationSummary>;
  /** The canonical posting URL, else the apply URL. */
  postingUrl: string | null;
  lifecycle: Pick<
    JobDoc['lifecycle'],
    'state' | 'firstSeenAt' | 'lastSeenAt' | 'publishedAt' | 'lastChangedAt' | 'closedAt' | 'closeReason'
  >;
  verification: JobDoc['verification'];
  /** Interpretation flags without their messages (open the record for those). */
  flags: Array<{ code: string; severity: 'info' | 'warning' | 'high' }>;
  quality: Pick<JobDoc['quality'], 'conflictFields' | 'sourceCount'>;
  /** Live count of open review items naming the job (entity or candidate). */
  openReviewCount: number;
  /** Distinct providers of the job's source copies (e.g. `greenhouse`, `aggregator`). */
  providers: string[];
  /**
   * Every present copy is hidden by its provider (`providerState: 'unlisted'`, ruling U1): the
   * job exists but cannot be verified; it is never closed by absence (`isHiddenByProvider`).
   */
  hiddenByProvider: boolean;
  /** Optimistic-concurrency revision (0 before the first fenced write); pin joins to it. */
  rev: number;
  /**
   * Lifecycle material hash (title, description, locations, work model, remote scope, sponsorship,
   * pay, requirement count, conflict fields): drives the `CHANGED` state; ignores status/confidence.
   */
  contentHash: string;
  /** Version pin of every summary fact (value, status, confidence; `factsHash`). */
  factsHash: string;
  /** Versions of the interpretation the facts come from. */
  interpretation: Pick<JobDoc['interpretation'], 'logicVersion' | 'policyVersion' | 'taxonomyVersion'>;
  updatedAt: Date;
}

export const JOB_SUMMARY_FACTS = [
  'identity.title',
  'identity.seniority',
  'employment.employmentType',
  'geography.workModel',
  'geography.remoteScope',
  'immigration.sponsorship',
  'immigration.authorization',
  'immigration.relocation',
  'compensation',
];

export const jobSummaryProjection: Document = {
  companyId: 1,
  status: 1,
  mergedInto: 1,
  'identity.normalizedTitle': 1, // the `title` sort key (cursor), not returned
  'geography.listedLocations': 1,
  'geography.normalizedLocations.country': 1,
  'application.canonicalPostingUrl': 1,
  'application.applyUrl': 1,
  'lifecycle.state': 1,
  'lifecycle.firstSeenAt': 1,
  'lifecycle.lastSeenAt': 1,
  'lifecycle.publishedAt': 1,
  'lifecycle.lastChangedAt': 1,
  'lifecycle.closedAt': 1,
  'lifecycle.closeReason': 1,
  verification: 1,
  'interpretation.flags.code': 1,
  'interpretation.flags.severity': 1,
  'interpretation.logicVersion': 1,
  'interpretation.policyVersion': 1,
  'interpretation.taxonomyVersion': 1,
  'quality.conflictFields': 1,
  'quality.sourceCount': 1,
  rev: 1,
  contentHash: 1,
  'sourceRefs.provider': 1,
  'sourceRefs.present': 1,
  'sourceRefs.providerState': 1,
  updatedAt: 1,
  ...Object.assign({}, ...JOB_SUMMARY_FACTS.map(factProjection)),
};

function compensationSummary(v: JobDoc['compensation']['value']): CompensationSummary | null {
  if (!v) return null;
  return {
    status: v.status,
    min: v.min,
    max: v.max,
    currency: v.currency,
    period: v.period,
    basis: v.basis,
    annualized: v.annualized ? { min: v.annualized.min, max: v.annualized.max } : null,
    warnings: (v.warnings ?? []).slice(0, COMP_WARNINGS_MAX).map((w) => clip(w, COMP_TEXT_MAX)),
    originalText: v.originalText ? clip(v.originalText, COMP_TEXT_MAX) : null,
  };
}

const pick = <T extends object, K extends keyof T>(o: T, keys: K[]) =>
  Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) as Pick<T, K>;

export function toJobSummary(
  j: JobDoc,
  companyName: string | null,
  live: { openReviewCount: number },
): JobListSummary {
  const comp = summaryFact(j.compensation);
  return {
    _id: j._id,
    companyId: j.companyId,
    companyName,
    status: j.status,
    ...(j.mergedInto ? { mergedInto: j.mergedInto } : {}),
    identity: {
      title: summaryFact(j.identity.title),
      seniority: summaryFact(j.identity.seniority),
    },
    employment: { employmentType: summaryFact(j.employment.employmentType) },
    geography: {
      listedLocations: (j.geography.listedLocations ?? []).slice(0, 3),
      locationCount: Math.max(
        (j.geography.listedLocations ?? []).length,
        (j.geography.normalizedLocations ?? []).length,
      ),
      countries: [
        ...new Set(
          (j.geography.normalizedLocations ?? []).map((l) => l.country).filter((c): c is string => !!c),
        ),
      ],
      workModel: summaryFact(j.geography.workModel),
      remoteScope: summaryFact(j.geography.remoteScope),
    },
    immigration: {
      sponsorship: summaryFact(j.immigration.sponsorship),
      authorization: summaryFact(j.immigration.authorization),
      relocation: summaryFact(j.immigration.relocation),
    },
    compensation: { ...comp, value: compensationSummary(j.compensation?.value ?? null) },
    postingUrl: j.application?.canonicalPostingUrl ?? j.application?.applyUrl ?? null,
    lifecycle: pick(j.lifecycle, [
      'state',
      'firstSeenAt',
      'lastSeenAt',
      'publishedAt',
      'lastChangedAt',
      'closedAt',
      'closeReason',
    ]),
    verification: j.verification ?? {},
    flags: (j.interpretation?.flags ?? []).map((f) => ({ code: f.code, severity: f.severity })),
    quality: { conflictFields: j.quality.conflictFields ?? [], sourceCount: j.quality.sourceCount },
    openReviewCount: live.openReviewCount,
    providers: [...new Set((j.sourceRefs ?? []).map((r) => r.provider))].sort(),
    hiddenByProvider: isHiddenByProvider({ sourceRefs: j.sourceRefs ?? [] }),
    rev: j.rev ?? 0,
    contentHash: j.contentHash,
    factsHash: factsHash(j, JOB_SUMMARY_FACTS),
    interpretation: {
      logicVersion: j.interpretation.logicVersion,
      policyVersion: j.interpretation.policyVersion,
      taxonomyVersion: j.interpretation.taxonomyVersion,
    },
    updatedAt: j.updatedAt,
  };
}

/** Display names of the jobs' companies (`identity.displayName.value`). */
export async function companyNames(db: Db, companyIds: string[]): Promise<Map<string, string | null>> {
  const docs = await db
    .collection<{ _id: string; identity: { displayName: { value: string | null } } }>(
      companiesCollection.name,
    )
    .find({ _id: { $in: [...new Set(companyIds)] } }, { projection: { 'identity.displayName.value': 1 } })
    .toArray();
  return new Map(docs.map((c) => [c._id, c.identity.displayName.value]));
}

// ------------------------------------------------------------------ list

export async function jobListPlan(db: Db, q: JobListV2Query, now: Date): Promise<ListPlan> {
  const and: Filter<Document>[] = [{ status: 'active' }];
  const add = (f: Filter<Document> | undefined) => f && and.push(f);
  if (q.q) add(await jobSearchFilter(db, q.q));
  if (q.state) add({ 'lifecycle.state': { $in: q.state } });
  if (q.companyId) add({ companyId: { $in: q.companyId } });
  if (q.workModel) add({ 'geography.workModel.value': { $in: q.workModel } });
  if (q.remoteScope) add({ 'geography.remoteScope.value.type': { $in: q.remoteScope } });
  if (q.sponsorship) add({ 'immigration.sponsorship.value.status': { $in: q.sponsorship } });
  if (q.relocation) add({ 'immigration.relocation.value': { $in: q.relocation } });
  if (q.employmentType) add({ 'employment.employmentType.value': { $in: q.employmentType } });
  if (q.seniority) add({ 'identity.seniority.value': { $in: q.seniority } });
  if (q.authorizationRequired)
    add({
      'immigration.authorization.value.required':
        q.authorizationRequired === 'unknown' ? null : q.authorizationRequired === 'true',
    });
  if (q.country)
    add({
      $or: [
        { 'geography.normalizedLocations.country': { $in: q.country } },
        { 'geography.remoteScope.value.countries': { $in: q.country } },
      ],
    });
  for (const item of q.minConfidence ?? []) {
    const [field, level] = item.split(':') as [ConfidenceField, ConfidenceLevel];
    const levels = CONFIDENCE_LEVELS.filter((l) => CONF_RANK[l] >= CONF_RANK[level]);
    add({ [`${JOB_CONFIDENCE_FIELDS[field]}.confidence.level`]: { $in: levels } });
  }
  if (q.flag) add({ 'interpretation.flags.code': { $in: q.flag } });
  if (q.verificationOutcome)
    add({
      'verification.lastOutcome': {
        $in: q.verificationOutcome.map((o) => (o === 'none' ? null : o)),
      },
    });
  if (q.verificationDue !== undefined)
    add(
      q.verificationDue
        ? { 'verification.nextVerificationDueAt': { $lte: now } }
        : {
            $or: [
              { 'verification.nextVerificationDueAt': { $gt: now } },
              { 'verification.nextVerificationDueAt': null },
            ],
          },
    );
  if (q.salaryStatus)
    add({
      'compensation.value.status': {
        $in: q.salaryStatus.includes('unknown') ? [...q.salaryStatus, null] : q.salaryStatus,
      },
    });
  if (q.currency) add({ 'compensation.value.currency': { $in: q.currency } });
  if (q.minAnnual !== undefined)
    add({
      $or: [
        { 'compensation.value.annualized.max': { $gte: q.minAnnual } },
        {
          'compensation.value.annualized.max': null,
          'compensation.value.annualized.min': { $gte: q.minAnnual },
        },
      ],
    });
  // `sourceKeys` = `<sourceId>:<externalId>`: an anchored prefix on the unique source-key index.
  if (q.sourceId) add({ sourceKeys: { $in: q.sourceId.map((s) => new RegExp(`^${escapeRegex(s)}:`)) } });
  if (q.provider) add({ 'sourceRefs.provider': { $in: q.provider } });
  if (q.hasConflicts !== undefined) add({ 'quality.conflictFields.0': { $exists: q.hasConflicts } });
  const seen = dateRange(q.lastSeenAfter, q.lastSeenBefore);
  if (seen) add({ 'lifecycle.lastSeenAt': seen });
  const first = dateRange(q.firstSeenAfter, q.firstSeenBefore);
  if (first) add({ 'lifecycle.firstSeenAt': first });
  const changed = dateRange(q.changedAfter, q.changedBefore);
  if (changed) add({ 'lifecycle.lastChangedAt': changed });
  const hasOpen = q.hasOpenReviews;
  const join =
    hasOpen === undefined
      ? undefined
      : idSemiJoin(await openReviewEntityIds(db, 'job'), hasOpen, () => openReviewStages('job', hasOpen));
  if (join?.match) and.push(join.match);
  return {
    match: and.length === 1 ? and[0]! : { $and: and },
    semiJoins: join?.stages ?? [],
    defaultCount: join ? 'none' : 'exact',
    projection:
      q.view === 'summary' ? jobSummaryProjection : { 'content.descriptionText': 0, 'content.shingles': 0 },
    sort: q.sort,
    fields: sortFields(JOB_SORTS, q.sort),
    limit: q.limit,
    offset: q.offset,
    after: q.after,
    count: q.count,
  };
}

export type JobListItem = Omit<JobDoc, 'content'> & {
  content: Omit<JobDoc['content'], 'descriptionText' | 'shingles'>;
  companyName: string | null;
};

/** `GET /api/jobs`: v1 list items (full minus description, plus `companyName`) or summaries. */
export async function listJobs(
  db: Db,
  q: JobListV2Query,
  now: Date,
): Promise<ListPage<JobListItem> | ListPage<JobListSummary>> {
  const page = await runList(db.collection<JobDoc>(jobsCollection.name), await jobListPlan(db, q, now));
  const [names, reviews] = await Promise.all([
    companyNames(
      db,
      page.items.map((j) => j.companyId),
    ),
    q.view === 'summary'
      ? openReviewCounts(
          db,
          'job',
          page.items.map((j) => j._id),
        )
      : Promise.resolve(new Map<string, number>()),
  ]);
  if (q.view === 'summary')
    return {
      ...page,
      items: page.items.map((j) =>
        toJobSummary(j, names.get(j.companyId) ?? null, { openReviewCount: reviews.get(j._id) ?? 0 }),
      ),
    };
  return {
    ...page,
    items: page.items.map((j) => ({ ...j, companyName: names.get(j.companyId) ?? null }) as JobListItem),
  };
}

export async function jobSummary(db: Db, job: JobDoc): Promise<JobListSummary> {
  const [names, reviews] = await Promise.all([
    companyNames(db, [job.companyId]),
    openReviewCounts(db, 'job', [job._id]),
  ]);
  return toJobSummary(job, names.get(job.companyId) ?? null, {
    openReviewCount: reviews.get(job._id) ?? 0,
  });
}

export async function explainJobList(db: Db, q: JobListV2Query, now: Date): Promise<Document> {
  return explainList(db.collection<JobDoc>(jobsCollection.name), await jobListPlan(db, q, now));
}

// ------------------------------------------------------------------ DTOs

const compensationSummaryDto = z.strictObject({
  status: z.enum(SALARY_STATUSES),
  min: z.number().nullable(),
  max: z.number().nullable(),
  currency: z.string().nullable(),
  period: z.enum(PAY_PERIODS).nullable(),
  basis: z.string(),
  annualized: z.strictObject({ min: z.number().nullable(), max: z.number().nullable() }).nullable(),
  warnings: z.array(z.string().max(COMP_TEXT_MAX)).max(COMP_WARNINGS_MAX),
  originalText: z.string().max(COMP_TEXT_MAX).nullable(),
});

const jobWire = jobDto.shape as Record<string, z.ZodType>;
export const jobSummaryDto = z.strictObject({
  _id: z.string(),
  companyId: z.string(),
  companyName: z.string().nullable(),
  status: z.enum(['active', 'merged']),
  mergedInto: z.string().optional(),
  identity: z.strictObject({
    title: summaryFactDto(z.string()),
    seniority: summaryFactDto(z.enum(SENIORITY_LEVELS)),
  }),
  employment: z.strictObject({ employmentType: summaryFactDto(z.enum(EMPLOYMENT_TYPES)) }),
  geography: z.strictObject({
    listedLocations: z.array(z.string()).max(3),
    locationCount: z.number().int().min(0),
    countries: z.array(z.string().length(2)),
    workModel: summaryFactDto(z.enum(WORK_MODELS)),
    remoteScope: summaryFactDto(remoteScopeSchema),
  }),
  immigration: z.strictObject({
    sponsorship: summaryFactDto(sponsorshipSchema),
    authorization: summaryFactDto(authorizationSchema),
    relocation: summaryFactDto(z.enum(RELOCATION_STATUSES)),
  }),
  compensation: summaryFactDto(compensationSummaryDto),
  postingUrl: z.string().nullable(),
  lifecycle: z.strictObject({
    state: z.enum(JOB_STATES),
    firstSeenAt: isoDateTime,
    lastSeenAt: isoDateTime,
    publishedAt: isoDateTime.optional(),
    lastChangedAt: isoDateTime.optional(),
    closedAt: isoDateTime.optional(),
    closeReason: z.string().optional(),
  }),
  verification: jobWire.verification!,
  flags: z.array(z.strictObject({ code: z.string(), severity: z.enum(['info', 'warning', 'high']) })),
  quality: z.strictObject({ conflictFields: z.array(z.string()), sourceCount: z.number().int().min(0) }),
  openReviewCount: z.number().int().min(0),
  providers: z.array(z.string()),
  hiddenByProvider: z.boolean(),
  rev: z.number().int().min(0),
  contentHash: z.string(),
  factsHash: z.string().regex(/^[0-9a-f]{64}$/),
  interpretation: z.strictObject({
    logicVersion: z.string(),
    policyVersion: z.string(),
    taxonomyVersion: z.string(),
  }),
  updatedAt: isoDateTime,
});

export const jobListSummaryResponseDto = listPageDto(jobSummaryDto);
