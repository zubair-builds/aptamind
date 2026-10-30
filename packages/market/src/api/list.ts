import type { Collection, Db, Document, Filter } from 'mongodb';
import { z } from 'zod';
import { AppError } from '@aptamind/contracts';
import { limitParam, offsetParam } from './query';

/**
 * List v2 machinery shared by the Market list endpoints (M7.2–M7.5):
 *
 *   - a whitelisted `sort` (one named key, ascending or `-`descending) whose fields are backed by
 *     an index, always tie-broken on `_id` in the direction of the last field, so the order is
 *     total and stable;
 *   - keyset pagination: `after=<cursor>` resumes strictly after the last row of the previous
 *     page (sort values + `_id`), so concurrent inserts never duplicate or skip rows that
 *     existed when the traversal started; `offset` stays for v1 clients (not with `after`);
 *   - `count=exact|none` (the total is a second query; `none` skips it);
 *   - live semi-join filters (`$lookup` with `$limit: 1`) for "has active jobs" / "has open
 *     reviews" style questions, evaluated in sort order and stopped at the page limit.
 */

export type SortDir = 1 | -1;
/** One sort option: the document paths it orders by (the `_id` tiebreak is implicit). */
export type SortFields = ReadonlyArray<readonly [path: string, dir: SortDir]>;
export type SortOptions = Record<string, SortFields>;

/** `sort` values accepted for a set of named sort keys: `key` (ascending) and `-key`. */
export function sortParam<const K extends string>(keys: readonly K[], defaultSort: K | `-${K}`) {
  const values = keys.flatMap((k) => [k, `-${k}`]) as [K | `-${K}`, ...Array<K | `-${K}`>];
  return z.enum(values).default(defaultSort as never);
}

/** Resolve a `sort` value to its fields (a `-` prefix reverses every field of the option). */
export function sortFields(options: SortOptions, sort: string): SortFields {
  const desc = sort.startsWith('-');
  const base = options[desc ? sort.slice(1) : sort];
  if (!base) throw new AppError('validation_failed', `Unsupported sort ${sort}`);
  return desc ? base.map(([p, d]) => [p, (d * -1) as SortDir] as const) : base;
}

export function mongoSort(fields: SortFields): Record<string, SortDir> {
  const sort: Record<string, SortDir> = {};
  for (const [p, d] of fields) sort[p] = d;
  sort._id = fields[fields.length - 1]?.[1] ?? 1;
  return sort;
}

// ------------------------------------------------------------------ cursor

/** Longest `after` value accepted (and issued: every cursor we issue fits, see `encodeCursor`). */
export const CURSOR_MAX = 2000;

type CursorValue = string | number | boolean | null | { $d: string };
interface CursorPayload {
  /** The sort value the cursor was issued for. */
  s: string;
  /** Sort field values of the last row (absent in a reference cursor). */
  v?: CursorValue[];
  id: string;
  /** Reference cursor: the sort values are re-read from the row `id` when it is used. */
  r?: 1;
}

/** A decoded cursor: the keyset position, or (reference cursor) only the row to read it from. */
export type DecodedCursor = { values: unknown[]; id: string } | { ref: true; id: string };

const b64 = (p: CursorPayload) => Buffer.from(JSON.stringify(p)).toString('base64url');

/**
 * The cursor of the row after which the next page starts. It carries the row's sort values —
 * unless they would make it longer than `CURSOR_MAX` (a very long name or title), then it is a
 * **reference cursor** (sort + `_id`, always short) whose values are re-read from that row when it
 * is used. Either way the cursor we issue is always accepted.
 */
export function encodeCursor(sort: string, values: unknown[], id: string): string {
  const full = b64({
    s: sort,
    v: values.map((v) => (v instanceof Date ? { $d: v.toISOString() } : ((v ?? null) as CursorValue))),
    id,
  });
  return full.length <= CURSOR_MAX ? full : b64({ s: sort, id, r: 1 });
}

