/**
 * Verification apply fence and run evidence (PR #11 re-verification #4, DECISION_LOG a9af734).
 *
 *  - HIGH check-then-apply race: a board-derived not_found checked against one state of the job
 *    must not be applied to a later one. Three interleavings that closed a live job: a live
 *    verification (RACE-LIVE), an official-site copy (RACE-SITE) or a third-party sighting
 *    (RACE-SIGHTING) landing between the check and the apply.
 *  - M1: an absence after positive evidence restarts the run, so a skipped-entry sighting cannot
 *    block closure forever (RESTART-SKIPPED).
 *  - M2 + product ruling: only the held source's own evidence re-arms its small-board hold, and
 *    third-party sightings never reset a run (HOLD-FOREVER, RACE-SIGHTING).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestInfra, startFixtureServer, type TestInfra } from '@aptamind/testing';
import type { JobDoc } from './jobs/job.schema';
import type { SourceDoc } from './sources/source.schema';
import { createMarketTestRuntime } from './test-harness';

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let companyId: string;
const boards = new Map<string, unknown>();
/** The job a sighting resolved to (undefined when its company could not be resolved). */
const jobIdOf = (o: { outcome: string }): string => {
  if (!('jobId' in o) || typeof o.jobId !== 'string') throw new Error(`sighting not resolved: ${o.outcome}`);
  return o.jobId;
};
/** HTML pages (careers-site postings) on the fixture server, by path. */
const pages = new Map<string, string>();

