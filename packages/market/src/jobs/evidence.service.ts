import { isDeepStrictEqual } from 'node:util';
import type { AnyBulkWriteOperation } from 'mongodb';
import { type Actor, NotFoundError } from '@aptamind/contracts';
import { getCollection, isDuplicateKeyError } from '@aptamind/db';
import type { MarketContext } from '../context';
import { nextVerificationDue } from '../freshness/policies';
import { type SourceDoc, sourcesCollection } from '../sources/source.schema';
import { boardOfSource, endpointChangedSince } from '../sources/source-standing';
import type { SourceStanding } from './authority';
import { boardIdentity } from './board';
import {
  JOB_EVIDENCE_LOGIC_VERSION,
  JOB_EVIDENCE_SCHEMA_VERSION,
  type JobEvidenceDoc,
  jobEvidenceCollection,
  jobEvidenceSweepsCollection,
  jobLifecycleCheckpointsCollection,
  jobLifecycleFailuresCollection,
} from './evidence';
import { type JobDoc, type JobLifecycle, type SourceRef } from './job.schema';
import type { JobService } from './job.service';
import { AuditLog } from '../review/audit';
import type { ReviewRepository } from '../review/review.repository';
import {
  DEFAULT_LIFECYCLE_POLICY,
  type Derivation,
  type DerivedLifecycle,
  type DeriveJob,
  finalizeFold,
  foldEvidence,
  type FoldState,
  initialFoldState,
  LIFECYCLE_POLICY_VERSION,
} from './lifecycle';

/** Evidence to record: the store fills in `schemaVersion`, `createdAt` and (by default) `logicVersion`. */
export type NewJobEvidence = Omit<JobEvidenceDoc, 'schemaVersion' | 'createdAt' | 'logicVersion'> & {
  logicVersion?: string;
};

/** How a recompute schedules the job's next verification. */
export type RecomputeSchedule =
  /** A verification was applied: the normal cadence from it, sooner after an inconclusive one. */
  | { kind: 'verification'; evidenceId: string }
  /** Listing evidence was applied: a job that became POSSIBLY_STALE is due at `at`. */
  | { kind: 'listing'; at: Date }
  /** The stale sweep or a source's standing change: a job that became POSSIBLY_STALE is due now. */
  | { kind: 'sweep' };

export interface RecomputeResult {
  before: JobDoc;
  after: JobDoc;
  written: boolean;
  /** Evidence documents read by this recompute (bounded by the checkpoint). */
  read: number;
}

/**
 * What a recompute is told about evidence its caller just recorded. (Late evidence is detected by
 * the recompute itself, from the evidence counts — never from what a recorder says, DECISION_LOG
 * 9b0cb03.)
 */
export interface RecordedEvidence {
  /** Whether the record inserted anything: then the recompute always completes a revision-bumping write. */
  inserted?: boolean;
}

const SOURCE_PROJECTION = {
  _id: 1,
  enabled: 1,
  category: 1,
  provider: 1,
  authority: 1,
  endpoint: 1,
  endpointChangedAt: 1,
  standingHistory: 1,
  'health.listingBaseline': 1,
} as const;

/**
 * The job evidence store and the lifecycle recompute (DECISION_LOG 6a01b36, 15c965b). Evidence is
 * recorded once (idempotent on its key) BEFORE the job is recomputed; the recompute reads the job,
 * THEN its evidence (only after the job's checkpoint), derives the lifecycle and writes it under the
 * job's revision fence (retrying on a concurrent write). A recorder that inserted evidence always
 * completes a revision-bumping write, so a concurrent writer that read before the insert can
 * never overwrite it. So the last successful write always folded every piece of evidence
 * recorded before it: whatever the interleaving, the job ends at `deriveLifecycle(all evidence)`.
 */
export class JobEvidenceService {
  constructor(
    private readonly ctx: MarketContext,
    private readonly jobs: JobService,
    private readonly reviews?: ReviewRepository,
  ) {}

  /**
   * Called when a job whose re-derivation had been failing re-derives successfully: the domain
   * dismisses its open `lifecycle_failure` review, as a system actor. Resolves `true` once no open
   * item is left (none open, or dismissed now), `false` when it must be retried — the dismissal
   * failed, or another resolver (an operator's resolution claim, never taken) is deciding the item
   * — and the job then stays on the retry list (M6.2 L1, review L-2).
   */
  onLifecycleRecovered?: (jobId: string) => Promise<boolean>;

  /** The audit log the runs that re-derive a job are recorded in (M6.2 MR2). */
  private get audit() {
    return (this.auditLog ??= new AuditLog(this.ctx));
  }
  private auditLog?: AuditLog;

