/**
 * The derived lifecycle's recompute is never at the mercy of its recorder (PR #11
 * re-verification #10, DECISION_LOG 9b0cb03), end to end:
 *
 *  - M1: a checkpoint never hides late evidence, whether or not its recorder recomputed (crash,
 *    retries exhausted, contention) — the reviewer's repro and its mirror; the evidence count is
 *    answered from the indexes; a recompute that loses every write fails (retryably) and loses
 *    nothing; a storm of concurrent recorders (some crashing) converges on the derivation;
 *  - L2: a standing change's recompute is durable (a pending marker in the same write);
 *  - L3: `recompute_source_jobs` skips CLOSED jobs, honours abort and resumes from its cursor;
 *  - L4: standing history never goes back in time;
 *  - L5: `reposted` and `reposts` come from the derivation, not from arrival;
 *  - L7: careers evidence is at the crawl's start, on its start URL's board; a re-run never
 *    moves the latest fetch (or health) over a newer failure.
 */
import { appendFileSync } from 'node:fs';
import { Collection, type FindCursor } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestInfra, startFixtureServer, type TestInfra, waitForRun } from '@aptamind/testing';
import { AI_GATEWAY } from '@aptamind/workflow-nodes';
import { evidenceFilter, type NewJobEvidence, RecomputeContentionError } from './jobs/evidence.service';
import type { JobDoc } from './jobs/job.schema';
import { deriveLifecycle } from './jobs/lifecycle';
import { entityRunsQuerySchema, listEntityRuns } from './api/activity';
import { listingEvidenceKey } from './jobs/job-pipeline';
import { MARKET } from './market-domain';
import { REVIEW_CLAIM_STALE_MS } from './review/review.service';
import type { SourceDoc } from './sources/source.schema';
import { createMarketTestRuntime } from './test-harness';
import { extractJobsFromPages } from './workflow-nodes/acquisition';

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let companyId: string;
const bodies = new Map<string, unknown>();
const tick = () => new Promise((r) => setTimeout(r, 5));
const HOUR = 3600_000;
const DAY = 24 * HOUR;

