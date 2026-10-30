/**
 * Verification safety (PR #11 review A-H1): a job check may only say `not_found` when the
 * provider positively says the job is gone. Ashby has no single-job endpoint, so its check reads
 * the whole board: a provider shape drift, an empty-board glitch or an unparseable entry must be
 * `inconclusive` — otherwise stale → verify → 2× not_found would close every Ashby job.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestInfra, startFixtureServer, type TestInfra } from '@aptamind/testing';
import type { JobDoc } from './jobs/job.schema';
import type { SourceDoc } from './sources/source.schema';
import { createMarketTestRuntime } from './test-harness';

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let source: SourceDoc;
let board: unknown;
let companyId: string;
const PATH = '/posting-api/job-board/gamma-verify';
/** Other boards on the fixture server, by path. */
const boards = new Map<string, unknown>();

const job = (id: string) => ({
  id,
  title: `Ashby role ${id}`,
  location: 'Remote',
  isListed: true,
  jobUrl: `https://jobs.ashbyhq.com/gamma-verify/${id}`,
  descriptionPlain: `Role ${id}: build things.`,
});

beforeAll(async () => {
  infra = await createTestInfra('verification_safety');
  t = await createMarketTestRuntime(infra);
  server = await startFixtureServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const body = path === PATH ? board : boards.get(path);
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  const directory = (
    await t.market.sources.register(
      {
        key: 'directory:verify',
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
    externalId: 'gamma',
    payload: { name: 'Gamma Ltd', aliases: [], externalIds: [], locations: [], industries: [] },
    parser: { name: 'test', version: '1' },
  });
  if (company.outcome !== 'created' && company.outcome !== 'matched') throw new Error('company not created');
  companyId = company.companyId;
  source = (
    await t.market.sources.register(
      {
        key: 'ashby:gamma-verify',
        name: 'Gamma (ashby)',
        category: 'job_source',
        provider: 'ashby',
        endpoint: { boardToken: 'gamma-verify', url: `${server.url}${PATH}` },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      },
      t.actor,
    )
  ).source;
  board = { jobs: ['v1', 'v2', 'v3'].map(job) };
  expect((await t.runSource(source._id)).state).toBe('COMPLETED');
});

afterAll(async () => {
  await t?.stop();
  await server?.close();
  await infra?.cleanup();
});

const target = async (): Promise<JobDoc> =>
  (await t.market.jobs.col.findOne({ sourceKeys: `${source._id}:v1` })) as JobDoc;

async function verifyTwice(label: string) {
  const j = await target();
  const outcomes = [];
  for (const n of [1, 2]) {
    const v = await t.market.verification.verify(j._id, t.runtime.http, { operationKey: `${label}-${n}` });
    outcomes.push(v.outcome);
  }
  return outcomes;
}

const HOUR = 3600_000;

/**
 * Put v1 into a REAL job-level absence run (PR #11 re-verify #4, M3): two applied listings
 * without it, no positive evidence since the first absence, no hold. With nothing else in the way
 * a board read without v1 counts as not_found and closes it — so each test below is blocked by
 * exactly the guard it is named after (each one also runs the control that closes the job).
 * `sourceSeenAt`: when the source's other copies were last seen (source-level evidence).
 */
async function absenceRun(opts: { sourceSeenAt: Date }) {
  const now = Date.now();
  const before = new Date(now - 3 * HOUR);
  const j = await target();
  const copy = j.sourceRefs.find((r) => r.externalId === 'v1')!;
  // The lifecycle is derived from evidence (DECISION_LOG 6a01b36): the run is built from evidence
  // — a sighting, then two applied absences on the copy's board — never by writing the projection.
  await t.market.evidence.col.deleteMany({ copyKey: copy.key });
  await t.market.evidence.dropCheckpoint(j._id); // (the checkpoint is derived from what was deleted)
  const listing = (at: Date, outcome: 'present' | 'absent', n: number) => ({
    _id: `test:${copy.key}:${now}:${n}`,
    jobId: j._id,
    copyKey: copy.key,
    sourceId: source._id,
    board: copy.board ?? null,
    at,
    kind: 'listing' as const,
    outcome,
  });
  await t.market.evidence.record([
    listing(before, 'present', 0),
    listing(new Date(now - 2 * HOUR), 'absent', 1),
    listing(new Date(now - HOUR), 'absent', 2),
  ]);
  await t.market.jobs.col.updateOne(
    { _id: j._id },
    {
      $set: { 'sourceRefs.$[r].present': false, 'sourceRefs.$[r].lastSeenAt': before },
      $inc: { rev: 1 },
    },
    { arrayFilters: [{ 'r.externalId': 'v1' }] },
  );
  await t.market.jobs.col.updateMany(
    { 'sourceRefs.sourceId': source._id, _id: { $ne: j._id } },
    { $set: { 'sourceRefs.$[r].lastSeenAt': opts.sourceSeenAt, 'sourceRefs.$[r].present': true } },
    { arrayFilters: [{ 'r.sourceId': source._id }] },
  );
  await t.market.verification.col.deleteMany({ sourceId: source._id, outcome: 'live' });
  await t.market.evidence.recompute(j._id);
  expect((await target()).lifecycle).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveAbsences: 2 });
}