  /**
   * A run changed the job's stored lifecycle: record it on the job (an audit event linked to the
   * run, one per job and run), so the job's run history shows the run (M6.2 MR2). Idempotent on
   * the run, the job and the change.
   */
  async recordRunChange(
    runId: string | undefined,
    r: Pick<RecomputeResult, 'before' | 'after' | 'written'>,
    cause: 'source_standing' | 'recorded_evidence' | 'stale_sweep',
    details: Record<string, string> = {},
  ): Promise<void> {
    if (!runId || !r.written) return;
    await this.audit.record({
      actor: LIFECYCLE_DERIVATION_ACTOR,
      action: 'job.lifecycle_rederived',
      entity: { kind: 'job', id: r.after._id },
      runId,
      idempotencyKey: `run:${runId}`,
      details: { cause, ...details, from: r.before.lifecycle.state, to: r.after.lifecycle.state },
    });
  }

  /**
   * Raise (or refresh) the job's `lifecycle_failure` review — unless an operator dismissed one for
   * the same error code during this failure streak (`since`, the failure document's start): then
   * it is not raised again until the code changes or the job recovers in between (M6.2 L2). The
   * dismissed code is kept on the failure document (`dismissedCode`). The operator's latest
   * decision is read entity-first (`by_entity`, M6.2 L3). After raising, the failure document is
   * checked again: an overlapping sweep that healed the job in between found no item to dismiss,
   * so this one dismisses it (M6.2 L1); if that fails, the document is put back so the job stays
   * on the retry list until the dismissal succeeds.
   */
  private async raiseLifecycleFailure(
    jobId: string,
    code: string,
    failures: number,
    since: Date,
  ): Promise<void> {
    if (!this.reviews) return;
    const dedupeKey = `lifecycle_failure:${jobId}`;
    const entity = { kind: 'job' as const, id: jobId };
    const open = await this.reviews.col.findOne({ dedupeKey, status: 'open' }, { projection: { _id: 1 } });
    if (!open) {
      const last = await this.reviews.latestDecision(dedupeKey, entity);
      if (
        last?.status === 'dismissed' &&
        last.resolution &&
        last.resolution.actor.kind !== 'system' &&
        last.resolution.at.getTime() >= since.getTime() &&
        last.context?.code === code
      ) {
        await getCollection(this.ctx.db, jobLifecycleFailuresCollection).updateOne(
          { _id: jobId },
          { $set: { dismissedCode: code } },
        );
        return;
      }
    }
    await this.reviews.raise({
      type: 'lifecycle_failure',
      severity: 'medium',
      dedupeKey,
      entity,
      subject: `Job ${jobId}: lifecycle could not be re-derived`,
      reason: `Re-deriving the job's lifecycle from its evidence failed ${failures} times in a row (error ${code}). Its stored lifecycle may be out of date.`,
      context: { jobId, code, failures },
      allowedActions: ['dismiss'],
      refresh: true,
    });
    const failed = getCollection(this.ctx.db, jobLifecycleFailuresCollection);
    if (await failed.findOne({ _id: jobId }, { projection: { _id: 1 } })) return;
    // Healed meanwhile: its recovery ran before this review existed.
    if (!this.onLifecycleRecovered || (await this.onLifecycleRecovered(jobId))) return;
    const now = this.ctx.clock.now();
    await failed.updateOne(
      { _id: jobId },
      { $setOnInsert: { failures, code, since, lastAt: now } },
      { upsert: true },
    );
  }

  /**
   * A job re-derived successfully: dismiss its open review FIRST, then remove its failure
   * document — only the one this read (same `lastAt` and `failures`: a failure recorded meanwhile
   * by an overlapping sweep is kept). A failed dismissal keeps the document, moved to the back of
   * the retry list (`lastAt` now), so the next sweeps retry the job and its dismissal without
   * starving the other failing jobs (M6.2 L1, review L-b/L-c).
   */
  private async settleRecovery(jobId: string): Promise<void> {
    const failed = getCollection(this.ctx.db, jobLifecycleFailuresCollection);
    const doc = await failed.findOne({ _id: jobId }, { projection: { lastAt: 1, failures: 1 } });
    if (!doc) return;
    // Fenced on both: a failure recorded meanwhile moves `failures` even within the same ms (L-c).
    const seen = { _id: jobId, lastAt: doc.lastAt, failures: doc.failures };
    if (this.onLifecycleRecovered && !(await this.onLifecycleRecovered(jobId))) {
      // Still pending: to the back of the retry list, so it never starves the others (L-b).
      await failed.updateOne(seen, { $set: { lastAt: this.ctx.clock.now() } });
      return;
    }
    await failed.deleteOne(seen);
  }

  /** The database server's current time (the clock `createdAt` is stamped with). */
  async serverNow(): Promise<Date> {
    const hello = (await this.ctx.db.command({ hello: 1 })) as { localTime?: Date };
    return hello.localTime ?? new Date();
  }

  get col() {
    return getCollection(this.ctx.db, jobEvidenceCollection);
  }

