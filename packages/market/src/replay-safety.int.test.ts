/**
 * Replay and concurrency safety of Market state changes (audit findings B-1, B-2),
 * against real MongoDB/Redis/S3 with controlled failure injection — no timing sleeps.
 *
 *  B-1  one complete listing snapshot affects a job's absence/lifecycle at most once, whatever
 *       crash, retry or redelivery happens between the job writes and the acknowledgement
 *  B-2  one logical verification operation affects a job's lifecycle at most once, with a crash
 *       injected at every step boundary
 *
 * B-3 (review resolution) lives in `review-resolution.int.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestInfra, startFixtureServer, type TestInfra } from '@aptamind/testing';
import type { JobDoc } from './jobs/job.schema';
import type { SourceDoc } from './sources/source.schema';
import { ensureMarketCollections } from './market-domain';
import { createMarketTestRuntime } from './test-harness';

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let listing = 'acme-listing-t1.json';
let source: SourceDoc;

beforeAll(async () => {
  infra = await createTestInfra('replay');
  t = await createMarketTestRuntime(infra);
  server = await startFixtureServer(async (req, res) => {
    if ((req.url ?? '').startsWith('/posting/')) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('gone'); // verification: not found
      return;
    }
    if ((req.url ?? '').startsWith('/v1/boards/acme/jobs')) {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(await t.fixture('ats', 'greenhouse', listing));
      return;
    }
    res.writeHead(404).end();
  });
  const directory = (
    await t.market.sources.register(
      {
        key: 'directory:replay',
        name: 'Directory',
        category: 'company_universe',
        provider: 'fixture',
        acquisition: { workflowKey: 'market.noop' },
        freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 100000 },
        authority: { tier: 'official_site' },
      },
      t.actor,
    )
  ).source;
  const company = await t.market.companyPipeline.process({
    sourceId: directory._id,
    externalId: 'acme',
    payload: {
      name: 'Acme Ltd',
      domain: 'acme.example',
      aliases: [],
      externalIds: [],
      locations: [],
      industries: [],
    },
    parser: { name: 'test', version: '1' },
  });
  if (company.outcome !== 'created' && company.outcome !== 'matched') throw new Error('company not created');
  source = (
    await t.market.sources.register(
      {
        key: 'greenhouse:acme-replay',
        name: 'Acme (greenhouse)',
        category: 'job_source',
        provider: 'greenhouse',
        endpoint: { boardToken: 'acme', url: `${server.url}/v1/boards/acme/jobs` },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId: company.companyId,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      },
      t.actor,
    )
  ).source;
  listing = 'acme-listing-t1.json';
  expect((await t.runSource(source._id)).state).toBe('COMPLETED');
});

afterAll(async () => {
  await t?.stop();
  await server?.close();
  await infra?.cleanup();
});

const job = async (externalId: string): Promise<JobDoc> =>
  (await t.market.jobs.col.findOne({ sourceKeys: `${source._id}:${externalId}` })) as JobDoc;
const absences = async (externalId: string) => (await job(externalId)).lifecycle.consecutiveAbsences;

/**
 * Reset the listed jobs to "live, never absent" between scenarios. The lifecycle is derived from
 * evidence (DECISION_LOG 6a01b36), so the reset replaces the copies' evidence (test-only: the
 * store is append-only) with one fresh sighting each, and re-derives.
 */
async function resetLifecycles() {
  const jobs = await t.market.jobs.col.find({ 'sourceRefs.sourceId': source._id }).toArray();
  const at = new Date(Date.now() - 60_000);
  for (const j of jobs) {
    await t.market.evidence.col.deleteMany({ copyKey: { $in: j.sourceKeys } });
    await t.market.evidence.dropCheckpoint(j._id); // (the checkpoint is derived from what was deleted)
    await t.market.jobs.col.updateOne(
      { _id: j._id },
      { $set: { 'sourceRefs.$[].present': true, 'sourceRefs.$[].lastSeenAt': at }, $inc: { rev: 1 } },
    );
    await t.market.evidence.record(
      j.sourceRefs.map((r) => ({
        _id: `test:reset:${r.key}:${at.getTime()}`,
        jobId: j._id,
        copyKey: r.key,
        sourceId: r.sourceId,
        board: r.board ?? null,
        at,
        kind: 'listing' as const,
        outcome: 'present' as const,
      })),
    );
    await t.market.evidence.recompute(j._id);
  }
  await t.market.sources.col.updateOne(
    { _id: source._id },
    { $unset: { 'health.lastListingAppliedAt': '' } },
  );
}

