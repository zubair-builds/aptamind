import type { Collection, Db, Document, Filter } from 'mongodb';
import { z } from 'zod';
import { mergedIdsInto } from '../merge-chain';
import {
  type CompanyObservationDoc,
  companyObservationsCollection,
  type JobObservationDoc,
  jobObservationsCollection,
} from '../observations/schemas';
import { type AuditEventDoc, auditEventsCollection } from '../review/schemas';
import { sourcesCollection } from '../sources/source.schema';
import { type JobVerificationDoc, jobVerificationsCollection } from '../verification/schemas';
import {
  auditEventDto,
  companyObservationDto,
  jobObservationDto,
  jobVerificationDto,
  listPageDto,
  RUN_STATES,
  runSummaryDto,
} from './dto';
import {
  csvParam,
  type ListPage,
  type ListPlan,
  listPageShape,
  refinePaging,
  runList,
  type SortFields,
} from './list';
import { boolParam, idParam } from './query';

/**
 * Paginated sub-resources of company and job records (M7.6, Admin ask API-5) and their run
 * history. Every endpoint pages with the list v2 parameters (`limit`, `after`/`nextCursor`,
 * `offset`, `count`) in one fixed, index-backed order.
 */

export const subResourcePageQuerySchema = z.strictObject({ ...listPageShape }).superRefine(refinePaging);

export const observationPageQuerySchema = z
  .strictObject({
    ...listPageShape,
    /** `true`: only the current version of each source record; `false`: only superseded history. */
    current: boolParam,
    sourceId: csvParam(idParam).optional(),
  })
  .superRefine(refinePaging);

export const entityRunsQuerySchema = z
  .strictObject({
    ...listPageShape,
    state: csvParam(z.enum(RUN_STATES)).optional(),
    workflowKey: csvParam(z.string().regex(/^[a-z0-9_.]{1,200}$/, 'Expected a workflow key')).optional(),
  })
  .superRefine(refinePaging);

type PageQuery = z.infer<typeof subResourcePageQuerySchema>;

const NEWEST_OBSERVED: SortFields = [['lastObservedAt', -1]];
const NEWEST_AT: SortFields = [['at', -1]];
const NEWEST_CREATED: SortFields = [['createdAt', -1]];

// ------------------------------------------------------------------ observations

export type ObservationRow<T> = T & {
  /** Not superseded: the latest version of its source record (what reconciliation reads). */
  current: boolean;
};

/**
 * Observations resolved to a company or job, newest `lastObservedAt` first
 * (`by_company_recent` / `by_job_recent`), with the sources they came from.
 */
export async function listEntityObservations(
  db: Db,
  kind: 'company' | 'job',
  entityId: string,
  q: z.infer<typeof observationPageQuerySchema>,
): Promise<
  ListPage<ObservationRow<CompanyObservationDoc | JobObservationDoc>> & {
    sources: Array<{ _id: string; key: string; name: string; authority: unknown }>;
  }
> {
  const and: Filter<Document>[] = [{ 'resolution.entityId': entityId }];
  if (q.current !== undefined) and.push({ superseded: q.current ? { $ne: true } : true });
  if (q.sourceId) and.push({ sourceId: { $in: q.sourceId } });
  const col = db.collection<CompanyObservationDoc | JobObservationDoc>(
    kind === 'company' ? companyObservationsCollection.name : jobObservationsCollection.name,
  );
  const page = await runList(col, {
    match: and.length === 1 ? and[0]! : { $and: and },
    sort: '-lastObservedAt',
    fields: NEWEST_OBSERVED,
    limit: q.limit,
    offset: q.offset,
    after: q.after,
    count: q.count,
  });
  const sources = await db
    .collection<{ _id: string; key: string; name: string; authority: unknown }>(sourcesCollection.name)
    .find(
      { _id: { $in: [...new Set(page.items.map((o) => o.sourceId))] } },
      { projection: { key: 1, name: 1, authority: 1 } },
    )
    .toArray();
  return { ...page, items: page.items.map((o) => ({ ...o, current: o.superseded !== true })), sources };
}

// ------------------------------------------------------------------ audit, verifications

/** Audit events of an entity, newest first (`by_entity_time`). */
export function listEntityAudit(
  db: Db,
  entity: { kind: string; id: string },
  q: PageQuery,
): Promise<ListPage<AuditEventDoc>> {
  return runList(db.collection<AuditEventDoc>(auditEventsCollection.name), {
    match: { 'entity.kind': entity.kind, 'entity.id': entity.id },
    sort: '-at',
    fields: NEWEST_AT,
    limit: q.limit,
    offset: q.offset,
    after: q.after,
    count: q.count,
  });
}