  get checkpoints() {
    return getCollection(this.ctx.db, jobLifecycleCheckpointsCollection);
  }

  /** Record evidence exactly once per key (a replay changes nothing). Returns how many were new. */
  async record(docs: ReadonlyArray<NewJobEvidence>): Promise<number> {
    if (!docs.length) return 0;
    // `createdAt` is the DATABASE's time at insert ($$NOW), never an app clock (re-verify #12
    // LOW-1): the recorded-evidence sweep orders and cuts off by it, so a recorder whose clock is
    // behind can never file evidence behind the sweep's watermark. An existing document is kept.
    const ops: AnyBulkWriteOperation<JobEvidenceDoc>[] = docs.map((d) => ({
      updateOne: {
        filter: { _id: d._id },
        update: [
          {
            $replaceWith: {
              $cond: [
                { $eq: [{ $type: '$createdAt' }, 'missing'] },
                {
                  $mergeObjects: [
                    {
                      $literal: {
                        ...d,
                        logicVersion: d.logicVersion ?? JOB_EVIDENCE_LOGIC_VERSION,
                        schemaVersion: JOB_EVIDENCE_SCHEMA_VERSION,
                      },
                    },
                    { createdAt: '$$NOW' },
                  ],
                },
                '$$ROOT',
              ],
            },
          },
        ],
        upsert: true,
      },
    }));
    const res = await this.col.bulkWrite(ops, { ordered: false });
    return res.upsertedCount;
  }

  /**
   * A job's evidence: every copy's evidence (by copy key, so a merge carries it to the survivor)
   * plus the job's own baseline — only after `after` when given (a checkpoint's watermark).
   */
  async evidenceOf(
    jobId: string,
    copyKeys: ReadonlyArray<string>,
    after?: Date | null,
  ): Promise<JobEvidenceDoc[]> {
    return this.col.find(evidenceFilter(jobId, copyKeys, after ? { $gt: after } : undefined)).toArray();
  }

  /**
   * How many of the job's evidence documents are at or before `upTo` — the same filter as
   * `evidenceOf`, answered from the indexes alone (`by_copy_time`, `by_job_baseline`). A
   * checkpoint whose count differs has not folded everything up to its watermark.
   */
  countUpTo(jobId: string, copyKeys: ReadonlyArray<string>, upTo: Date): Promise<number> {
    return this.col.countDocuments(evidenceFilter(jobId, copyKeys, { $lte: upTo }));
  }

  async sourcesOf(ids: Iterable<string | null | undefined>): Promise<Map<string, SourceDoc>> {
    const wanted = [...new Set([...ids].filter((x): x is string => !!x))];
    if (!wanted.length) return new Map();
    const docs = await getCollection(this.ctx.db, sourcesCollection)
      .find({ _id: { $in: wanted } }, { projection: SOURCE_PROJECTION })
      .toArray();
    return new Map(docs.map((d) => [d._id, d as SourceDoc]));
  }

