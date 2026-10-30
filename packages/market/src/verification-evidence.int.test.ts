/**
 * Job lifecycle derived from an order-independent evidence set (PR #11 re-verification #8,
 * DECISION_LOG 6a01b36). The reviewer's sequences, end to end:
 *
 *  - HIGH-A: an out-of-order not_found never extends a streak across an intervening live read —
 *    in any apply order, and under concurrent applies;
 *  - MEDIUM-B: an endpoint PATCH while a listing is in flight never relabels what it read: the
 *    board is captured at fetch start, so two 404s on the new (typo) board close nothing;
 *  - MEDIUM-C: listings of a wrong but valid board are no evidence about copies seen on another
 *    board, so after the endpoint is fixed one board read closes nothing;
 *  - LOW-D: reprocessing an old snapshot never changes source health ("latest listing failed");
 *  - LOW-F: a source disabled while its listing is in flight records no absences.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestInfra, startFixtureServer, type TestInfra } from '@aptamind/testing';
import type { JobDoc } from './jobs/job.schema';
import { createMarketTestRuntime } from './test-harness';
import { latestListingFailed } from './verification/verification.service';

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let companyId: string;
/** JSON bodies on the fixture server, by path (anything else answers 404). */
const bodies = new Map<string, unknown>();
/** One-shot hooks run when a path is requested, before it is answered (a mid-flight change). */
const hooks = new Map<string, () => Promise<void>>();
const tick = () => new Promise((r) => setTimeout(r, 5));

