import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestInfra, startFixtureServer, type TestInfra, waitForRun } from '@aptamind/testing';
import { createMarketTestRuntime } from './test-harness';

/**
 * Wave 6 (generic careers pages): careers discovery registers a company's careers page as a
 * scheduled `careers_page` source when no ATS board is found; a careers link off the official
 * hosts goes to review instead; the registered source crawls (JSON-LD) into canonical jobs and a
 * second identical crawl is idempotent. Fixture server on loopback; nothing here is live.
 */

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const routes = new Map<string, () => Promise<string>>();

beforeAll(async () => {
  infra = await createTestInfra('market-careers');
  t = await createMarketTestRuntime(infra);
  server = await startFixtureServer(async (req, res) => {
    const r = routes.get((req.url ?? '').split('?')[0] ?? '');
    if (!r) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(await r());
  });
});

afterAll(async () => {
  await t?.stop();
  await server?.close();
  await infra?.cleanup();
});

async function company(name: string, slug: string) {
  const { source } = await t.market.sources.register(
    {
      key: `test:directory:${slug}`,
      name: 'Test directory',
      category: 'manual_import',
      provider: 'fixture',
      acquisition: { workflowKey: 'market.noop' },
      freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 100000 },
      authority: { tier: 'official_site' },
    },
    t.actor,
  );
  await t.market.companyPipeline.process({
    sourceId: source._id,
    externalId: slug,
    payload: {
      name,
      // `.example` never resolves to fetch candidates; the official site is the loopback fixture server.
      domain: `${slug}.example`,
      website: `${server.url}/${slug}/`,
      aliases: [],
      externalIds: [],
      locations: [],
      industries: [],
    },
    parser: { name: 'test', version: '1' },
  });
  return (await t.market.companies.col.findOne({ 'identity.displayName.value': name }))!;
}

async function discover(companyId: string) {
  const run = await t.runtime.engine.startRun({
    workflowKey: 'market.company.discover_careers',
    input: { companyId },
    trigger: { kind: 'manual' },
  });
  const done = await waitForRun(t.runtime.engine, run._id, undefined, 60_000);
  expect(done.state).toBe('COMPLETED');
  const node = await t.runtime.engine.stores.nodeRuns.findCompletedOutput(run._id, 'careers_page');
  return node?.output as { outcome: string; sourceId: string | null };
}

describe('wave 6: generic careers pages', () => {
  it('registers a careers page without an ATS as a scheduled careers_page source, idempotently', async () => {
    // An IP-addressed site has no registrable domain, so discovery finds the page by probing
    // the origin's conventional paths (/careers), as for a site without a careers link.
    routes.clear();
    routes.set('/delta/', async () => '<html><body><h1>Delta</h1></body></html>');
    routes.set('/careers', async () => (await t.fixture('careers', 'delta-careers-listing.html')).toString());
    routes.set('/careers/senior-data-engineer-remote-uk', async () =>
      (await t.fixture('careers', 'delta-job-detail.html')).toString(),
    );
    const delta = await company('Delta Analytics Ltd', 'delta');
    const first = await discover(delta._id);
    expect(first.outcome).toBe('registered');
    const source = await t.market.sources.get(first.sourceId!);
    expect(source).toMatchObject({
      provider: 'careers_page',
      companyId: delta._id,
      endpoint: { url: `${server.url}/careers` },
      acquisition: { workflowKey: 'market.careers_page.crawl' },
      schedule: { intervalMinutes: 24 * 60 },
      governance: { accessMethod: 'public_web' },
    });
    // Discovery again: the same source, no second registration.
    const again = await discover(delta._id);
    expect(again).toEqual({ outcome: 'existing', sourceId: first.sourceId });
    expect(await t.market.sources.col.countDocuments({ provider: 'careers_page' })).toBe(1);

    // The registered source crawls into a canonical job; a second identical crawl changes nothing.
    const crawl1 = await t.runSource(source._id, { startUrl: `${server.url}/careers` });
    expect(crawl1.state).toBe('COMPLETED');
    const jobs = await t.market.jobs.col.find({ 'sourceRefs.sourceId': source._id }).toArray();
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    const crawl2 = await t.runSource(source._id, { startUrl: `${server.url}/careers` });
    expect(crawl2.state).toBe('COMPLETED');
    expect(await t.market.jobs.col.countDocuments({ 'sourceRefs.sourceId': source._id })).toBe(jobs.length);
    expect((await t.market.sources.get(source._id)).health.status).toBe('healthy');
  });

  it('a careers link off the official hosts is never registered; it goes to review', async () => {
    routes.clear();
    routes.set(
      '/zeta/',
      async () => '<html><body><a href="https://jobs-portal.example/careers/zeta">Careers</a></body></html>',
    );
    const zeta = await company('Zeta Widgets Ltd', 'zeta');
    const out = await discover(zeta._id);
    expect(out).toEqual({ outcome: 'off_domain_review', sourceId: null });
    expect(await t.market.sources.col.countDocuments({ provider: 'careers_page', companyId: zeta._id })).toBe(
      0,
    );
    const review = await t.market.reviews.col.findOne({ type: 'careers_discovery', 'entity.id': zeta._id });
    expect(review?.subject).toMatch(/off the official site/);
    // Informational only: no decision registers the page, so `confirm` is not offered.
    expect(review?.allowedActions).toEqual(['dismiss']);
  });

  it('a company with an ATS board gets no careers_page source', async () => {
    routes.clear();
    routes.set('/acme/', async () => '<html><body><h1>Acme</h1></body></html>');
    routes.set('/careers', async () =>
      (await t.fixture('careers', 'acme-careers-greenhouse.html')).toString(),
    );
    const acme = await company('Acme Greenhouse Ltd', 'acme');
    const out = await discover(acme._id);
    expect(out.outcome).toBe('ats_found');
    expect(await t.market.sources.col.countDocuments({ provider: 'careers_page', companyId: acme._id })).toBe(
      0,
    );
  });
});
