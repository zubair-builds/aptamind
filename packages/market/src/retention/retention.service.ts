import { getCollection } from '@aptamind/db';
import type { MarketContext } from '../context';
import {
  companyObservationsCollection,
  jobObservationsCollection,
  snapshotsCollection,
} from '../observations/schemas';
import type { SnapshotDoc } from '../observations/schemas';
import { reviewItemsCollection } from '../review/schemas';
import { sourcesCollection } from '../sources/source.schema';
import { expiresAtFor, RETENTION_POLICY_VERSION, RETENTION_TTL_MS, retentionClassFor } from './policy';

export type HoldReason = NonNullable<SnapshotDoc['retentionHold']>['reason'];

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
 *  - a current (non-superseded) observation came from it — that observation backs canonical facts.
 * Pinned snapshots are never selected. Releasing sets `expiredAt` only; the snapshot record and
 * every observation stay (history is never destroyed, no dangling evidence references). Deleting
 * the raw bytes waits for an ArtifactStore delete (Foundation Exception, not in this change).
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
    return null;
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
    const held: Record<HoldReason, number> = { latest_of_source: 0, open_review: 0, current_observation: 0 };
    let released = 0;
    for (const s of due) {
      const reason = await this.holdReason(s);
      if (reason) {
        held[reason] += 1;
        if (dryRun) continue;
        const ttl =
          reason === 'open_review'
            ? RETENTION_TTL_MS.review_evidence
            : RETENTION_TTL_MS[s.retentionClass ?? 'web_snapshot'];
        // Guarded on the expiry we read: a concurrent fetch that extended it wins.
        await this.snapshots.updateOne(
          { _id: s._id, expiresAt: s.expiresAt },
          {
            $set: {
              expiresAt: new Date(now.getTime() + ttl),
              retentionHold: { at: now, reason },
              ...(reason === 'open_review' ? { retentionClass: 'review_evidence' as const } : {}),
            },
          },
        );
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
      released += r.modifiedCount;
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