beforeAll(async () => {
  infra = await createTestInfra('verification_evidence');
  t = await createMarketTestRuntime(infra);
  server = await startFixtureServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const hook = hooks.get(path);
    if (hook) {
      hooks.delete(path);
      await hook();
    }
    const body = bodies.get(path);
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  const directory = (
    await t.market.sources.register(
      {
        key: 'directory:evidence',
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
    externalId: 'evidence-co',
    payload: { name: 'Evidence Set Ltd', aliases: [], externalIds: [], locations: [], industries: [] },
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

async function checkedOnly(jobId: string, key: string) {
  const op = await svc().claim(`ver_${key}`, jobId, { operationKey: key });
  return svc().recordResult(op._id, await svc().check(await t.market.jobs.get(jobId), t.runtime.http));
}
let opKey = 0;
const verify = (jobId: string) => svc().verify(jobId, t.runtime.http, { operationKey: `ev-${++opKey}` });

async function greenhouse(token: string) {
  const path = `/v1/boards/${token}/jobs`;
  const source = (
    await t.market.sources.register(
      {
        key: `greenhouse:${token}`,
        name: `${token} (greenhouse)`,
        category: 'job_source',
        provider: 'greenhouse',
        endpoint: { boardToken: token, url: `${server.url}${path}?content=true` },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      },
      t.actor,
    )
  ).source;
  const gh = (id: number, board = token) => ({
    id,
    title: `Role ${board} ${id}`,
    absolute_url: `https://job-boards.greenhouse.io/${board}/jobs/${id}`,
    location: { name: 'Remote' },
    updated_at: '2026-09-01T10:00:00Z',
    content: `&lt;p&gt;Own the unique ${board} programme number ${id} end to end.&lt;/p&gt;`,
  });
  const of = async (id: number) =>
    (await t.market.jobs.col.findOne({ sourceKeys: `${source._id}:${id}` })) as JobDoc;
  const serve = (ids: number[]) => bodies.set(path, { jobs: ids.map((id) => gh(id)) });
  const listing = async (ids: number[], state: 'COMPLETED' | 'FAILED' = 'COMPLETED') => {
    serve(ids);
    expect((await t.runSource(source._id)).state).toBe(state);
  };
  const live = (id: number) => bodies.set(`${path}/${id}`, gh(id));
  const gone = (id: number) => bodies.delete(`${path}/${id}`);
  return { source, path, gh, of, serve, listing, live, gone };
}

async function ashby(token: string) {
  const path = (board: string) => `/posting-api/job-board/${board}`;
  const source = (
    await t.market.sources.register(
      {
        key: `ashby:${token}`,
        name: `${token} (ashby)`,
        category: 'job_source',
        provider: 'ashby',
        endpoint: { boardToken: token, url: `${server.url}${path(token)}` },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      },
      t.actor,
    )
  ).source;
  const job = (board: string, id: string) => ({
    id,
    title: `Ashby role ${board} ${id}`,
    location: 'Remote',
    isListed: true,
    jobUrl: `https://jobs.ashbyhq.com/${board}/${id}`,
    descriptionPlain: `Run the unique ${board} ${id} workstream across teams. Board ${board}.`,
  });
  const set = (board: string, ids: string[]) =>
    bodies.set(path(board), { jobs: ids.map((id) => job(board, id)) });
  const listing = async () => expect((await t.runSource(source._id)).state).toBe('COMPLETED');
  const of = async (id: string) =>
    (await t.market.jobs.col.findOne({ sourceKeys: `${source._id}:${id}` })) as JobDoc;
  return { source, set, listing, of, path };
}

describe('HIGH-A: the lifecycle does not depend on the order evidence is applied in', () => {
  /** A live Greenhouse job with N1 (404) at T1, L (live) at T1.5 and N2 (404) at T2 all checked. */
  async function threeChecks(token: string) {
    const g = await greenhouse(token);
    await g.listing([1, 2, 3]);
    const j = await g.of(1);
    g.gone(1);
    const n1 = await checkedOnly(j._id, `${token}-n1`);
    await tick();
    g.live(1);
    const l = await checkedOnly(j._id, `${token}-l`);
    await tick();
    g.gone(1);
    const n2 = await checkedOnly(j._id, `${token}-n2`);
    expect([n1.outcome, l.outcome, n2.outcome]).toEqual(['not_found', 'live', 'not_found']);
    return { g, j, n1, l, n2 };
  }

  it("the reviewer's order (N2, then L, then N1) does not close the job: one not_found after the live read", async () => {
    const { g, n1, l, n2 } = await threeChecks('ev-a1');
    for (const op of [n2, l, n1]) await svc().applyToJob(op);
    expect((await g.of(1)).lifecycle).toMatchObject({
      state: 'POSSIBLY_STALE',
      consecutiveNotFound: 1,
      lastNotFoundAt: n2.at,
      lastVerifiedAt: l.at,
    });
  });

  it('arrival order L, N1, N2 (which a counter would read as two in a row) does not close it either', async () => {
    const { g, n1, l, n2 } = await threeChecks('ev-a2');
    for (const op of [l, n1, n2]) await svc().applyToJob(op);
    expect((await g.of(1)).lifecycle).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveNotFound: 1 });
  });

  it('concurrent applies of the same operations end at the same derived state as any sequential order', async () => {
    const g = await greenhouse('ev-a3');
    await g.listing([1, 2, 3, 4]);
    const results: string[] = [];
    for (const [id, script] of [
      // N, L, N, N: two not_founds after the live read → CLOSED at the last one.
      [1, ['nf', 'live', 'nf', 'nf']],
      // N, N, L: closed by two not_founds, then REOPENED by the later live read.
      [2, ['nf', 'nf', 'live']],
    ] as const) {
      const j = await g.of(id);
      const ops = [];
      for (const [i, step] of script.entries()) {
        if (step === 'live') g.live(id);
        else g.gone(id);
        ops.push(await checkedOnly(j._id, `ev-a3-${id}-${i}`));
        await tick();
      }
      await Promise.all([...ops].reverse().map((op) => svc().applyToJob(op)));
      await Promise.all(ops.map((op) => svc().applyToJob(op))); // replays change nothing
      const lc = (await g.of(id)).lifecycle;
      results.push(lc.state);
      if (id === 1) expect(lc).toMatchObject({ state: 'CLOSED', closedAt: ops[3]!.at });
      if (id === 2) expect(lc).toMatchObject({ state: 'REOPENED', lastVerifiedAt: ops[2]!.at });
      // The stored projection IS the derivation of the evidence set: recomputing writes nothing.
      expect((await t.market.evidence.recompute(j._id)).written).toBe(false);
      expect(
        await t.market.evidence.col.countDocuments({ copyKey: j.sourceRefs[0]!.key, kind: 'verification' }),
      ).toBe(script.length);
    }
    expect(results).toEqual(['CLOSED', 'REOPENED']);
  });
});

describe('MEDIUM-B: the board is captured when the fetch starts', () => {
  it('an endpoint PATCH while a listing is in flight: the copies keep the board read, and two 404s on the typo board close nothing', async () => {
    const g = await greenhouse('ev-b');
    await g.listing([1, 2, 3]);
    // The next listing is answered by the OLD board, but the endpoint is PATCHed to a typo while
    // the request is in flight (before the listing is ingested).
    hooks.set(g.path, async () => {
      await t.market.sources.update(g.source._id, { endpoint: { boardToken: 'ev-b-typo' } }, t.actor);
    });
    await tick();
    await g.listing([1, 2, 3]);
    expect((await t.market.sources.get(g.source._id)).endpoint.boardToken).toBe('ev-b-typo');
    const jobs = await Promise.all([1, 2, 3].map((id) => g.of(id)));
    for (const j of jobs) {
      expect(j.sourceRefs[0]!.board).toMatchObject({ boardToken: 'ev-b' });
      const latest = await t.market.evidence.col
        .find({ copyKey: j.sourceRefs[0]!.key, kind: 'listing' })
        .sort({ at: -1 })
        .limit(1)
        .next();
      expect(latest?.board).toMatchObject({ boardToken: 'ev-b' });
    }
    // The typo board has no jobs: every single-job read there would answer 404.
    for (let cycle = 0; cycle < 2; cycle++)
      for (const j of jobs) expect((await verify(j._id)).outcome).toBe('inconclusive');
    for (const j of jobs) expect((await t.market.jobs.get(j._id)).lifecycle.state).toBe('VERIFIED_LIVE');
  });
});

describe('MEDIUM-C: a listing of another board is no evidence about a copy', () => {
  it('listings of a wrong but valid board, then the endpoint fixed: one board read closes nothing', async () => {
    const b = await ashby('ev-c');
    b.set('ev-c', ['a1', 'a2', 'a3', 'a4']);
    await b.listing();
    const a1 = await b.of('a1');
    // PATCH to another company's (valid) board: two listings that contain none of our jobs.
    b.set('ev-c-other', ['o1', 'o2', 'o3', 'o4']);
    await t.market.sources.update(
      b.source._id,
      { endpoint: { boardToken: 'ev-c-other', url: `${server.url}${b.path('ev-c-other')}` } },
      t.actor,
    );
    await b.listing();
    await b.listing();
    // The absences were recorded (they happened) on the other board, and never count.
    expect(
      await t.market.evidence.col.countDocuments({ copyKey: a1.sourceRefs[0]!.key, outcome: 'absent' }),
    ).toBe(2);
    const mid = await b.of('a1');
    expect(mid.lifecycle).toMatchObject({ state: 'VERIFIED_LIVE', consecutiveAbsences: 0 });
    expect(mid.sourceRefs[0]).toMatchObject({ present: true, board: { boardToken: 'ev-c' } }); // unknown, not absent
    // The endpoint is fixed; a1 has really gone from the right board since.
    await t.market.sources.update(
      b.source._id,
      { endpoint: { boardToken: 'ev-c', url: `${server.url}${b.path('ev-c')}` } },
      t.actor,
    );
    b.set('ev-c', ['a2', 'a3', 'a4']);
    const v = await verify(a1._id);
    expect(v.outcome).not.toBe('live');
    const after = (await b.of('a1')).lifecycle;
    expect(after.state).not.toBe('CLOSED');
    expect(after).toMatchObject({ consecutiveAbsences: 0, consecutiveNotFound: 0 });
  });
});

describe('LOW-D: reprocessing never changes source health', () => {
  it('reprocessing an old snapshot after a failed fetch keeps "latest listing failed"', async () => {
    const g = await greenhouse('ev-d');
    await g.listing([1, 2]);
    const ok = await t.market.sources.get(g.source._id);
    const snapshot = ok.health.lastSnapshotId!;
    bodies.delete(g.path); // the board now answers 404: a failed fetch
    await tick();
    expect((await t.runSource(g.source._id)).state).toBe('FAILED');
    const failed = await t.market.sources.get(g.source._id);
    expect(failed.health.latestFetch).toMatchObject({ ok: false });
    expect(latestListingFailed(failed)).toBe(true);
    // Reprocess the older, successful snapshot.
    expect((await t.runSource(g.source._id, { snapshotId: snapshot })).state).toBe('COMPLETED');
    const after = await t.market.sources.get(g.source._id);
    expect(after.health).toMatchObject({
      status: failed.health.status,
      consecutiveFailures: failed.health.consecutiveFailures,
      latestFetch: failed.health.latestFetch,
    });
    expect(after.health.lastSuccessAt?.getTime()).toBe(failed.health.lastSuccessAt?.getTime());
    expect(latestListingFailed(after)).toBe(true);
    const v = await verify((await g.of(1))._id);
    expect(v).toMatchObject({ outcome: 'inconclusive' });
    expect(v.detail).toContain('latest listing fetch');
  });
});

describe('LOW-F: a source disabled mid-flight records no absences', () => {
  it('the listing is fetched while enabled, finalized while disabled: no absence evidence, nothing marked absent', async () => {
    const g = await greenhouse('ev-f');
    await g.listing([1, 2, 3]);
    const j = await g.of(1);
    hooks.set(g.path, async () => {
      await t.market.sources.setEnabled(g.source._id, false, t.actor);
    });
    await tick();
    await g.listing([2, 3]); // lacks 1; the source is disabled while the request is in flight
    expect((await t.market.sources.get(g.source._id)).enabled).toBe(false);
    expect(
      await t.market.evidence.col.countDocuments({ copyKey: j.sourceRefs[0]!.key, outcome: 'absent' }),
    ).toBe(0);
    expect((await g.of(1)).sourceRefs[0]).toMatchObject({ present: true });
    // Re-enabled, one more listing without it is the FIRST absence, not the second.
    await t.market.sources.setEnabled(g.source._id, true, t.actor);
    await tick();
    await g.listing([2, 3]);
    expect((await g.of(1)).lifecycle).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveAbsences: 1 });
  });
});
