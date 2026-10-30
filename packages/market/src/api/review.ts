import type { Db, Document, Filter } from 'mongodb';
import { z } from 'zod';
import type { Fact } from '@aptamind/provenance';
import { type CompanyDoc, companiesCollection } from '../companies/company.schema';
import { EMPLOYMENT_TYPES, RELOCATION_STATUSES, WORK_MODELS } from '../contracts/employment';
import { type JobDoc, jobsCollection } from '../jobs/job.schema';
import type { MarketDomain } from '../market-domain';
import { COMPANY_CORRECTABLE, EFFECT_ACTIONS, JOB_OVERRIDABLE } from '../review/review.service';
import { withoutExpiredAssignment } from '../review/triage';
import {
  REVIEW_TYPES,
  type ReviewAction,
  type ReviewItemDoc,
  reviewItemsCollection,
} from '../review/schemas';
import {
  csvParam,
  dateParam,
  dateRange,
  explainList,
  type ListPage,
  type ListPlan,
  listPageShape,
  refinePaging,
  runList,
  sortFields,
  type SortOptions,
  valueAt,
} from './list';
import { boolParam, idParam, reviewStatusParam } from './query';
import { factProjection, type SummaryFact, summaryFact } from './summary';

// ------------------------------------------------------------------ query (M7.5)

/**
 * Sort keys of `GET /api/review`. `priority` = highest priority first, oldest first within a
 * priority (the v1 open-queue order); `-priority` reverses it.
 */
export const REVIEW_SORTS = {
  priority: [
    ['priority', -1],
    ['createdAt', 1],
  ],
  createdAt: [['createdAt', 1]],
  updatedAt: [['updatedAt', 1]],
} as const satisfies SortOptions;
type ReviewSort = keyof typeof REVIEW_SORTS;
const REVIEW_SORT_VALUES = (Object.keys(REVIEW_SORTS) as ReviewSort[]).flatMap((k) => [k, `-${k}`]) as [
  string,
  ...string[],
];

export const REVIEW_SEVERITIES = ['low', 'medium', 'high'] as const;
export const REVIEW_ENTITY_KINDS = ['company', 'job', 'observation', 'source'] as const;

/** `GET /api/review` (v2, a superset of v1). */
export const reviewListQuerySchema = z
  .strictObject({
    ...listPageShape,
    /** Default: `priority` for `open`/`all`, `-updatedAt` for `resolved`/`dismissed` (v1 orders). */
    sort: z.enum(REVIEW_SORT_VALUES).optional(),
    facets: boolParam,
    status: reviewStatusParam,
    type: csvParam(z.enum(REVIEW_TYPES)).optional(),
    severity: csvParam(z.enum(REVIEW_SEVERITIES)).optional(),
    entityKind: csvParam(z.enum(REVIEW_ENTITY_KINDS)).optional(),
    entityId: idParam.optional(),
    scopeId: idParam.optional(),
    resolving: boolParam,
    hasFailure: boolParam,
    /** A live triage claim (API-9): `assignment` set and not expired. */
    claimed: boolParam,
    createdAfter: dateParam.optional(),
    createdBefore: dateParam.optional(),
    /**
     * `actions`: also compute `supportedActions` per row (read-only probes against the resolver;
     * bounded concurrency). Without it, list rows carry no `supportedActions` (the detail always does).
     */
    include: csvParam(z.enum(['actions'])).optional(),
  })
  .superRefine(refinePaging);
export type ReviewListQuery = z.infer<typeof reviewListQuerySchema>;

// ------------------------------------------------------------------ server-computed item fields

/** Where an item is in its life (the review contract's item states). */
export const REVIEW_QUEUE_STATES = ['open', 'resolving', 'failed', 'resolved', 'dismissed'] as const;
export type ReviewQueueState = (typeof REVIEW_QUEUE_STATES)[number];

export function reviewQueueState(item: ReviewItemDoc): ReviewQueueState {
  if (item.status !== 'open') return item.status;
  if (item.claim) return 'resolving';
  if (item.lastFailure) return 'failed';
  return 'open';
}