/** The listing evidence recorded about a copy (one document per listing and outcome). */
const listingEvidence = (externalId: string, outcome: 'present' | 'absent') =>
  t.market.evidence.col.countDocuments({ copyKey: `${source._id}:${externalId}`, outcome });

describe('B-1: listing absence is applied at most once per snapshot', () => {
  // The listing contains 001–003; 004 and 005 are absent.
  const seen = new Set(['4012345001', '4012345002', '4012345003']);
  // Listing times after the jobs' sightings (a listing older than a sighting is stale).
  const day = 24 * 3600_000;
  const s1 = { id: 'snap_s1', at: new Date(Date.now() + day) };
  const s2 = { id: 'snap_s2', at: new Date(Date.now() + 2 * day) };

  beforeEach(resetLifecycles);

  it('survives a crash after some job mutations and before acknowledgement; replay counts nothing twice', async () => {
    const pipeline = t.market.jobPipeline;
    const jobs = t.market.jobs;
    const original = jobs.casUpdate.bind(jobs);
    let writes = 0;
    // Crash after the first job's lifecycle write has been committed.
    jobs.casUpdate = async (...args) => {
      if (writes === 1) throw new Error('simulated crash mid-listing');
      const ok = await original(...args);
      if (ok) writes += 1;
      return ok;
    };
    try {
      await expect(pipeline.applyListingAbsences(source, seen, s1.at, s1.id)).rejects.toThrow(
        'simulated crash',
      );
    } finally {
      jobs.casUpdate = original;
    }
    const partial = [await absences('4012345004'), await absences('4012345005')].sort();
    expect(partial).toEqual([0, 1]); // exactly one job was mutated before the crash

    // Replay the same snapshot (retry / redelivery): the unfinished job's evidence was recorded
    // before the crash, so nothing is recorded again ("already applied" for both) — but the replay
    // re-derives it, which completes its projection, and reports the transition it wrote (L9).
    const replay = await pipeline.applyListingAbsences(source, seen, s1.at, s1.id);
    expect(replay).toEqual({ absent: 0, alreadyApplied: 2, closed: 0, possiblyStale: 1 });
    expect(await absences('4012345004')).toBe(1);
    expect(await absences('4012345005')).toBe(1);

    // Any number of further replays change nothing.
    for (let i = 0; i < 3; i++) {
      expect(await pipeline.applyListingAbsences(source, seen, s1.at, s1.id)).toEqual({
        absent: 0,
        alreadyApplied: 2,
        closed: 0,
        possiblyStale: 0,
      });
    }
    const j5 = await job('4012345005');
    expect(j5.lifecycle).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveAbsences: 1 });
    // The listing is ONE piece of evidence per copy, however often it was applied.
    expect(await listingEvidence('4012345005', 'absent')).toBe(1);
    expect(await listingEvidence('4012345004', 'absent')).toBe(1);

    // A genuinely new listing counts the second absence and — corroborated by a not_found since
    // the first absence (ruling L1; recorded directly here as verification evidence) — closes.
    for (const id of ['4012345004', '4012345005']) {
      const j = await job(id);
      const copy = j.sourceRefs.find((r) => r.externalId === id)!;
      await t.market.evidence.record([
        {
          _id: `test:nf:${copy.key}:${s1.at.getTime()}`,
          jobId: j._id,
          copyKey: copy.key,
          sourceId: source._id,
          board: copy.board ?? null,
          at: new Date(s1.at.getTime() + 1),
          kind: 'verification',
          outcome: 'not_found',
        },
      ]);
    }
    expect(await pipeline.applyListingAbsences(source, seen, s2.at, s2.id)).toMatchObject({
      absent: 2,
      closed: 2,
    });
    const closed = await job('4012345005');
    // (Derived: the not_found while the job is absent from its listing closes it — L1 path b.)
    expect(closed.lifecycle).toMatchObject({
      state: 'CLOSED',
      closeReason: 'verified not found and absent from listing',
    });
    expect(closed.lifecycle.history.filter((h) => h.to === 'CLOSED')).toHaveLength(1);

    // Replaying the older snapshot afterwards is ignored too.
    expect(await pipeline.applyListingAbsences(source, seen, s1.at, s1.id)).toMatchObject({ absent: 0 });
  });

  it('closing requires two distinct logical listings, even under concurrent replays of one', async () => {
    const pipeline = t.market.jobPipeline;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => pipeline.applyListingAbsences(source, seen, s1.at, s1.id)),
    );
    expect(results.reduce((n, r) => n + r.absent, 0)).toBe(2); // one per absent job, in total
    // Each job's transition is reported once, by the call whose write made it (L9).
    expect(results.reduce((n, r) => n + r.possiblyStale, 0)).toBe(2);
    expect(await absences('4012345004')).toBe(1);
    expect((await job('4012345005')).lifecycle.state).toBe('POSSIBLY_STALE');
  });

  it('a failed acknowledgement after the job writes is retried by the runtime without a second absence', async () => {
    // Real workflow: listing t2 drops 4012345005. The finalize node commits the job writes and
    // then fails before completing (as if the process died before acknowledging).
    const pipeline = t.market.jobPipeline;
    const original = pipeline.applyListingAbsences.bind(pipeline);
    let failures = 0;
    pipeline.applyListingAbsences = async (...args) => {
      const res = await original(...args);
      if (failures === 0) {
        failures += 1;
        throw new Error('simulated crash after lifecycle mutation, before acknowledgement');
      }
      return res;
    };
    try {
      listing = 'acme-listing-t2.json';
      const run = await t.runSource(source._id);
      expect(run.state).toBe('COMPLETED');
    } finally {
      pipeline.applyListingAbsences = original;
      listing = 'acme-listing-t1.json';
    }
    expect(failures).toBe(1);
    const j5 = await job('4012345005');
    expect(j5.lifecycle).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveAbsences: 1 });
    const finalize = await t.runtime.engine.nodeRuns.findOne({
      workflowKey: 'market.ats.refresh',
      nodeId: 'finalize',
      'attempts.1': { $exists: true },
    });
    expect(finalize?.attempts.map((a) => a.status)).toEqual(['failed', 'completed']);
  });
});

