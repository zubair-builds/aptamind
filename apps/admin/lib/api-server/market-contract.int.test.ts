import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditListResponseDto,
  companyDetailResponseDto,
  companyListResponseDto,
  companyReconcileResponseDto,
  errorResponseDto,
  jobDetailResponseDto,
  jobListResponseDto,
  observationResponseDto,
  reviewDetailResponseDto,
  reviewListResponseDto,
  reviewResolveResponseDto,
  signalListResponseDto,
  snapshotDto,
  sourceDetailResponseDto,
  sourceListResponseDto,
  sourceResponseDto,
} from '@aptamind/market';
import { type ApiHarness, expectDto, expectValidationError, startApiHarness } from './market-test-harness';

/**
 * Route contract tests (M7.1): every Market list/detail endpoint's real response — produced by
 * the real pipelines from committed fixtures — parses with its published DTO, query strings
 * are validated strictly (400 on unknown parameters and misspelt enums), and the calls the
 * current Admin makes keep working unchanged.
 */

let h: ApiHarness;
let sponsorSourceId: string;
let boardSourceId: string;
let acmeId: string;

beforeAll(async () => {
  h = await startApiHarness('contract');
  sponsorSourceId = (await h.seedSponsorRegister())._id;
  const acme = await h.market.companies.col.findOne({ 'identity.normalizedName': 'acme ltd' });
  acmeId = acme!._id;
  boardSourceId = (await h.seedGreenhouseBoard(acmeId))._id;
});

afterAll(async () => {
  await h?.close();
});

