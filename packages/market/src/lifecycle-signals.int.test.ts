import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY_MS } from '@aptamind/contracts';
import { createTestInfra, type TestInfra } from '@aptamind/testing';
import type { MarketContext } from './context';
import { LifecycleSignalWriter } from './signals/lifecycle-signals';

/** OPS-4: lifecycle signals from recorded transitions, with evidence, idempotent. */
let infra: TestInfra;
let ctx: MarketContext;
const t0 = new Date('2026-03-01T00:00:00Z');
const t1 = new Date('2026-03-05T00:00:00Z');
const t2 = new Date('2026-03-09T00:00:00Z');

beforeAll(async () => {
  infra = await createTestInfra('lifecycle_signals');
  ctx = {
    db: infra.db,
    clock: { now: () => new Date() },
    logger: infra.logger,
    artifacts: infra.artifacts,
  } as MarketContext;
  await infra.db.collection('market_jobs').insertMany([
    {
      _id: 'job_a',
      companyId: 'co_1',
      updatedAt: t2,
      lifecycle: {
        history: [
          { at: t0, from: null, to: 'DISCOVERED', reason: 'listing', sourceId: 'src_1' },
          { at: t0, from: 'DISCOVERED', to: 'VERIFIED_LIVE', reason: 'listing', sourceId: 'src_1' },
          { at: t1, from: 'VERIFIED_LIVE', to: 'CLOSED', reason: 'absent', sourceId: 'src_1' },
          { at: t2, from: 'CLOSED', to: 'REOPENED', reason: 'listing', sourceId: 'src_1' },
          { at: t2, from: 'REOPENED', to: 'CHANGED', reason: 'decay' }, // no source: no signal
        ],
      },
    },
  ] as never[]);
  await infra.db.collection('market_job_evidence').insertMany([
    { _id: 'jev_1', jobId: 'job_a', sourceId: 'src_1', at: t0, snapshotId: 'snap_1' },
    { _id: 'jev_2', jobId: 'job_a', sourceId: 'src_1', at: t1, snapshotId: 'snap_2' },
  ] as never[]);
});
afterAll(async () => {
  await infra?.cleanup();
});

describe('lifecycle signals (OPS-4)', () => {
  it('writes one evidence-bearing signal per vocabulary transition; replay is a no-op', async () => {
    const w = new LifecycleSignalWriter(ctx);
    const r = await w.run();
    expect(r.written).toBe(3);
    const sigs = await infra.db.collection('market_signals').find({}).sort({ occurredAt: 1 }).toArray();
    expect(sigs.map((s) => s.type)).toEqual(['job_discovered', 'job_closed', 'job_reopened']);
    expect(sigs[0]!.evidence[0]).toMatchObject({
      sourceId: 'src_1',
      snapshotId: 'snap_1',
      locator: 'job_evidence:jev_1',
    });
    expect(sigs[0]!.facts.evidenceIds).toEqual(['jev_1']);
    expect(sigs[0]!.confidence.level).toBe('high');
    expect(sigs[2]!.confidence.level).toBe('medium'); // no evidence record at t2
    expect(sigs.every((s) => s.companyIds[0] === 'co_1')).toBe(true);

    const again = await w.run({ since: null });
    expect(again.written).toBe(0);
    expect(again.existing).toBe(3);
    expect(await infra.db.collection('market_signals').countDocuments()).toBe(3);
    expect(await w.cursor()).not.toBeNull();
  });

  it('resumes after the stored job watermark when maxJobs is smaller than the backlog', async () => {
    const w = new LifecycleSignalWriter(ctx);
    const base = new Date('2026-04-01T00:00:00.000Z');
    const at = (days: number) => new Date(base.getTime() + days * DAY_MS);
    await infra.db.collection('market_jobs').insertMany(
      [1, 2, 3, 4].map((n) => ({
        _id: `job_w${n}`,
        companyId: 'co_1',
        updatedAt: at(n),
        lifecycle: {
          history: [{ at: at(n), from: null, to: 'DISCOVERED', reason: 'listing', sourceId: 'src_1' }],
        },
      })) as never[],
    );

    const first = await w.run({ maxJobs: 2 });
    expect(first.scannedJobs).toBe(2);
    expect(first.written).toBe(2);
    expect(await w.cursor()).toEqual(at(2));

    const second = await w.run({ maxJobs: 2 });
    expect(second.scannedJobs).toBe(2);
    expect(second.written).toBe(2);
    expect(await w.cursor()).toEqual(at(4));
    expect(
      await infra.db
        .collection('market_signals')
        .countDocuments({
          type: 'job_discovered',
          'facts.jobId': { $in: ['job_w1', 'job_w2', 'job_w3', 'job_w4'] },
        }),
    ).toBe(4);

    // A job already passed in the keyset, then updated, is scanned on the next pass.
    const bumped = at(10);
    await infra.db.collection('market_jobs').updateOne(
      { _id: 'job_w1' } as never,
      {
        $set: { updatedAt: bumped },
        $push: {
          'lifecycle.history': {
            at: bumped,
            from: 'DISCOVERED',
            to: 'CLOSED',
            reason: 'absent',
            sourceId: 'src_1',
          },
        },
      } as never,
    );
    const third = await w.run({ maxJobs: 2 });
    expect(third.scannedJobs).toBe(1);
    expect(third.written).toBe(1);
    expect(await w.cursor()).toEqual(bumped);
    expect(
      await infra.db.collection('market_signals').findOne({ type: 'job_closed', 'facts.jobId': 'job_w1' }),
    ).toMatchObject({ facts: { to: 'CLOSED' } });
  });
});
