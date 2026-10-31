import { getCollection } from '@aptamind/db';
import { companiesCollection } from '../companies/company.schema';
import type { MarketContext } from '../context';
import { jobEvidenceCollection } from '../jobs/evidence';
import { jobsCollection } from '../jobs/job.schema';
import {
  companyObservationsCollection,
  jobObservationsCollection,
  RETENTION_HOLD_REASONS,
  snapshotsCollection,
  type SnapshotDoc,
} from '../observations/schemas';
import { reviewItemsCollection } from '../review/schemas';
import { signalsCollection } from '../signals/schemas';
import { sourcesCollection } from '../sources/source.schema';
import { expiresAtFor, RETENTION_POLICY_VERSION, RETENTION_TTL_MS, retentionClassFor } from './policy';

export type HoldReason = (typeof RETENTION_HOLD_REASONS)[number];

export interface RetentionSweepResult {
  policyVersion: string;
  scanned: number;
  backfilled: number;
  released: number;
  held: Record<HoldReason, number>;
  dryRun: boolean;
}

/**
 * OPS-3 retention sweep over Market snapshots. A snapshot past `expiresAt` is released only when
 * nothing still needs it; otherwise it is held and its expiry extended:
 *  - it is the latest snapshot of its source (the unchanged-content comparison and replay read it);
 *  - an open review item cites it as evidence (held to at least the review-evidence TTL);
 *  - a current (non-superseded) observation came from it;
 *  - `market_job_evidence.snapshotId` cites it (a close or change can outlive the observation);
 *  - a market signal's evidence cites it;
 *  - canonical company or job fact evidence (or a legacy job `listingMarks` entry) cites it.
 * Pinned snapshots are never selected. Releasing sets `expiredAt` only; the snapshot record and
 * every observation stay (history is never destroyed, no dangling evidence references). Deleting
 * the raw bytes waits for an ArtifactStore delete (Foundation Exception, not in this change).
 *
 * The release is check-then-write. After `expiredAt` is set, `holdReason` is read again and the
 * release is reverted when a citation appeared in between. Two windows remain (the residual race):
 * a citation inserted after that re-check, and a byte delete (FE-4) that observes `expiredAt`
 * before the revert lands. Either can still drop bytes a later citation needed.
 */
export class RetentionService {
  constructor(private readonly ctx: MarketContext) {}

  private get snapshots() {
    return getCollection(this.ctx.db, snapshotsCollection);
  }

  /** Give snapshots stored before OPS-3 a class and expiry (from their last fetch). */
  async backfill(limit = 1000): Promise<number> {
    const legacy = await this.snapshots
      .find(
        { retentionClass: { $exists: false } },
        { projection: { _id: 1, sourceId: 1, via: 1, lastFetchedAt: 1 } },
      )
      .limit(limit)
      .toArray();
    if (!legacy.length) return 0;
    const sources = getCollection(this.ctx.db, sourcesCollection);
    const srcIds = [...new Set(legacy.map((s) => s.sourceId))];
    const srcs = await sources
      .find({ _id: { $in: srcIds } }, { projection: { category: 1, 'authority.tier': 1 } })
      .toArray();
    const byId = new Map(srcs.map((s) => [s._id, s]));
    let n = 0;
    for (const s of legacy) {
      const src = byId.get(s.sourceId);
      const cls = retentionClassFor({
        via: s.via,
        category: src?.category,
        authorityTier: src?.authority?.tier,
      });
      const r = await this.snapshots.updateOne(
        { _id: s._id, retentionClass: { $exists: false } },
        { $set: { retentionClass: cls, expiresAt: expiresAtFor(cls, s.lastFetchedAt) } },
      );
      n += r.modifiedCount;
    }
    return n;
  }