/** A field a `correct` decision may set, with what the UI needs to build a typed editor. */
export interface CorrectableField {
  /** The `field` to send with `action: correct`. */
  field: string;
  /** Path of the fact on the entity (e.g. `geography.workModel`). */
  path: string;
  /** `enum`: one of `values`; `string`: non-empty text; `object`: the full value shape named by `schema`. */
  type: 'enum' | 'string' | 'object';
  values?: readonly string[];
  /** The value shape of an `object` field (market-provenance contract, employment enums). */
  schema?: 'remoteScope' | 'sponsorship' | 'compensation';
  /** The review is about this field (derived from the item's flag / conflict fields). */
  targeted: boolean;
  /**
   * The fact's current canonical state as a `SummaryFact` (value, status, confidence, basis,
   * alternates): `value` is `null` when unknown, `status` says whether it is unknown or conflicting.
   */
  current: SummaryFact<unknown>;
}

type JobFieldSpec = Omit<CorrectableField, 'field' | 'targeted' | 'current'>;
/** The job fields `correct` accepts (keys = `JOB_OVERRIDABLE`). */
export const JOB_CORRECTABLE_FIELDS: Record<string, JobFieldSpec> = {
  workModel: { path: 'geography.workModel', type: 'enum', values: WORK_MODELS },
  remoteScope: { path: 'geography.remoteScope', type: 'object', schema: 'remoteScope' },
  sponsorship: { path: 'immigration.sponsorship', type: 'object', schema: 'sponsorship' },
  relocation: { path: 'immigration.relocation', type: 'enum', values: RELOCATION_STATUSES },
  compensation: { path: 'compensation', type: 'object', schema: 'compensation' },
  employmentType: { path: 'employment.employmentType', type: 'enum', values: EMPLOYMENT_TYPES },
};

const PATH_TO_JOB_FIELD = new Map(Object.entries(JOB_CORRECTABLE_FIELDS).map(([f, s]) => [s.path, f]));

/** Which correctable fields the item is about (derived server-side; the UI no longer guesses). */
export function reviewTargetFields(item: ReviewItemDoc): string[] {
  const ctx = item.context ?? {};
  if (item.type === 'salary_suspicious') return ['compensation'];
  if (item.type === 'employment_conflict') {
    const flag = typeof ctx.flag === 'string' ? ctx.flag : '';
    if (flag.startsWith('work_model')) return ['workModel'];
    if (flag.startsWith('remote')) return ['remoteScope'];
    if (flag.startsWith('sponsor')) return ['sponsorship'];
    if (flag.startsWith('compensation') || flag.startsWith('salary')) return ['compensation'];
    if (flag.startsWith('employment_type')) return ['employmentType'];
    if (flag.startsWith('relocation')) return ['relocation'];
    return [];
  }
  if (item.type === 'field_conflict') {
    if (item.entity.kind === 'company')
      return typeof ctx.field === 'string' && COMPANY_CORRECTABLE.has(ctx.field) ? [ctx.field] : [];
    const fields = Array.isArray(ctx.fields) ? ctx.fields : [];
    return fields.flatMap((p) =>
      typeof p === 'string' && PATH_TO_JOB_FIELD.has(p) ? [PATH_TO_JOB_FIELD.get(p)!] : [],
    );
  }
  return [];
}

function currentFact(entity: object, path: string): SummaryFact<unknown> {
  return summaryFact(valueAt(entity, path) as Parameters<typeof summaryFact>[0]);
}

