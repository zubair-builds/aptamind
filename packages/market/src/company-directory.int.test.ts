/**
 * M8.1 — company directory CSV import (`market.company_directory.import`), end to end against
 * real MongoDB/Redis/S3: upload (checked before storage) → snapshot → observations with snapshot
 * provenance → resolution → reconciliation; row errors reported; idempotent re-import; a domain
 * disagreement between directories becomes a fact conflict, never an overwrite.
 */
import { createHash } from 'node:crypto';
import { Collection } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { artifactIdForHash } from '@aptamind/storage';
import { AppError } from '@aptamind/contracts';
import { createTestInfra, type TestInfra, waitForRun } from '@aptamind/testing';
import type { SourceDoc } from './sources/source.schema';
import { migrateCompanyNameKeysV2 } from './migrations';
import { conflictingIdNamespaces } from './reconciliation/company-reconciler';
import { resolveCompanyCandidate } from './resolution/company-resolver';
import { COMPANY_DIRECTORY_PARSER } from './sources/providers/company-directory';
import { createMarketTestRuntime } from './test-harness';
import { installOfflineHttp } from './test-offline-http';

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;

beforeAll(async () => {
  infra = await createTestInfra('company_directory');
  t = await createMarketTestRuntime(infra);
  // A company import queues careers discovery for its companies' domains: answered offline.
  installOfflineHttp(t.runtime);
});

afterAll(async () => {
  await t?.stop();
  await infra?.cleanup();
});

const COLUMNS = {
  name: 'Company',
  domain: 'Domain',
  country: 'Country',
  careersUrl: 'Careers',
  registerIds: { gb_companies_house: 'Company number' },
};
const HEADER = 'Company,Domain,Country,Careers,Company number';

async function directory(key: string, config: Record<string, unknown> = {}): Promise<SourceDoc> {
  return (
    await t.market.sources.register(
      {
        key: `directory:${key}`,
        name: `${key} directory`,
        category: 'company_universe',
        provider: 'company_directory',
        acquisition: {
          workflowKey: 'market.company_directory.import',
          config: { columns: COLUMNS, ...config },
        },
        freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 100000 },
        authority: { tier: 'third_party' },
        governance: { accessMethod: 'manual_upload' },
      },
      t.actor,
    )
  ).source;
}

async function importFile(source: SourceDoc, csv: string) {
  const upload = await t.upload(source._id, csv, 'text/csv');
  const run = await t.runSource(source._id, { snapshotId: upload.snapshotId });
  expect(run.state).toBe('COMPLETED');
  return upload;
}

/** The final import report of a snapshot (the one with outcomes), whether or not a review was raised. */
async function finalReport<T = Record<string, unknown>>(snapshotId: string): Promise<T> {
  const docs = await infra.db
    .collection<{ _id: string; mimeType: string; createdAt: Date }>('artifacts')
    .find({ mimeType: { $regex: '^application/json' } })
    .sort({ createdAt: -1 })
    .toArray();
  for (const d of docs) {
    const r = await infra.artifacts
      .readJson<Record<string, unknown>>({ artifactId: d._id })
      .catch(() => null);
    if (r && r.kind === 'company_directory_import_report' && r.snapshotId === snapshotId && 'outcomes' in r)
      return r as T;
  }
  throw new Error(`no final report for ${snapshotId}`);
}

/** Generated ids (`rev_01M3R7…`, ULIDs) are random text: a canary marker must not match inside one. */
const ID_PATTERN = /\b[a-z]+_[0-9a-z]{20,}\b/g;
const withoutIds = (text: string) => text.replace(ID_PATTERN, '');

const snapshotsOf = (sourceId: string) => t.market.observations.snapshots.countDocuments({ sourceId });
const observationsOf = (sourceId: string) =>
  t.market.observations.companyObservations.find({ sourceId }).toArray();