  /**
   * Re-derive every job named by evidence recorded since the sweep's watermark (DECISION_LOG
   * 9b0cb03, re-verify #11 M-A), so every job converges on the derivation of its evidence whether
   * or not the evidence's recorder re-derived it (a crash, a cancelled or exhausted step, a
   * concurrent writer that read before the insert) — CLOSED jobs included. Evidence is read in
   * record order (`createdAt`, `_id`; index `by_created`) in pages of `pageSize`; each page's jobs
   * (the job now holding each copy, else the one it was recorded against; deduplicated) are
   * re-derived, then the watermark moves past the page. It keeps going while behind, until it
   * catches up or `budgetMs` / `signal` stops it (the rest is left to the next sweep).
   *
   * Each job is isolated (re-verify #12 MEDIUM-1, final M1-M3): a job whose recompute fails is
   * logged and recorded at once in `market_job_lifecycle_failures` (one document per job:
   * failures, code, since, lastAt), before the watermark moves past its evidence; later sweeps
   * retry those first (least recently tried first, within the deadline) and the watermark moves
   * on regardless. After `EVIDENCE_SWEEP_REVIEW_AFTER` consecutive failures a `lifecycle_failure`
   * review is raised (job id and error code only); a success dismisses the open review
   * (`onLifecycleRecovered`) and then removes the document — kept while the dismissal fails, so it
   * is retried (M6.2 L1). The retry list gets at most half of `budgetMs`, and every pass reads at
   * least one page, so slow failing jobs never stop the watermark (M6.2 L4). With `runId`, each
   * job the sweep changes records the run (`job.lifecycle_rederived`, M6.2 MR2).
   *
   * Only evidence recorded at least `lagMs` ago is swept (default 5 minutes), by the database's
   * clock (`createdAt` is stamped by the server, and the cutoff is the server's time): a document
   * can become visible after a newer one (its insert still committing); the lag margin covers
   * that. A job whose evidence is swept is re-derived from ALL its evidence (the checkpoint's
   * count check), so re-sweeping is harmless.
   */
  async sweepRecordedEvidence(
    opts: {
      lagMs?: number;
      pageSize?: number;
      budgetMs?: number;
      signal?: AbortSignal;
      /** The run sweeping: each job it changes records it (`job.lifecycle_rederived`, M6.2 MR2). */
      runId?: string;
    } = {},
  ): Promise<EvidenceSweepResult> {
    const out: EvidenceSweepResult = {
      evidence: 0,
      jobs: 0,
      written: 0,
      complete: false,
      lagMs: null,
      retried: 0,
      failing: 0,
    };
    const serverNow = await this.serverNow();
    const upTo = new Date(serverNow.getTime() - (opts.lagMs ?? EVIDENCE_SWEEP_LAG_MS));
    const budgetMs = opts.budgetMs ?? 60_000;
    const started = Date.now();
    const deadline = started + budgetMs;
    // The retry list gets at most half the budget, so every pass also moves the watermark (M6.2 L4).
    const retryDeadline = started + budgetMs / 2;
    const sweeps = getCollection(this.ctx.db, jobEvidenceSweepsCollection);
    const mark = await sweeps.findOne({ _id: EVIDENCE_SWEEP_ID });
    let cursor = mark?.id ? { at: mark.at, id: mark.id } : null;
    const failed = getCollection(this.ctx.db, jobLifecycleFailuresCollection);
    const finish = async () => {
      out.failing = await failed.countDocuments({});
      // Caught up: no lag. Behind: how far the watermark trails the cutoff.
      const at = (await sweeps.findOne({ _id: EVIDENCE_SWEEP_ID }))?.at;
      out.lagMs = out.complete ? 0 : at ? Math.max(0, upTo.getTime() - at.getTime()) : null;
      return out;
    };
    const rederive = async (jobId: string) => {
      let result: RecomputeResult;
      try {
        result = await this.recompute(jobId, { schedule: { kind: 'sweep' } });
      } catch (err) {
        if (err instanceof NotFoundError) {
          await failed.deleteOne({ _id: jobId });
          return;
        }
        // Persisted at once, before the watermark can move past this job's evidence (re-verify
        // final M1-M3): one document per job, so nothing is capped, lost on an interrupt, or
        // erased by an overlapping sweep.
        const code = errorCode(err);
        const now = this.ctx.clock.now();
        const entry = await failed.findOneAndUpdate(
          { _id: jobId },
          { $inc: { failures: 1 }, $set: { code, lastAt: now }, $setOnInsert: { since: now } },
          { upsert: true, returnDocument: 'after' },
        );
        const failures = entry?.failures ?? 1;
        this.ctx.logger.warn(
          { jobId, code, failures },
          'job lifecycle re-derivation failed (kept for retry by later sweeps)',
        );
        if (failures >= EVIDENCE_SWEEP_REVIEW_AFTER)
          await this.raiseLifecycleFailure(jobId, code, failures, entry?.since ?? now);
        return;
      }
      if (result.written) out.written += 1;
      out.jobs += 1;
      try {
        await this.recordRunChange(opts.runId, result, 'recorded_evidence');
        await this.settleRecovery(jobId);
      } catch (err) {
        // The failure document (if any) is kept — at the back of the retry list (review L-b) — so
        // the next sweep retries the job and its recovery.
        await failed
          .updateOne({ _id: jobId }, { $set: { lastAt: this.ctx.clock.now() } })
          .catch(() => undefined);
        this.ctx.logger.warn(
          { jobId, err: errorCode(err) },
          'job re-derived, but its recovery bookkeeping failed (retried by a later sweep)',
        );
      }
    };
    // Jobs that failed before first — least recently tried first, within the deadline.
    const retry = await failed
      .find({}, { projection: { _id: 1 } })
      .sort({ lastAt: 1, _id: 1 })
      .limit(EVIDENCE_SWEEP_RETRY_PAGE)
      .toArray();
    for (const { _id } of retry) {
      opts.signal?.throwIfAborted();
      if (Date.now() > retryDeadline) break;
      out.retried += 1;
      await rederive(_id);
    }
    // At least one page per pass, whatever the retries took (M6.2 L4).
    for (let pages = 0; ; pages++) {
      opts.signal?.throwIfAborted();
      if (pages > 0 && Date.now() > deadline) return finish();
      const page = await this.col
        .find(
          {
            createdAt: { $lte: upTo },
            ...(cursor
              ? {
                  $or: [{ createdAt: { $gt: cursor.at } }, { createdAt: cursor.at, _id: { $gt: cursor.id } }],
                }
              : {}),
          },
          { projection: { _id: 1, jobId: 1, copyKey: 1, createdAt: 1 } },
        )
        .sort({ createdAt: 1, _id: 1 })
        .limit(opts.pageSize ?? 500)
        .toArray();
      if (!page.length) {
        out.complete = true;
        return finish();
      }
      const keys = [...new Set(page.map((e) => e.copyKey).filter((k): k is string => !!k))];
      const holders = new Map<string, string>();
      if (keys.length)
        for (const j of await this.jobs.col
          .find({ sourceKeys: { $in: keys }, status: 'active' }, { projection: { _id: 1, sourceKeys: 1 } })
          .toArray())
          for (const k of j.sourceKeys) holders.set(k, j._id);
      const jobIds = [...new Set(page.map((e) => (e.copyKey && holders.get(e.copyKey)) || e.jobId))];
      for (const jobId of jobIds) {
        opts.signal?.throwIfAborted();
        await rederive(jobId);
      }
      out.evidence += page.length;
      const last = page[page.length - 1]!;
      cursor = { at: last.createdAt, id: last._id };
      // Only ever forward (a concurrent sweep may be ahead); failing jobs are on the retry list.
      await sweeps.updateOne(
        { _id: EVIDENCE_SWEEP_ID },
        [
          {
            $set: {
              at: {
                $cond: [
                  { $or: [{ $lt: ['$at', cursor.at] }, { $eq: [{ $type: '$at' }, 'missing'] }] },
                  { $literal: cursor.at },
                  '$at',
                ],
              },
              id: {
                $cond: [
                  {
                    $or: [
                      { $lt: ['$at', cursor.at] },
                      { $eq: [{ $type: '$at' }, 'missing'] },
                      { $and: [{ $eq: ['$at', cursor.at] }, { $lt: ['$id', cursor.id] }] },
                    ],
                  },
                  { $literal: cursor.id },
                  '$id',
                ],
              },
              updatedAt: { $literal: this.ctx.clock.now() },
            },
          },
        ],
        { upsert: true },
      );
    }
  }