export function decodeCursor(raw: string, sort: string, arity: number): DecodedCursor {
  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as CursorPayload;
  } catch {
    throw new AppError('validation_failed', 'Malformed cursor', { param: 'after' });
  }
  if (!payload || typeof payload.id !== 'string' || typeof payload.s !== 'string')
    throw new AppError('validation_failed', 'Malformed cursor', { param: 'after' });
  if (payload.s !== sort)
    throw new AppError('validation_failed', `Cursor was issued for sort ${payload.s}, not ${sort}`, {
      param: 'after',
    });
  if (payload.r === 1 && payload.v === undefined) return { ref: true, id: payload.id };
  if (!Array.isArray(payload.v) || payload.v.length !== arity)
    throw new AppError('validation_failed', 'Malformed cursor', { param: 'after' });
  const values = payload.v.map((v) => {
    if (v && typeof v === 'object' && typeof (v as { $d?: unknown }).$d === 'string') {
      const d = new Date((v as { $d: string }).$d);
      if (Number.isNaN(d.getTime()))
        throw new AppError('validation_failed', 'Malformed cursor', { param: 'after' });
      return d;
    }
    if (v !== null && !['string', 'number', 'boolean'].includes(typeof v))
      throw new AppError('validation_failed', 'Malformed cursor', { param: 'after' });
    return v;
  });
  return { values, id: payload.id };
}

/**
 * The keyset position of `plan.after`: decoded from the cursor, or — for a reference cursor —
 * read from its row (the row's current sort values). A reference to a row that no longer exists
 * is a 400 (Market list rows are never deleted: merged records stay as `status: merged`).
 */
export async function resolveCursor<T extends Document>(
  col: Collection<T>,
  plan: Pick<ListPlan, 'after' | 'sort' | 'fields'>,
): Promise<{ values: unknown[]; id: string } | undefined> {
  if (!plan.after) return undefined;
  const c = decodeCursor(plan.after, plan.sort, plan.fields.length);
  if (!('ref' in c)) return c;
  const row = await col.findOne({ _id: c.id } as Filter<T>, {
    projection: Object.fromEntries(plan.fields.map(([p]) => [p, 1])),
  });
  if (!row)
    throw new AppError('validation_failed', 'The cursor row no longer exists; restart from the first page', {
      param: 'after',
    });
  return { values: plan.fields.map(([p]) => valueAt(row, p)), id: c.id };
}

/**
 * Rows strictly after (values, id) in the order of `fields` + `_id`. Missing/null values sort
 * first ascending and last descending (MongoDB order), and `{ path: null }` matches both.
 */
export function keysetFilter(fields: SortFields, values: unknown[], id: string): Filter<Document> {
  const all: Array<readonly [string, SortDir, unknown]> = [
    ...fields.map(([p, d], i) => [p, d, values[i] ?? null] as const),
    ['_id', fields[fields.length - 1]?.[1] ?? 1, id] as const,
  ];
  const branches: Document[] = [];
  for (let i = 0; i < all.length; i++) {
    const [path, dir, v] = all[i]!;
    const prefix: Document = {};
    for (const [p, , pv] of all.slice(0, i)) prefix[p] = pv;
    let after: Document | null;
    if (v === null) after = dir === 1 ? { [path]: { $ne: null } } : null;
    else if (dir === 1) after = { [path]: { $gt: v } };
    else if (path === '_id') after = { _id: { $lt: v } };
    else after = { $or: [{ [path]: { $lt: v } }, { [path]: null }] };
    if (after) branches.push({ ...prefix, ...after });
  }
  return branches.length ? { $or: branches } : { _id: { $exists: false } };
}

