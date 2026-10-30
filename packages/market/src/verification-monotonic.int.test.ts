/**
 * Job verification apply is monotonic and re-validated (PR #11 re-verification #7; DECISION_LOG
 * "Job verification apply is monotonic and re-validated"):
 *
 *  - HIGH-1: an old live operation applied late never rewinds `lastVerifiedAt`, so the apply
 *    re-gate cannot let a superseded not_found close a live job;
 *  - MEDIUM-1: job-level presence counts only copies on existing, enabled sources;
 *  - MEDIUM-2: a copy is verified only on the board where it was seen; a changed endpoint or a
 *    failed latest listing makes verification inconclusive;
 *  - LOW-1: providers outside the closed job-source set are never authoritative;
 *  - LOW-2: at apply time the op's source must still be an existing, enabled, authoritative source
 *    and the op must have been recorded under the current verification logic version;
 *  - LOW-5: `verification.lastOutcome` moves only with a newer `lastVerifiedAt`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@aptamind/contracts';
import { createTestInfra, startFixtureServer, type TestInfra } from '@aptamind/testing';
import { FreshnessService } from './freshness/freshness.service';
import type { JobDoc } from './jobs/job.schema';
import { type SourceDoc, sourceDocSchema } from './sources/source.schema';
import { createMarketTestRuntime } from './test-harness';
import { VERIFICATION_LOGIC_VERSION } from './verification/verification.service';

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let companyId: string;
/** JSON bodies on the fixture server, by path (anything else answers 404). */
const bodies = new Map<string, unknown>();
const tick = () => new Promise((r) => setTimeout(r, 5));

beforeAll(async () => {
  infra = await createTestInfra('verification_monotonic');
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
        key: 'directory:monotonic',
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
    externalId: 'monotonic-co',
    payload: { name: 'Monotonic Evidence Ltd', aliases: [], externalIds: [], locations: [], industries: [] },
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

/** Claim, check and record a verification without applying it. */
async function checkedOnly(jobId: string, key: string) {
  const op = await svc().claim(`ver_${key}`, jobId, { operationKey: key });
  return svc().recordResult(op._id, await svc().check(await t.market.jobs.get(jobId), t.runtime.http));
}

/** A Greenhouse board on the fixture server; `live(id)` serves its single-job endpoint. */
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
    bodies.set(path, { jobs: ids.map(gh) });
    expect((await t.runSource(source._id)).state).toBe('COMPLETED');
  };
  const live = (id: number) => bodies.set(`${path}/${id}`, gh(id));
  const gone = (id: number) => bodies.delete(`${path}/${id}`);
  return { source, path, gh, of, listing, live, gone };
}

/** An Ashby board (a board-derived check reads the whole board). */
async function ashby(token: string) {
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
  const job = (id: string) => ({
    id,
    title: `Ashby role ${token} ${id}`,
    location: 'Remote',
    isListed: true,
    jobUrl: `https://jobs.ashbyhq.com/${token}/${id}`,
    descriptionPlain: `Run the unique ${token} ${id} workstream across teams. Board ${token}.`,
  });
  const listing = async (ids: string[]) => {
    bodies.set(path, { jobs: ids.map(job) });
    expect((await t.runSource(source._id)).state).toBe('COMPLETED');
  };
  const of = async (id: string) =>
    (await t.market.jobs.col.findOne({ sourceKeys: `${source._id}:${id}` })) as JobDoc;
  return { source, job, listing, of };
}