  /** Drop a job's checkpoint (it is rebuilt by the next recompute). */
  async dropCheckpoint(jobId: string): Promise<void> {
    await this.checkpoints.deleteOne({ _id: jobId });
  }

  /**
   * Widening of a job last written before derivation (no `lifecycle.derivedVersion`): each copy
   * without a recorded board adopts its source's current board when the endpoint did not change
   * since the copy was last seen (else its board is unknown, `null`), and the job gets a
   * conservative baseline — a positive at its `lastVerifiedAt`, the presence of its present copies
   * and its closure, never its absence runs or not_found streaks. Its history is carried over.
   * Idempotent (fixed keys, first write wins). This can delay a closure by one cycle: a legacy
   * absence run or not_found streak starts again from zero.
   */
  async widen(job: JobDoc, sources: Map<string, SourceDoc>): Promise<SourceRef[]> {
    const lc = job.lifecycle;
    const refs: SourceRef[] = [];
    for (const r of job.sourceRefs) {
      if (r.board !== undefined) {
        refs.push(r);
        continue;
      }
      const source = sources.get(r.sourceId);
      const adopt = source && !(await endpointChangedSince(this.ctx.db, source, r.lastSeenAt));
      refs.push({ ...r, board: adopt ? boardOfSource(source) : null });
    }
    const baseline: NewJobEvidence[] = [
      {
        _id: `baseline:${job._id}`,
        jobId: job._id,
        copyKey: null,
        sourceId: null,
        board: null,
        at: lc.lastVerifiedAt ?? lc.lastSeenAt,
        kind: 'baseline',
        outcome: lc.lastVerifiedAt ? 'live' : 'inconclusive',
        history: lc.history,
        ...(lc.lastChangedAt ? { lastChangedAt: lc.lastChangedAt } : {}),
      },
    ];
    // Every legacy copy was sighted before evidence was recorded: its next sighting after a closure
    // is a reopening, not a repost (the derivation reads that from the evidence only).
    for (const r of refs)
      baseline.push({
        _id: `baseline:${job._id}:${r.key}:seen`,
        jobId: job._id,
        copyKey: r.key,
        sourceId: r.sourceId,
        board: null,
        at: r.firstSeenAt,
        kind: 'baseline',
        outcome: 'inconclusive',
      });
    for (const r of refs)
      if (r.present && r.board)
        baseline.push({
          _id: `baseline:${job._id}:${r.key}`,
          jobId: job._id,
          copyKey: r.key,
          sourceId: r.sourceId,
          board: r.board,
          at: r.lastSeenAt,
          kind: 'baseline',
          outcome: 'present',
          contentHash: r.contentHash,
        });
    if (lc.state === 'CLOSED')
      baseline.push({
        _id: `baseline:${job._id}:closed`,
        jobId: job._id,
        copyKey: null,
        sourceId: null,
        board: null,
        at: lc.closedAt ?? lc.lastSeenAt,
        kind: 'baseline',
        outcome: 'closed',
        ...(lc.closeReason ? { reason: lc.closeReason } : {}),
      });
    await this.record(baseline);
    return refs;
  }

