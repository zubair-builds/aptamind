import { getCollection } from '@aptamind/db';
import type { MarketContext } from '../context';
import { type RETENTION_HOLD_REASONS, snapshotsCollection, type SnapshotDoc } from '../observations/schemas';
import { sourcesCollection } from '../sources/source.schema';
import { artifactReferenceHold, snapshotHoldReason } from './artifact-references';
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

export interface RetentionPurgeResult {
  scanned: number;
  deletable: number;
  deleted: number;
  keptReferenced: number;
  dryRun: boolean;
}

/**
 * OPS-3 retention sweep over Market snapshots, and the FE-4 purge of released bytes.
 * A snapshot past `expiresAt` is released only when nothing still needs it; otherwise it is
 * held and its expiry extended:
 *  - it is the latest snapshot of its source (the unchanged-content comparison and replay read it);
 *  - an open review item cites it as evidence (held to at least the review-evidence TTL);
 *  - a current (non-superseded) observation came from it;
 *  - `market_job_evidence.snapshotId` cites it (a close or change can outlive the observation);
 *  - a market signal's evidence cites it;
 *  - canonical company or job fact evidence (or a legacy job `listingMarks` entry) cites it.
 * Pinned snapshots are never selected. Releasing sets `expiredAt` only; the snapshot record and
 * every observation stay (history is never destroyed, no dangling evidence references).
 *
 * The release is check-then-write. After `expiredAt` is set, `holdReason` is read again and the
 * release is reverted when a citation appeared in between. `purgeReleased` deletes the raw bytes
 * only when every snapshot of that artifact is released and unpinned, none of them is held for
 * any hold reason, and no other market document stores the artifact id. That check runs again
 * inside `ArtifactStore.deleteBytes`, immediately before the object delete, so a reverted
 * release blocks deletion. A citation that lands after that immediate check can still drop
 * bytes (residual race). A delete sets `bytesDeletedAt` on the released snapshots.
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
    return snapshotHoldReason(this.ctx.db, s);
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

  /**
   * Delete bytes of artifacts cited by released snapshots. `limit` is how many distinct
   * artifact ids to consider (kept ones count). Dry-run counts and writes nothing.
   * The reference check runs again inside `ArtifactStore.deleteBytes`, immediately before
   * the object delete. It re-reads `expiredAt` and `holdReason` for every snapshot that
   * shares the artifact, so a refetch or a reverted release wins.
   */
  async purgeReleased(opts: { limit?: number; dryRun?: boolean } = {}): Promise<RetentionPurgeResult> {
    const limit = opts.limit ?? 500;
    const dryRun = opts.dryRun ?? false;
    const now = this.ctx.clock.now();
    const ids = await this.releasedArtifactIds(limit);
    let deletable = 0;
    let deleted = 0;
    let keptReferenced = 0;
    for (const artifactId of ids) {
      if (await this.bytesHeld(artifactId)) {
        keptReferenced += 1;
        continue;
      }
      deletable += 1;
      if (dryRun) continue;
      const outcome = await this.ctx.artifacts.deleteBytes(artifactId, (id) => this.bytesHeld(id));
      if (outcome !== 'deleted') {
        // Re-check refused, or the artifact document is already gone.
        deletable -= 1;
        if (outcome === 'referenced') keptReferenced += 1;
        else await this.markBytesDeleted(artifactId, now);
        continue;
      }
      deleted += 1;
      await this.markBytesDeleted(artifactId, now);
    }
    const result = { scanned: ids.length, deletable, deleted, keptReferenced, dryRun };
    this.ctx.logger.info(result, 'market retention purge');
    return result;
  }

  /** Distinct artifact ids on released snapshots whose bytes have not been deleted yet. */
  private async releasedArtifactIds(limit: number): Promise<string[]> {
    if (limit <= 0) return [];
    const cursor = this.snapshots
      .find(
        { expiredAt: { $exists: true }, bytesDeletedAt: { $exists: false } },
        { projection: { 'artifact.artifactId': 1 } },
      )
      .sort({ expiredAt: 1, _id: 1 });
    const ids: string[] = [];
    const seen = new Set<string>();
    try {
      for await (const s of cursor) {
        const id = s.artifact?.artifactId;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length >= limit) break;
      }
    } finally {
      await cursor.close();
    }
    return ids;
  }

  private bytesHeld(artifactId: string): Promise<boolean> {
    return artifactReferenceHold(this.ctx.db, artifactId).then((reason) => reason !== null);
  }

  private async markBytesDeleted(artifactId: string, at: Date): Promise<void> {
    await this.snapshots.updateMany(
      {
        'artifact.artifactId': artifactId,
        expiredAt: { $exists: true },
        bytesDeletedAt: { $exists: false },
      },
      { $set: { bytesDeletedAt: at, updatedAt: at } },
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