beforeAll(async () => {
  infra = await createTestInfra('lifecycle_recompute');
  t = await createMarketTestRuntime(infra);
  server = await startFixtureServer(async (req, res) => {
    const body = bodies.get((req.url ?? '').split('?')[0] ?? '');
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  const directory = (
    await t.market.sources.register(
      {
        key: 'directory:recompute',
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
    externalId: 'recompute-co',
    payload: { name: 'Recompute Evidence Ltd', aliases: [], externalIds: [], locations: [], industries: [] },
    parser: { name: 'test', version: '1' },
  });
  if (company.outcome !== 'created' && company.outcome !== 'matched') throw new Error('company not created');
  companyId = company.companyId;
});

afterAll(async () => {
  await t?.stop();
  await server?.close();
  await infra?.cleanup();
});

const svc = () => t.market.verification;
let opKey = 0;
const verify = (jobId: string) =>
  svc().verify(jobId, t.runtime.http, { operationKey: `recompute-${++opKey}` });

async function greenhouse(token: string) {
  const path = (board: string) => `/v1/boards/${board}/jobs`;
  const source = (
    await t.market.sources.register(
      {
        key: `greenhouse:${token}`,
        name: `${token} (greenhouse)`,
        category: 'job_source',
        provider: 'greenhouse',
        endpoint: { boardToken: token, url: `${server.url}${path(token)}?content=true` },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      },
      t.actor,
    )
  ).source;
  const gh = (id: number) => ({
    id,
    title: `Role ${token} ${id}`,
    absolute_url: `https://job-boards.greenhouse.io/${token}/jobs/${id}`,
    location: { name: 'Remote' },
    updated_at: '2026-09-01T10:00:00Z',
    content: `&lt;p&gt;Own the unique ${token} programme number ${id} end to end.&lt;/p&gt;`,
  });
  const of = async (id: number) =>
    (await t.market.jobs.col.findOne({ sourceKeys: `${source._id}:${id}` })) as JobDoc;
  const listing = async (ids: number[]) => {
    bodies.set(path(token), { jobs: ids.map(gh) });
    expect((await t.runSource(source._id)).state).toBe('COMPLETED');
  };
  const gone = (id: number) => bodies.delete(`${path(token)}/${id}`);
  const close = async (id: number) => {
    gone(id);
    const j = await of(id);
    await verify(j._id);
    await tick();
    await verify(j._id);
    const closed = await of(id);
    expect(closed.lifecycle.state).toBe('CLOSED');
    return closed;
  };
  return { source, path, gh, of, listing, gone, close };
}

/** Move the recorded-evidence sweep's watermark (test set-up). */
async function sweepMark(at: Date) {
  await t.market.ctx.db
    .collection('market_job_evidence_sweeps')
    .updateOne({ _id: 'recorded_evidence' as never }, { $set: { at, id: '!' } }, { upsert: true });
}

/** The pure derivation of a job's whole evidence set, now. */
async function pureOf(jobId: string) {
  const job = await t.market.jobs.get(jobId);
  const all = await t.market.evidence.evidenceOf(
    job._id,
    job.sourceRefs.map((r) => r.key),
  );
  const sources = await t.market.evidence.sourcesOf(all.map((e) => e.sourceId));
  return deriveLifecycle(all, sources, new Date(), {
    copies: job.sourceRefs,
    firstSeenAt: job.lifecycle.firstSeenAt,
    lastSeenAt: job.lifecycle.lastSeenAt,
  }).lifecycle;
}

const derivedPart = (lc: Record<string, unknown>) => {
  const keys = [
    'state',
    'consecutiveAbsences',
    'consecutiveNotFound',
    'history',
    'lastVerifiedAt',
    'lastChangedAt',
    'closedAt',
    'closeReason',
    'absentSince',
    'lastNotFoundAt',
  ];
  return Object.fromEntries(keys.map((k) => [k, lc[k] ?? null]));
};

/** The stored projection equals the pure derivation of everything recorded. */
async function expectDerived(jobId: string) {
  const stored = await t.market.jobs.get(jobId);
  expect(derivedPart(stored.lifecycle as never)).toEqual(derivedPart((await pureOf(jobId)) as never));
  return stored;
}

function verificationEvidence(job: JobDoc, at: Date, outcome: 'live' | 'not_found' | 'inconclusive') {
  const copy = job.sourceRefs[0]!;
  return {
    _id: `test:ver:${copy.key}:${at.getTime()}:${outcome}`,
    jobId: job._id,
    copyKey: copy.key,
    sourceId: copy.sourceId,
    board: copy.board ?? null,
    at,
    kind: 'verification' as const,
    outcome,
  } satisfies NewJobEvidence;
}

/** A later recorder: evidence that says nothing by itself, recorded and recomputed. */
async function laterRecorder(job: JobDoc) {
  const e = verificationEvidence(job, new Date(), 'inconclusive');
  const inserted = await t.market.evidence.record([e]);
  return t.market.evidence.recompute(job._id, { recorded: { inserted: inserted > 0 } });
}

const latestVerificationAt = async (copyKey: string) =>
  (
    await t.market.evidence.col.find({ copyKey, kind: 'verification' }).sort({ at: -1 }).limit(1).toArray()
  )[0]!.at;

async function standingRuns(sourceId: string) {
  return t.runtime.engine.runs.find({ 'labels.standingOfSource': sourceId }).toArray();
}
async function settleStandingRuns(sourceId: string, n: number) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const runs = await standingRuns(sourceId);
    if (runs.length >= n) {
      for (const r of runs) await waitForRun(t.runtime.engine, r._id, undefined, 30_000);
      return runs;
    }
    if (Date.now() > deadline) throw new Error(`expected ${n} standing runs for ${sourceId}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('M1: a checkpoint never hides late evidence, whoever recorded it', () => {
  it("the reviewer's repro: nf1 recomputed, a late nf0 recorded without a recompute — sweep, source recompute and a later recorder all end at the derivation (CLOSED)", async () => {
    const g = await greenhouse('rc-m1');
    await g.listing([1, 2]);
    const j = await g.of(1);
    const copy = j.sourceRefs[0]!;
    g.gone(1);
    await tick();
    await verify(j._id); // nf1, recomputed (the checkpoint's watermark is now its time)
    expect((await g.of(1)).lifecycle).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveNotFound: 1 });
    const nf1 = await latestVerificationAt(copy.key);
    // nf0: between the sighting and nf1, recorded by a recorder that never recomputed.
    const nf0At = new Date((copy.lastSeenAt.getTime() + nf1.getTime()) / 2);
    expect(await t.market.evidence.record([verificationEvidence(j, nf0At, 'not_found')])).toBe(1);
    expect((await pureOf(j._id)).state).toBe('CLOSED');

    await t.market.freshness.staleSweep();
    await t.market.recomputeSourceJobs(g.source._id);
    const healed = await expectDerived(j._id);
    expect(healed.lifecycle).toMatchObject({ state: 'CLOSED', consecutiveNotFound: 2 });
    await laterRecorder(healed);
    expect((await expectDerived(j._id)).lifecycle.state).toBe('CLOSED');
  });

  it('a later recorder alone re-derives from everything (its evidence is newer than the watermark)', async () => {
    const g = await greenhouse('rc-m1b');
    await g.listing([1, 2]);
    const j = await g.of(1);
    const copy = j.sourceRefs[0]!;
    g.gone(1);
    await tick();
    await verify(j._id);
    const nf1 = await latestVerificationAt(copy.key);
    const nf0At = new Date((copy.lastSeenAt.getTime() + nf1.getTime()) / 2);
    await t.market.evidence.record([verificationEvidence(j, nf0At, 'not_found')]);
    await laterRecorder(await g.of(1));
    expect((await expectDerived(j._id)).lifecycle.state).toBe('CLOSED');
  });

  it('the mirror: a missed late positive never keeps a job CLOSED', async () => {
    const g = await greenhouse('rc-m1c');
    await g.listing([1, 2]);
    const j = await g.of(1);
    const copy = j.sourceRefs[0]!;
    const closed = await g.close(1);
    const [nfA, nfB] = (
      await t.market.evidence.col.find({ copyKey: copy.key, kind: 'verification' }).sort({ at: 1 }).toArray()
    ).map((e) => e.at);
    // A live read between the two 404s, recorded by a recorder that never recomputed.
    const liveAt = new Date((nfA!.getTime() + nfB!.getTime()) / 2);
    await t.market.evidence.record([verificationEvidence(closed, liveAt, 'live')]);
    expect(await pureOf(j._id)).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveNotFound: 1 });
    // A source recompute skips CLOSED jobs (L3) ...
    expect((await t.market.recomputeSourceJobs(g.source._id)).jobs).toBe(1);
    expect((await g.of(1)).lifecycle.state).toBe('CLOSED');
    // ... and the next recorder about the job re-derives it from everything.
    await laterRecorder(closed);
    expect((await expectDerived(j._id)).lifecycle).toMatchObject({
      state: 'POSSIBLY_STALE',
      consecutiveNotFound: 1,
    });
  });

  it('the evidence count up to the watermark is answered from the indexes (no document fetched per evidence)', async () => {
    const g = await greenhouse('rc-count');
    await g.listing([1]);
    const j = await g.of(1);
    const copy = j.sourceRefs[0]!;
    const start = Date.now() - 2 * DAY;
    await t.market.evidence.record(
      Array.from({ length: 2000 }, (_, i) => {
        const at = new Date(start + i * 60_000);
        return {
          _id: listingEvidenceKey(copy.key, at, 'present'),
          jobId: j._id,
          copyKey: copy.key,
          sourceId: g.source._id,
          board: copy.board ?? null,
          at,
          kind: 'listing' as const,
          outcome: 'present' as const,
        };
      }),
    );
    const upTo = new Date();
    expect(await t.market.evidence.countUpTo(j._id, [copy.key], upTo)).toBeGreaterThanOrEqual(2000);
    const explain = (await t.market.evidence.col
      .aggregate([{ $match: evidenceFilter(j._id, [copy.key], { $lte: upTo }) }, { $count: 'n' }])
      .explain('executionStats')) as unknown;
    const examined: number[] = [];
    const stages: string[] = [];
    const walk = (x: unknown) => {
      if (!x || typeof x !== 'object') return;
      for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
        if (k === 'totalDocsExamined' && typeof v === 'number') examined.push(v);
        if (k === 'stage' && typeof v === 'string') stages.push(v);
        walk(v);
      }
    };
    walk(explain);
    expect(stages).not.toContain('COLLSCAN');
    expect(examined.length).toBeGreaterThan(0);
    expect(Math.max(...examined)).toBeLessThanOrEqual(3); // at most the job-level baselines
  });

  it('a recompute that loses every write fails retryably and loses nothing; the retry applies it', async () => {
    const g = await greenhouse('rc-contend');
    await g.listing([1, 2]);
    const j = await g.of(1);
    g.gone(1);
    await tick();
    const jobs = t.market.jobs;
    const original = jobs.casUpdate.bind(jobs);
    jobs.casUpdate = async () => false; // every compare-and-set loses to a "concurrent" writer
    const key = 'recompute-contend';
    try {
      await expect(svc().verify(j._id, t.runtime.http, { operationKey: key })).rejects.toBeInstanceOf(
        RecomputeContentionError,
      );
    } finally {
      jobs.casUpdate = original;
    }
    // The result is recorded evidence already; the job is not yet re-derived.
    expect(
      await t.market.evidence.col.countDocuments({ copyKey: j.sourceRefs[0]!.key, kind: 'verification' }),
    ).toBe(1);
    expect((await g.of(1)).lifecycle.state).toBe('VERIFIED_LIVE');
    // The node's retry (same operation) records nothing new and applies it.
    const op = await svc().verify(j._id, t.runtime.http, { operationKey: key });
    expect(op).toMatchObject({ status: 'applied', stateAfter: 'POSSIBLY_STALE' });
    expect(
      await t.market.evidence.col.countDocuments({ copyKey: j.sourceRefs[0]!.key, kind: 'verification' }),
    ).toBe(1);
    await expectDerived(j._id);
  }, 60_000);
});

describe('M1: a storm of concurrent recorders converges on the derivation', () => {
  const seeds = (process.env.STORM_SEEDS ?? '4242,777,9001').split(',').map(Number);
  it.each(seeds)(
    'seed %i: 150 concurrent record+recompute tasks on 4 jobs, 2 of them CLOSED (one in ten crashing before it re-derives) — healed by the sweep alone',
    async (seed) => {
      let s = seed >>> 0;
      const rand = () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 2 ** 32;
      };
      const g = await greenhouse(`rc-storm-${seed}`);
      await g.listing([1, 2, 3, 4]);
      // Jobs 1 and 2 were closed (two 404s) 39 hours ago: storm evidence after that is late.
      for (const id of [1, 2]) {
        const closed = await g.close(id);
        await t.market.evidence.col.updateMany({ copyKey: closed.sourceRefs[0]!.key }, [
          { $set: { at: { $subtract: ['$at', 39 * HOUR] } } },
        ]);
        await t.market.evidence.dropCheckpoint(closed._id);
        await t.market.evidence.recompute(closed._id);
        expect((await g.of(id)).lifecycle.state).toBe('CLOSED');
      }
      const jobs = await Promise.all([1, 2, 3, 4].map((id) => g.of(id)));
      const base = Date.now() - 40 * HOUR;
      let contended = 0;
      const tasks = Array.from({ length: 150 }, (_, i) => async () => {
        const job = jobs[Math.floor(rand() * jobs.length)]!;
        const copy = job.sourceRefs[0]!;
        const at = new Date(base + Math.floor(rand() * 38 * HOUR));
        const kind = rand() < 0.5 ? 'listing' : 'verification';
        const outcome =
          kind === 'listing'
            ? rand() < 0.5
              ? ('present' as const)
              : ('absent' as const)
            : (['live', 'not_found', 'inconclusive'] as const)[Math.floor(rand() * 3)]!;
        const crash = rand() < 0.1;
        const e: NewJobEvidence = {
          _id: `storm:${seed}:${i}`,
          jobId: job._id,
          copyKey: copy.key,
          sourceId: g.source._id,
          board: copy.board ?? null,
          at,
          kind,
          outcome,
          ...(outcome === 'present' ? { contentHash: copy.contentHash } : {}),
        };
        await tick();
        const inserted = await t.market.evidence.record([e]);
        if (crash) return; // recorded, never recomputed
        try {
          await t.market.evidence.recompute(job._id, { recorded: { inserted: inserted > 0 } });
        } catch (err) {
          if (!(err instanceof RecomputeContentionError)) throw err;
          contended += 1; // its node would retry; the evidence is recorded either way
        }
      });
      await Promise.all(tasks.map((f) => f()));
      // A tail of crashed recorders on the CLOSED jobs: late sightings after their closure, recorded
      // and never re-derived (nothing but the sweep can fold them).
      for (const job of jobs.slice(0, 2)) {
        const copy = job.sourceRefs[0]!;
        const at = new Date(base + 30 * HOUR + Math.floor(rand() * 8 * HOUR));
        await t.market.evidence.record([
          {
            _id: `storm:${seed}:tail:${job._id}`,
            jobId: job._id,
            copyKey: copy.key,
            sourceId: g.source._id,
            board: copy.board ?? null,
            at,
            kind: 'listing',
            outcome: 'present',
            contentHash: copy.contentHash,
          },
        ]);
      }
      // Production paths only: the freshness sweep's recorded-evidence pass re-derives every job
      // named by evidence recorded since its watermark (no lag here: nothing is in flight).
      while (!(await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 })).complete);
      for (const job of jobs) await expectDerived(job._id);
      if (process.env.STORM_REPORT)
        appendFileSync(
          process.env.STORM_REPORT,
          `storm seed ${seed}: ${contended}/150 recomputes contended\n`,
        );
      expect(contended).toBeLessThan(150);
    },
    120_000,
  );
});

describe('L2: a standing change recompute is durable', () => {
  it('a crash after the change is resumed by a retry of the change, then by the sweep', async () => {
    const g = await greenhouse('rc-l2');
    await g.listing([1, 2]);
    const j = await g.of(1);
    // Five days pass without a confirmation (evidence moved back; checkpoint dropped).
    await t.market.evidence.col.updateMany({ copyKey: j.sourceRefs[0]!.key }, [
      { $set: { at: { $subtract: ['$at', 5 * DAY] } } },
    ]);
    await t.market.evidence.dropCheckpoint(j._id);
    const sources = t.market.sources;
    const hook = sources.onStandingChanged;
    sources.onStandingChanged = async () => {
      throw new Error('simulated crash after the standing write');
    };
    try {
      await expect(sources.setEnabled(g.source._id, false, t.actor)).rejects.toThrow('simulated crash');
    } finally {
      sources.onStandingChanged = hook;
    }
    const crashed = await sources.get(g.source._id);
    expect(crashed.enabled).toBe(false);
    // The marker was written in the same update as the history entry.
    expect(crashed.standingRecompute).toEqual({
      pendingAt: crashed.standingHistory!.at(-1)!.at,
      cursor: null,
    });
    expect((await g.of(1)).lifecycle.state).toBe('VERIFIED_LIVE');
    // A retry of the same change records nothing new but enqueues the pending recompute.
    await sources.setEnabled(g.source._id, false, t.actor);
    await settleStandingRuns(g.source._id, 1);
    expect((await sources.get(g.source._id)).standingHistory).toHaveLength(2);
    expect((await sources.get(g.source._id)).standingRecompute).toBeUndefined();
    expect((await g.of(1)).lifecycle.state).toBe('POSSIBLY_STALE');

    // Another change crashes the same way; the sweep resumes it.
    sources.onStandingChanged = async () => {
      throw new Error('simulated crash after the standing write');
    };
    try {
      await expect(sources.setEnabled(g.source._id, true, t.actor)).rejects.toThrow('simulated crash');
    } finally {
      sources.onStandingChanged = hook;
    }
    expect((await sources.get(g.source._id)).standingRecompute).toBeDefined();
    expect(await t.market.resumeStandingRecomputes({ graceMs: 0 })).toBeGreaterThanOrEqual(1);
    expect((await sources.get(g.source._id)).standingRecompute).toBeUndefined();
  });
});

describe('L3: recompute_source_jobs skips CLOSED jobs, honours abort and resumes from its cursor', () => {
  it('an aborted run keeps its cursor; the next pass resumes after it and clears the marker', async () => {
    const g = await greenhouse('rc-l3');
    await g.listing([1, 2, 3, 4]);
    await g.close(4);
    const open = (await Promise.all([1, 2, 3].map((id) => g.of(id)))).map((j) => j._id).sort();
    const sources = t.market.sources.col;
    const pendingAt = new Date();
    await sources.updateOne(
      { _id: g.source._id },
      { $set: { standingRecompute: { pendingAt, cursor: null } } },
    );
    const evidence = t.market.evidence;
    const original = evidence.recompute.bind(evidence);
    const seen: string[] = [];
    const ac = new AbortController();
    evidence.recompute = async (id, opts) => {
      seen.push(id);
      const r = await original(id, opts);
      if (seen.length === 1) ac.abort(new Error('cancelled'));
      return r;
    };
    try {
      await expect(
        t.market.recomputeSourceJobs(g.source._id, { pageSize: 1, signal: ac.signal }),
      ).rejects.toThrow('cancelled');
      expect(seen).toEqual([open[0]]);
      expect((await t.market.sources.get(g.source._id)).standingRecompute).toEqual({
        pendingAt,
        cursor: open[0],
      });
      const rest = await t.market.recomputeSourceJobs(g.source._id, { pageSize: 1 });
      expect(rest.jobs).toBe(2);
      expect(seen).toEqual(open); // never the CLOSED job, never the first one again
    } finally {
      evidence.recompute = original;
    }
    expect((await t.market.sources.get(g.source._id)).standingRecompute).toBeUndefined();
  });

  it('a newer standing change supersedes a pass in progress', async () => {
    const g = await greenhouse('rc-l3b');
    await g.listing([1, 2, 3]);
    const sources = t.market.sources.col;
    await sources.updateOne(
      { _id: g.source._id },
      { $set: { standingRecompute: { pendingAt: new Date(Date.now() - 1000), cursor: null } } },
    );
    const newer = new Date();
    const evidence = t.market.evidence;
    const original = evidence.recompute.bind(evidence);
    evidence.recompute = async (id, opts) => {
      await sources.updateOne(
        { _id: g.source._id },
        { $set: { standingRecompute: { pendingAt: newer, cursor: null } } },
      );
      return original(id, opts);
    };
    try {
      expect((await t.market.recomputeSourceJobs(g.source._id, { pageSize: 1 })).jobs).toBe(1);
    } finally {
      evidence.recompute = original;
    }
    expect((await t.market.sources.get(g.source._id)).standingRecompute).toEqual({
      pendingAt: newer,
      cursor: null,
    });
  });
});

describe('L4: standing history never goes back in time', () => {
  it('an entry recorded under a clock that stepped back is clamped to just after the previous entry', async () => {
    const g = await greenhouse('rc-l4');
    await t.market.sources.setEnabled(g.source._id, false, t.actor);
    await settleStandingRuns(g.source._id, 1);
    const clock = t.market.ctx.clock;
    const now = clock.now;
    clock.now = () => new Date(Date.now() - DAY);
    try {
      await t.market.sources.setEnabled(g.source._id, true, t.actor);
    } finally {
      clock.now = now;
    }
    await settleStandingRuns(g.source._id, 2);
    const history = (await t.market.sources.get(g.source._id)).standingHistory!;
    expect(history.map((h) => h.enabled)).toEqual([true, false, true]);
    for (let i = 1; i < history.length; i++)
      expect(history[i]!.at.getTime()).toBeGreaterThan(history[i - 1]!.at.getTime());
    expect(history[2]!.at.getTime()).toBe(history[1]!.at.getTime() + 1);
    // Its own recompute ran (its key is its own time) and cleared the marker.
    expect((await t.market.sources.get(g.source._id)).standingRecompute).toBeUndefined();
  });
});

describe('L5: a repost is what the derivation says, not how a sighting arrived', () => {
  async function site(key: string) {
    return (
      await t.market.sources.register(
        {
          key: `careers:${key}`,
          name: `${key} careers site`,
          category: 'job_source',
          provider: 'careers_page',
          acquisition: { workflowKey: 'market.careers_page.crawl' },
          companyId,
          freshness: { policyClass: 'source.careers_page', maxAgeMinutes: 2160 },
          authority: { tier: 'official_site', listingIsComplete: false },
          governance: { accessMethod: 'public_web' },
        },
        t.actor,
      )
    ).source as SourceDoc;
  }
  const sighting = (s: SourceDoc, token: string, id: number, at: Date) =>
    t.market.jobPipeline.process({
      source: s,
      locator: `https://${token}.example/careers/${id}`,
      payload: {
        externalId: `site-${id}`,
        title: `Role ${token} ${id}`,
        descriptionText: `Own the unique ${token} programme number ${id} end to end.`,
        locations: [{ text: 'Remote' }],
        postingUrl: `${server.url}/careers/${token}/${id}`,
        provider: { name: 'careers_page' },
      },
      parser: { name: 'test', version: '1' },
      at,
    });

  it('a new copy sighted (late) before the closure is no repost; one sighted after it is', async () => {
    const g = await greenhouse('rc-l5');
    await g.listing([1, 2]);
    const s = await site('rc-l5');
    const closed1 = await g.close(1);
    const late = await sighting(s, 'rc-l5', 1, new Date(closed1.lifecycle.firstSeenAt.getTime() + 1));
    expect('jobId' in late && late.jobId).toBe(closed1._id);
    expect(late.outcome).not.toBe('reposted');
    const after1 = await g.of(1);
    expect(after1.reposts).toEqual([]);
    expect(after1.lifecycle.history.map((h) => h.to)).not.toContain('REPOSTED');

    const closed2 = await g.close(2);
    await tick();
    const repost = await sighting(s, 'rc-l5', 2, new Date());
    expect(repost).toMatchObject({ outcome: 'reposted', jobId: closed2._id, lifecycleState: 'REPOSTED' });
    const after2 = await g.of(2);
    expect(after2.reposts).toHaveLength(1);
    expect(after2.reposts[0]).toMatchObject({ previousState: 'CLOSED' });
  });
});