describe('B-2: a verification operation influences the lifecycle at most once', () => {
  type Step = 'claim' | 'recordResult' | 'applyToJob' | 'complete';
  const boundaries: Array<{ name: string; step: Step; when: 'before' | 'after' }> = [
    { name: 'before claim', step: 'claim', when: 'before' },
    { name: 'after claim', step: 'claim', when: 'after' },
    { name: 'after verification persistence', step: 'recordResult', when: 'after' },
    { name: 'after lifecycle application', step: 'applyToJob', when: 'after' },
    { name: 'before final acknowledgement', step: 'complete', when: 'after' },
  ];

  /**
   * A job verified through its posting URL, which the fixture server answers with 404. Its copy
   * is made a non-ATS copy: an ATS copy is always read on its own board (a9af734).
   */
  async function verifiableJob(): Promise<JobDoc> {
    await resetLifecycles();
    const j = await job('4012345002');
    await t.market.jobs.col.updateOne(
      { _id: j._id },
      {
        $set: {
          'application.ats': null,
          'sourceRefs.$[].provider': 'careers_page',
          'sourceRefs.$[].postingUrl': `${server.url}/posting/${j._id}`,
        },
        $unset: { 'lifecycle.appliedVerifications': '', 'verification.lastOutcome': '' },
        $inc: { rev: 1 },
      },
    );
    await t.market.verification.col.deleteMany({ jobId: j._id });
    return j;
  }

  for (const b of boundaries) {
    it(`replay after a crash ${b.name} never double-applies not_found`, async () => {
      const j = await verifiableJob();
      const svc = t.market.verification;
      const original = svc[b.step].bind(svc) as (...a: unknown[]) => Promise<unknown>;
      (svc as unknown as Record<Step, unknown>)[b.step] = async (...args: unknown[]) => {
        if (b.when === 'before') throw new Error(`simulated crash ${b.name}`);
        await original(...args);
        throw new Error(`simulated crash ${b.name}`);
      };
      try {
        await expect(svc.verify(j._id, t.runtime.http, { operationKey: 'op-1' })).rejects.toThrow(
          'simulated crash',
        );
      } finally {
        (svc as unknown as Record<Step, unknown>)[b.step] = original;
      }
      // Replay the same logical operation (retry / redelivery), several times.
      for (let i = 0; i < 3; i++) {
        const v = await svc.verify(j._id, t.runtime.http, { operationKey: 'op-1' });
        expect(v).toMatchObject({ status: 'applied', outcome: 'not_found', stateAfter: 'POSSIBLY_STALE' });
      }
      const after = await job('4012345002');
      expect(after.lifecycle).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveNotFound: 1 });
      expect(
        after.lifecycle.history.filter((h) => h.reason === 'verification did not find the posting'),
      ).toHaveLength(1);
      expect(await svc.col.countDocuments({ jobId: j._id })).toBe(1);

      // A second, independent verification is what closes it.
      const second = await svc.verify(j._id, t.runtime.http, { operationKey: 'op-2' });
      expect(second).toMatchObject({ outcome: 'not_found', stateAfter: 'CLOSED' });
      expect((await job('4012345002')).lifecycle.consecutiveNotFound).toBe(2);
    });
  }

  // Independent re-audit probe (B-2): the fence must hold for the operation's whole lifetime,
  // not only while its id is among the most recent ones.
  it('a delayed replay after more newer operations than any bounded history still applies nothing', async () => {
    const j = await verifiableJob();
    const svc = t.market.verification;
    // V1 = not_found, applied, then the worker dies before completion: V1 stays replayable.
    const complete = svc.complete.bind(svc);
    svc.complete = async () => {
      throw new Error('simulated crash before completing V1');
    };
    try {
      await expect(svc.verify(j._id, t.runtime.http, { operationKey: 'op-v1' })).rejects.toThrow(
        'simulated crash',
      );
    } finally {
      svc.complete = complete;
    }
    expect((await job('4012345002')).lifecycle).toMatchObject({
      state: 'POSSIBLY_STALE',
      consecutiveNotFound: 1,
    });

    // 60 newer, independent operations (more than the 50 ids the old job-embedded fence kept).
    for (let i = 0; i < 60; i++) {
      const id = `ver-later-${j._id}-${i}`;
      await svc.claim(id, j._id, { operationKey: `later-${i}` });
      const op = await svc.recordResult(id, {
        method: 'posting_url',
        outcome: 'inconclusive',
        detail: 'fixture: temporarily unavailable',
      });
      await svc.complete(id, await svc.applyToJob(op));
    }

    // V1 is replayed (a delayed redelivery / recovery of the interrupted operation).
    const v1 = await svc.verify(j._id, t.runtime.http, { operationKey: 'op-v1' });
    const after = await job('4012345002');
    expect(after.lifecycle).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveNotFound: 1 });
    expect(v1).toMatchObject({ status: 'applied', outcome: 'not_found', lifecycleApplied: true });
  });

  it('concurrent replays of one operation apply it once', async () => {
    const j = await verifiableJob();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        t.market.verification.verify(j._id, t.runtime.http, { operationKey: 'op-c' }),
      ),
    );
    expect(new Set(results.map((r) => r._id)).size).toBe(1);
    expect((await job('4012345002')).lifecycle).toMatchObject({
      state: 'POSSIBLY_STALE',
      consecutiveNotFound: 1,
    });
  });
});