/** The correctable fields of an item's entity, targeted fields first. Empty when `correct` does not apply. */
export function reviewCorrectable(
  item: ReviewItemDoc,
  entity: Partial<JobDoc> | Partial<CompanyDoc> | null,
): CorrectableField[] {
  if (!entity || !EFFECT_ACTIONS[item.type].includes('correct') || !item.allowedActions.includes('correct'))
    return [];
  const targets = new Set(reviewTargetFields(item));
  let fields: CorrectableField[] = [];
  if (item.entity.kind === 'job')
    fields = Object.entries(JOB_CORRECTABLE_FIELDS)
      .filter(([f]) => JOB_OVERRIDABLE.has(f))
      .map(([field, spec]) => ({
        field,
        ...spec,
        targeted: targets.has(field),
        current: currentFact(entity, spec.path),
      }));
  else if (item.entity.kind === 'company')
    fields = [...COMPANY_CORRECTABLE].map((field) => ({
      field,
      path: field,
      type: 'string' as const,
      targeted: targets.has(field),
      current: currentFact(entity, field),
    }));
  return fields.sort((a, b) => Number(b.targeted) - Number(a.targeted));
}

/** A value a `correct` check can use for a field (its current value, else the first enum value). */
function probeValue(f: CorrectableField): unknown {
  if (f.current.value !== null && f.current.value !== undefined) return f.current.value;
  if (f.type === 'enum') return f.values?.[0];
  if (f.type === 'string') return 'example.com';
  return undefined;
}

/**
 * The actions `POST /api/review/:id/resolve` accepts for this item now (⊆ `allowedActions`),
 * as **probes**: each candidate decision is run through the resolver's own validation
 * (read-only). An action is listed when one probe passed — a targeted action (`merge`,
 * `keep_separate`) when at least one existing candidate is a valid target, `correct` when at least
 * one correctable field accepts a probe value (its current value, else the first enum value). It
 * does not promise that every target or value is accepted; `resolve` validates the actual decision.
 * Empty for closed or resolving items.
 *
 * `existing`, when given, is the set of candidate ids known to exist (prefetched for a page in one
 * `$in` per kind): other candidates are not probed.
 */
export async function reviewSupportedActions(
  market: MarketDomain,
  item: ReviewItemDoc,
  correctable: CorrectableField[],
  existing?: ReadonlySet<string>,
): Promise<ReviewAction[]> {
  if (item.status !== 'open' || item.claim) return [];
  const effect = new Set<ReviewAction>(['confirm', 'dismiss', ...EFFECT_ACTIONS[item.type]]);
  const out: ReviewAction[] = [];
  const candidates = item.candidates.filter((c) => !existing || existing.has(c.id)).slice(0, 5);
  for (const action of item.allowedActions.filter((a) => effect.has(a))) {
    let ok = false;
    if (action === 'merge' || action === 'keep_separate') {
      for (const c of candidates)
        if (await market.reviewService.accepts(item, { action, targetId: c.id })) {
          ok = true;
          break;
        }
    } else if (action === 'correct') {
      for (const f of correctable) {
        const value = probeValue(f);
        if (value === undefined) continue;
        if (await market.reviewService.accepts(item, { action, field: f.field, value: value as never })) {
          ok = true;
          break;
        }
      }
    } else ok = await market.reviewService.accepts(item, { action });
    if (ok) out.push(action);
  }
  return out;
}

export type ReviewListItem = ReviewItemDoc & {
  queueState: ReviewQueueState;
  /**
   * What `resolve` accepts now (probes; see `reviewSupportedActions`). Absent on list rows unless
   * `include=actions`; `null` when the probes failed transiently (retry the request).
   */
  supportedActions?: ReviewAction[] | null;
  correctable: CorrectableField[];
  targetFields: string[];
};

const JOB_CORRECTABLE_PROJECTION = Object.assign(
  {},
  ...Object.values(JOB_CORRECTABLE_FIELDS).map((s) => factProjection(s.path)),
) as Record<string, 1>;
const COMPANY_CORRECTABLE_PROJECTION = Object.assign(
  {},
  ...[...COMPANY_CORRECTABLE].map((f) => factProjection(f)),
) as Record<string, 1>;

/** Items probed concurrently for `supportedActions` on a list page (each probe is a few indexed reads). */
export const SUPPORTED_ACTIONS_CONCURRENCY = 4;

async function mapLimit<T, R>(xs: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let next = 0;
  const worker = async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, xs.length)) }, worker));
  return out;
}

