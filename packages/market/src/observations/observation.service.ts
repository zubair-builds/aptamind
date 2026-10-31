import type { ClientSession } from 'mongodb';
import {
  type ArtifactRef,
  contentHash,
  deterministicId,
  InvalidStateError,
  NotFoundError,
} from '@aptamind/contracts';
import { getCollection, isDuplicateKeyError, withTransaction } from '@aptamind/db';
import {
  type CompanyObservationPayload,
  companyObservationPayloadSchema,
  type JobObservationPayload,
  jobObservationPayloadSchema,
} from '../contracts/observations';
import { companiesCollection } from '../companies/company.schema';
import { externalIdsOf } from '../companies/company.service';
import { idsContradict, normalizeObservationExternalIds } from '../companies/external-ids';
import type { MarketContext } from '../context';
import { expiresAtFor, retentionClassFor } from '../retention/policy';
import { sourcesCollection } from '../sources/source.schema';
import {
  type CompanyObservationDoc,
  companyObservationsCollection,
  type JobObservationDoc,
  jobObservationsCollection,
  OBSERVATION_SCHEMA_VERSION,
  type ObservationResolution,
  type SnapshotDoc,
  snapshotsCollection,
  sourceTimeOf,
} from './schemas';

/**
 * A link whose observation carries a single-valued register id that contradicts one the company
 * holds (as read inside the link transaction): the transaction aborts and nothing is linked.
 */
export class ContradictingIdError extends Error {
  constructor(
    readonly companyId: string,
    readonly namespace: string,
    readonly heldId: string,
    readonly observedId: string,
  ) {
    super(`The company already holds ${namespace} id ${heldId}; the row gives ${observedId}`);
    this.name = 'ContradictingIdError';
  }
}

export interface RecordObservationInput<P> {
  sourceId: string;
  snapshotId?: string;
  artifactId?: string;
  locator?: string;
  externalId?: string;
  payload: P;
  parser: { name: string; version: string };
  warnings?: string[];
  runId?: string;
  ai?: CompanyObservationDoc['ai'];
  /**
   * Source chronology of this observation. Defaults to the fetch time of `snapshotId` (so a
   * reprocessed snapshot keeps its original time), else to now.
   */
  sourceObservedAt?: Date;
}

/**
 * Snapshots and observations. Both are idempotent:
 *  - a snapshot is keyed by (source, content hash);
 *  - an observation id is derived from (source, external id, payload hash), so re-importing the
 *    same record touches `lastObservedAt`/`seenCount` instead of inserting a duplicate, and
 *    changed content creates a new observation while history is preserved.
 */
export class ObservationService {
  constructor(private readonly ctx: MarketContext) {}

  get snapshots() {
    return getCollection(this.ctx.db, snapshotsCollection);
  }
  get companyObservations() {
    return getCollection(this.ctx.db, companyObservationsCollection);
  }
  get jobObservations() {
    return getCollection(this.ctx.db, jobObservationsCollection);
  }

  /**
   * Whether `runId` is the acquisition of an uploaded snapshot: the first run to process it claims
   * it (a replay of that run still is); every other run is a reprocess.
   */
  async claimUploadAcquisition(snapshotId: string, runId: string | undefined): Promise<boolean> {
    const run = runId ?? 'no-run';
    const res = await this.snapshots.updateOne(
      {
        _id: snapshotId,
        via: 'upload',
        $or: [{ acquisitionRunId: { $exists: false } }, { acquisitionRunId: run }],
      },
      { $set: { acquisitionRunId: run } },
    );
    return res.matchedCount > 0;
  }