describe('found during B-3: unique identity indexes allow more than one merged entity', () => {
  it('reconciles the old non-partial indexes and lets merged jobs/companies coexist', async () => {
    // A database created before the fix, with the old non-partial unique indexes.
    const old = infra.mongo.client.db(`${infra.dbName}_idx`);
    try {
      await old
        .collection('market_jobs')
        .createIndex({ sourceKeys: 1 }, { name: 'uniq_source_keys', unique: true });
      await old
        .collection('market_companies')
        .createIndex({ identityKeys: 1 }, { name: 'uniq_identity_keys', unique: true });

      await ensureMarketCollections(old); // runs on every boot
      const idx = async (col: string, name: string) =>
        (await old.collection(col).listIndexes().toArray()).find((i) => i.name === name);
      expect((await idx('market_jobs', 'uniq_source_keys'))?.partialFilterExpression).toEqual({
        status: 'active',
      });
      expect((await idx('market_companies', 'uniq_identity_keys'))?.partialFilterExpression).toEqual({
        status: 'active',
      });

      // Two merged jobs / companies (empty key arrays) no longer collide.
      const baseJob = await job('4012345005');
      const baseCompany = (await t.market.companies.col.findOne({ status: 'active' }))!;
      for (const n of ['a', 'b']) {
        await old
          .collection('market_jobs')
          .insertOne({ ...baseJob, _id: `job_m_${n}`, status: 'merged', sourceKeys: [] } as never);
        await old
          .collection('market_companies')
          .insertOne({ ...baseCompany, _id: `cmp_m_${n}`, status: 'merged', identityKeys: [] } as never);
      }
      // Uniqueness among active entities still holds.
      await old.collection('market_jobs').insertOne({ ...baseJob, _id: 'job_live_1' } as never);
      await expect(
        old.collection('market_jobs').insertOne({ ...baseJob, _id: 'job_live_2' } as never),
      ).rejects.toThrow(/E11000/);
    } finally {
      await old.dropDatabase();
    }
  });
});
