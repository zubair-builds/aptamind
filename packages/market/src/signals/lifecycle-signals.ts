import { deterministicId } from '@aptamind/contracts';
import { getCollection, isDuplicateKeyError } from '@aptamind/db';
import type { MarketContext } from '../context';
import { jobEvidenceCollection } from '../jobs/evidence';
import { jobsCollection, type JobDoc, type JobState } from '../jobs/job.schema';
import {
  LIFECYCLE_SIGNAL_CURSOR_ID,
  SIGNAL_SCHEMA_VERSION,
  type SignalDoc,
  signalWriterCursorsCollection,
  signalsCollection,
} from './schemas';

export const LIFECYCLE_SIGNAL_WRITER = 'lifecycle/1';

/**
 * Lifecycle transitions that are signals. `VERIFIED_LIVE` is not a signal type, except the first
 * transition in the history when it is that state: an authoritative ATS listing records the first
 * sighting as `VERIFIED_LIVE` (`first seen on authoritative source`) and never as `DISCOVERED`.
 * `POSSIBLY_STALE` is not an event.
 */
export const LIFECYCLE_SIGNAL_TYPE: Partial<Record<JobState, SignalDoc['type']>> = {
  DISCOVERED: 'job_discovered',
  CHANGED: 'job_changed',
  CLOSED: 'job_closed',
  REOPENED: 'job_reopened',
  REPOSTED: 'job_reposted',
};

/**
 * Jobs whose `updatedAt` falls in this window at or before the stored watermark are re-read each
 * pass. A job updated while the previous pass was scanning can keep an `updatedAt` behind the
 * watermark; dedupe keys make the re-read a no-op when the transition was already signaled.
 * The re-read does not consume the forward budget and does not move the watermark.
 */
const CURSOR_OVERLAP_MS = 2 * 60 * 60_000;

export interface LifecycleSignalResult {
  scannedJobs: number;
  written: number;
  existing: number;
  /** Watermark time this pass resumed after, or the explicit `since` override. */
  since: Date | null;
}

type ScannedJob = Pick<JobDoc, '_id' | 'companyId' | 'updatedAt'> & {
  lifecycle?: { history?: JobDoc['lifecycle']['history'] };
};

/**
 * OPS-4: writes one signal per job lifecycle transition in the v1 vocabulary. Derived from the
 * transition history the lifecycle already records (no new writer inside the CAS paths), with a
 * deterministic id and dedupe key (job, target state, transition time): a replay or an overlapping
 * pass records nothing new. Each signal carries the transition's source and evidence id; a
 * transition without a source is skipped (no evidence, no signal). Signals are append-only: a
 * later re-derivation that drops a transition does not delete its signal.
 *
 * Progress is a stored `(updatedAt, _id)` watermark of the last job actually scanned, not the
 * newest signal's `createdAt`. A pass that stops at `maxJobs` continues after that job next time.
 * The watermark moves only forward, and only for jobs this pass scanned.
 */
export class LifecycleSignalWriter {
  constructor(private readonly ctx: MarketContext) {}

  private get signals() {
    return getCollection(this.ctx.db, signalsCollection);
  }
  private get cursors() {
    return getCollection(this.ctx.db, signalWriterCursorsCollection);
  }
  private get jobs() {
    return getCollection(this.ctx.db, jobsCollection);
  }

  /** The `updatedAt` of the last job this writer scanned, or null before the first pass. */
  async cursor(): Promise<Date | null> {
    return (await this.jobWatermark())?.updatedAt ?? null;
  }

  private async jobWatermark(): Promise<{ updatedAt: Date; _id: string } | null> {
    const doc = await this.cursors.findOne({ _id: LIFECYCLE_SIGNAL_CURSOR_ID });
    if (!doc?.jobUpdatedAt || !doc.jobId) return null;
    return { updatedAt: doc.jobUpdatedAt, _id: doc.jobId };
  }

  private async saveJobWatermark(job: { updatedAt: Date; _id: string }): Promise<void> {
    await this.cursors.updateOne(
      { _id: LIFECYCLE_SIGNAL_CURSOR_ID },
      {
        $set: {
          jobUpdatedAt: job.updatedAt,
          jobId: job._id,
          updatedAt: this.ctx.clock.now(),
        },
      },
      { upsert: true },
    );
  }

  async run(
    opts: { since?: Date | null; batch?: number; maxJobs?: number } = {},
  ): Promise<LifecycleSignalResult> {
    // An explicit `since` (including null) is a caller override and does not move the watermark.
    const explicit = opts.since !== undefined;
    const stored = explicit ? null : await this.jobWatermark();
    const batch = opts.batch ?? 500;
    const maxJobs = opts.maxJobs ?? 20_000;
    const out: LifecycleSignalResult = {
      scannedJobs: 0,
      written: 0,
      existing: 0,
      since: explicit ? (opts.since ?? null) : (stored?.updatedAt ?? null),
    };
    if (stored) await this.rereadOverlap(stored, out, batch);
    let after = stored;
    while (out.scannedJobs < maxJobs) {
      const room = Math.min(batch, maxJobs - out.scannedJobs);
      const page = await this.jobs
        .find(this.forwardFilter(after, explicit ? (opts.since ?? null) : null), {
          projection: { _id: 1, companyId: 1, updatedAt: 1, 'lifecycle.history': 1 },
        })
        .sort({ updatedAt: 1, _id: 1 })
        .limit(room)
        .toArray();
      if (!page.length) break;
      for (const j of page) {
        out.scannedJobs += 1;
        await this.writeJob(j, out);
      }
      const last = page[page.length - 1]!;
      after = { updatedAt: last.updatedAt, _id: last._id };
      if (!explicit) await this.saveJobWatermark(last);
      if (page.length < room) break;
    }
    this.ctx.logger.info({ ...out }, 'market lifecycle signals');
    return out;
  }