/** An official careers-site source (never complete). */
async function careersSite(key: string) {
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

let opKey = 0;
const verify = (jobId: string) => svc().verify(jobId, t.runtime.http, { operationKey: `mono-${++opKey}` });

describe('HIGH-1: every lifecycle timestamp only moves forward', () => {
  it('live L1 → 404 N → live L3 applied → L1 applied late → N applied: the job is not closed', async () => {
    const g = await greenhouse('mono-h1');
    await g.listing([1, 2, 3]);
    await g.listing([2, 3]); // job 1 is absent from its only listing
    const j = await g.of(1);
    expect(j.lifecycle).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveAbsences: 1 });

    g.live(1);
    const l1 = await checkedOnly(j._id, 'mono-h1-L1'); // 1. live at T1, not applied
    expect(l1.outcome).toBe('live');
    await tick();
    g.gone(1);
    const n = await checkedOnly(j._id, 'mono-h1-N'); // 2. 404 at T2, not applied
    expect(n).toMatchObject({ outcome: 'not_found', method: 'ats_api' });
    await tick();
    g.live(1);
    const l3 = await verify(j._id); // 3. live at T3, verified and applied
    expect(l3.outcome).toBe('live');
    const t3 = l3.at.getTime();
    expect((await g.of(1)).lifecycle.lastVerifiedAt?.getTime()).toBe(t3);

    await svc().applyToJob(l1); // 4. L1 applied late: lastVerifiedAt does not rewind to T1
    const afterL1 = await g.of(1);
    expect(afterL1.lifecycle.lastVerifiedAt?.getTime()).toBe(t3);
    expect(afterL1.lifecycle).toMatchObject({ state: 'VERIFIED_LIVE', consecutiveAbsences: 0 });
    // LOW-5: an older op changes neither the verification time nor its outcome.
    expect(afterL1.verification.lastVerifiedAt?.getTime()).toBe(t3);
    expect(afterL1.verification.lastOutcome).toBe('live');

    const states = await svc().applyToJob(n); // 5. N applied: superseded by L3
    expect(states.stateAfter).not.toBe('CLOSED');
    const after = await g.of(1);
    expect(after.lifecycle.state).toBe('VERIFIED_LIVE');
    expect(after.lifecycle.lastVerifiedAt?.getTime()).toBe(t3);
    expect(after.lifecycle.consecutiveNotFound).toBe(0);
    expect(after.verification.lastOutcome).toBe('live');
    // Derived (6a01b36): N is evidence at T2, followed by the live read at T3 — it no longer counts.
    expect(await svc().col.findOne({ _id: n._id })).toMatchObject({ outcome: 'not_found' });
  });

  it('a live op checked before a newer absence neither resets that absence run nor makes the job live', async () => {
    const g = await greenhouse('mono-h1b');
    await g.listing([1, 2, 3]);
    g.live(1);
    const early = await checkedOnly((await g.of(1))._id, 'mono-h1b-early');
    expect(early.outcome).toBe('live');
    await tick();
    await g.listing([2, 3]); // absence at A > early.at
    const absent = await g.of(1);
    expect(absent.lifecycle).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveAbsences: 1 });
    await svc().applyToJob(early);
    const after = await g.of(1);
    expect(after.lifecycle).toMatchObject({
      state: 'POSSIBLY_STALE',
      consecutiveAbsences: 1,
      absentSince: absent.lifecycle.absentSince,
    });
  });
});

