import type { Db, Document, Filter } from 'mongodb';
import { z } from 'zod';
import {
  CAREERS_DISCOVERY_STATUSES,
  type CompanyDoc,
  companiesCollection,
} from '../companies/company.schema';
import { registrableDomain, strictNameKey } from '../companies/normalize';
import { atsRefSchema, locationSchema } from '../contracts/common';
import { jobsCollection } from '../jobs/job.schema';
import { escapeRegex } from '../sources/source.service';
import { companyDto, listPageDto } from './dto';
import {
  ACTIVE_JOB_MATCH,
  activeJobCompanyIds,
  activeJobStages,
  idSemiJoin,
  openReviewCounts,
  openReviewEntityIds,
  type SemiJoin,
  csvParam,
  dateParam,
  dateRange,
  explainList,
  type ListPage,
  type ListPlan,
  listPageShape,
  refinePaging,
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

// ------------------------------------------------------------------ query (M7.2)

/** Sort keys of `GET /api/companies` (each backed by a `list_*` index on `market_companies`). */
export const COMPANY_SORTS = {
  name: [['identity.normalizedName', 1]],
  createdAt: [['createdAt', 1]],
  lastChangedAt: [['freshness.lastChangedAt', 1]],
} as const satisfies SortOptions;
export type CompanySort = keyof typeof COMPANY_SORTS;

/** Company capability (`employment.sponsorship.capability.value`); `none` = no capability known. */
export const LICENCE_STATUSES = ['licensed', 'previously_licensed', 'none'] as const;

/**
 * `GET /api/companies` (v2, a superset of v1). Multi-value parameters take `a,b` or repeated
 * keys. Unknown parameters are 400.
 */
export const companyListQuerySchema = z
  .strictObject({
    ...listPageShape,
    view: viewParam,
    sort: sortParam(Object.keys(COMPANY_SORTS) as CompanySort[], 'name'),
    q: searchParam.min(1).optional(),
    sponsorCountry: csvParam(countryParam).optional(),
    careersStatus: csvParam(z.enum(CAREERS_DISCOVERY_STATUSES)).optional(),
    licenceStatus: csvParam(z.enum(LICENCE_STATUSES)).optional(),
    hasDomain: boolParam,
    hasConflicts: boolParam,
    hasActiveJobs: boolParam,
    hasOpenReviews: boolParam,
    sourceId: csvParam(idParam).optional(),
    changedAfter: dateParam.optional(),
    changedBefore: dateParam.optional(),
    createdAfter: dateParam.optional(),
    createdBefore: dateParam.optional(),
  })
  .superRefine(refinePaging);
export type CompanyListQuery = z.infer<typeof companyListQuerySchema>;

export const companyDetailQuerySchema = z.strictObject({ view: viewParam });

// ------------------------------------------------------------------ summary view

export interface CompanyListSummary {
  _id: string;
  status: CompanyDoc['status'];
  mergedInto?: string;
  identity: {
    displayName: SummaryFact<string>;
    legalName: SummaryFact<string>;
    normalizedName: string;
    domain: SummaryFact<string>;
    website: SummaryFact<string>;
    /** Up to 20 alias names (the full list is on the record). */
    aliases: string[];
  };
  geography: { headquarters: SummaryFact<z.infer<typeof locationSchema>> };
  employment: {
    careersUrls: SummaryFact<string[]>;
    ats: SummaryFact<Array<z.infer<typeof atsRefSchema>>>;
    sponsorship: {
      capability: SummaryFact<'licensed' | 'previously_licensed'>;
      licenceCountries: string[];
    };
  };
  quality: {
    observationCount: number;
    sourceCount: number;
    conflictFields: string[];
  };
  freshness: {
    careersDiscoveryStatus: CompanyDoc['freshness']['careersDiscoveryStatus'];
    careersCheckedAt?: Date;
    lastChangedAt?: Date;
    lastReconciledAt?: Date;
  };
  /** Live count of the company's jobs that are active and not CLOSED. */
  activeJobCount: number;
  /** Live count of open review items naming the company (entity or candidate). */
  openReviewCount: number;
  /** Revision of the reconciled state (0 before the first fenced write); pin joins to it. */
  rev: number;
  /**
   * Hash of the reconciled content (`reconciliation.contentHash`); `null` until the company's first
   * reconciliation (then only `rev` + `factsHash` pin the row).
   */
  contentHash: string | null;
  /** Version pin of every summary fact (value, status, confidence; `factsHash`). */
  factsHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export const COMPANY_SUMMARY_FACTS = [
  'identity.displayName',
  'identity.legalName',
  'identity.domain',
  'identity.website',
  'geography.headquarters',
  'employment.careersUrls',
  'employment.ats',
  'employment.sponsorship.capability',
];

export const companySummaryProjection: Document = {
  status: 1,
  mergedInto: 1,
  'identity.normalizedName': 1,
  'identity.aliases.name': 1,
  'employment.sponsorship.licenceCountries': 1,
  'quality.observationCount': 1,
  'quality.sourceIds': 1,
  'quality.conflictFields': 1,
  freshness: 1,
  rev: 1,
  'reconciliation.contentHash': 1,
  createdAt: 1,
  updatedAt: 1,
  ...Object.assign({}, ...COMPANY_SUMMARY_FACTS.map(factProjection)),
};

export function toCompanySummary(
  c: CompanyDoc,
  live: { activeJobCount: number; openReviewCount: number },
): CompanyListSummary {
  return {
    _id: c._id,
    status: c.status,
    ...(c.mergedInto ? { mergedInto: c.mergedInto } : {}),
    identity: {
      displayName: summaryFact(c.identity.displayName),
      legalName: summaryFact(c.identity.legalName),
      normalizedName: c.identity.normalizedName,
      domain: summaryFact(c.identity.domain),
      website: summaryFact(c.identity.website),
      aliases: (c.identity.aliases ?? []).slice(0, 20).map((a) => a.name),
    },
    geography: { headquarters: summaryFact(c.geography.headquarters) },
    employment: {
      careersUrls: summaryFact(c.employment.careersUrls),
      ats: summaryFact(c.employment.ats),
      sponsorship: {
        capability: summaryFact(c.employment.sponsorship.capability),
        licenceCountries: c.employment.sponsorship.licenceCountries ?? [],
      },
    },
    quality: {
      observationCount: c.quality.observationCount,
      sourceCount: (c.quality.sourceIds ?? []).length,
      conflictFields: c.quality.conflictFields ?? [],
    },
    freshness: {
      careersDiscoveryStatus: c.freshness?.careersDiscoveryStatus ?? 'not_attempted',
      ...(c.freshness?.careersCheckedAt ? { careersCheckedAt: c.freshness.careersCheckedAt } : {}),
      ...(c.freshness?.lastChangedAt ? { lastChangedAt: c.freshness.lastChangedAt } : {}),
      ...(c.freshness?.lastReconciledAt ? { lastReconciledAt: c.freshness.lastReconciledAt } : {}),
    },
    activeJobCount: live.activeJobCount,
    openReviewCount: live.openReviewCount,
    rev: c.rev ?? 0,
    contentHash: c.reconciliation?.contentHash ?? null,
    factsHash: factsHash(c, COMPANY_SUMMARY_FACTS),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/**
 * Live active-job counts of a set of companies: covered by `by_company_state` (hinted: the
 * companyId-first `list_company_seen` would fetch every job to read its state).
 */
export async function activeJobCounts(db: Db, companyIds: string[]): Promise<Map<string, number>> {
  if (!companyIds.length) return new Map();
  const rows = await db
    .collection(jobsCollection.name)
    .aggregate<{ _id: string; n: number }>(activeJobCountsPipeline(companyIds), { hint: 'by_company_state' })
    .toArray();
  return new Map(rows.map((r) => [r._id, r.n]));
}

/** Summary rows of a page of companies: live active-job and open-review counts, one batched query each. */
export function activeJobCountsPipeline(companyIds: string[]): Document[] {
  return [
    { $match: { companyId: { $in: companyIds }, ...ACTIVE_JOB_MATCH } },
    { $project: { _id: 0, companyId: 1 } },
    { $group: { _id: '$companyId', n: { $sum: 1 } } },
  ];
}

export async function companySummaries(db: Db, docs: CompanyDoc[]): Promise<CompanyListSummary[]> {
  const ids = docs.map((d) => d._id);
  const [jobs, reviews] = await Promise.all([activeJobCounts(db, ids), openReviewCounts(db, 'company', ids)]);
  return docs.map((d) =>
    toCompanySummary(d, { activeJobCount: jobs.get(d._id) ?? 0, openReviewCount: reviews.get(d._id) ?? 0 }),
  );
}

// ------------------------------------------------------------------ list

/**
 * Prefix search over the strict name key, alias keys and the domain — each an anchored regex on
 * an index (`list_name`, `by_alias`, `by_domain`), never an unanchored collection scan.
 */
export function companySearchFilter(q: string): Filter<Document> {
  const branches: Document[] = [];
  const key = strictNameKey(q);
  if (key) {
    const re = { $regex: `^${escapeRegex(key)}` };
    branches.push({ 'identity.normalizedName': re }, { 'identity.aliases.strictKey': re });
  }
  if (!/\s/.test(q.trim())) {
    const host = q
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .replace(/^www\./, '')
      .split(/[/?#]/)[0];
    const domain = host && host.includes('.') ? (registrableDomain(host) ?? host) : host;
    if (domain) branches.push({ 'identity.domain.value': { $regex: `^${escapeRegex(domain)}` } });
  }
  return branches.length ? { $or: branches } : { _id: { $exists: false } };
}

export async function companyListPlan(db: Db, q: CompanyListQuery): Promise<ListPlan> {
  const and: Filter<Document>[] = [{ status: 'active' }];
  if (q.q) and.push(companySearchFilter(q.q));
  if (q.sponsorCountry) and.push({ 'employment.sponsorship.licenceCountries': { $in: q.sponsorCountry } });
  if (q.careersStatus) and.push({ 'freshness.careersDiscoveryStatus': { $in: q.careersStatus } });
  if (q.licenceStatus)
    and.push({
      'employment.sponsorship.capability.value': {
        $in: q.licenceStatus.map((s) => (s === 'none' ? null : s)),
      },
    });
  if (q.hasDomain !== undefined)
    and.push({ 'identity.domain.value': q.hasDomain ? { $type: 'string' } : null });
  if (q.hasConflicts !== undefined) and.push({ 'quality.conflictFields.0': { $exists: q.hasConflicts } });
  if (q.sourceId) and.push({ 'quality.sourceIds': { $in: q.sourceId } });
  const changed = dateRange(q.changedAfter, q.changedBefore);
  if (changed) and.push({ 'freshness.lastChangedAt': changed });
  const created = dateRange(q.createdAfter, q.createdBefore);
  if (created) and.push({ createdAt: created });
  const joins: SemiJoin[] = [];
  if (q.hasActiveJobs !== undefined) {
    const has = q.hasActiveJobs;
    joins.push(idSemiJoin(await activeJobCompanyIds(db), has, () => activeJobStages(has)));
  }
  if (q.hasOpenReviews !== undefined) {
    const has = q.hasOpenReviews;
    joins.push(
      idSemiJoin(await openReviewEntityIds(db, 'company'), has, () => openReviewStages('company', has)),
    );
  }
  for (const j of joins) if (j.match) and.push(j.match);
  return {
    match: and.length === 1 ? and[0]! : { $and: and },
    semiJoins: joins.flatMap((j) => j.stages ?? []),
    defaultCount: joins.length ? 'none' : 'exact',
    projection: q.view === 'summary' ? companySummaryProjection : undefined,
    sort: q.sort,
    fields: sortFields(COMPANY_SORTS, q.sort),
    limit: q.limit,
    offset: q.offset,
    after: q.after,
    count: q.count,
  };
}

/** `GET /api/companies`: full documents (v1 shape) or summaries (`view=summary`). */
export async function listCompanies(
  db: Db,
  q: CompanyListQuery,
): Promise<ListPage<CompanyDoc> | ListPage<CompanyListSummary>> {
  const page = await runList(
    db.collection<CompanyDoc>(companiesCollection.name),
    await companyListPlan(db, q),
  );
  if (q.view !== 'summary') return page;
  return { ...page, items: await companySummaries(db, page.items) };
}

export async function explainCompanyList(db: Db, q: CompanyListQuery): Promise<Document> {
  return explainList(db.collection<CompanyDoc>(companiesCollection.name), await companyListPlan(db, q));
}

// ------------------------------------------------------------------ DTOs

const locationDto = locationSchema;
export const companySummaryDto = z.strictObject({
  _id: z.string(),
  status: z.enum(['active', 'merged']),
  mergedInto: z.string().optional(),
  identity: z.strictObject({
    displayName: summaryFactDto(z.string()),
    legalName: summaryFactDto(z.string()),
    normalizedName: z.string(),
    domain: summaryFactDto(z.string()),
    website: summaryFactDto(z.string()),
    aliases: z.array(z.string()).max(20),
  }),
  geography: z.strictObject({ headquarters: summaryFactDto(locationDto) }),
  employment: z.strictObject({
    careersUrls: summaryFactDto(z.array(z.string())),
    ats: summaryFactDto(z.array(atsRefSchema)),
    sponsorship: z.strictObject({
      capability: summaryFactDto(z.enum(['licensed', 'previously_licensed'])),
      licenceCountries: z.array(z.string()),
    }),
  }),
  quality: z.strictObject({
    observationCount: z.number().int(),
    sourceCount: z.number().int(),
    conflictFields: z.array(z.string()),
  }),
  freshness: z.strictObject({
    careersDiscoveryStatus: z.enum(CAREERS_DISCOVERY_STATUSES),
    careersCheckedAt: isoDateTime.optional(),
    lastChangedAt: isoDateTime.optional(),
    lastReconciledAt: isoDateTime.optional(),
  }),
  activeJobCount: z.number().int().min(0),
  openReviewCount: z.number().int().min(0),
  rev: z.number().int().min(0),
  contentHash: z.string().nullable(),
  factsHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

export const companyListFullResponseDto = listPageDto(companyDto);
export const companyListSummaryResponseDto = listPageDto(companySummaryDto);