  async holdReason(s: Pick<SnapshotDoc, '_id' | 'sourceId'>): Promise<HoldReason | null> {
    const latest = await this.snapshots
      .find({ sourceId: s.sourceId }, { projection: { _id: 1 } })
      .sort({ lastFetchedAt: -1, _id: -1 })
      .limit(1)
      .next();
    if (latest?._id === s._id) return 'latest_of_source';
    const review = await getCollection(this.ctx.db, reviewItemsCollection).findOne(
      { 'evidence.snapshotId': s._id, status: 'open' },
      { projection: { _id: 1 } },
    );
    if (review) return 'open_review';
    const current = { snapshotId: s._id, superseded: { $ne: true } };
    const obs =
      (await getCollection(this.ctx.db, companyObservationsCollection).findOne(current, {
        projection: { _id: 1 },
      })) ??
      (await getCollection(this.ctx.db, jobObservationsCollection).findOne(current, {
        projection: { _id: 1 },
      }));
    if (obs) return 'current_observation';
    const evidence = await getCollection(this.ctx.db, jobEvidenceCollection).findOne(
      { snapshotId: s._id },
      { projection: { _id: 1 } },
    );
    if (evidence) return 'job_evidence';
    const signal = await getCollection(this.ctx.db, signalsCollection).findOne(
      { 'evidence.snapshotId': s._id },
      { projection: { _id: 1 } },
    );
    if (signal) return 'signal_evidence';
    if (await this.citedByCanonicalFact(s._id)) return 'canonical_fact';
    return null;
  }

  /** Company or job fact evidence, or a legacy job listing mark, names this snapshot. */
  private async citedByCanonicalFact(snapshotId: string): Promise<boolean> {
    const company = await getCollection(this.ctx.db, companiesCollection).findOne(
      factSnapshotFilter(COMPANY_FACT_PATHS, COMPANY_EVIDENCE_PATHS, snapshotId),
      { projection: { _id: 1 } },
    );
    if (company) return true;
    const job = await getCollection(this.ctx.db, jobsCollection).findOne(
      {
        $or: [
          ...factSnapshotClauses(JOB_FACT_PATHS, snapshotId, true),
          { $expr: listingMarkCites(snapshotId) },
        ],
      },
      { projection: { _id: 1 } },
    );
    return !!job;
  }

  async sweep(opts: { limit?: number; dryRun?: boolean } = {}): Promise<RetentionSweepResult> {
    const limit = opts.limit ?? 500;
    const dryRun = opts.dryRun ?? false;
    const now = this.ctx.clock.now();
    const backfilled = dryRun ? 0 : await this.backfill();
    const due = await this.snapshots
      .find(
        { expiresAt: { $lte: now }, pinned: { $ne: true }, expiredAt: { $exists: false } },
        { projection: { _id: 1, sourceId: 1, retentionClass: 1, expiresAt: 1 } },
      )
      .sort({ expiresAt: 1 })
      .limit(limit)
      .toArray();
    const held = emptyHeld();
    let released = 0;
    for (const s of due) {
      const reason = await this.holdReason(s);
      if (reason) {
        held[reason] += 1;
        if (!dryRun) await this.hold(s, reason, now);
        continue;
      }
      if (dryRun) {
        released += 1;
        continue;
      }
      const r = await this.snapshots.updateOne(
        { _id: s._id, expiresAt: s.expiresAt, pinned: { $ne: true }, expiredAt: { $exists: false } },
        { $set: { expiredAt: now, updatedAt: now } },
      );
      if (!r.modifiedCount) continue;
      // A review, observation, or evidence row inserted after the pre-check still wins.
      const again = await this.holdReason(s);
      if (!again) {
        released += 1;
        continue;
      }
      await this.revertRelease(s, again, now);
      held[again] += 1;
    }
    const result = {
      policyVersion: RETENTION_POLICY_VERSION,
      scanned: due.length,
      backfilled,
      released,
      held,
      dryRun,
    };
    this.ctx.logger.info({ ...result }, 'market retention sweep');
    return result;
  }

  private holdTtl(s: { retentionClass?: SnapshotDoc['retentionClass'] }, reason: HoldReason): number {
    return reason === 'open_review'
      ? RETENTION_TTL_MS.review_evidence
      : RETENTION_TTL_MS[s.retentionClass ?? 'web_snapshot'];
  }

  private holdSet(s: { retentionClass?: SnapshotDoc['retentionClass'] }, reason: HoldReason, now: Date) {
    return {
      expiresAt: new Date(now.getTime() + this.holdTtl(s, reason)),
      retentionHold: { at: now, reason },
      ...(reason === 'open_review' ? { retentionClass: 'review_evidence' as const } : {}),
    };
  }

