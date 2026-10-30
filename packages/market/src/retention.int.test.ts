import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY_MS } from '@aptamind/contracts';
import { createTestInfra, type TestInfra } from '@aptamind/testing';
import type { MarketContext } from './context';
import { ObservationService } from './observations/observation.service';
import { RetentionService } from './retention/retention.service';

/** OPS-3: retention metadata on snapshots and the reference-checking expiry sweep. */
let infra: TestInfra;
let now = new Date('2026-01-01T00:00:00Z');
let ctx: MarketContext;
let obs: ObservationService;
let ret: RetentionService;

beforeAll(async () => {
  infra = await createTestInfra('retention');
  ctx = {
    db: infra.db,
    clock: { now: () => now },
    logger: infra.logger,
    artifacts: infra.artifacts,
  } as MarketContext;
  obs = new ObservationService(ctx);
  ret = new RetentionService(ctx);
  await infra.db.collection('market_sources').insertMany([
    { _id: 'src_web', category: 'job_source', authority: { tier: 'company_controlled' } },
    { _id: 'src_reg', category: 'company_universe', authority: { tier: 'official_registry' } },
  ] as never[]);
});
afterAll(async () => {
  await infra?.cleanup();
});

async function snap(sourceId: string, content: string) {
  const artifact = await infra.artifacts.put(
    new TextEncoder().encode(`${sourceId}:${content}`),
    'text/plain',
  );
  return (await obs.recordSnapshot({ sourceId, artifact, via: 'http' })).snapshot;
}
const at = (d: number) => new Date(Date.UTC(2026, 0, 1) + d * DAY_MS);
const get = (id: string) => obs.snapshots.findOne({ _id: id });