  /**
   * The fold of `job`'s evidence (its copies `refs`), reading only what its checkpoint has not
   * folded: a full fold when there is no usable checkpoint (none, another policy version, other
   * copies, a standing change up to its watermark) or when the evidence at or before its
   * watermark is not exactly what it folded (late evidence, however it was recorded — whether or
   * not its recorder ever recomputed: DECISION_LOG 9b0cb03). The new fold is stored as the
   * checkpoint (guarded).
   */
  private async fold(
    job: Pick<JobDoc, '_id' | 'lifecycle'>,
    refs: ReadonlyArray<SourceRef>,
    deriveJob: DeriveJob,
    sources: Map<string, SourceDoc>,
  ): Promise<{ state: FoldState; read: number }> {
    const copiesKey = JSON.stringify(
      [...refs]
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((r) => [r.key, r.sourceId, r.board ? boardIdentity(r.board) : null, r.authority, r.provider]),
    );
    const copyKeys = refs.map((r) => r.key);
    const cp = await this.checkpoints.findOne({ _id: job._id });
    let from = initialFoldState();
    if (
      cp &&
      cp.version === LIFECYCLE_POLICY_VERSION &&
      cp.copiesKey === copiesKey &&
      cp.standingKey === standingKey(sources, refs, cp.watermark) &&
      // Evidence is append-only: the same count up to the watermark is the same set.
      (await this.countUpTo(job._id, copyKeys, cp.watermark)) === cp.count
    )
      from = deserialize(cp.state);
    const evidence = await this.evidenceOf(job._id, copyKeys, from.watermark);
    const extra = evidence.map((e) => e.sourceId).filter((id): id is string => !!id && !sources.has(id));
    if (extra.length) for (const [id, doc] of await this.sourcesOf(extra)) sources.set(id, doc);
    const state = foldEvidence(from, evidence, sources, deriveJob, DEFAULT_LIFECYCLE_POLICY);
    const read = evidence.length;
    if (state.watermark)
      await this.storeCheckpoint(job._id, copiesKey, standingKey(sources, refs, state.watermark), state);
    return { state, read };
  }

  private async storeCheckpoint(
    jobId: string,
    copiesKey: string,
    standing: string,
    state: FoldState,
  ): Promise<void> {
    const watermark = state.watermark!;
    const doc = {
      version: LIFECYCLE_POLICY_VERSION,
      copiesKey,
      standingKey: standing,
      watermark,
      count: state.count,
      state: serialize(state),
      updatedAt: this.ctx.clock.now(),
    };
    try {
      // Never replace a checkpoint that folded more; a changed version/copies/standing always replaces.
      await this.checkpoints.updateOne(
        {
          _id: jobId,
          $or: [
            { version: { $ne: LIFECYCLE_POLICY_VERSION } },
            { copiesKey: { $ne: copiesKey } },
            { standingKey: { $ne: standing } },
            { watermark: { $lt: watermark } },
            { watermark, count: { $lte: state.count } },
          ],
        },
        { $set: doc },
        { upsert: true },
      );
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err; // a checkpoint that folded more is kept
    }
  }

  /**
   * The lifecycle/verification update for `job` whose copies will be `refs` (widening a legacy
   * job first, unless the caller already did): folds its evidence, derives at `now`, and returns
   * the `$set` / `$unset` to write in the caller's compare-and-set on the job's revision. Empty
   * when nothing changes.
   */
  async projectionUpdate(
    job: JobDoc,
    refs: SourceRef[],
    schedule?: RecomputeSchedule,
    copyData: { publishedAt?: Date } = {},
  ): Promise<{
    $set: Record<string, unknown>;
    $unset: Record<string, ''>;
    derivation: Derivation;
    read: number;
  }> {
    const sources = await this.sourcesOf(refs.map((r) => r.sourceId));
    if (!job.lifecycle.derivedVersion && refs.some((r) => r.board === undefined))
      refs = await this.widen({ ...job, sourceRefs: refs }, sources);
    const deriveJob: DeriveJob = {
      copies: refs,
      firstSeenAt: job.lifecycle.firstSeenAt,
      lastSeenAt: lastSeenOf(job.lifecycle, refs),
    };
    const { state, read } = await this.fold(job, refs, deriveJob, sources);
    const now = this.ctx.clock.now();
    // The sources' disable events after the last evidence, up to now (not checkpointed).
    const tail = foldEvidence(state, [], sources, deriveJob, DEFAULT_LIFECYCLE_POLICY, now);
    const derivation = finalizeFold(tail, now, deriveJob, DEFAULT_LIFECYCLE_POLICY);
    const lifecycle: JobLifecycle = projection(
      job.lifecycle,
      refs,
      derivation.lifecycle,
      copyData.publishedAt,
    );
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ''> = {};
    if (!isDeepStrictEqual(lifecycle, job.lifecycle)) $set.lifecycle = lifecycle;
    if (!isDeepStrictEqual(refs, job.sourceRefs)) $set.sourceRefs = refs;
    const latest = derivation.latestVerification;
    if (latest && !sameTime(job.verification?.lastVerifiedAt, latest.at))
      $set['verification.lastVerifiedAt'] = latest.at;
    if (latest && job.verification?.lastOutcome !== latest.outcome)
      $set['verification.lastOutcome'] = latest.outcome;
    const due = nextDue(job, lifecycle, derivation, schedule, now);
    if (due === null) {
      if (job.verification?.nextVerificationDueAt) $unset['verification.nextVerificationDueAt'] = '';
    } else if (due && !sameTime(job.verification?.nextVerificationDueAt, due))
      $set['verification.nextVerificationDueAt'] = due;
    return { $set, $unset, derivation, read };
  }