describe('Market API response contracts', () => {
  it('companies: list and detail match their DTOs', async () => {
    const list = await h.get('/api/companies?limit=200');
    expect(list.status).toBe(200);
    const page = expectDto(companyListResponseDto, list.body);
    expect(page.total).toBe(16);
    expect(page.items).toHaveLength(16);

    const detail = await h.get(`/api/companies/${acmeId}`);
    expect(detail.status).toBe(200);
    const d = expectDto(companyDetailResponseDto, detail.body);
    expect(d.company._id).toBe(acmeId);
    expect(d.jobs.length).toBe(5);
    expect(d.jobSources.map((s) => s._id)).toEqual([boardSourceId]);
    expect(d.observations.length).toBeGreaterThan(0);

    const reconcile = await h.post(`/api/companies/${acmeId}/reconcile`);
    expect(reconcile.status).toBe(200);
    expectDto(companyReconcileResponseDto, reconcile.body);
  });

  it('jobs: list and detail match their DTOs (list items omit the description)', async () => {
    const list = await h.get('/api/jobs');
    const page = expectDto(jobListResponseDto, list.body);
    expect(page.items).toHaveLength(5);
    expect(page.items.every((j) => j.companyName === 'Acme Ltd')).toBe(true);
    const raw = (list.body as { items: Array<{ content: Record<string, unknown> }> }).items[0]!;
    expect(raw.content).not.toHaveProperty('descriptionText');
    expect(raw.content).not.toHaveProperty('shingles');

    const detail = await h.get(`/api/jobs/${page.items[0]!._id}`);
    const d = expectDto(jobDetailResponseDto, detail.body);
    expect(d.company._id).toBe(acmeId);
    expect(d.sources.map((s) => s._id)).toEqual([boardSourceId]);
    expect(d.observations.length).toBeGreaterThan(0);
  });

  it('observations: company, job and unknown ids match the DTO', async () => {
    const cobs = await h.market.observations.companyObservations.findOne({ sourceId: sponsorSourceId });
    const jobs = await h.market.observations.jobObservations.findOne({ sourceId: boardSourceId });
    const c = expectDto(observationResponseDto, (await h.get(`/api/observations/${cobs!._id}`)).body);
    expect(c).toMatchObject({ kind: 'company', source: { _id: sponsorSourceId } });
    const j = expectDto(observationResponseDto, (await h.get(`/api/observations/${jobs!._id}`)).body);
    expect(j).toMatchObject({ kind: 'job', source: { _id: boardSourceId } });
    expect(expectDto(observationResponseDto, (await h.get('/api/observations/cobs_missing')).body)).toEqual({
      observation: null,
    });
  });

  it('sources and snapshots: list and detail match their DTOs', async () => {
    const page = expectDto(sourceListResponseDto, (await h.get('/api/sources')).body);
    expect(page.items.map((s) => s.key)).toEqual(
      expect.arrayContaining(['uk-sponsor-register', 'greenhouse:acme', 'system:operator']),
    );
    const d = expectDto(sourceDetailResponseDto, (await h.get(`/api/sources/${boardSourceId}`)).body);
    expect(d.runs.length).toBe(1);
    expect(d.snapshots.length).toBe(1);
    expect(d.schedule?.enabled).toBe(false); // no schedule configured: a disabled placeholder
    const snap = await h.get(`/api/snapshots/${d.snapshots[0]!._id}`);
    expectDto(snapshotDto, snap.body);

    const disabled = await h.post(`/api/sources/${boardSourceId}/disable`);
    expect(expectDto(sourceResponseDto, disabled.body).source.enabled).toBe(false);
    const enabled = await h.post(`/api/sources/${boardSourceId}/enable`);
    expect(expectDto(sourceResponseDto, enabled.body).source.enabled).toBe(true);
  });

  it('review: list, detail and resolve match their DTOs; operator evidence cites the operator source', async () => {
    const list = expectDto(reviewListResponseDto, (await h.get('/api/review')).body);
    expect(list.items.length).toBeGreaterThan(0);
    const detail = expectDto(
      reviewDetailResponseDto,
      (await h.get(`/api/review/${list.items[0]!._id}`)).body,
    );
    expect(detail.item._id).toBe(list.items[0]!._id);

    // A job field conflict corrected by the operator.
    const job = (await h.market.jobs.col.findOne({ companyId: acmeId }))!;
    const { item } = await h.market.reviews.raise({
      type: 'field_conflict',
      severity: 'medium',
      dedupeKey: `contract:${job._id}`,
      entity: { kind: 'job', id: job._id },
      subject: 'Work model disagreement',
      reason: 'contract test',
      allowedActions: ['correct', 'confirm', 'dismiss'],
    });
    expectDto(reviewDetailResponseDto, (await h.get(`/api/review/${item._id}`)).body);
    const resolved = await h.post(`/api/review/${item._id}/resolve`, {
      action: 'correct',
      reason: 'The posting says hybrid',
      field: 'workModel',
      value: 'hybrid',
    });
    expect(resolved.status).toBe(200);
    expect(expectDto(reviewResolveResponseDto, resolved.body).item.status).toBe('resolved');

    const operator = (await h.market.sources.getByKey('system:operator'))!;
    const after = expectDto(jobDetailResponseDto, (await h.get(`/api/jobs/${job._id}`)).body);
    const workModel = after.job.geography as {
      workModel: { value: string; evidence: { sourceId: string }[] };
    };
    expect(workModel.workModel.value).toBe('hybrid');
    expect(workModel.workModel.evidence.map((e) => e.sourceId)).toEqual([operator._id]);
    // The evidence link resolves like any other source, and the detail lists the operator source.
    expect((await h.get(`/api/sources/${operator._id}`)).status).toBe(200);
    expect(after.sources.map((x) => x._id)).toContain(operator._id);
    expect(after.sources.find((x) => x._id === operator._id)).toMatchObject({
      key: 'system:operator',
      provider: 'operator',
    });

    // Legacy evidence (before M7.1 it cited the literal source id 'operator'): the document still
    // parses, and the next reconciliation rewrites it to the operator source id without counting
    // as a change (no content-hash or lifecycle change).
    await h.market.jobs.col.updateOne(
      { _id: job._id },
      { $set: { 'geography.workModel.evidence.0.sourceId': 'operator' } },
    );
    const legacy = (await h.market.jobs.col.findOne({ _id: job._id }))!;
    expect(legacy.geography.workModel.evidence[0]!.sourceId).toBe('operator');
    const legacyDetail = expectDto(jobDetailResponseDto, (await h.get(`/api/jobs/${job._id}`)).body);
    expect(legacyDetail.sources.map((x) => x._id)).toContain(operator._id);
    const company = await h.market.companies.resolveActive(legacy.companyId);
    const { job: rewritten, changed } = await h.market.jobReconciler.reconcile(legacy, company);
    expect(changed).toBe(false);
    const stored = (await h.market.jobs.col.findOne({ _id: job._id }))!;
    expect(stored.geography.workModel.evidence.map((e) => e.sourceId)).toEqual([operator._id]);
    expect(rewritten.geography.workModel.value).toBe('hybrid');
    expect(stored.contentHash).toBe(legacy.contentHash);
    expect(stored.lifecycle.lastChangedAt).toEqual(legacy.lifecycle.lastChangedAt);
    expect(stored.lifecycle.history).toHaveLength(legacy.lifecycle.history.length);
  });

  it('audit and signals match their DTOs', async () => {
    const audit = await h.get(`/api/audit?entityKind=source&entityId=${boardSourceId}`);
    expect(expectDto(auditListResponseDto, audit.body).items.length).toBeGreaterThan(0);
    expectDto(signalListResponseDto, (await h.get('/api/signals')).body);
  });
});

