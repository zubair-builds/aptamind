import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestInfra, startFixtureServer, type TestInfra } from '@aptamind/testing';
import type { CompanyObservationPayload } from './contracts/observations';
import { interpretJob } from './enrichment/interpret';
import type { JobObservationDoc } from './observations/schemas';
import { interpretationInput } from './reconciliation/interpretation-input';
import { createMarketTestRuntime } from './test-harness';

/**
 * M11.5 — USCIS H-1B Employer Data Hub through the generic register import (adapter
 * `us_uscis_h1b_employer_data_hub`, evidence tier `history`) against real MongoDB/Redis/S3. The
 * fiscal-year files are committed synthetic, format-faithful fixtures, fetched from a local server
 * through the SSRF-safe client or uploaded as an operator snapshot. The register never creates a
 * company: rows attach to seeded companies on a high-confidence match or go to review.
 */

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const FILE = '/sites/default/files/document/data/h1b_datahubexport-2023.csv';
const ids: Record<string, string> = {};
let directoryId = '';

beforeAll(async () => {
  infra = await createTestInfra('market_h1b_history');
  t = await createMarketTestRuntime(infra);
  server = await startFixtureServer(async (req, res) => {
    if ((req.url ?? '').split('?')[0] !== FILE) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res
      .writeHead(200, { 'content-type': 'text/csv' })
      .end(await t.fixture('us-h1b', 'h1b-datahub-fy2023-legacy.csv'));
  });
  // The company universe the history attaches to (a directory-like source, official site authority).
  const { source } = await t.market.sources.register(
    {
      key: 'test:directory',
      name: 'Test directory (fixture)',
      category: 'manual_import',
      provider: 'fixture',
      acquisition: { workflowKey: 'market.noop' },
      freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 525_600 },
      authority: { tier: 'official_site' },
      governance: { accessMethod: 'manual_upload' },
    },
    t.actor,
  );
  directoryId = source._id;
  const seed = async (key: string, payload: Partial<CompanyObservationPayload> & { name: string }) => {
    const r = await t.market.companyPipeline.process({
      sourceId: source._id,
      externalId: key,
      payload: { aliases: [], externalIds: [], locations: [], industries: [], ...payload },
      parser: { name: 'test', version: '1' },
    });
    if (!('companyId' in r)) throw new Error(`seed ${key}: ${r.outcome}`);
    ids[key] = r.companyId;
  };
  await seed('acme', {
    name: 'Acme Analytics Inc',
    locations: [{ city: 'San Francisco', region: 'CA', country: 'US', kind: 'hq' }],
  });
  await seed('helix', {
    name: 'Helix Biotech PLC',
    locations: [{ city: 'Oxford', country: 'GB', kind: 'hq' }],
  });
  await seed('orion', { name: 'Orion Software Solutions Ltd' });
  await seed('northwind', {
    name: 'Northwind Freight Ltd',
    locations: [{ city: 'Houston', region: 'Texas', country: 'US', kind: 'office' }],
  });
});

afterAll(async () => {
  await t?.stop();
  await server?.close();
  await infra?.cleanup();
});

async function h1bSource(url?: string) {
  const { source } = await t.market.sources.register(
    {
      key: url ? 'us-h1b-datahub' : 'us-h1b-datahub-upload',
      name: 'USCIS H-1B Employer Data Hub (fixture)',
      category: 'signal_source',
      provider: 'us_uscis_h1b_employer_data_hub',
      ...(url ? { endpoint: { url } } : {}),
      acquisition: { workflowKey: 'market.sponsor_register.import' },
      freshness: { policyClass: 'source.sponsor_register', maxAgeMinutes: 525_600 },
      authority: { tier: 'official_registry', listingIsComplete: true },
      governance: { accessMethod: url ? 'public_download' : 'manual_upload' },
    },
    t.actor,
  );
  return source;
}

const company = (key: string) => t.market.companies.col.findOne({ _id: ids[key]! });
const state = async () => ({
  companies: (await t.market.companies.col.find({}).sort({ _id: 1 }).toArray()).map((c) => ({
    id: c._id,
    rev: c.rev,
    hash: c.reconciliation?.contentHash,
    sponsorship: c.employment.sponsorship,
    keys: c.identityKeys,
  })),
  observations: await t.market.observations.companyObservations.countDocuments({}),
  reviews: await t.market.reviews.col.find({}).sort({ _id: 1 }).toArray(),
});
const interpret = (c: NonNullable<Awaited<ReturnType<typeof company>>>, location: string) =>
  interpretJob(
    interpretationInput(
      {
        payload: {
          externalId: '1',
          title: 'Data Engineer',
          locations: [{ text: location }],
          descriptionText: 'Build our data platform.',
          provider: { name: 'greenhouse', boardToken: 'acme' },
        },
      } as unknown as JobObservationDoc,
      c,
    ),
  ).sponsorship;

