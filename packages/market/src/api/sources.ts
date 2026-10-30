import type { Collection, Db, Document, Filter } from 'mongodb';
import { z } from 'zod';
import { companiesCollection } from '../companies/company.schema';
import { SOURCE_CATEGORIES } from '../contracts/common';
import {
  SOURCE_FRESHNESS_STATES,
  type SourceFreshnessState,
  sourceFreshnessAgeMs,
  sourceFreshnessFilter,
  sourceFreshnessState,
} from '../freshness/source-freshness';
import { type SnapshotDoc, snapshotsCollection } from '../observations/schemas';
import {
  SOURCE_HEALTH_STATUSES,
  type SourceDoc,
  sourceNameKey,
  sourcesCollection,
} from '../sources/source.schema';
import { escapeRegex } from '../sources/source.service';
import { isUploadOnly } from '../sources/upload-only';
import { companySearchFilter } from './companies';
import { listPageDto, pageDto, RUN_STATES, runSummaryDto, snapshotDto, sourceListItemDto } from './dto';
import { companyNames, titleSearchWords } from './jobs';
import {
  csvParam,
  explainList,
  type ListPage,
  type ListPlan,
  listPageShape,
  refinePaging,
  runList,
  sortFields,
  type SortOptions,
  sortParam,
} from './list';
import { boolParam, idParam, limitParam, offsetParam, searchParam } from './query';

// ------------------------------------------------------------------ query (M7.4)

/** Sort keys of `GET /api/sources` (each backed by a `list_*` index on `market_sources`). */
export const SOURCE_SORTS = {
  category: [
    ['category', 1],
    ['name', 1],
  ],
  name: [['name', 1]],
  lastSuccessAt: [['health.lastSuccessAt', 1]],
  createdAt: [['createdAt', 1]],
} as const satisfies SortOptions;
export type SourceSort = keyof typeof SOURCE_SORTS;

const providerParam = z.string().regex(/^[a-z0-9_]{1,64}$/, 'Expected a provider key');

/** `GET /api/sources` (v2, a superset of v1). */
export const sourceListQuerySchema = z
  .strictObject({
    ...listPageShape,
    sort: sortParam(Object.keys(SOURCE_SORTS) as SourceSort[], 'category'),
    q: searchParam.min(1).optional(),
    category: csvParam(z.enum(SOURCE_CATEGORIES)).optional(),
    provider: csvParam(providerParam).optional(),
    enabled: boolParam,
    health: csvParam(z.enum(SOURCE_HEALTH_STATUSES)).optional(),
    freshness: csvParam(z.enum(SOURCE_FRESHNESS_STATES)).optional(),
    companyId: csvParam(idParam).optional(),
    /** `false` hides the built-in `system:*` sources. */
    system: boolParam,
  })
  .superRefine(refinePaging);
export type SourceListQuery = z.infer<typeof sourceListQuerySchema>;

export const sourceRunsQuerySchema = z.strictObject({
  limit: limitParam,
  offset: offsetParam,
  state: z.enum(RUN_STATES).optional(),
  workflowKey: z.string().min(1).max(200).optional(),
});

export const SNAPSHOT_SORTS = { lastFetchedAt: [['lastFetchedAt', 1]] } as const satisfies SortOptions;

export const sourceSnapshotsQuerySchema = z
  .strictObject({
    ...listPageShape,
    sort: sortParam(['lastFetchedAt'], '-lastFetchedAt'),
  })
  .superRefine(refinePaging);

// ------------------------------------------------------------------ rows

/** A source in list v2: the full document plus server-computed freshness and its company's name. */
export type SourceListItem = Omit<SourceDoc, 'schedule'> & {
  freshnessState: SourceFreshnessState;
  /** `now - health.lastSuccessAt` in ms; `null` when it never succeeded. */
  freshnessAgeMs: number | null;
  companyName: string | null;
  schedule: SourceScheduleState | null;
};

/** The scheduler fields a source row reads (structural: Market does not import the engine). */
export interface ScheduleView {
  owner: { kind: string; id: string };
  enabled: boolean;
  nextFireAt?: Date | null;
  lastFiredAt?: Date | null;
}
export type ScheduleCollection = Collection<ScheduleView>;