  async recordSnapshot(input: {
    sourceId: string;
    artifact: ArtifactRef;
    url?: string;
    httpStatus?: number;
    contentType?: string;
    runId?: string;
    via: SnapshotDoc['via'];
    /** The board this fetch read (captured at fetch start). */
    board?: SnapshotDoc['fetchBoard'];
  }): Promise<{ snapshot: SnapshotDoc; unchanged: boolean; previousSnapshotId: string | null }> {
    const now = this.ctx.clock.now();
    const previous = await this.snapshots
      .find({ sourceId: input.sourceId })
      .sort({ lastFetchedAt: -1 })
      .limit(1)
      .next();
    const id = deterministicId('snap', input.sourceId, input.artifact.sha256);
    const src = await getCollection(this.ctx.db, sourcesCollection).findOne(
      { _id: input.sourceId },
      { projection: { category: 1, 'authority.tier': 1 } },
    );
    const retentionClass = retentionClassFor({
      via: input.via,
      category: src?.category,
      authorityTier: src?.authority?.tier,
    });
    await this.snapshots.updateOne(
      { _id: id },
      {
        // Each fetch of the same bytes extends expiry ($max keeps a later hold); a snapshot whose
        // bytes were released is fetched again as new evidence, so the release mark is cleared.
        $max: { expiresAt: expiresAtFor(retentionClass, now) },
        $unset: { expiredAt: '' },
        $set: {
          lastFetchedAt: now,
          updatedAt: now,
          ...(input.board !== undefined ? { fetchBoard: input.board } : {}),
        },
        $setOnInsert: {
          fetchCount: 0,
          runIds: [],
          sourceId: input.sourceId,
          artifact: input.artifact,
          contentHash: input.artifact.sha256,
          url: input.url,
          httpStatus: input.httpStatus,
          contentType: input.contentType,
          firstFetchedAt: now,
          via: input.via,
          retentionClass,
          schemaVersion: OBSERVATION_SCHEMA_VERSION,
          createdAt: now,
        },
      },
      { upsert: true },
    );
    // fetchCount counts distinct fetch operations: a replay within the same run (retry, crash,
    // redelivery) does not count again. Uploads without a run count each call.
    await this.snapshots.updateOne(
      input.runId ? { _id: id, runIds: { $ne: input.runId } } : { _id: id },
      input.runId
        ? { $inc: { fetchCount: 1 }, $push: { runIds: { $each: [input.runId], $slice: -50 } } }
        : { $inc: { fetchCount: 1 } },
    );
    const snapshot = (await this.snapshots.findOne({ _id: id })) as SnapshotDoc;
    return {
      snapshot,
      unchanged: previous?.contentHash === input.artifact.sha256,
      previousSnapshotId: previous && previous._id !== id ? previous._id : (previous?._id ?? null),
    };
  }

  async getSnapshot(id: string): Promise<SnapshotDoc> {
    const s = await this.snapshots.findOne({ _id: id });
    if (!s) throw new NotFoundError('Snapshot', id);
    return s;
  }

  async setSnapshotItemCount(id: string, itemCount: number): Promise<void> {
    await this.snapshots.updateOne({ _id: id }, { $set: { itemCount, updatedAt: this.ctx.clock.now() } });
  }

  /**
   * With `session`, every read and write joins the caller's transaction (a generation-fenced
   * review correction records its operator observation atomically with the fence).
   */
  /** The id `recordCompanyObservation` gives a record (deterministic: source, record key, payload). */
  companyObservationId(sourceId: string, externalId: string, payload: CompanyObservationPayload): string {
    return deterministicId('cobs', sourceId, externalId, contentHash(normalizedCompanyPayload(payload)));
  }

  recordCompanyObservation(
    input: RecordObservationInput<CompanyObservationPayload>,
    opts: { session?: ClientSession } = {},
  ) {
    const payload = normalizedCompanyPayload(input.payload);
    return this.record(this.companyObservations, 'cobs', { ...input, payload }, opts.session);
  }

  recordJobObservation(input: RecordObservationInput<JobObservationPayload>) {
    const payload = jobObservationPayloadSchema.parse(input.payload);
    return this.record(this.jobObservations, 'jobs', { ...input, payload });
  }