/** Read a (dotted) path of a document. */
export function valueAt(doc: unknown, path: string): unknown {
  let cur: unknown = doc;
  for (const p of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur ?? null;
}

// ------------------------------------------------------------------ page parameters

export const cursorParam = z.string().min(1).max(CURSOR_MAX);
/** Absent = the endpoint's default: `exact`, or `none` when a live semi-join filter is present. */
export const countParam = z.enum(['exact', 'none']).optional();
export const viewParam = z.enum(['full', 'summary']).default('full');

/** Paging parameters of every list v2 endpoint. */
export const listPageShape = {
  limit: limitParam,
  offset: offsetParam,
  after: cursorParam.optional(),
  count: countParam,
};

/** Schema refinement of every list v2 query: `after` and a non-zero `offset` are exclusive. */
export function refinePaging(q: { after?: string; offset: number }, ctx: z.RefinementCtx): void {
  if (q.after && q.offset > 0)
    ctx.addIssue({ code: 'custom', path: ['after'], message: '`after` and `offset` cannot be combined' });
}

/** Comma-separated (or repeated) multi-value parameter: `state=A,B` or `state=A&state=B`. */
export function csvParam<T extends z.ZodType<string, string>>(item: T, max = 50) {
  return z
    .union([z.string(), z.array(z.string())])
    .transform((v) =>
      (Array.isArray(v) ? v : [v])
        .flatMap((s) => s.split(','))
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(item).min(1).max(max))
    .transform((a) => [...new Set(a)] as z.infer<T>[]);
}

/** A date or date-time (`2026-09-29` or ISO-8601 with offset) → `Date`. */
export const dateParam = z
  .union([z.iso.datetime({ offset: true }), z.iso.date()])
  .transform((s) => new Date(s));

/** `…After` / `…Before` → a `$gte` / `$lt` range, or nothing. */
export function dateRange(after?: Date, before?: Date): Document | undefined {
  if (!after && !before) return undefined;
  return { ...(after ? { $gte: after } : {}), ...(before ? { $lt: before } : {}) };
}

// ------------------------------------------------------------------ live semi-joins

/**
 * "Has an open review" / "has an active job" filters are driven from the small side: the ids
 * that qualify are read with `distinct` on an index (open review items; active jobs), and the list
 * filters `_id $in/$nin` them. Above this many ids the filter falls back to a per-row `$lookup`
 * (then matches are dense, so a page fills quickly); totals then default to `count=none`.
 */
export const SEMI_JOIN_MAX_IDS = 10_000;

export interface SemiJoin {
  match?: Filter<Document>;
  stages?: Document[];
}

export function idSemiJoin(ids: string[], has: boolean, fallback: () => Document[]): SemiJoin {
  if (ids.length <= SEMI_JOIN_MAX_IDS)
    return { match: { _id: has ? { $in: ids } : { $nin: ids } } as unknown as Filter<Document> };
  return { stages: fallback() };
}

/** Ids of `kind` records named by an open review item, as entity or candidate (`by_entity`, `by_candidate`). */
export async function openReviewEntityIds(db: Db, kind: 'company' | 'job'): Promise<string[]> {
  const col = db.collection('market_review_items');
  const [entity, candidate] = await Promise.all([
    col.distinct('entity.id', { 'entity.kind': kind, status: 'open' }),
    col.distinct('candidates.id', { status: 'open', 'candidates.kind': kind }),
  ]);
  return [...new Set([...entity, ...candidate].filter((v): v is string => typeof v === 'string'))];
}

/**
 * Live open-review counts of a page of `kind` records: open items naming the record as their
 * entity or as a candidate, each item counted once per record (`by_entity`, `by_candidate`).
 * Records without an open item are absent from the map (count 0).
 */
export async function openReviewCounts(
  db: Db,
  kind: 'company' | 'job',
  ids: string[],
): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await db
    .collection('market_review_items')
    .aggregate<{ _id: string; n: number }>([
      {
        $match: {
          status: 'open',
          $or: [{ 'entity.kind': kind, 'entity.id': { $in: ids } }, { 'candidates.id': { $in: ids } }],
        },
      },
      {
        $project: {
          named: {
            $setUnion: [
              { $cond: [{ $eq: ['$entity.kind', kind] }, ['$entity.id'], []] },
              {
                $map: {
                  input: {
                    $filter: {
                      input: { $ifNull: ['$candidates', []] },
                      cond: { $eq: ['$$this.kind', kind] },
                    },
                  },
                  in: '$$this.id',
                },
              },
            ],
          },
        },
      },
      { $unwind: '$named' },
      { $match: { named: { $in: ids } } },
      { $group: { _id: '$named', n: { $sum: 1 } } },
    ])
    .toArray();
  return new Map(rows.map((r) => [r._id, r.n]));
}