  /**
   * Recompute the job's lifecycle projection from its evidence under its revision fence
   * (retrying on a concurrent write). A legacy job is widened once, first, so `mutate` sees its
   * copies' boards. `mutate` returns the copies to write in the same compare-and-set (re-run on
   * every retry with the job as re-read); null means nothing to do. When the caller's record
   * inserted evidence (`recorded.inserted`), the write always happens (it bumps the revision),
   * even if the projection is unchanged. The stored `lifecycle` and `verification` stay a
   * projection of the evidence, so the API and its DTOs are unchanged.
   */
  async recompute(
    jobId: string,
    opts: {
      mutate?: (job: JobDoc) => SourceRef[] | null | undefined;
      schedule?: RecomputeSchedule;
      recorded?: RecordedEvidence;
    } = {},
  ): Promise<RecomputeResult> {
    for (let attempt = 0; attempt < RECOMPUTE_ATTEMPTS; attempt++) {
      // The survivor, never a merged record (an over-long or broken chain is a conflict: M6.2 MR3).
      const stored = await this.jobs.resolveSurvivor(jobId);
      const job = stored.lifecycle.derivedVersion
        ? stored
        : {
            ...stored,
            sourceRefs: await this.widen(
              stored,
              await this.sourcesOf(stored.sourceRefs.map((r) => r.sourceId)),
            ),
          };
      const refs = opts.mutate ? opts.mutate(job) : undefined;
      if (refs === null && !opts.recorded?.inserted)
        return { before: stored, after: stored, written: false, read: 0 };
      const { $set, $unset, read } = await this.projectionUpdate(
        stored,
        refs ?? job.sourceRefs,
        opts.schedule,
      );
      if (!Object.keys($set).length && !Object.keys($unset).length && !opts.recorded?.inserted)
        return { before: stored, after: stored, written: false, read };
      $set.updatedAt = this.ctx.clock.now();
      const ok = await this.jobs.casUpdate(
        stored,
        { $set, ...(Object.keys($unset).length ? { $unset } : {}) },
        { status: 'active' },
      );
      if (ok) return { before: stored, after: await this.jobs.get(stored._id), written: true, read };
      // A concurrent write won: back off (jittered, exponential) so a storm of writers spreads out.
      await sleep(Math.random() * Math.min(RECOMPUTE_MAX_BACKOFF_MS, 5 * 2 ** attempt));
    }
    // Still contended: the step fails and its node retries. Nothing is lost — the evidence is
    // recorded (a retry records nothing new), and every later recompute of the job folds it.
    throw new RecomputeContentionError(jobId);
  }
}

const RECOMPUTE_ATTEMPTS = 16;
/** Who re-derived a job in a run (the audit events of `recordRunChange`). */
export const LIFECYCLE_DERIVATION_ACTOR: Actor = { kind: 'system', id: 'market-lifecycle' } as Actor;
/** Failed jobs the recorded-evidence sweep retries per pass (least recently tried first). */
export const EVIDENCE_SWEEP_RETRY_PAGE = 500;
/** Consecutive failures of one job before a `lifecycle_failure` review is raised. */
export const EVIDENCE_SWEEP_REVIEW_AFTER = 3;

export interface EvidenceSweepResult {
  evidence: number;
  jobs: number;
  written: number;
  /** Caught up with all evidence older than the lag margin. */
  complete: boolean;
  /** How far the watermark trails the sweep's cutoff (ms; 0 when caught up, null before any page). */
  lagMs: number | null;
  /** Previously failed jobs retried. */
  retried: number;
  /** Jobs whose re-derivation is failing after this sweep (`market_job_lifecycle_failures`). */
  failing: number;
}

/** An error's code for logs and reviews (never its message, which may carry data). */
function errorCode(err: unknown): string {
  const e = err as { code?: unknown; codeName?: unknown; name?: unknown };
  if (typeof e?.codeName === 'string') return e.codeName;
  if (typeof e?.code === 'string' || typeof e?.code === 'number') return String(e.code);
  return typeof e?.name === 'string' ? e.name : 'unknown';
}
/** Evidence younger than this is left to a later sweep (see `sweepRecordedEvidence`). */
export const EVIDENCE_SWEEP_LAG_MS = 5 * 60_000;
const EVIDENCE_SWEEP_ID = 'recorded_evidence';
const RECOMPUTE_MAX_BACKOFF_MS = 250;

