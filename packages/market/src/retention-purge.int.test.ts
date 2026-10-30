import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestInfra, type TestInfra } from '@aptamind/testing';
import { ArtifactDeletedError } from '@aptamind/storage';
import type { MarketContext } from './context';
import { ObservationService } from './observations/observation.service';
import type { SnapshotDoc } from './observations/schemas';
import { artifactReferenceHold } from './retention/artifact-references';
import { RetentionService } from './retention/retention.service';

/**
 * FE-4 purge of released artifact bytes.
 * One database, in source order: later counts include artifacts earlier tests left referenced
 * (a pinned snapshot and open reviews stay candidates). Sweep is not used to release.
 * Each release is followed by a newer snapshot of the same source, so `latest_of_source` is
 * not what keeps or drops the artifact under test. A snapshot `holdReason` still holds (job
 * evidence, signal evidence, canonical fact) is not deleted even when `expiredAt` is set, and
 * a release that was reverted is not deleted.
 */
let infra: TestInfra;
let now = new Date('2026-06-01T00:00:00Z');
let ctx: MarketContext;
let obs: ObservationService;
let ret: RetentionService;

beforeAll(async () => {
  infra = await createTestInfra('retention_purge');
  ctx = {
    db: infra.db,
    clock: { now: () => now },
    logger: infra.logger,
    artifacts: infra.artifacts,
  } as MarketContext;
  obs = new ObservationService(ctx);
  ret = new RetentionService(ctx);
  await infra.db.collection('market_sources').insertMany([
    { _id: 'src_a', category: 'job_source', authority: { tier: 'company_controlled' } },
    { _id: 'src_b', category: 'job_source', authority: { tier: 'company_controlled' } },
  ] as never[]);
});
afterAll(async () => {
  await infra?.cleanup();
});

async function snap(sourceId: string, content: string) {
  const artifact = await infra.artifacts.put(new TextEncoder().encode(content), 'text/plain');
  return (await obs.recordSnapshot({ sourceId, artifact, via: 'http' })).snapshot;
}
const get = (id: string) => obs.snapshots.findOne({ _id: id });
let newer = 0;
/** A later fetch of the same source, so the snapshot under test is not `latest_of_source`. */
async function supersede(sourceId: string) {
  newer += 1;
  now = new Date(now.getTime() + 1000);
  return snap(sourceId, `newer-${sourceId}-${newer}`);
}
async function release(s: { _id: string; sourceId: string }) {
  await supersede(s.sourceId);
  await obs.snapshots.updateOne({ _id: s._id }, { $set: { expiredAt: now, updatedAt: now } });
}