/** Ids of the candidates of `items` that exist — one `$in` per kind. */
async function existingCandidates(market: MarketDomain, items: ReviewItemDoc[]): Promise<Set<string>> {
  const db = market.ctx.db;
  const lookup = async (kind: 'company' | 'job') => {
    const ids = [
      ...new Set(items.flatMap((i) => i.candidates.filter((c) => c.kind === kind).map((c) => c.id))),
    ];
    if (!ids.length) return [];
    return db
      .collection<{ _id: string }>(kind === 'company' ? companiesCollection.name : jobsCollection.name)
      .find({ _id: { $in: ids } }, { projection: { _id: 1 } })
      .toArray();
  };
  const [companies, jobs] = await Promise.all([lookup('company'), lookup('job')]);
  return new Set([...companies, ...jobs].map((d) => d._id));
}

/**
 * Add the server-computed fields to review items (entities loaded in two batched queries).
 * With `actions`, also `supportedActions`: candidates prefetched in one `$in` per kind, at most
 * `SUPPORTED_ACTIONS_CONCURRENCY` items probed at a time, and a transient probe failure degrades
 * that item only (`supportedActions: null`, logged) instead of failing the page.
 */
export async function enrichReviewItems(
  market: MarketDomain,
  items: ReviewItemDoc[],
  opts: { actions: boolean },
): Promise<ReviewListItem[]> {
  const db = market.ctx.db;
  const ids = (kind: string) => [
    ...new Set(items.filter((i) => i.entity.kind === kind).map((i) => i.entity.id)),
  ];
  const [jobs, companies, existing] = await Promise.all([
    db
      .collection<JobDoc>(jobsCollection.name)
      .find({ _id: { $in: ids('job') } }, { projection: JOB_CORRECTABLE_PROJECTION })
      .toArray(),
    db
      .collection<CompanyDoc>(companiesCollection.name)
      .find({ _id: { $in: ids('company') } }, { projection: COMPANY_CORRECTABLE_PROJECTION })
      .toArray(),
    opts.actions ? existingCandidates(market, items) : Promise.resolve(undefined),
  ]);
  const entities = new Map<string, Partial<JobDoc> | Partial<CompanyDoc>>([
    ...jobs.map((j) => [`job:${j._id}`, j] as const),
    ...companies.map((c) => [`company:${c._id}`, c] as const),
  ]);
  const now = market.ctx.clock.now();
  const rows = items.map((item): ReviewListItem => ({
    ...withoutExpiredAssignment(item, now),
    queueState: reviewQueueState(item),
    correctable: reviewCorrectable(item, entities.get(`${item.entity.kind}:${item.entity.id}`) ?? null),
    targetFields: reviewTargetFields(item),
  }));
  if (!opts.actions) return rows;
  await mapLimit(rows, SUPPORTED_ACTIONS_CONCURRENCY, async (row) => {
    try {
      row.supportedActions = await reviewSupportedActions(market, row, row.correctable, existing);
    } catch (err) {
      market.ctx.logger.warn(
        { reviewItemId: row._id, err: err instanceof Error ? err.message : String(err) },
        'supported-action probes failed; item degraded to supportedActions: null',
      );
      row.supportedActions = null;
    }
  });
  return rows;
}

// ------------------------------------------------------------------ list

function filterParts(q: ReviewListQuery, now: Date): Record<string, Filter<Document>> {
  const parts: Record<string, Filter<Document>> = {};
  if (q.status) parts.status = { status: q.status };
  if (q.type) parts.type = { type: { $in: q.type } };
  if (q.severity) parts.severity = { severity: { $in: q.severity } };
  if (q.entityKind) parts.entityKind = { 'entity.kind': { $in: q.entityKind } };
  if (q.entityId) parts.entityId = { $or: [{ 'entity.id': q.entityId }, { 'candidates.id': q.entityId }] };
  if (q.scopeId)
    parts.scopeId = {
      $or: [{ 'entity.id': q.scopeId }, { 'candidates.id': q.scopeId }, { 'context.sourceId': q.scopeId }],
    };
  if (q.resolving !== undefined)
    parts.resolving = { claim: q.resolving ? { $exists: true } : { $exists: false } };
  if (q.hasFailure !== undefined)
    parts.hasFailure = { lastFailure: q.hasFailure ? { $exists: true } : { $exists: false } };
  if (q.claimed !== undefined)
    parts.claimed = q.claimed
      ? { status: 'open', 'assignment.expiresAt': { $gt: now } }
      : {
          $or: [
            { status: { $ne: 'open' } },
            { assignment: { $exists: false } },
            { 'assignment.expiresAt': { $lte: now } },
          ],
        };
  const created = dateRange(q.createdAfter, q.createdBefore);
  if (created) parts.created = { createdAt: created };
  return parts;
}

