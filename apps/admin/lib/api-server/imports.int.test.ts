import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  importDetailDto,
  importListDto,
  sourceDetailResponseDto,
  sourceListV2ResponseDto,
  sourceScheduleStateDto,
} from '@aptamind/market';
import { type ApiHarness, expectDto, expectValidationError, startApiHarness } from './market-test-harness';

/**
 * OPS-1 imports API (market-imports.md): a file upload makes a snapshot, a run and one import
 * record; refused files make no record; status and counts come from the run. Also the source
 * schedule state on the source APIs.
 */

let h: ApiHarness;
let companySourceId: string;
let boardSourceId: string;

const CSV = [
  'Company,Domain',
  'Api Orbit Ltd,api-orbit-ops1.co.uk',
  'Api Nimbus Ltd,api-nimbus-ops1.co.uk',
].join('\n');

async function upload(query: string, body: string, contentType = 'text/csv') {
  const res = await h.app.inject({
    method: 'POST',
    url: `/api/imports?${query}`,
    payload: body,
    headers: { 'content-type': contentType },
  });
  return { status: res.statusCode, body: res.json() as unknown };
}

const importCount = () => h.worker.mongo.db.collection('market_imports').countDocuments();

beforeAll(async () => {
  h = await startApiHarness('imports');
  const company = await h.post('/api/sources', {
    key: 'directory:api-imports',
    name: 'API imports directory',
    category: 'company_universe',
    provider: 'company_directory',
    acquisition: {
      workflowKey: 'market.company_directory.import',
      config: { columns: { name: 'Company', domain: 'Domain' } },
    },
    freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 100000 },
  });
  expect(company.status).toBe(201);
  companySourceId = (company.body as { source: { _id: string } }).source._id;
  const boards = await h.post('/api/sources', {
    key: 'boards:api-imports',
    name: 'API imports boards',
    category: 'manual_import',
    provider: 'ats_board_directory',
    acquisition: {
      workflowKey: 'market.ats_boards.import',
      config: { columns: { provider: 'Provider', token: 'Token', domain: 'Domain' } },
    },
    freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 100000 },
  });
  expect(boards.status).toBe(201);
  boardSourceId = (boards.body as { source: { _id: string } }).source._id;
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('POST /api/imports', () => {
  let firstId: string;
  let firstSnapshot: string;

  it('uploads a company file, starts the run and records the import', async () => {
    const res = await upload(`type=companies&sourceId=${companySourceId}&fileName=companies.csv`, CSV);
    expect(res.status).toBe(201);
    const created = expectDto(importDetailDto, res.body);
    expect(created).toMatchObject({
      type: 'companies',
      fileName: 'companies.csv',
      sourceId: companySourceId,
      snapshotUnchanged: false,
      source: { id: companySourceId, provider: 'company_directory' },
    });
    expect(created.runId).toEqual(expect.any(String));
    expect(created.bytes).toBe(Buffer.byteLength(CSV));
    firstId = created._id;
    firstSnapshot = created.snapshotId;

    await h.waitRun(created.runId!);
    const detail = expectDto(importDetailDto, (await h.get(`/api/imports/${firstId}`)).body);
    expect(detail.status).toBe('completed');
    expect(detail.counts).toEqual({
      rows: 2,
      parsed: 2,
      accepted: 2,
      created: 2,
      updated: 0,
      unchanged: 0,
      ignored: 0,
      failed: 0,
      reviews: 0,
      // One file warning: no id column is mapped.
      warnings: 1,
    });
    expect(detail.trace).toMatchObject({ runId: created.runId, snapshotId: firstSnapshot, truncated: false });
    // The file warning is in the report, so a report artifact is stored and linked (OPS-1b).
    expect(detail.trace.reportArtifactId).toEqual(expect.any(String));
    expect(detail.trace.companyIds).toHaveLength(2);
    expect(detail.finishedAt).not.toBeNull();
  });

  it('refuses a bad file before storage and records nothing', async () => {
    const before = await importCount();
    for (const body of [
      'Company,Domain,Email\nA Ltd,a-ops1.co.uk,x@a-ops1.co.uk',
      'Name,Site\nA Ltd,a.co.uk',
    ]) {
      const res = await upload(`type=companies&sourceId=${companySourceId}`, body);
      expect(res.status).toBe(400);
    }
    expect(await importCount()).toBe(before);
  });

  it('refuses a source of the wrong type, an unknown source and job imports', async () => {
    const before = await importCount();
    const wrong = await upload(`type=ats_boards&sourceId=${companySourceId}`, CSV);
    expectValidationError(wrong);
    expect(JSON.stringify(wrong.body)).toContain('wrong_source_type');
    const jobs = await upload(`type=jobs&sourceId=${companySourceId}`, CSV);
    expectValidationError(jobs);
    expect(JSON.stringify(jobs.body)).toContain('not_supported');
    expect((await upload(`type=companies&sourceId=src_missing`, CSV)).status).toBe(404);
    expectValidationError(await upload(`type=companies`, CSV));
    expectValidationError(await upload(`type=companies&sourceId=${companySourceId}&extra=1`, CSV));
    expect(await importCount()).toBe(before);
  });

  it('a re-upload of the same bytes is a new import of the same snapshot', async () => {
    const res = await upload(`type=companies&sourceId=${companySourceId}&fileName=again.csv`, CSV);
    expect(res.status).toBe(201);
    const again = expectDto(importDetailDto, res.body);
    expect(again._id).not.toBe(firstId);
    expect(again).toMatchObject({ snapshotId: firstSnapshot, snapshotUnchanged: true });
    await h.waitRun(again.runId!);
    const detail = expectDto(importDetailDto, (await h.get(`/api/imports/${again._id}`)).body);
    expect(detail.counts).toMatchObject({ created: 0, unchanged: 2 });
  });

  it('imports a known-board file and reports issues', async () => {
    const res = await upload(
      `type=ats_boards&sourceId=${boardSourceId}&fileName=boards.csv`,
      [
        'Provider,Token,Domain',
        'greenhouse,apiorbit,api-orbit-ops1.co.uk',
        'workday,x,api-orbit-ops1.co.uk',
      ].join('\n'),
    );
    expect(res.status).toBe(201);
    const created = expectDto(importDetailDto, res.body);
    await h.waitRun(created.runId!);
    const detail = expectDto(importDetailDto, (await h.get(`/api/imports/${created._id}`)).body);
    expect(detail.status).toBe('completed_with_issues');
    expect(detail.counts).toMatchObject({ rows: 2, created: 1, failed: 1, reviews: 1 });
    expect(detail.trace.sourceIds).toHaveLength(1);
  });
});

