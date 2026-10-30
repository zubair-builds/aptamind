import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS } from '@aptamind/contracts';
import { createTestInfra, type TestInfra } from '@aptamind/testing';
import type { MarketContext } from './context';
import { COMPANY_CHANGE_SIGNAL_WRITER, CompanyChangeSignalWriter } from './signals/company-change-signals';

/**
 * OPS-4: canonical company-change signals. The first pass of a company records a baseline and
 * writes nothing; later passes emit evidence-bearing diffs and are idempotent.
 */
let infra: TestInfra;
let writer: CompanyChangeSignalWriter;
/** Mutable clock. Acceleration dedupe is the epoch week containing this instant. */
let now = new Date('2026-06-15T12:00:00.000Z');
const evidenceAt = new Date('2026-06-01T00:00:00.000Z');
const openingSeen = new Date('2026-05-01T00:00:00.000Z');
const expansionSeen = new Date('2026-06-10T00:00:00.000Z');

function companyDoc(
  id: string,
  capability: string,
  capabilityEvidence: Array<{ sourceId: string; observedAt: Date }>,
) {
  return {
    _id: id,
    status: 'active',
    employment: {
      sponsorship: { capability: { value: capability, evidence: capabilityEvidence } },
      remotePolicy: {
        value: 'hybrid',
        evidence: [{ sourceId: 'src_1', observedAt: evidenceAt }],
      },
    },
  };
}

function jobDoc(
  id: string,
  companyId: string,
  firstSeenAt: Date,
  roleFamily: string,
  country: string,
  city: string,
) {
  return {
    _id: id,
    companyId,
    status: 'active',
    lifecycle: { state: 'VERIFIED_LIVE', firstSeenAt },
    identity: { roleFamily: { value: roleFamily } },
    geography: {
      normalizedLocations: [
        { text: `${city}, ${country}`, city, region: null, country, isRemoteLabel: false },
      ],
    },
    sourceRefs: [{ sourceId: 'src_1' }],
  };
}

beforeAll(async () => {
  infra = await createTestInfra('company_change_signals');
  const ctx = {
    db: infra.db,
    clock: { now: () => now },
    logger: infra.logger,
    artifacts: infra.artifacts,
  } as MarketContext;
  writer = new CompanyChangeSignalWriter(ctx);
  await infra.db
    .collection('market_companies')
    .insertMany([companyDoc('co_1', 'licensed', [{ sourceId: 'src_1', observedAt: evidenceAt }])] as never[]);
  await infra.db
    .collection('market_jobs')
    .insertMany([jobDoc('job_1', 'co_1', openingSeen, 'software_engineering', 'GB', 'London')] as never[]);
});

afterAll(async () => {
  await infra?.cleanup();
});