describe('MEDIUM-1: job-level presence counts only copies on existing, enabled sources', () => {
  it('a frozen present official-site copy on a disabled source does not keep an Ashby job live: it closes on the enabled board', async () => {
    const b = await ashby('mono-m1');
    await b.listing(['a1', 'a2', 'a3', 'a4']);
    const j = await b.of('a1');
    const site = await careersSite('mono-m1');
    const out = await t.market.jobPipeline.process({
      source: site,
      locator: 'https://m1.example/careers/a1',
      payload: {
        externalId: 'site-a1',
        title: b.job('a1').title,
        descriptionText: b.job('a1').descriptionPlain,
        locations: [{ text: 'Remote' }],
        postingUrl: b.job('a1').jobUrl,
        provider: { name: 'careers_page' },
      },
      parser: { name: 'test', version: '1' },
    });
    expect('jobId' in out && out.jobId).toBe(j._id);
    await t.market.sources.setEnabled(site._id, false, t.actor);
    const frozen = (await b.of('a1')).sourceRefs.find((r) => r.sourceId === site._id);
    expect(frozen).toMatchObject({ present: true, authority: 'official_site' });

    // The job leaves the enabled Ashby board: the disabled site copy does not count as present.
    await b.listing(['a2', 'a3', 'a4']);
    await b.listing(['a2', 'a3', 'a4']);
    expect((await b.of('a1')).lifecycle).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveAbsences: 2 });
    const v = await verify(j._id);
    expect(v).toMatchObject({ outcome: 'not_found', sourceId: b.source._id, boardDerived: true });
    expect((await b.of('a1')).lifecycle.state).toBe('CLOSED');
  });

  it('every authoritative copy on a disabled source: never verified, never closed, decays to POSSIBLY_STALE', async () => {
    const b = await ashby('mono-m1b');
    await b.listing(['a1', 'a2', 'a3', 'a4']);
    const j = await b.of('a1');
    const site = await careersSite('mono-m1b');
    await t.market.jobPipeline.process({
      source: site,
      locator: 'https://m1b.example/careers/a1',
      payload: {
        externalId: 'site-a1',
        title: b.job('a1').title,
        descriptionText: b.job('a1').descriptionPlain,
        locations: [{ text: 'Remote' }],
        postingUrl: b.job('a1').jobUrl,
        provider: { name: 'careers_page' },
      },
      parser: { name: 'test', version: '1' },
    });
    bodies.set(`/posting-api/job-board/mono-m1b`, { jobs: [] }); // the board would say "not found"
    await t.market.sources.setEnabled(site._id, false, t.actor);
    await t.market.sources.setEnabled(b.source._id, false, t.actor);
    for (let i = 0; i < 2; i++) {
      const v = await verify(j._id);
      expect(v.outcome).toBe('inconclusive');
      expect(v.detail).toContain('no authoritative copy of this job is on an enabled');
    }
    // The disables rewrite nothing (DECISION_LOG 15c965b: standing as of the evidence time): the
    // job stays as it was and decays through the stale sweep; nothing ever closes it.
    expect((await b.of('a1')).lifecycle.state).toBe('VERIFIED_LIVE');
    const future = new FreshnessService({
      ...t.market.ctx,
      clock: { now: () => new Date(Date.now() + 7 * 86_400_000) },
    });
    await future.staleSweep();
    expect((await b.of('a1')).lifecycle.state).toBe('POSSIBLY_STALE');
    expect((await verify(j._id)).outcome).toBe('inconclusive');
    // (Re-derived at the real now, it is fresh again: staleness is a function of time.)
    const after = await b.of('a1');
    expect(after.lifecycle.state).not.toBe('CLOSED');
    expect(after.lifecycle.consecutiveNotFound).toBe(0);
  });
});

