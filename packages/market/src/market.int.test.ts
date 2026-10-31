import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DefaultAiGateway, FixtureAiProvider } from '@aptamind/ai';
import { createTestInfra, startFixtureServer, type TestInfra, waitForRun } from '@aptamind/testing';
import { AI_GATEWAY, AI_TASKS, AiTaskRegistry } from '@aptamind/workflow-nodes';
import { marketAiTasks } from './workflow-nodes';
import { createMarketTestRuntime } from './test-harness';

/**
 * End-to-end Market vertical slices against real MongoDB/Redis/S3:
 *   M1/M2  UK sponsor register → snapshots → observations → canonical companies (+ review)
 *   M3     ATS listing → job observations → canonical jobs → lifecycle
 *   M4     employment intelligence on real pipeline output
 *   M5     verification, source failure safety, reprocessing, review resolution
 * External services are served from committed fixtures by a local HTTP server; nothing here
 * claims a live integration.
 */

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const routes = new Map<string, { status: number; type: string; body: () => Promise<Buffer | string> }>();

beforeAll(async () => {
  infra = await createTestInfra('market');
  t = await createMarketTestRuntime(infra);
  server = await startFixtureServer(async (req, res) => {
    const r = routes.get((req.url ?? '').split('?')[0] ?? '');
    if (!r) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const body = await r.body();
    res.writeHead(r.status, { 'content-type': r.type }).end(body);
  });
});

afterAll(async () => {
  await t?.stop();
  await server?.close();
  await infra?.cleanup();
});

const serve = (p: string, type: string, body: () => Promise<Buffer | string>, status = 200) =>
  routes.set(p, { status, type, body });

async function sponsorSource() {
  const { source } = await t.market.sources.register(
    {
      key: 'uk-sponsor-register',
      name: 'UK sponsor register (fixture server)',
      category: 'company_universe',
      provider: 'uk_home_office_sponsor_register',
      endpoint: { url: `${server.url}/government/publications/register-of-licensed-sponsors-workers` },
      acquisition: { workflowKey: 'market.uk_sponsor_register.import' },
      freshness: { policyClass: 'source.sponsor_register', maxAgeMinutes: 4320 },
      authority: { tier: 'official_registry', listingIsComplete: true },
      governance: { accessMethod: 'public_download' },
    },
    t.actor,
  );
  return source;
}