  private async record<D extends CompanyObservationDoc | JobObservationDoc>(
    col: ReturnType<typeof getCollection<D>>,
    prefix: string,
    input: RecordObservationInput<D['payload']>,
    session?: ClientSession,
  ): Promise<{ observation: D; created: boolean }> {
    const s = session ? { session } : {};
    const hash = contentHash(input.payload);
    const id = deterministicId(prefix, input.sourceId, input.externalId ?? input.locator ?? '', hash);
    const now = this.ctx.clock.now();
    const sourceAt =
      input.sourceObservedAt ?? (await this.snapshotFetchTime(input.snapshotId, session)) ?? now;
    // Processing metadata moves on every (re)processing; source chronology only moves forward,
    // and only when a later fetch saw this content again.
    const touch = {
      lastObservedAt: now,
      updatedAt: now,
    };
    const forward = { sourceObservedAt: sourceAt };
    // seenCount counts distinct runs that observed this record: a replay within the same run
    // (retry, crash, redelivery) only refreshes timestamps.
    let touched = input.runId
      ? await col.findOneAndUpdate(
          { _id: id, runId: { $ne: input.runId }, seenRunIds: { $ne: input.runId } } as never,
          {
            $set: touch,
            $max: forward,
            $inc: { seenCount: 1 },
            $push: { seenRunIds: { $each: [input.runId], $slice: -20 } },
          } as never,
          { returnDocument: 'after', ...s },
        )
      : null;
    if (!touched) {
      touched = await col.findOneAndUpdate(
        { _id: id } as never,
        (input.runId
          ? { $set: touch, $max: forward }
          : { $set: touch, $max: forward, $inc: { seenCount: 1 } }) as never,
        { returnDocument: 'after', ...s },
      );
    }
    if (touched) {
      // The provenance follows source chronology: only the latest fetch re-points it, and the
      // snapshot, its artifact and the locator inside it move TOGETHER (a row that moved in a
      // newer file must cite that file's line, never the new snapshot with the old line).
      const provenance = {
        ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
        ...(input.artifactId ? { artifactId: input.artifactId } : {}),
        ...(input.locator ? { locator: input.locator } : {}),
      };
      const stale = Object.entries(provenance).some(
        ([k, v]) => (touched as unknown as Record<string, unknown>)[k] !== v,
      );
      if (input.snapshotId && stale && sourceTimeOf(touched).getTime() === sourceAt.getTime()) {
        await col.updateOne(
          { _id: id, sourceObservedAt: sourceAt } as never,
          { $set: provenance } as never,
          s,
        );
        touched = { ...touched, ...provenance } as unknown as typeof touched;
      }
      await this.markCurrent(col, touched as D, session);
      return { observation: touched as D, created: false };
    }
    const doc = {
      _id: id,
      sourceId: input.sourceId,
      snapshotId: input.snapshotId,
      artifactId: input.artifactId,
      locator: input.locator,
      externalId: input.externalId,
      contentHash: hash,
      firstObservedAt: now,
      lastObservedAt: now,
      sourceObservedAt: sourceAt,
      seenCount: 1,
      parser: input.parser,
      ai: input.ai,
      warnings: input.warnings ?? [],
      resolution: { state: 'pending' } as ObservationResolution,
      runId: input.runId,
      payload: input.payload,
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    } as D;
    try {
      await col.insertOne(doc as never, s);
      await this.markCurrent(col, doc, session);
      return { observation: doc, created: true };
    } catch (err) {
      // Inside a transaction the failed insert aborted it: the caller's transaction retries.
      if (!isDuplicateKeyError(err) || session) throw err;
      const existing = await col.findOne({ _id: id } as never);
      return { observation: existing as D, created: false };
    }
  }

  /**
   * The most recently observed version of a source record is its current claim; older versions
   * of the same record are marked superseded (kept as history). Records without an external id
   * or locator cannot be matched across versions and are always current.
   */
  private async markCurrent<D extends CompanyObservationDoc | JobObservationDoc>(
    col: ReturnType<typeof getCollection<D>>,
    obs: D,
    session?: ClientSession,
  ): Promise<void> {
    const key = obs.externalId
      ? { externalId: obs.externalId }
      : obs.locator
        ? { locator: obs.locator }
        : null;
    if (!key) return;
    // Versions are totally ordered by SOURCE chronology, then id: (sourceObservedAt, _id) — never
    // by processing time, so reprocessing an old snapshot cannot make its content current over
    // a later fetch. Only the greatest version is current. Protocol, safe under concurrent
    // writers of the same record: (1) become visible as current, (2) supersede every earlier
    // version, (3) if a later current version exists, supersede self. The greatest version is
    // never superseded (nothing is later; nobody else supersedes a later version); any other
    // version is superseded either by its own step 3 (the greatest was visible) or by the
    // greatest's step 2 (it ran after this one's step 3).
    const at = sourceTimeOf(obs);
    const t = { $ifNull: ['$sourceObservedAt', '$lastObservedAt'] };
    const record = { sourceId: obs.sourceId, ...key, _id: { $ne: obs._id }, superseded: { $ne: true } };
    const earlier = {
      ...record,
      $expr: { $or: [{ $lt: [t, at] }, { $and: [{ $eq: [t, at] }, { $lt: ['$_id', obs._id] }] }] },
    };
    let superseded = !!obs.superseded;
    const steps = async (s: { session?: ClientSession }) => {
      if (superseded)
        await col.updateOne({ _id: obs._id } as never, { $set: { superseded: false } } as never, s);
      await col.updateMany(earlier as never, { $set: { superseded: true } } as never, s);
      const later = await col.findOne(
        {
          ...record,
          $expr: { $or: [{ $gt: [t, at] }, { $and: [{ $eq: [t, at] }, { $gt: ['$_id', obs._id] }] }] },
        } as never,
        { projection: { _id: 1 }, ...s },
      );
      if (later) await col.updateOne({ _id: obs._id } as never, { $set: { superseded: true } } as never, s);
    };
    if (col.collectionName !== companyObservationsCollection.name) return steps(session ? { session } : {});
    // Company records: the supersede (and make-current) and the revision bump of the companies
    // whose evidence it changes — a company an older version this call supersedes is linked to,
    // and the company of this version made current again — are one transaction.
    await this.withCompanyRevisionFence(
      session,
      async (s) => {
        const older = await col
          .find({ ...earlier, 'resolution.state': 'resolved' } as never, {
            projection: { resolution: 1 },
            session: s,
          })
          .toArray();
        // Re-read inside the transaction (a concurrent link of this version is seen).
        const fresh = await col.findOne({ _id: obs._id } as never, {
          projection: { superseded: 1, resolution: 1 },
          session: s,
        });
        superseded = !!(fresh as { superseded?: boolean } | null)?.superseded;
        // This version itself only when its standing changes: made current again (it was
        // superseded), or superseded now by step 3 (a later current version exists). A version
        // that stays current changes no company's evidence: no bump (an identical re-import is a
        // no-op, revisions included).
        const later =
          !superseded &&
          !!(await col.findOne(
            {
              ...record,
              $expr: { $or: [{ $gt: [t, at] }, { $and: [{ $eq: [t, at] }, { $gt: ['$_id', obs._id] }] }] },
            } as never,
            { projection: { _id: 1 }, session: s },
          ));
        const changing = [...older, ...(fresh && (superseded || later) ? [fresh] : [])];
        const ids: string[] = [];
        for (const o of changing) {
          const r = (o as { resolution?: ObservationResolution }).resolution;
          if (r?.state === 'resolved' && r.entityId) ids.push(r.entityId);
        }
        return ids;
      },
      async (s) => steps({ session: s }),
    );
  }

