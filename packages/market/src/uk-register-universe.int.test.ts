import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestInfra, startFixtureServer, type TestInfra } from '@aptamind/testing';
import { createMarketTestRuntime } from './test-harness';

/**
 * Owner decision 2026-10-31 (wave 7): the UK sponsor register matches the KNOWN company universe
 * first. Unrestricted, the 2026-10-30 publication would have created ~142,000 companies. A
 * sponsor that matches no known company creates nothing and records no observation; a match
 * attaches its licence; an ambiguous match reaches an attach-only review (no create_new).
 */

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  infra = await createTestInfra('market-uk-universe');
  t = await createMarketTestRuntime(infra);
  server = await startFixtureServer(async (req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (url === '/register') {
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(await t.fixture('uk-sponsor', 'publication-page.html'));
      return;
    }
    if (url === '/media/fixture/2026-09-27_-_Worker_and_Temporary_Worker.csv') {
      res
        .writeHead(200, { 'content-type': 'text/csv' })
        .end(await t.fixture('uk-sponsor', 'register-t1.csv'));
      return;
    }
    res.writeHead(404).end();
  });
});

afterAll(async () => {
  await t?.stop();
  await server?.close();
  await infra?.cleanup();
});

describe('UK register attaches to the known company universe only (owner 2026-10-31)', () => {
  it('attaches licences to known companies and creates none for unmatched sponsors', async () => {
    await t.seedUniverse(['Acme Ltd', { name: 'Zenith Robotics Ltd', city: 'Cambridge' }]);
    const before = await t.market.companies.col.countDocuments({});
    const { source } = await t.market.sources.register(
      {
        key: 'uk-sponsor-register',
        name: 'UK sponsor register (fixture server)',
        category: 'company_universe',
        provider: 'uk_home_office_sponsor_register',
        endpoint: { url: `${server.url}/register` },
        acquisition: { workflowKey: 'market.uk_sponsor_register.import' },
        freshness: { policyClass: 'source.sponsor_register', maxAgeMinutes: 4320 },
        authority: { tier: 'official_registry', listingIsComplete: true },
        governance: { accessMethod: 'public_download' },
      },
      t.actor,
    );
    const run = await t.runSource(source._id);
    expect(run.state).toBe('COMPLETED');
    expect(run.output).toMatchObject({ complete: true, anomaly: null });

    // No company was created by the register.
    expect(await t.market.companies.col.countDocuments({})).toBe(before);
    expect(
      await t.market.companies.col.findOne({ 'identity.normalizedName': 'northwind freight ltd' }),
    ).toBeNull();

    // The known company carries its licences.
    const acme = await t.market.companies.col.findOne({ 'identity.normalizedName': 'acme ltd' });
    expect(acme?.employment.sponsorship.capability.value).toBe('licensed');
    expect(acme?.employment.sponsorship.licences.map((l) => l.route).sort()).toEqual([
      'Global Business Mobility: Senior or Specialist Worker',
      'Scale-up',
      'Skilled Worker',
    ]);

    // Unmatched sponsors leave no observation (the raw snapshot keeps them).
    const obs = await t.market.observations.companyObservations.find({ sourceId: source._id }).toArray();
    expect(obs.some((o) => o.payload.name === 'Northwind Freight Ltd')).toBe(false);
    expect(obs.every((o) => o.resolution.state === 'resolved' || o.resolution.state === 'review')).toBe(true);

    // Any review from the register is attach-only: never create_new.
    const reviews = await t.market.reviews.col
      .find({ type: 'company_resolution', 'evidence.sourceId': source._id })
      .toArray();
    for (const r of reviews) expect(r.allowedActions).not.toContain('create_new');
  });

  it('an unchanged file is skipped until an operator forces a re-check; then later-known sponsors attach', async () => {
    const source = (await t.market.sources.getByKey('uk-sponsor-register'))!;
    // Northwind becomes known after the import that skipped it.
    await t.seedUniverse(['Northwind Freight Ltd']);
    const northwind = () =>
      t.market.companies.col.findOne({ 'identity.normalizedName': 'northwind freight ltd' });

    const skipped = await t.runSource(source._id);
    expect(skipped.state).toBe('COMPLETED');
    expect(skipped.output).toMatchObject({
      complete: true,
      unchanged: true,
      delistedCompanies: 0,
      reconciled: 0,
    });
    expect((await northwind())?.employment.sponsorship.capability.value).not.toBe('licensed');

    const forced = await t.runSource(source._id, { force: true });
    expect(forced.state).toBe('COMPLETED');
    expect(forced.output).toMatchObject({ complete: true, anomaly: null, unchanged: false });
    expect((await northwind())?.employment.sponsorship.capability.value).toBe('licensed');
  });
});