describe('Market vertical slices', () => {
  it('M2: imports the UK sponsor register into canonical companies with licence evidence and review for ambiguity', async () => {
    serve('/government/publications/register-of-licensed-sponsors-workers', 'text/html', () =>
      t.fixture('uk-sponsor', 'publication-page.html'),
    );
    serve('/media/fixture/2026-09-27_-_Worker_and_Temporary_Worker.csv', 'text/csv', () =>
      t.fixture('uk-sponsor', 'register-t1.csv'),
    );
    const source = await sponsorSource();
    const run = await t.runSource(source._id);
    expect(run.state).toBe('COMPLETED');
    expect(run.output).toMatchObject({ complete: true, anomaly: null });

    const companies = await t.market.companies.col.find({ status: 'active' }).toArray();
    const names = companies.map((c) => c.identity.displayName.value).sort();
    expect(companies).toHaveLength(16);
    expect(names).toContain('Acme Ltd');

    // Same company across routes/name variants → one canonical company with three licences.
    const acme = companies.find((c) => c.identity.normalizedName === 'acme ltd');
    expect(acme?.employment.sponsorship.licences.map((l) => l.route).sort()).toEqual([
      'Global Business Mobility: Senior or Specialist Worker',
      'Scale-up',
      'Skilled Worker',
    ]);
    expect(acme?.employment.sponsorship.capability).toMatchObject({
      value: 'licensed',
      status: 'known',
      confidence: { level: 'high' },
    });
    expect(acme?.employment.sponsorship.licenceCountries).toEqual(['GB']);
    // Provenance: capability evidence points back to observation, snapshot and artifact.
    const ev = acme?.employment.sponsorship.capability.evidence[0];
    expect(ev).toMatchObject({ sourceId: source._id, authority: 'official_registry' });
    expect(ev?.observationId).toMatch(/^cobs_/);
    expect(ev?.snapshotId).toMatch(/^snap_/);
    expect(ev?.artifactId).toMatch(/^art_/);
    // PLC variants merge; trading names become aliases.
    expect(companies.filter((c) => c.identity.normalizedName.startsWith('helix biotech'))).toHaveLength(1);
    const beta = companies.find((c) => c.identity.normalizedName === 'beta co ltd');
    expect(beta?.identity.aliases.map((a) => a.name)).toContain('Beta Logistics');

    // Similar-but-distinct and non-unique names are held for review, not merged.
    const reviews = await t.market.reviews.col.find({ type: 'company_resolution', status: 'open' }).toArray();
    expect(reviews.map((r) => r.subject).sort()).toEqual([
      'Resolve company "Dr J Smith"',
      'Resolve company "Zenith Robotic Ltd"',
    ]);
    // M8.4b: the Government Authorised Exchange row is not evidence (23 rows, 22 observations).
    expect(await t.market.observations.companyObservations.countDocuments({ sourceId: source._id })).toBe(22);
  });

  it('M2 / wave 7: re-running on an unchanged, applied file skips processing and changes nothing', async () => {
    const source = (await t.market.sources.getByKey('uk-sponsor-register'))!;
    const before = {
      companies: await t.market.companies.col.countDocuments({}),
      obs: await t.market.observations.companyObservations.countDocuments({}),
      reviews: await t.market.reviews.col.countDocuments({}),
      snaps: await t.market.observations.snapshots.countDocuments({ sourceId: source._id }),
    };
    const run = await t.runSource(source._id);
    expect(run.state).toBe('COMPLETED');
    expect(await t.market.companies.col.countDocuments({})).toBe(before.companies);
    expect(await t.market.observations.companyObservations.countDocuments({})).toBe(before.obs);
    expect(await t.market.reviews.col.countDocuments({})).toBe(before.reviews);
    expect(await t.market.observations.snapshots.countDocuments({ sourceId: source._id })).toBe(before.snaps);
    const snap = await t.market.observations.snapshots.findOne({ sourceId: source._id });
    expect(snap?.fetchCount).toBe(2);
    // Content hash short-circuit (source DoD 3): the fetch is recorded, no row is processed again
    // and the delisting marker does not move.
    const obs = await t.market.observations.companyObservations.findOne({ sourceId: source._id });
    expect(obs?.seenCount).toBe(1);
    const out = (node: string) => t.runtime.engine.stores.nodeRuns.findCompletedOutput(run._id, node);
    expect((await out('unchanged'))?.output).toMatchObject({ path: 'unchanged' });
    expect((await out('parse'))?.state).not.toBe('COMPLETED');
    expect((await out('finalize'))?.state).not.toBe('COMPLETED');
    const after = (await t.market.sources.getByKey('uk-sponsor-register'))!;
    expect(after.health.status).toBe('healthy');
    expect(after.health.lastCompleteImportStartedAt).toEqual(source.health.lastCompleteImportStartedAt);
    expect(after.health.lastItemCount).toBe(source.health.lastItemCount);
  });

  it('M2: delisting from a later complete register downgrades capability; new sponsors are added', async () => {
    serve('/media/fixture/2026-09-27_-_Worker_and_Temporary_Worker.csv', 'text/csv', () =>
      t.fixture('uk-sponsor', 'register-t2.csv'),
    );
    const source = (await t.market.sources.getByKey('uk-sponsor-register'))!;
    const run = await t.runSource(source._id);
    expect(run.output).toMatchObject({ complete: true, delistedCompanies: 1 });
    const lumen = await t.market.companies.col.findOne({ 'identity.normalizedName': 'lumen energy ltd' });
    expect(lumen?.employment.sponsorship.capability.value).toBe('previously_licensed');
    expect(lumen?.employment.sponsorship.licences[0]?.status).toBe('no_longer_listed');
    expect(
      await t.market.companies.col.findOne({ 'identity.normalizedName': 'solstice games ltd' }),
    ).not.toBeNull();
  });

  it('M5: an anomalous (shrunken) dataset is held back for review instead of mass-delisting', async () => {
    serve('/media/fixture/2026-09-27_-_Worker_and_Temporary_Worker.csv', 'text/csv', async () =>
      (await t.fixture('uk-sponsor', 'register-t2.csv')).toString().split('\n').slice(0, 4).join('\n'),
    );
    const source = (await t.market.sources.getByKey('uk-sponsor-register'))!;
    const run = await t.runSource(source._id);
    expect(run.output).toMatchObject({ complete: false, delistedCompanies: 0 });
    expect((run.output as { anomaly: string }).anomaly).toMatch(/shrank/);
    const acme = await t.market.companies.col.findOne({ 'identity.normalizedName': 'acme ltd' });
    expect(acme?.employment.sponsorship.capability.value).toBe('licensed');
    expect(await t.market.reviews.col.countDocuments({ type: 'source_anomaly', status: 'open' })).toBe(1);
  });

  it('wave 7: a held-back file fetched again unchanged is never skipped (it was not applied)', async () => {
    const source = (await t.market.sources.getByKey('uk-sponsor-register'))!;
    const run = await t.runSource(source._id);
    const node = await t.runtime.engine.stores.nodeRuns.findCompletedOutput(run._id, 'unchanged');
    expect(node?.output).toMatchObject({ path: 'import' });
    expect(run.output).toMatchObject({ complete: false, delistedCompanies: 0 });
    // The anomaly review is deduplicated on (source, snapshot): still exactly one.
    expect(await t.market.reviews.col.countDocuments({ type: 'source_anomaly', status: 'open' })).toBe(1);
  });

  it('M5: reprocesses a stored snapshot without refetching', async () => {
    const source = (await t.market.sources.getByKey('uk-sponsor-register'))!;
    const snaps = await t.market.observations.snapshots
      .find({ sourceId: source._id })
      .sort({ firstFetchedAt: 1 })
      .toArray();
    const hits = server.hits.length;
    const run = await t.runSource(source._id, { snapshotId: snaps[0]!._id });
    expect(run.state).toBe('COMPLETED');
    expect(server.hits.length).toBe(hits);
    // Reprocessing the OLDER register snapshot (t1) after the newer complete import (t2) must not
    // move the delisting marker: a sponsor listed only in t2 stays listed, and one missing from
    // t2 stays delisted (found while fixing M-5: the marker used the reprocessing run's time).
    const solstice = await t.market.companies.col.findOne({
      'identity.normalizedName': 'solstice games ltd',
    });
    expect(solstice?.employment.sponsorship.capability.value).toBe('licensed');
    expect(solstice?.employment.sponsorship.licences[0]?.status).toBe('listed');
    const lumen = await t.market.companies.col.findOne({ 'identity.normalizedName': 'lumen energy ltd' });
    expect(lumen?.employment.sponsorship.licences[0]?.status).toBe('no_longer_listed');
  });

  it('WF7: review decisions update domain state and are audited', async () => {
    const zen = await t.market.reviews.col.findOne({
      subject: 'Resolve company "Zenith Robotic Ltd"',
      status: 'open',
    });
    const resolved = await t.market.reviewService.resolve(
      zen!._id,
      { action: 'create_new', reason: 'Different company: Coventry, B rating' },
      t.actor,
    );
    expect(resolved.status).toBe('resolved');
    const created = resolved.resolution?.result?.companyId as string;
    const company = await t.market.companies.get(created);
    expect(company.identity.distinctFrom).toHaveLength(1);
    expect(company.employment.sponsorship.capability.value).toBe('licensed');

    const smith = await t.market.reviews.col.findOne({
      subject: 'Resolve company "Dr J Smith"',
      status: 'open',
    });
    await t.market.reviewService.resolve(
      smith!._id,
      { action: 'merge', reason: 'Same practice, second site', targetId: smith!.candidates[0]!.id },
      t.actor,
    );
    const merged = await t.market.companies.get(smith!.candidates[0]!.id);
    expect(merged.geography.registeredLocations.map((l) => l.city).sort()).toEqual(['Bristol', 'Leeds']);
    const audit = await t.market.audit.list({ reviewItemId: smith!._id });
    expect(audit.map((a) => a.action)).toContain('review.merge');
  });

  it('M3/M4: ingests an ATS board into canonical jobs with employment intelligence', async () => {
    // Attach an official domain/website + ATS board to Acme (as careers discovery would).
    const acme = (await t.market.companies.col.findOne({ 'identity.normalizedName': 'acme ltd' }))!;
    const { source } = await t.market.sources.register(
      {
        key: 'greenhouse:acme',
        name: 'Acme (greenhouse)',
        category: 'job_source',
        provider: 'greenhouse',
        endpoint: { boardToken: 'acme', url: `${server.url}/v1/boards/acme/jobs` },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId: acme._id,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      },
      t.actor,
    );
    serve('/v1/boards/acme/jobs', 'application/json', () =>
      t.fixture('ats', 'greenhouse', 'acme-listing-t1.json'),
    );
    const run = await t.runSource(source._id);
    expect(run.state).toBe('COMPLETED');
    const jobs = await t.market.jobs.col.find({ companyId: acme._id }).toArray();
    expect(jobs).toHaveLength(5); // malformed entry skipped with a warning
    expect(new Set(jobs.map((j) => j.lifecycle.state))).toEqual(new Set(['VERIFIED_LIVE']));

    const backend = jobs.find((j) => j.identity.title.value === 'Senior Backend Engineer')!;
    expect(backend.geography.workModel.value).toBe('remote');
    expect(backend.geography.remoteScope.value).toMatchObject({ type: 'country', countries: ['US'] });
    expect(backend.geography.remoteScope.evidence[0]?.quote).toMatch(/United States/);

    const designer = jobs.find((j) => j.identity.title.value === 'Product Designer')!;
    // "we are unable to sponsor visas for this role" is free text: a mention, never a verdict
    // (DECISION_LOG 9186ad2); the licence stays company capability and the sentence is evidence.
    expect(designer.immigration.sponsorship.value).toMatchObject({
      status: 'company_capable',
      roleStatement: 'none',
      companyCapability: 'licensed',
    });
    expect(designer.immigration.sponsorship.evidence.map((e) => e.quote).join(' ')).toMatch(
      /unable to sponsor visas/,
    );
    expect(designer.interpretation.flags.map((f) => f.code)).toContain('sponsorship_mentioned');

    const emea = jobs.find((j) => j.identity.title.value === 'Platform Engineer, EMEA')!;
    expect(emea.geography.remoteScope.value).toMatchObject({ type: 'region', regions: ['EMEA'] });
    // Company licence is capability evidence only — never "this job sponsors".
    expect(emea.immigration.sponsorship.value?.status).toBe('company_capable');
    expect(emea.immigration.sponsorship.value?.roleStatement).toBe('none');

    // Idempotent re-run.
    await t.runSource(source._id);
    expect(await t.market.jobs.col.countDocuments({ companyId: acme._id })).toBe(5);
  });

  it('M3/M5: lifecycle tracks changes, additions and absence without closing on one listing', async () => {
    const source = (await t.market.sources.getByKey('greenhouse:acme'))!;
    serve('/v1/boards/acme/jobs', 'application/json', () =>
      t.fixture('ats', 'greenhouse', 'acme-listing-t2.json'),
    );
    await t.runSource(source._id);
    const byExt = async (id: string) => t.market.jobs.col.findOne({ sourceKeys: `${source._id}:${id}` });
    expect((await byExt('4012345005'))?.lifecycle.state).toBe('POSSIBLY_STALE');
    expect((await byExt('4012345003'))?.lifecycle.state).toBe('CHANGED');
    expect((await byExt('4012345006'))?.lifecycle.state).toBe('VERIFIED_LIVE');

    // Reprocessing the same snapshot is not a new observation of absence.
    const snap = await t.market.observations.snapshots
      .find({ sourceId: source._id })
      .sort({ lastFetchedAt: -1 })
      .limit(1)
      .next();
    await t.runSource(source._id, { snapshotId: snap!._id });
    expect((await byExt('4012345005'))?.lifecycle.state).toBe('POSSIBLY_STALE');

    // A second complete listing without the job does not close it on its own (ruling L1) …
    await t.runSource(source._id);
    expect((await byExt('4012345005'))?.lifecycle).toMatchObject({
      state: 'POSSIBLY_STALE',
      consecutiveAbsences: 2,
    });
    // … a not_found verification since the first absence corroborates, and the next listing closes.
    // (Recorded directly as verification evidence: the lifecycle is derived from evidence.)
    const absentJob = (await byExt('4012345005'))!;
    const copy = absentJob.sourceRefs.find((r) => r.externalId === '4012345005')!;
    await t.market.evidence.record([
      {
        _id: `test:nf:${copy.key}`,
        jobId: absentJob._id,
        copyKey: copy.key,
        sourceId: source._id,
        board: copy.board ?? null,
        at: new Date(),
        kind: 'verification',
        outcome: 'not_found',
      },
    ]);
    await t.runSource(source._id);
    const closed = await byExt('4012345005');
    expect(closed?.lifecycle.state).toBe('CLOSED');
    expect(closed?.lifecycle.history.map((h) => h.to)).toEqual(['VERIFIED_LIVE', 'POSSIBLY_STALE', 'CLOSED']);
  });

  it('M5: a failed source fetch never changes job state', async () => {
    const source = (await t.market.sources.getByKey('greenhouse:acme'))!;
    const before = await t.market.jobs.col
      .find({ companyId: source.companyId }, { projection: { 'lifecycle.state': 1 } })
      .toArray();
    serve('/v1/boards/acme/jobs', 'text/plain', async () => 'upstream down', 503);
    const { runId } = await t.market.sources.runNow(source._id, t.actor);
    // The fetch node retries with backoff, then fails; the run fails visibly.
    const run = await waitForRun(t.runtime.engine, runId, ['FAILED', 'COMPLETED'], 90_000);
    expect(run.state).toBe('FAILED');
    const after = await t.market.jobs.col
      .find({ companyId: source.companyId }, { projection: { 'lifecycle.state': 1 } })
      .toArray();
    expect(after).toEqual(before);
    const s = await t.market.sources.get(source._id);
    expect(['degraded', 'failing']).toContain(s.health.status);
    expect(s.health.lastError).toMatch(/503/);
  }, 120_000);

  it('FR-14: resolves a third-party syndicated copy to the official job and keeps its conflicts', async () => {
    const { source } = await t.market.sources.register(
      {
        key: 'aggregator:jobhub',
        name: 'JobHub (fixture)',
        category: 'job_source',
        provider: 'aggregator',
        endpoint: { url: `${server.url}/feed.json` },
        acquisition: { workflowKey: 'market.ats.refresh' },
        freshness: { policyClass: 'source.third_party_feed', maxAgeMinutes: 4320 },
        authority: { tier: 'third_party', listingIsComplete: false },
        governance: { accessMethod: 'licensed_feed' },
      },
      t.actor,
    );
    serve('/feed.json', 'application/json', () => t.fixture('ats', 'aggregator', 'jobs-feed.json'));
    const run = await t.runSource(source._id);
    expect(run.state).toBe('COMPLETED');
    const gh = (await t.market.sources.getByKey('greenhouse:acme'))!;
    const official = await t.market.jobs.col.findOne({ sourceKeys: `${gh._id}:4012345001` });
    expect(official?.sourceRefs.map((r) => r.provider).sort()).toEqual(['aggregator', 'greenhouse']);
    // Official ATS wins; the aggregator's "Remote (Worldwide)" and salary are retained as conflicts.
    expect(official?.geography.remoteScope.value?.type).toBe('country');
    expect(official?.geography.remoteScope.conflicts.length).toBeGreaterThan(0);
    // Won by authority: the others are alternates, not a disagreement listed in conflictFields;
    // the review says "other values kept", not "sources disagree".
    expect(official?.quality.conflictFields).not.toContain('geography.remoteScope');
    const review = await t.market.reviews.col.findOne({ type: 'field_conflict', 'entity.id': official!._id });
    expect(review?.subject).toMatch(/other values kept \(.*geography\.remoteScope/);
    expect(review?.subject).not.toMatch(/sources disagree/);
    // A company mentioned only by the aggregator resolves to the registered legal entity.
    const northwind = await t.market.companies.col.findOne({
      'identity.normalizedName': 'northwind freight ltd',
    });
    expect(await t.market.jobs.col.countDocuments({ companyId: northwind!._id })).toBeGreaterThan(0);
  });

  it('WF6: verification distinguishes live, not found and inconclusive; closure needs repeated evidence', async () => {
    const agg = (await t.market.sources.getByKey('aggregator:jobhub'))!;
    const job = await t.market.jobs.col.findOne({
      'sourceRefs.sourceId': agg._id,
      'sourceRefs.1': { $exists: false },
    });
    expect(job).not.toBeNull();
    const posting = `${server.url}/posting/${job!._id}`;
    await t.market.jobs.col.updateOne({ _id: job!._id }, { $set: { 'sourceRefs.0.postingUrl': posting } });
    serve(
      `/posting/${job!._id}`,
      'text/html',
      async () => `<html><h1>${job!.identity.title.value}</h1></html>`,
    );
    // A third-party copy is never verified (PR #11 re-verify #6 H-1) …
    const tp = await t.market.verification.verify(job!._id, t.runtime.http, { operationKey: 'v0' });
    expect(tp).toMatchObject({ outcome: 'inconclusive' });
    expect(tp.url).toBeUndefined();
    // … not even when it is stored with an authoritative tier: an aggregator copy is third-party
    // by nature (PR #11 re-verify #7 LOW-1).
    await t.market.jobs.col.updateOne(
      { _id: job!._id },
      { $set: { 'sourceRefs.0.authority': 'official_site' }, $inc: { rev: 1 } },
    );
    const relabelled = await t.market.verification.verify(job!._id, t.runtime.http, { operationKey: 'v0b' });
    expect(relabelled).toMatchObject({ outcome: 'inconclusive' });
    expect(relabelled.url).toBeUndefined();
    // An official careers-site copy of the same posting exercises posting-URL verification.
    const { source: site } = await t.market.sources.register(
      {
        key: 'careers:wf6',
        name: 'WF6 careers site',
        category: 'job_source',
        provider: 'careers_page',
        acquisition: { workflowKey: 'market.careers_page.crawl' },
        companyId: job!.companyId,
        freshness: { policyClass: 'source.careers_page', maxAgeMinutes: 4320 },
        authority: { tier: 'official_site', listingIsComplete: false },
        governance: { accessMethod: 'public_web' },
      },
      t.actor,
    );
    await t.market.jobs.col.updateOne(
      { _id: job!._id },
      { $set: { 'sourceRefs.0.authority': 'third_party', 'sourceRefs.0.present': false }, $inc: { rev: 1 } },
    );
    await t.market.jobs.col.updateOne(
      { _id: job!._id },
      {
        $push: {
          sourceRefs: {
            ...job!.sourceRefs[0]!,
            key: `${site._id}:wf6`,
            sourceId: site._id,
            externalId: 'wf6',
            provider: 'careers_page',
            authority: 'official_site',
            postingUrl: posting,
            present: true,
            board: { endpointUrl: null, boardToken: null, apiBase: null },
          },
          sourceKeys: `${site._id}:wf6`,
        },
        $inc: { rev: 1 },
      },
    );
    const live = await t.market.verification.verify(job!._id, t.runtime.http, { operationKey: 'v1' });
    expect(live.outcome).toBe('live');
    serve(`/posting/${job!._id}`, 'text/html', async () => 'gone', 404);
    const nf1 = await t.market.verification.verify(job!._id, t.runtime.http, { operationKey: 'v2' });
    expect(nf1).toMatchObject({ outcome: 'not_found', stateAfter: 'POSSIBLY_STALE' });
    serve(`/posting/${job!._id}`, 'text/html', async () => 'error', 502);
    const inc = await t.market.verification.verify(job!._id, t.runtime.http, { operationKey: 'v3' });
    expect(inc).toMatchObject({ outcome: 'inconclusive', stateAfter: 'POSSIBLY_STALE' });
    serve(`/posting/${job!._id}`, 'text/html', async () => 'gone', 410);
    const nf2 = await t.market.verification.verify(job!._id, t.runtime.http, { operationKey: 'v4' });
    expect(nf2).toMatchObject({ outcome: 'not_found', stateAfter: 'CLOSED' });
    expect(await t.market.verification.col.countDocuments({ jobId: job!._id })).toBe(6);
  });

  it('WF2: discovers careers page and ATS board from the official website and registers the job source', async () => {
    const company = (await t.market.companies.col.findOne({
      'identity.normalizedName': 'orion software solutions ltd',
    }))!;
    // The fixture site is served from the local server, so its absolute links are rebased onto it.
    serve('/', 'text/html', async () =>
      (await t.fixture('careers', 'acme-home.html'))
        .toString()
        .replaceAll('https://www.acme.com', server.url),
    );
    serve('/careers', 'text/html', async () =>
      (await t.fixture('careers', 'acme-careers-greenhouse.html')).toString(),
    );
    const directory = (
      await t.market.sources.register(
        {
          key: 'test:directory',
          name: 'Test directory',
          category: 'manual_import',
          provider: 'fixture',
          acquisition: { workflowKey: 'market.noop' },
          freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 100000 },
          authority: { tier: 'official_site' },
        },
        t.actor,
      )
    ).source;
    await t.market.companyPipeline.process({
      sourceId: directory._id,
      externalId: 'orion',
      payload: {
        name: 'Orion Software Solutions Ltd',
        domain: 'orion.example',
        website: `${server.url}/`,
        aliases: [],
        externalIds: [],
        locations: [],
        industries: [],
      },
      parser: { name: 'test', version: '1' },
    });
    const run = await t.runtime.engine.startRun({
      workflowKey: 'market.company.discover_careers',
      input: { companyId: company._id },
      trigger: { kind: 'manual' },
    });
    const done = await waitForRun(t.runtime.engine, run._id, undefined, 60_000);
    expect(done.state).toBe('COMPLETED');
    expect(done.output).toMatchObject({
      status: 'found',
      ats: [expect.objectContaining({ provider: 'greenhouse', boardToken: 'acme' })],
    });
    const refreshed = await t.market.companies.get(company._id);
    expect(refreshed.employment.ats.value).toEqual([{ provider: 'greenhouse', boardToken: 'acme' }]);
    expect(refreshed.freshness.careersDiscoveryStatus).toBe('found');
  });
  it('WF4: crawls a careers page (host-scoped) and extracts JobPosting JSON-LD into canonical jobs', async () => {
    const detail = async () =>
      (await t.fixture('careers', 'delta-job-detail.html'))
        .toString()
        .replaceAll('https://www.deltalogistics.co.uk', server.url);
    serve('/careers', 'text/html', async () =>
      (await t.fixture('careers', 'delta-careers-listing.html'))
        .toString()
        .replaceAll('https://www.deltalogistics.co.uk', server.url),
    );
    serve('/careers/senior-data-engineer-remote-uk', 'text/html', detail);
    const company = (await t.market.companies.col.findOne({
      'identity.normalizedName': 'nimbus cloud services ltd',
    }))!;
    const { source } = await t.market.sources.register(
      {
        key: 'careers_page:test-delta',
        name: 'Careers page (fixture)',
        category: 'job_source',
        provider: 'careers_page',
        endpoint: { url: `${server.url}/careers` },
        acquisition: {
          workflowKey: 'market.careers_page.crawl',
          config: { startUrl: `${server.url}/careers` },
        },
        companyId: company._id,
        freshness: { policyClass: 'source.careers_page', maxAgeMinutes: 4320 },
        authority: { tier: 'official_site', listingIsComplete: false },
        governance: { accessMethod: 'public_web', crawlPolicy: 'host-scoped' },
      },
      t.actor,
    );
    const run = await t.runSource(source._id);
    expect(run.state).toBe('COMPLETED');
    const crawl = (await t.runtime.engine.loadNodeOutput(run._id, 'crawl')) as {
      pages: Array<{ url: string }>;
    };
    // Out-of-scope links (other hosts) are never fetched.
    expect(crawl.pages.every((p) => p.url.startsWith(server.url))).toBe(true);
    const jobs = await t.market.jobs.col.find({ 'sourceRefs.sourceId': source._id }).toArray();
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    const job = jobs.find((j) => /data engineer/i.test(j.identity.title.value ?? ''));
    expect(job?.sourceRefs[0]?.provider).toBe('careers_page');
    expect(job?.lifecycle.state).toBe('VERIFIED_LIVE');
    expect((await t.market.sources.get(source._id)).health.status).toBe('healthy');
  });
  it('Law H: AI output is schema-validated, stored as a non-canonical proposal and version-traceable', async () => {
    const provider = new FixtureAiProvider(() => ({
      requirements: [
        { text: '5+ years building backend services', importance: 'critical', category: 'experience' },
        { text: 'Experience with Kafka', importance: 'preferred', category: 'skill' },
      ],
    }));
    const tasks = new AiTaskRegistry();
    for (const task of marketAiTasks) tasks.register(task);
    t.runtime.services.register(AI_GATEWAY, new DefaultAiGateway(provider)).register(AI_TASKS, tasks);
    const gh = (await t.market.sources.getByKey('greenhouse:acme'))!;
    const job = (await t.market.jobs.col.findOne({ sourceKeys: `${gh._id}:4012345002` }))!;
    const before = JSON.stringify(job.requirements);
    await t.runtime.catalog.register({
      key: 'test.ai_requirements',
      title: 'AI requirements proposal',
      nodes: [
        {
          id: 'start',
          capability: { type: 'core.manual_trigger', version: 1 },
          input: { payload: { $ref: 'run.input' } },
        },
        {
          id: 'propose',
          capability: { type: 'market.propose_job_requirements', version: 1 },
          input: { jobId: { $ref: 'nodes.start.output.payload.jobId' } },
        },
      ],
      edges: [{ from: 'start', to: 'propose' }],
    });
    const run = await t.runtime.engine.startRun({
      workflowKey: 'test.ai_requirements',
      input: { jobId: job._id },
      trigger: { kind: 'manual' },
    });
    const done = await waitForRun(t.runtime.engine, run._id);
    expect(done.state).toBe('COMPLETED');
    const after = await t.market.jobs.get(job._id);
    expect(after.aiProposals).toHaveLength(1);
    expect(after.aiProposals[0]).toMatchObject({
      task: 'market.job_requirements_proposal',
      applied: false,
      meta: {
        provider: 'fixture',
        model: 'fixture-model-v1',
        promptId: 'market.job_requirements_proposal',
        promptVersion: '1',
        schemaVersion: '1',
      },
    });
    // Canonical requirements are untouched by the proposal.
    expect(JSON.stringify(after.requirements)).toBe(before);

    // Invalid AI output fails the step visibly and changes nothing.
    t.runtime.services.register(
      AI_GATEWAY,
      new DefaultAiGateway(
        new FixtureAiProvider(() => ({ requirements: [{ text: 'x', importance: 'urgent' }] })),
      ),
    );
    const bad = await t.runtime.engine.startRun({
      workflowKey: 'test.ai_requirements',
      input: { jobId: job._id },
      trigger: { kind: 'manual' },
    });
    const failed = await waitForRun(t.runtime.engine, bad._id, undefined, 60_000);
    expect(failed.state).toBe('FAILED');
    expect(failed.error?.name).toBe('AiOutputValidationError');
    expect((await t.market.jobs.get(job._id)).aiProposals).toHaveLength(1);
  }, 90_000);
});