  /**
   * Re-read the overlap behind the watermark, paging until it is exhausted. Does not count
   * toward `maxJobs` and does not move the watermark. Dedupe keys make a repeat a no-op.
   */
  private async rereadOverlap(
    wm: { updatedAt: Date; _id: string },
    out: LifecycleSignalResult,
    batch: number,
  ): Promise<void> {
    const floor = new Date(wm.updatedAt.getTime() - CURSOR_OVERLAP_MS);
    let before: { updatedAt: Date; _id: string } | null = null;
    for (;;) {
      const and: Record<string, unknown>[] = [
        { updatedAt: { $gte: floor } },
        {
          $or: [{ updatedAt: { $lt: wm.updatedAt } }, { updatedAt: wm.updatedAt, _id: { $lte: wm._id } }],
        },
      ];
      if (before) {
        and.push({
          $or: [
            { updatedAt: { $lt: before.updatedAt } },
            { updatedAt: before.updatedAt, _id: { $lt: before._id } },
          ],
        });
      }
      const page = await this.jobs
        .find({ $and: and }, { projection: { _id: 1, companyId: 1, updatedAt: 1, 'lifecycle.history': 1 } })
        .sort({ updatedAt: -1, _id: -1 })
        .limit(batch)
        .toArray();
      for (const j of page) await this.writeJob(j, out);
      if (page.length < batch) break;
      const last = page[page.length - 1]!;
      before = { updatedAt: last.updatedAt, _id: last._id };
    }
  }

  private forwardFilter(
    after: { updatedAt: Date; _id: string } | null,
    since: Date | null,
  ): Record<string, unknown> {
    const and: Record<string, unknown>[] = [];
    if (since) and.push({ updatedAt: { $gte: since } });
    if (after) {
      and.push({
        $or: [
          { updatedAt: { $gt: after.updatedAt } },
          { updatedAt: after.updatedAt, _id: { $gt: after._id } },
        ],
      });
    }
    if (and.length === 0) return {};
    if (and.length === 1) return and[0]!;
    return { $and: and };
  }

  private async writeJob(j: ScannedJob, out: LifecycleSignalResult): Promise<void> {
    const history = j.lifecycle?.history ?? [];
    for (let i = 0; i < history.length; i++) {
      const t = history[i]!;
      const type = lifecycleSignalType(history, i);
      if (!type || !t.sourceId) continue;
      const dedupeKey = `job:${j._id}:${t.to}:${t.at.toISOString()}`;
      if (await this.signals.findOne({ dedupeKey }, { projection: { _id: 1 } })) {
        out.existing += 1;
        continue;
      }
      // The job evidence the transition was derived from (same job, source and time).
      const ev = await getCollection(this.ctx.db, jobEvidenceCollection)
        .find({ jobId: j._id, at: t.at, sourceId: t.sourceId }, { projection: { _id: 1, snapshotId: 1 } })
        .limit(5)
        .toArray();
      const now = this.ctx.clock.now();
      const doc: SignalDoc = {
        _id: deterministicId('sig', dedupeKey),
        type,
        companyIds: [j.companyId],
        sourceId: t.sourceId,
        evidence: ev.length
          ? ev.map((e) => ({
              sourceId: t.sourceId!,
              ...(e.snapshotId ? { snapshotId: e.snapshotId } : {}),
              locator: `job_evidence:${e._id}`,
              observedAt: t.at,
            }))
          : [{ sourceId: t.sourceId, locator: `job:${j._id}#lifecycle.history`, observedAt: t.at }],
        occurredAt: t.at,
        observedAt: t.at,
        facts: {
          writer: LIFECYCLE_SIGNAL_WRITER,
          jobId: j._id,
          from: t.from,
          to: t.to,
          reason: t.reason,
          evidenceIds: ev.map((e) => e._id),
        },
        confidence: ev.length
          ? { level: 'high', reasons: ['lifecycle transition derived from recorded job evidence'] }
          : {
              level: 'medium',
              reasons: ['lifecycle transition; its evidence record was not found by job id'],
            },
        state: 'new',
        dedupeKey,
        schemaVersion: SIGNAL_SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await this.signals.insertOne(doc);
        out.written += 1;
      } catch (e) {
        if (!isDuplicateKeyError(e)) throw e;
        out.existing += 1;
      }
    }
  }
}

/** Signal type for history entry `index`, or undefined when the transition is not an event. */
function lifecycleSignalType(
  history: ReadonlyArray<{ to: JobState }>,
  index: number,
): SignalDoc['type'] | undefined {
  const to = history[index]!.to;
  // The first sourced sighting on an authoritative board is VERIFIED_LIVE, not DISCOVERED.
  if (to === 'VERIFIED_LIVE' && index === 0) return 'job_discovered';
  return LIFECYCLE_SIGNAL_TYPE[to];
}