describe('retention (OPS-3)', () => {
  it('classifies and dates new snapshots; a refetch extends expiry', async () => {
    now = at(0);
    const w = await snap('src_web', 'a');
    const r = await snap('src_reg', 'a');
    expect(w.retentionClass).toBe('web_snapshot');
    expect(w.expiresAt).toEqual(at(30));
    expect(r.retentionClass).toBe('register_snapshot');
    expect(r.expiresAt).toEqual(at(365));
    now = at(10);
    await snap('src_web', 'a');
    expect((await get(w._id))?.expiresAt).toEqual(at(40));
  });

  it('releases only unreferenced expired snapshots; holds the rest', async () => {
    now = at(100);
    const old1 = await snap('src_web', 'old-free');
    const old2 = await snap('src_web', 'old-review');
    const old3 = await snap('src_web', 'old-current-obs');
    const old4 = await snap('src_web', 'old-superseded-obs');
    const old5 = await snap('src_web', 'old-pinned');
    now = at(101);
    const latest = await snap('src_web', 'latest');
    await infra.db.collection('market_review_items').insertOne({
      _id: 'rev_1',
      status: 'open',
      dedupeKey: 'k1',
      evidence: [{ sourceId: 'src_web', snapshotId: old2._id, observedAt: now }],
    } as never);
    await infra.db.collection('market_job_observations').insertMany([
      { _id: 'o1', sourceId: 'src_web', snapshotId: old3._id },
      { _id: 'o2', sourceId: 'src_web', snapshotId: old4._id, superseded: true },
    ] as never[]);
    await ret.pin(old5._id, 'dispute');

    now = at(200); // everything web is past 30 d
    const dry = await ret.sweep({ dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect((await get(old1._id))?.expiredAt).toBeUndefined();

    const res = await ret.sweep();
    const released = new Set(
      (await obs.snapshots.find({ expiredAt: { $exists: true } }).toArray()).map((s) => s._id),
    );
    expect(released.has(old1._id)).toBe(true);
    expect(released.has(old4._id)).toBe(true); // only a superseded observation
    expect(released.has(old2._id)).toBe(false);
    expect(released.has(old3._id)).toBe(false);
    expect(released.has(old5._id)).toBe(false);
    expect(released.has(latest._id)).toBe(false);
    expect(res.held.open_review).toBe(1);
    expect(res.held.current_observation).toBe(1);
    expect(res.held.latest_of_source).toBe(1);

    const r2 = await get(old2._id);
    expect(r2?.retentionClass).toBe('review_evidence');
    expect(r2?.expiresAt).toEqual(new Date(at(200).getTime() + 180 * DAY_MS));
    // Records are never deleted.
    expect(await get(old1._id)).not.toBeNull();

    // Replay: nothing new is due.
    const again = await ret.sweep();
    expect(again.released).toBe(0);
    expect(again.scanned).toBe(0);
  });

  it('backfills snapshots stored before OPS-3', async () => {
    await infra.db.collection('market_snapshots').insertOne({
      _id: 'snap_legacy',
      sourceId: 'src_reg',
      via: 'http',
      lastFetchedAt: at(0),
      contentHash: 'legacy',
    } as never);
    now = at(400);
    expect(await ret.backfill()).toBe(1);
    const l = await get('snap_legacy');
    expect(l?.retentionClass).toBe('register_snapshot');
    expect(l?.expiresAt).toEqual(at(365));
  });

  it('holds a snapshot cited only by job evidence, a signal, or a canonical fact', async () => {
    await infra.db.collection('market_sources').insertOne({
      _id: 'src_cite',
      category: 'job_source',
      authority: { tier: 'company_controlled' },
    } as never);
    now = at(500);
    const jobEv = await snap('src_cite', 'only-job-evidence');
    const sigEv = await snap('src_cite', 'only-signal');
    const companyFact = await snap('src_cite', 'only-company-fact');
    const jobFact = await snap('src_cite', 'only-job-fact');
    now = at(501);
    const latest = await snap('src_cite', 'cite-latest');
    await infra.db.collection('market_job_evidence').insertOne({
      _id: 'jev_hold',
      jobId: 'job_hold',
      snapshotId: jobEv._id,
    } as never);
    await infra.db.collection('market_signals').insertOne({
      _id: 'sig_hold',
      evidence: [{ sourceId: 'src_cite', snapshotId: sigEv._id, observedAt: now }],
    } as never);
    await infra.db.collection('market_companies').insertOne({
      _id: 'co_hold',
      identity: {
        displayName: { evidence: [{ sourceId: 'src_cite', snapshotId: companyFact._id, observedAt: now }] },
      },
    } as never);
    await infra.db.collection('market_jobs').insertOne({
      _id: 'job_fact_hold',
      identity: {
        title: { evidence: [{ sourceId: 'src_cite', snapshotId: jobFact._id, observedAt: now }] },
      },
    } as never);

    now = at(600);
    const res = await ret.sweep();
    expect((await get(jobEv._id))?.expiredAt).toBeUndefined();
    expect((await get(sigEv._id))?.expiredAt).toBeUndefined();
    expect((await get(companyFact._id))?.expiredAt).toBeUndefined();
    expect((await get(jobFact._id))?.expiredAt).toBeUndefined();
    expect((await get(latest._id))?.expiredAt).toBeUndefined();
    expect((await get(jobEv._id))?.retentionHold?.reason).toBe('job_evidence');
    expect((await get(sigEv._id))?.retentionHold?.reason).toBe('signal_evidence');
    expect((await get(companyFact._id))?.retentionHold?.reason).toBe('canonical_fact');
    expect((await get(jobFact._id))?.retentionHold?.reason).toBe('canonical_fact');
    expect((await get(latest._id))?.retentionHold?.reason).toBe('latest_of_source');
    expect(res.held.job_evidence).toBeGreaterThanOrEqual(1);
    expect(res.held.signal_evidence).toBeGreaterThanOrEqual(1);
    expect(res.held.canonical_fact).toBeGreaterThanOrEqual(2);
  });
});