/** Ids of companies with at least one active, non-CLOSED job (covered `DISTINCT_SCAN` on `by_company_state`). */
export async function activeJobCompanyIds(db: Db): Promise<string[]> {
  return (await db.collection('market_jobs').distinct('companyId', ACTIVE_JOB_MATCH)).filter(
    (v): v is string => typeof v === 'string',
  );
}

/**
 * Fallback for a large id set: keep rows (by `_id`) that do (or do not) have an open review naming
 * them as the entity or as a candidate, per row via the `by_entity` / `by_candidate` indexes.
 */
export function openReviewStages(kind: 'company' | 'job', has: boolean): Document[] {
  return [
    {
      $lookup: {
        from: 'market_review_items',
        localField: '_id',
        foreignField: 'entity.id',
        pipeline: [
          { $match: { 'entity.kind': kind, status: 'open' } },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: '_openAsEntity',
      },
    },
    {
      $lookup: {
        from: 'market_review_items',
        localField: '_id',
        foreignField: 'candidates.id',
        pipeline: [{ $match: { status: 'open' } }, { $limit: 1 }, { $project: { _id: 1 } }],
        as: '_openAsCandidate',
      },
    },
    {
      $match: has
        ? { $or: [{ '_openAsEntity.0': { $exists: true } }, { '_openAsCandidate.0': { $exists: true } }] }
        : { '_openAsEntity.0': { $exists: false }, '_openAsCandidate.0': { $exists: false } },
    },
    { $unset: ['_openAsEntity', '_openAsCandidate'] },
  ];
}

/** A job counts as active while it is `status: active` and not `CLOSED`. */
export const ACTIVE_JOB_MATCH = { status: 'active', 'lifecycle.state': { $ne: 'CLOSED' } } as const;

/** Fallback for a large id set: companies that do (or do not) have an active job, per row (`list_company_seen`, `$limit: 1`). */
export function activeJobStages(has: boolean): Document[] {
  return [
    {
      $lookup: {
        from: 'market_jobs',
        localField: '_id',
        foreignField: 'companyId',
        pipeline: [{ $match: ACTIVE_JOB_MATCH }, { $limit: 1 }, { $project: { _id: 1 } }],
        as: '_activeJob',
      },
    },
    { $match: { '_activeJob.0': { $exists: has } } },
    { $unset: ['_activeJob'] },
  ];
}

// ------------------------------------------------------------------ execution

export interface ListPlan {
  /** Filters (without the keyset condition). */
  match: Filter<Document>;
  /** Stages after the sort that filter rows (live semi-joins). They also apply to the count. */
  semiJoins?: Document[];
  /** Projection applied before semi-joins (must keep the sort fields). */
  projection?: Document;
  sort: string;
  fields: SortFields;
  limit: number;
  offset: number;
  after?: string;
  /** `undefined` = `defaultCount` (itself `exact` unless set). */
  count?: 'exact' | 'none';
  defaultCount?: 'exact' | 'none';
  /**
   * An index to use for the page and the count (where the planner could pick a blocking sort):
   * preferably its key pattern (names can differ on a live deployment), or its name.
   */
  hint?: string | Record<string, 1 | -1>;
}

export interface ListPage<T> {
  items: T[];
  /** `null` with `count=none`. */
  total: number | null;
  limit: number;
  offset: number;
  /** Pass as `after` to get the next page; `null` on the last page. */
  nextCursor: string | null;
}

/**
 * The page pipeline. `keyset` is the resolved position of `plan.after` (`resolveCursor`); without
 * it the cursor is decoded here, which cannot resolve a reference cursor.
 */
export function listPipeline(plan: ListPlan, keyset?: { values: unknown[]; id: string }): Document[] {
  if (plan.after && plan.offset > 0)
    throw new AppError('validation_failed', '`after` and `offset` cannot be combined', {
      params: ['after', 'offset'],
    });
  const position = (() => {
    if (!plan.after) return undefined;
    if (keyset) return keyset;
    const c = decodeCursor(plan.after, plan.sort, plan.fields.length);
    if ('ref' in c) throw new Error('listPipeline: resolve a reference cursor first (resolveCursor)');
    return c;
  })();
  const match: Filter<Document> = position
    ? { $and: [plan.match, keysetFilter(plan.fields, position.values, position.id)] }
    : plan.match;
  return [
    { $match: match },
    { $sort: mongoSort(plan.fields) },
    ...(plan.projection ? [{ $project: plan.projection }] : []),
    ...(plan.semiJoins ?? []),
    ...(plan.offset ? [{ $skip: plan.offset }] : []),
    { $limit: plan.limit + 1 },
  ];
}

/** Run a list plan: one page (limit + 1 rows to detect the end) and, unless `count=none`, the total. */
export async function runList<T extends Document>(col: Collection<T>, plan: ListPlan): Promise<ListPage<T>> {
  // Per-row semi-join stages are only planned above `SEMI_JOIN_MAX_IDS` qualifying ids: an exact
  // total would run the lookups over every row of the filter. The page itself stays cheap.
  if (plan.semiJoins?.length && plan.count === 'exact')
    throw new AppError(
      'validation_failed',
      `count=exact is not available for this filter: more than ${SEMI_JOIN_MAX_IDS} records qualify; use count=none`,
      { param: 'count', maxIds: SEMI_JOIN_MAX_IDS },
    );
  const pipeline = listPipeline(plan, await resolveCursor(col, plan));
  // With semi-join stages the effective count is always `none` (default `none`, `exact` refused).
  const counted = !plan.semiJoins?.length && (plan.count ?? plan.defaultCount ?? 'exact') === 'exact';
  const [rows, total] = await Promise.all([
    col.aggregate<T>(pipeline, { allowDiskUse: true, ...(plan.hint ? { hint: plan.hint } : {}) }).toArray(),
    counted
      ? col.countDocuments(plan.match as Filter<T>, plan.hint ? { hint: plan.hint } : {})
      : Promise.resolve(null),
  ]);
  const more = rows.length > plan.limit;
  const items = more ? rows.slice(0, plan.limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    total,
    limit: plan.limit,
    offset: plan.offset,
    nextCursor:
      more && last
        ? encodeCursor(
            plan.sort,
            plan.fields.map(([p]) => valueAt(last, p)),
            String(last._id),
          )
        : null,
  };
}

/** The query plan of a list page (tests assert index use). */
export async function explainList<T extends Document>(col: Collection<T>, plan: ListPlan): Promise<Document> {
  return col
    .aggregate(listPipeline(plan, await resolveCursor(col, plan)), plan.hint ? { hint: plan.hint } : {})
    .explain('queryPlanner');
}

/** Every plan stage name in an explain document (recursively), e.g. `IXSCAN`, `SORT`, `COLLSCAN`. */
export function planStages(explain: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') {
      for (const [k, v] of Object.entries(x)) {
        if (k === 'rejectedPlans') continue;
        if (k === 'stage' && typeof v === 'string') out.push(v);
        walk(v);
      }
    }
  };
  walk(explain);
  return out;
}