describe('US H-1B Employer Data Hub (M11.5)', () => {
  it('attaches FY history to existing companies on a high-confidence match only; never creates a company', async () => {
    const companiesBefore = await t.market.companies.col.countDocuments({});
    const source = await h1bSource(`${server.url}${FILE}`);
    const run = await t.runSource(source._id);
    expect(run.state).toBe('COMPLETED');
    expect(run.output).toMatchObject({ complete: true, anomaly: null, delistedCompanies: 0 });
    const parse = (await t.runtime.engine.nodeRuns.findOne({ runId: run._id, nodeId: 'parse' }))?.output;
    expect(parse).toMatchObject({ count: 7, totalRows: 10, skippedRows: 3 });

    // Never creates companies.
    expect(await t.market.companies.col.countDocuments({})).toBe(companiesBefore);
    expect(
      await t.market.companies.col.findOne({ 'identity.normalizedName': 'unknown widgets llc' }),
    ).toBeNull();

    // Acme (exact own name + CA location): the two CA rows of FY2023 summed; the NY row is not.
    const acme = (await company('acme'))!;
    expect(acme.employment.sponsorship.history).toMatchObject([
      {
        register: 'us_uscis_h1b_employer_data_hub',
        country: 'US',
        route: 'H-1B',
        fiscalYear: 2023,
        initialApprovals: 15,
        initialDenials: 1,
        continuingApprovals: 34,
        continuingDenials: 2,
        rows: 2,
      },
    ]);
    expect(acme.employment.sponsorship.history[0]?.evidence[0]).toMatchObject({
      sourceId: source._id,
      authority: 'official_registry',
      extractor: { name: 'us-h1b-datahub-row', version: '1' },
    });
    expect(acme.employment.sponsorship.historyCountries).toEqual(['US']);
    // History is not capability and contributes no identity facts.
    expect(acme.employment.sponsorship.capability.status).toBe('unknown');
    expect(acme.employment.sponsorship.licenceCountries).toEqual([]);
    expect(acme.identity.displayName.value).toBe('Acme Analytics Inc');
    expect(acme.identity.legalName.value).not.toBe('ACME ANALYTICS INC');
    expect(acme.geography.headquarters.value).toMatchObject({ region: 'CA', country: 'US' });
    // The row key is not an identifier: never an identity key (DECISION_LOG "Sponsor register
    // adapters" (2)); history rows do not refresh the company's own freshness (4).
    expect(acme.identityKeys.some((k) => k.startsWith('ext:us_h1b_employer:'))).toBe(false);
    expect(acme.quality.observationCount).toBe(1);
    expect(acme.quality.sourceIds).toEqual([directoryId]);
    // No tax-id or ZIP digits in any stored record key.
    for (const o of await t.market.observations.companyObservations.find({ sourceId: source._id }).toArray())
      expect(o.externalId).toMatch(/^fy\d{4}\|[0-9a-f]{24}$/);

    // Northwind (office in "Texas"): attached; denials only, so no history country.
    const northwind = (await company('northwind'))!;
    expect(northwind.employment.sponsorship.history).toMatchObject([{ fiscalYear: 2023, initialDenials: 2 }]);
    expect(northwind.employment.sponsorship.historyCountries).toEqual([]);

    // Ambiguous: Acme in NY (state not known) and Helix (no US location) go to review — merge,
    // reject or dismiss only, never create_new.
    const reviews = await t.market.reviews.col.find({ type: 'company_resolution', status: 'open' }).toArray();
    expect(reviews.map((r) => r.subject).sort()).toEqual([
      'Attach H-1B history of "ACME ANALYTICS INC" (NY) to a company?',
      'Attach H-1B history of "HELIX BIOTECH PLC" (MA) to a company?',
    ]);
    for (const r of reviews) {
      expect(r.allowedActions).toEqual(['merge', 'reject', 'dismiss']);
      expect(r.severity).toBe('medium');
    }
    expect((await company('helix'))!.employment.sponsorship.history).toEqual([]);
    // Unmatched rows (no company, or only a legal-form variant) leave no observation and no review.
    expect(
      await t.market.observations.companyObservations.countDocuments({
        sourceId: source._id,
        'payload.name': { $in: ['UNKNOWN WIDGETS LLC', 'ORION SOFTWARE'] },
      }),
    ).toBe(0);
    expect((await company('orion'))!.employment.sponsorship.history).toEqual([]);
    expect(await t.market.observations.companyObservations.countDocuments({ sourceId: source._id })).toBe(5);

    // The company axis of a job: US role historical_evidence (never company_capable, never a
    // role yes); a London role unclear.
    expect(interpret(acme, 'San Francisco, CA').value).toMatchObject({
      status: 'historical_evidence',
      roleStatement: 'none',
      companyCapability: 'historical',
      capabilityCountries: ['US'],
    });
    expect(interpret(acme, 'London, United Kingdom').value.status).toBe('unclear');
  });

  it('re-importing the identical fiscal-year file changes nothing', async () => {
    const source = (await t.market.sources.getByKey('us-h1b-datahub'))!;
    const before = await state();
    const run = await t.runSource(source._id);
    expect(run.state).toBe('COMPLETED');
    expect(await state()).toEqual(before);
  });

  it('a later fiscal year (operator upload, UTF-16 TSV) adds history (exact name + state), keeps earlier years, and is not a shrink of another year', async () => {
    const source = await h1bSource();
    const first = await t.upload(
      source._id,
      await t.fixture('us-h1b', 'h1b-datahub-fy2023-legacy.csv'),
      'text/csv',
    );
    expect((await t.runSource(source._id, { snapshotId: first.snapshotId })).output).toMatchObject({
      complete: true,
    });
    const snap = await t.upload(
      source._id,
      await t.fixture('us-h1b', 'h1b-datahub-fy2024-employer-information.csv'),
      'application/octet-stream',
    );
    const run = await t.runSource(source._id, { snapshotId: snap.snapshotId });
    expect(run.state).toBe('COMPLETED');
    // 7 → 3 rows: a history import only adds evidence, so there is no shrink anomaly.
    expect(run.output).toMatchObject({ complete: true, anomaly: null, delistedCompanies: 0 });
    const acme = (await company('acme'))!;
    const fy = acme.employment.sponsorship.history.map((h) => [h.fiscalYear, h.initialApprovals, h.rows]);
    // FY2023 rows count once although two sources carry them; FY2024 from the upload.
    expect(fy).toEqual([
      [2023, 15, 2],
      [2024, 10, 1],
    ]);
    const helixReview = await t.market.reviews.col.findOne({
      type: 'company_resolution',
      status: 'open',
      subject: { $regex: 'HELIX' },
    });
    // One review item per employer and state across fiscal years and sources.
    expect(helixReview?.observationIds.length).toBe(3);
    expect(await t.market.reviews.col.countDocuments({ type: 'source_anomaly' })).toBe(0);
  });

  it('an operator merge attaches the reviewed history; create_new is refused', async () => {
    const item = (await t.market.reviews.col.findOne({
      type: 'company_resolution',
      status: 'open',
      subject: { $regex: 'HELIX' },
    }))!;
    await expect(
      t.market.reviewService.resolve(item._id, { action: 'create_new', reason: 'new company' }, t.actor),
    ).rejects.toThrow(/not allowed/);
    await t.market.reviewService.resolve(
      item._id,
      { action: 'merge', reason: 'same company (Boston office)', targetId: ids.helix! },
      t.actor,
    );
    const helix = (await company('helix'))!;
    expect(helix.employment.sponsorship.history.map((h) => [h.fiscalYear, h.rows])).toEqual([
      [2023, 1],
      [2024, 1],
    ]);
    expect(helix.employment.sponsorship.historyCountries).toEqual(['US']);
    expect(helix.employment.sponsorship.licenceCountries).toEqual([]);
    expect(helix.identity.displayName.value).toBe('Helix Biotech PLC');
    expect(helix.identityKeys.some((k) => k.startsWith('ext:us_h1b_employer:'))).toBe(false);
    expect(
      await t.market.companies.col.countDocuments({ 'identity.normalizedName': 'helix biotech plc' }),
    ).toBe(1);
  });

  const CSV_HEAD =
    'Fiscal Year,Employer,Initial Approval,Initial Denial,Continuing Approval,Continuing Denial,NAICS,Tax ID,State,City,ZIP';
  const others = [
    '2021,OTHER ONE LLC,1,0,0,0,54,1111,WA,SEATTLE,98101',
    '2021,OTHER TWO LLC,1,0,0,0,54,2222,WA,SEATTLE,98101',
    '2021,OTHER THREE LLC,1,0,0,0,54,3333,WA,SEATTLE,98101',
  ];
  const fy2021 = (acmeRow: string, rest = others) => [CSV_HEAD, acmeRow, ...rest].join('\n') + '\n';
  const snapshots: string[] = [];
  const importCsv = async (sourceId: string, csv: string) => {
    const snap = await t.upload(sourceId, csv, 'text/csv');
    snapshots.push(snap.snapshotId);
    return t.runSource(sourceId, { snapshotId: snap.snapshotId });
  };
  const markerOf = async (sourceId: string, period: number) =>
    (await t.market.sources.get(sourceId)).health.historyPeriods?.find((p) => p.period === period);
  const fy = async (year: number) =>
    (await company('acme'))!.employment.sponsorship.history.find((h) => h.fiscalYear === year);

  it("a corrected fiscal-year file replaces the source's earlier rows of that year; a shrunken year is held back", async () => {
    const { source } = await t.market.sources.register(
      {
        key: 'us-h1b-corrections',
        name: 'H-1B corrections (fixture)',
        category: 'signal_source',
        provider: 'us_uscis_h1b_employer_data_hub',
        acquisition: { workflowKey: 'market.sponsor_register.import' },
        freshness: { policyClass: 'source.sponsor_register', maxAgeMinutes: 525_600 },
        authority: { tier: 'official_registry', listingIsComplete: true },
        governance: { accessMethod: 'manual_upload' },
      },
      t.actor,
    );
    expect(
      (await importCsv(source._id, fy2021('2021,ACME ANALYTICS INC,10,0,0,0,54,1234,CA,SAN FRANCISCO,94105')))
        .output,
    ).toMatchObject({ complete: true });
    expect(await fy(2021)).toMatchObject({ initialApprovals: 10, rows: 1 });
    // The correction moves ACME to a new ZIP: a new row key, and the old row is replaced (11, not 21).
    const corrected = await importCsv(
      source._id,
      fy2021('2021,ACME ANALYTICS INC,11,0,0,0,54,1234,CA,SAN FRANCISCO,94107'),
    );
    expect(corrected.output).toMatchObject({ complete: true, anomaly: null });
    expect(await fy(2021)).toMatchObject({ initialApprovals: 11, rows: 1 });
    const correctedMarker = await markerOf(source._id, 2021);
    expect(correctedMarker).toMatchObject({
      snapshotId: snapshots[1],
      rowCount: 4,
      parser: 'us-h1b-datahub-row/1',
    });
    // L1: reprocessing the OLDER snapshot afterwards changes neither the marker nor the rows.
    const older = await t.runSource(source._id, { snapshotId: snapshots[0] });
    expect(older.state).toBe('COMPLETED');
    expect(await markerOf(source._id, 2021)).toEqual(correctedMarker);
    expect(await fy(2021)).toMatchObject({ initialApprovals: 11, rows: 1 });
    // A shrunken FY2021 file (1 of 4 rows) is held back: nothing processed, nothing replaced.
    const shrunk = await importCsv(
      source._id,
      fy2021('2021,ACME ANALYTICS INC,50,0,0,0,54,1234,CA,SAN FRANCISCO,94108', []),
    );
    expect(shrunk.output).toMatchObject({ complete: false });
    expect((shrunk.output as { anomaly: string }).anomaly).toMatch(/FY2021 shrank from 4 to 1 rows/);
    expect(await fy(2021)).toMatchObject({ initialApprovals: 11, rows: 1 });
    const held = await t.market.reviews.col
      .find({ type: 'source_anomaly', 'entity.id': source._id, status: 'open' })
      .toArray();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ context: { period: 2021, count: 1, previousRows: 4 } });
    expect(held[0]?.allowedActions).toContain('confirm');
    // B-M2: a re-run alone keeps the year held back ...
    const again = await t.runSource(source._id, { snapshotId: snapshots.at(-1)! });
    expect(again.output).toMatchObject({ complete: false });
    expect(await fy(2021)).toMatchObject({ initialApprovals: 11 });
    // ... an operator's confirm of exactly this shrink lets the next run of the snapshot apply it.
    await t.market.reviewService.resolve(
      held[0]!._id,
      { action: 'confirm', reason: 'USCIS corrected FY2021' },
      t.actor,
    );
    const accepted = await t.runSource(source._id, { snapshotId: snapshots.at(-1)! });
    expect(accepted.output).toMatchObject({ complete: true, anomaly: null });
    expect(await fy(2021)).toMatchObject({ initialApprovals: 50, rows: 1 });
    expect(await markerOf(source._id, 2021)).toMatchObject({ snapshotId: snapshots.at(-1), rowCount: 1 });
  });

  it('overlapping imports: a period marker moved since the parse step read it applies nothing and says why (B-M1)', async () => {
    const source = (await t.market.sources.getByKey('us-h1b-corrections'))!;
    // Another import of FY2021 finishes between this import's parse and its finalisation.
    const cas = t.market.sources.casHistoryPeriod.bind(t.market.sources);
    t.market.sources.casHistoryPeriod = async (id, next, expected) => {
      await t.market.sources.col.updateOne(
        { _id: id, 'health.historyPeriods.period': next.period },
        {
          $set: {
            'health.historyPeriods.$.snapshotId': 'snap_concurrent',
            'health.historyPeriods.$.completeAt': new Date(),
          },
        },
      );
      return cas(id, next, expected);
    };
    try {
      const run = await importCsv(
        source._id,
        fy2021('2021,ACME ANALYTICS INC,60,0,0,0,54,1234,CA,SAN FRANCISCO,94109'),
      );
      expect(run.output).toMatchObject({ complete: false });
      expect((run.output as { anomaly: string }).anomaly).toMatch(/FY2021 marker moved during the import/);
    } finally {
      t.market.sources.casHistoryPeriod = cas;
    }
    expect((await markerOf(source._id, 2021))?.snapshotId).toBe('snap_concurrent');
    expect(
      await t.market.reviews.col.countDocuments({
        type: 'source_anomaly',
        'entity.id': source._id,
        status: 'open',
        subject: { $regex: 'marker moved' },
      }),
    ).toBe(1);
    // The period belongs to the import that moved the marker: once reconciled (its finalisation
    // does that), rows older than its marker — this import's included — no longer count.
    await t.market.companyReconciler.reconcile(ids.acme!);
    expect(await fy(2021)).toBeUndefined();
  });

  it('a row key is never proof: once a second same-name company is in the state, the next row is an attach-only review (no duplicate-identity review)', async () => {
    // A second, distinct "Acme Analytics Inc" with a California location.
    const twin = (await t.market.companies.createFromCandidate(
      { name: 'Acme Analytics Inc', country: 'US' },
      { nameQualifier: 'us-ca-twin' },
    ))!;
    const { observation } = await t.market.observations.recordCompanyObservation({
      sourceId: directoryId,
      externalId: 'acme-twin',
      payload: {
        name: 'Acme Analytics Inc',
        aliases: [],
        externalIds: [],
        locations: [{ city: 'Los Angeles', region: 'CA', country: 'US', kind: 'hq' }],
        industries: [],
      },
      parser: { name: 'test', version: '1' },
    });
    await t.market.observations.setCompanyResolution([observation._id], {
      state: 'resolved',
      entityId: twin._id,
      method: 'test',
      confidence: 'high',
      resolverVersion: 'test',
    });
    await t.market.companyReconciler.reconcile(twin._id);
    const source = (await t.market.sources.getByKey('us-h1b-corrections'))!;
    const run = await importCsv(
      source._id,
      [CSV_HEAD, '2022,ACME ANALYTICS INC,3,0,0,0,54,1234,CA,SAN FRANCISCO,94107'].join('\n') + '\n',
    );
    expect(run.state).toBe('COMPLETED');
    expect(await fy(2022)).toBeUndefined();
    expect((await t.market.companies.col.findOne({ _id: twin._id }))!.employment.sponsorship.history).toEqual(
      [],
    );
    const review = await t.market.reviews.col.findOne({
      type: 'company_resolution',
      status: 'open',
      subject: { $regex: '"ACME ANALYTICS INC" \\(CA\\)' },
    });
    expect(review).toMatchObject({ severity: 'high', allowedActions: ['merge', 'reject', 'dismiss'] });
    expect(await t.market.reviews.col.countDocuments({ type: 'company_duplicate' })).toBe(0);
  });
});