describe('retention purge (FE-4)', { concurrent: false, shuffle: false }, () => {
  it('dry-run counts and deletes nothing; a live purge deletes once; a refetch restores the bytes', async () => {
    const body = 'happy-body';
    const s = await snap('src_a', body);
    await release(s);

    const dry = await ret.purgeReleased({ dryRun: true });
    expect(dry).toEqual({ scanned: 1, deletable: 1, deleted: 0, keptReferenced: 0, dryRun: true });
    expect(await infra.storage.exists(s.artifact.storageKey)).toBe(true);
    expect((await get(s._id))?.bytesDeletedAt).toBeUndefined();
    expect(await infra.artifacts.readText(s.artifact)).toBe(body);

    const live = await ret.purgeReleased();
    expect(live).toEqual({ scanned: 1, deletable: 1, deleted: 1, keptReferenced: 0, dryRun: false });
    await expect(infra.artifacts.readBytes(s.artifact)).rejects.toBeInstanceOf(ArtifactDeletedError);
    const released = await get(s._id);
    expect(released).not.toBeNull();
    expect(released?.bytesDeletedAt).toEqual(now);
    // createTestInfra builds ArtifactStore with the system clock.
    expect((await infra.artifacts.get(s.artifact.artifactId)).deletedAt).toBeInstanceOf(Date);

    expect(await ret.purgeReleased()).toEqual({
      scanned: 0,
      deletable: 0,
      deleted: 0,
      keptReferenced: 0,
      dryRun: false,
    });

    const again = await snap('src_a', body);
    expect(again._id).toBe(s._id);
    expect(again.artifact.artifactId).toBe(s.artifact.artifactId);
    expect(again.expiredAt).toBeUndefined();
    expect(again.bytesDeletedAt).toBeUndefined();
    expect(await infra.artifacts.readText(again.artifact)).toBe(body);
    expect((await infra.artifacts.get(again.artifact.artifactId)).deletedAt).toBeUndefined();
    expect(await infra.storage.exists(again.artifact.storageKey)).toBe(true);
  });

  it('does not delete while any snapshot of the same artifact is unreleased', async () => {
    const body = 'shared-body';
    const a = await snap('src_a', body);
    const b = await snap('src_b', body);
    expect(a.artifact.artifactId).toBe(b.artifact.artifactId);
    expect(a._id).not.toBe(b._id);
    await release(a);

    const held = await ret.purgeReleased();
    expect(held).toEqual({ scanned: 1, deletable: 0, deleted: 0, keptReferenced: 1, dryRun: false });
    expect(await infra.artifacts.readText(a.artifact)).toBe(body);
    expect((await get(a._id))?.bytesDeletedAt).toBeUndefined();
    expect((await get(b._id))?.expiredAt).toBeUndefined();

    await release(b);
    const gone = await ret.purgeReleased();
    expect(gone).toEqual({ scanned: 1, deletable: 1, deleted: 1, keptReferenced: 0, dryRun: false });
    await expect(infra.artifacts.readBytes(a.artifact)).rejects.toBeInstanceOf(ArtifactDeletedError);
    expect((await get(a._id))?.bytesDeletedAt).toEqual(now);
    expect((await get(b._id))?.bytesDeletedAt).toEqual(now);
    expect(await get(a._id)).not.toBeNull();
  });

  it('does not delete a pinned snapshot', async () => {
    const body = 'pinned-body';
    const s = await snap('src_a', body);
    await release(s);
    expect(await ret.pin(s._id, 'dispute')).toBe(true);

    const res = await ret.purgeReleased();
    expect(res).toEqual({ scanned: 1, deletable: 0, deleted: 0, keptReferenced: 1, dryRun: false });
    expect(await infra.artifacts.readText(s.artifact)).toBe(body);
    expect((await get(s._id))?.bytesDeletedAt).toBeUndefined();
  });

  it('keeps bytes an open review cites and deletes bytes cited only by a dismissed review', async () => {
    const cited = await snap('src_a', 'review-cited');
    const reported = await snap('src_b', 'review-report');
    const dismissed = await snap('src_a', 'review-dismissed');
    await release(cited);
    await release(reported);
    await release(dismissed);
    await infra.db.collection('market_review_items').insertMany([
      {
        _id: 'rev_cited',
        status: 'open',
        evidence: [{ artifactId: cited.artifact.artifactId, sourceId: 'src_a', observedAt: now }],
      },
      {
        _id: 'rev_report',
        status: 'open',
        context: { reportArtifactId: reported.artifact.artifactId },
        evidence: [],
      },
      {
        _id: 'rev_dismissed',
        status: 'dismissed',
        evidence: [{ artifactId: dismissed.artifact.artifactId, sourceId: 'src_a', observedAt: now }],
      },
    ] as never[]);

    // Still a candidate from the pin test, plus these three.
    const res = await ret.purgeReleased();
    expect(res).toEqual({ scanned: 4, deletable: 1, deleted: 1, keptReferenced: 3, dryRun: false });
    expect(await infra.artifacts.readText(cited.artifact)).toBe('review-cited');
    expect(await infra.artifacts.readText(reported.artifact)).toBe('review-report');
    await expect(infra.artifacts.readBytes(dismissed.artifact)).rejects.toBeInstanceOf(ArtifactDeletedError);
    expect((await get(cited._id))?.bytesDeletedAt).toBeUndefined();
    expect((await get(reported._id))?.bytesDeletedAt).toBeUndefined();
  });

  it('keeps artifact ids and snapshot holds, and deletes a released snapshot nothing cites', async () => {
    const keepers: Array<{ body: string; cite: (artifactId: string) => Promise<unknown> }> = [
      {
        body: 'obs-body',
        cite: (artifactId) =>
          infra.db.collection('market_job_observations').insertOne({ _id: 'obs_hold', artifactId } as never),
      },
      {
        body: 'import-body',
        cite: (artifactId) =>
          infra.db.collection('market_imports').insertOne({ _id: 'imp_hold', artifactId } as never),
      },
      {
        body: 'job-desc-body',
        cite: (artifactId) =>
          infra.db
            .collection('market_jobs')
            .insertOne({ _id: 'job_hold', content: { descriptionArtifactId: artifactId } } as never),
      },
      {
        body: 'company-body',
        cite: (artifactId) =>
          infra.db.collection('market_companies').insertOne({
            _id: 'co_hold',
            identity: { displayName: { evidence: [{ artifactId }] } },
          } as never),
      },
      {
        body: 'verify-body',
        cite: (artifactId) =>
          infra.db.collection('market_job_verifications').insertOne({ _id: 'ver_hold', artifactId } as never),
      },
      {
        body: 'board-body',
        cite: (artifactId) =>
          infra.db.collection('market_audit_events').insertOne({
            _id: 'aud_hold',
            details: { boardArtifactId: artifactId },
          } as never),
      },
      {
        body: 'signal-body',
        cite: (artifactId) =>
          infra.db.collection('market_signals').insertOne({
            _id: 'sig_hold',
            evidence: [{ artifactId }],
          } as never),
      },
    ];
    const held: Array<{ snapshot: SnapshotDoc; body: string }> = [];
    for (const k of keepers) {
      const s = await snap(held.length % 2 === 0 ? 'src_a' : 'src_b', k.body);
      await release(s);
      await k.cite(s.artifact.artifactId);
      held.push({ snapshot: s, body: k.body });
    }
    const snapshotHolds: Array<{
      body: string;
      reason: string;
      cite: (snapshotId: string) => Promise<unknown>;
    }> = [
      {
        body: 'job-evidence-body',
        reason: 'job_evidence',
        cite: (snapshotId) =>
          infra.db.collection('market_job_evidence').insertOne({ _id: 'jev_snap_hold', snapshotId } as never),
      },
      {
        body: 'signal-snapshot-body',
        reason: 'signal_evidence',
        cite: (snapshotId) =>
          infra.db.collection('market_signals').insertOne({
            _id: 'sig_snap_hold',
            evidence: [{ snapshotId }],
          } as never),
      },
      {
        body: 'company-fact-body',
        reason: 'canonical_fact',
        cite: (snapshotId) =>
          infra.db.collection('market_companies').insertOne({
            _id: 'co_snap_hold',
            identity: { displayName: { evidence: [{ snapshotId }] } },
          } as never),
      },
      {
        body: 'job-fact-body',
        reason: 'canonical_fact',
        cite: (snapshotId) =>
          infra.db.collection('market_jobs').insertOne({
            _id: 'job_snap_hold',
            identity: { title: { evidence: [{ snapshotId }] } },
          } as never),
      },
    ];
    const heldBySnapshot: Array<{ snapshot: SnapshotDoc; body: string; reason: string }> = [];
    for (const k of snapshotHolds) {
      const s = await snap(heldBySnapshot.length % 2 === 0 ? 'src_a' : 'src_b', k.body);
      await release(s);
      await k.cite(s._id);
      expect(await artifactReferenceHold(infra.db, s.artifact.artifactId)).toBe(k.reason);
      heldBySnapshot.push({ snapshot: s, body: k.body, reason: k.reason });
    }

    const reverted = await snap('src_a', 'reverted-body');
    await release(reverted);
    await obs.snapshots.updateOne({ _id: reverted._id }, { $unset: { expiredAt: '' } });
    expect(await artifactReferenceHold(infra.db, reverted.artifact.artifactId)).toBe('snapshot_unreleased');

    const free = await snap('src_b', 'free-to-purge');
    await release(free);
    expect(await artifactReferenceHold(infra.db, free.artifact.artifactId)).toBeNull();

    // Pinned snapshot plus the two open reviews are still candidates. The reverted release is not.
    const baseline = 3;
    const res = await ret.purgeReleased();
    expect(res).toEqual({
      scanned: baseline + keepers.length + snapshotHolds.length + 1,
      deletable: 1,
      deleted: 1,
      keptReferenced: baseline + keepers.length + snapshotHolds.length,
      dryRun: false,
    });
    for (const s of [...held, ...heldBySnapshot]) {
      expect(await infra.artifacts.readText(s.snapshot.artifact)).toBe(s.body);
      expect((await get(s.snapshot._id))?.bytesDeletedAt).toBeUndefined();
    }
    expect(await infra.artifacts.readText(reverted.artifact)).toBe('reverted-body');
    expect((await get(reverted._id))?.bytesDeletedAt).toBeUndefined();
    expect((await get(reverted._id))?.expiredAt).toBeUndefined();
    await expect(infra.artifacts.readBytes(free.artifact)).rejects.toBeInstanceOf(ArtifactDeletedError);
    expect(await get(free._id)).not.toBeNull();
    expect((await get(free._id))?.bytesDeletedAt).toEqual(now);
  });
});