/** The control: with the guard lifted, the same read closes the job (the setup is a real run). */
async function expectControlCloses(label: string) {
  const v = await t.market.verification.verify((await target())._id, t.runtime.http, {
    operationKey: `${label}-control`,
  });
  expect(v.outcome).toBe('not_found');
  expect((await target()).lifecycle.state).toBe('CLOSED');
}

describe('A-H1: Ashby verification never mistakes an unreadable board for a closed job', () => {
  let baseline: SourceDoc['health']['listingBaseline'];
  beforeAll(async () => {
    baseline = (await t.market.sources.get(source._id)).health.listingBaseline;
  });
  // Each case starts from a real absence run of v1 on a board whose other jobs are live now.
  beforeEach(async () => {
    await t.market.sources.col.updateOne(
      { _id: source._id },
      { $set: { 'health.listingBaseline': baseline }, $unset: { 'health.listingHeld': '' } },
    );
    await absenceRun({ sourceSeenAt: new Date() });
  });

  it.each([
    [
      'a provider shape drift (every entry malformed)',
      () => ({ jobs: ['v1', 'v2', 'v3'].map((id) => ({ id, name: 'x' })) }),
    ],
    [
      'an id-less malformed entry (could be this job)',
      () => ({ jobs: [job('v2'), job('v3'), { title: 'broken' }] }),
    ],
    ['a numeric id where a string is expected', () => ({ jobs: [{ ...job('v1'), id: 1 }, job('v2')] })],
    ['a renamed top-level key', () => ({ postings: ['v1', 'v2'].map(job) })],
  ])('%s → inconclusive, job stays open', async (label, make) => {
    board = make();
    expect(await verifyTwice(label)).toEqual(['inconclusive', 'inconclusive']);
    expect((await target()).lifecycle).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveNotFound: 0 });
    board = { jobs: ['v2', 'v3'].map(job) };
    await expectControlCloses(label);
  });

  it('an empty-board glitch (the source showed jobs since the run began) → inconclusive', async () => {
    board = { jobs: [] };
    expect(await verifyTwice('empty-glitch')).toEqual(['inconclusive', 'inconclusive']);
    expect((await target()).lifecycle).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveNotFound: 0 });
    // Control: no source evidence since the first absence → the empty board counts.
    await absenceRun({ sourceSeenAt: new Date(Date.now() - 3 * HOUR) });
    await expectControlCloses('empty-glitch');
  });

  it('ruling L1: a board-derived not_found that is a shrink against the listing baseline (3 of 100: truncated) is inconclusive', async () => {
    await t.market.sources.col.updateOne(
      { _id: source._id },
      { $set: { 'health.listingBaseline.count': 100 } },
    );
    board = { jobs: ['v2', 'v3', 'v4'].map(job) };
    expect(await verifyTwice('gated-shrink')).toEqual(['inconclusive', 'inconclusive']);
    expect((await target()).lifecycle).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveNotFound: 0 });
    // Control: the same board against a baseline it does not shrink from.
    await t.market.sources.col.updateOne(
      { _id: source._id },
      { $set: { 'health.listingBaseline.count': 3 } },
    );
    await expectControlCloses('gated-shrink');
  });

  it('ruling L1: a board-derived not_found for a source whose listings are held is inconclusive', async () => {
    const held = { reason: 'shrink', since: new Date(), lastAt: new Date(), count: 2, baseline: 3 };
    await t.market.sources.col.updateOne({ _id: source._id }, { $set: { 'health.listingHeld': held } });
    board = { jobs: ['v2', 'v3', 'v4'].map(job) };
    expect(await verifyTwice('gated-held')).toEqual(['inconclusive', 'inconclusive']);
    expect((await target()).lifecycle).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveNotFound: 0 });
    await t.market.sources.col.updateOne({ _id: source._id }, { $unset: { 'health.listingHeld': '' } });
    await expectControlCloses('gated-held');
  });

  it('MEDIUM-1: a stale baseline of 0 does not let an empty board read close a job while the source shows live jobs', async () => {
    // A baseline of 0 (e.g. set by an empty first listing) while the source's other jobs were
    // seen since the run began: the empty read is a glitch.
    await t.market.sources.col.updateOne(
      { _id: source._id },
      { $set: { 'health.listingBaseline.count': 0 } },
    );
    board = { jobs: [] };
    expect(await verifyTwice('stale-zero')).toEqual(['inconclusive', 'inconclusive']);
    expect((await target()).lifecycle).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveNotFound: 0 });
    await absenceRun({ sourceSeenAt: new Date(Date.now() - 3 * HOUR) });
    await expectControlCloses('stale-zero');
  });

  it('a readable complete board without the job closes it once two applied listings agree (closure still works)', async () => {
    // Start live: the board lists v1 again (an authoritative sighting ends the run).
    board = { jobs: ['v1', 'v2', 'v3'].map(job) };
    expect((await t.runSource(source._id)).state).toBe('COMPLETED');
    expect((await target()).lifecycle).toMatchObject({ state: 'VERIFIED_LIVE', consecutiveAbsences: 0 });
    // DECISION_LOG b7f1a76: the board read alone is not independent verification…
    board = { jobs: ['v2', 'v3'].map(job) };
    expect(await verifyTwice('gone-alone')).toEqual(['inconclusive', 'inconclusive']);
    // … it corroborates a job-level absence run of two applied listings.
    expect((await t.runSource(source._id)).state).toBe('COMPLETED');
    expect((await t.runSource(source._id)).state).toBe('COMPLETED');
    expect((await target()).lifecycle.consecutiveAbsences).toBe(2);
    const v = await t.market.verification.verify((await target())._id, t.runtime.http, {
      operationKey: 'gone-after-run',
    });
    expect(v.outcome).toBe('not_found');
    expect((await target()).lifecycle.state).toBe('CLOSED');
  });
});