describe('MEDIUM-2: a copy is verified only on the board where it was seen', () => {
  it('the typo scenario: a Greenhouse endpoint PATCHed to a wrong board changes no job state in two verification cycles', async () => {
    const g = await greenhouse('mono-m2');
    await g.listing([1, 2, 3]);
    const jobs = await Promise.all([1, 2, 3].map((id) => g.of(id)));
    for (const j of jobs)
      expect(j.sourceRefs[0]?.board).toMatchObject({
        boardToken: 'mono-m2',
        apiBase: server.url + '/v1/boards',
      });
    // The typo: the wrong board has no jobs, so every single-job read there answers 404.
    await t.market.sources.update(g.source._id, { endpoint: { boardToken: 'mono-m2-typo' } }, t.actor);
    const before = new Map(jobs.map((j) => [j._id, j.lifecycle.state]));
    const cycle = async () => {
      for (const j of jobs) {
        const v = await verify(j._id);
        expect(v.outcome).toBe('inconclusive');
        expect(v.url).toBeUndefined(); // nothing was read on the wrong board
      }
    };
    await cycle(); // the endpoint changed since the copies were last seen
    // The listing fetch on the wrong board fails (404): a source failure, never job evidence.
    expect((await t.runSource(g.source._id)).state).toBe('FAILED');
    await cycle();
    for (const j of jobs) expect((await t.market.jobs.get(j._id)).lifecycle.state).toBe(before.get(j._id));
    const detail = (await svc().history(jobs[0]!._id, 1))[0]?.detail ?? '';
    expect(detail).toMatch(/latest listing fetch .* failed|endpoint changed/);
  });

  it('a copy seen in a listing fetched before an endpoint change has an unknown board: inconclusive', async () => {
    const g = await greenhouse('mono-m2-null');
    const fetchedAt = new Date();
    await tick();
    await t.market.sources.update(g.source._id, { endpoint: { boardToken: 'mono-m2-null2' } }, t.actor);
    const source = await t.market.sources.get(g.source._id);
    expect(source.endpointChangedAt).toBeDefined();
    const out = await t.market.jobPipeline.process({
      source,
      locator: 'record:1',
      payload: {
        externalId: '1',
        title: 'Role mono-m2-null 1',
        descriptionText: 'Own the unique mono-m2-null programme number 1 end to end.',
        locations: [{ text: 'Remote' }],
        postingUrl: 'https://job-boards.greenhouse.io/mono-m2-null/jobs/1',
        provider: { name: 'greenhouse', boardToken: 'mono-m2-null' },
      },
      parser: { name: 'test', version: '1' },
      at: fetchedAt,
    });
    const jobId = 'jobId' in out ? out.jobId! : '';
    expect((await t.market.jobs.get(jobId)).sourceRefs[0]?.board).toBeNull();
    const v = await verify(jobId);
    expect(v).toMatchObject({ outcome: 'inconclusive' });
    expect(v.detail).toContain('is unknown');
  });

  describe('copies without a recorded board (seen before boards were recorded)', () => {
    const legacy = async (token: string) => {
      const g = await greenhouse(token);
      await g.listing([1, 2]);
      const j = await g.of(1);
      await t.market.jobs.col.updateOne(
        { _id: j._id },
        { $unset: { 'sourceRefs.$[].board': '', 'lifecycle.derivedVersion': '' }, $inc: { rev: 1 } },
      );
      expect((await g.of(1)).sourceRefs[0]).not.toHaveProperty('board');
      return { g, j };
    };

    it('an unchanged endpoint: verified on it', async () => {
      const { g, j } = await legacy('mono-m2-legacy');
      g.live(1);
      expect(await verify(j._id)).toMatchObject({ outcome: 'live', method: 'ats_api' });
    });

    it('an endpoint changed after the copy was last seen (endpointChangedAt): inconclusive', async () => {
      const { g, j } = await legacy('mono-m2-legacy-b');
      await tick();
      await t.market.sources.update(g.source._id, { endpoint: { boardToken: 'mono-m2-legacy-b2' } }, t.actor);
      const v = await verify(j._id);
      expect(v.outcome).toBe('inconclusive');
      expect(v.detail).toContain('may have changed');
    });

    it('an endpoint change recorded only in the audit log (before endpointChangedAt existed): inconclusive', async () => {
      const { g, j } = await legacy('mono-m2-legacy-c');
      g.live(1);
      await tick();
      await t.market.sources.update(g.source._id, { endpoint: { boardToken: 'mono-m2-legacy-c' } }, t.actor);
      await t.market.sources.col.updateOne({ _id: g.source._id }, { $unset: { endpointChangedAt: '' } });
      const v = await verify(j._id);
      expect(v.outcome).toBe('inconclusive');
      expect(v.detail).toContain('may have changed');
    });
  });
});