  /** Guarded on the expiry we read: a concurrent fetch that extended it wins. */
  private async hold(
    s: Pick<SnapshotDoc, '_id' | 'expiresAt' | 'retentionClass'>,
    reason: HoldReason,
    now: Date,
  ): Promise<void> {
    await this.snapshots.updateOne(
      { _id: s._id, expiresAt: s.expiresAt },
      { $set: this.holdSet(s, reason, now) },
    );
  }

  /** Undo a release that lost the race with a new citation. See the class comment for what remains. */
  private async revertRelease(
    s: Pick<SnapshotDoc, '_id' | 'retentionClass'>,
    reason: HoldReason,
    now: Date,
  ): Promise<void> {
    await this.snapshots.updateOne(
      { _id: s._id, expiredAt: now },
      { $set: { ...this.holdSet(s, reason, now), updatedAt: now }, $unset: { expiredAt: '' } },
    );
  }

  async pin(snapshotId: string, reason: string): Promise<boolean> {
    const r = await this.snapshots.updateOne(
      { _id: snapshotId },
      { $set: { pinned: true, pinnedReason: reason, updatedAt: this.ctx.clock.now() } },
    );
    return r.matchedCount === 1;
  }

  async unpin(snapshotId: string): Promise<boolean> {
    const r = await this.snapshots.updateOne(
      { _id: snapshotId },
      { $unset: { pinned: '', pinnedReason: '' }, $set: { updatedAt: this.ctx.clock.now() } },
    );
    return r.matchedCount === 1;
  }
}

function emptyHeld(): Record<HoldReason, number> {
  return {
    latest_of_source: 0,
    open_review: 0,
    current_observation: 0,
    job_evidence: 0,
    signal_evidence: 0,
    canonical_fact: 0,
  };
}

/** Fact paths (`path.evidence` and `path.conflicts.evidence`) on a canonical company. */
const COMPANY_FACT_PATHS = [
  'identity.displayName',
  'identity.legalName',
  'identity.domain',
  'identity.website',
  'classification.industries',
  'classification.stage',
  'classification.businessModel',
  'firmographics.foundedYear',
  'firmographics.employeeEstimate',
  'firmographics.employeeRange',
  'firmographics.fundingStage',
  'geography.headquarters',
  'geography.hiringCountries',
  'employment.careersUrls',
  'employment.ats',
  'employment.remotePolicy',
  'employment.sponsorship.capability',
  'employment.relocationSupport',
  'employment.eorIndicators',
];

/** Arrays of `{ evidence }` that are not facts (licences, history, schemes, people). */
const COMPANY_EVIDENCE_PATHS = [
  'classification.schemes',
  'employment.sponsorship.licences',
  'employment.sponsorship.history',
  'organization.founders',
  'organization.leadership',
];

/** Fact paths on a canonical job. */
const JOB_FACT_PATHS = [
  'identity.title',
  'identity.roleFamily',
  'identity.specialization',
  'identity.department',
  'identity.seniority',
  'employment.employmentType',
  'geography.workModel',
  'geography.remoteScope',
  'geography.officeAttendance',
  'immigration.sponsorship',
  'immigration.authorization',
  'immigration.relocation',
  'compensation',
  'requirements',
  'responsibilities',
];

function factSnapshotClauses(
  paths: readonly string[],
  snapshotId: string,
  withConflicts: boolean,
): Record<string, string>[] {
  const or: Record<string, string>[] = [];
  for (const p of paths) {
    or.push({ [`${p}.evidence.snapshotId`]: snapshotId });
    if (withConflicts) or.push({ [`${p}.conflicts.evidence.snapshotId`]: snapshotId });
  }
  return or;
}

function factSnapshotFilter(
  facts: readonly string[],
  evidenceArrays: readonly string[],
  snapshotId: string,
): { $or: Record<string, string>[] } {
  return {
    $or: [
      ...factSnapshotClauses(facts, snapshotId, true),
      ...factSnapshotClauses(evidenceArrays, snapshotId, false),
    ],
  };
}

/** True when any legacy `lifecycle.listingMarks` value names this snapshot. */
function listingMarkCites(snapshotId: string) {
  return {
    $gt: [
      {
        $size: {
          $filter: {
            input: { $objectToArray: { $ifNull: ['$lifecycle.listingMarks', {}] } },
            as: 'm',
            cond: { $eq: ['$$m.v.snapshotId', snapshotId] },
          },
        },
      },
      0,
    ],
  };
}