describe('GET /api/imports', () => {
  it('lists newest first with a cursor, and filters', async () => {
    const first = expectDto(importListDto, (await h.get('/api/imports?limit=2')).body);
    expect(first.items).toHaveLength(2);
    expect(first.items[0]!.type).toBe('ats_boards');
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = expectDto(
      importListDto,
      (await h.get(`/api/imports?limit=2&cursor=${first.nextCursor!}`)).body,
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map((i) => i._id);
    expect(new Set(ids).size).toBe(3);
    // The list row has no trace.
    expect(first.items[0]).not.toHaveProperty('trace');

    const companies = expectDto(importListDto, (await h.get('/api/imports?type=companies')).body);
    expect(companies.items.map((i) => i.type)).toEqual(['companies', 'companies']);
    const withIssues = expectDto(
      importListDto,
      (await h.get('/api/imports?status=completed_with_issues')).body,
    );
    expect(withIssues.items.map((i) => i.type)).toEqual(['ats_boards']);
    const bySource = expectDto(importListDto, (await h.get(`/api/imports?sourceId=${boardSourceId}`)).body);
    expect(bySource.items).toHaveLength(1);

    expectValidationError(await h.get('/api/imports?cursor=not-a-cursor'));
    expectValidationError(await h.get('/api/imports?limit=101'));
    expectValidationError(await h.get('/api/imports?status=done'));
  });

  it('returns 404 for an unknown import', async () => {
    expect((await h.get('/api/imports/imp_missing')).status).toBe(404);
  });
});

describe('source schedule state', () => {
  it('shows the scheduler state on the source list and detail', async () => {
    const list = expectDto(sourceListV2ResponseDto, (await h.get('/api/sources?limit=100&count=none')).body);
    const upload = list.items.find((s) => s._id === companySourceId)!;
    expect(upload.schedule).toBeNull();
    // A source with no scheduler entry has no schedule state (not a disabled one).
    expect(list.items.find((s) => s.key === 'system:operator')!.schedule).toBeNull();
    const discovery = list.items.find((s) => s.key === 'system:careers-discovery')!;
    expect(discovery.schedule).toMatchObject({
      intervalMinutes: 60,
      enabled: true,
      timezone: 'UTC',
      nextRunAt: expect.any(String),
    });

    const detail = expectDto(sourceDetailResponseDto, (await h.get(`/api/sources/${discovery._id}`)).body);
    expect(detail.source.schedule).toMatchObject({ intervalMinutes: 60, enabled: true });
    const uploadDetail = expectDto(
      sourceDetailResponseDto,
      (await h.get(`/api/sources/${companySourceId}`)).body,
    );
    expect(uploadDetail.source.schedule).toBeNull();
  });

  it('shows an active source backoff, and nextRunAt never claims a fire the backoff defers', async () => {
    const sources = h.worker.mongo.db.collection('market_sources');
    const discovery = await sources.findOne({ key: 'system:careers-discovery' });
    const until = new Date(Date.now() + 3 * 24 * 60 * 60_000);
    await sources.updateOne({ _id: discovery!._id }, { $set: { 'health.backoffUntil': until } });
    try {
      const detail = expectDto(sourceDetailResponseDto, (await h.get(`/api/sources/${discovery!._id}`)).body);
      expect(detail.source.schedule).toMatchObject({
        backoffUntil: until.toISOString(),
        nextRunAt: until.toISOString(),
      });
    } finally {
      await sources.updateOne({ _id: discovery!._id }, { $unset: { 'health.backoffUntil': '' } });
    }
    const after = expectDto(sourceListV2ResponseDto, (await h.get('/api/sources?limit=100&count=none')).body);
    // List rows are typed loosely (listPageDto); read the schedule through its own DTO.
    const schedule = sourceScheduleStateDto
      .nullable()
      .parse(after.items.find((s) => s.key === 'system:careers-discovery')!.schedule);
    expect(schedule?.backoffUntil).toBeNull();
    expect(new Date(schedule!.nextRunAt!).getTime()).toBeLessThan(until.getTime());
  });
});