describe('L7: careers evidence is labelled at the crawl start, on its start URL', () => {
  it("the extract step labels the trigger's time and start URL; a re-run never moves the latest fetch or health over a newer failure", async () => {
    const startUrl = 'https://rc-l7.example/careers';
    const source = (
      await t.market.sources.register(
        {
          key: 'careers:rc-l7',
          name: 'rc-l7 careers page',
          category: 'job_source',
          provider: 'careers_page',
          endpoint: { url: startUrl },
          acquisition: { workflowKey: 'market.careers_page.crawl', config: { startUrl } },
          companyId,
          freshness: { policyClass: 'source.careers_page', maxAgeMinutes: 2160 },
          authority: { tier: 'official_site', listingIsComplete: false },
          governance: { accessMethod: 'public_web' },
        },
        t.actor,
      )
    ).source;
    const html =
      '<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Platform Engineer","description":"Build the platform.","identifier":"pe-1","datePosted":"2026-09-01"}</script>';
    const ctx = {
      runId: 'run_rc_l7',
      clock: { now: () => new Date() },
      signal: new AbortController().signal,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      artifacts: { readText: async () => html },
      records: { write: async (items: unknown[]) => ({ count: items.length }) },
      services: {
        get: (token: unknown) => {
          if (token === MARKET) return t.market;
          throw new Error('unexpected service');
        },
        has: (token: unknown) => token === MARKET && token !== AI_GATEWAY,
      },
    };
    const startedAt = new Date(Date.now() - HOUR);
    const input = {
      sourceId: source._id,
      pages: [{ url: `${startUrl}/pe-1`, artifact: { artifactId: 'a1' }, matched: true }],
      startedAt: startedAt.toISOString(),
      startUrl,
    };
    const run = async () =>
      (await extractJobsFromPages.execute(ctx as never, input as never, {
        useAiFallback: false,
        maxAiPages: 0,
      })) as { observedAt?: string; board?: unknown };
    const out = await run();
    expect(out.observedAt).toBe(startedAt.toISOString());
    expect(out.board).toMatchObject({ endpointUrl: startUrl });
    expect((await t.market.sources.get(source._id)).health).toMatchObject({
      status: 'healthy',
      latestFetch: { at: startedAt, ok: true },
    });
    // The endpoint moves and a newer crawl fails; then the older crawl's extract re-runs.
    await t.market.sources.update(source._id, { endpoint: { url: 'https://rc-l7.example/jobs' } }, t.actor);
    const failedAt = new Date();
    await t.market.sources.recordAttempt(source._id, 'run_rc_l7_newer');
    await t.market.sources.recordFetch(source._id, failedAt, false);
    await t.market.sources.recordFailure(source._id, 'crawl fetched no pages', 'run_rc_l7_newer');
    const failed = await t.market.sources.get(source._id);
    const again = await run();
    expect(again.observedAt).toBe(startedAt.toISOString());
    expect(again.board).toMatchObject({ endpointUrl: startUrl }); // the board it read, not the new one
    const after = await t.market.sources.get(source._id);
    expect(after.health).toMatchObject({
      status: failed.health.status,
      consecutiveFailures: failed.health.consecutiveFailures,
      latestFetch: { at: failedAt, ok: false },
    });
    expect(after.health.lastSuccessAt?.getTime()).toBe(failed.health.lastSuccessAt?.getTime());
  });
});

describe('re-verify #11 M-A: convergence never depends on a recorder — CLOSED jobs included', () => {
  const present = (job: JobDoc, at: Date) => {
    const copy = job.sourceRefs[0]!;
    return {
      _id: listingEvidenceKey(copy.key, at, 'present'),
      jobId: job._id,
      copyKey: copy.key,
      sourceId: copy.sourceId,
      board: copy.board ?? null,
      at,
      kind: 'listing' as const,
      outcome: 'present' as const,
      contentHash: copy.contentHash,
    } satisfies NewJobEvidence;
  };
  /** Close job `id` with two 404s, then move its whole history `ms` into the past. */
  async function closedLongAgo(g: Awaited<ReturnType<typeof greenhouse>>, id: number, ms: number) {
    const closed = await g.close(id);
    await t.market.evidence.col.updateMany({ copyKey: closed.sourceRefs[0]!.key }, [
      { $set: { at: { $subtract: ['$at', ms] } } },
    ]);
    await t.market.evidence.dropCheckpoint(closed._id);
    await t.market.evidence.recompute(closed._id);
    return g.of(id);
  }

  it("the reviewer's probe: a closed job's present evidence whose recorder never re-derived — listings, sweeps and toggles leave it; the recorded-evidence sweep heals it", async () => {
    const g = await greenhouse('rc-ma');
    await g.listing([1, 2]);
    const closed = await closedLongAgo(g, 1, 5 * DAY);
    expect(closed.lifecycle.state).toBe('CLOSED');
    expect(await t.market.evidence.record([present(closed, new Date())])).toBe(1); // never recomputed
    expect((await pureOf(closed._id)).state).toBe('REOPENED');
    // Nothing else touches a job CLOSED long ago.
    await tick();
    await g.listing([2]);
    await t.market.freshness.staleSweep();
    await t.market.sources.setEnabled(g.source._id, false, t.actor);
    await settleStandingRuns(g.source._id, 1);
    await t.market.sources.setEnabled(g.source._id, true, t.actor);
    await settleStandingRuns(g.source._id, 2);
    await t.market.resumeStandingRecomputes({ graceMs: 0 });
    expect((await g.of(1)).lifecycle.state).toBe('CLOSED');
    // The sweep leaves evidence younger than its lag margin (5 min) for later ...
    await t.market.evidence.sweepRecordedEvidence();
    expect((await g.of(1)).lifecycle.state).toBe('CLOSED');
    // ... and re-derives its job once it is older (here: the lag has passed).
    while (!(await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 })).complete);
    expect((await expectDerived(closed._id)).lifecycle.state).not.toBe('CLOSED');
  });

  it('the lag margin: evidence that becomes visible after a newer document is still swept', async () => {
    const g = await greenhouse('rc-lag');
    await g.listing([1, 2]);
    const y = await closedLongAgo(g, 1, 5 * DAY);
    const x = await g.of(2);
    // Times by the database clock (evidence `createdAt` is stamped by the server).
    const S = (await t.market.evidence.serverNow()).getTime();
    await sweepMark(new Date(S - 120_000));
    const backdate = async (id: string, createdAt: Date) =>
      t.market.evidence.col.updateOne({ _id: id }, { $set: { createdAt } });
    // A newer document (recorded at S-10 s) is visible first ...
    const newer = verificationEvidence(x, new Date(), 'inconclusive');
    await t.market.evidence.record([newer]);
    await backdate(newer._id, new Date(S - 10_000));
    while (!(await t.market.evidence.sweepRecordedEvidence({ lagMs: 60_000 })).complete);
    // ... then one recorded earlier (S-30 s, its insert slower) about a CLOSED job, never recomputed.
    const late = present(y, new Date());
    await t.market.evidence.record([late]);
    await backdate(late._id, new Date(S - 30_000));
    // The lag has passed.
    while (!(await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 })).complete);
    expect((await expectDerived(y._id)).lifecycle.state).not.toBe('CLOSED');
  });

  it('L-1: absences are recorded for recently CLOSED jobs, so absence-then-late-present equals present-then-absence', async () => {
    const g = await greenhouse('rc-l1-order');
    await g.listing([1, 2, 3]);
    const j1 = await g.close(1);
    const j2 = await g.close(2);
    await tick();
    const P = new Date();
    await tick();
    // j1, natural order: the sighting (after the closure) is recorded and re-derived first ...
    const inserted = await t.market.evidence.record([present(j1, P)]);
    await t.market.evidence.recompute(j1._id, { recorded: { inserted: inserted > 0 } });
    // ... then a newer complete listing lacks both jobs (j2 is still CLOSED when it is applied).
    await tick();
    await g.listing([3]);
    // j2, late order: the same (older) sighting arrives after the listing.
    const late = await t.market.evidence.record([present(j2, P)]);
    await t.market.evidence.recompute(j2._id, { recorded: { inserted: late > 0 } });
    const a = (await expectDerived(j1._id)).lifecycle;
    const b = (await expectDerived(j2._id)).lifecycle;
    expect(a).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveAbsences: 1 });
    expect({ state: b.state, abs: b.consecutiveAbsences, nf: b.consecutiveNotFound }).toEqual({
      state: a.state,
      abs: a.consecutiveAbsences,
      nf: a.consecutiveNotFound,
    });
  });
});