const ROLES: Record<string, [string, string]> = {
  a1: ['Backend Engineer', 'Design and run payment APIs in Go and PostgreSQL.'],
  a2: ['Product Designer', 'Shape onboarding flows with research and prototypes in Figma.'],
  a3: ['Data Analyst', 'Model churn and revenue with SQL, dbt and Looker dashboards.'],
  a4: ['Account Executive', 'Close mid-market deals and manage a quota across the Nordics.'],
};
const WORDS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet',
  'kilo',
  'lima',
  'mike',
  'november',
];
const role = (id: string): [string, string] => {
  if (ROLES[id]) return ROLES[id]!;
  const n = Number(id.replace(/\D/g, ''));
  return [
    `${WORDS[n % WORDS.length]} ${WORDS[(n * 7 + 3) % WORDS.length]} specialist ${id}`,
    `Own the ${WORDS[(n * 5 + 1) % WORDS.length]} programme and ${WORDS[(n * 3 + 2) % WORDS.length]} tooling, unique ${id} ${id} ${id}.`,
  ];
};
const job = (token: string, id: string) => ({
  id,
  title: role(id)[0],
  location: 'Remote',
  isListed: true,
  jobUrl: `https://jobs.ashbyhq.com/${token}/${id}`,
  descriptionPlain: `${role(id)[1]} Board ${token}.`,
});
beforeAll(async () => {
  infra = await createTestInfra('verification_races');
  t = await createMarketTestRuntime(infra);
  server = await startFixtureServer(async (req, res) => {
    const page = pages.get((req.url ?? '').split('?')[0] ?? '');
    if (page !== undefined) {
      res.writeHead(200, { 'content-type': 'text/html' }).end(page);
      return;
    }
    const body = boards.get((req.url ?? '').split('?')[0] ?? '');
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  const directory = (
    await t.market.sources.register(
      {
        key: 'directory:races',
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
    externalId: 'races-co',
    payload: { name: 'Race Evidence Ltd', aliases: [], externalIds: [], locations: [], industries: [] },
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

async function ashbyBoard(token: string, mk = job) {
  const path = `/posting-api/job-board/${token}`;
  const source = (
    await t.market.sources.register(
      {
        key: `ashby:${token}`,
        name: `${token} (ashby)`,
        category: 'job_source',
        provider: 'ashby',
        endpoint: { boardToken: token, url: `${server.url}${path}` },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      },
      t.actor,
    )
  ).source;
  const set = (jobs: unknown[]) => boards.set(path, { jobs });
  const listing = async () => expect((await t.runSource(source._id)).state).toBe('COMPLETED');
  const of = async (id: string) =>
    (await t.market.jobs.col.findOne({ sourceKeys: `${source._id}:${id}` })) as JobDoc;
  let n = 0;
  const read = async (id: string) =>
    t.market.verification.verify((await of(id))._id, t.runtime.http, {
      operationKey: `${token}-read-${++n}`,
    });
  const held = async () => (await t.market.sources.get(source._id)).health.listingHeld;
  const all = (ids: string[]) => ids.map((id) => mk(token, id));
  const jobsOn = async () =>
    t.market.jobs.col.find({ status: 'active', 'sourceRefs.sourceId': source._id }).toArray();
  return { source, set, listing, of, read, held, all, jobsOn };
}

async function siteSource(key: string) {
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

/**
 * Two applied listings without `id` on a 4-job board: a real job-level absence run of two.
 * `isolated`: the job must be this board's alone. Every board's jobs share one company and title,
 * so a description too similar to another board's (≥ SYNDICATION_SIMILARITY) syndicates into that
 * job, whose other copy then decides whether the absences count.
 */
async function runOfTwo(
  b: Awaited<ReturnType<typeof ashbyBoard>>,
  id = 'a1',
  opts: { isolated?: boolean } = {},
) {
  b.set(b.all(['a1', 'a2', 'a3', 'a4']));
  await b.listing();
  if (opts.isolated) expect((await b.of(id)).sourceRefs.map((r) => r.sourceId)).toEqual([b.source._id]);
  b.set(b.all(['a1', 'a2', 'a3', 'a4'].filter((x) => x !== id)));
  await b.listing();
  await b.listing();
  const j = await b.of(id);
  expect(j.lifecycle).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveAbsences: 2 });
  return j;
}

/** Claim + check + record a verification without applying it (the window of the race). */
async function checkedNotFound(jobId: string, key: string) {
  const svc = t.market.verification;
  const op = await svc.claim(`ver_${key}`, jobId, { operationKey: key });
  const res = await svc.check(await t.market.jobs.get(jobId), t.runtime.http);
  expect(res).toMatchObject({ outcome: 'not_found', boardDerived: true });
  return svc.recordResult(op._id, res);
}

describe('HIGH: a board-derived not_found is re-gated when it is applied', () => {
  it('RACE-LIVE: a live verification lands between the check and the apply → the job ends live (derived: closed at the check, reopened by the later read)', async () => {
    const b = await ashbyBoard('race-live');
    const j = await runOfTwo(b);
    const stale = await checkedNotFound(j._id, 'race-live-stale');
    b.set(b.all(['a1', 'a2', 'a3', 'a4']));
    expect((await b.read('a1')).outcome).toBe('live');
    const states = await t.market.verification.applyToJob(stale);
    expect(states.stateAfter).not.toBe('CLOSED');
    // DECISION_LOG 6a01b36: the evidence set says "not on the board at the check, on it at the
    // later read" — whatever order they were applied in, the job is REOPENED, never CLOSED.
    const after = (await b.of('a1')).lifecycle;
    expect(after.state).toBe('REOPENED');
    expect(after.history.slice(-2).map((h) => h.to)).toEqual(['CLOSED', 'REOPENED']);
    expect(await t.market.verification.col.findOne({ _id: stale._id })).toMatchObject({
      outcome: 'not_found',
    });
  });

  it('RACE-SITE: an official-site copy is sighted between the check and the apply → the job stays open', async () => {
    const b = await ashbyBoard('race-site');
    const j = await runOfTwo(b);
    const stale = await checkedNotFound(j._id, 'race-site-stale');
    const site = await siteSource('race-site');
    const out = await t.market.jobPipeline.process({
      source: site,
      locator: 'https://rs.example/careers/a1',
      payload: {
        externalId: 'site-a1',
        title: 'Backend Engineer',
        descriptionText: 'Design and run payment APIs in Go and PostgreSQL. Board race-site.',
        locations: [{ text: 'Remote' }],
        postingUrl: 'https://jobs.ashbyhq.com/race-site/a1',
        provider: { name: 'careers_page' },
      },
      parser: { name: 'test', version: '1' },
    });
    expect(jobIdOf(out)).toBe(j._id);
    await t.market.verification.applyToJob(stale);
    const after = await b.of('a1');
    expect(after.lifecycle.state).not.toBe('CLOSED');
    // MC: the present official-site copy is what a later verification reads, and the job is not
    // absent from listings at the job level.
    expect(after.sourceRefs.find((r) => r.sourceId === site._id)?.present).toBe(true);
  });

  it('RACE-SIGHTING: a third-party sighting between the check and the apply neither resets the run nor moves the fence → the not_found closes the job', async () => {
    const b = await ashbyBoard('race-tp');
    const j = await runOfTwo(b);
    const stale = await checkedNotFound(j._id, 'race-tp-stale');
    const tp = (
      await t.market.sources.register(
        {
          key: 'board:race-tp',
          name: 'aggregator',
          category: 'job_source',
          provider: 'aggregator',
          acquisition: { workflowKey: 'market.noop' },
          companyId,
          freshness: { policyClass: 'source.careers_page', maxAgeMinutes: 2160 },
          authority: { tier: 'third_party', listingIsComplete: false },
          governance: { accessMethod: 'public_web' },
        },
        t.actor,
      )
    ).source as SourceDoc;
    const out = await t.market.jobPipeline.process({
      source: tp,
      locator: 'https://agg.example/a1',
      payload: {
        externalId: 'agg-a1',
        title: 'Backend Engineer',
        descriptionText: 'Design and run payment APIs in Go and PostgreSQL. Board race-tp.',
        locations: [{ text: 'Remote' }],
        postingUrl: 'https://jobs.ashbyhq.com/race-tp/a1',
        provider: { name: 'fixture' },
      },
      parser: { name: 'test', version: '1' },
    });
    expect(jobIdOf(out)).toBe(j._id);
    // The run is intact: a third-party sighting is not run evidence.
    expect((await b.of('a1')).lifecycle).toMatchObject({
      consecutiveAbsences: 2,
      absentSince: j.lifecycle.absentSince,
    });
    expect((await t.market.verification.applyToJob(stale)).stateAfter).toBe('CLOSED');
    expect((await t.market.verification.col.findOne({ _id: stale._id }))?.appliedOutcome).toBeUndefined();
    // (An AUTHORITATIVE sighting in the same window still blocks it: RACE-SITE, RACE-SITE fence.)
  });

  it('RACE-SKIPPED (fence): an authoritative skipped-entry sighting fetched before the check but processed after it still blocks the close', async () => {
    const b = await ashbyBoard('race-skip-fence');
    const j = await runOfTwo(b, 'a1', { isolated: true });
    const stale = await checkedNotFound(j._id, 'race-skip-fence-stale');
    // A held listing fetched before the check was recorded shows a1 as a skipped entry: it moves
    // only the ATS copy's lastSeenAt (not lastVerifiedAt, not the run) — only the fence sees it.
    // Source time strictly inside the absence run — after the run began and before the check was
    // recorded — so it interrupts the run whatever the listings' timing. (The midpoint of the
    // copy's last sighting and the check could land before the run's first absence when the first
    // listing ran slow: a sighting BEFORE the run is correctly no evidence against it, the run of
    // two stands and the board read legitimately closes the job.)
    const runStart = j.lifecycle.absentSince!.getTime();
    const between = new Date(Math.floor((runStart + stale.at.getTime()) / 2));
    expect(between.getTime()).toBeGreaterThan(runStart);
    expect(between.getTime()).toBeLessThan(stale.at.getTime());
    const touched = await t.market.jobPipeline.touchSkippedEntries(b.source, [{ externalId: 'a1' }], between);
    expect(touched.touched).toBe(1);
    // Derived: the sighting (a positive) ends the run it interrupts; the board read after it is
    // not backed by a job-level absence run of two, so it does not count.
    expect((await b.of('a1')).lifecycle.consecutiveAbsences).toBeLessThan(2);
    await t.market.verification.applyToJob(stale);
    expect((await b.of('a1')).lifecycle).toMatchObject({ consecutiveNotFound: 0 });
    expect((await b.of('a1')).lifecycle.state).not.toBe('CLOSED');
  });

  it('control (RACE-SKIPPED): a skipped-entry sighting from BEFORE the absence run does not interrupt it → the checked not_found closes the job', async () => {
    // Token chosen so a1's description is < SYNDICATION_SIMILARITY to every other board's a1 in
    // this file (all share the company and title): 'race-skip-before' scored exactly 0.80 against
    // 'race-skip-fence', was syndicated into that job, and its absences then counted or not by
    // whether RACE-SKIPPED (fence)'s sighting left that board's copy present — timing-dependent.
    const b = await ashbyBoard('early-sighting');
    const j = await runOfTwo(b, 'a1', { isolated: true });
    const stale = await checkedNotFound(j._id, 'early-sighting-stale');
    // Strictly between the copy's last sighting and the run's first absence.
    const copySeen = j.sourceRefs.find((r) => r.sourceId === b.source._id)!.lastSeenAt.getTime();
    const runStart = j.lifecycle.absentSince!.getTime();
    const before = new Date(Math.floor((copySeen + runStart) / 2));
    expect(before.getTime()).toBeGreaterThan(copySeen);
    expect(before.getTime()).toBeLessThan(runStart);
    const touched = await t.market.jobPipeline.touchSkippedEntries(b.source, [{ externalId: 'a1' }], before);
    expect(touched.touched).toBe(1);
    // Both absences follow the sighting: the run of two stands and the board read corroborates it.
    expect((await b.of('a1')).lifecycle).toMatchObject({
      consecutiveAbsences: 2,
      absentSince: j.lifecycle.absentSince,
    });
    expect((await t.market.verification.applyToJob(stale)).stateAfter).toBe('CLOSED');
  });

  it('a job whose primary copy is now a third-party copy is still read on its ATS copy’s own board, and a fresh read closes it', async () => {
    const b = await ashbyBoard('race-tp-fresh');
    const j = await runOfTwo(b);
    const tp = (
      await t.market.sources.register(
        {
          key: 'board:race-tp-fresh',
          name: 'aggregator (fresh)',
          category: 'job_source',
          provider: 'aggregator',
          acquisition: { workflowKey: 'market.noop' },
          companyId,
          freshness: { policyClass: 'source.careers_page', maxAgeMinutes: 2160 },
          authority: { tier: 'third_party', listingIsComplete: false },
          governance: { accessMethod: 'public_web' },
        },
        t.actor,
      )
    ).source as SourceDoc;
    const out = await t.market.jobPipeline.process({
      source: tp,
      locator: 'https://agg.example/a1-fresh',
      payload: {
        externalId: 'agg-a1-fresh',
        title: 'Backend Engineer',
        descriptionText: 'Design and run payment APIs in Go and PostgreSQL. Board race-tp-fresh.',
        locations: [{ text: 'Remote' }],
        postingUrl: 'https://jobs.ashbyhq.com/race-tp-fresh/a1',
        provider: { name: 'fixture' },
      },
      parser: { name: 'test', version: '1' },
    });
    expect(jobIdOf(out)).toBe(j._id);
    expect(await b.read('a1')).toMatchObject({ outcome: 'not_found', method: 'ats_api' });
    expect((await b.of('a1')).lifecycle.state).toBe('CLOSED');
  });

  it('RACE-SITE (fence): a site copy fetched before the check but processed after it → only the run fence catches it', async () => {
    const b = await ashbyBoard('race-fence');
    const j = await runOfTwo(b);
    const stale = await checkedNotFound(j._id, 'race-fence-stale');
    const site = await siteSource('race-fence');
    // Source time after the run began and before the check was recorded: `op.at` alone would not
    // supersede it (timing-independent: strictly between the two).
    const runStart = j.lifecycle.absentSince!.getTime();
    const between = new Date(Math.floor((runStart + stale.at.getTime()) / 2));
    expect(between.getTime()).toBeGreaterThan(runStart);
    const out = await t.market.jobPipeline.process({
      source: site,
      locator: 'https://rf.example/careers/a1',
      at: between,
      payload: {
        externalId: 'site-a1',
        title: 'Backend Engineer',
        descriptionText: 'Design and run payment APIs in Go and PostgreSQL. Board race-fence.',
        locations: [{ text: 'Remote' }],
        postingUrl: 'https://jobs.ashbyhq.com/race-fence/a1',
        provider: { name: 'careers_page' },
      },
      parser: { name: 'test', version: '1' },
    });
    expect(jobIdOf(out)).toBe(j._id);
    const mid = await b.of('a1');
    expect(mid.lifecycle.lastSeenAt.getTime()).toBeLessThan(stale.at.getTime());
    await t.market.verification.applyToJob(stale);
    // Derived: the site sighting inside the run ends it; the later board read does not count.
    expect((await b.of('a1')).lifecycle).toMatchObject({ state: 'VERIFIED_LIVE', consecutiveNotFound: 0 });
  });

  it('control: with nothing in between, the checked not_found closes the job when applied', async () => {
    const b = await ashbyBoard('race-none');
    const j = await runOfTwo(b);
    const op = await checkedNotFound(j._id, 'race-none');
    expect((await t.market.verification.applyToJob(op)).stateAfter).toBe('CLOSED');
  });
});

describe('a direct single-job 404 is superseded by positive evidence after its check', () => {
  it('RACE-DIRECT: a Greenhouse 404 checked before a listing that shows the job → applied as inconclusive', async () => {
    const token = 'race-direct';
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
    const gh = (id: number, title: string) => ({
      id,
      title,
      absolute_url: `https://job-boards.greenhouse.io/${token}/jobs/${id}`,
      location: { name: 'Remote' },
      updated_at: '2026-09-01T10:00:00Z',
      content: `&lt;p&gt;${title}: unique direct role ${id}.&lt;/p&gt;`,
    });
    boards.set(path, { jobs: [gh(1001, 'Payments Engineer'), gh(1002, 'Growth Marketer')] });
    expect((await t.runSource(source._id)).state).toBe('COMPLETED');
    const j = (await t.market.jobs.col.findOne({ sourceKeys: `${source._id}:1001` })) as JobDoc;
    // The single-job endpoint answers 404 (not in the fixture map): a direct not_found.
    const svc = t.market.verification;
    const op = await svc.claim('ver_race_direct', j._id, { operationKey: 'race-direct' });
    const res = await svc.check(await t.market.jobs.get(j._id), t.runtime.http);
    expect(res).toMatchObject({ outcome: 'not_found', method: 'ats_api' });
    expect(res.boardDerived).toBeUndefined();
    const stale = await svc.recordResult(op._id, res);
    await new Promise((r) => setTimeout(r, 5));
    expect((await t.runSource(source._id)).state).toBe('COMPLETED'); // the board lists it: seen now
    await svc.applyToJob(stale);
    const after = (await t.market.jobs.get(j._id)).lifecycle;
    // Derived: the 404 is followed by a sighting (a positive), which ends it.
    expect(after).toMatchObject({ state: 'VERIFIED_LIVE', consecutiveNotFound: 0 });
  });
});

describe('verification reads the job-level truth: present authoritative copies first', () => {
  const ghBoard = async (token: string) => {
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
    const gh = (id: number, title: string) => ({
      id,
      title,
      absolute_url: `https://job-boards.greenhouse.io/${token}/jobs/${id}`,
      location: { name: 'Remote' },
      updated_at: '2026-09-01T10:00:00Z',
      content: `&lt;p&gt;${title}: unique role ${token} ${id}.&lt;/p&gt;`,
    });
    return { source, path, gh };
  };

  it('MC-DIRECT: an absent ATS copy with a present official-site copy is verified on the site copy and never closed by a 404', async () => {
    const { source, path, gh } = await ghBoard('mc-direct');
    boards.set(path, {
      jobs: [gh(2001, 'Ledger Engineer'), gh(2002, 'Support Lead'), gh(2003, 'Brand Designer')],
    });
    expect((await t.runSource(source._id)).state).toBe('COMPLETED');
    const j = (await t.market.jobs.col.findOne({ sourceKeys: `${source._id}:2001` })) as JobDoc;
    const site = await siteSource('mc-direct');
    const postingPath = '/careers/ledger-engineer';
    pages.set(postingPath, '<html><body><h1>Ledger Engineer</h1><p>Apply now.</p></body></html>');
    const out = await t.market.jobPipeline.process({
      source: site,
      locator: `${server.url}${postingPath}`,
      payload: {
        externalId: 'site-ledger',
        title: 'Ledger Engineer',
        descriptionText: 'Ledger Engineer: unique role mc-direct 2001.',
        locations: [{ text: 'Remote' }],
        postingUrl: `https://job-boards.greenhouse.io/mc-direct/jobs/2001`,
        provider: { name: 'careers_page' },
      },
      parser: { name: 'test', version: '1' },
    });
    expect(jobIdOf(out)).toBe(j._id);
    // Point the site copy at the fixture page (its own posting URL).
    await t.market.jobs.col.updateOne(
      { _id: j._id },
      { $set: { 'sourceRefs.$[r].postingUrl': `${server.url}${postingPath}` }, $inc: { rev: 1 } },
      { arrayFilters: [{ 'r.sourceId': site._id }] },
    );
    // The board drops it: the ATS copy is absent (the job is still listed on the site). The
    // single-job endpoint would answer 404 for it.
    boards.set(path, { jobs: [gh(2002, 'Support Lead'), gh(2003, 'Brand Designer')] });
    expect((await t.runSource(source._id)).state).toBe('COMPLETED');
    const mid = await t.market.jobs.get(j._id);
    expect(mid.sourceRefs.find((r) => r.sourceId === source._id)?.present).toBe(false);
    const v = await t.market.verification.verify(j._id, t.runtime.http, { operationKey: 'mc-direct' });
    expect(v).toMatchObject({ outcome: 'live', method: 'posting_url', sourceId: site._id });
    expect((await t.market.jobs.get(j._id)).lifecycle.state).toBe('VERIFIED_LIVE');
  });

  it('a job with only a third-party copy is never verified: a 404 on that copy is no evidence (H-1)', async () => {
    const tp = (
      await t.market.sources.register(
        {
          key: 'board:tp-absent',
          name: 'aggregator (absent)',
          category: 'job_source',
          provider: 'aggregator',
          acquisition: { workflowKey: 'market.noop' },
          companyId,
          freshness: { policyClass: 'source.careers_page', maxAgeMinutes: 2160 },
          authority: { tier: 'third_party', listingIsComplete: false },
          governance: { accessMethod: 'public_web' },
        },
        t.actor,
      )
    ).source as SourceDoc;
    const out = await t.market.jobPipeline.process({
      source: tp,
      locator: `${server.url}/agg/gone-role`,
      payload: {
        externalId: 'agg-gone',
        title: 'Quantum Archivist',
        descriptionText: 'Catalogue quantum research archives; unique third-party role.',
        locations: [{ text: 'Remote' }],
        postingUrl: `${server.url}/agg/gone-role`, // 404 on the fixture server
        provider: { name: 'fixture' },
      },
      parser: { name: 'test', version: '1' },
    });
    await t.market.jobs.col.updateOne(
      { _id: jobIdOf(out) },
      { $set: { 'sourceRefs.$[r].present': false }, $inc: { rev: 1 } },
      { arrayFilters: [{ 'r.sourceId': tp._id }] },
    );
    const before = (await t.market.jobs.get(jobIdOf(out))).lifecycle.state;
    for (const n of [1, 2]) {
      const v = await t.market.verification.verify(jobIdOf(out), t.runtime.http, {
        operationKey: `tp-absent-${n}`,
      });
      expect(v).toMatchObject({ outcome: 'inconclusive' });
      expect(v.url).toBeUndefined();
    }
    expect((await t.market.jobs.get(jobIdOf(out))).lifecycle.state).toBe(before);
  });
});

describe('M1: an absence after positive evidence restarts the run', () => {
  it('RESTART-SKIPPED: a skipped-entry sighting interrupts the run; two fresh absences and a read close the job', async () => {
    const b = await ashbyBoard('restart-skip');
    const j = await runOfTwo(b);
    b.set([{ id: 'a1', title: '' }, ...b.all(['a2', 'a3', 'a4'])]); // a1 on the board, but skipped
    await b.listing();
    b.set(b.all(['a2', 'a3', 'a4']));
    await b.listing();
    const restarted = (await b.of('a1')).lifecycle;
    expect(restarted.consecutiveAbsences).toBe(1);
    expect(restarted.absentSince!.getTime()).toBeGreaterThan(j.lifecycle.absentSince!.getTime());
    expect((await b.read('a1')).outcome).toBe('inconclusive'); // one absence of the new run
    await b.listing();
    expect((await b.of('a1')).lifecycle.consecutiveAbsences).toBe(2);
    expect((await b.read('a1')).outcome).toBe('not_found');
    expect((await b.of('a1')).lifecycle.state).toBe('CLOSED');
  });
});

describe('M2: only the held source re-arms its small-board hold', () => {
  it('HOLD-FOREVER: a job live on another authoritative source does not keep an emptied small board held', async () => {
    const b = await ashbyBoard('hold-forever');
    b.set(b.all(['a1', 'a2', 'a3']));
    await b.listing();
    const site = await siteSource('hold-forever');
    const sight = async (n: number) =>
      t.market.jobPipeline.process({
        source: site,
        locator: `https://hf.example/careers/a1?${n}`,
        payload: {
          externalId: 'site-a1',
          title: 'Backend Engineer',
          descriptionText: 'Design and run payment APIs in Go and PostgreSQL. Board hold-forever.',
          locations: [{ text: 'Remote' }],
          postingUrl: 'https://jobs.ashbyhq.com/hold-forever/a1',
          provider: { name: 'careers_page' },
        },
        parser: { name: 'test', version: `${n}` },
      });
    expect(jobIdOf(await sight(0))).toBe((await b.of('a1'))._id);
    b.set([]);
    await b.listing();
    expect(await b.held()).toMatchObject({ reason: 'small_board_empty' }); // L2: one run
    for (let i = 1; i <= 3; i++) {
      await new Promise((r) => setTimeout(r, 5));
      await sight(i); // the job stays live on the official site
      await b.listing();
    }
    expect(await b.held()).toBeFalsy();
    const a2 = await b.of('a2');
    expect(a2.lifecycle.consecutiveAbsences).toBeGreaterThanOrEqual(2);
    expect((await b.read('a2')).outcome).toBe('not_found');
    expect((await b.of('a2')).lifecycle.state).toBe('CLOSED');
    // a1 is live on the site: never absent at the job level, never closed.
    expect((await b.of('a1')).lifecycle.state).not.toBe('CLOSED');
  });
});

/** A Greenhouse board on the fixture server (its single-job endpoint answers 404 for unlisted ids). */
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
  const gh = (id: number, title: string, desc?: string) => ({
    id,
    title,
    absolute_url: `https://job-boards.greenhouse.io/${token}/jobs/${id}`,
    location: { name: 'Remote' },
    updated_at: '2026-09-01T10:00:00Z',
    content: `&lt;p&gt;${desc ?? `${title}: unique role ${token} ${id}.`}&lt;/p&gt;`,
  });
  const of = async (id: number) =>
    (await t.market.jobs.col.findOne({ sourceKeys: `${source._id}:${id}` })) as JobDoc;
  const listing = async (jobs: unknown[]) => {
    boards.set(path, { jobs });
    expect((await t.runSource(source._id)).state).toBe('COMPLETED');
  };
  return { source, gh, of, listing };
}

async function checkedOnly(jobId: string, key: string) {
  const svc = t.market.verification;
  const op = await svc.claim(`ver_${key}`, jobId, { operationKey: key });
  return svc.recordResult(op._id, await svc.check(await t.market.jobs.get(jobId), t.runtime.http));
}

describe('DECISION_LOG 0bcc357: the apply re-gate covers every outcome; disabled or missing sources are never verified', () => {
  it('a-2: a live read checked before the absence run and applied after a not_found closed the job does not reopen it', async () => {
    const b = await ashbyBoard('rv-a2');
    b.set(b.all(['a1', 'a2', 'a3', 'a4']));
    await b.listing();
    const j0 = await b.of('a1');
    const live = await checkedOnly(j0._id, 'rv-a2-live');
    expect(live.outcome).toBe('live');
    await new Promise((r) => setTimeout(r, 5));
    b.set(b.all(['a2', 'a3', 'a4']));
    await b.listing();
    await b.listing();
    const nf = await checkedNotFound(j0._id, 'rv-a2-nf');
    expect((await t.market.verification.applyToJob(nf)).stateAfter).toBe('CLOSED');
    const closed = (await b.of('a1')).lifecycle;
    const states = await t.market.verification.applyToJob(live);
    const after = (await b.of('a1')).lifecycle;
    expect(states.stateAfter).toBe('CLOSED');
    expect(after).toMatchObject({ state: 'CLOSED', consecutiveAbsences: closed.consecutiveAbsences });
    // The read is evidence at its own (earlier) time: it can move lastVerifiedAt forward to that
    // time, never backwards, and never reopens a job closed after it.
    expect(after.lastVerifiedAt!.getTime()).toBeGreaterThanOrEqual(closed.lastVerifiedAt!.getTime());
    expect(after.lastVerifiedAt!.getTime()).toBeLessThanOrEqual(after.closedAt!.getTime());
  });

  it('c-2: a third-party sighting after a direct 404 check does not block the closure', async () => {
    const g = await greenhouse('rv-c2');
    const title = 'Aggregated Treasurer';
    const desc = 'Aggregated Treasurer: run treasury for rv-c2 uniquely.';
    await g.listing([g.gh(9201, title, desc), g.gh(9202, 'Stay C2')]);
    await g.listing([g.gh(9202, 'Stay C2')]);
    const j = await g.of(9201);
    const op = await checkedOnly(j._id, 'rv-c2');
    expect(op.outcome).toBe('not_found');
    await new Promise((r) => setTimeout(r, 5));
    const tp = (
      await t.market.sources.register(
        {
          key: 'board:rv-c2',
          name: 'aggregator (c2)',
          category: 'job_source',
          provider: 'aggregator',
          acquisition: { workflowKey: 'market.noop' },
          companyId,
          freshness: { policyClass: 'source.careers_page', maxAgeMinutes: 2160 },
          authority: { tier: 'third_party', listingIsComplete: false },
          governance: { accessMethod: 'public_web' },
        },
        t.actor,
      )
    ).source as SourceDoc;
    const out = await t.market.jobPipeline.process({
      source: tp,
      locator: 'https://agg.example/rv-c2',
      payload: {
        externalId: 'agg-rv-c2',
        title,
        descriptionText: desc,
        locations: [{ text: 'Remote' }],
        postingUrl: 'https://job-boards.greenhouse.io/rv-c2/jobs/9201',
        provider: { name: 'fixture' },
      },
      parser: { name: 'test', version: '1' },
    });
    expect(jobIdOf(out)).toBe(j._id);
    expect((await t.market.verification.applyToJob(op)).stateAfter).toBe('CLOSED');
    expect((await t.market.verification.col.findOne({ _id: op._id }))?.appliedOutcome).toBeUndefined();
  });

  it('d-1: a copy on a DISABLED source is not verified (inconclusive, no request)', async () => {
    const g = await greenhouse('rv-d1');
    await g.listing([g.gh(9401, 'Disabled One'), g.gh(9402, 'Disabled Two')]);
    await t.market.sources.setEnabled(g.source._id, false, t.actor);
    const j = await g.of(9401);
    const v = await t.market.verification.verify(j._id, t.runtime.http, { operationKey: 'rv-d1' });
    expect(v).toMatchObject({ outcome: 'inconclusive' });
    expect(v.url).toBeUndefined();
    expect(v.detail).toMatch(/enabled source/);
    // The disable rewrites nothing (15c965b): the job keeps its state.
    expect(v.stateAfter).toBe(j.lifecycle.state);
  });

  it('d-2b: a copy whose source document is gone is never verified on a guessed target (no posting-URL fallback, no request)', async () => {
    const g = await greenhouse('rv-d2');
    await g.listing([g.gh(9501, 'Gone One'), g.gh(9502, 'Gone Two')]);
    await t.market.sources.col.deleteOne({ _id: g.source._id });
    const j = await g.of(9501);
    // Without a usable fallback token either: the posting URL is a real greenhouse.io host.
    await t.market.jobs.col.updateOne(
      { _id: j._id },
      { $set: { 'application.ats.provider': 'lever' }, $inc: { rev: 1 } },
    );
    const v = await t.market.verification.verify(j._id, t.runtime.http, { operationKey: 'rv-d2b' });
    expect(v).toMatchObject({ outcome: 'inconclusive' });
    expect(v.url).toBeUndefined();
  });

  it('d-3: with a disabled ATS copy, another authoritative copy (the official site) is verified instead', async () => {
    const g = await greenhouse('rv-d3');
    await g.listing([g.gh(9601, 'Harbour Engineer'), g.gh(9602, 'Stay D3')]);
    const j = await g.of(9601);
    const site = await siteSource('rv-d3');
    const postingPath = '/careers/harbour-engineer';
    pages.set(postingPath, '<html><body><h1>Harbour Engineer</h1></body></html>');
    const out = await t.market.jobPipeline.process({
      source: site,
      locator: `${server.url}${postingPath}`,
      payload: {
        externalId: 'site-harbour',
        title: 'Harbour Engineer',
        descriptionText: 'Harbour Engineer: unique role rv-d3 9601.',
        locations: [{ text: 'Remote' }],
        postingUrl: `${server.url}${postingPath}`,
        provider: { name: 'careers_page' },
      },
      parser: { name: 'test', version: '1' },
    });
    expect(jobIdOf(out)).toBe(j._id);
    await t.market.sources.setEnabled(g.source._id, false, t.actor);
    const v = await t.market.verification.verify(j._id, t.runtime.http, { operationKey: 'rv-d3' });
    expect(v).toMatchObject({ outcome: 'live', method: 'posting_url', sourceId: site._id });
  });
});

describe('PR #11 re-verify #6: only authoritative copies on enabled sources are verified', () => {
  /** A third-party copy of the job (deterministic: added to the job directly). */
  async function addThirdPartyCopy(jobId: string, key: string, postingUrl: string | null) {
    const tp = (
      await t.market.sources.register(
        {
          key: `board:${key}`,
          name: `aggregator ${key}`,
          category: 'job_source',
          provider: 'aggregator',
          acquisition: { workflowKey: 'market.noop' },
          companyId,
          freshness: { policyClass: 'source.careers_page', maxAgeMinutes: 2160 },
          authority: { tier: 'third_party', listingIsComplete: false },
          governance: { accessMethod: 'public_web' },
        },
        t.actor,
      )
    ).source as SourceDoc;
    const job = await t.market.jobs.get(jobId);
    const base = job.sourceRefs[0]!;
    const copy = {
      ...base,
      key: `${tp._id}:${key}`,
      sourceId: tp._id,
      externalId: key,
      provider: 'fixture',
      authority: 'third_party' as const,
      postingUrl,
      present: true,
      lastSeenAt: new Date(),
    };
    await t.market.jobs.col.updateOne(
      { _id: jobId },
      { $push: { sourceRefs: copy }, $addToSet: { sourceKeys: copy.key }, $inc: { rev: 1 } },
    );
    return tp;
  }

  it('H-1 path 1: ATS copy on a disabled source (absent) + an enabled third-party copy whose URL answers 404 → inconclusive, never closed', async () => {
    const g = await greenhouse('rv-h1-own');
    await g.listing([g.gh(9901, 'Tide Analyst'), g.gh(9902, 'Stay H1')]);
    const j = await g.of(9901);
    await addThirdPartyCopy(j._id, 'rv-h1-own', `${server.url}/agg-gone/rv-h1-own`);
    await g.listing([g.gh(9902, 'Stay H1')]); // the ATS copy is absent
    await t.market.sources.setEnabled(g.source._id, false, t.actor);
    const v = await t.market.verification.verify(j._id, t.runtime.http, { operationKey: 'rv-h1-own' });
    expect(v).toMatchObject({ outcome: 'inconclusive' });
    expect(v.url).toBeUndefined();
    expect((await g.of(9901)).lifecycle.state).not.toBe('CLOSED');
  });

  it('H-1 path 2: ATS copy on a disabled source (present) + a third-party copy without a URL → no canonical-URL fallback, never closed', async () => {
    const g = await greenhouse('rv-h1-fallback');
    await g.listing([g.gh(9911, 'Reef Planner'), g.gh(9912, 'Stay H1b')]);
    const j = await g.of(9911);
    await addThirdPartyCopy(j._id, 'rv-h1-fallback', null);
    // The canonical posting URL answers 404 on the fixture server (it is the disabled copy's).
    await t.market.jobs.col.updateOne(
      { _id: j._id },
      {
        $set: { 'application.canonicalPostingUrl': `${server.url}/gone/rv-h1-fallback/9911` },
        $inc: { rev: 1 },
      },
    );
    await t.market.sources.setEnabled(g.source._id, false, t.actor);
    for (const n of [1, 2]) {
      const v = await t.market.verification.verify(j._id, t.runtime.http, {
        operationKey: `rv-h1-fallback-${n}`,
      });
      expect(v).toMatchObject({ outcome: 'inconclusive' });
      expect(v.url).toBeUndefined();
    }
    expect((await g.of(9911)).lifecycle.state).not.toBe('CLOSED');
  });

  it('no canonical-URL fallback: an enabled authoritative copy without its own posting URL is inconclusive, never closed by a 404 elsewhere', async () => {
    const site = await siteSource('rv-no-fallback');
    const out = await t.market.jobPipeline.process({
      source: site,
      locator: `${server.url}/careers/lagoon-engineer`,
      payload: {
        externalId: 'site-lagoon',
        title: 'Lagoon Engineer',
        descriptionText: 'Lagoon Engineer: unique site-only role for the no-fallback check.',
        locations: [{ text: 'Remote' }],
        provider: { name: 'careers_page' },
      },
      parser: { name: 'test', version: '1' },
    });
    const jobId = jobIdOf(out);
    const job = await t.market.jobs.get(jobId);
    expect(job.sourceRefs).toEqual([expect.objectContaining({ sourceId: site._id, postingUrl: null })]);
    // The job's canonical posting URL points elsewhere and answers 404 on the fixture server.
    await t.market.jobs.col.updateOne(
      { _id: jobId },
      { $set: { 'application.canonicalPostingUrl': `${server.url}/gone/rv-no-fallback` }, $inc: { rev: 1 } },
    );
    for (const n of [1, 2]) {
      const v = await t.market.verification.verify(jobId, t.runtime.http, {
        operationKey: `rv-no-fallback-${n}`,
      });
      expect(v).toMatchObject({ outcome: 'inconclusive', sourceId: site._id });
      expect(v.url).toBeUndefined();
    }
    expect((await t.market.jobs.get(jobId)).lifecycle).toMatchObject({ consecutiveNotFound: 0 });
    expect((await t.market.jobs.get(jobId)).lifecycle.state).not.toBe('CLOSED');
  });

  it('RV-REOPEN: a live check made after the job closed reopens it', async () => {
    const b = await ashbyBoard('rv-reopen');
    const j = await runOfTwo(b);
    expect((await b.read('a1')).outcome).toBe('not_found');
    expect((await b.of('a1')).lifecycle.state).toBe('CLOSED');
    await new Promise((r) => setTimeout(r, 5));
    b.set(b.all(['a1', 'a2', 'a3', 'a4'])); // back on the board; no listing run yet
    const live = await checkedOnly(j._id, 'rv-reopen-live');
    expect(live.outcome).toBe('live');
    expect((await t.market.verification.applyToJob(live)).stateAfter).toBe('REOPENED');
    expect((await t.market.verification.col.findOne({ _id: live._id }))?.appliedOutcome).toBeUndefined();
  });

  it('L-4: verification.lastVerifiedAt never moves backwards when an older operation is applied late', async () => {
    const b = await ashbyBoard('rv-l4');
    b.set(b.all(['a1', 'a2', 'a3', 'a4']));
    await b.listing();
    const j = await b.of('a1');
    const older = await checkedOnly(j._id, 'rv-l4-older');
    await new Promise((r) => setTimeout(r, 5));
    const newer = await b.read('a1');
    expect(newer.outcome).toBe('live');
    await t.market.verification.applyToJob(older);
    expect((await b.of('a1')).verification.lastVerifiedAt?.getTime()).toBe(newer.at.getTime());
  });

  it('L-1: an inherently third-party provider cannot be registered with an authoritative tier', async () => {
    const input = (tier: 'official_ats' | 'official_site' | 'operator' | 'third_party') => ({
      key: `aggregator:rv-l1-${tier}`,
      name: `aggregator ${tier}`,
      category: 'job_source' as const,
      provider: 'aggregator',
      acquisition: { workflowKey: 'market.ats.refresh' },
      companyId,
      freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
      authority: { tier, listingIsComplete: false },
    });
    for (const tier of ['official_ats', 'official_site', 'operator'] as const)
      await expect(t.market.sources.register(input(tier), t.actor)).rejects.toMatchObject({
        code: 'validation_failed',
      });
    await expect(t.market.sources.register(input('third_party'), t.actor)).resolves.toMatchObject({
      created: true,
    });
  });
});
