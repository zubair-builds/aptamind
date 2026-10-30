import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestInfra, startFixtureServer, type TestInfra } from '@aptamind/testing';
import { createMarketTestRuntime } from './test-harness';

/**
 * M8.4 — the IND (Netherlands) public register of recognised sponsors through the generic
 * register import (`market.sponsor_register.import`, adapter `nl_ind_recognised_sponsors`) against
 * real MongoDB/Redis/S3. The register pages are served from committed synthetic, format-faithful
 * fixtures by a local HTTP server (fetched through the SSRF-safe client); the operator-upload
 * path uploads a fixture as a snapshot. Nothing here reaches the network.
 */

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let page: () => Promise<Buffer | string>;

const LABOUR_PATH =
  '/en/public-register-recognised-sponsors/public-register-regular-labour-and-highly-skilled-migrants';

const REAL_PATH = '/en/public-register-recognised-sponsors/public-register-work';

beforeAll(async () => {
  infra = await createTestInfra('market_nl_register');
  t = await createMarketTestRuntime(infra);
  page = () => t.fixture('nl-ind', 'register-labour-t1.html');
  server = await startFixtureServer(async (req, res) => {
    if ((req.url ?? '').split('?')[0] === REAL_PATH) {
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(await t.fixture('nl-ind', 'real-register-work-2026-10.html'));
      return;
    }
    if ((req.url ?? '').split('?')[0] !== LABOUR_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await page());
  });
});

afterAll(async () => {
  await t?.stop();
  await server?.close();
  await infra?.cleanup();
});

async function register(key: string, url?: string) {
  const { source } = await t.market.sources.register(
    {
      key,
      name: `IND recognised sponsors (${key}, fixture)`,
      category: 'company_universe',
      provider: 'nl_ind_recognised_sponsors',
      ...(url ? { endpoint: { url } } : {}),
      acquisition: { workflowKey: 'market.sponsor_register.import' },
      freshness: { policyClass: 'source.sponsor_register', maxAgeMinutes: 4320 },
      authority: { tier: 'official_registry', listingIsComplete: true },
      governance: { accessMethod: url ? 'public_web' : 'manual_upload' },
    },
    t.actor,
  );
  return source;
}

const company = (kvk: string) => t.market.companies.col.findOne({ identityKeys: `ext:nl_kvk:${kvk}` });
const byName = (name: string) => t.market.companies.col.findOne({ 'identity.displayName.value': name });
const parseOutput = async (runId: string) =>
  (await t.runtime.engine.nodeRuns.findOne({ runId, nodeId: 'parse' }))?.output as Record<string, unknown>;

