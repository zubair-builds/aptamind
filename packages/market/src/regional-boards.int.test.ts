/**
 * Regional ATS hosts end to end (M6.3). An EU Greenhouse or Lever board exists only on the EU
 * API host; the US host answers 404 for it. Detection, registration, fetch and verification must
 * all target the board's own host, or a live EU job is "not found" on the US host and closes.
 *
 * The ATS hosts are stubbed behind the real net client (no egress); everything else — the
 * company website used by careers discovery — is served by a local fixture server.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SafeHttpClient, SafeRequest, SafeResponse } from '@aptamind/net';
import { createTestInfra, startFixtureServer, type TestInfra, waitForRun } from '@aptamind/testing';
import { NET_CLIENT } from '@aptamind/workflow-nodes';
import type { SourceDoc } from './sources/source.schema';
import { createMarketTestRuntime } from './test-harness';

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let http: SafeHttpClient;
let companyId: string;
/** Every URL requested from an ATS host. */
const atsRequests: string[] = [];
/** Stubbed ATS responses by exact URL (without query); anything else on an ATS host → 404. */
const ats = new Map<string, unknown>();
const pages = new Map<string, string>();

const ATS_HOST = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com)$/;

function response(url: string, status: number, body: unknown): SafeResponse {
  const bytes = new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    url,
    requestedUrl: url,
    status,
    ok: status >= 200 && status < 300,
    headers: { 'content-type': 'application/json' },
    contentType: 'application/json',
    body: bytes,
    redirects: [],
    fetchedAt: new Date(),
    durationMs: 1,
  };
}

const ghJob = (id: number, title: string) => ({
  id,
  title,
  location: { name: 'Dublin, Ireland' },
  content: `<p>${title}: build our European platform.</p>`,
  absolute_url: `https://job-boards.eu.greenhouse.io/acme-eu/jobs/${id}`,
});
const leverPosting = (id: string, text: string) => ({
  id,
  text,
  categories: { location: 'Berlin, Germany' },
  descriptionPlain: `${text}: build our European platform.`,
  hostedUrl: `https://jobs.eu.lever.co/acme-eu-lever/${id}`,
});