describe('company change signals (OPS-4)', () => {
  it('baselines on the first run and writes no signals', async () => {
    const first = await writer.run({ companyIds: ['co_1'] });
    expect(first.scanned).toBe(1);
    expect(first.baselined).toBe(1);
    expect(first.written).toEqual({});
    expect(first.skippedNoEvidence).toBe(0);
    expect(await infra.db.collection('market_signals').countDocuments()).toBe(0);
    expect(
      await infra.db.collection('market_company_signal_state').findOne({ _id: 'co_1' } as never),
    ).toMatchObject({
      writer: COMPANY_CHANGE_SIGNAL_WRITER,
      capability: 'licensed',
      remotePolicy: 'hybrid',
      roleFamilies: ['software_engineering'],
      locations: ['GB|london'],
      rev: 1,
    });
  });

  it('writes one sponsorship_change, one role_family_expansion and one new_location_hiring', async () => {
    await infra.db.collection('market_companies').updateOne({ _id: 'co_1' } as never, {
      $set: { 'employment.sponsorship.capability.value': 'previously_licensed' },
    });
    await infra.db
      .collection('market_jobs')
      .insertOne(jobDoc('job_2', 'co_1', expansionSeen, 'data_science_ml', 'DE', 'Berlin') as never);
    now = new Date(now.getTime() + HOUR_MS);
    const at = new Date(now.getTime());

    const r = await writer.run({ companyIds: ['co_1'] });
    expect(r.written).toEqual({
      sponsorship_change: 1,
      role_family_expansion: 1,
      new_location_hiring: 1,
    });
    const sigs = await infra.db.collection('market_signals').find({}).toArray();
    expect(sigs).toHaveLength(3);
    const byType = Object.fromEntries(sigs.map((s) => [s.type as string, s]));
    expect(byType.sponsorship_change).toMatchObject({
      companyIds: ['co_1'],
      observedAt: at,
      occurredAt: at,
      confidence: { level: 'high' },
      facts: { from: 'licensed', to: 'previously_licensed', writer: COMPANY_CHANGE_SIGNAL_WRITER },
    });
    expect(byType.sponsorship_change!.evidence[0]).toMatchObject({
      sourceId: 'src_1',
      observedAt: evidenceAt,
    });
    expect(byType.sponsorship_change!.evidence[0].locator).toBeUndefined();

    expect(byType.role_family_expansion).toMatchObject({
      companyIds: ['co_1'],
      observedAt: at,
      occurredAt: expansionSeen,
      confidence: { level: 'high' },
      facts: { roleFamily: 'data_science_ml', jobId: 'job_2', writer: COMPANY_CHANGE_SIGNAL_WRITER },
    });
    expect(byType.role_family_expansion!.evidence[0]).toMatchObject({
      sourceId: 'src_1',
      locator: 'job:job_2',
      observedAt: expansionSeen,
    });

    expect(byType.new_location_hiring).toMatchObject({
      companyIds: ['co_1'],
      observedAt: at,
      occurredAt: expansionSeen,
      confidence: { level: 'high' },
      facts: { location: 'DE|berlin', jobId: 'job_2', writer: COMPANY_CHANGE_SIGNAL_WRITER },
    });
    expect(byType.new_location_hiring!.evidence[0]).toMatchObject({
      sourceId: 'src_1',
      locator: 'job:job_2',
      observedAt: expansionSeen,
    });
  });

  it('replay of run() writes nothing new', async () => {
    const before = await infra.db.collection('market_signals').countDocuments();
    const again = await writer.run({ companyIds: ['co_1'] });
    expect(again.written).toEqual({});
    expect(again.baselined).toBe(0);
    expect(again.skippedNoEvidence).toBe(0);
    expect(await infra.db.collection('market_signals').countDocuments()).toBe(before);
  });

  it('writes hiring_acceleration only with a positive prior window, and none again the same week', async () => {
    await infra.db
      .collection('market_companies')
      .insertOne(
        companyDoc('co_accel', 'licensed', [{ sourceId: 'src_1', observedAt: evidenceAt }]) as never,
      );
    // Six open jobs, all first seen inside the last seven days, and none older than that.
    await infra.db
      .collection('market_jobs')
      .insertMany(
        Array.from({ length: 6 }, (_, i) =>
          jobDoc(
            `job_accel_${i}`,
            'co_accel',
            new Date(now.getTime() - (6 - i) * HOUR_MS),
            'software_engineering',
            'GB',
            'London',
          ),
        ) as never[],
      );

    const baseline = await writer.run({ companyIds: ['co_accel'] });
    expect(baseline.baselined).toBe(1);
    expect(baseline.written).toEqual({});

    // First comparison after baseline, and prior28 is 0: the ratio would be vacuous.
    const firstCompare = await writer.run({ companyIds: ['co_accel'] });
    expect(firstCompare.written).toEqual({});
    expect(await infra.db.collection('market_signals').countDocuments({ type: 'hiring_acceleration' })).toBe(
      0,
    );

    // Ten days later those six sit in the prior window; six new openings are the recent window.
    now = new Date(now.getTime() + 10 * DAY_MS);
    await infra.db
      .collection('market_jobs')
      .insertMany(
        Array.from({ length: 6 }, (_, i) =>
          jobDoc(
            `job_accel_new_${i}`,
            'co_accel',
            new Date(now.getTime() - (5 - i) * HOUR_MS),
            'software_engineering',
            'GB',
            'London',
          ),
        ) as never[],
      );
    const detected = await writer.run({ companyIds: ['co_accel'] });
    expect(detected.written).toEqual({ hiring_acceleration: 1 });
    const sig = await infra.db.collection('market_signals').findOne({ type: 'hiring_acceleration' });
    expect(sig).toMatchObject({
      companyIds: ['co_accel'],
      confidence: { level: 'high' },
      facts: { recent7: 6, prior28: 6, writer: COMPANY_CHANGE_SIGNAL_WRITER },
    });
    expect(sig!.evidence[0]).toMatchObject({ sourceId: 'src_1', locator: 'job:job_accel_new_5' });

    const count = await infra.db.collection('market_signals').countDocuments();
    // One day later is still the same epoch week (the window is 7 days, and 10 + 1 < 14).
    now = new Date(now.getTime() + DAY_MS);
    const again = await writer.run({ companyIds: ['co_accel'] });
    expect(again.written).toEqual({});
    expect(await infra.db.collection('market_signals').countDocuments()).toBe(count);
    expect(await infra.db.collection('market_signals').countDocuments({ type: 'hiring_acceleration' })).toBe(
      1,
    );
  });

  it('skips a capability change when the capability fact has no evidence', async () => {
    await infra.db
      .collection('market_companies')
      .insertOne(companyDoc('co_no_evidence', 'licensed', []) as never);
    const baseline = await writer.run({ companyIds: ['co_no_evidence'] });
    expect(baseline.baselined).toBe(1);
    expect(baseline.skippedNoEvidence).toBe(0);
    expect(baseline.written).toEqual({});

    await infra.db.collection('market_companies').updateOne({ _id: 'co_no_evidence' } as never, {
      $set: { 'employment.sponsorship.capability.value': 'previously_licensed' },
    });
    const before = await infra.db.collection('market_signals').countDocuments();
    const changed = await writer.run({ companyIds: ['co_no_evidence'] });
    expect(changed.written).toEqual({});
    expect(changed.skippedNoEvidence).toBe(1);
    expect(await infra.db.collection('market_signals').countDocuments()).toBe(before);
    expect(await infra.db.collection('market_signals').countDocuments({ companyIds: 'co_no_evidence' })).toBe(
      0,
    );
    // The stored capability stays at the previous value, so the diff is retried once evidence exists.
    expect(
      await infra.db.collection('market_company_signal_state').findOne({ _id: 'co_no_evidence' } as never),
    ).toMatchObject({ capability: 'licensed' });

    await infra.db.collection('market_companies').updateOne({ _id: 'co_no_evidence' } as never, {
      $set: {
        'employment.sponsorship.capability.evidence': [{ sourceId: 'src_1', observedAt: evidenceAt }],
      },
    });
    const retried = await writer.run({ companyIds: ['co_no_evidence'] });
    expect(retried.skippedNoEvidence).toBe(0);
    expect(retried.written).toEqual({ sponsorship_change: 1 });
    expect(
      await infra.db.collection('market_company_signal_state').findOne({ _id: 'co_no_evidence' } as never),
    ).toMatchObject({ capability: 'previously_licensed' });
  });

  it('resumes from the stored company id and wraps to the start when the id space is exhausted', async () => {
    const cursors = infra.db.collection('market_signal_writer_cursors');
    const cursor = () => cursors.findOne({ _id: 'company_change' } as never);
    // An explicit id list does not move the cursor (the tests above only passed companyIds).
    expect(await cursor()).toBeNull();

    const first = await writer.run({ maxCompanies: 1 });
    expect(first.scanned).toBe(1);
    expect(await cursor()).toMatchObject({ companyId: 'co_1' });

    const second = await writer.run({ maxCompanies: 1 });
    expect(second.scanned).toBe(1);
    expect((await cursor())?.companyId).toBe('co_accel');

    const third = await writer.run({ maxCompanies: 1 });
    expect(third.scanned).toBe(1);
    expect((await cursor())?.companyId).toBe('co_no_evidence');

    const exhausted = await writer.run({ maxCompanies: 1 });
    expect(exhausted.scanned).toBe(0);
    expect((await cursor())?.companyId).toBe('');

    const wrapped = await writer.run({ maxCompanies: 1 });
    expect(wrapped.scanned).toBe(1);
    expect((await cursor())?.companyId).toBe('co_1');
  });
});