/** The source's schedule config with the scheduler's live state (OPS-1). */
export interface SourceScheduleState {
  cron?: string;
  intervalMinutes?: number;
  timezone: string;
  enabled: boolean;
  nextRunAt: Date | null;
  lastFiredAt: Date | null;
  /** OPS-2: scheduled fires before this time are deferred without a request; null when none. */
  backoffUntil: Date | null;
}

/**
 * `null` for an upload-only source, or when the source has no schedule and never had one.
 * `enabled` needs both the source and its scheduler entry enabled; `nextRunAt` only when enabled.
 * During a backoff `nextRunAt` is the backoff end when that is later than the next fire: a fire
 * before it is deferred, so the next fetch is the first fire at or after it.
 */
export function sourceScheduleState(source: SourceDoc, doc: ScheduleView | null): SourceScheduleState | null {
  // No schedule = null: upload-only sources, sources without a schedule, and sources whose
  // scheduler entry is missing or only a disabled placeholder.
  if (isUploadOnly(source.provider) || !source.schedule || !doc) return null;
  const backoff = source.health.backoffUntil ?? null;
  const enabled = !!source.schedule && source.enabled && !!doc?.enabled;
  return {
    ...(source.schedule?.cron ? { cron: source.schedule.cron } : {}),
    ...(source.schedule?.intervalMinutes ? { intervalMinutes: source.schedule.intervalMinutes } : {}),
    timezone: source.schedule?.timezone ?? 'UTC',
    enabled,
    nextRunAt: enabled ? laterOf(doc?.nextFireAt ?? null, backoff) : null,
    lastFiredAt: doc?.lastFiredAt ?? null,
    backoffUntil: backoff,
  };
}

function laterOf(next: Date | null, backoff: Date | null): Date | null {
  if (!next || !backoff) return next;
  return backoff > next ? backoff : next;
}

/** Scheduler entries of `sourceIds` (one query). */
export async function sourceSchedules(
  schedules: ScheduleCollection,
  sourceIds: string[],
): Promise<Map<string, ScheduleView>> {
  if (!sourceIds.length) return new Map();
  const docs = await schedules
    .find(
      { 'owner.kind': 'source', 'owner.id': { $in: sourceIds } },
      { projection: { owner: 1, enabled: 1, nextFireAt: 1, lastFiredAt: 1 } },
    )
    .toArray();
  return new Map(docs.map((d) => [d.owner.id, d]));
}

export function withFreshness(
  s: SourceDoc,
  now: Date,
): SourceDoc & {
  freshnessState: SourceFreshnessState;
  freshnessAgeMs: number | null;
} {
  return { ...s, freshnessState: sourceFreshnessState(s, now), freshnessAgeMs: sourceFreshnessAgeMs(s, now) };
}

// ------------------------------------------------------------------ search

/**
 * Anchored search: every word of `q` is a prefix of some name token (`nameTokens`,
 * `by_name_tokens`, tokenised like job titles: "home office" finds "UK Home Office Sponsor
 * Register", "acme car" finds "Acme — Careers (EU)"), or the key (`provider:board` style,
 * lower-case) starts with `q`, or its part after a `<provider>:` / `system:` prefix does — one
 * anchored regex per known prefix on the unique key index — or the source belongs to a company
 * whose name, alias or domain starts with `q`.
 */