/**
 * Completed verifications of a job — and of every job merged into it (M6.2 MR1: a verification
 * keeps the job it was made against; a merge does not rewrite it) — newest first (`by_job_time`,
 * one index range per id, merged in order); in-flight operations are not evidence.
 */
export async function listJobVerifications(
  db: Db,
  jobId: string,
  q: PageQuery,
): Promise<ListPage<JobVerificationDoc>> {
  return runList(
    db.collection<JobVerificationDoc>(jobVerificationsCollection.name),
    await jobVerificationsPlan(db, jobId, q),
  );
}

/**
 * The list plan of `listJobVerifications`: hinted to `by_job_time` (by its key), so the ids'
 * ranges are merged in `at` order (`SORT_MERGE`) — never `by_job_status` and a blocking sort.
 * Beyond `MAX_MERGED_IDS` merged records the oldest-merged are left out (`mergedIdsInto`
 * `truncated`; the run history reports it as `truncated: true`).
 */
export async function jobVerificationsPlan(db: Db, jobId: string, q: PageQuery): Promise<ListPlan> {
  const merged = await mergedIdsInto(db, 'job', jobId);
  const ids = [jobId, ...merged.ids];
  return {
    match: { jobId: ids.length === 1 ? jobId : { $in: ids }, status: { $nin: ['claimed', 'checked'] } },
    sort: '-at',
    fields: NEWEST_AT,
    limit: q.limit,
    offset: q.offset,
    after: q.after,
    count: q.count,
    hint: { jobId: 1, at: -1, _id: -1 }, // by_job_time, by key (review L-3)
  };
}

// ------------------------------------------------------------------ run history

/** Why a run belongs to a record's history. */
export const ENTITY_RUN_LINKS = ['label', 'observation', 'verification', 'audit'] as const;
export type EntityRunLink = (typeof ENTITY_RUN_LINKS)[number];

/**
 * Bound on the run ids collected **per link kind** (observations, verifications, audit events).
 * Each kind is read newest first, so a bound drops only the oldest linked runs, and the response
 * says so (`truncated: true`); label-linked runs are never bounded.
 */
export const MAX_LINKED_RUNS = 2000;

/**
 * Up to `max` distinct run ids from `docs`, read newest first (`sort` on an index); `truncated`
 * when more distinct ids exist beyond the bound.
 */
async function newestRunIds(
  col: Collection<Document>,
  filter: Filter<Document>,
  sort: Document,
  runIdsOf: (d: Document) => string[],
  max: number,
): Promise<{ ids: string[]; truncated: boolean }> {
  const ids = new Set<string>();
  const cursor = col.find(filter, { sort, projection: { runId: 1, seenRunIds: 1 } });
  for await (const d of cursor) {
    for (const r of runIdsOf(d)) {
      if (ids.has(r)) continue;
      if (ids.size >= max) {
        await cursor.close();
        return { ids: [...ids], truncated: true };
      }
      ids.add(r);
    }
  }
  return { ids: [...ids], truncated: false };
}

const str = (v: unknown): v is string => typeof v === 'string';

/**
 * The runs that touched a company or job, without any runtime change: runs labelled with the
 * record or with a record merged into it (any depth, `mergedIdsInto`) — `companyId` on manual
 * discovery, `jobId` on manual verification and re-interpretation — plus the runs that produced
 * its observations (`runId`, `seenRunIds`), its verifications and those of the records merged
 * into it (M6.2 MR1), and its audit events (which include the batch re-derivations and
 * re-interpretations that changed it, M6.2 MR2), each kind read newest first and bounded by
 * `MAX_LINKED_RUNS`. Batch and scheduled runs are found through what they wrote.
 */
