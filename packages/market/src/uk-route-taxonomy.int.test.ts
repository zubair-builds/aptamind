import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestInfra, type TestInfra } from '@aptamind/testing';
import { sponsorRowToPayload, UK_SPONSOR_PARSER } from './sources/providers/uk-sponsor-register';
import { createMarketTestRuntime } from './test-harness';

/**
 * M8.4b never-delist: licences stored before the UK route taxonomy (Government Authorised
 * Exchange, Seasonal Worker, International Agreement) are dropped as capability evidence on the
 * next reconcile, never marked no_longer_listed, and a company whose only licence was such a
 * route is not "previously licensed". Its observations stay.
 */
let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;

beforeAll(async () => {
  infra = await createTestInfra('uk_route_taxonomy');
  t = await createMarketTestRuntime(infra);
});
afterAll(async () => {
  await t?.stop();
  await infra?.cleanup();
});

describe('UK route taxonomy (M8.4b)', () => {
  it('a route that became ignored never delists: licences dropped, not no_longer_listed', async () => {
    const { source } = await t.market.sources.register(
      {
        key: 'uk-sponsor-register-m84b',
        name: 'UK sponsor register (M8.4b fixture)',
        category: 'company_universe',
        provider: 'uk_home_office_sponsor_register',
        acquisition: { workflowKey: 'market.sponsor_register.import' },
        freshness: { policyClass: 'source.sponsor_register', maxAgeMinutes: 4320 },
        authority: { tier: 'official_registry', listingIsComplete: true },
        governance: { accessMethod: 'manual_upload' },
      },
      t.actor,
    );
    // Before M8.4b: the importer stored every route as a licence (simulate those observations).
    const old = await t.upload(
      source._id,
      [
        'Organisation Name,Town/City,County,Type & Rating,Route',
        'Gamma Health Limited,Leeds,West Yorkshire,Temporary Worker (A rating),Government Authorised Exchange',
        'Solo Exchange Ltd,York,North Yorkshire,Temporary Worker (A rating),Seasonal Worker',
      ].join('\n'),
      'text/csv',
    );
    const snap = await t.market.observations.getSnapshot(old.snapshotId);
    const rows = [
      {
        name: 'Gamma Health Limited',
        town: 'Leeds',
        county: 'West Yorkshire',
        typeRating: 'Temporary Worker (A rating)',
        route: 'Government Authorised Exchange',
      },
      {
        name: 'Solo Exchange Ltd',
        town: 'York',
        county: 'North Yorkshire',
        typeRating: 'Temporary Worker (A rating)',
        route: 'Seasonal Worker',
      },
    ];
    for (const [i, row] of rows.entries()) {
      const m = sponsorRowToPayload(row)!;
      await t.market.companyPipeline.process({
        sourceId: source._id,
        snapshotId: snap._id,
        artifactId: snap.artifact.artifactId,
        locator: `row:${i + 2}`,
        externalId: m.externalId,
        payload: m.payload,
        parser: UK_SPONSOR_PARSER,
      });
    }
    const solo0 = await t.market.companies.col.findOne({ 'identity.normalizedName': 'solo exchange ltd' });
    expect(solo0).not.toBeNull();

    // A later complete import (the fixture lists Gamma's Skilled Worker and GAE rows; no Solo).
    const snap2 = await t.upload(source._id, await t.fixture('uk-sponsor', 'register-t1.csv'), 'text/csv');
    const run = await t.runSource(source._id, { snapshotId: snap2.snapshotId });
    expect(run.state).toBe('COMPLETED');
    expect(run.output).toMatchObject({ complete: true, anomaly: null });

    const gamma = await t.market.companies.col.findOne({ 'identity.normalizedName': /^gamma health/ });
    const gl = gamma!.employment.sponsorship.licences;
    expect(gl.map((l) => l.route)).not.toContain('Government Authorised Exchange');
    expect(gl.every((l) => l.status === 'listed')).toBe(true);
    expect(gamma!.employment.sponsorship.capability.value).toBe('licensed');

    const solo = await t.market.companies.resolveActive(solo0!._id);
    expect(solo.employment.sponsorship.licences).toEqual([]);
    expect(solo.employment.sponsorship.capability.value).not.toBe('previously_licensed');
    expect(solo.employment.sponsorship.licenceCountries).toEqual([]);
    // History is kept: the old observations still exist.
    expect(
      await t.market.observations.companyObservations.countDocuments({
        sourceId: source._id,
        'payload.sponsorLicence.route': 'Seasonal Worker',
      }),
    ).toBe(1);
  });
});