describe('NL IND register (M8.4)', () => {
  it('imports the labour register: NL licences with provenance, KvK identity, name fallback', async () => {
    const source = await register('nl-ind-labour', `${server.url}${LABOUR_PATH}`);
    const run = await t.runSource(source._id);
    expect(run.state).toBe('COMPLETED');
    expect(run.output).toMatchObject({ complete: true, anomaly: null, delistedCompanies: 0 });
    expect(await parseOutput(run._id)).toMatchObject({
      register: 'nl_ind_recognised_sponsors',
      format: 'html_table',
      count: 8,
      routes: [
        {
          route: 'Regular labour and highly skilled migrants',
          id: 'regular_labour_highly_skilled',
          meaning: 'labour',
          rows: 8,
        },
      ],
      unlistedRoutes: [],
    });
    expect(await t.market.companies.col.countDocuments({ status: 'active' })).toBe(8);

    const voorbeeld = (await company('99000011'))!;
    expect(voorbeeld.identity.displayName.value).toBe('Voorbeeld Tech B.V.');
    expect(voorbeeld.identity.externalIds).toEqual([{ namespace: 'nl_kvk', id: '99000011' }]);
    expect(voorbeeld.employment.sponsorship.licenceCountries).toEqual(['NL']);
    expect(voorbeeld.employment.sponsorship.licences).toMatchObject([
      {
        register: 'nl_ind_recognised_sponsors',
        country: 'NL',
        route: 'Regular labour and highly skilled migrants',
        typeRating: null,
        status: 'listed',
      },
    ]);
    expect(voorbeeld.employment.sponsorship.capability).toMatchObject({
      value: 'licensed',
      status: 'known',
      confidence: { level: 'high' },
    });
    const ev = voorbeeld.employment.sponsorship.capability.evidence[0];
    expect(ev).toMatchObject({
      sourceId: source._id,
      authority: 'official_registry',
      locator: 'table:1/row:1#sponsorLicence',
      extractor: { name: 'nl-ind-register-row', version: '1' },
    });
    expect(ev?.observationId).toMatch(/^cobs_/);
    expect(ev?.snapshotId).toMatch(/^snap_/);
    expect(ev?.artifactId).toMatch(/^art_/);

    // KvK with a space is normalised; no KvK and the all-zero placeholder fall back to the name rules.
    expect((await company('99000044'))?.identity.displayName.value).toBe('Dijkstra & Zonen Logistiek B.V.');
    for (const name of ['Grachtengordel Data B.V.', 'Polderlicht Energy B.V.']) {
      const c = (await byName(name))!;
      expect(c.identity.externalIds).toEqual([]);
      expect(c.identityKeys.some((k) => k.startsWith('ext:'))).toBe(false);
      expect(c.employment.sponsorship.licenceCountries).toEqual(['NL']);
    }
  });

  it('re-importing the identical register changes nothing', async () => {
    const source = (await t.market.sources.getByKey('nl-ind-labour'))!;
    const snapshot = async () => ({
      companies: (await t.market.companies.col.find({}).sort({ _id: 1 }).toArray()).map((c) => ({
        id: c._id,
        rev: c.rev,
        hash: c.reconciliation?.contentHash,
        licences: c.employment.sponsorship.licences,
        keys: c.identityKeys,
      })),
      observations: await t.market.observations.companyObservations.countDocuments({}),
      reviews: await t.market.reviews.col.countDocuments({}),
      snapshots: await t.market.observations.snapshots.countDocuments({ sourceId: source._id }),
    });
    const before = await snapshot();
    const run = await t.runSource(source._id);
    expect(run.state).toBe('COMPLETED');
    expect(run.output).toMatchObject({ complete: true, delistedCompanies: 0 });
    expect(await snapshot()).toEqual(before);
  });

  it('delisting: a sponsor missing from a later complete register is no longer listed, with its history kept; a renamed sponsor keeps its KvK identity', async () => {
    const source = (await t.market.sources.getByKey('nl-ind-labour'))!;
    const molenwerkBefore = (await company('99000022'))!;
    page = () => t.fixture('nl-ind', 'register-labour-t2.html');
    const run = await t.runSource(source._id);
    // `delistedCompanies` counts the companies re-reconciled because one of their observations was
    // not seen again: Molenwerk (delisted) and Voorbeeld (renamed: its old-name observation is
    // superseded, its licence stays listed).
    expect(run.output).toMatchObject({ complete: true, anomaly: null, delistedCompanies: 2 });

    const molenwerk = (await company('99000022'))!;
    expect(molenwerk._id).toBe(molenwerkBefore._id);
    expect(molenwerk.employment.sponsorship.capability.value).toBe('previously_licensed');
    expect(molenwerk.employment.sponsorship.licenceCountries).toEqual([]);
    const [licence] = molenwerk.employment.sponsorship.licences;
    expect(licence).toMatchObject({ status: 'no_longer_listed', country: 'NL' });
    // History is kept: the licence, its first sighting, its evidence and the observation.
    expect(licence?.firstSeenAt).toEqual(molenwerkBefore.employment.sponsorship.licences[0]?.firstSeenAt);
    expect(licence?.evidence.length).toBeGreaterThan(0);
    expect(
      await t.market.observations.companyObservations.countDocuments({
        sourceId: source._id,
        externalId: 'kvk:99000022|regular_labour_highly_skilled',
      }),
    ).toBe(1);

    // Same KvK, new name: the same company (identity by KvK), the old name kept as an alias.
    const voorbeeld = await t.market.companies.col
      .find({ identityKeys: 'ext:nl_kvk:99000011', status: 'active' })
      .toArray();
    expect(voorbeeld).toHaveLength(1);
    expect(voorbeeld[0]?.employment.sponsorship.licences[0]?.status).toBe('listed');
    expect(voorbeeld[0]?.identity.aliases.map((a) => a.name)).toContain('Voorbeeld Tech B.V.');
    const versions = await t.market.observations.companyObservations
      .find({ sourceId: source._id, externalId: 'kvk:99000011|regular_labour_highly_skilled' })
      .toArray();
    expect(versions.map((o) => [o.payload.name, o.superseded === true]).sort()).toEqual([
      ['Voorbeeld Tech B.V.', true],
      ['Voorbeeld Technology B.V.', false],
    ]);
    expect((await company('99000077'))?.employment.sponsorship.licenceCountries).toEqual(['NL']);
  });

  it('anomaly guard: a shrunken register is held back for review and delists nothing', async () => {
    const source = (await t.market.sources.getByKey('nl-ind-labour'))!;
    page = async () =>
      (await t.fixture('nl-ind', 'register-labour-t2.html'))
        .toString()
        .replace(/<tr><td>(?!Voorbeeld)[^\n]*<\/tr>\n/g, '');
    const run = await t.runSource(source._id);
    expect(run.state).toBe('COMPLETED');
    expect(run.output).toMatchObject({ complete: false, delistedCompanies: 0 });
    expect((run.output as { anomaly: string }).anomaly).toMatch(/shrank from 8 to 1 rows/);
    expect((await company('99000066'))?.employment.sponsorship.capability.value).toBe('licensed');
    expect((await company('99000077'))?.employment.sponsorship.licences[0]?.status).toBe('listed');
    expect(
      await t.market.reviews.col.countDocuments({
        type: 'source_anomaly',
        status: 'open',
        'entity.id': source._id,
      }),
    ).toBe(1);
  });

  it('operator upload of a page with every IND register: labour, research and Blue Card only; study, au pair, exchange and unrecognised registers are ignored', async () => {
    const source = await register('nl-ind-upload');
    const companiesBefore = await t.market.companies.col.countDocuments({});
    const snap = await t.upload(
      source._id,
      await t.fixture('nl-ind', 'register-all-purposes.html'),
      'text/plain',
    );
    const run = await t.runSource(source._id, { snapshotId: snap.snapshotId });
    expect(run.state).toBe('COMPLETED');
    const parsed = await parseOutput(run._id);
    expect(parsed).toMatchObject({
      count: 4,
      totalRows: 8,
      unlistedRoutes: ['Openbaar register pilot seizoensarbeid'],
    });
    expect(
      (parsed.routes as Array<{ id: string | null; meaning: string; rows: number }>)
        .map((r) => [r.id, r.meaning, r.rows])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['eu_blue_card', 'labour', 1],
      ['exchange', 'ignored', 1],
      [null, 'ignored', 1],
      ['regular_labour_highly_skilled', 'labour', 1],
      ['research', 'labour', 2],
      ['study', 'ignored', 2],
    ]);
    // Organisations listed only for study, au pair / exchange or an unrecognised register: no company.
    for (const kvk of ['99000099', '99000101', '99000112']) expect(await company(kvk)).toBeNull();
    // The university is on the research and the study register: research only.
    const uni = (await company('99000088'))!;
    expect(uni.employment.sponsorship.licences.map((l) => l.route)).toEqual([
      'Researchers (Directive (EU) 2016/801)',
    ]);
    // Existing sponsors resolve by KvK and gain the extra routes of the same register.
    expect((await company('99000055'))!.employment.sponsorship.licences.map((l) => l.route).sort()).toEqual([
      'EU Blue Card',
      'Regular labour and highly skilled migrants',
    ]);
    expect(await t.market.companies.col.countDocuments({})).toBe(companiesBefore + 1);
    for (const c of await t.market.companies.col.find({ status: 'active' }).toArray())
      for (const l of c.employment.sponsorship.licences) expect(l.country).toBe('NL');
  });

  it('the UK register adapter runs through the generic import with the M2 row mapping (same licences)', async () => {
    const { source } = await t.market.sources.register(
      {
        key: 'uk-sponsor-register-generic',
        name: 'UK sponsor register via the register adapter (fixture)',
        category: 'company_universe',
        provider: 'uk_home_office_sponsor_register',
        acquisition: { workflowKey: 'market.sponsor_register.import' },
        freshness: { policyClass: 'source.sponsor_register', maxAgeMinutes: 4320 },
        authority: { tier: 'official_registry', listingIsComplete: true },
        governance: { accessMethod: 'manual_upload' },
      },
      t.actor,
    );
    const snap = await t.upload(source._id, await t.fixture('uk-sponsor', 'register-t1.csv'), 'text/csv');
    const run = await t.runSource(source._id, { snapshotId: snap.snapshotId });
    expect(run.state).toBe('COMPLETED');
    expect(run.output).toMatchObject({ complete: true, anomaly: null });
    expect(await parseOutput(run._id)).toMatchObject({
      register: 'uk_home_office_licensed_sponsors_workers',
      count: 23,
    });
    expect(await t.market.observations.companyObservations.countDocuments({ sourceId: source._id })).toBe(23);
    const acme = await t.market.companies.col.findOne({ 'identity.normalizedName': 'acme ltd' });
    expect(acme?.employment.sponsorship.licences.map((l) => [l.route, l.country]).sort()).toEqual([
      ['Global Business Mobility: Senior or Specialist Worker', 'GB'],
      ['Scale-up', 'GB'],
      ['Skilled Worker', 'GB'],
    ]);
    expect(acme?.identityKeys).toContain('ext:uk_sponsor_register:acme ltd|london');
  });
});

describe('NL IND real-file gate (2026-10, scratch database)', () => {
  it('imports the trimmed live page: 25 labour licences, KvK identity, nothing unlisted', async () => {
    const source = await register('nl-ind-real-gate', `${server.url}${REAL_PATH}`);
    const run = await t.runSource(source._id);
    expect(run.state).toBe('COMPLETED');
    expect(run.output).toMatchObject({ complete: true, anomaly: null, delistedCompanies: 0 });
    expect(await parseOutput(run._id)).toMatchObject({
      format: 'html_table',
      count: 25,
      routes: [{ id: 'regular_labour_highly_skilled', meaning: 'labour', rows: 25 }],
    });
    expect(await company('02076358')).not.toBeNull();
  });
});