describe('re-verify #11 L-3: one failing source never starves the other standing recomputes', () => {
  it('a source whose recompute fails (or exhausts its budget) is logged and kept pending; the others complete', async () => {
    const a = await greenhouse('rc-l3-a');
    const b = await greenhouse('rc-l3-b');
    const c = await greenhouse('rc-l3-c');
    await a.listing([1]);
    await b.listing([1]);
    await c.listing([1, 2, 3]);
    const sources = t.market.sources.col;
    const old = new Date(Date.now() - DAY);
    for (const [g, dt] of [
      [a, 0],
      [c, 1],
      [b, 2],
    ] as const)
      await sources.updateOne(
        { _id: g.source._id },
        { $set: { standingRecompute: { pendingAt: new Date(old.getTime() + dt), cursor: null } } },
      );
    const failing = (await a.of(1))._id;
    const slow = new Set(await Promise.all([1, 2, 3].map(async (id) => (await c.of(id))._id)));
    const evidence = t.market.evidence;
    const original = evidence.recompute.bind(evidence);
    evidence.recompute = async (id, opts) => {
      if (id === failing) throw new Error('simulated failure');
      if (slow.has(id)) await new Promise((r) => setTimeout(r, 80));
      return original(id, opts);
    };
    let done: number;
    try {
      done = await t.market.resumeStandingRecomputes({ graceMs: 0, perSourceBudgetMs: 50 });
    } finally {
      evidence.recompute = original;
    }
    expect(done).toBeGreaterThanOrEqual(1);
    expect((await t.market.sources.get(a.source._id)).standingRecompute).toBeDefined(); // failed: kept
    // Out of budget: kept, resumed from its cursor by a later sweep.
    expect((await t.market.sources.get(c.source._id)).standingRecompute).toBeDefined();
    expect((await t.market.sources.get(b.source._id)).standingRecompute).toBeUndefined(); // completed
  });
});

describe('re-verify #11 L-4: health follows the latest fetch on every path', () => {
  it("the reviewer's A/B interleaving: A fetched, B failed later, A's finalize reports success — health shows B's failure", async () => {
    const g = await greenhouse('rc-l4h');
    const s = t.market.sources;
    const id = g.source._id;
    const tA = new Date(Date.now() - 60_000);
    const tB = new Date();
    await s.recordFetch(id, tA, true); // A: fetch node
    await s.recordFetch(id, tB, false); // B: fetch fails
    await s.recordFailure(id, 'HTTP 503 from greenhouse listing', 'run_B', tB);
    await s.recordSuccess(id, { runId: 'run_A', itemCount: 3, fetchAt: tA }); // A: finalize, late
    const after = (await s.get(id)).health;
    expect(after).toMatchObject({
      status: 'degraded',
      consecutiveFailures: 1,
      lastError: 'HTTP 503 from greenhouse listing',
      latestFetch: { at: tB, ok: false },
    });
    expect(after.lastSuccessAt).toBeUndefined();
    // The other order: A's success first, then B's failure — the same health.
    const h = await greenhouse('rc-l4h2');
    await s.recordFetch(h.source._id, tA, true);
    await s.recordSuccess(h.source._id, { runId: 'run_A2', itemCount: 3, fetchAt: tA });
    await s.recordFetch(h.source._id, tB, false);
    await s.recordFailure(h.source._id, 'HTTP 503 from greenhouse listing', 'run_B2', tB);
    expect((await s.get(h.source._id)).health).toMatchObject({ status: 'degraded', consecutiveFailures: 1 });
    // An older failure arriving after a newer success changes nothing either.
    const k = await greenhouse('rc-l4h3');
    await s.recordFetch(k.source._id, tB, true);
    await s.recordSuccess(k.source._id, { runId: 'run_C', fetchAt: tB });
    await s.recordFetch(k.source._id, tA, false);
    await s.recordFailure(k.source._id, 'late old failure', 'run_D', tA);
    expect((await s.get(k.source._id)).health).toMatchObject({
      status: 'healthy',
      consecutiveFailures: 0,
      latestFetch: { at: tB, ok: true },
    });
  });

  it("the ATS workflow end to end: an upload (A) processed after a newer fetch (B) failed keeps B's failure", async () => {
    const g = await greenhouse('rc-l4e');
    const s = t.market.sources;
    // A: an operator upload of the listing (its fetch time is the upload time) ...
    const { snapshotId } = await t.upload(
      g.source._id,
      JSON.stringify({ jobs: [g.gh(1), g.gh(2)] }),
      'application/json',
    );
    await tick();
    // ... B: a real fetch after it fails (no listing body: 404) ...
    bodies.delete(g.path('rc-l4e'));
    expect((await t.runSource(g.source._id)).state).toBe('FAILED');
    const failed = (await s.get(g.source._id)).health;
    expect(failed).toMatchObject({ status: 'degraded', latestFetch: { ok: false } });
    // ... then A is processed (its first processing is its acquisition): its fetch is older than
    // B's, so neither the latest fetch nor the health moves.
    expect((await t.runSource(g.source._id, { snapshotId })).state).toBe('COMPLETED');
    const after = (await s.get(g.source._id)).health;
    expect(after).toMatchObject({
      status: failed.status,
      consecutiveFailures: failed.consecutiveFailures,
      lastError: failed.lastError,
      latestFetch: failed.latestFetch,
    });
    expect(after.lastSuccessAt).toBeUndefined();
  });
});