describe('LOW-1: providers outside the closed set are never authoritative', () => {
  it('a stored job source with an unrecognised provider is reported, and its copies are third-party', async () => {
    const now = new Date();
    const stored = sourceDocSchema.parse({
      _id: newId('src'),
      key: 'legacy:adzuna-feed',
      name: 'Legacy feed',
      category: 'job_source',
      provider: 'adzuna-feed',
      endpoint: {},
      acquisition: { workflowKey: 'market.noop' },
      companyId,
      freshness: { policyClass: 'source.careers_page', maxAgeMinutes: 2160 },
      authority: { tier: 'official_ats', listingIsComplete: true },
      enabled: true,
      health: { status: 'never_run', consecutiveFailures: 0 },
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    await t.market.sources.col.insertOne(stored);
    expect((await t.market.sources.unrecognisedJobSourceProviders()).map((s) => s.key)).toContain(
      'legacy:adzuna-feed',
    );
    const out = await t.market.jobPipeline.process({
      source: stored,
      locator: 'feed:1',
      payload: {
        externalId: 'feed-1',
        title: 'Feed only archivist',
        descriptionText: 'Catalogue the unique legacy feed archive end to end.',
        locations: [{ text: 'Remote' }],
        postingUrl: `${server.url}/feed/1`,
        provider: { name: 'adzuna-feed' },
      },
      parser: { name: 'test', version: '1' },
    });
    const job = await t.market.jobs.get('jobId' in out ? out.jobId! : '');
    expect(job.sourceRefs[0]?.authority).toBe('third_party');
    expect(job.lifecycle.state).toBe('DISCOVERED');
    // A copy stored earlier with the source's authoritative tier is still not verified.
    await t.market.jobs.col.updateOne(
      { _id: job._id },
      { $set: { 'sourceRefs.0.authority': 'official_ats' }, $inc: { rev: 1 } },
    );
    const v = await verify(job._id);
    expect(v.outcome).toBe('inconclusive');
    expect(v.detail).toContain('outside the job-source provider set');
  });
});

describe('LOW-2: an op is re-validated against its source and logic version when applied', () => {
  it('a source disabled between check and apply: the 404s were checked while it was enabled, so they count (15c965b)', async () => {
    const g = await greenhouse('mono-l2');
    await g.listing([1, 2, 3]);
    const j = await g.of(1);
    const n1 = await checkedOnly(j._id, 'mono-l2-n1');
    await tick();
    const n2 = await checkedOnly(j._id, 'mono-l2-n2');
    expect([n1.outcome, n2.outcome]).toEqual(['not_found', 'not_found']);
    await t.market.sources.setEnabled(g.source._id, false, t.actor);
    await svc().applyToJob(n1);
    await svc().applyToJob(n2);
    const after = await g.of(1);
    // Standing is evaluated as of each result's own time (DECISION_LOG 15c965b, superseding the
    // apply-time re-check of re-verify #7 LOW-2): both 404s were checked while the source was
    // enabled, so they count, and the later disable rewrites none of it.
    expect(after.lifecycle).toMatchObject({ state: 'CLOSED', consecutiveNotFound: 2, lastNotFoundAt: n2.at });
    // Both results are recorded once, as they were checked.
    expect(
      await t.market.evidence.col.countDocuments({
        _id: { $in: [`ver:${n1._id}`, `ver:${n2._id}`] },
        outcome: 'not_found',
      }),
    ).toBe(2);
  });

  it('an op recorded under another verification logic version is applied as inconclusive', async () => {
    const g = await greenhouse('mono-l2-ver');
    await g.listing([1, 2, 3]);
    await g.listing([2, 3]);
    const j = await g.of(1);
    const n = await checkedOnly(j._id, 'mono-l2-ver');
    expect(n).toMatchObject({ outcome: 'not_found', logicVersion: VERIFICATION_LOGIC_VERSION });
    await svc().col.updateOne({ _id: n._id }, { $set: { logicVersion: 'job-verify/6' } });
    await svc().applyToJob({ ...n, logicVersion: 'job-verify/6' });
    expect((await g.of(1)).lifecycle.state).not.toBe('CLOSED');
    expect(await svc().col.findOne({ _id: n._id })).toMatchObject({
      appliedOutcome: 'inconclusive',
      appliedNote: expect.stringContaining('job-verify/6'),
    });
  });
});