async function sourceSearchFilter(db: Db, q: string): Promise<Filter<Document>> {
  const needle = escapeRegex(q.trim().toLowerCase());
  const col = db.collection<SourceDoc>(sourcesCollection.name);
  const prefixes = [...new Set([...(await col.distinct('provider')), 'system'])].filter((p) =>
    /^[a-z0-9_-]+$/.test(p),
  );
  const words = titleSearchWords(q);
  const token = (w: string) => ({ nameTokens: { $regex: `^${escapeRegex(w)}` } });
  // Widen phase: the previous release's whole-name prefix (`nameKey`) still matches, so a source
  // not yet backfilled with tokens is still found.
  const nameKey = sourceNameKey(q);
  const branches: Document[] = [
    ...(words.length ? [words.length === 1 ? token(words[0]!) : { $and: words.map(token) }] : []),
    ...(nameKey ? [{ nameKey: { $regex: `^${escapeRegex(nameKey)}` } }] : []),
    { key: { $regex: `^${needle}` } },
    ...prefixes.map((p) => ({ key: { $regex: `^${p}:${needle}` } })),
  ];
  const companies = await db
    .collection(companiesCollection.name)
    .find({ status: 'active', ...companySearchFilter(q) }, { projection: { _id: 1 } })
    .limit(200)
    .toArray();
  if (companies.length) branches.push({ companyId: { $in: companies.map((c) => c._id) } });
  return { $or: branches };
}

// ------------------------------------------------------------------ list

export async function sourceListPlan(db: Db, q: SourceListQuery, now: Date): Promise<ListPlan> {
  const col = db.collection<SourceDoc>(sourcesCollection.name);
  const and: Filter<Document>[] = [];
  if (q.q) and.push(await sourceSearchFilter(db, q.q));
  if (q.category) and.push({ category: { $in: q.category } });
  if (q.provider) and.push({ provider: { $in: q.provider } });
  if (q.enabled !== undefined) and.push({ enabled: q.enabled });
  if (q.health) and.push({ 'health.status': { $in: q.health } });
  if (q.freshness) and.push(await sourceFreshnessFilter(col, q.freshness, now));
  if (q.companyId) and.push({ companyId: { $in: q.companyId } });
  if (q.system !== undefined) and.push({ key: q.system ? { $regex: '^system:' } : { $not: /^system:/ } });
  return {
    match: and.length === 0 ? {} : and.length === 1 ? and[0]! : { $and: and },
    sort: q.sort,
    fields: sortFields(SOURCE_SORTS, q.sort),
    limit: q.limit,
    offset: q.offset,
    after: q.after,
    count: q.count,
  };
}

/**
 * `GET /api/sources`: full source documents with `freshnessState`, `freshnessAgeMs`, `companyName`
 * and the schedule state (`schedule`, from the scheduler: one batched lookup per page).
 */
export async function listSources(
  db: Db,
  q: SourceListQuery,
  now: Date,
  schedules: ScheduleCollection,
): Promise<ListPage<SourceListItem>> {
  const page = await runList(
    db.collection<SourceDoc>(sourcesCollection.name),
    await sourceListPlan(db, q, now),
  );
  const [names, scheduleOf] = await Promise.all([
    companyNames(
      db,
      page.items.flatMap((s) => (s.companyId ? [s.companyId] : [])),
    ),
    sourceSchedules(
      schedules,
      page.items.map((s) => s._id),
    ),
  ]);
  return {
    ...page,
    items: page.items.map((s) => ({
      ...withFreshness(s, now),
      companyName: s.companyId ? (names.get(s.companyId) ?? null) : null,
      schedule: sourceScheduleState(s, scheduleOf.get(s._id) ?? null),
    })),
  };
}

export async function explainSourceList(db: Db, q: SourceListQuery, now: Date): Promise<Document> {
  return explainList(db.collection<SourceDoc>(sourcesCollection.name), await sourceListPlan(db, q, now));
}

/** `GET /api/sources/:id/snapshots`: newest fetch first, keyset-paginated (`by_source_recent`). */
export function listSourceSnapshots(
  db: Db,
  sourceId: string,
  q: z.infer<typeof sourceSnapshotsQuerySchema>,
): Promise<ListPage<SnapshotDoc>> {
  return runList(db.collection<SnapshotDoc>(snapshotsCollection.name), {
    match: { sourceId },
    sort: q.sort,
    fields: sortFields(SNAPSHOT_SORTS, q.sort),
    limit: q.limit,
    offset: q.offset,
    after: q.after,
    count: q.count,
  });
}

// ------------------------------------------------------------------ DTOs

export const sourceListV2ResponseDto = listPageDto(sourceListItemDto);
export const sourceRunsResponseDto = pageDto(runSummaryDto);
export const sourceSnapshotsResponseDto = listPageDto(snapshotDto);