describe('re-verify #12: the recorded-evidence sweep never stops for one job, and never trusts an app clock', () => {
  const presentOf = (job: JobDoc, at: Date): NewJobEvidence => {
    const copy = job.sourceRefs[0]!;
    return {
      _id: listingEvidenceKey(copy.key, at, 'present'),
      jobId: job._id,
      copyKey: copy.key,
      sourceId: copy.sourceId,
      board: copy.board ?? null,
      at,
      kind: 'listing',
      outcome: 'present',
      contentHash: copy.contentHash,
    };
  };
  async function closedLongAgo(g: Awaited<ReturnType<typeof greenhouse>>, id: number) {
    const closed = await g.close(id);
    await t.market.evidence.col.updateMany({ copyKey: closed.sourceRefs[0]!.key }, [
      { $set: { at: { $subtract: ['$at', 5 * DAY] } } },
    ]);
    await t.market.evidence.dropCheckpoint(closed._id);
    await t.market.evidence.recompute(closed._id);
    return g.of(id);
  }
  const sweepDoc = () =>
    t.market.ctx.db
      .collection<{ _id: string; at?: Date }>('market_job_evidence_sweeps')
      .findOne({ _id: 'recorded_evidence' });
  const failuresCol = () =>
    t.market.ctx.db.collection<{
      _id: string;
      failures: number;
      code: string;
      since: Date;
      lastAt: Date;
      dismissedCode?: string;
    }>('market_job_lifecycle_failures');
  const failErr = () =>
    Object.assign(new Error('Document failed validation'), {
      name: 'MongoServerError',
      code: 121,
      codeName: 'DocumentValidationFailure',
    });
  const drain = async () => {
    while (!(await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 })).complete);
  };
  /** Run `f` with the recompute of the given jobs throwing (`fail`) or intercepted (`hook`). */
  async function withRecompute<T>(
    hook: (id: string, next: () => Promise<unknown>) => Promise<unknown>,
    f: () => Promise<T>,
  ): Promise<T> {
    const evidence = t.market.evidence;
    const original = evidence.recompute.bind(evidence);
    evidence.recompute = (async (id: string, opts?: Parameters<typeof original>[1]) =>
      hook(id, () => original(id, opts))) as typeof evidence.recompute;
    try {
      return await f();
    } finally {
      evidence.recompute = original;
    }
  }

  it("MEDIUM-1, the reviewer's P2: job 1's recompute throws a validation error — job 2 (CLOSED, late present) is still healed; job 1 is kept for retry, reviewed after 3 failures, and its review dismissed when it recovers", async () => {
    await drain();
    await failuresCol().deleteMany({});
    const g = await greenhouse('rc-p2');
    await g.listing([1, 2]);
    const j1 = await g.of(1);
    const j2 = await closedLongAgo(g, 2);
    // Job 1's evidence is recorded first (earlier in the page), then job 2's late present.
    await t.market.evidence.record([verificationEvidence(j1, new Date(), 'inconclusive')]);
    await tick();
    await t.market.evidence.record([presentOf(j2, new Date())]);
    await withRecompute(
      async (id, next) => {
        if (id === j1._id) throw failErr();
        return next();
      },
      async () => {
        const first = await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 });
        expect(first).toMatchObject({ complete: true, failing: 1 });
        expect((await expectDerived(j2._id)).lifecycle.state).not.toBe('CLOSED');
        expect(await failuresCol().findOne({ _id: j1._id })).toMatchObject({
          failures: 1,
          code: 'DocumentValidationFailure',
        });
        // The watermark moved past both documents regardless.
        const latest = await t.market.evidence.col.find({}).sort({ createdAt: -1 }).limit(1).toArray();
        expect((await sweepDoc())!.at!.getTime()).toBeGreaterThanOrEqual(latest[0]!.createdAt.getTime());
        // Two more failing sweeps (failed jobs go first): a review, with a code only.
        for (let i = 0; i < 2; i++)
          expect((await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 })).retried).toBe(1);
      },
    );
    const review = await t.market.reviews.col.findOne({ dedupeKey: `lifecycle_failure:${j1._id}` });
    expect(review).toMatchObject({
      type: 'lifecycle_failure',
      status: 'open',
      allowedActions: ['dismiss'],
      entity: { kind: 'job', id: j1._id },
      context: { jobId: j1._id, code: 'DocumentValidationFailure', failures: 3 },
    });
    expect(JSON.stringify(review)).not.toContain('Document failed validation');
    // Fixed: the next sweep retries it first, removes its failure and dismisses its review.
    const healed = await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 });
    expect(healed).toMatchObject({ retried: 1, failing: 0 });
    expect(await failuresCol().findOne({ _id: j1._id })).toBeNull();
    expect(await t.market.reviews.col.findOne({ _id: review!._id })).toMatchObject({
      status: 'dismissed',
      resolution: expect.objectContaining({
        action: 'dismiss',
        actor: expect.objectContaining({ kind: 'system' }),
        reason: expect.stringContaining('re-derived successfully'),
      }),
    });
  });

  it('final P1: a sweep aborted mid-page after a job failed has already persisted that failure', async () => {
    await drain();
    await failuresCol().deleteMany({});
    const g = await greenhouse('rc-fp1');
    await g.listing([1, 2]);
    const j1 = await g.of(1);
    const j2 = await g.of(2);
    await drain();
    await t.market.evidence.record([verificationEvidence(j1, new Date(), 'inconclusive')]);
    await tick();
    await t.market.evidence.record([verificationEvidence(j2, new Date(Date.now() + 1), 'inconclusive')]);
    const ac = new AbortController();
    await withRecompute(
      async (id, next) => {
        if (id === j1._id) throw failErr();
        if (id === j2._id) ac.abort(new Error('lease lost')); // the node is cancelled mid-sweep
        return next();
      },
      () =>
        expect(
          t.market.evidence.sweepRecordedEvidence({ lagMs: 0, pageSize: 1, signal: ac.signal }),
        ).rejects.toThrow('lease lost'),
    );
    expect(await failuresCol().findOne({ _id: j1._id })).toMatchObject({ failures: 1 });
    // A later sweep retries it.
    expect(await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 })).toMatchObject({ failing: 0 });
    expect(await failuresCol().findOne({ _id: j1._id })).toBeNull();
  });

  it('final P2: with 150 jobs already failing, a newly failing job is kept and reviewed after 3 failures', async () => {
    await drain();
    await failuresCol().deleteMany({});
    const g = await greenhouse('rc-fp2');
    await g.listing([1]);
    const j1 = await g.of(1);
    await drain();
    const old = new Date(Date.now() - HOUR);
    const fake = Array.from({ length: 150 }, (_, i) => `job_rc_fp2_fake_${String(i).padStart(3, '0')}`);
    await failuresCol().insertMany(
      fake.map((_id) => ({ _id, failures: 1, code: 'X', since: old, lastAt: old })),
    );
    const failing = new Set([...fake, j1._id]);
    await withRecompute(
      async (id, next) => {
        if (failing.has(id)) throw failErr();
        return next();
      },
      async () => {
        await t.market.evidence.record([verificationEvidence(j1, new Date(), 'inconclusive')]);
        for (let i = 0; i < 3; i++) await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 });
      },
    );
    expect(await failuresCol().findOne({ _id: j1._id })).toMatchObject({ failures: 3 });
    expect(await failuresCol().countDocuments({})).toBe(151);
    expect(await t.market.reviews.col.findOne({ dedupeKey: `lifecycle_failure:${j1._id}` })).toMatchObject({
      status: 'open',
    });
    // The fakes do not exist: a sweep without the stub drops them (a vanished job is no failure).
    await drain();
    expect(await failuresCol().countDocuments({})).toBe(0);
  });

  it("final P3: overlapping sweeps never erase each other's failures", async () => {
    await drain();
    await failuresCol().deleteMany({});
    const g = await greenhouse('rc-fp3');
    await g.listing([1, 2]);
    const j1 = await g.of(1);
    const j2 = await g.of(2);
    await drain();
    await t.market.evidence.record([verificationEvidence(j1, new Date(), 'inconclusive')]);
    await tick();
    await t.market.evidence.record([verificationEvidence(j2, new Date(Date.now() + 1), 'inconclusive')]);
    let j2Calls = 0;
    let bReached!: () => void;
    const bReachedP = new Promise<void>((r) => (bReached = r));
    let aDone!: Promise<unknown>;
    await withRecompute(
      async (id, next) => {
        if (id === j1._id) throw failErr();
        if (id === j2._id) {
          j2Calls += 1;
          if (j2Calls === 1)
            await bReachedP; // A waits until B has started
          else if (j2Calls === 2) {
            bReached();
            await aDone.catch(() => undefined); // B finishes after A
          }
        }
        return next();
      },
      async () => {
        aDone = t.market.evidence.sweepRecordedEvidence({ lagMs: 0, pageSize: 1 });
        await new Promise((r) => setTimeout(r, 300)); // A has passed j1 and waits on j2
        const bDone = t.market.evidence.sweepRecordedEvidence({ lagMs: 0, pageSize: 1 });
        await Promise.all([aDone, bDone]);
      },
    );
    expect(j2Calls).toBeGreaterThanOrEqual(2);
    expect(await failuresCol().findOne({ _id: j1._id })).toMatchObject({ code: 'DocumentValidationFailure' });
    await drain();
  });

  it('final L2: after an operator dismissal, the review is not raised again until the error code changes', async () => {
    await drain();
    await failuresCol().deleteMany({});
    const g = await greenhouse('rc-fl2');
    await g.listing([1]);
    const j1 = await g.of(1);
    await drain();
    let err: Error = failErr();
    await withRecompute(
      async (id, next) => {
        if (id === j1._id) throw err;
        return next();
      },
      async () => {
        await t.market.evidence.record([verificationEvidence(j1, new Date(), 'inconclusive')]);
        for (let i = 0; i < 3; i++) await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 });
        const item = await t.market.reviews.col.findOne({
          dedupeKey: `lifecycle_failure:${j1._id}`,
          status: 'open',
        });
        expect(item).not.toBeNull();
        await t.market.reviewService.resolve(
          item!._id,
          { action: 'dismiss', reason: 'known issue' },
          t.actor,
        );
        // Same code: not raised again.
        for (let i = 0; i < 2; i++) await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 });
        expect(
          await t.market.reviews.col.countDocuments({
            dedupeKey: `lifecycle_failure:${j1._id}`,
            status: 'open',
          }),
        ).toBe(0);
        expect(await failuresCol().findOne({ _id: j1._id })).toMatchObject({
          dismissedCode: 'DocumentValidationFailure',
        });
        // Another code: raised again.
        err = Object.assign(new Error('write conflict'), {
          name: 'MongoServerError',
          code: 112,
          codeName: 'WriteConflict',
        });
        await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 });
        expect(
          await t.market.reviews.col.findOne({ dedupeKey: `lifecycle_failure:${j1._id}`, status: 'open' }),
        ).toMatchObject({ context: { code: 'WriteConflict' } });
      },
    );
    await drain();
  });

  it("merge m6 × m11: the recovery auto-dismiss goes through M11's claim (single CAS, confirmClaimed) and never takes an operator's claim", async () => {
    await drain();
    await failuresCol().deleteMany({});
    const g = await greenhouse('rc-m11');
    await g.listing([1, 2, 3]);
    const [free, busy, stale] = [await g.of(1), await g.of(2), await g.of(3)];
    await drain();
    const failing = new Set([free._id, busy._id, stale._id]);
    await withRecompute(
      async (id, next) => {
        if (failing.has(id)) throw failErr();
        return next();
      },
      async () => {
        await t.market.evidence.record(
          [free, busy, stale].map((j) => verificationEvidence(j, new Date(), 'inconclusive')),
        );
        for (let i = 0; i < 3; i++) await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 });
      },
    );
    const itemOf = async (jobId: string) =>
      (await t.market.reviews.col.findOne({ dedupeKey: `lifecycle_failure:${jobId}` }))!;
    const [freeItem, busyItem, staleItem] = [
      await itemOf(free._id),
      await itemOf(busy._id),
      await itemOf(stale._id),
    ];
    for (const item of [freeItem, busyItem, staleItem]) {
      expect(item.status).toBe('open');
      expect(item.context.evidenceHash).toBeUndefined(); // a lifecycle_failure item carries no digest
    }
    // An operator is deciding `busy` right now, and decided `stale` long ago (a crashed resolver),
    // both with an If-Match (accepted: the item has no digest).
    const svc = t.market.reviewService;
    const operator = { kind: 'internal-operator' as const, id: 'dana' };
    const decision = { action: 'dismiss' as const, reason: 'known infrastructure issue' };
    await svc.claim(busyItem._id, 'rop_dana_busy', decision, operator, 'shown-on-screen');
    await svc.claim(staleItem._id, 'rop_dana_stale', decision, operator, 'shown-on-screen');
    await svc.operations.updateOne(
      { _id: staleItem._id },
      { $set: { 'owner.at': new Date(Date.now() - REVIEW_CLAIM_STALE_MS - 60_000) } },
    );

    // The jobs heal: the next sweep dismisses their reviews as the system and removes their
    // failures — except `busy`'s, whose item the operator is deciding (review L-2: kept, retried).
    expect(await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 })).toMatchObject({ failing: 1 });
    expect(await failuresCol().findOne({ _id: busy._id })).not.toBeNull();

    // 1. No claim in progress: dismissed by the system through the operation record.
    expect(await t.market.reviews.get(freeItem._id)).toMatchObject({
      status: 'dismissed',
      resolution: {
        action: 'dismiss',
        actor: { kind: 'system', id: 'market-lifecycle-recovery' },
        operationId: `rop_recovered_${freeItem._id}`,
      },
    });
    const freeOp = await svc.operations.findOne({ _id: freeItem._id });
    expect(freeOp).toMatchObject({ state: 'completed', generation: 1 });
    expect(freeOp?.shownEvidenceHash).toBeUndefined();

    // 2. A fresh operator claim is not taken: the item stays the operator's, still open.
    const busyNow = await t.market.reviews.get(busyItem._id);
    expect(busyNow.status).toBe('open');
    expect(busyNow.claim?.operationId).toBe('rop_dana_busy');
    expect(await svc.operations.findOne({ _id: busyItem._id })).toMatchObject({
      state: 'claimed',
      generation: 1,
      owner: { operationId: 'rop_dana_busy' },
      shownEvidenceHash: 'shown-on-screen',
    });
    // ... and the operator completes their own decision.
    expect(
      await svc.resolve(busyItem._id, { ...decision, evidenceHash: 'shown-on-screen' }, operator, {
        operationId: 'rop_dana_busy',
      }),
    ).toMatchObject({
      status: 'dismissed',
      resolution: { reason: decision.reason, actor: { id: 'dana' }, operationId: 'rop_dana_busy' },
    });

    // 3. A crashed operator's claim is recovered, and completes the OPERATOR's decision (the
    //    system's own dismissal is never substituted for it).
    expect(await t.market.reviews.get(staleItem._id)).toMatchObject({
      status: 'dismissed',
      resolution: { reason: decision.reason, actor: { id: 'dana' }, operationId: 'rop_dana_stale' },
    });
    expect(await svc.operations.findOne({ _id: staleItem._id })).toMatchObject({
      state: 'completed',
      generation: 2,
      recoveredFrom: ['rop_dana_stale'],
    });
    // The operator finished: the next sweep finds nothing left open for `busy` and settles it.
    // Every healed job's failure record is gone; the operator's decision is untouched.
    expect(await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 })).toMatchObject({ failing: 0 });
    expect(await failuresCol().countDocuments({ _id: { $in: [...failing] } })).toBe(0);
    expect(await t.market.reviews.get(busyItem._id)).toMatchObject({
      status: 'dismissed',
      resolution: { actor: { id: 'dana' }, operationId: 'rop_dana_busy' },
    });
  });

  it('LOW-1: evidence recorded under a 7-minute-slow app clock is stamped by the server and still swept', async () => {
    while (!(await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 })).complete);
    const g = await greenhouse('rc-skew');
    await g.listing([1, 2]);
    const closed = await closedLongAgo(g, 1);
    while (!(await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 })).complete);
    const clock = t.market.ctx.clock;
    const now = clock.now;
    clock.now = () => new Date(Date.now() - 7 * 60_000); // the recorder's clock is 7 minutes slow
    const e = presentOf(closed, new Date());
    try {
      await t.market.evidence.record([e]); // never recomputed
    } finally {
      clock.now = now;
    }
    const stored = await t.market.evidence.col.findOne({ _id: e._id });
    const server = await t.market.evidence.serverNow();
    expect(Math.abs(server.getTime() - stored!.createdAt.getTime())).toBeLessThan(60_000);
    while (!(await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 })).complete);
    expect((await expectDerived(closed._id)).lifecycle.state).not.toBe('CLOSED');
  });

  it('LOW-2: a sweep reports whether it caught up and how far its watermark trails; it keeps going while behind', async () => {
    const g = await greenhouse('rc-behind');
    await g.listing([1]);
    const j = await g.of(1);
    const copy = j.sourceRefs[0]!;
    const start = Date.now() - DAY;
    await t.market.evidence.record(
      Array.from({ length: 300 }, (_, i) => ({
        _id: `behind:${i}`,
        jobId: j._id,
        copyKey: copy.key,
        sourceId: copy.sourceId,
        board: copy.board ?? null,
        at: new Date(start + i * 60_000),
        kind: 'listing' as const,
        outcome: 'present' as const,
      })),
    );
    // The watermark just before these 300 documents.
    const first = await t.market.evidence.col
      .find({ _id: /^behind:/ })
      .sort({ createdAt: 1 })
      .limit(1)
      .toArray();
    await sweepMark(new Date(first[0]!.createdAt.getTime() - 1));
    const behind = await t.market.evidence.sweepRecordedEvidence({ lagMs: 0, pageSize: 10, budgetMs: 0 });
    expect(behind.complete).toBe(false);
    expect(behind.lagMs).toBeGreaterThan(0);
    // Out of budget, a pass still reads one page (M6.2 L4: the watermark always moves).
    expect(behind.evidence).toBe(10);
    // Within one budget it keeps paging until it has caught up.
    const caughtUp = await t.market.evidence.sweepRecordedEvidence({ lagMs: 0, pageSize: 10 });
    expect(caughtUp).toMatchObject({ complete: true, lagMs: 0 });
    expect(caughtUp.evidence).toBeGreaterThanOrEqual(290);
  });

  it('LOW-3: F, S (finalize late), F, F — the failure streak is 2', async () => {
    const g = await greenhouse('rc-streak');
    const s = t.market.sources;
    const id = g.source._id;
    const base = Date.now() - 10 * 60_000;
    const at = (m: number) => new Date(base + m * 60_000);
    await s.recordFetch(id, at(1), false, 'run_F1');
    await s.recordFailure(id, 'HTTP 503', 'run_F1', at(1));
    await s.recordFetch(id, at(2), true, 'run_S'); // S fetched; its finalize is still to come
    await s.recordFetch(id, at(3), false, 'run_F2');
    await s.recordFailure(id, 'HTTP 503', 'run_F2', at(3));
    await s.recordFetch(id, at(4), false, 'run_F3');
    await s.recordFailure(id, 'HTTP 503', 'run_F3', at(4));
    await s.recordSuccess(id, { runId: 'run_S', fetchAt: at(2) }); // late: not the latest fetch
    expect((await s.get(id)).health).toMatchObject({ consecutiveFailures: 2, status: 'degraded' });
    // A retried failure of the same run, and a replay of the same fetch, count nothing more.
    await s.recordFetch(id, at(5), false, 'run_F3');
    await s.recordFetch(id, at(5), false, 'run_F3');
    expect((await s.get(id)).health.consecutiveFailures).toBe(2);
    // A newer success resets it.
    await s.recordFetch(id, at(6), true, 'run_S2');
    expect((await s.get(id)).health.consecutiveFailures).toBe(0);
  });

  it('final L3: R1 fails, R2 fails, R1 retried fails — the streak is 2 (a run counts once)', async () => {
    const g = await greenhouse('rc-streak2');
    const s = t.market.sources;
    const id = g.source._id;
    const base = Date.now() - 10 * 60_000;
    const at = (m: number) => new Date(base + m * 60_000);
    await s.recordFetch(id, at(1), false, 'run_R1');
    await s.recordFetch(id, at(2), false, 'run_R2');
    await s.recordFetch(id, at(3), false, 'run_R1'); // R1's retry, after R2
    expect((await s.get(id)).health.consecutiveFailures).toBe(2);
    await s.recordFetch(id, at(4), false, 'run_R3');
    expect((await s.get(id)).health.consecutiveFailures).toBe(3);
    // A success clears the streak and its runs: R1 failing again later is a new failure.
    await s.recordFetch(id, at(5), true, 'run_R4');
    await s.recordFetch(id, at(6), false, 'run_R1');
    expect((await s.get(id)).health).toMatchObject({ consecutiveFailures: 1, failedRuns: ['run_R1'] });
  });

  it('LOW-4: standing resume rotates past a source that keeps failing', async () => {
    const a = await greenhouse('rc-rot-a');
    const b = await greenhouse('rc-rot-b');
    await a.listing([1]);
    await b.listing([1]);
    const old = new Date(Date.now() - DAY);
    await t.market.sources.col.updateOne(
      { _id: a.source._id },
      { $set: { standingRecompute: { pendingAt: new Date(old.getTime() - 60_000), cursor: null } } },
    );
    await t.market.sources.col.updateOne(
      { _id: b.source._id },
      { $set: { standingRecompute: { pendingAt: old, cursor: null } } },
    );
    // Clear any other pending markers so the rotation is between these two.
    await t.market.sources.col.updateMany(
      { _id: { $nin: [a.source._id, b.source._id] } },
      { $unset: { standingRecompute: '' } },
    );
    const failing = (await a.of(1))._id;
    const evidence = t.market.evidence;
    const original = evidence.recompute.bind(evidence);
    evidence.recompute = async (id, opts) => {
      if (id === failing) throw new Error('simulated failure');
      return original(id, opts);
    };
    try {
      expect(await t.market.resumeStandingRecomputes({ graceMs: 0, limit: 1 })).toBe(0); // A, fails
      expect(await t.market.resumeStandingRecomputes({ graceMs: 0, limit: 1 })).toBe(1); // B, not A again
    } finally {
      evidence.recompute = original;
    }
    expect((await t.market.sources.get(b.source._id)).standingRecompute).toBeUndefined();
    expect((await t.market.sources.get(a.source._id)).standingRecompute?.lastAttemptAt).toBeDefined();
  });

  it("LOW-4: finalize `absent` counts open jobs only (a CLOSED job's absence is evidence, not counted)", async () => {
    const g = await greenhouse('rc-absent-count');
    await g.listing([1, 2, 3]);
    const closed = await g.close(1);
    const source = await t.market.sources.get(g.source._id);
    const at = new Date();
    const res = await t.market.jobPipeline.applyListingAbsences(source, new Set(['3']), at, 'snap_rc_count');
    expect(res).toMatchObject({ absent: 1, alreadyApplied: 0 }); // job 2 only
    // The CLOSED job's absence was recorded as evidence all the same.
    expect(
      await t.market.evidence.col.countDocuments({
        copyKey: closed.sourceRefs[0]!.key,
        kind: 'listing',
        outcome: 'absent',
      }),
    ).toBe(1);
    const again = await t.market.jobPipeline.applyListingAbsences(
      source,
      new Set(['3']),
      at,
      'snap_rc_count',
    );
    expect(again).toMatchObject({ absent: 0, alreadyApplied: 1 });
  });

  // ------------------------------------------------------------------ M6.2 follow-ups

  /** A job that fails `n` sweeps in a row (its recompute throws); a review is open after 3. */
  async function failingStreak(j: JobDoc, n: number, err: () => Error = failErr) {
    await withRecompute(
      async (id, next) => {
        if (id === j._id) throw err();
        return next();
      },
      async () => {
        await t.market.evidence.record([verificationEvidence(j, new Date(), 'inconclusive')]);
        for (let i = 0; i < n; i++) await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 });
      },
    );
  }
  const openReview = (jobId: string) =>
    t.market.reviews.col.findOne({ dedupeKey: `lifecycle_failure:${jobId}`, status: 'open' });

  it('M6.2 L1 repro A: a recovery whose auto-dismiss failed is retried until the review is dismissed', async () => {
    await drain();
    await failuresCol().deleteMany({});
    const g = await greenhouse('rc-l1a');
    await g.listing([1]);
    const j1 = await g.of(1);
    await drain();
    await failingStreak(j1, 3);
    const item = await openReview(j1._id);
    expect(item).not.toBeNull();
    // The job heals, but the system's dismissal fails once.
    const svc = t.market.reviewService;
    const resolve = svc.resolve.bind(svc);
    let calls = 0;
    svc.resolve = (async (...a: Parameters<typeof resolve>) => {
      if (a[0] === item!._id && calls++ === 0) throw new Error('transient: primary stepped down');
      return resolve(...a);
    }) as typeof svc.resolve;
    try {
      for (let i = 0; i < 3; i++) await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 });
    } finally {
      svc.resolve = resolve;
    }
    expect(calls).toBeGreaterThanOrEqual(2); // retried after the failed attempt
    expect(await t.market.reviews.get(item!._id)).toMatchObject({
      status: 'dismissed',
      resolution: { actor: { kind: 'system', id: 'market-lifecycle-recovery' } },
    });
    expect(await failuresCol().findOne({ _id: j1._id })).toBeNull();
  });

  it('M6.2 L1 repro B: a sweep that raises the review after an overlapping sweep healed the job dismisses it', async () => {
    await drain();
    await failuresCol().deleteMany({});
    const g = await greenhouse('rc-l1b');
    await g.listing([1]);
    const j1 = await g.of(1);
    await drain();
    await failingStreak(j1, 2);
    let failing = true;
    let overlapped = false;
    const reviews = t.market.reviews;
    const raise = reviews.raise.bind(reviews);
    reviews.raise = (async (input: Parameters<typeof raise>[0]) => {
      if (input.dedupeKey === `lifecycle_failure:${j1._id}` && !overlapped) {
        // A's third failure is persisted (failures = 3); before A raises, sweep B heals the job.
        overlapped = true;
        expect(await failuresCol().findOne({ _id: j1._id })).toMatchObject({ failures: 3 });
        failing = false;
        await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 });
        expect(await failuresCol().findOne({ _id: j1._id })).toBeNull();
        expect(await openReview(j1._id)).toBeNull();
      }
      return raise(input);
    }) as typeof reviews.raise;
    try {
      await withRecompute(
        async (id, next) => {
          if (id === j1._id && failing) throw failErr();
          return next();
        },
        () => t.market.evidence.sweepRecordedEvidence({ lagMs: 0 }), // sweep A
      );
    } finally {
      reviews.raise = raise;
    }
    expect(overlapped).toBe(true);
    // No orphan: the review A raised is dismissed by the system, and nothing is failing.
    expect(await openReview(j1._id)).toBeNull();
    expect(
      await t.market.reviews.col.findOne({ dedupeKey: `lifecycle_failure:${j1._id}`, status: 'dismissed' }),
    ).toMatchObject({ resolution: { actor: { kind: 'system' } } });
    expect(await failuresCol().findOne({ _id: j1._id })).toBeNull();
  });

  it("M6.2 L1: the late raiser's dismissal fails — the failure document is put back and the next sweep dismisses", async () => {
    await drain();
    await failuresCol().deleteMany({});
    const g = await greenhouse('rc-l1c');
    await g.listing([1]);
    const j1 = await g.of(1);
    await drain();
    await failingStreak(j1, 2);
    let failing = true;
    let overlapped = false;
    let refuse = false;
    const reviews = t.market.reviews;
    const raise = reviews.raise.bind(reviews);
    reviews.raise = (async (input: Parameters<typeof raise>[0]) => {
      if (input.dedupeKey === `lifecycle_failure:${j1._id}` && !overlapped) {
        overlapped = true;
        failing = false;
        await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 }); // B heals it first
        refuse = true; // A's own dismissal (after its raise) fails
      }
      return raise(input);
    }) as typeof reviews.raise;
    const svc = t.market.reviewService;
    const resolve = svc.resolve.bind(svc);
    svc.resolve = (async (...a: Parameters<typeof resolve>) => {
      if (refuse) {
        refuse = false;
        throw new Error('transient');
      }
      return resolve(...a);
    }) as typeof svc.resolve;
    try {
      await withRecompute(
        async (id, next) => {
          if (id === j1._id && failing) throw failErr();
          return next();
        },
        () => t.market.evidence.sweepRecordedEvidence({ lagMs: 0 }),
      );
      expect(await openReview(j1._id)).not.toBeNull();
      // The job is back on the retry list, so the next sweep dismisses it.
      expect(await failuresCol().findOne({ _id: j1._id })).toMatchObject({ failures: 3 });
      await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 });
    } finally {
      reviews.raise = raise;
      svc.resolve = resolve;
    }
    expect(await openReview(j1._id)).toBeNull();
    expect(await failuresCol().findOne({ _id: j1._id })).toBeNull();
  });

  it.each([
    ['a later lastAt', { $inc: { failures: 1 }, $set: { lastAt: new Date(Date.now() + 60_000) } }],
    ['the same-millisecond lastAt (failures only, review L-c)', { $inc: { failures: 1 } }],
  ])('M6.2 L1: a failure recorded while a recovery is dismissing is kept — %s', async (_name, overlap) => {
    await drain();
    await failuresCol().deleteMany({});
    const g = await greenhouse(`rc-l1d-${_name.length}`);
    await g.listing([1]);
    const j1 = await g.of(1);
    await drain();
    await failingStreak(j1, 3);
    const evidence = t.market.evidence;
    const hook = evidence.onLifecycleRecovered!;
    evidence.onLifecycleRecovered = async (jobId) => {
      const ok = await hook(jobId);
      // An overlapping sweep's recompute of the job fails meanwhile (a new failure is recorded).
      await failuresCol().updateOne({ _id: jobId }, overlap as never);
      return ok;
    };
    try {
      await evidence.sweepRecordedEvidence({ lagMs: 0 });
    } finally {
      evidence.onLifecycleRecovered = hook;
    }
    expect(await failuresCol().findOne({ _id: j1._id })).toMatchObject({ failures: 4 });
    await drain();
    expect(await failuresCol().findOne({ _id: j1._id })).toBeNull();
  });

  it('M6.2 review L-b: a recovery whose dismissal keeps failing moves to the back of the retry list', async () => {
    await drain();
    await failuresCol().deleteMany({});
    const g = await greenhouse('rc-l1-lb');
    await g.listing([1]);
    const j1 = await g.of(1);
    await drain();
    await failingStreak(j1, 3);
    const before = (await failuresCol().findOne({ _id: j1._id }))!;
    const evidence = t.market.evidence;
    const hook = evidence.onLifecycleRecovered!;
    evidence.onLifecycleRecovered = async () => false; // the dismissal keeps failing
    try {
      await tick();
      await evidence.sweepRecordedEvidence({ lagMs: 0 });
    } finally {
      evidence.onLifecycleRecovered = hook;
    }
    const after = (await failuresCol().findOne({ _id: j1._id }))!;
    expect(after.failures).toBe(before.failures); // not a new failure
    expect(after.lastAt.getTime()).toBeGreaterThan(before.lastAt.getTime()); // rotated
    await drain();
    expect(await failuresCol().findOne({ _id: j1._id })).toBeNull();
  });

  it('M6.2 review L-2: a triage (API-9) claim does not hold off the recovery dismissal', async () => {
    await drain();
    await failuresCol().deleteMany({});
    const g = await greenhouse('rc-l2-triage');
    await g.listing([1]);
    const j1 = await g.of(1);
    await drain();
    await failingStreak(j1, 3);
    const item = (await openReview(j1._id))!;
    await t.market.reviewTriage.claim(item._id, { holder: 'dana-tab', ttlMinutes: 30 }, t.actor);
    expect((await t.market.reviews.get(item._id)).assignment).toBeDefined();
    await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 });
    expect(await t.market.reviews.get(item._id)).toMatchObject({
      status: 'dismissed',
      resolution: { actor: { kind: 'system', id: 'market-lifecycle-recovery' } },
    });
    expect(await failuresCol().findOne({ _id: j1._id })).toBeNull();
  });

  it('M6.2 L2: an operator dismissal silences only its own streak; after a recovery the same code is reviewed again', async () => {
    await drain();
    await failuresCol().deleteMany({});
    const g = await greenhouse('rc-l2b');
    await g.listing([1]);
    const j1 = await g.of(1);
    await drain();
    await failingStreak(j1, 3);
    const first = (await openReview(j1._id))!;
    await t.market.reviewService.resolve(first._id, { action: 'dismiss', reason: 'known issue' }, t.actor);
    // The job recovers: its failure document goes; the operator's dismissal is untouched.
    await t.market.evidence.sweepRecordedEvidence({ lagMs: 0 });
    expect(await failuresCol().findOne({ _id: j1._id })).toBeNull();
    expect(await t.market.reviews.get(first._id)).toMatchObject({
      status: 'dismissed',
      resolution: { reason: 'known issue', actor: { id: t.actor.id } },
    });
    await tick();
    // A new streak with the same code: reviewed again.
    await failingStreak(j1, 3);
    const second = await openReview(j1._id);
    expect(second).toMatchObject({ context: { code: 'DocumentValidationFailure', failures: 3 } });
    expect(second!._id).not.toBe(first._id);
    await drain();
  });

  it('M6.2 L3: the dismissed-code lookup is served by by_entity (keys examined do not grow with the closed queue)', async () => {
    await drain();
    await failuresCol().deleteMany({});
    const g = await greenhouse('rc-l3idx');
    await g.listing([1]);
    const j1 = await g.of(1);
    await drain();
    // Many closed items about other jobs.
    const now = new Date();
    await t.market.reviews.col.insertMany(
      Array.from({ length: 400 }, (_, i) => ({
        _id: `rev_l3idx_${i}_${now.getTime()}`,
        type: 'lifecycle_failure' as const,
        severity: 'medium' as const,
        priority: 200,
        status: 'dismissed' as const,
        dedupeKey: `lifecycle_failure:job_l3idx_other_${i}`,
        entity: { kind: 'job' as const, id: `job_l3idx_other_${i}` },
        subject: 's',
        reason: 'r',
        evidence: [],
        candidates: [],
        observationIds: [],
        context: { code: 'X' },
        allowedActions: ['dismiss' as const],
        occurrences: 1,
        resolution: {
          action: 'dismiss' as const,
          reason: 'old',
          actor: { kind: 'internal-operator', id: 'x' },
          at: now,
        },
        schemaVersion: 1,
        createdAt: now,
        updatedAt: new Date(now.getTime() + i),
      })),
    );
    // Capture the queries the raise makes for this job's closed items (filter and sort).
    const seen: Array<{ filter: Record<string, unknown>; sort?: Record<string, 1 | -1> }> = [];
    type Find = (this: Collection, filter: Record<string, unknown>, ...rest: unknown[]) => FindCursor;
    const proto = Collection.prototype as unknown as { find: Find };
    const find = proto.find;
    proto.find = function (this: Collection, filter: Record<string, unknown>, ...rest: unknown[]) {
      const cursor = find.call(this, filter, ...rest);
      if (
        this.collectionName === 'market_review_items' &&
        filter?.dedupeKey === `lifecycle_failure:${j1._id}` &&
        filter.status !== 'open'
      ) {
        const q: (typeof seen)[number] = { filter };
        seen.push(q);
        const sort = cursor.sort.bind(cursor);
        cursor.sort = ((s: Record<string, 1 | -1>) => {
          q.sort = s;
          return sort(s);
        }) as typeof cursor.sort;
      }
      return cursor;
    } as Find;
    try {
      await failingStreak(j1, 3);
    } finally {
      proto.find = find;
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const q of seen) {
      const plan = (await t.market.reviews.col
        .find(q.filter as never)
        .sort(q.sort ?? {})
        .limit(1)
        .explain('executionStats')) as unknown as {
        executionStats: { totalKeysExamined: number; totalDocsExamined: number };
        queryPlanner: { winningPlan: unknown };
      };
      expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('by_entity');
      expect(plan.executionStats.totalKeysExamined).toBeLessThan(10);
      expect(plan.executionStats.totalDocsExamined).toBeLessThan(10);
    }
    await t.market.reviews.col.deleteMany({ _id: /^rev_l3idx_/ });
    await drain();
  });

  it('M6.2 L4: slow failing jobs on the retry list never stop the watermark from moving', async () => {
    await drain();
    await failuresCol().deleteMany({});
    const g = await greenhouse('rc-l4slow');
    await g.listing([1]);
    const j1 = await g.of(1);
    await drain();
    const old = new Date(Date.now() - HOUR);
    const fake = Array.from({ length: 60 }, (_, i) => `job_rc_l4slow_${String(i).padStart(2, '0')}`);
    await failuresCol().insertMany(
      fake.map((_id) => ({ _id, failures: 1, code: 'X', since: old, lastAt: old })),
    );
    const e = verificationEvidence(j1, new Date(), 'inconclusive');
    await t.market.evidence.record([e]);
    const recorded = (await t.market.evidence.col.findOne({ _id: e._id }))!;
    const slow = new Set(fake);
    const before = (await sweepDoc())!.at!;
    await withRecompute(
      async (id, next) => {
        if (slow.has(id)) {
          await new Promise((r) => setTimeout(r, 100));
          throw failErr();
        }
        return next();
      },
      async () => {
        const res = await t.market.evidence.sweepRecordedEvidence({ lagMs: 0, budgetMs: 2000 });
        // About half the budget went to retries (10 × 100 ms, plus the one that crossed it).
        expect(res.retried).toBeGreaterThanOrEqual(5);
        expect(res.retried).toBeLessThanOrEqual(12);
      },
    );
    const after = (await sweepDoc())!.at!;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
    expect(after.getTime()).toBeGreaterThanOrEqual(recorded.createdAt.getTime());
    await failuresCol().deleteMany({ _id: { $in: fake } });
  }, 60_000);

  it('M6.2 MR3: a recompute never writes a lifecycle onto a merged record (an over-long merge chain is a conflict)', async () => {
    const g = await greenhouse('rc-mr3');
    await g.listing([1]);
    const live = await g.of(1);
    // m0 → m1 → … → m11 → live: longer than the merge chain limit.
    const stamp = Date.now();
    const ids = Array.from({ length: 12 }, (_, i) => `job_rc_mr3_${i}_${stamp}`);
    await t.market.jobs.col.insertMany(
      ids.map((id, i) => ({
        ...live,
        _id: id,
        status: 'merged' as const,
        mergedInto: ids[i + 1] ?? live._id,
        sourceKeys: [],
      })),
    );
    const revs = async () =>
      (await t.market.jobs.col.find({ _id: { $in: ids } }).toArray()).map((j) => [j._id, j.rev]);
    const before = await revs();
    await expect(
      t.market.evidence.recompute(ids[0]!, { recorded: { inserted: true } }),
    ).rejects.toMatchObject({ name: 'MergeChainError' });
    expect(await revs()).toEqual(before);
    // A short chain resolves to the survivor, which is what is written.
    const r = await t.market.evidence.recompute(ids[11]!, { recorded: { inserted: true } });
    expect(r.after._id).toBe(live._id);
    expect(await revs()).toEqual(before);
    await t.market.jobs.col.deleteMany({ _id: { $in: ids } });
  });

  const historyOf = async (jobId: string) =>
    new Map(
      (
        await listEntityRuns(
          t.market.ctx.db,
          t.runtime.engine.runs as never,
          'job',
          jobId,
          entityRunsQuerySchema.parse({}),
        )
      ).items.map((r) => [r._id, r.linkedBy]),
    );

  it('M6.2 MR2: the runs that re-derive a job (standing change, freshness sweep) are in its run history', async () => {
    await drain();
    await failuresCol().deleteMany({});
    const g = await greenhouse('rc-mr2');
    await g.listing([1, 2]);
    const j = await g.of(1);
    // Five days pass without a confirmation for job 1 (evidence moved back; checkpoint dropped).
    await t.market.evidence.col.updateMany({ copyKey: j.sourceRefs[0]!.key }, [
      { $set: { at: { $subtract: ['$at', 5 * DAY] } } },
    ]);
    await t.market.evidence.dropCheckpoint(j._id);
    await t.market.sources.setEnabled(g.source._id, false, t.actor);
    const [standing] = await settleStandingRuns(g.source._id, 1);
    expect((await g.of(1)).lifecycle.state).toBe('POSSIBLY_STALE');
    expect((await historyOf(j._id)).get(standing!._id)).toEqual(['audit']);
    const audit = await t.market.audit.list({ entityKind: 'job', entityId: j._id });
    expect(audit.find((e) => e.runId === standing!._id)).toMatchObject({
      action: 'job.lifecycle_rederived',
      actor: { kind: 'system' },
      details: {
        cause: 'source_standing',
        sourceId: g.source._id,
        from: 'VERIFIED_LIVE',
        to: 'POSSIBLY_STALE',
      },
    });
    await t.market.sources.setEnabled(g.source._id, true, t.actor);
    await settleStandingRuns(g.source._id, 2);

    // The freshness workflow's recorded-evidence sweep: a late present re-derives job 1.
    await drain();
    const late = presentOf(await g.of(1), new Date());
    await t.market.evidence.record([late]);
    // The workflow's sweep keeps the default lag (5 min): the evidence is older than that, and the
    // watermark just before it.
    const createdAt = new Date(Date.now() - 10 * 60_000);
    await t.market.evidence.col.updateOne({ _id: late._id }, { $set: { createdAt } });
    await sweepMark(new Date(createdAt.getTime() - 1));
    const run = await t.runtime.engine.startRun({
      workflowKey: 'market.freshness.sweep',
      input: {},
      trigger: { kind: 'manual' },
    });
    expect((await waitForRun(t.runtime.engine, run._id, undefined, 120_000)).state).toBe('COMPLETED');
    expect((await g.of(1)).lifecycle.state).not.toBe('POSSIBLY_STALE');
    expect((await historyOf(j._id)).get(run._id)).toEqual(['audit']);
    expect(
      (await t.market.audit.list({ entityKind: 'job', entityId: j._id })).find((e) => e.runId === run._id),
    ).toMatchObject({ action: 'job.lifecycle_rederived', details: { cause: 'recorded_evidence' } });
    // A job the sweep re-derives without a change is not linked to its run.
    const other = await g.of(2);
    const [first] = await t.market.evidence.col
      .find({ copyKey: other.sourceRefs[0]!.key })
      .sort({ createdAt: 1 })
      .limit(1)
      .toArray();
    await sweepMark(new Date(first!.createdAt.getTime() - 1));
    const quiet = `run_rc_mr2_quiet_${Date.now()}`;
    let swept = 0;
    for (;;) {
      const res = await t.market.evidence.sweepRecordedEvidence({ lagMs: 0, runId: quiet });
      swept += res.jobs;
      if (res.complete) break;
    }
    expect(swept).toBeGreaterThan(0);
    expect(
      (await t.market.audit.list({ entityKind: 'job', entityId: other._id })).filter(
        (e) => e.runId === quiet,
      ),
    ).toHaveLength(0);
  }, 180_000);

  it('M6.2 MR2: the stale sweep records its run on the jobs it marks POSSIBLY_STALE', async () => {
    const g = await greenhouse('rc-mr2c');
    await g.listing([1]);
    const j = await g.of(1);
    await t.market.evidence.col.updateMany({ copyKey: j.sourceRefs[0]!.key }, [
      { $set: { at: { $subtract: ['$at', 5 * DAY] } } },
    ]);
    await t.market.evidence.dropCheckpoint(j._id);
    await t.market.jobs.col.updateOne(
      { _id: j._id },
      {
        $set: {
          'lifecycle.lastVerifiedAt': new Date(Date.now() - 5 * DAY),
          'lifecycle.lastSeenAt': new Date(Date.now() - 5 * DAY),
        },
      },
    );
    const runId = `run_rc_mr2c_${Date.now()}`;
    await t.market.freshness.staleSweep(5000, runId);
    expect((await g.of(1)).lifecycle.state).toBe('POSSIBLY_STALE');
    const events = (await t.market.audit.list({ entityKind: 'job', entityId: j._id })).filter(
      (e) => e.runId === runId,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'job.lifecycle_rederived',
      details: { cause: 'stale_sweep', to: 'POSSIBLY_STALE' },
    });
    // A replay of the sweep changes nothing and records nothing more.
    await t.market.freshness.staleSweep(5000, runId);
    expect(
      (await t.market.audit.list({ entityKind: 'job', entityId: j._id })).filter((e) => e.runId === runId),
    ).toHaveLength(1);
  });

  it('M6.2 MR2: the re-interpretation backfill links the jobs it re-interprets', async () => {
    const g = await greenhouse('rc-mr2b');
    await g.listing([1, 2]);
    const j = await g.of(1);
    const other = await g.of(2);
    await t.market.jobs.col.updateOne(
      { _id: j._id },
      { $set: { 'interpretation.policyVersion': 'employment/0' } },
    );
    const run = await t.runtime.engine.startRun({
      workflowKey: 'market.jobs.reinterpret_outdated',
      input: {},
      trigger: { kind: 'manual' },
    });
    expect((await waitForRun(t.runtime.engine, run._id, undefined, 120_000)).state).toBe('COMPLETED');
    expect((await historyOf(j._id)).get(run._id)).toEqual(['audit']);
    expect((await historyOf(other._id)).has(run._id)).toBe(false); // not selected, not changed
    expect(
      (await t.market.audit.list({ entityKind: 'job', entityId: j._id })).find((e) => e.runId === run._id),
    ).toMatchObject({ action: 'job.reinterpreted', details: { fromPolicyVersion: 'employment/0' } });
  }, 180_000);
});