async function entityRunLinks(db: Db, kind: 'company' | 'job', id: string, max = MAX_LINKED_RUNS) {
  const col = (name: string) => db.collection<Document>(name);
  const { ids: merged, truncated: mergedTruncated } = await mergedIdsInto(db, kind, id);
  const obs = col(kind === 'company' ? companyObservationsCollection.name : jobObservationsCollection.name);
  const [observed, audited, verified] = await Promise.all([
    newestRunIds(
      obs,
      { 'resolution.entityId': id },
      { lastObservedAt: -1, _id: -1 },
      // The latest sightings first (seenRunIds is appended in run order).
      (d) => [...(Array.isArray(d.seenRunIds) ? [...d.seenRunIds].reverse() : []), d.runId].filter(str),
      max,
    ),
    newestRunIds(
      col(auditEventsCollection.name),
      { 'entity.kind': kind, 'entity.id': id },
      { at: -1, _id: -1 },
      (d) => [d.runId].filter(str),
      max,
    ),
    kind === 'job'
      ? newestRunIds(
          col(jobVerificationsCollection.name),
          { jobId: merged.length ? { $in: [id, ...merged] } : id },
          { at: -1, _id: -1 },
          (d) => [d.runId].filter(str),
          max,
        )
      : Promise.resolve({ ids: [] as string[], truncated: false }),
  ]);
  const links = new Map<string, Set<EntityRunLink>>();
  const add = (ids: string[], link: EntityRunLink) => {
    for (const r of ids) (links.get(r) ?? links.set(r, new Set()).get(r)!).add(link);
  };
  add(verified.ids, 'verification');
  add(observed.ids, 'observation');
  add(audited.ids, 'audit');
  return {
    labelIds: [id, ...merged],
    links,
    truncated: observed.truncated || audited.truncated || verified.truncated || mergedTruncated,
  };
}

export type EntityRunRow = Document & { _id: string; linkedBy: EntityRunLink[] };

/**
 * `GET /api/companies/:id/runs`, `GET /api/jobs/:id/runs`: newest first (keyset on `createdAt`),
 * each with `linkedBy` (why it is in this history). `runs` is the runtime's `workflow_runs`
 * collection, read only; the `by_label_company` / `by_label_job` indexes serve the label part.
 */
/**
 * The runtime's run collection as this read model needs it: a run has a string `_id` and string
 * labels (structural; Market does not import the runtime's types).
 */
export type RunCollection<T extends { _id: string; labels?: Record<string, string> }> = Collection<T>;

export async function listEntityRuns<T extends { _id: string; labels?: Record<string, string> }>(
  db: Db,
  runs: RunCollection<T>,
  kind: 'company' | 'job',
  id: string,
  q: z.infer<typeof entityRunsQuerySchema>,
  opts: { maxLinked?: number } = {},
): Promise<ListPage<EntityRunRow> & { truncated: boolean }> {
  const label = kind === 'company' ? 'labels.companyId' : 'labels.jobId';
  const { labelIds, links, truncated } = await entityRunLinks(db, kind, id, opts.maxLinked);
  const and: Filter<Document>[] = [
    { $or: [{ [label]: { $in: labelIds } }, { _id: { $in: [...links.keys()] as never[] } }] },
  ];
  if (q.state) and.push({ state: { $in: q.state } });
  if (q.workflowKey) and.push({ workflowKey: { $in: q.workflowKey } });
  const page = await runList(runs, {
    match: { $and: and },
    projection: { input: 0, output: 0 },
    sort: '-createdAt',
    fields: NEWEST_CREATED,
    limit: q.limit,
    offset: q.offset,
    after: q.after,
    count: q.count,
  });
  const labelKey = kind === 'company' ? 'companyId' : 'jobId';
  return {
    ...page,
    truncated,
    items: page.items.map((r) => {
      const linked = new Set<EntityRunLink>(links.get(String(r._id)) ?? []);
      const labels = r.labels ?? {};
      if (labels[labelKey] && labelIds.includes(labels[labelKey])) linked.add('label');
      return {
        ...r,
        _id: String(r._id),
        linkedBy: ENTITY_RUN_LINKS.filter((l) => linked.has(l)),
      } as EntityRunRow;
    }),
  };
}

// ------------------------------------------------------------------ DTOs

export const entityRunsResponseDto = listPageDto(
  runSummaryDto.extend({ linkedBy: z.array(z.enum(ENTITY_RUN_LINKS)).min(1) }),
).extend({
  /** Some older observation/verification/audit-linked runs were left out (`MAX_LINKED_RUNS` per kind). */
  truncated: z.boolean(),
});
const sourceRef = z.object({ _id: z.string(), key: z.string(), name: z.string() }).loose();
export const companyObservationsResponseDto = listPageDto(
  companyObservationDto.extend({ current: z.boolean() }),
).extend({ sources: z.array(sourceRef) });
export const jobObservationsResponseDto = listPageDto(
  jobObservationDto.extend({ current: z.boolean() }),
).extend({
  sources: z.array(sourceRef),
});
export const auditPageResponseDto = listPageDto(auditEventDto);
export const jobVerificationsResponseDto = listPageDto(jobVerificationDto);