  /** Fetch time of a snapshot: the source chronology of everything parsed from it. */
  private async snapshotFetchTime(
    snapshotId: string | undefined,
    session?: ClientSession,
  ): Promise<Date | undefined> {
    if (!snapshotId) return undefined;
    const snap = await this.snapshots.findOne(
      { _id: snapshotId },
      { projection: { lastFetchedAt: 1 }, ...(session ? { session } : {}) },
    );
    return snap?.lastFetchedAt;
  }

  async setCompanyResolution(
    observationIds: string[],
    resolution: ObservationResolution,
    opts: { session?: ClientSession; claimKeys?: boolean } = {},
  ): Promise<void> {
    const write = (r: ObservationResolution, session?: ClientSession) =>
      this.companyObservations.updateMany(
        { _id: { $in: observationIds } },
        {
          $set: {
            resolution: { ...r, resolvedAt: r.resolvedAt ?? this.ctx.clock.now() },
            updatedAt: this.ctx.clock.now(),
          },
        },
        session ? { session } : {},
      );
    if (!(resolution.state === 'resolved' && resolution.entityId)) {
      await write(resolution, opts.session);
      return;
    }
    // A link to a company and that company's revision bump are one transaction (DECISION_LOG
    // 621f14c): a reconciliation planned before the link fails its revision check and recomputes.
    // The target is resolved inside the transaction (a company merged meanwhile → its survivor),
    // and with `claimKeys` the observation's register-id keys are claimed in the same transaction.
    const entityId = resolution.entityId;
    let target = entityId;
    await this.withCompanyRevisionFence(
      opts.session,
      async (s) => {
        target = await this.activeCompanyId(entityId, s);
        // A link that is already in place (every observation resolved to this company) changes no
        // evidence: no bump, so an identical re-import leaves the company's revision as it is.
        const current = await this.companyObservations
          .find({ _id: { $in: observationIds } }, { projection: { resolution: 1 }, session: s })
          .toArray();
        const linked =
          current.length === observationIds.length &&
          current.every((o) => o.resolution.state === 'resolved' && o.resolution.entityId === target);
        return linked ? [] : [target];
      },
      async (s) => {
        if (opts.claimKeys) await this.claimExternalIdKeys(observationIds, target, s);
        await write(target === entityId ? resolution : { ...resolution, entityId: target }, s);
      },
    );
  }