describe('Market API query validation', () => {
  const bad: Array<[string, string]> = [
    ['unknown list parameter', '/api/companies?bogus=1'],
    ['misspelt parameter name', '/api/jobs?workmodel=remote'],
    ['misspelt careers status', '/api/companies?careersStatus=foundd'],
    ['bad boolean', '/api/companies?hasConflicts=yes'],
    ['bad sponsor country', '/api/companies?sponsorCountry=GBR'],
    ['misspelt job state', '/api/jobs?state=OPEN'],
    ['wrong-case work model', '/api/jobs?workModel=Remote'],
    ['misspelt remote scope', '/api/jobs?remoteScope=global'],
    ['misspelt sponsorship', '/api/jobs?sponsorship=yes'],
    ['bad country', '/api/jobs?country=USA'],
    ['limit out of range', '/api/jobs?limit=0'],
    ['offset out of range', '/api/jobs?offset=100001'],
    ['misspelt source category', '/api/sources?category=jobs'],
    ['misspelt source health', '/api/sources?health=ok'],
    ['misspelt review status', '/api/review?status=closed'],
    ['misspelt review type', '/api/review?type=duplicate'],
    ['misspelt audit entity kind', '/api/audit?entityKind=companies'],
    ['unknown signals parameter', '/api/signals?type=x'],
    ['query on a detail route', '/api/companies/cmp_x?expand=all'],
  ];
  it.each(bad)('400 validation_failed: %s', async (_name, url) => {
    const res = await h.get(url);
    expectValidationError(res);
    const body = expectDto(errorResponseDto, res.body);
    expect(body.error.issues?.length).toBeGreaterThan(0);
  });

  it('400 on unknown query parameters of mutations', async () => {
    expectValidationError(await h.post(`/api/sources/${boardSourceId}/run?force=true`));
    expectValidationError(await h.post(`/api/companies/${acmeId}/reconcile?dry=1`));
  });

  it('keeps the current Admin calls working unchanged', async () => {
    // Exactly what apps/admin sends today.
    const all = await h.get('/api/review?status=&limit=50&offset=0');
    expect(all.status).toBe(200);
    const open = await h.get('/api/review?limit=50&offset=0');
    const allPage = expectDto(reviewListResponseDto, all.body);
    const openPage = expectDto(reviewListResponseDto, open.body);
    expect(allPage.total).toBeGreaterThan(openPage.total); // includes the resolved item
    expect(expectDto(reviewListResponseDto, (await h.get('/api/review?status=all')).body).total).toBe(
      allPage.total,
    );

    const sponsors = expectDto(
      companyListResponseDto,
      (await h.get('/api/companies?sponsorCountry=gb&careersStatus=not_attempted&limit=50&offset=0')).body,
    );
    expect(sponsors.total).toBeGreaterThan(0); // case-insensitive country, as before for upper case
    const jobs = await h.get(`/api/jobs?state=VERIFIED_LIVE&companyId=${acmeId}&limit=50&offset=0`);
    expect(jobs.status).toBe(200);
    expect(expectDto(jobListResponseDto, jobs.body).items.length).toBeGreaterThan(0);
    const remote = await h.get(
      '/api/jobs?workModel=remote&remoteScope=country&country=us&hasConflicts=false',
    );
    expect(expectDto(jobListResponseDto, remote.body).items.length).toBeGreaterThan(0);
    const sources = await h.get('/api/sources?category=job_source&health=healthy&q=acme&limit=50&offset=0');
    expect(expectDto(sourceListResponseDto, sources.body).total).toBe(1);
  });
});