/** A recompute that lost every compare-and-set to concurrent writers (retryable: the node retries). */
export class RecomputeContentionError extends Error {
  constructor(readonly jobId: string) {
    super(`Job ${jobId}: lifecycle recompute did not converge (persistent write contention)`);
    this.name = 'RecomputeContentionError';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The evidence of a job: its copies' (by copy key) and its own job-level baseline, optionally
 * restricted in time. `evidenceOf` and `countUpTo` use exactly this filter.
 */
export function evidenceFilter(
  jobId: string,
  copyKeys: ReadonlyArray<string>,
  at?: { $gt: Date } | { $lte: Date },
) {
  const time = at ? { at } : {};
  return {
    $or: [
      { copyKey: { $in: [...copyKeys] }, ...time },
      { jobId, kind: 'baseline' as const, copyKey: null, ...time },
    ],
  };
}

/** The sources' standing (and immutable authority) up to `watermark`: a change there voids a checkpoint. */
function standingKey(
  sources: ReadonlyMap<string, SourceStanding & { _id?: string }>,
  refs: ReadonlyArray<SourceRef>,
  watermark: Date,
): string {
  const ids = [...new Set(refs.map((r) => r.sourceId))].sort();
  return JSON.stringify(
    ids.map((id) => {
      const s = sources.get(id);
      if (!s) return [id, null];
      const history = (s.standingHistory ?? []).filter((h) => h.at.getTime() <= watermark.getTime());
      return [
        id,
        s.authority.tier,
        s.authority.listingIsComplete ?? null,
        s.provider,
        s.category,
        history.length ? history.map((h) => [h.at.getTime(), h.enabled]) : s.enabled,
      ];
    }),
  );
}

const MAP_FIELDS = ['status', 'latest', 'sightingBoard', 'contentHash', 'firstSighting'] as const;

/** A fold state for storage: maps as entry arrays (copy keys may contain dots). */
function serialize(state: FoldState): Record<string, unknown> {
  const out: Record<string, unknown> = { ...state };
  for (const f of MAP_FIELDS) out[f] = Object.entries(state[f]);
  return out;
}

function deserialize(raw: Record<string, unknown>): FoldState {
  const out = { ...initialFoldState(), ...raw } as unknown as Record<string, unknown>;
  for (const f of MAP_FIELDS) out[f] = Object.fromEntries((raw[f] as Array<[string, unknown]>) ?? []);
  return out as unknown as FoldState;
}

function sameTime(a: Date | null | undefined, b: Date | null | undefined): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

function lastSeenOf(lc: Pick<JobLifecycle, 'lastSeenAt'>, refs: ReadonlyArray<SourceRef>): Date {
  let latest = lc.lastSeenAt;
  for (const r of refs) if (r.lastSeenAt > latest) latest = r.lastSeenAt;
  return latest;
}

/** The stored lifecycle: copy data (first/last seen, published) plus the derived fields. */
export function projection(
  current: Pick<JobLifecycle, 'firstSeenAt' | 'lastSeenAt' | 'publishedAt'>,
  refs: ReadonlyArray<SourceRef>,
  derived: DerivedLifecycle,
  publishedAt?: Date,
): JobLifecycle {
  const published = current.publishedAt ?? publishedAt;
  return {
    ...derived,
    firstSeenAt: current.firstSeenAt,
    lastSeenAt: lastSeenOf(current, refs),
    ...(published ? { publishedAt: published } : {}),
  };
}

/**
 * The next verification due time: `null` clears it (closed), `undefined` keeps it. After an
 * applied verification that is the job's latest: its normal cadence, sooner (6 h) after an
 * inconclusive one. A job that became POSSIBLY_STALE otherwise is due at once (listing: at the
 * listing's time).
 */
function nextDue(
  before: JobDoc,
  lc: JobLifecycle,
  d: Derivation,
  schedule: RecomputeSchedule | undefined,
  now: Date,
): Date | null | undefined {
  if (lc.state === 'CLOSED') return null;
  if (schedule?.kind === 'verification') {
    if (d.latestVerification?.id !== schedule.evidenceId) return undefined;
    return d.latestVerification.outcome === 'inconclusive'
      ? new Date(now.getTime() + 6 * 3600_000)
      : nextVerificationDue(lc.lastVerifiedAt ?? lc.lastSeenAt);
  }
  if (lc.state === 'POSSIBLY_STALE' && before.lifecycle.state !== 'POSSIBLY_STALE')
    return schedule?.kind === 'listing' ? schedule.at : now;
  return undefined;
}