describe('M8.1 company directory import', () => {
  const FILE = [
    HEADER,
    'Kestrel Logistics Ltd,kestrel-logistics.co.uk,United Kingdom,https://kestrel-logistics.co.uk/careers,04821937',
    'Heron Analytics GmbH,heron-analytics.co.uk,DE,,',
    '"Plover Robotics Ltd",,GB,,',
    'Broken Domain Ltd,gmail.com,GB,,',
    'Short,row',
    'Kestrel Logistics Limited,kestrel-logistics.co.uk,GB,,04821937',
  ].join('\n');

  it('imports valid rows through snapshot → observation → canonical, with provenance, and reports every other row', async () => {
    const source = await directory('m8-main');
    const { snapshotId, artifactId } = await importFile(source, FILE);

    const observations = await observationsOf(source._id);
    // Broken Domain Ltd is kept without its refused Domain cell (re-verification #6: drop, not refuse).
    expect(observations).toHaveLength(4);
    expect(observations.find((o) => o.payload.name === 'Broken Domain Ltd')!.payload.domain).toBeNull();
    for (const o of observations) {
      expect(o).toMatchObject({ snapshotId, artifactId, parser: COMPANY_DIRECTORY_PARSER });
      expect(o.locator).toMatch(/^row:\d+$/);
      // Plover and Broken Domain have no register id and no domain: bare, so review (re-verification #4).
      expect(o.resolution.state).toBe(
        ['Plover Robotics Ltd', 'Broken Domain Ltd'].includes(o.payload.name) ? 'review' : 'resolved',
      );
    }
    const kestrel = observations.find((o) => o.externalId === 'gb_companies_house:04821937')!;
    expect(kestrel).toMatchObject({ locator: 'row:2' });
    const company = await t.market.companies.get(kestrel.resolution.entityId!);
    expect(company.identity.domain.value).toBe('kestrel-logistics.co.uk');
    expect(company.identity.domain.evidence[0]).toMatchObject({
      sourceId: source._id,
      observationId: kestrel._id,
      snapshotId,
      artifactId,
      locator: 'row:2#domain',
    });
    expect(company.identity.externalIds).toEqual([{ namespace: 'gb_companies_house', id: '04821937' }]);

    // Rows that were not imported are reported — never dropped: one review per snapshot, with
    // the full list in a report artifact.
    const review = await t.market.reviews.col.findOne({ type: 'parser_failure', 'entity.id': source._id });
    expect(review).toMatchObject({
      status: 'open',
      dedupeKey: `parser_failure:${source._id}:${snapshotId}`,
      context: expect.objectContaining({ rowCount: 6, rowErrors: 2, rowWarnings: 1, processingFailures: 0 }),
    });
    const report = await infra.artifacts.readJson<{
      errors: Array<{ line: number; code: string }>;
      rowWarnings: Array<{ line: number; code: string; column: string }>;
    }>({
      artifactId: String(review!.context.reportArtifactId),
    });
    expect(report.errors.map((e) => [e.line, e.code])).toEqual([
      [6, 'malformed_row'],
      [7, 'duplicate_row_key'],
    ]);
    expect(report.rowWarnings.map((w) => [w.line, w.code, w.column])).toEqual([
      [5, 'invalid_domain', 'Domain'],
    ]);
    expect((await t.market.sources.get(source._id)).health).toMatchObject({
      status: 'healthy',
      lastItemCount: 4,
    });
  });

  it('re-importing the same file is idempotent: same snapshot, no new observations, companies or reviews', async () => {
    const source = await directory('m8-idempotent');
    const first = await importFile(source, FILE);
    const before = {
      observations: (await observationsOf(source._id)).map((o) => o._id).sort(),
      companies: await t.market.companies.col.countDocuments({}),
      reviews: await t.market.reviews.col.countDocuments({ 'entity.id': source._id }),
      hashes: await Promise.all(
        (await observationsOf(source._id)).map(async (o) => {
          const c = await t.market.companies.get(o.resolution.entityId!);
          return [c._id, c.reconciliation?.contentHash];
        }),
      ),
    };
    const again = await importFile(source, FILE);
    expect(again).toMatchObject({ snapshotId: first.snapshotId, unchanged: true });
    expect(await snapshotsOf(source._id)).toBe(1);
    expect((await observationsOf(source._id)).map((o) => o._id).sort()).toEqual(before.observations);
    expect(await t.market.companies.col.countDocuments({})).toBe(before.companies);
    expect(await t.market.reviews.col.countDocuments({ 'entity.id': source._id })).toBe(before.reviews);
    for (const [id, hash] of before.hashes)
      expect((await t.market.companies.get(id!)).reconciliation?.contentHash).toBe(hash);
  });

  it('a domain disagreement between two directories becomes a fact conflict, never an overwrite', async () => {
    const a = await directory('m8-conflict-a');
    const b = await directory('m8-conflict-b');
    await importFile(a, `${HEADER}\nOsprey Freight Ltd,osprey-freight.co.uk,GB,,11223344\n`);
    const [oa] = await observationsOf(a._id);
    const companyId = oa!.resolution.entityId!;
    // Same register id, another domain: ambiguity goes to review; the canonical domain stays.
    await importFile(b, `${HEADER}\nOsprey Freight Ltd,osprey.co.uk,GB,,11223344\n`);
    const [ob] = await observationsOf(b._id);
    expect(ob!.resolution.state).toBe('review');
    expect((await t.market.companies.get(companyId)).identity.domain.value).toBe('osprey-freight.co.uk');
    // An operator confirms it is the same company: both domains are kept, as a conflict.
    const item = await t.market.reviews.col.findOne({ _id: ob!.resolution.reviewItemId });
    expect(item).toMatchObject({ type: 'company_resolution', status: 'open' });
    await t.market.reviewService.resolve(
      item!._id,
      { action: 'merge', reason: 'same register number', targetId: companyId },
      t.actor,
    );
    const merged = await t.market.companies.get(companyId);
    const domain = merged.identity.domain;
    // Neither value silently wins: the fact is conflicting, both values are kept with their evidence.
    expect(domain.value).not.toBe('osprey.co.uk');
    expect([...domain.evidence.map((e) => e.quote), ...domain.conflicts.map((c) => c.value)]).toEqual(
      expect.arrayContaining(['osprey-freight.co.uk', 'osprey.co.uk']),
    );
    expect(domain.status).toBe('conflicting');
    expect(merged.quality.conflictFields).toContain('identity.domain');
    expect(
      await t.market.reviews.col.findOne({
        dedupeKey: `field_conflict:company:${companyId}:domain`,
        status: 'open',
      }),
    ).toBeTruthy();
  });

  it.each([
    [
      'a personal-data column',
      `${HEADER},Contact email\nWren Ltd,wren.co.uk,GB,,,ceo@wren.example\n`,
      'validation_failed',
      {},
    ],
    ['an unmapped column', `${HEADER},Notes\nWren Ltd,wren.co.uk,GB,,,x\n`, 'validation_failed', {}],
    [
      'more rows than the source accepts',
      `${HEADER}\nWren Ltd,wren.co.uk,GB,,\nLark Ltd,lark.co.uk,GB,,\n`,
      'limit_exceeded',
      { maxRows: 1 },
    ],
    [
      'a file over the size limit',
      `${HEADER}\nWren Ltd,wren.co.uk,GB,,\n`,
      'limit_exceeded',
      { maxBytes: 20 },
    ],
  ])('refuses %s before anything is stored', async (label, csv, code, config) => {
    const source = await directory(`m8-refuse-${label.replace(/\W+/g, '-')}`, config);
    await expect(t.upload(source._id, csv, 'text/csv')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === code,
    );
    expect(await snapshotsOf(source._id)).toBe(0);
    expect(await t.market.audit.list({ entityKind: 'source', entityId: source._id })).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'source.snapshot_upload_refused' })]),
    );
  });

  it('a directory source is upload-only and its column map is validated on registration', async () => {
    await expect(
      t.market.sources.register(
        {
          key: 'directory:m8-url',
          name: 'fetched directory',
          category: 'company_universe',
          provider: 'company_directory',
          endpoint: { url: 'https://example.com/companies.csv' },
          acquisition: { workflowKey: 'market.company_directory.import', config: { columns: COLUMNS } },
          freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 100000 },
          authority: { tier: 'third_party' },
        },
        t.actor,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(directory('m8-bad-config', { columns: { domain: 'Domain' } })).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  const register = (key: string, over: Record<string, unknown> = {}) =>
    t.market.sources.register(
      {
        key: `directory:${key}`,
        name: `${key} directory`,
        category: 'company_universe',
        provider: 'company_directory',
        acquisition: { workflowKey: 'market.company_directory.import', config: { columns: COLUMNS } },
        freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 100000 },
        ...over,
      } as never,
      t.actor,
    );

  it('authority (ruling): third_party by default; operator, inferred and official_registry are refused', async () => {
    const { source } = await register('m8-authority-default');
    expect(source.authority.tier).toBe('third_party');
    for (const tier of ['operator', 'inferred', 'official_registry'])
      await expect(register(`m8-authority-${tier}`, { authority: { tier } })).rejects.toMatchObject({
        code: 'validation_failed',
      });
    const site = await register('m8-authority-site', { authority: { tier: 'official_site' } });
    expect(site.source.authority.tier).toBe('official_site');
  });

  it('the column map is strict and stored parsed; the workflow is pinned', async () => {
    await expect(
      register('m8-config-extra', {
        acquisition: {
          workflowKey: 'market.company_directory.import',
          config: { columns: COLUMNS, csvUrl: 'https://x.example/a.csv' },
        },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      register('m8-config-extra-column', {
        acquisition: {
          workflowKey: 'market.company_directory.import',
          config: { columns: { ...COLUMNS, url: 'Url' } },
        },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const { source } = await register('m8-config-parsed');
    expect(source.acquisition.config).toMatchObject({
      maxBytes: 10 * 1024 * 1024,
      maxRows: 50_000,
    });
    expect(source.acquisition.config).not.toHaveProperty('ignoreColumns');
    await expect(
      t.market.sources.update(
        source._id,
        { acquisition: { config: { columns: COLUMNS, url: 'https://x.example' } } },
        t.actor,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await t.market.sources.update(
      source._id,
      { acquisition: { config: { columns: COLUMNS, maxRows: 7 } } },
      t.actor,
    );
    expect((await t.market.sources.get(source._id)).acquisition.config).toMatchObject({
      maxRows: 7,
      maxBytes: 10 * 1024 * 1024,
    });
    // A mapped column that names personal data is refused at configuration time, and there is no
    // ignoreColumns any more (every column of a file is mapped): an unknown key.
    for (const config of [
      { columns: { ...COLUMNS, town: 'Director name' } },
      { columns: COLUMNS, ignoreColumns: ['Notes'] },
    ])
      await expect(
        register(`m8-config-personal-${Object.keys(config).length}`, {
          acquisition: { workflowKey: 'market.company_directory.import', config },
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('P2: a directory source cannot run a fetching workflow, and nothing fetches for it', async () => {
    // Registering with another workflow is refused.
    await expect(
      register('m8-p2', {
        acquisition: {
          workflowKey: 'market.uk_sponsor_register.import',
          config: { columns: COLUMNS },
        },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    // A legacy/tampered document with a fetching workflow and a URL: runs are refused (400) …
    const { source } = await register('m8-p2-legacy');
    await t.market.sources.col.updateOne(
      { _id: source._id },
      {
        $set: {
          'acquisition.workflowKey': 'market.uk_sponsor_register.import',
          endpoint: { url: 'https://people.co.uk/people.csv' },
        },
      },
    );
    await expect(t.market.sources.runNow(source._id, t.actor)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(
      t.market.sources.assertWorkflowRunAllowed('market.uk_sponsor_register.import', {
        sourceId: source._id,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    // … and even a run started directly on the engine never fetches (acquire_snapshot refuses).
    const run = await t.runtime.engine.startRun({
      workflowKey: 'market.uk_sponsor_register.import',
      input: { sourceId: source._id },
      labels: { sourceId: source._id },
      trigger: { kind: 'manual', actor: { kind: t.actor.kind, id: t.actor.id } },
    });
    const done = await waitForRun(t.runtime.engine, run._id, undefined, 60_000);
    expect(done.state).toBe('FAILED');
    expect(JSON.stringify(done)).toMatch(/upload-only/);
    expect(await snapshotsOf(source._id)).toBe(0);
  });

  it('a directory run needs an uploaded snapshot (400 without one)', async () => {
    const { source } = await register('m8-run-no-snapshot');
    await expect(t.market.sources.runNow(source._id, t.actor)).rejects.toMatchObject({
      code: 'validation_failed',
      details: { param: 'snapshotId' },
    });
  });

  it('P1: a refused upload stores nothing and its audit records only problem codes and counts', async () => {
    const { source } = await register('m8-p1');
    // A header-less export: its first data row (a person's name, email and phone) is the "header".
    const csv = 'Jane Doe,jane.doe@example.org,+44 7700 900123\nJohn Roe,john@example.org,+44 7700 900456\n';
    await expect(t.upload(source._id, csv, 'text/csv')).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await snapshotsOf(source._id)).toBe(0);
    const sha = createHash('sha256').update(csv).digest('hex');
    expect(
      await infra.db.collection('artifacts').countDocuments({ _id: artifactIdForHash(sha) } as never),
    ).toBe(0);
    const audit = await t.market.audit.list({ entityKind: 'source', entityId: source._id });
    const refused = audit.find((e) => e.action === 'source.snapshot_upload_refused')!;
    expect(refused.details).toEqual({
      code: 'validation_failed',
      problems: { missing_column: 5, unmapped_column: 1, personal_data_column: 2 },
    });
    const text = JSON.stringify(audit);
    for (const leaked of ['Jane', 'jane.doe', 'example.org', '7700']) expect(text).not.toContain(leaked);
  });

  it('P4: a row re-seen at another line of a newer file cites that file and line (snapshot, artifact and locator move together)', async () => {
    const { source } = await register('m8-p4');
    const h = 'Company,Domain,Country,Careers,Company number';
    const a = `${h}\nAlpha Ltd,alpha.co.uk,GB,,\nBravo Ltd,bravo.co.uk,GB,,\n`;
    const b = `${h}\nZulu Ltd,zulu.co.uk,GB,,\nAlpha Ltd,alpha.co.uk,GB,,\nBravo Ltd,bravo.co.uk,GB,,\n`;
    const ua = await importFile(source, a);
    await new Promise((r) => setTimeout(r, 20));
    const ub = await importFile(source, b);
    const alpha = (await observationsOf(source._id)).find((o) => o.externalId === 'name:alpha ltd|gb')!;
    expect({ snapshotId: alpha.snapshotId, artifactId: alpha.artifactId, locator: alpha.locator }).toEqual({
      snapshotId: ub.snapshotId,
      artifactId: ub.artifactId,
      locator: 'row:3',
    });
    expect(ua.artifactId).not.toBe(ub.artifactId);
    // The canonical evidence is a consistent (snapshot, artifact, line) triple: either the file
    // it was reconciled from or the newer one — never one file's snapshot with another's line.
    const company = await t.market.companies.get(alpha.resolution.entityId!);
    const ev = company.identity.domain.evidence.find((e) => e.observationId === alpha._id)!;
    expect([
      [ua.snapshotId, ua.artifactId, 'row:2#domain'],
      [ub.snapshotId, ub.artifactId, 'row:3#domain'],
    ]).toContainEqual([ev.snapshotId, ev.artifactId, ev.locator]);
    // Reprocessing the older file does not move provenance back (source chronology).
    expect((await t.runSource(source._id, { snapshotId: ua.snapshotId })).state).toBe('COMPLETED');
    const again = (await observationsOf(source._id)).find((o) => o._id === alpha._id)!;
    expect({ snapshotId: again.snapshotId, locator: again.locator }).toEqual({
      snapshotId: ub.snapshotId,
      locator: 'row:3',
    });
  });

  it('P7: the parser_failure review is refreshed on re-raise and resolved when a later run imports every row', async () => {
    // The name column is mis-mapped at first (Alias, empty on one row → missing_name).
    const { source } = await register('m8-p7', {
      acquisition: {
        workflowKey: 'market.company_directory.import',
        config: { columns: { name: 'Alias', legalName: 'Company', country: 'Country' } },
      },
    });
    const csv = `Company,Alias,Country\nGood Ltd,Good,GB\nMail Ltd,,GB\n`;
    const u = await importFile(source, csv);
    const dedupeKey = `parser_failure:${source._id}:${u.snapshotId}`;
    const first = (await t.market.reviews.col.findOne({ dedupeKey }))!;
    expect(first).toMatchObject({ status: 'open', allowedActions: ['dismiss'] }); // row errors only: no retry
    expect(first.context).toMatchObject({ rowErrors: 1, processingFailures: 0 });
    // The operator fixes the column map (the name is the Company column) and re-runs the snapshot.
    await t.market.sources.update(
      source._id,
      {
        acquisition: {
          config: { columns: { name: 'Company', legalName: 'Alias', country: 'Country' } },
        },
      },
      t.actor,
    );
    expect((await t.runSource(source._id, { snapshotId: u.snapshotId })).state).toBe('COMPLETED');
    const after = (await t.market.reviews.col.findOne({ _id: first._id }))!;
    expect(after.status).toBe('resolved');
    expect(after.resolution).toMatchObject({ action: 'retry', actor: { kind: 'system' } });
    expect(await t.market.reviews.col.countDocuments({ dedupeKey, status: 'open' })).toBe(0);
  });

  it('processing failures carry the file line, are in the full report and are the only case that offers retry', async () => {
    const { source } = await register('m8-failures');
    const h = 'Company,Domain,Country,Careers,Company number';
    const csv = `${h}\nFine Ltd,fine.co.uk,GB,,\nBroken Pipe Ltd,broken-pipe.co.uk,GB,,\n,gmail.com,GB,,\n`;
    const pipeline = t.market.companyPipeline;
    const original = pipeline.process.bind(pipeline);
    pipeline.process = async (input) => {
      if (input.externalId === 'name:broken pipe ltd|gb') throw new Error('simulated processing failure');
      return original(input);
    };
    let u: Awaited<ReturnType<typeof importFile>>;
    try {
      u = await importFile(source, csv);
    } finally {
      pipeline.process = original;
    }
    const review = (await t.market.reviews.col.findOne({
      dedupeKey: `parser_failure:${source._id}:${u.snapshotId}`,
    }))!;
    expect(review.allowedActions).toEqual(['retry', 'dismiss']);
    expect(review.context).toMatchObject({
      rowErrors: 1,
      processingFailures: 1,
      outcomes: { created: 1, matched: 0, review: 0, failed: 1 },
      failures: [{ line: 3, code: 'processing_failed', message: expect.not.stringMatching(/simulated/) }],
    });
    const report = await infra.artifacts.readJson<{
      errors: Array<{ line: number; code: string }>;
      processingFailures: Array<{ line: number }>;
    }>({ artifactId: String(review.context.reportArtifactId) });
    expect(report.errors.map((e) => [e.line, e.code])).toEqual([[4, 'missing_name']]);
    expect(report.processingFailures.map((f) => f.line)).toEqual([3]);
    // A retry run (the pipeline healthy again) refreshes the review: no processing failure, no retry.
    expect((await t.runSource(source._id, { snapshotId: u.snapshotId })).state).toBe('COMPLETED');
    const refreshed = (await t.market.reviews.col.findOne({ _id: review._id }))!;
    expect(refreshed).toMatchObject({ status: 'open', allowedActions: ['dismiss'] });
    expect(refreshed.context).toMatchObject({ rowErrors: 1, processingFailures: 0 });
  });

  it('B-M1/B-M3/B-M5/A-M3: contact values are row errors, bare names go to review, towns and non-Latin names resolve', async () => {
    const existing = await directory('m8-bare-seed');
    // A canonical "Wren Services" exists; a bare-name row with the same name must not match it.
    await importFile(existing, `${HEADER}\nWren Services,wren-services.co.uk,GB,,\n`);
    const source = await directory('m8-bare', {
      columns: {
        ...COLUMNS,
        town: 'Town',
        registerIds: { gb_companies_house: 'Company number', lei: 'LEI' },
      },
    });
    const h = `${HEADER},Town,LEI`;
    const csv = [
      h,
      'Wren Services,,GB,,,,', // bare, same name as a canonical company → review, not a match
      'Jane Doe,,GB,,,,', // bare, nothing similar → review, not a created company
      'Lark Joinery,,GB,,,Leeds,', // a town never lifts bare status → review
      'ООО Ромашка,,RU,,,,', // bare too (no legal form) → review, but with its own key
      '東京電力株式会社,tepco.co.jp,JP,,,,', // non-Latin name with a domain → created
      'Crane Ltd,jane.doe@crane.co.uk,GB,,,,', // contact value in Domain → the cell is dropped
      'Finch Ltd,,GB,,,,5493001KJTIIGC8Y1R13', // LEI with bad check digits → the cell is dropped
    ].join('\n');
    const { snapshotId } = await importFile(source, csv);
    const obs = await observationsOf(source._id);
    const state = Object.fromEntries(obs.map((o) => [o.payload.name, o.resolution.state]));
    expect(state).toEqual({
      'Wren Services': 'review',
      'Jane Doe': 'review',
      'Lark Joinery': 'review',
      'ООО Ромашка': 'review',
      東京電力株式会社: 'resolved',
      'Crane Ltd': 'review', // kept without its Domain cell: bare
      'Finch Ltd': 'review', // kept without its LEI: bare
    });
    const wren = obs.find((o) => o.payload.name === 'Wren Services')!;
    const wrenReview = (await t.market.reviews.col.findOne({ _id: wren.resolution.reviewItemId! }))!;
    expect(wrenReview).toMatchObject({ type: 'company_resolution', status: 'open' });
    expect(wrenReview.candidates).toHaveLength(1);
    expect(await t.market.companies.col.countDocuments({ 'identity.displayName.value': 'Jane Doe' })).toBe(0);
    const lark = obs.find((o) => o.payload.name === 'Lark Joinery')!;
    expect(lark.payload.locations).toEqual([{ country: 'GB', city: 'Leeds', kind: 'hq' }]);
    expect(obs.find((o) => o.payload.name === 'ООО Ромашка')!.externalId).toBe('name:ооо ромашка|ru');

    // Only dropped cells, no row errors: no parser_failure review, but the report lists them.
    expect(
      await t.market.reviews.col.countDocuments({ dedupeKey: `parser_failure:${source._id}:${snapshotId}` }),
    ).toBe(0);
    const report = await finalReport<{
      outcomes: Record<string, number>;
      errors: unknown[];
      rowWarnings: Array<{ line: number; code: string; column: string }>;
      warnings: string[];
    }>(snapshotId);
    expect(report.outcomes).toMatchObject({ created: 1, matched: 0, review: 6, failed: 0 });
    expect(report.errors).toEqual([]);
    expect(report.rowWarnings.map((w) => [w.line, w.code, w.column])).toEqual([
      [7, 'contact_value', 'Domain'],
      [8, 'invalid_external_id', 'LEI'],
    ]);
    expect(obs.find((o) => o.payload.name === 'Crane Ltd')!.payload.domain).toBeNull();
    expect(JSON.stringify(report)).not.toContain('jane.doe');
    expect(report.warnings).toEqual([expect.stringMatching(/no id column is mapped/)]);
  });

  it('H1 regression: a webmail or shared-hosting Website is no identity evidence; Smith Plumbing and Smith Electrical stay apart, in review', async () => {
    const source = await directory('m8-h1-smith', { columns: { ...COLUMNS, website: 'Website' } });
    const csv = [
      `${HEADER},Website`,
      'Smith Plumbing,,GB,,,https://gmail.com',
      'Smith Electrical,,GB,,,https://gmail.com',
      'Smith Roofing,,GB,,,https://sites.google.com/view/smith-roofing',
    ].join('\n');
    const companiesBefore = await t.market.companies.col.countDocuments({});
    await importFile(source, csv);
    const obs = await observationsOf(source._id);
    expect(obs.map((o) => [o.payload.name, o.resolution.state]).sort()).toEqual([
      ['Smith Electrical', 'review'],
      ['Smith Plumbing', 'review'],
      ['Smith Roofing', 'review'],
    ]);
    for (const o of obs) expect(o.payload).toMatchObject({ domain: null, website: null });
    expect(new Set(obs.map((o) => o.resolution.reviewItemId)).size).toBe(3);
    expect(await t.market.companies.col.countDocuments({})).toBe(companiesBefore);
    expect(
      await t.market.companies.col.countDocuments({
        $or: [
          { 'identity.domain.value': { $in: ['gmail.com', 'google.com'] } },
          { identityKeys: 'domain:gmail.com' },
        ],
      }),
    ).toBe(0);
  });

  it('re-verification #3 item 1: Website is never identity — maps.google.com, google.co.uk/maps, bit.ly and Companies House links merge nothing', async () => {
    const source = await directory('m8-rv3-website', { columns: { ...COLUMNS, website: 'Website' } });
    const csv = [
      `${HEADER},Website`,
      'Smith Electrical,,GB,,,https://maps.google.com/?cid=1234567',
      'Smith Plumbing,,GB,,,https://maps.google.com/?cid=7654321',
      'Smith Heating,,GB,,,https://www.google.co.uk/maps/place/Smith+Heating',
      'Smith Joinery,,GB,,,https://bit.ly/3smith',
      'Smith Glazing,,GB,,,https://bit.ly/4smith',
      'Smith Roofing,,GB,,,https://find-and-update.company-information.service.gov.uk/company/04821937',
      'Smith Tiling,,GB,,,https://find-and-update.company-information.service.gov.uk/company/04821938',
      'Smith Decorating,,GB,,,https://smith-decorating.co.uk/',
    ].join('\n');
    const companiesBefore = await t.market.companies.col.countDocuments({});
    await importFile(source, csv);
    const obs = await observationsOf(source._id);
    expect(obs).toHaveLength(8);
    for (const o of obs) {
      expect(o.resolution.state).toBe('review');
      expect(o.payload.domain).toBeNull();
    }
    expect(new Set(obs.map((o) => o.resolution.reviewItemId)).size).toBe(8);
    expect(await t.market.companies.col.countDocuments({})).toBe(companiesBefore);
    expect(
      await t.market.companies.col.countDocuments({
        $or: [
          {
            'identity.domain.value': {
              $in: ['google.com', 'google.co.uk', 'bit.ly', 'service.gov.uk', 'smith-decorating.co.uk'],
            },
          },
          {
            identityKeys: {
              $in: [
                'domain:google.com',
                'domain:google.co.uk',
                'domain:bit.ly',
                'domain:smith-decorating.co.uk',
              ],
            },
          },
        ],
      }),
    ).toBe(0);
    // Even a legal-form row with an accepted Website gets no domain identity from it.
    const legal = await directory('m8-rv3-website-legal', { columns: { ...COLUMNS, website: 'Website' } });
    await importFile(
      legal,
      `${HEADER},Website\nSmith Brothers Ltd,,GB,,05432198,https://smith-brothers.co.uk/about\n`,
    );
    const [o] = await observationsOf(legal._id);
    const c = await t.market.companies.get(o!.resolution.entityId!);
    expect(c.identity.domain.value).toBeNull();
    expect(c.identityKeys.filter((k) => k.startsWith('domain:'))).toEqual([]);
    expect(c.identity.website.value).toBe('https://smith-brothers.co.uk/');
  });

  it('re-verification #3 item 2: a directory domain or id hit auto-matches only on the row’s own name key', async () => {
    const seed = await directory('m8-rv3-own-seed');
    await importFile(seed, `${HEADER}\nHalcyon Foods Ltd,halcyon-foods.co.uk,GB,,03817265\n`);
    const [seeded] = await observationsOf(seed._id);
    const source = await directory('m8-rv3-own');
    await importFile(
      source,
      [
        HEADER,
        'Halcyon Coffee Ltd,halcyon-foods.co.uk,GB,,', // domain hit, token overlap only → review
        'Kestrel Air Ltd,,GB,,03817265', // id hit, another name → review
        'HALCYON FOODS LIMITED,halcyon-foods.co.uk,GB,,', // own strict key → match
        'Halcyon Foods Ltd,halcyon-foods.co.uk,DE,,', // own key but another country → review (re-verification #4)
      ].join('\n'),
    );
    const state = Object.fromEntries(
      (await observationsOf(source._id)).map((o) => [o.payload.name, o.resolution]),
    );
    expect(state['Halcyon Coffee Ltd']).toMatchObject({ state: 'review' });
    expect(state['Kestrel Air Ltd']).toMatchObject({ state: 'review' });
    expect(state['Halcyon Foods Ltd']).toMatchObject({ state: 'review' });
    expect(state['HALCYON FOODS LIMITED']).toMatchObject({
      state: 'resolved',
      entityId: seeded!.resolution.entityId,
      method: 'domain',
    });
  });

  it('re-verification #4 H1: contradicting register ids never merge (Acme Widgets in-file, Kite across files, Heron Tools brand); a merged contradiction is a recorded conflict', async () => {
    const before = await t.market.companies.col.countDocuments({});
    // In one file: the same name and country with two company numbers → both rows to review.
    const inFile = await directory('m8-rv4-acme-widgets');
    await importFile(
      inFile,
      `${HEADER}\nAcme Widgets Ltd,,GB,,04711223\nACME WIDGETS LIMITED,,GB,,09733221\n`,
    );
    const widgets = await observationsOf(inFile._id);
    expect(widgets.map((o) => o.resolution.state)).toEqual(['review', 'review']);
    const widgetReviews = await t.market.reviews.col
      .find({ _id: { $in: widgets.map((o) => o.resolution.reviewItemId!) } })
      .toArray();
    expect(widgetReviews.map((r) => r.severity)).toEqual(['high', 'high']);
    expect(await t.market.companies.col.countDocuments({})).toBe(before);

    // Across files: Kite Ltd (one number), then KITE LIMITED with another number → high review.
    const first = await directory('m8-rv4-kite-1');
    await importFile(first, `${HEADER}\nKite Ltd,,GB,,04811234\n`);
    const [kiteObs] = await observationsOf(first._id);
    const kiteId = kiteObs!.resolution.entityId!;
    const second = await directory('m8-rv4-kite-2');
    await importFile(second, `${HEADER}\nKITE LIMITED,,GB,,09811234\n`);
    const [kite2] = await observationsOf(second._id);
    expect(kite2!.resolution.state).toBe('review');
    const kiteReview = (await t.market.reviews.col.findOne({ _id: kite2!.resolution.reviewItemId! }))!;
    expect(kiteReview).toMatchObject({
      severity: 'high',
      candidates: [expect.objectContaining({ id: kiteId })],
    });
    expect((await t.market.companies.get(kiteId)).identity.externalIds).toEqual([
      { namespace: 'gb_companies_house', id: '04811234' },
    ]);

    // Brand: Heron Tools Ltd (one number), then "Heron Tools" with another number → high review.
    const heron1 = await directory('m8-rv4-heron-1');
    await importFile(heron1, `${HEADER}\nHeron Tools Ltd,,GB,,03911234\n`);
    const heron2 = await directory('m8-rv4-heron-2');
    await importFile(heron2, `${HEADER}\nHeron Tools,,GB,,07911234\n`);
    const [heronObs] = await observationsOf(heron2._id);
    expect(heronObs!.resolution.state).toBe('review');
    expect((await t.market.reviews.col.findOne({ _id: heronObs!.resolution.reviewItemId! }))!.severity).toBe(
      'high',
    );

    // An operator merges the Kite review anyway: the reconciler records the two numbers as a
    // conflict (never a silent union) and gives the second number no identity key.
    await t.market.reviewService.resolve(
      kiteReview._id,
      { action: 'merge', targetId: kiteId, reason: 'operator says same company' },
      t.actor,
    );
    const kite = await t.market.companies.get(kiteId);
    expect(kite.quality.conflictFields).toContain('identity.externalIds');
    expect(kite.identityKeys).toContain('ext:gb_companies_house:04811234');
    expect(kite.identityKeys).not.toContain('ext:gb_companies_house:09811234');
    const conflict = (await t.market.reviews.col.findOne({
      dedupeKey: `field_conflict:company:${kiteId}:externalIds:gb_companies_house`,
    }))!;
    expect(conflict).toMatchObject({
      type: 'field_conflict',
      severity: 'high',
      status: 'open',
      context: expect.objectContaining({ values: ['04811234', '09811234'] }),
    });
  });

  it('re-verification #3 item 4: a legacy name key is a review, and a genuine company is still creatable (qualified key, no index clash)', async () => {
    const col = t.market.companies.col;
    const mutech = (await t.market.companies.createFromCandidate({ name: 'µTech Ltd' }))!;
    await col.updateOne({ _id: mutech._id }, { $set: { identityKeys: ['name:tech ltd'] } }); // keyed under v1
    const source = await directory('m8-rv3-legacy');
    await importFile(source, `${HEADER}\nTech Ltd,,GB,,\n`);
    const [o] = await observationsOf(source._id);
    expect(o!.resolution.state).toBe('review');
    const review = (await t.market.reviews.col.findOne({ _id: o!.resolution.reviewItemId! }))!;
    expect(review.candidates).toEqual([
      expect.objectContaining({ id: mutech._id, details: { method: 'name_legacy_key' } }),
    ]);
    // The operator decides it is a different company: create_new gives it a qualified name key
    // (`name:tech ltd#gb`), so the unique identity-key index does not clash with µTech's v1 key.
    await t.market.reviewService.resolve(
      review._id,
      { action: 'create_new', reason: 'a different company' },
      t.actor,
    );
    const resolved = (await t.market.observations.companyObservations.findOne({ _id: o!._id }))!;
    expect(resolved.resolution).toMatchObject({ state: 'resolved', method: 'operator_create' });
    const created = await t.market.companies.get(resolved.resolution.entityId!);
    expect(created._id).not.toBe(mutech._id);
    expect(created.identityKeys).toContain('name:tech ltd#gb');
    expect((await col.findOne({ _id: mutech._id }))!.identityKeys).toEqual(['name:tech ltd']);
  });

  it('M5: an upload-only source has no schedule document at all, so enable has nothing to switch on', async () => {
    const source = await directory('m8-m5-schedule');
    const schedules = () =>
      infra.db
        .collection('workflow_schedules')
        .countDocuments({ 'owner.kind': 'source', 'owner.id': source._id });
    expect(await schedules()).toBe(0);
    await t.market.sources.setEnabled(source._id, false, t.actor);
    await t.market.sources.setEnabled(source._id, true, t.actor);
    expect(await schedules()).toBe(0);
  });

  it('M2 canary: no cell text of a refused or dropped cell reaches any Mongo collection or stored artifact except the raw upload', async () => {
    const source = await directory('m8-m2-canary', {
      columns: { ...COLUMNS, website: 'Website', town: 'Town', id: 'Ref' },
    });
    const h = `${HEADER},Website,Town,Ref`;
    const csv = [
      h,
      'Canary One Ltd,zqcanaryaa.test,GB,,,,,R1', // reserved domain → row error
      'Canary Two Ltd,,GB,,,,zqcanarybb jane@zqcanarybb.co.uk,R2', // contact value in town → row error
      'Canary Three Ltd,,GB,,ZQCANARYCC,,,R3', // invalid company number → row error
      'Canary Four Ltd,,Zqcanaryddland,,,,,R4', // invalid country → row error
      'Canary Five Ltd,,GB,,,https://canary-five.co.uk/zqcanaryee?utm=zqcanaryee#zqcanaryee,,R5', // path dropped
      'Canary Six,,GB,,,https://gmail.com/zqcanaryff,,R6', // refused host dropped
      'Canary Seven Ltd,,GB,,,,Leeds,R7',
      'Canary Seven Twin Ltd,,GB,,,,Zqcanarygg,R7', // duplicate record key (R7) → row error
      'Canary Eight Ltd,zqcanaryhh",GB,,,,,R8', // malformed row → row error
      'Canary Nine Ltd,,GB,https://careers.canary-nine.co.uk/jobs?contact=+44 7700 900123 zqcanaryii,,,,R9', // contact in the query: never stored (DECISION_LOG 29b6592), the path is kept, no warning
      'Canary Ten Ltd,,GB,,00000000,,,R10', // placeholder id: absent
      'Canary Eleven Ltd,,GB,https://careers.canary-eleven.co.uk/jobs?ref=zqcanaryjj#zqcanaryjj,,,,R11', // query dropped
    ].join('\n');
    const { snapshotId, artifactId } = await importFile(source, csv);
    const review = (await t.market.reviews.col.findOne({
      dedupeKey: `parser_failure:${source._id}:${snapshotId}`,
    }))!;
    expect(review.context).toMatchObject({ rowErrors: 2, rowWarnings: 5 }); // bad optional cells are dropped, not refused

    const canaries = [
      'zqcanaryaa',
      'zqcanarybb',
      'zqcanarycc',
      'zqcanarydd',
      'zqcanaryee',
      'zqcanaryff',
      'zqcanarygg',
      'zqcanaryhh',
      'zqcanaryii',
      'zqcanaryjj',
      '7700 900123',
    ];
    const hits: string[] = [];
    for (const { name } of await infra.db.listCollections({}, { nameOnly: true }).toArray()) {
      for await (const doc of infra.db.collection(name).find({})) {
        const text = withoutIds(JSON.stringify(doc).toLowerCase());
        for (const c of canaries) if (text.includes(c)) hits.push(`${name}/${String(doc._id)}: ${c}`);
      }
    }
    for await (const a of infra.db.collection<{ _id: string }>('artifacts').find({})) {
      if (a._id === artifactId) continue; // the raw uploaded snapshot holds the cell text
      const text = Buffer.from(await infra.artifacts.readBytes({ artifactId: a._id }))
        .toString('utf8')
        .toLowerCase()
        .replace(ID_PATTERN, '');
      for (const c of canaries) if (text.includes(c)) hits.push(`artifact ${a._id}: ${c}`);
    }
    expect(hits).toEqual([]);
    // The raw snapshot does hold them (the check above would otherwise prove nothing).
    const raw = (await infra.artifacts.readText({ artifactId })).toLowerCase();
    for (const c of canaries) expect(raw).toContain(c);
  });

  it('L1: the name-norm/2 backfill adds v2 name keys beside v1 keys, never removes one, and is idempotent', async () => {
    const col = t.market.companies.col;
    const make = async (name: string, keys: string[]) => {
      const c = (await t.market.companies.createFromCandidate({ name }))!;
      await col.updateOne({ _id: c._id }, { $set: { identityKeys: keys } }); // as stored under v1
      return c._id;
    };
    const cafe = await make('Café 東京 Ltd', ['name:cafe ltd', 'domain:cafe-tokyo.co.jp']);
    const qualified = await make('Café 京都 Ltd', ['name:cafe ltd#kyoto']);
    const cyrillic = await make('ООО Ромашка Лтд', []); // v1 key was empty: no name key at all
    const latin = await make('Plain Latin Ltd', ['name:plain latin ltd']);
    // Another company already holds the v2 key the qualified one would get: a clash, not a theft.
    const holder = await make('Holder Ltd', ['name:holder ltd', 'name:cafe 京都 ltd#kyoto']);

    const first = await migrateCompanyNameKeysV2(infra.db, 2);
    expect(first.keysAdded).toBeGreaterThanOrEqual(2);
    expect(first.clashes).toBeGreaterThanOrEqual(1);
    const keys = async (id: string) => (await col.findOne({ _id: id }))!.identityKeys.slice().sort();
    expect(await keys(cafe)).toEqual(['domain:cafe-tokyo.co.jp', 'name:cafe ltd', 'name:cafe 東京 ltd']);
    expect(await keys(qualified)).toEqual(['name:cafe ltd#kyoto']);
    expect(await keys(cyrillic)).toEqual(['name:ооо ромашка лтд']);
    expect(await keys(latin)).toEqual(['name:plain latin ltd']);
    expect(await keys(holder)).toEqual(['name:cafe 京都 ltd#kyoto', 'name:holder ltd']);

    // A clash shows up as the several-companies-share-the-legal-name review at the next resolution.
    const naraLegacy = await make('Nara 奈良 Ltd', ['name:nara ltd']);
    const naraNew = await make('Nara 奈良 Ltd', ['name:nara 奈良 ltd']);
    const merged = await make('Kobe 神戸 Ltd', ['name:kobe ltd']);
    await col.updateOne({ _id: merged }, { $set: { status: 'merged' } });
    const second = await migrateCompanyNameKeysV2(infra.db);
    expect(second.clashes).toBeGreaterThanOrEqual(1);
    expect(await keys(naraLegacy)).toEqual(['name:nara ltd']);
    expect(await keys(merged)).toEqual(['name:kobe ltd']); // only active companies are touched
    expect(await resolveCompanyCandidate({ name: 'Nara 奈良 Ltd' }, t.market.companies)).toMatchObject({
      kind: 'review',
      reason: expect.stringMatching(/^Several companies share the legal name/),
      candidates: expect.arrayContaining([
        expect.objectContaining({ id: naraLegacy }),
        expect.objectContaining({ id: naraNew }),
      ]),
    });

    // Replay-safe: a second run adds nothing and removes nothing.
    const again = await migrateCompanyNameKeysV2(infra.db);
    expect(again).toMatchObject({ keysAdded: 0, updated: 0 });
    expect(await keys(cafe)).toEqual(['domain:cafe-tokyo.co.jp', 'name:cafe ltd', 'name:cafe 東京 ltd']);
    // And the resolver finds the legacy company by either key.
    expect(await t.market.companies.byStrictName('cafe 東京 ltd')).toEqual([
      expect.objectContaining({ id: cafe }),
    ]);
  });

  // ---- PR #27 re-verification #5 ------------------------------------------------------------

  const crnColumns = { ...COLUMNS, registerIds: { gb_companies_house: 'Company number', lei: 'LEI' } };
  const H5 = `${HEADER},LEI`;
  const kiloCompanies = () =>
    t.market.companies.col
      .find({ status: 'active', 'identity.displayName.value': { $regex: '^(Kilo|November) Tools' } })
      .toArray();

  it('P7 (item 4): Kilo Tools with two company numbers imported concurrently → one company + a high review, or two companies — never a union', async () => {
    const a = await directory('m8-rv5-kilo-a', { columns: crnColumns });
    const b = await directory('m8-rv5-kilo-b', { columns: crnColumns });
    const ua = await t.upload(a._id, `${H5}\nKilo Tools Ltd,,GB,,04711111,\n`, 'text/csv');
    const ub = await t.upload(b._id, `${H5}\nKilo Tools Ltd,,GB,,09722222,\n`, 'text/csv');
    const [ra, rb] = await Promise.all([
      t.market.sources.runNow(a._id, t.actor, { snapshotId: ua.snapshotId }),
      t.market.sources.runNow(b._id, t.actor, { snapshotId: ub.snapshotId }),
    ]);
    const runs = await Promise.all(
      [ra, rb].map((r) => waitForRun(t.runtime.engine, r.runId, undefined, 60_000)),
    );
    expect(runs.map((r) => r.state)).toEqual(['COMPLETED', 'COMPLETED']);
    const companies = (await kiloCompanies()).filter(
      (c) => c.identity.displayName.value === 'Kilo Tools Ltd',
    );
    expect(companies.length === 1 || companies.length === 2).toBe(true);
    for (const c of companies) {
      expect(c.identity.externalIds.filter((e) => e.namespace === 'gb_companies_house')).toHaveLength(1);
      expect(c.quality.conflictFields).not.toContain('identity.externalIds');
    }
    const obs = [...(await observationsOf(a._id)), ...(await observationsOf(b._id))];
    if (companies.length === 1) {
      const review = obs.find((o) => o.resolution.state === 'review')!;
      const item = (await t.market.reviews.col.findOne({ _id: review.resolution.reviewItemId! }))!;
      expect(item.severity).toBe('high');
    }
  });

  it('item 4: the lost creation race sees the winner’s ids and HQ country (pipeline-level race)', async () => {
    const src = await directory('m8-rv5-race');
    const payload = (crn: string, country: string) => ({
      name: 'Lima Tools Ltd',
      legalName: 'Lima Tools Ltd',
      aliases: [],
      domain: null,
      website: null,
      externalIds: [{ namespace: 'gb_companies_house', id: crn }],
      locations: [{ country, kind: 'hq' as const }],
      industries: [],
      careersUrl: null,
    });
    const input = (crn: string, country: string, line: number) => ({
      sourceId: src._id,
      locator: `row:${line}`,
      externalId: `gb_companies_house:${crn}`,
      payload: payload(crn, country),
      parser: COMPANY_DIRECTORY_PARSER,
    });
    const results = await Promise.all([
      t.market.companyPipeline.process(input('04733333', 'GB', 2)),
      t.market.companyPipeline.process(input('09744444', 'GB', 3)),
    ]);
    const outcomes = results.map((r) => r.outcome).sort();
    const lima = await t.market.companies.col
      .find({ 'identity.displayName.value': 'Lima Tools Ltd' })
      .toArray();
    if (lima.length === 1) {
      expect(outcomes).toEqual(['created', 'review']);
      expect(lima[0]!.identity.externalIds).toHaveLength(1);
    } else expect(outcomes).toEqual(['created', 'created']);
    // Creation stores the candidate's ids and HQ country in the same write.
    const created = (await t.market.companies.createFromCandidate({
      name: 'Mike Tools Ltd',
      hqCountry: 'GB',
      externalIds: [{ namespace: 'gb_companies_house', id: '445790' }],
    }))!;
    expect(created.identity.externalIds).toEqual([{ namespace: 'gb_companies_house', id: '00445790' }]);
    expect(created.geography.headquarters.value).toEqual({ country: 'GB', kind: 'hq' });
    const summary = (await t.market.companies.byStrictName('mike tools ltd'))[0]!;
    expect(summary).toMatchObject({
      hqCountry: 'GB',
      externalIds: expect.arrayContaining([{ namespace: 'gb_companies_house', id: '00445790' }]),
    });
  });

  it('P10 (item 4): November Tools GB company number vs IE LEI imported concurrently → review, no silent HQ change', async () => {
    const a = await directory('m8-rv5-nov-a', { columns: crnColumns });
    const b = await directory('m8-rv5-nov-b', { columns: crnColumns });
    const ua = await t.upload(a._id, `${H5}\nNovember Tools Ltd,,GB,,07778888,\n`, 'text/csv');
    const ub = await t.upload(b._id, `${H5}\nNovember Tools Ltd,,IE,,,5493001KJTIIGC8Y1R12\n`, 'text/csv');
    const [ra, rb] = await Promise.all([
      t.market.sources.runNow(a._id, t.actor, { snapshotId: ua.snapshotId }),
      t.market.sources.runNow(b._id, t.actor, { snapshotId: ub.snapshotId }),
    ]);
    await Promise.all([ra, rb].map((r) => waitForRun(t.runtime.engine, r.runId, undefined, 60_000)));
    const [oa] = await observationsOf(a._id);
    const [ob] = await observationsOf(b._id);
    expect([oa!.resolution.state, ob!.resolution.state].sort()).toEqual(['resolved', 'review']);
    const winner = oa!.resolution.state === 'resolved' ? oa! : ob!;
    const company = await t.market.companies.get(winner.resolution.entityId!);
    // The company keeps its own row's country and ids only.
    expect(company.geography.headquarters.value?.country).toBe(winner.payload.locations[0]!.country);
    expect(company.identity.externalIds).toEqual(winner.payload.externalIds);
  });

  it('P2 (item 5): a CRN row does not attach by name to a LEI-only company → low review', async () => {
    const seed = await directory('m8-rv5-foxtrot-seed', { columns: crnColumns });
    await importFile(seed, `${H5}\nFoxtrot Widgets Ltd,,GB,,,5299FOXTROTWIDGET082\n`);
    const src = await directory('m8-rv5-foxtrot', { columns: crnColumns });
    await importFile(src, `${H5}\nFoxtrot Widgets Ltd,,GB,,04755555,\n`);
    const [o] = await observationsOf(src._id);
    expect(o!.resolution.state).toBe('review');
    expect((await t.market.reviews.col.findOne({ _id: o!.resolution.reviewItemId! }))!.severity).toBe('low');
  });

  it('P5 (item 6): India Tools GB and IE (bare rows) are two review items', async () => {
    const src = await directory('m8-rv5-india');
    await importFile(src, `${HEADER}\nIndia Tools,,GB,,\nIndia Tools,,IE,,\n`);
    const obs = await observationsOf(src._id);
    expect(obs.map((o) => o.resolution.state)).toEqual(['review', 'review']);
    expect(new Set(obs.map((o) => o.resolution.reviewItemId)).size).toBe(2);
  });

  it('item 7: the id-conflict review refreshes, a dismissal holds for the same ids, and it resolves once the conflict is gone', async () => {
    const col = t.market.companies.col;
    const first = await directory('m8-rv5-oscar-1');
    await importFile(first, `${HEADER}\nOscar Tools Ltd,,GB,,04766666\n`);
    const [o1] = await observationsOf(first._id);
    const companyId = o1!.resolution.entityId!;
    const mergeIn = async (key: string, crn: string) => {
      const s = await directory(key);
      await importFile(s, `${HEADER}\nOSCAR TOOLS LIMITED,,GB,,${crn}\n`);
      const [o] = await observationsOf(s._id);
      await t.market.reviewService.resolve(
        o!.resolution.reviewItemId!,
        { action: 'merge', targetId: companyId, reason: 'operator says same company' },
        t.actor,
      );
      return o!;
    };
    const o2 = await mergeIn('m8-rv5-oscar-2', '09766667');
    const dedupeKey = `field_conflict:company:${companyId}:externalIds:gb_companies_house`;
    const first1 = (await t.market.reviews.col.findOne({ dedupeKey, status: 'open' }))!;
    expect(first1.context).toMatchObject({ values: ['04766666', '09766667'] });
    expect(first1.reason).toMatch(/04766666, 09766667/);
    expect(first1.reason).toMatch(/Dismiss|operator must correct the source data/);
    // The operator dismisses: a re-reconciliation with the same ids raises nothing new.
    await t.market.reviewService.resolve(
      first1._id,
      { action: 'dismiss', reason: 'both are right' },
      t.actor,
    );
    await t.market.companyReconciler.reconcile(companyId);
    expect(await t.market.reviews.col.countDocuments({ dedupeKey, status: 'open' })).toBe(0);
    // A third id changes the set: raised again, with all three values.
    const o3 = await mergeIn('m8-rv5-oscar-3', '09766668');
    const again = (await t.market.reviews.col.findOne({ dedupeKey, status: 'open' }))!;
    expect(again.context).toMatchObject({ values: ['04766666', '09766667', '09766668'] });
    // The wrong observations are rejected: the conflict is gone and the review resolves itself.
    await t.market.observations.setCompanyResolution([o2._id, o3._id], {
      state: 'rejected',
      resolverVersion: 'operator',
    });
    await t.market.companyReconciler.reconcile(companyId);
    expect(await t.market.reviews.col.findOne({ _id: again._id })).toMatchObject({ status: 'resolved' });
    expect((await col.findOne({ _id: companyId }))!.quality.conflictFields).not.toContain(
      'identity.externalIds',
    );
  });

  it('items 2 and 3: contact vectors and a raw file id never reach canonical data (canary scan)', async () => {
    const source = await directory('m8-rv5-canary', {
      columns: { ...COLUMNS, legalName: 'Legal', town: 'Town', id: 'Ref' },
    });
    // [name, legal name, town, marker]: a bad name refuses the row; a bad legal name or town is
    // dropped (re-verification #6) — the marker sits only in the offending cell.
    const vectors = [
      ['Zqaa Ltd 020–7946–0958', '', '', 'zqaa'],
      ['Clean Ab Ltd', 'Zqab 020_7946_0958 Ltd', '', 'zqab'],
      ['Clean Ac Ltd', '', 'Zqac Leeds 0113·496·0000', 'zqac'],
      ['Zqad jane at zqad-mail.co.uk', '', '', 'zqad'],
      ['Clean Ae Ltd', '', 'Zqae ٠٧٧٠٠٩٠٠١٢٣', 'zqae'],
      ['Zqaf jane(a)zqaf.co.uk', '', '', 'zqaf'],
      ['Zqag jane#zqag.co.uk', '', '', 'zqag'],
      ['Zqah o77oo9oo123', '', '', 'zqah'],
      ['Zqai jane@gmail。com', '', '', 'zqai'],
      ['Zqaj skype jane.zqaj', '', '', 'zqaj'],
      ['Clean Ak Ltd', '', 'Zqak 2', 'zqak'],
      ['qqleak [at] acme dot com', '', '', 'qqleak'],
      ['Zqam &#64; acme.com', '', '', 'zqam'],
      ['Clean An Ltd', '', 'Dublin 2 Zqan', 'zqan'],
    ];
    const csv = [
      `${HEADER},Legal,Town,Ref`,
      ...vectors.map(([name, legal, town], k) => `"${name}",,GB,,,"${legal}","${town}",R${k}`),
      'Zqal Holdings Ltd,,GB,,04788888,,,ZQRAWID-4477',
    ].join('\n');
    const { artifactId, snapshotId } = await importFile(source, csv);
    const review = (await t.market.reviews.col.findOne({
      dedupeKey: `parser_failure:${source._id}:${snapshotId}`,
    }))!;
    const refusedNames = vectors.filter(([name]) => !name!.startsWith('Clean')).length;
    expect(review.context).toMatchObject({
      rowErrors: refusedNames,
      rowWarnings: vectors.length - refusedNames,
    });
    // Unique markers only (digits like 7946 also occur in other tests' data in this database).
    const canaries = [...vectors.map(([, , , marker]) => marker!), '٠٧٧٠٠', 'o77oo', 'zqrawid'];
    const hits: string[] = [];
    for (const { name } of await infra.db.listCollections({}, { nameOnly: true }).toArray())
      for await (const doc of infra.db.collection(name).find({})) {
        const text = withoutIds(JSON.stringify(doc).toLowerCase());
        for (const c of canaries) if (text.includes(c)) hits.push(`${name}/${String(doc._id)}: ${c}`);
      }
    for await (const a of infra.db.collection<{ _id: string }>('artifacts').find({})) {
      if (a._id === artifactId) continue;
      const text = Buffer.from(await infra.artifacts.readBytes({ artifactId: a._id }))
        .toString('utf8')
        .toLowerCase()
        .replace(ID_PATTERN, '');
      for (const c of canaries) if (text.includes(c)) hits.push(`artifact ${a._id}: ${c}`);
    }
    // The accepted row's company name "Zqal Holdings Ltd" is company data; its file id is not stored.
    expect(hits.filter((h) => !h.endsWith(': zqal'))).toEqual([]);
    const [accepted] = (await observationsOf(source._id)).filter(
      (o) => o.payload.name === 'Zqal Holdings Ltd',
    );
    expect(accepted!.externalId).toMatch(/^id:[0-9a-f]{32}$/); // the hashed file id, never the raw one
  });

  it('item 3: a row keyed by its file id stores only the hash', async () => {
    const source = await directory('m8-rv5-fileid', { columns: { ...COLUMNS, id: 'Ref' } });
    await importFile(source, `${HEADER},Ref\nPapa Tools Ltd,papa-tools.co.uk,GB,,,ZQFILEID-9911\n`);
    const [o] = await observationsOf(source._id);
    expect(o!.externalId).toMatch(/^id:[0-9a-f]{32}$/);
    expect(JSON.stringify(o).toLowerCase()).not.toContain('zqfileid');
  });

  it('item 9: a file mapping neither Domain nor a register id warns on upload and in the report', async () => {
    const source = await directory('m8-rv5-warn', { columns: { name: 'Company', country: 'Country' } });
    const upload = await t.upload(source._id, 'Company,Country\nQuebec Tools,GB\nBad,Atlantis\n', 'text/csv');
    expect(upload.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/every row is a bare name/)]),
    );
    const run = await t.runSource(source._id, { snapshotId: upload.snapshotId });
    expect(run.state).toBe('COMPLETED');
    const report = await finalReport<{ warnings: string[] }>(upload.snapshotId);
    expect(report.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/every row is a bare name/)]),
    );
  });

  it('P3 (item 10): the generic company observation normalises known registry ids', async () => {
    const src = await directory('m8-rv5-p3');
    const { observation } = await t.market.observations.recordCompanyObservation({
      sourceId: src._id,
      externalId: 'p3',
      payload: {
        name: 'Romeo Tools Ltd',
        aliases: [],
        externalIds: [{ namespace: 'gb_companies_house', id: '445790' }],
        locations: [],
        industries: [],
      },
      parser: { name: 'workflow', version: '1' },
    });
    expect(observation.payload.externalIds).toEqual([{ namespace: 'gb_companies_house', id: '00445790' }]);
  });

  // ---- PR #27 re-verification #6 ------------------------------------------------------------

  it('H-B: Zulu Holdings with a BR number, then an ordinary company number → high review; a merge is a recorded conflict', async () => {
    const a = await directory('m8-rv6-zulu-a');
    await importFile(a, `${HEADER}\nZulu Holdings Ltd,,GB,,BR001234\n`);
    const [oa] = await observationsOf(a._id);
    const companyId = oa!.resolution.entityId!;
    const b = await directory('m8-rv6-zulu-b');
    await importFile(b, `${HEADER}\nZulu Holdings Ltd,,GB,,04811111\n`);
    const [ob] = await observationsOf(b._id);
    expect(ob!.resolution.state).toBe('review');
    const review = (await t.market.reviews.col.findOne({ _id: ob!.resolution.reviewItemId! }))!;
    expect(review.severity).toBe('high');
    expect((await t.market.companies.get(companyId)).identity.externalIds).toEqual([
      { namespace: 'gb_companies_house', id: 'BR001234' },
    ]);
    await t.market.reviewService.resolve(
      review._id,
      { action: 'merge', targetId: companyId, reason: 'same company' },
      t.actor,
    );
    const zulu = await t.market.companies.get(companyId);
    expect(zulu.quality.conflictFields).toContain('identity.externalIds');
    expect(zulu.identityKeys).not.toContain('ext:gb_companies_house:04811111');
    expect(
      await t.market.reviews.col.countDocuments({
        dedupeKey: `field_conflict:company:${companyId}:externalIds:gb_companies_house`,
        status: 'open',
        severity: 'high',
      }),
    ).toBe(1);
  });

  it('M-A: correcting an id by re-import leaves no stale id or key; the corrected id then matches normally (Yankee Tools)', async () => {
    const cols = { ...COLUMNS, id: 'Ref' };
    const s1 = await directory('m8-rv6-yankee-1', { columns: cols });
    await importFile(s1, `${HEADER},Ref\nYankee Tools Ltd,,GB,,04711001,R1\n`);
    const [o1] = await observationsOf(s1._id);
    const companyId = o1!.resolution.entityId!;
    const s2 = await directory('m8-rv6-yankee-2', { columns: cols });
    await importFile(s2, `${HEADER},Ref\nYANKEE TOOLS LIMITED,,GB,,09711002,R1\n`);
    const [o2] = await observationsOf(s2._id);
    await t.market.reviewService.resolve(
      o2!.resolution.reviewItemId!,
      { action: 'merge', targetId: companyId, reason: 'same' },
      t.actor,
    );
    // The operator corrects source 1 to the right number and re-imports it (the id column keys the row).
    await importFile(s1, `${HEADER},Ref\nYankee Tools Ltd,,GB,,09711002,R1\n`);
    const current = (await observationsOf(s1._id)).find((o) => !o.superseded)!;
    if (current.resolution.state === 'review')
      await t.market.reviewService.resolve(
        current.resolution.reviewItemId!,
        { action: 'merge', targetId: companyId, reason: 'corrected' },
        t.actor,
      );
    const c = await t.market.companies.get(companyId);
    expect(c.identity.externalIds).toEqual([{ namespace: 'gb_companies_house', id: '09711002' }]);
    expect(c.identityKeys).not.toContain('ext:gb_companies_house:04711001');
    expect(c.quality.conflictFields).not.toContain('identity.externalIds');
    const summary = (await t.market.companies.byStrictName('yankee tools ltd'))[0]!;
    expect(summary.externalIds).toEqual([{ namespace: 'gb_companies_house', id: '09711002' }]);
    const s3 = await directory('m8-rv6-yankee-3');
    await importFile(s3, `${HEADER}\nYankee Tools Ltd,,GB,,09711002\n`);
    const [o3] = await observationsOf(s3._id);
    expect(o3!.resolution).toMatchObject({ state: 'resolved', entityId: companyId, method: 'external_id' });
  });

  it('M-B: a conflict set equal to ANY dismissed set closes the open review (dismiss {1,2}, add 3, reject 3)', async () => {
    const first = await directory('m8-rv6-sierra-1');
    await importFile(first, `${HEADER}\nSierra Tools Ltd,,GB,,04755001\n`);
    const [o1] = await observationsOf(first._id);
    const companyId = o1!.resolution.entityId!;
    const mergeIn = async (key: string, crn: string) => {
      const src = await directory(key);
      await importFile(src, `${HEADER}\nSIERRA TOOLS LIMITED,,GB,,${crn}\n`);
      const [o] = await observationsOf(src._id);
      await t.market.reviewService.resolve(
        o!.resolution.reviewItemId!,
        { action: 'merge', targetId: companyId, reason: 'same company' },
        t.actor,
      );
      return o!;
    };
    await mergeIn('m8-rv6-sierra-2', '09755002');
    const dedupeKey = `field_conflict:company:${companyId}:externalIds:gb_companies_house`;
    const r1 = (await t.market.reviews.col.findOne({ dedupeKey, status: 'open' }))!;
    expect(r1.reason).toMatch(/dismiss, or re-import with an id column/);
    expect(r1.reason).not.toMatch(/reject/i);
    await t.market.reviewService.resolve(r1._id, { action: 'dismiss', reason: 'both right' }, t.actor);
    const o3 = await mergeIn('m8-rv6-sierra-3', '09755003');
    const r2 = (await t.market.reviews.col.findOne({ dedupeKey, status: 'open' }))!;
    expect(r2.context).toMatchObject({ values: ['04755001', '09755002', '09755003'] });
    await t.market.observations.setCompanyResolution([o3._id], {
      state: 'rejected',
      resolverVersion: 'operator',
    });
    await t.market.companyReconciler.reconcile(companyId);
    expect(await t.market.reviews.col.findOne({ _id: r2._id })).toMatchObject({ status: 'resolved' });
    expect(await t.market.reviews.col.countDocuments({ dedupeKey, status: 'open' })).toBe(0);
  });

  it('rv7 H3 Race A: a reconcile between create and link keeps the creation key; a contradicting CRN is a high review; no second holder', async () => {
    // The creator wrote the company (and its key) but has not linked its observation yet.
    const created = (await t.market.companies.createFromCandidate({
      name: 'Uniform Racing Ltd',
      hqCountry: 'GB',
      externalIds: [{ namespace: 'gb_companies_house', id: '04791001' }],
    }))!;
    const key = 'ext:gb_companies_house:04791001';
    // Another file's row (same name, a domain, no id) matches it by name and reconciles it.
    const b = await directory('m8-rv7-uniform-b');
    await importFile(b, `${HEADER}\nUniform Racing Ltd,uniform-racing.co.uk,GB,,\n`);
    const [ob] = await observationsOf(b._id);
    expect(ob!.resolution).toMatchObject({ state: 'resolved', entityId: created._id });
    const after = await t.market.companies.get(created._id);
    expect(after.reconciliation).toBeDefined();
    expect(after.identityKeys).toContain(key);
    const summary = (await t.market.companies.byStrictName('uniform racing ltd'))[0]!;
    expect(summary.externalIds).toContainEqual({ namespace: 'gb_companies_house', id: '04791001' });
    // A contradicting CRN with the same name and domain is still a high review.
    const c = await directory('m8-rv7-uniform-c');
    await importFile(c, `${HEADER}\nUniform Racing Ltd,uniform-racing.co.uk,GB,,09791002\n`);
    const [oc] = await observationsOf(c._id);
    expect(oc!.resolution.state).toBe('review');
    expect((await t.market.reviews.col.findOne({ _id: oc!.resolution.reviewItemId! }))!.severity).toBe(
      'high',
    );
    // A row with the creator's CRN and another name never creates a second holder of the key.
    const d = await directory('m8-rv7-uniform-d');
    await importFile(d, `${HEADER}\nUniform Engineering Ltd,,GB,,04791001\n`);
    const [od] = await observationsOf(d._id);
    if (od!.resolution.state === 'resolved') expect(od!.resolution.entityId).toBe(created._id);
    const holders = await t.market.companies.col.find({ identityKeys: key }).toArray();
    expect(holders.map((h) => h._id)).toEqual([created._id]);
  });

  it('rv7 H3 Race B: a release planned before a newer observation carried the key never removes it (fenced in the commit)', async () => {
    const src = await directory('m8-rv7-victor-1');
    const other = await directory('m8-rv7-victor-2');
    const CRN = { namespace: 'gb_companies_house', id: '04791003' };
    const DUNS = { namespace: 'duns', id: '150483782' };
    const DUNS_KEY = 'ext:duns:150483782';
    const input = (sourceId: string, ids: Array<{ namespace: string; id: string }>, at?: Date) => ({
      sourceId,
      locator: 'row:2',
      externalId: sourceId === src._id ? 'id:victor-r1' : 'gb_companies_house:04791003',
      payload: {
        name: 'Victor Tools Ltd',
        legalName: 'Victor Tools Ltd',
        aliases: [],
        domain: null,
        website: null,
        externalIds: ids,
        locations: [{ country: 'GB', kind: 'hq' as const }],
        industries: [],
        careersUrl: null,
      },
      parser: COMPANY_DIRECTORY_PARSER,
      ...(at ? { sourceObservedAt: at } : {}),
    });
    const first = await t.market.companyPipeline.process(
      input(src._id, [CRN, DUNS], new Date('2026-01-01T00:00:00Z')),
    );
    const companyId = (first as { companyId: string }).companyId;
    expect((await t.market.companies.get(companyId)).identityKeys).toContain(DUNS_KEY);
    // The corrected row (no D-U-N-S) plans the release; right after its commit — before anything
    // else it does — a newer observation carrying the D-U-N-S links and reconciles.
    const rec = t.market.companyReconciler as unknown as {
      commit: (plan: { company: { _id: string }; releaseKeys: string[] }) => Promise<boolean>;
    };
    const commit = rec.commit.bind(rec);
    let planned: string[] | null = null;
    rec.commit = async (plan) => {
      const ok = await commit(plan);
      if (ok && planned === null && plan.company._id === companyId) {
        planned = plan.releaseKeys;
        await t.market.companyPipeline.process(input(other._id, [CRN, DUNS]));
      }
      return ok;
    };
    try {
      await t.market.companyPipeline.process(input(src._id, [CRN], new Date('2026-02-01T00:00:00Z')));
    } finally {
      delete (rec as { commit?: unknown }).commit;
    }
    expect(planned).toContain(DUNS_KEY);
    const c = await t.market.companies.get(companyId);
    expect(c.identityKeys).toContain(DUNS_KEY);
    expect(c.identity.externalIds).toContainEqual(DUNS);
    await t.market.companyReconciler.reconcile(companyId);
    expect((await t.market.companies.get(companyId)).identityKeys).toContain(DUNS_KEY);
    // A later row with that D-U-N-S number and another name finds no free key to claim.
    const later = await directory('m8-rv7-victor-3', {
      columns: { ...COLUMNS, registerIds: { duns: 'DUNS' } },
    });
    await importFile(later, 'Company,Domain,Country,Careers,DUNS\nVictor Engineering Ltd,,GB,,150483782\n');
    const holders = await t.market.companies.col.find({ identityKeys: DUNS_KEY }).toArray();
    expect(holders.map((h) => h._id)).toEqual([companyId]);
  });

  it('rv7 L6: a dismissal also covers any subset of its id set (dismiss {1,2,3}, reject 3 → nothing re-raised)', async () => {
    const first = await directory('m8-rv7-whiskey-1');
    await importFile(first, `${HEADER}\nWhiskey Tools Ltd,,GB,,04791011\n`);
    const [o1] = await observationsOf(first._id);
    const companyId = o1!.resolution.entityId!;
    const mergeIn = async (key: string, crn: string) => {
      const src = await directory(key);
      await importFile(src, `${HEADER}\nWHISKEY TOOLS LIMITED,,GB,,${crn}\n`);
      const [o] = await observationsOf(src._id);
      await t.market.reviewService.resolve(
        o!.resolution.reviewItemId!,
        { action: 'merge', targetId: companyId, reason: 'same company' },
        t.actor,
      );
      return o!;
    };
    await mergeIn('m8-rv7-whiskey-2', '09791012');
    const o3 = await mergeIn('m8-rv7-whiskey-3', '09791013');
    const dedupeKey = `field_conflict:company:${companyId}:externalIds:gb_companies_house`;
    const open = (await t.market.reviews.col.findOne({ dedupeKey, status: 'open' }))!;
    expect(open.context).toMatchObject({ values: ['04791011', '09791012', '09791013'] });
    await t.market.reviewService.resolve(open._id, { action: 'dismiss', reason: 'all right' }, t.actor);
    await t.market.observations.setCompanyResolution([o3._id], {
      state: 'rejected',
      resolverVersion: 'operator',
    });
    await t.market.companyReconciler.reconcile(companyId);
    expect((await t.market.companies.get(companyId)).quality.conflictFields).toContain(
      'identity.externalIds',
    );
    expect(await t.market.reviews.col.countDocuments({ dedupeKey, status: 'open' })).toBe(0);
  });

  it('rv7 H1/H2 canary: the five reviewer rows and a +61 name leave no marker outside the raw upload', async () => {
    const source = await directory('m8-rv7-canary', {
      columns: { ...COLUMNS, legalName: 'Legal', town: 'Town' },
    });
    const csv = [
      `${HEADER},Legal,Town`,
      '"Jane Smith zqlaa at smith-consult dot ae",smith-consult-a.co.uk,GB,,,,',
      '"zqlab[at]acme[.]com Trading",zqlab-co.co.uk,GB,,,,',
      'Clean Lac Ltd,clean-lac.co.uk,GB,,,"zqlac(at)acme(.)co(.)uk",',
      'Clean Lad Ltd,clean-lad.co.uk,GB,,,,"zqlad at acme dot sg"',
      'Clean Lae Ltd,clean-lae.co.uk,GB,https://clean-lae.co.uk/careers/zqlae-at-acme-dot-ae,,,',
      '"Zqlaf Jane +61 412 345 674 Pty Ltd",zqlaf.com.au,AU,,,,',
    ].join('\n');
    const { artifactId, snapshotId } = await importFile(source, csv);
    const report = await finalReport<{ errors: unknown[]; rowWarnings: unknown[] }>(snapshotId);
    expect(report.errors).toHaveLength(3);
    expect(report.rowWarnings).toHaveLength(3);
    const canaries = ['zqlaa', 'zqlab', 'zqlac', 'zqlad', 'zqlae', 'zqlaf', '412 345 674'];
    const hits: string[] = [];
    for (const { name } of await infra.db.listCollections({}, { nameOnly: true }).toArray())
      for await (const doc of infra.db.collection(name).find({})) {
        const text = withoutIds(JSON.stringify(doc).toLowerCase());
        for (const c of canaries) if (text.includes(c)) hits.push(`${name}/${String(doc._id)}: ${c}`);
      }
    for await (const a of infra.db.collection<{ _id: string }>('artifacts').find({})) {
      if (a._id === artifactId) continue;
      const text = Buffer.from(await infra.artifacts.readBytes({ artifactId: a._id }))
        .toString('utf8')
        .toLowerCase()
        .replace(ID_PATTERN, '');
      for (const c of canaries) if (text.includes(c)) hits.push(`artifact ${a._id}: ${c}`);
    }
    expect(hits).toEqual([]);
  });

  it('rv8 canary: the reviewer rows (spelled-dot .co emails, LinkedIn slugs) leave no marker outside the raw upload', async () => {
    const source = await directory('m8-rv8-canary', { columns: { ...COLUMNS, legalName: 'Legal' } });
    const csv = [
      `${HEADER},Legal`,
      'zqt1 at acme dot co,zqt1-co.co.uk,GB,,,',
      '"Jane zqt2 [at] acme dot co Trading",zqt2-co.co.uk,GB,,,',
      'zqt3 arroba acme dot co,zqt3-co.co.uk,GB,,,',
      'Clean Ta Ltd,clean-ta.co.uk,GB,,,zqt4 at mail dot acme dot co',
      'Clean Tb Ltd,clean-tb.co.uk,GB,https://tb.co.uk/careers/zqt5-at-acme-dot-co,,',
      'Clean Tc Ltd,clean-tc.co.uk,GB,https://www.linkedin.com/jobs/view/zqt6-at-acme-dot-com-3912345678,,',
      'Clean Td Ltd,clean-td.co.uk,GB,https://www.linkedin.com/company/07700900755,,',
      'Clean Te Ltd,clean-te.co.uk,GB,https://www.linkedin.com/jobs/view/call-07700-900-844-3912345678,,',
      'Clean Tf Ltd,clean-tf.co.uk,GB,https://www.linkedin.com/jobs/view/07700900133,,',
    ].join('\n');
    const { artifactId, snapshotId } = await importFile(source, csv);
    const report = await finalReport<{ errors: unknown[]; rowWarnings: unknown[] }>(snapshotId);
    expect(report.errors).toHaveLength(3);
    expect(report.rowWarnings).toHaveLength(6);
    const canaries = [
      'zqt1',
      'zqt2',
      'zqt3',
      'zqt4',
      'zqt5',
      'zqt6',
      '07700900755',
      '900-844',
      '07700900133',
    ];
    const hits: string[] = [];
    for (const { name } of await infra.db.listCollections({}, { nameOnly: true }).toArray())
      for await (const doc of infra.db.collection(name).find({})) {
        const text = withoutIds(JSON.stringify(doc).toLowerCase());
        for (const c of canaries) if (text.includes(c)) hits.push(`${name}/${String(doc._id)}: ${c}`);
      }
    for await (const a of infra.db.collection<{ _id: string }>('artifacts').find({})) {
      if (a._id === artifactId) continue;
      const text = Buffer.from(await infra.artifacts.readBytes({ artifactId: a._id }))
        .toString('utf8')
        .toLowerCase()
        .replace(ID_PATTERN, '');
      for (const c of canaries) if (text.includes(c)) hits.push(`artifact ${a._id}: ${c}`);
    }
    expect(hits).toEqual([]);
  });

  it('rv8 M-1: an observation linked between compute() and commit() fails the plan’s revision check; the key stays, no second holder', async () => {
    const src = await directory('m8-rv8-xray-1');
    const other = await directory('m8-rv8-xray-2');
    const CRN = { namespace: 'gb_companies_house', id: '04791103' };
    const DUNS = { namespace: 'duns', id: '150483790' };
    const DUNS_KEY = 'ext:duns:150483790';
    const input = (sourceId: string, ids: Array<{ namespace: string; id: string }>, at?: Date) => ({
      sourceId,
      locator: 'row:2',
      externalId: sourceId === src._id ? 'id:xray-r1' : 'gb_companies_house:04791103',
      payload: {
        name: 'Xray Tools Ltd',
        legalName: 'Xray Tools Ltd',
        aliases: [],
        domain: null,
        website: null,
        externalIds: ids,
        locations: [{ country: 'GB', kind: 'hq' as const }],
        industries: [],
        careersUrl: null,
      },
      parser: COMPANY_DIRECTORY_PARSER,
      ...(at ? { sourceObservedAt: at } : {}),
    });
    const first = await t.market.companyPipeline.process(
      input(src._id, [CRN, DUNS], new Date('2026-01-01T00:00:00Z')),
    );
    const companyId = (first as { companyId: string }).companyId;
    // Hook between compute() and commit(): the corrected row (CRN only) has planned to release the
    // D-U-N-S key; another source's observation carrying it links to the company before the commit.
    const rec = t.market.companyReconciler as unknown as {
      compute: (id: string) => Promise<{ company: { _id: string }; releaseKeys: string[] }>;
    };
    const compute = rec.compute.bind(rec);
    let planned: string[] | null = null;
    let linked = false;
    rec.compute = async (id) => {
      const plan = await compute(id);
      if (!linked && id === companyId && plan.releaseKeys.includes(DUNS_KEY)) {
        linked = true;
        planned = plan.releaseKeys;
        const o = await t.market.observations.recordCompanyObservation(input(other._id, [CRN, DUNS]));
        await t.market.observations.setCompanyResolution([o.observation._id], {
          state: 'resolved',
          entityId: companyId,
          method: 'external_id',
          confidence: 'high',
          resolverVersion: 'test',
        });
      }
      return plan;
    };
    try {
      await t.market.companyPipeline.process(input(src._id, [CRN], new Date('2026-02-01T00:00:00Z')));
    } finally {
      delete (rec as { compute?: unknown }).compute;
    }
    expect(planned).toContain(DUNS_KEY);
    const c = await t.market.companies.get(companyId);
    expect(c.identityKeys).toContain(DUNS_KEY);
    expect(c.identity.externalIds).toContainEqual(DUNS);
    const third = await directory('m8-rv8-xray-3', {
      columns: { ...COLUMNS, registerIds: { duns: 'DUNS' } },
    });
    await importFile(third, 'Company,Domain,Country,Careers,DUNS\nXray Engineering Ltd,,GB,,150483790\n');
    const holders = await t.market.companies.col.find({ identityKeys: DUNS_KEY }).toArray();
    expect(holders.map((h) => h._id)).toEqual([companyId]);
  });

  it('rv8 M-1: a stale plan whose commit lands right after the link write (inside the link transaction) fails its revision check; the key stays, no second holder', async () => {
    const src = await directory('m8-rv8-zulu-1');
    const other = await directory('m8-rv8-zulu-2');
    const CRN = { namespace: 'gb_companies_house', id: '04791203' };
    const DUNS = { namespace: 'duns', id: '150483804' };
    const DUNS_KEY = 'ext:duns:150483804';
    const input = (sourceId: string, ids: Array<{ namespace: string; id: string }>, at?: Date) => ({
      sourceId,
      locator: 'row:2',
      externalId: sourceId === src._id ? 'id:zebra-r1' : 'gb_companies_house:04791203',
      payload: {
        name: 'Zebra Tools Ltd',
        legalName: 'Zebra Tools Ltd',
        aliases: [],
        domain: null,
        website: null,
        externalIds: ids,
        locations: [{ country: 'GB', kind: 'hq' as const }],
        industries: [],
        careersUrl: null,
      },
      parser: COMPANY_DIRECTORY_PARSER,
      ...(at ? { sourceObservedAt: at } : {}),
    });
    const first = await t.market.companyPipeline.process(
      input(src._id, [CRN, DUNS], new Date('2026-01-01T00:00:00Z')),
    );
    const companyId = (first as { companyId: string }).companyId;
    const pending = await t.market.observations.recordCompanyObservation(input(other._id, [CRN, DUNS]));
    // The interleaving: (1) the corrected row's reconciliation computes a plan releasing the
    // D-U-N-S key; (2) another observation carrying it is linked — the link write is done but its
    // transaction has not committed; (3) the plan's commit is issued at exactly that point.
    const signal = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      return { promise, resolve };
    };
    const linkWritten = signal();
    const commitIssued = signal();
    // The link write is hooked on the driver (the service reads its collection per call).
    const proto = Collection.prototype as unknown as { updateMany: (...args: unknown[]) => Promise<unknown> };
    const updateMany = proto.updateMany;
    let hookLink = true;
    proto.updateMany = async function (this: Collection, ...args: unknown[]) {
      const res = await updateMany.apply(this, args);
      const filter = args[0] as { _id?: { $in?: string[] } };
      if (
        hookLink &&
        this.collectionName === 'market_company_observations' &&
        filter?._id?.$in?.includes(pending.observation._id)
      ) {
        hookLink = false;
        linkWritten.resolve();
        await commitIssued.promise;
      }
      return res;
    };
    const rec = t.market.companyReconciler as unknown as {
      compute: (id: string) => Promise<{ releaseKeys: string[] }>;
      commit: (plan: { releaseKeys: string[] }) => Promise<boolean>;
    };
    const compute = rec.compute.bind(rec);
    const commit = rec.commit.bind(rec);
    let planned: string[] | null = null;
    let link: Promise<void> | null = null;
    const commits: boolean[] = [];
    rec.compute = async (id) => {
      const plan = await compute(id);
      if (!link && id === companyId && plan.releaseKeys.includes(DUNS_KEY)) {
        planned = plan.releaseKeys;
        link = t.market.observations.setCompanyResolution([pending.observation._id], {
          state: 'resolved',
          entityId: companyId,
          method: 'external_id',
          confidence: 'high',
          resolverVersion: 'test',
        });
        await linkWritten.promise;
      }
      return plan;
    };
    rec.commit = async (plan) => {
      const issued = commits.length === 0;
      const done = commit(plan);
      if (issued) commitIssued.resolve();
      const ok = await done;
      commits.push(ok);
      return ok;
    };
    try {
      await t.market.companyPipeline.process(input(src._id, [CRN], new Date('2026-02-01T00:00:00Z')));
      await link;
    } finally {
      delete (rec as { compute?: unknown }).compute;
      delete (rec as { commit?: unknown }).commit;
      proto.updateMany = updateMany;
    }
    expect(planned).toContain(DUNS_KEY);
    // The stale plan's commit lost its revision check; the recomputed plan committed.
    expect(commits[0]).toBe(false);
    expect(commits.at(-1)).toBe(true);
    const c = await t.market.companies.get(companyId);
    expect(c.identityKeys).toContain(DUNS_KEY);
    expect(c.identity.externalIds).toContainEqual(DUNS);
    const third = await directory('m8-rv8-zulu-3', {
      columns: { ...COLUMNS, registerIds: { duns: 'DUNS' } },
    });
    await importFile(third, 'Company,Domain,Country,Careers,DUNS\nZebra Engineering Ltd,,GB,,150483804\n');
    const holders = await t.market.companies.col.find({ identityKeys: DUNS_KEY }).toArray();
    expect(holders.map((h) => h._id)).toEqual([companyId]);
  });

  it('rv8 M-1: linking an observation and superseding a linked version advance the company revision', async () => {
    const src = await directory('m8-rv8-yoke');
    const created = (await t.market.companies.createFromCandidate({
      name: 'Yoke Tools Ltd',
      hqCountry: 'GB',
    }))!;
    const rev = async () => (await t.market.companies.get(created._id)).rev ?? 0;
    const payload = (name: string) => ({
      name,
      legalName: name,
      aliases: [],
      domain: null,
      website: null,
      externalIds: [],
      locations: [{ country: 'GB', kind: 'hq' as const }],
      industries: [],
      careersUrl: null,
    });
    const v1 = await t.market.observations.recordCompanyObservation({
      sourceId: src._id,
      externalId: 'id:yoke-r1',
      payload: payload('Yoke Tools Ltd'),
      parser: COMPANY_DIRECTORY_PARSER,
      sourceObservedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const r0 = await rev();
    await t.market.observations.setCompanyResolution([v1.observation._id], {
      state: 'resolved',
      entityId: created._id,
      method: 'name_exact',
      confidence: 'high',
      resolverVersion: 'test',
    });
    const r1 = await rev();
    expect(r1).toBe(r0 + 1);
    await t.market.observations.recordCompanyObservation({
      sourceId: src._id,
      externalId: 'id:yoke-r1',
      payload: payload('Yoke Tools Limited'),
      parser: COMPANY_DIRECTORY_PARSER,
      sourceObservedAt: new Date('2026-02-01T00:00:00Z'),
    });
    expect(await rev()).toBe(r1 + 1);
    // Re-seeing an unchanged record changes nothing: no bump.
    await t.market.observations.recordCompanyObservation({
      sourceId: src._id,
      externalId: 'id:yoke-r1',
      payload: payload('Yoke Tools Limited'),
      parser: COMPANY_DIRECTORY_PARSER,
      sourceObservedAt: new Date('2026-02-01T00:00:00Z'),
    });
    expect(await rev()).toBe(r1 + 1);
  });

  it('rv9 canary: host @ / host phone / dashed-dot rows leave no marker outside the raw upload; no phone domain becomes identity', async () => {
    const source = await directory('m8-rv9-canary', {
      columns: { ...COLUMNS, legalName: 'Legal', website: 'Website' },
    });
    const csv = [
      `${HEADER},Legal,Website`,
      'Clean Ua Ltd,clean-ua.co.uk,GB,https://zqu1&commat;acme.com/careers,,,',
      'Clean Ub Ltd,clean-ub.co.uk,GB,https://zqu2%26commat%3Bacme.com/careers,,,',
      'Clean Uc Ltd,clean-uc.co.uk,GB,,,,https://call-07700-900199.acme.co.uk/',
      'Vesperine Holdings Ltd,07700900188.co.uk,GB,,04791399,,',
      'zqu3 at acme – dot – com,zqu3-co.co.uk,GB,,,,',
      'Clean Ue Ltd,clean-ue.co.uk,GB,,,zqu4 at acme — dot — com,',
    ].join('\n');
    const { artifactId, snapshotId } = await importFile(source, csv);
    const report = await finalReport<{ errors: unknown[]; rowWarnings: unknown[] }>(snapshotId);
    expect(report.errors).toHaveLength(1);
    expect(report.rowWarnings).toHaveLength(5);
    const canaries = ['zqu1', 'zqu2', '900199', '07700900188', 'zqu3', 'zqu4'];
    const hits: string[] = [];
    for (const { name } of await infra.db.listCollections({}, { nameOnly: true }).toArray())
      for await (const doc of infra.db.collection(name).find({})) {
        const text = withoutIds(JSON.stringify(doc).toLowerCase());
        for (const c of canaries) if (text.includes(c)) hits.push(`${name}/${String(doc._id)}: ${c}`);
      }
    for await (const a of infra.db.collection<{ _id: string }>('artifacts').find({})) {
      if (a._id === artifactId) continue;
      const text = Buffer.from(await infra.artifacts.readBytes({ artifactId: a._id }))
        .toString('utf8')
        .toLowerCase()
        .replace(ID_PATTERN, '');
      for (const c of canaries) if (text.includes(c)) hits.push(`artifact ${a._id}: ${c}`);
    }
    expect(hits).toEqual([]);
    const ud = (await observationsOf(source._id)).find((o) => o.payload.name === 'Vesperine Holdings Ltd')!;
    expect(ud.payload.domain).toBeNull();
    expect(ud.resolution.state).toBe('resolved');
    expect((await t.market.companies.get(ud.resolution.entityId!)).identity.domain.value).toBeNull();
  });

  /** Company C holds D-U-N-S key K; row X resolves to C by K; before X links, C's record is corrected (K released). */
  async function openCase(key: string, crn: string, duns: string, beforeLink: (c: string) => Promise<void>) {
    const src = await directory(`m8-rv9-${key}-c`);
    const xs = await directory(`m8-rv9-${key}-x`);
    const DUNS = { namespace: 'duns', id: duns };
    const K = `ext:duns:${duns}`;
    const input = (
      sourceId: string,
      ids: Array<{ namespace: string; id: string }>,
      name: string,
      at?: Date,
    ) => ({
      sourceId,
      locator: 'row:2',
      externalId: sourceId === src._id ? `id:${key}-r1` : `duns:${duns}`,
      payload: {
        name,
        legalName: name,
        aliases: [],
        domain: null,
        website: null,
        externalIds: ids,
        locations: [{ country: 'GB', kind: 'hq' as const }],
        industries: [],
        careersUrl: null,
      },
      parser: COMPANY_DIRECTORY_PARSER,
      ...(at ? { sourceObservedAt: at } : {}),
    });
    const name = `${key[0]!.toUpperCase()}${key.slice(1)} Tools Ltd`;
    const CRN = { namespace: 'gb_companies_house', id: crn };
    const first = await t.market.companyPipeline.process(
      input(src._id, [CRN, DUNS], name, new Date('2026-01-01T00:00:00Z')),
    );
    const companyId = (first as { companyId: string }).companyId;
    const xInput = input(xs._id, [DUNS], name);
    const xId = t.market.observations.companyObservationId(xs._id, xInput.externalId, xInput.payload);
    const obs = t.market.observations as unknown as {
      setCompanyResolution: (ids: string[], r: { entityId?: string }, o?: object) => Promise<void>;
    };
    const original = obs.setCompanyResolution.bind(obs);
    let fired = false;
    obs.setCompanyResolution = async (ids, r, o) => {
      if (!fired && ids.includes(xId) && r.entityId === companyId) {
        fired = true;
        // C's record is corrected (no D-U-N-S): its reconciliation releases K.
        await t.market.companyPipeline.process(input(src._id, [CRN], name, new Date('2026-02-01T00:00:00Z')));
        expect((await t.market.companies.get(companyId)).identityKeys).not.toContain(K);
        await beforeLink(companyId);
      }
      return original(ids, r, o);
    };
    let x;
    try {
      x = await t.market.companyPipeline.process(xInput);
    } finally {
      delete (obs as { setCompanyResolution?: unknown }).setCompanyResolution;
    }
    expect(fired).toBe(true);
    return { companyId, K, x, xId, duns };
  }

  it('rv9 L-1: the link claims the observation’s register-id key in its transaction — a later row cannot create a second holder', async () => {
    const { companyId, K, x, duns } = await openCase('quill', '04791301', '150483812', async () => {});
    expect(x).toMatchObject({ outcome: 'matched', companyId });
    expect((await t.market.companies.get(companyId)).identityKeys).toContain(K);
    const y = await directory('m8-rv9-quill-y', { columns: { ...COLUMNS, registerIds: { duns: 'DUNS' } } });
    await importFile(y, `Company,Domain,Country,Careers,DUNS\nQuill Engineering Ltd,,GB,,${duns}\n`);
    const holders = await t.market.companies.col.find({ identityKeys: K }).toArray();
    expect(holders.map((h) => h._id)).toEqual([companyId]);
  });

  it('rv9 L-1: when another company took the key before the link, the link aborts and the observation re-resolves (never linked to C without the key)', async () => {
    let other: string | undefined;
    const { companyId, K, x, xId } = await openCase('kappa', '04791311', '150483838', async () => {
      const y = await directory('m8-rv9-kappa-y', { columns: { ...COLUMNS, registerIds: { duns: 'DUNS' } } });
      await importFile(y, 'Company,Domain,Country,Careers,DUNS\nKappa Engineering Ltd,,GB,,150483838\n');
      const [oy] = await observationsOf(y._id);
      other = oy!.resolution.entityId!;
    });
    expect(other).toBeDefined();
    expect(other).not.toBe(companyId);
    const xo = (await t.market.observations.companyObservations.findOne({ _id: xId }))!;
    expect(xo.resolution.entityId === companyId && xo.resolution.state === 'resolved').toBe(false);
    expect(x.outcome).not.toBe('matched');
    const holders = await t.market.companies.col.find({ identityKeys: K }).toArray();
    expect(holders.map((h) => h._id)).toEqual([other]);
  });

  it('rv9 L-4: a link to a company merged meanwhile lands on the survivor, and only the active survivor is bumped', async () => {
    const src = await directory('m8-rv9-lima');
    const a = (await t.market.companies.createFromCandidate({ name: 'Mango Tools Ltd', hqCountry: 'GB' }))!;
    const b = (await t.market.companies.createFromCandidate({
      name: 'Mango Tools (UK) Ltd',
      hqCountry: 'GB',
    }))!;
    await t.market.companies.merge(b._id, a._id, t.actor, 'same company');
    const o = await t.market.observations.recordCompanyObservation({
      sourceId: src._id,
      externalId: 'id:mango-r1',
      payload: {
        name: 'Mango Tools Ltd',
        legalName: 'Mango Tools Ltd',
        aliases: [],
        domain: null,
        website: null,
        externalIds: [],
        locations: [{ country: 'GB', kind: 'hq' as const }],
        industries: [],
        careersUrl: null,
      },
      parser: COMPANY_DIRECTORY_PARSER,
    });
    const revA = (await t.market.companies.get(a._id)).rev ?? 0;
    const revB = (await t.market.companies.get(b._id)).rev ?? 0;
    await t.market.observations.setCompanyResolution([o.observation._id], {
      state: 'resolved',
      entityId: a._id,
      method: 'name_exact',
      confidence: 'high',
      resolverVersion: 'test',
    });
    const linked = (await t.market.observations.companyObservations.findOne({ _id: o.observation._id }))!;
    expect(linked.resolution.entityId).toBe(b._id);
    expect((await t.market.companies.get(b._id)).rev).toBe(revB + 1);
    expect((await t.market.companies.get(a._id)).rev ?? 0).toBe(revA);
  });

  it('rv9 L-3: the make-current bump reads the observation inside the transaction (a link made after the caller read it counts)', async () => {
    const src = await directory('m8-rv9-nectar');
    const company = (await t.market.companies.createFromCandidate({
      name: 'Nectar Tools Ltd',
      hqCountry: 'GB',
    }))!;
    const payload = {
      name: 'Nectar Tools Ltd',
      legalName: 'Nectar Tools Ltd',
      aliases: [],
      domain: null,
      website: null,
      externalIds: [],
      locations: [{ country: 'GB', kind: 'hq' as const }],
      industries: [],
      careersUrl: null,
    };
    const rec = await t.market.observations.recordCompanyObservation({
      sourceId: src._id,
      externalId: 'id:nectar-r1',
      payload,
      parser: COMPANY_DIRECTORY_PARSER,
    });
    // The caller's copy says "superseded, pending"; in the database the version is linked to the company.
    await t.market.observations.companyObservations.updateOne(
      { _id: rec.observation._id },
      {
        $set: {
          superseded: true,
          resolution: { state: 'resolved', entityId: company._id, method: 'name_exact', confidence: 'high' },
        },
      },
    );
    const stale = { ...rec.observation, superseded: true, resolution: { state: 'pending' as const } };
    const before = (await t.market.companies.get(company._id)).rev ?? 0;
    const svc = t.market.observations as unknown as {
      markCurrent: (col: unknown, obs: unknown) => Promise<void>;
    };
    await svc.markCurrent(t.market.observations.companyObservations, stale);
    expect((await t.market.companies.get(company._id)).rev).toBe(before + 1);
    expect(
      (await t.market.observations.companyObservations.findOne({ _id: rec.observation._id }))!.superseded,
    ).toBe(false);
  });

  const dirPayload = (name: string, ids: Array<{ namespace: string; id: string }>) => ({
    name,
    legalName: name,
    aliases: [],
    domain: null,
    website: null,
    externalIds: ids,
    locations: [{ country: 'GB', kind: 'hq' as const }],
    industries: [],
    careersUrl: null,
  });

  it('rv10 H-3 (Wren Tools): a link after a concurrent contradicting claim aborts — the row goes to a high review, never a union', async () => {
    const wren = (await t.market.companies.createFromCandidate({ name: 'Wren Tools Ltd', hqCountry: 'GB' }))!;
    const xs = await directory('m8-rv10-wren-x');
    const ys = await directory('m8-rv10-wren-y');
    const x = {
      sourceId: xs._id,
      locator: 'row:2',
      externalId: 'gb_companies_house:04797101',
      payload: dirPayload('Wren Tools Ltd', [{ namespace: 'gb_companies_house', id: '04797101' }]),
      parser: COMPANY_DIRECTORY_PARSER,
    };
    const xId = t.market.observations.companyObservationId(x.sourceId, x.externalId, x.payload);
    const obs = t.market.observations as unknown as {
      setCompanyResolution: (ids: string[], r: { entityId?: string }, o?: object) => Promise<void>;
    };
    const original = obs.setCompanyResolution.bind(obs);
    let y: unknown;
    obs.setCompanyResolution = async (ids, r, o) => {
      if (!y && ids.includes(xId) && r.entityId === wren._id) {
        // X resolved to Wren by name; before X links, Y (same name, another company number) links.
        y = await t.market.companyPipeline.process({
          ...x,
          sourceId: ys._id,
          externalId: 'gb_companies_house:04797102',
          payload: dirPayload('Wren Tools Ltd', [{ namespace: 'gb_companies_house', id: '04797102' }]),
        });
      }
      return original(ids, r, o);
    };
    let out;
    try {
      out = await t.market.companyPipeline.process(x);
    } finally {
      delete (obs as { setCompanyResolution?: unknown }).setCompanyResolution;
    }
    expect(y).toMatchObject({ outcome: 'matched', companyId: wren._id });
    expect(out).toMatchObject({ outcome: 'review' });
    const xo = (await t.market.observations.companyObservations.findOne({ _id: xId }))!;
    expect(xo.resolution.state).toBe('review');
    const item = (await t.market.reviews.col.findOne({ _id: xo.resolution.reviewItemId! }))!;
    expect(item.severity).toBe('high');
    const company = await t.market.companies.get(wren._id);
    expect(company.identity.externalIds).toEqual([{ namespace: 'gb_companies_house', id: '04797102' }]);
    expect(company.quality.conflictFields).not.toContain('identity.externalIds');
    expect(company.identityKeys).not.toContain('ext:gb_companies_house:04797101');
  });

  it('rv10 H-3: 9 files imported concurrently never leave a company holding two contradicting single-valued ids', async () => {
    await t.market.companies.createFromCandidate({ name: 'Orca Tools Ltd', hqCountry: 'GB' });
    const crns = ['04797201', '04797202', '04797203'];
    const sources = await Promise.all(Array.from({ length: 9 }, (_, k) => directory(`m8-rv10-orca-${k}`)));
    await Promise.all(
      sources.map((src, k) =>
        importFile(
          src,
          [
            HEADER,
            `Orca Tools Ltd,,GB,,${crns[k % 3]}`,
            `ORCA TOOLS LIMITED,,GB,,${crns[(k + 1) % 3]}`,
            `Orca Marine Ltd,,GB,,0479721${k}`,
          ].join('\n'),
        ),
      ),
    );
    const orcas = await t.market.companies.col
      .find({ 'identity.displayName.value': { $regex: '^orca', $options: 'i' } })
      .toArray();
    expect(orcas.length).toBeGreaterThan(0);
    for (const c of orcas) {
      expect(conflictingIdNamespaces(c.identity.externalIds).size).toBe(0);
      expect(
        conflictingIdNamespaces(
          c.identityKeys
            .filter((k) => k.startsWith('ext:'))
            .map((k) => ({ namespace: k.split(':')[1]!, id: k.split(':').slice(2).join(':') })),
        ).size,
      ).toBe(0);
    }
    // Every Orca Tools row is linked to a company holding its own number, or is in review.
    const obs = (await Promise.all(sources.map((s) => observationsOf(s._id)))).flat();
    for (const o of obs.filter((x) => x.resolution.state === 'resolved')) {
      const c = await t.market.companies.get(o.resolution.entityId!);
      for (const e of o.payload.externalIds) expect(c.identity.externalIds).toContainEqual(e);
    }
  });

  it('rv10 L-4: a merge loop is an InvalidStateError; a broken chain is NotFound', async () => {
    const src = await directory('m8-rv10-loop');
    const a = (await t.market.companies.createFromCandidate({ name: 'Looping A Ltd', hqCountry: 'GB' }))!;
    const b = (await t.market.companies.createFromCandidate({ name: 'Looping B Ltd', hqCountry: 'GB' }))!;
    const c = (await t.market.companies.createFromCandidate({ name: 'Broken C Ltd', hqCountry: 'GB' }))!;
    await t.market.companies.col.updateOne({ _id: a._id }, { $set: { status: 'merged', mergedInto: b._id } });
    await t.market.companies.col.updateOne({ _id: b._id }, { $set: { status: 'merged', mergedInto: a._id } });
    await t.market.companies.col.updateOne(
      { _id: c._id },
      { $set: { status: 'merged', mergedInto: 'cmp_does_not_exist' } },
    );
    const o = await t.market.observations.recordCompanyObservation({
      sourceId: src._id,
      externalId: 'id:loop-r1',
      payload: dirPayload('Looping A Ltd', []),
      parser: COMPANY_DIRECTORY_PARSER,
    });
    const link = (entityId: string) =>
      t.market.observations.setCompanyResolution([o.observation._id], {
        state: 'resolved',
        entityId,
        method: 'name_exact',
        confidence: 'high',
        resolverVersion: 'test',
      });
    await expect(link(a._id)).rejects.toMatchObject({ name: 'InvalidStateError' });
    await expect(link(c._id)).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(
      (await t.market.observations.companyObservations.findOne({ _id: o.observation._id }))!.resolution.state,
    ).toBe('pending');
  });

  it('rv10 L-2: a resolved version superseded by its own step 3 (a later version visible) bumps its company', async () => {
    const src = await directory('m8-rv10-pike');
    const company = (await t.market.companies.createFromCandidate({
      name: 'Pike Tools Ltd',
      hqCountry: 'GB',
    }))!;
    const v1 = await t.market.observations.recordCompanyObservation({
      sourceId: src._id,
      externalId: 'id:pike-r1',
      payload: dirPayload('Pike Tools Ltd', []),
      parser: COMPANY_DIRECTORY_PARSER,
      sourceObservedAt: new Date('2026-01-01T00:00:00Z'),
    });
    await t.market.observations.setCompanyResolution([v1.observation._id], {
      state: 'resolved',
      entityId: company._id,
      method: 'name_exact',
      confidence: 'high',
      resolverVersion: 'test',
    });
    // A later version is visible but has not superseded v1 yet.
    await t.market.observations.companyObservations.insertOne({
      ...v1.observation,
      _id: 'cobs_pike_later_version_0000000',
      contentHash: 'later',
      sourceObservedAt: new Date('2026-02-01T00:00:00Z'),
      superseded: false,
      resolution: { state: 'pending' },
    });
    const before = (await t.market.companies.get(company._id)).rev ?? 0;
    const current = (await t.market.observations.companyObservations.findOne({ _id: v1.observation._id }))!;
    const svc = t.market.observations as unknown as {
      markCurrent: (col: unknown, obs: unknown) => Promise<void>;
    };
    await svc.markCurrent(t.market.observations.companyObservations, current);
    expect(
      (await t.market.observations.companyObservations.findOne({ _id: v1.observation._id }))!.superseded,
    ).toBe(true);
    expect((await t.market.companies.get(company._id)).rev).toBe(before + 1);
  });

  it(
    'rv11 L-5: 40 concurrent same-name rows with distinct CRNs against one bare company (3 rounds): one CRN, one key, every other row a high review',
    { timeout: 180_000 },
    async () => {
      const names = ['Tern Tools Ltd', 'Teal Tools Ltd', 'Tui Tools Ltd'];
      for (const [round, name] of names.entries()) {
        const company = (await t.market.companies.createFromCandidate({ name, hqCountry: 'GB' }))!;
        const src = await directory(`m8-rv11-fan-${round}`);
        const crns = Array.from({ length: 40 }, (_, k) => `0598${round}${String(k).padStart(3, '0')}`);
        const outcomes = await Promise.all(
          crns.map((crn) =>
            t.market.companyPipeline.process({
              sourceId: src._id,
              locator: `row:${crn}`,
              externalId: `gb_companies_house:${crn}`,
              payload: dirPayload(name, [{ namespace: 'gb_companies_house', id: crn }]),
              parser: COMPANY_DIRECTORY_PARSER,
            }),
          ),
        );
        const c = await t.market.companies.get(company._id);
        const held = c.identity.externalIds.filter((e) => e.namespace === 'gb_companies_house');
        expect(held).toHaveLength(1);
        expect(c.identityKeys.filter((k) => k.startsWith('ext:gb_companies_house:'))).toEqual([
          `ext:gb_companies_house:${held[0]!.id}`,
        ]);
        expect(c.quality.conflictFields).not.toContain('identity.externalIds');
        const obs = await observationsOf(src._id);
        expect(obs).toHaveLength(40);
        for (const o of obs) {
          if (o.payload.externalIds[0]!.id === held[0]!.id) {
            expect(o.resolution).toMatchObject({ state: 'resolved', entityId: company._id });
            continue;
          }
          expect(o.resolution.state).toBe('review');
          expect((await t.market.reviews.col.findOne({ _id: o.resolution.reviewItemId! }))!.severity).toBe(
            'high',
          );
        }
        expect(outcomes.filter((x) => x.outcome === 'matched')).toHaveLength(1);
      }
    },
  );
});