beforeAll(async () => {
  infra = await createTestInfra('regional_boards');
  t = await createMarketTestRuntime(infra);
  server = await startFixtureServer(async (req, res) => {
    const body = pages.get((req.url ?? '').split('?')[0] ?? '');
    if (body === undefined) res.writeHead(404).end();
    else res.writeHead(200, { 'content-type': 'text/html' }).end(body);
  });
  // The real client for the fixture server; ATS hosts are answered from `ats`.
  const real = t.runtime.http;
  http = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop !== 'request') return Reflect.get(target, prop, receiver) as unknown;
      return async (req: SafeRequest): Promise<SafeResponse> => {
        const url = new URL(req.url);
        if (!ATS_HOST.test(url.hostname)) return target.request(req);
        atsRequests.push(req.url);
        const key = `${url.origin}${url.pathname}`;
        return ats.has(key)
          ? response(req.url, 200, ats.get(key))
          : response(req.url, 404, { error: 'Not found' });
      };
    },
  });
  t.runtime.services.register(NET_CLIENT, http);

  const directory = (
    await t.market.sources.register(
      {
        key: 'directory:regional',
        name: 'Directory',
        category: 'manual_import',
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
    externalId: 'acme-eu',
    payload: {
      name: 'Acme Europe GmbH',
      domain: 'acme-eu.example',
      website: `${server.url}/`,
      aliases: [],
      externalIds: [],
      locations: [],
      industries: [],
    },
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

async function discover() {
  const run = await t.runtime.engine.startRun({
    workflowKey: 'market.company.discover_careers',
    input: { companyId },
    trigger: { kind: 'manual' },
  });
  const done = await waitForRun(t.runtime.engine, run._id, undefined, 60_000);
  expect(done.state).toBe('COMPLETED');
  return done;
}

async function jobsOf(source: SourceDoc) {
  return t.market.jobs.col.find({ 'sourceRefs.sourceId': source._id }).toArray();
}

describe('M6.3: regional ATS hosts', () => {
  it('careers discovery registers EU Greenhouse and Lever boards on their EU API endpoints', async () => {
    pages.set(
      '/',
      `<html><body><h1>Acme Europe</h1>
        <div id="grnhse_app"></div>
        <script src="https://boards.eu.greenhouse.io/embed/job_board/js?for=acme-eu"></script>
        <a href="https://jobs.eu.lever.co/acme-eu-lever">Engineering jobs</a>
      </body></html>`,
    );
    const done = await discover();
    expect(done.output).toMatchObject({
      status: 'found',
      ats: expect.arrayContaining([
        expect.objectContaining({
          provider: 'greenhouse',
          boardToken: 'acme-eu',
          apiBase: 'https://boards-api.eu.greenhouse.io/v1/boards',
        }),
        expect.objectContaining({
          provider: 'lever',
          boardToken: 'acme-eu-lever',
          apiBase: 'https://api.eu.lever.co/v0/postings',
        }),
      ]),
    });
    const gh = await t.market.sources.getByKey('greenhouse:eu:acme-eu');
    expect(gh).toMatchObject({
      provider: 'greenhouse',
      companyId,
      endpoint: {
        boardToken: 'acme-eu',
        url: 'https://boards-api.eu.greenhouse.io/v1/boards/acme-eu/jobs?content=true',
      },
    });
    const lever = await t.market.sources.getByKey('lever:eu:acme-eu-lever');
    expect(lever?.endpoint).toEqual({
      boardToken: 'acme-eu-lever',
      url: 'https://api.eu.lever.co/v0/postings/acme-eu-lever?mode=json',
    });
    // Nothing was registered on the default (US) keys or hosts.
    expect(await t.market.sources.getByKey('greenhouse:acme-eu')).toBeNull();
    expect(await t.market.sources.getByKey('lever:acme-eu-lever')).toBeNull();
    // Idempotent: discovering again registers nothing new.
    await discover();
    expect(await t.market.sources.col.countDocuments({ companyId })).toBe(2);
  });

  it('verification of a job on a hand-registered EU board uses the source endpoint host (a US 404 must not close it)', async () => {
    const { source } = await t.market.sources.register(
      {
        key: 'greenhouse:eu:acme-manual',
        name: 'Acme Europe (greenhouse EU, manual)',
        category: 'job_source',
        provider: 'greenhouse',
        endpoint: {
          boardToken: 'acme-manual',
          url: 'https://boards-api.eu.greenhouse.io/v1/boards/acme-manual/jobs?content=true',
        },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      },
      t.actor,
    );
    ats.set('https://boards-api.eu.greenhouse.io/v1/boards/acme-manual/jobs', {
      jobs: [ghJob(701, 'EU Manual Engineer')],
      meta: { total: 1 },
    });
    ats.set(
      'https://boards-api.eu.greenhouse.io/v1/boards/acme-manual/jobs/701',
      ghJob(701, 'EU Manual Engineer'),
    );
    expect((await t.runSource(source._id)).state).toBe('COMPLETED');
    const job = (await t.market.jobs.col.findOne({ sourceKeys: `${source._id}:701` }))!;
    for (const key of ['m-1', 'm-2']) {
      const v = await t.market.verification.verify(job._id, http, { operationKey: key });
      expect(v.outcome).toBe('live');
    }
    expect((await t.market.jobs.get(job._id)).lifecycle.state).toBe('VERIFIED_LIVE');
  });

  it('an EU Greenhouse board is fetched and verified on the EU host; the US host is never asked', async () => {
    const source = (await t.market.sources.getByKey('greenhouse:eu:acme-eu'))!;
    ats.set('https://boards-api.eu.greenhouse.io/v1/boards/acme-eu/jobs', {
      jobs: [ghJob(501, 'EU Platform Engineer'), ghJob(502, 'EU Data Engineer')],
      meta: { total: 2 },
    });
    ats.set(
      'https://boards-api.eu.greenhouse.io/v1/boards/acme-eu/jobs/501',
      ghJob(501, 'EU Platform Engineer'),
    );
    atsRequests.length = 0;
    expect((await t.runSource(source._id)).state).toBe('COMPLETED');
    expect(await jobsOf(source)).toHaveLength(2);

    const job = (await t.market.jobs.col.findOne({ sourceKeys: `${source._id}:501` }))!;
    for (const key of ['op-1', 'op-2']) {
      const v = await t.market.verification.verify(job._id, http, { operationKey: key });
      expect(v).toMatchObject({
        outcome: 'live',
        url: 'https://boards-api.eu.greenhouse.io/v1/boards/acme-eu/jobs/501?pay_transparency=true',
      });
    }
    expect((await t.market.jobs.get(job._id)).lifecycle.state).toBe('VERIFIED_LIVE');
    expect(atsRequests.every((u) => new URL(u).hostname === 'boards-api.eu.greenhouse.io')).toBe(true);
  });

  it('an EU Lever board is fetched and verified on the EU host', async () => {
    const source = (await t.market.sources.getByKey('lever:eu:acme-eu-lever'))!;
    ats.set('https://api.eu.lever.co/v0/postings/acme-eu-lever', [
      leverPosting('l-1', 'EU Site Reliability Engineer'),
    ]);
    ats.set(
      'https://api.eu.lever.co/v0/postings/acme-eu-lever/l-1',
      leverPosting('l-1', 'EU Site Reliability Engineer'),
    );
    atsRequests.length = 0;
    expect((await t.runSource(source._id)).state).toBe('COMPLETED');
    const job = (await t.market.jobs.col.findOne({ sourceKeys: `${source._id}:l-1` }))!;
    const v = await t.market.verification.verify(job._id, http, { operationKey: 'lever-1' });
    expect(v).toMatchObject({
      outcome: 'live',
      url: 'https://api.eu.lever.co/v0/postings/acme-eu-lever/l-1',
    });
    expect(atsRequests.every((u) => new URL(u).hostname === 'api.eu.lever.co')).toBe(true);
  });

  it('US boards keep their key, endpoint and verification host', async () => {
    pages.set('/', `<a href="https://boards.greenhouse.io/acme-us">Jobs</a>`);
    await discover();
    const us = (await t.market.sources.getByKey('greenhouse:acme-us'))!;
    expect(us.endpoint).toEqual({
      boardToken: 'acme-us',
      url: 'https://boards-api.greenhouse.io/v1/boards/acme-us/jobs?content=true',
    });
    ats.set('https://boards-api.greenhouse.io/v1/boards/acme-us/jobs', {
      jobs: [ghJob(601, 'US Backend Engineer')],
      meta: { total: 1 },
    });
    ats.set('https://boards-api.greenhouse.io/v1/boards/acme-us/jobs/601', ghJob(601, 'US Backend Engineer'));
    expect((await t.runSource(us._id)).state).toBe('COMPLETED');
    const job = (await t.market.jobs.col.findOne({ sourceKeys: `${us._id}:601` }))!;
    const v = await t.market.verification.verify(job._id, http, { operationKey: 'us-1' });
    expect(v).toMatchObject({
      outcome: 'live',
      url: 'https://boards-api.greenhouse.io/v1/boards/acme-us/jobs/601?pay_transparency=true',
    });
  });

  it('a source endpoint that does not identify the API base makes verification inconclusive, never a guessed host', async () => {
    const source = (await t.market.sources.getByKey('greenhouse:eu:acme-eu'))!;
    const job = (await t.market.jobs.col.findOne({ sourceKeys: `${source._id}:502` }))!;
    await t.market.sources.col.updateOne(
      { _id: source._id },
      { $set: { 'endpoint.url': 'https://proxy.acme-eu.example/greenhouse-feed.json' } },
    );
    try {
      atsRequests.length = 0;
      // The copy was seen on the EU board: an endpoint that is not that board is never read
      // (PR #11 re-verify #7 MEDIUM-2).
      const changed = await t.market.verification.verify(job._id, http, { operationKey: 'no-base-board' });
      expect(changed.outcome).toBe('inconclusive');
      expect(changed.detail).toMatch(/endpoint changed since this copy was last seen/);
      // A copy without a recorded board (a job written before boards and derivation existed) on
      // an endpoint that does not identify its API base.
      await t.market.jobs.col.updateOne(
        { _id: job._id },
        { $unset: { 'sourceRefs.$[].board': '', 'lifecycle.derivedVersion': '' }, $inc: { rev: 1 } },
      );
      const v = await t.market.verification.verify(job._id, http, { operationKey: 'no-base' });
      expect(v.outcome).toBe('inconclusive');
      expect(v.detail).toMatch(/API base/);
      expect(atsRequests).toEqual([]);
      expect((await t.market.jobs.get(job._id)).lifecycle.state).toBe('VERIFIED_LIVE');
    } finally {
      await t.market.sources.col.updateOne(
        { _id: source._id },
        {
          $set: { 'endpoint.url': 'https://boards-api.eu.greenhouse.io/v1/boards/acme-eu/jobs?content=true' },
        },
      );
    }
  });

  it('PR #11 LOW-1: a board-token PATCH on a regional source keeps its regional host, or is refused — never the default host', async () => {
    const { source } = await t.market.sources.register(
      {
        key: 'greenhouse:eu:acme-patch',
        name: 'Acme Europe (greenhouse EU, patch)',
        category: 'job_source',
        provider: 'greenhouse',
        endpoint: {
          boardToken: 'acme-patch',
          url: 'https://boards-api.eu.greenhouse.io/v1/boards/acme-patch/jobs?content=true',
        },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      },
      t.actor,
    );
    const patched = await t.market.sources.update(
      source._id,
      { endpoint: { boardToken: 'acme-patch-2' } },
      t.actor,
    );
    expect(patched.endpoint).toEqual({
      boardToken: 'acme-patch-2',
      url: 'https://boards-api.eu.greenhouse.io/v1/boards/acme-patch-2/jobs?content=true',
    });
    // An endpoint whose API host cannot be recovered: a token-only PATCH is refused.
    await t.market.sources.col.updateOne(
      { _id: source._id },
      { $set: { 'endpoint.url': 'https://proxy.acme-eu.example/greenhouse-feed.json' } },
    );
    await expect(
      t.market.sources.update(source._id, { endpoint: { boardToken: 'acme-patch-3' } }, t.actor),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect((await t.market.sources.get(source._id)).endpoint).toEqual({
      boardToken: 'acme-patch-2',
      url: 'https://proxy.acme-eu.example/greenhouse-feed.json',
    });
  });

  it('PR #11 LOW-3: the same holds for a Lever EU source (the host comes from the stored URL)', async () => {
    const { source } = await t.market.sources.register(
      {
        key: 'lever:eu:acme-lever-patch',
        name: 'Acme Europe (lever EU, patch)',
        category: 'job_source',
        provider: 'lever',
        endpoint: {
          boardToken: 'acme-lever-patch',
          url: 'https://api.eu.lever.co/v0/postings/acme-lever-patch?mode=json',
        },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      },
      t.actor,
    );
    const patched = await t.market.sources.update(
      source._id,
      { endpoint: { boardToken: 'acme-lever-patch-2' } },
      t.actor,
    );
    expect(patched.endpoint).toEqual({
      boardToken: 'acme-lever-patch-2',
      url: 'https://api.eu.lever.co/v0/postings/acme-lever-patch-2?mode=json',
    });
  });

  it('E1: an ATS source registered or patched without an endpoint URL stores the default listing URL, and verification uses that host', async () => {
    const { source } = await t.market.sources.register(
      {
        key: 'greenhouse:acme-nourl',
        name: 'Acme (greenhouse, no URL)',
        category: 'job_source',
        provider: 'greenhouse',
        endpoint: { boardToken: 'acme-nourl' },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      },
      t.actor,
    );
    expect(source.endpoint.url).toBe(
      'https://boards-api.greenhouse.io/v1/boards/acme-nourl/jobs?content=true',
    );
    const patched = await t.market.sources.update(
      source._id,
      { endpoint: { boardToken: 'acme-nourl' } },
      t.actor,
    );
    expect(patched.endpoint.url).toBe(source.endpoint.url);

    // A legacy document without endpoint.url: fetch used the default host, so verification does too.
    ats.set('https://boards-api.greenhouse.io/v1/boards/acme-nourl/jobs', {
      jobs: [ghJob(801, 'Default Host Engineer')],
      meta: { total: 1 },
    });
    ats.set(
      'https://boards-api.greenhouse.io/v1/boards/acme-nourl/jobs/801',
      ghJob(801, 'Default Host Engineer'),
    );
    await t.market.sources.col.updateOne({ _id: source._id }, { $unset: { 'endpoint.url': '' } });
    expect((await t.runSource(source._id)).state).toBe('COMPLETED');
    const job = (await t.market.jobs.col.findOne({ sourceKeys: `${source._id}:801` }))!;
    atsRequests.length = 0;
    const v = await t.market.verification.verify(job._id, http, { operationKey: 'no-endpoint' });
    expect(v.outcome).toBe('live');
    expect(atsRequests).toEqual([
      'https://boards-api.greenhouse.io/v1/boards/acme-nourl/jobs/801?pay_transparency=true',
    ]);

    // Only a missing source document is inconclusive (no host to trust at all).
    const orphan = { ...job, sourceRefs: job.sourceRefs.map((r) => ({ ...r, sourceId: 'src_missing' })) };
    await t.market.jobs.col.updateOne(
      { _id: job._id },
      { $set: { sourceRefs: orphan.sourceRefs }, $inc: { rev: 1 } },
    );
    atsRequests.length = 0;
    const missing = await t.market.verification.verify(job._id, http, { operationKey: 'missing-source' });
    expect(missing).toMatchObject({ outcome: 'inconclusive', detail: expect.stringMatching(/missing/) });
    expect(atsRequests).toEqual([]);
  });

  it('a board registered earlier on the default host for the same company is flagged for review', async () => {
    // As the pre-M6.3 code registered EU boards: default key, US endpoint.
    const { source: legacy } = await t.market.sources.register(
      {
        key: 'lever:acme-eu-legacy',
        name: 'Acme Europe (lever)',
        category: 'job_source',
        provider: 'lever',
        endpoint: {
          boardToken: 'acme-eu-legacy',
          url: 'https://api.lever.co/v0/postings/acme-eu-legacy?mode=json',
        },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      },
      t.actor,
    );
    pages.set('/', `<a href="https://jobs.eu.lever.co/acme-eu-legacy">Jobs</a>`);
    await discover();
    expect(await t.market.sources.getByKey('lever:eu:acme-eu-legacy')).not.toBeNull();
    const reviews = await t.market.reviews.col
      .find({ type: 'careers_discovery', 'entity.id': companyId, status: 'open' })
      .toArray();
    expect(reviews.find((r) => r.context.legacySourceId === legacy._id)).toMatchObject({
      severity: 'low',
      subject: expect.stringMatching(/also registered on the default host/),
    });
  });
});