const andOf = (parts: Filter<Document>[]): Filter<Document> =>
  parts.length === 0 ? {} : parts.length === 1 ? parts[0]! : { $and: parts };

export function reviewSort(q: ReviewListQuery): string {
  return q.sort ?? (q.status === 'resolved' || q.status === 'dismissed' ? '-updatedAt' : 'priority');
}

export function reviewListPlan(q: ReviewListQuery, now: Date = new Date()): ListPlan {
  const sort = reviewSort(q);
  return {
    match: andOf(Object.values(filterParts(q, now))),
    sort,
    fields: sortFields(REVIEW_SORTS, sort),
    limit: q.limit,
    offset: q.offset,
    after: q.after,
    count: q.count,
  };
}

export interface ReviewFacets {
  type: Partial<Record<(typeof REVIEW_TYPES)[number], number>>;
  severity: Partial<Record<(typeof REVIEW_SEVERITIES)[number], number>>;
}

/** Counts by type and by severity; each facet ignores its own filter (the other filters apply). */
async function reviewFacets(db: Db, q: ReviewListQuery, now: Date): Promise<ReviewFacets> {
  const parts = filterParts(q, now);
  const col = db.collection(reviewItemsCollection.name);
  const count = async (dim: 'type' | 'severity') => {
    const others = Object.entries(parts)
      .filter(([k]) => k !== dim)
      .map(([, f]) => f);
    const rows = await col
      .aggregate<{ _id: string; n: number }>([
        { $match: andOf(others) },
        { $group: { _id: `$${dim}`, n: { $sum: 1 } } },
      ])
      .toArray();
    return Object.fromEntries(rows.map((r) => [r._id, r.n]));
  };
  const [type, severity] = await Promise.all([count('type'), count('severity')]);
  return { type, severity };
}

/**
 * `GET /api/review`: items with server-computed queue state and correctable fields, optional
 * facets; `supportedActions` only with `include=actions`.
 */
export async function listReviews(
  market: MarketDomain,
  q: ReviewListQuery,
): Promise<ListPage<ReviewListItem> & { facets?: ReviewFacets }> {
  const db = market.ctx.db;
  const now = market.ctx.clock.now();
  const [page, facets] = await Promise.all([
    runList(db.collection<ReviewItemDoc>(reviewItemsCollection.name), reviewListPlan(q, now)),
    q.facets ? reviewFacets(db, q, now) : Promise.resolve(undefined),
  ]);
  const items = await enrichReviewItems(market, page.items, { actions: !!q.include?.includes('actions') });
  return { ...page, items, ...(facets ? { facets } : {}) };
}

export function explainReviewList(db: Db, q: ReviewListQuery): Promise<Document> {
  return explainList(db.collection<ReviewItemDoc>(reviewItemsCollection.name), reviewListPlan(q));
}

/** The targeted facts of an item's entity, in full (evidence, conflicts), for the review detail. */
export function reviewTargetedFacts(
  item: ReviewListItem,
  entity: JobDoc | CompanyDoc | null,
): Array<{ field: string; path: string; fact: Fact<unknown> | null }> {
  return item.correctable
    .filter((c) => c.targeted)
    .map((c) => ({
      field: c.field,
      path: c.path,
      fact: (valueAt(entity, c.path) as Fact<unknown> | null) ?? null,
    }));
}