describe('LOW-2: a dead Ashby board closes its jobs end to end', () => {
  it('empty listings held, applied, applied (b7f1a76: a run of two) → an empty-board verification closes the job', async () => {
    const path = '/posting-api/job-board/gamma-dead';
    const dead = (
      await t.market.sources.register(
        {
          key: 'ashby:gamma-dead',
          name: 'Gamma dead board (ashby)',
          category: 'job_source',
          provider: 'ashby',
          endpoint: { boardToken: 'gamma-dead', url: `${server.url}${path}` },
          acquisition: { workflowKey: 'market.ats.refresh' },
          companyId,
          freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
          authority: { tier: 'official_ats', listingIsComplete: true },
          governance: { accessMethod: 'public_api' },
        },
        t.actor,
      )
    ).source;
    const run = async () => expect((await t.runSource(dead._id)).state).toBe('COMPLETED');
    boards.set(path, { jobs: ['d1', 'd2', 'd3'].map(job) });
    await run();
    const d1 = async () => (await t.market.jobs.col.findOne({ sourceKeys: `${dead._id}:d1` })) as JobDoc;
    boards.set(path, { jobs: [] });
    await run(); // held one run (small board, L2)
    expect((await t.market.sources.get(dead._id)).health.listingHeld).toMatchObject({
      reason: 'small_board_empty',
    });
    expect((await d1()).lifecycle.state).toBe('VERIFIED_LIVE');
    await run(); // applied: the jobs are absent, the baseline is 0
    expect((await t.market.sources.get(dead._id)).health.listingBaseline).toMatchObject({ count: 0 });
    expect((await d1()).lifecycle).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveAbsences: 1 });
    const early = await t.market.verification.verify((await d1())._id, t.runtime.http, {
      operationKey: 'dead-early',
    });
    expect(early.outcome).toBe('inconclusive'); // one applied absence is not a run
    await run(); // applied again: absence 2
    const v = await t.market.verification.verify((await d1())._id, t.runtime.http, {
      operationKey: 'dead-1',
    });
    expect(v.outcome).toBe('not_found');
    expect((await d1()).lifecycle.state).toBe('CLOSED');
  });
});