  /** The surviving active company of `id` (following merge pointers), read in the session. */
  private async activeCompanyId(id: string, session: ClientSession): Promise<string> {
    const col = getCollection(this.ctx.db, companiesCollection);
    const seen = new Set<string>();
    let cur = id;
    for (;;) {
      if (seen.has(cur) || seen.size >= 20)
        throw new InvalidStateError(`Company ${id}: its merge chain loops (or exceeds 20 hops)`, {
          chain: [...seen],
        });
      seen.add(cur);
      const c = await col.findOne({ _id: cur }, { projection: { status: 1, mergedInto: 1 }, session });
      // A broken chain: a missing company, or a merged one without a survivor.
      if (!c) throw new NotFoundError('Company', cur);
      if (c.status === 'active') return c._id;
      if (!c.mergedInto) throw new NotFoundError('Company', id);
      cur = c.mergedInto;
    }
  }

  /**
   * Claim the observations' register-id keys for the company inside the link transaction
   * (DECISION_LOG re-verification #9, L-1; af1b342): an id that contradicts one the company holds
   * (`idsContradict`, the company as read in this transaction) throws `ContradictingIdError`; every
   * other `ext:` key is added. A key another company holds raises a duplicate-key error. Either
   * aborts the transaction — the caller re-resolves instead of linking (so the company never
   * unites two contradicting ids, and no other row can create a second holder of a key).
   */
  private async claimExternalIdKeys(observationIds: string[], companyId: string, session: ClientSession) {
    const companies = getCollection(this.ctx.db, companiesCollection);
    const company = await companies.findOne({ _id: companyId }, { session });
    if (!company) throw new NotFoundError('Company', companyId);
    const held = externalIdsOf(company);
    const observations = await this.companyObservations
      .find({ _id: { $in: observationIds } }, { projection: { 'payload.externalIds': 1 }, session })
      .toArray();
    for (const o of observations)
      for (const e of o.payload.externalIds) {
        const key = `ext:${e.namespace}:${e.id}`;
        // An id the company already holds is the matched evidence (an operator may have dismissed
        // a recorded conflict beside it): nothing to contradict; its key is the reconciler's.
        if (held.some((h) => h.namespace === e.namespace && h.id === e.id)) continue;
        const clash = held.find((h) => idsContradict(e, h));
        // A contradicting single-valued id (as the company reads inside this transaction): never
        // link — abort, and the caller re-resolves to a high review (DECISION_LOG af1b342).
        if (clash) throw new ContradictingIdError(companyId, e.namespace, clash.id, e.id);
        if (company.identityKeys.includes(key)) continue;
        await companies.updateOne({ _id: companyId }, { $addToSet: { identityKeys: key } }, { session });
      }
  }

  /**
   * The release fence (DECISION_LOG 621f14c): change a company's evidence (link an observation,
   * supersede or re-instate a linked version) and advance the revision of the companies it
   * affects in ONE transaction — the caller's with `session`. The bump runs FIRST, so each
   * affected company document is write-locked until the transaction ends: a reconciliation commit
   * that races the change waits for it and then fails its revision check, and a plan computed
   * before the change (it read the older revision) can never commit after it.
   */
  private async withCompanyRevisionFence(
    session: ClientSession | undefined,
    affected: (s: ClientSession) => Promise<string[]>,
    write: (s: ClientSession, ids: string[]) => Promise<unknown>,
  ): Promise<void> {
    const run = async (s: ClientSession) => {
      const ids = [...new Set(await affected(s))];
      // Active companies only: a merged tombstone is never reconciled (its evidence moved to the
      // survivor with the merge).
      if (ids.length)
        await getCollection(this.ctx.db, companiesCollection).updateMany(
          { _id: { $in: ids }, status: 'active' },
          { $inc: { rev: 1 } },
          { session: s },
        );
      await write(s, ids);
    };
    if (session) await run(session);
    else await withTransaction(this.ctx.db.client, run);
  }

  async setJobResolution(observationIds: string[], resolution: ObservationResolution): Promise<void> {
    await this.jobObservations.updateMany(
      { _id: { $in: observationIds } },
      {
        $set: {
          resolution: { ...resolution, resolvedAt: resolution.resolvedAt ?? this.ctx.clock.now() },
          updatedAt: this.ctx.clock.now(),
        },
      },
    );
  }
}

/**
 * The stored form of a company observation payload: the contract's parse, with known registry
 * namespaces' ids normalised for every provider (so `445790` and `00445790` are one id).
 */
export function normalizedCompanyPayload(payload: unknown): CompanyObservationPayload {
  const p = companyObservationPayloadSchema.parse(payload);
  return { ...p, externalIds: normalizeObservationExternalIds(p.externalIds) };
}
