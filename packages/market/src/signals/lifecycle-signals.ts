import { deterministicId } from '@aptamind/contracts';
import { getCollection, isDuplicateKeyError } from '@aptamind/db';
import type { MarketContext } from '../context';
import { jobEvidenceCollection } from '../jobs/evidence';
import { jobsCollection, type JobState } from '../jobs/job.schema';
import { SIGNAL_SCHEMA_VERSION, type SignalDoc, signalsCollection } from './schemas';

export const LIFECYCLE_SIGNAL_WRITER = 'lifecycle/1';

/** Lifecycle transitions that are signals (VERIFIED_LIVE / POSSIBLY_STALE are not events). */
export const LIFECYCLE_SIGNAL_TYPE: Partial<Record<JobState, SignalDoc['type']>> = {
  DISCOVERED: 'job_discovered',
  CHANGED: 'job_changed',
  CLOSED: 'job_closed',
  REOPENED: 'job_reopened',
  REPOSTED: 'job_reposted',
};

/** Overlap re-read behind the cursor, so a job written while the previous pass ran is not missed. */
const CURSOR_OVERLAP_MS = 2 * 60 * 60_000;

export interface LifecycleSignalResult {
  scannedJobs: number;
  written: number;
  existing: number;
  since: Date | null;
}

/**
 * OPS-4: writes one signal per job lifecycle transition in the v1 vocabulary. Derived from the
 * transition history the lifecycle already records (no new writer inside the CAS paths), with a
 * deterministic id and dedupe key (job, target state, transition time): a replay or an overlapping
 * pass records nothing new. Each signal carries the transition's source and evidence id; a
 * transition without a source is skipped (no evidence, no signal). Signals are append-only: a
 * later re-derivation that drops a transition does not delete its signal.
 */
export class LifecycleSignalWriter {
  constructor(private readonly ctx: MarketContext) {}

  private get signals() {
    return getCollection(this.ctx.db, signalsCollection);
  }

  async cursor(): Promise<Date | null> {
    const last = await this.signals
      .find({ 'facts.writer': LIFECYCLE_SIGNAL_WRITER }, { projection: { createdAt: 1 } })
      .sort({ createdAt: -1 })
      .limit(1)
      .next();
    return last ? new Date(last.createdAt.getTime() - CURSOR_OVERLAP_MS) : null;
  }

  async run(
    opts: { since?: Date | null; batch?: number; maxJobs?: number } = {},
  ): Promise<LifecycleSignalResult> {
    const since = opts.since !== undefined ? opts.since : await this.cursor();
    const batch = opts.batch ?? 500;
    const maxJobs = opts.maxJobs ?? 20_000;
    const jobs = getCollection(this.ctx.db, jobsCollection);
    let after: { updatedAt: Date; _id: string } | null = null;
    const out: LifecycleSignalResult = { scannedJobs: 0, written: 0, existing: 0, since };
    while (out.scannedJobs < maxJobs) {
      const filter: Record<string, unknown> = {};
      if (since) filter.updatedAt = { $gte: since };
      if (after) {
        filter.$or = [
          { updatedAt: { $gt: after.updatedAt } },
          { updatedAt: after.updatedAt, _id: { $gt: after._id } },
        ];
      }
      const page = await jobs
        .find(filter, {
          projection: { _id: 1, companyId: 1, updatedAt: 1, 'lifecycle.history': 1, title: 1 },
        })
        .sort({ updatedAt: 1, _id: 1 })
        .limit(batch)
        .toArray();
      if (!page.length) break;
      for (const j of page) {
        out.scannedJobs += 1;
        for (const t of j.lifecycle?.history ?? []) {
          const type = LIFECYCLE_SIGNAL_TYPE[t.to];
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
      const last = page[page.length - 1]!;
      after = { updatedAt: last.updatedAt, _id: last._id };
      if (page.length < batch) break;
    }
    this.ctx.logger.info({ ...out }, 'market lifecycle signals');
    return out;
  }
}
