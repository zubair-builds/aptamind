import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, UNAUTHENTICATED_INTERNAL_OPERATOR } from '@aptamind/contracts';
import { ensureMarketRunLabelIndexes, MARKET_RUN_LABEL_INDEXES, MIGRATIONS } from '@aptamind/platform';
import {
  auditPageResponseDto,
  companyObservationsResponseDto,
  entityRunsQuerySchema,
  entityRunsResponseDto,
  explainList,
  jobVerificationsPlan,
  listEntityRuns,
  MAX_LINKED_RUNS,
  MAX_MERGED_IDS,
  mergedIdsInto,
  MERGE_CHAIN_MAX,
  companyDocSchema,
  emptyCompany,
  jobDetailResponseDto,
  jobListSummaryResponseDto,
  jobObservationsResponseDto,
  jobVerificationDocSchema,
  jobVerificationsResponseDto,
  planStages,
  sourceListV2ResponseDto,
  subResourcePageQuerySchema,
} from '@aptamind/market';
import {
  type ApiHarness,
  expectDto,
  expectValidationError,
  mongoOrderBy,
  startApiHarness,
  traverse,
} from './market-test-harness';

/**
 * Record sub-resources and run history (M7.6, Admin ask API-5): company and job runs (labels +
 * observation/verification/audit run ids), paginated observations with current/superseded,
 * company jobs/sources/audit, job verifications/audit, merge redirects.
 */

let h: ApiHarness;
let acmeId: string;
let otherId: string;
let registerSourceId: string;
let boardSourceId: string;
let jobIds: string[];
const actor = UNAUTHENTICATED_INTERNAL_OPERATOR;

async function runIdOf(res: { status: number; body: unknown }) {
  expect(res.status).toBe(202);
  const { runId } = res.body as { runId: string };
  await h.waitRun(runId);
  return runId;
}

beforeAll(async () => {
  h = await startApiHarness('activity');
  registerSourceId = (await h.seedSponsorRegister())._id;
  acmeId = (await h.market.companies.col.findOne({ 'identity.normalizedName': 'acme ltd' }))!._id;
  otherId = (await h.market.companies.col.findOne({ status: 'active', _id: { $ne: acmeId } }))!._id;
  boardSourceId = (await h.seedGreenhouseBoard(acmeId))._id;
  jobIds = (await h.market.jobs.col.find({ companyId: acmeId }).sort({ _id: 1 }).toArray()).map((j) => j._id);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const idsOf = (rows: Array<{ _id: string }>) => rows.map((r) => r._id);

describe('run history', () => {
  it('company runs: labelled runs and the runs that produced its observations, newest first, paged', async () => {
    const discovery = await runIdOf(await h.post(`/api/companies/${acmeId}/discover-careers`));
    const page = expectDto(entityRunsResponseDto, (await h.get(`/api/companies/${acmeId}/runs`)).body);
    const byId = new Map(page.items.map((r) => [r._id, r]));
    expect(byId.get(discovery)?.linkedBy).toEqual(['label']);
    const importRun = (await h.worker.runtime.engine.runs.findOne({
      'labels.sourceId': registerSourceId,
      depth: 0,
    }))!;
    // The register import works through child runs; whichever wrote the observations is linked.
    const obsRunIds = await h.market.observations.companyObservations.distinct('runId', {
      'resolution.entityId': acmeId,
    });
    expect(obsRunIds.length).toBeGreaterThan(0);
    for (const r of obsRunIds) expect(byId.get(r as string)?.linkedBy).toContain('observation');
    expect(importRun).toBeTruthy();
    const created = page.items.map((r) => r.createdAt);
    expect([...created].sort().reverse()).toEqual(created);
    const walked = await traverse<{ _id: string }>(h, `/api/companies/${acmeId}/runs?limit=1&count=none`);
    expect(idsOf(walked.rows)).toEqual(idsOf(page.items));
    const done = expectDto(
      entityRunsResponseDto,
      (
        await h.get(
          `/api/companies/${acmeId}/runs?state=COMPLETED&workflowKey=market.company.discover_careers`,
        )
      ).body,
    );
    expect(idsOf(done.items)).toEqual([discovery]);
  });

  it('job runs: labelled runs, the listing run (observations) and verification runs', async () => {
    const job = jobIds[0]!;
    const reinterpret = await runIdOf(await h.post(`/api/jobs/${job}/reinterpret`));
    const boardRun = (await h.worker.runtime.engine.runs.findOne({ 'labels.sourceId': boardSourceId }))!;
    // A verification written by the board run (as a listing-presence verification would be).
    await h.market.verification.col.insertOne(
      jobVerificationDocSchema.parse({
        _id: newId('ver'),
        jobId: job,
        status: 'applied',
        method: 'listing_presence',
        outcome: 'live',
        runId: boardRun._id,
        at: new Date(),
        schemaVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    const page = expectDto(entityRunsResponseDto, (await h.get(`/api/jobs/${job}/runs`)).body);
    const byId = new Map(page.items.map((r) => [r._id, r.linkedBy]));
    expect(byId.get(reinterpret)).toEqual(['label']);
    expect(byId.get(boardRun._id)).toEqual(['observation', 'verification']);
  });
});

describe('paginated sub-resources', () => {
  it('company observations: newest first, keyset-paged, current vs superseded, with their sources', async () => {
    const all = await h.market.observations.companyObservations
      .find({ 'resolution.entityId': acmeId })
      .toArray();
    expect(all.length).toBeGreaterThan(2);
    await h.market.observations.companyObservations.updateOne(
      { _id: all[0]!._id },
      { $set: { superseded: true } },
    );
    const walked = await traverse<{ _id: string; current: boolean }>(
      h,
      `/api/companies/${acmeId}/observations?limit=1`,
    );
    expectDto(companyObservationsResponseDto, walked.first);
    expect(idsOf(walked.rows)).toEqual(mongoOrderBy(all, [[(o) => o.lastObservedAt, -1]]));
    expect(walked.rows.find((o) => o._id === all[0]!._id)?.current).toBe(false);
    const current = expectDto(
      companyObservationsResponseDto,
      (await h.get(`/api/companies/${acmeId}/observations?current=true&limit=200`)).body,
    );
    expect(current.total).toBe(all.length - 1);
    expect(current.sources.map((s) => s._id)).toEqual([registerSourceId]);
    const history = expectDto(
      companyObservationsResponseDto,
      (await h.get(`/api/companies/${acmeId}/observations?current=false`)).body,
    );
    expect(idsOf(history.items as Array<{ _id: string }>)).toEqual([all[0]!._id]);
    const bySource = (await h.get(`/api/companies/${acmeId}/observations?sourceId=${boardSourceId}`))
      .body as {
      total: number;
    };
    expect(bySource.total).toBe(0);
  });

  it('job observations and verifications page newest first', async () => {
    const obs = expectDto(
      jobObservationsResponseDto,
      (await h.get(`/api/jobs/${jobIds[0]}/observations`)).body,
    );
    expect(obs.items.length).toBeGreaterThan(0);
    expect(obs.sources.map((s) => s._id)).toEqual([boardSourceId]);
    for (let i = 0; i < 4; i++)
      await h.market.verification.col.insertOne(
        jobVerificationDocSchema.parse({
          _id: newId('ver'),
          jobId: jobIds[1],
          status: i === 3 ? 'claimed' : 'applied', // in-flight operations are not listed
          outcome: 'inconclusive',
          at: new Date(Date.now() - i * 60_000),
          schemaVersion: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
    const walked = await traverse<{ _id: string; at: string }>(
      h,
      `/api/jobs/${jobIds[1]}/verifications?limit=2`,
    );
    expectDto(jobVerificationsResponseDto, walked.first);
    expect(walked.rows).toHaveLength(3);
    expect(walked.first.total).toBe(3);
    const at = walked.rows.map((v) => v.at);
    expect([...at].sort().reverse()).toEqual(at);
  });

  it('company jobs and sources reuse the list v2 endpoints scoped to the company', async () => {
    const jobs = expectDto(
      jobListSummaryResponseDto,
      (await h.get(`/api/companies/${acmeId}/jobs?view=summary&sort=title`)).body,
    );
    expect(jobs.total).toBe(5);
    expect(jobs.items.map((j) => j.identity.title.value)).toEqual(
      [...jobs.items.map((j) => j.identity.title.value)].sort(),
    );
    const sources = expectDto(
      sourceListV2ResponseDto,
      (await h.get(`/api/companies/${acmeId}/sources`)).body,
    );
    expect(sources.items.map((s) => s._id)).toEqual([boardSourceId]);
    expectValidationError(await h.get(`/api/companies/${acmeId}/jobs?companyId=${otherId}`));
    expectValidationError(await h.get(`/api/companies/${acmeId}/sources?companyId=${otherId}`));
  });

  it('company and job audit page newest first', async () => {
    for (let i = 0; i < 5; i++) {
      await h.market.audit.record({
        actor,
        action: `test.event_${i}`,
        entity: { kind: 'company', id: acmeId },
      });
      await h.market.audit.record({
        actor,
        action: `test.event_${i}`,
        entity: { kind: 'job', id: jobIds[2]! },
      });
    }
    const company = await traverse<{ _id: string; action: string }>(
      h,
      `/api/companies/${acmeId}/audit?limit=2`,
    );
    expectDto(auditPageResponseDto, company.first);
    const stored = await h.market.audit.list({ entityKind: 'company', entityId: acmeId }, 100);
    expect(new Set(idsOf(company.rows))).toEqual(new Set(stored.map((e) => e._id)));
    expect(idsOf(company.rows)).toEqual(mongoOrderBy(stored, [[(e) => e.at, -1]]));
    const job = expectDto(auditPageResponseDto, (await h.get(`/api/jobs/${jobIds[2]}/audit?limit=50`)).body);
    expect(job.total).toBe(5);
  });

  it('observation and audit pages are index-backed without a blocking sort', async () => {
    const db = h.market.ctx.db;
    const obs = await db
      .collection('market_company_observations')
      .find({ 'resolution.entityId': acmeId })
      .sort({ lastObservedAt: -1, _id: -1 })
      .limit(10)
      .explain('queryPlanner');
    const audit = await db
      .collection('market_audit_events')
      .find({ 'entity.kind': 'company', 'entity.id': acmeId })
      .sort({ at: -1, _id: -1 })
      .limit(10)
      .explain('queryPlanner');
    for (const plan of [obs, audit]) {
      expect(planStages(plan)).toContain('IXSCAN');
      expect(planStages(plan)).not.toContain('SORT');
    }
    const indexes = await h.worker.runtime.engine.runs.listIndexes().toArray();
    for (const name of ['by_label_company', 'by_label_job'])
      expect(indexes.find((i) => i.name === name)?.partialFilterExpression).toBeDefined();
  });
});

describe('merges', () => {
  it('a merged job detail points at its survivor; its sub-resources are the survivor’s', async () => {
    const [a, b] = [jobIds[3]!, jobIds[4]!];
    const { item } = await h.market.reviews.raise({
      type: 'job_duplicate',
      severity: 'medium',
      dedupeKey: 't:dup',
      entity: { kind: 'job', id: a },
      candidates: [{ kind: 'job', id: b, label: 'b' }],
      subject: 's',
      reason: 'r',
      allowedActions: ['merge', 'keep_separate', 'dismiss'],
    });
    expect(
      (await h.post(`/api/review/${item._id}/resolve`, { action: 'merge', reason: 'same posting' })).status,
    ).toBe(200);
    const merged = (await h.market.jobs.col.findOne({ _id: { $in: [a, b] }, status: 'merged' }))!;
    const detail = expectDto(jobDetailResponseDto, (await h.get(`/api/jobs/${merged._id}`)).body);
    expect(detail.job.status).toBe('merged');
    expect(detail.survivor?._id).toBe(merged.mergedInto);
    const live = expectDto(jobDetailResponseDto, (await h.get(`/api/jobs/${merged.mergedInto}`)).body);
    expect(live.survivor).toBeNull();
    const viaMerged = (await h.get(`/api/jobs/${merged._id}/observations`)).body;
    expect(viaMerged).toEqual((await h.get(`/api/jobs/${merged.mergedInto}/observations`)).body);
  });

  it('M6.2 MR1: verifications of jobs merged into the survivor (any depth) are its verifications and runs', async () => {
    const merged = (await h.market.jobs.col.findOne({
      _id: { $in: [jobIds[3]!, jobIds[4]!] },
      status: 'merged',
    }))!;
    const survivor = merged.mergedInto!;
    // A record merged into the merged one earlier (two hops from the survivor).
    const deeper = `job_mr1_deep_${newId('x')}`;
    await h.market.jobs.col.insertOne({ ...merged, _id: deeper, mergedInto: merged._id, sourceKeys: [] });
    const runOf = async (tag: string) => {
      const _id = `run_mr1_${tag}_${newId('x')}`;
      await h.worker.mongo.db.collection('workflow_runs').insertOne(
        {
          _id,
          workflowKey: 'market.jobs.verify_due',
          workflowVersion: 1,
          trigger: { kind: 'schedule' },
          labels: {},
          state: 'COMPLETED',
          createdAt: new Date(),
          updatedAt: new Date(),
        } as never,
        { bypassDocumentValidation: true },
      );
      return _id;
    };
    const verification = async (jobId: string, runId: string, minutesAgo: number) => {
      const _id = newId('ver');
      await h.market.verification.col.insertOne(
        jobVerificationDocSchema.parse({
          _id,
          jobId,
          status: 'applied',
          method: 'listing_presence',
          outcome: 'live',
          runId,
          at: new Date(Date.now() - minutesAgo * 60_000),
          schemaVersion: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
      return _id;
    };
    const [r1, r2] = [await runOf('direct'), await runOf('deep')];
    const v1 = await verification(merged._id, r1, 1);
    const v2 = await verification(deeper, r2, 2);
    const page = expectDto(
      jobVerificationsResponseDto,
      (await h.get(`/api/jobs/${survivor}/verifications?limit=200`)).body,
    );
    const ids = page.items.map((v) => v._id);
    expect(ids).toEqual(expect.arrayContaining([v1, v2]));
    expect(ids.indexOf(v1)).toBeLessThan(ids.indexOf(v2)); // newest first across the merged records
    const walked = await traverse<{ _id: string }>(h, `/api/jobs/${survivor}/verifications?limit=1`);
    expect(idsOf(walked.rows)).toEqual(ids);
    // The detail embeds the same (newest first, ≤ 20).
    const detail = expectDto(jobDetailResponseDto, (await h.get(`/api/jobs/${survivor}`)).body);
    expect(detail.verifications.map((v) => v._id)).toEqual(expect.arrayContaining([v1, v2]));
    // History is not rewritten: each verification keeps the job it was made against.
    expect((await h.market.verification.col.findOne({ _id: v1 }))!.jobId).toBe(merged._id);
    const runs = expectDto(entityRunsResponseDto, (await h.get(`/api/jobs/${survivor}/runs`)).body);
    const byId = new Map(runs.items.map((r) => [r._id, r.linkedBy]));
    expect(byId.get(r1)).toEqual(['verification']);
    expect(byId.get(r2)).toEqual(['verification']);
    // Index-backed: by_job_time over the ids, merged in order without a blocking sort.
    const listPlan = await jobVerificationsPlan(
      h.market.ctx.db,
      survivor,
      subResourcePageQuerySchema.parse({ limit: '10' }),
    );
    expect(listPlan.match).toMatchObject({
      jobId: { $in: expect.arrayContaining([survivor, merged._id, deeper]) },
    });
    const plan = await explainList(h.market.verification.col, listPlan);
    expect(JSON.stringify(plan)).toContain('by_job_time');
    expect(planStages(plan)).toContain('IXSCAN');
    expect(planStages(plan)).not.toContain('SORT');
    expect(planStages(plan)).not.toContain('COLLSCAN');
  });

  it('a merged company’s sub-resources and runs are the survivor’s, including runs labelled with the merged id', async () => {
    const discovery = await runIdOf(await h.post(`/api/companies/${otherId}/discover-careers`));
    await h.market.companies.merge(acmeId, otherId, actor, 'test merge');
    const runs = expectDto(entityRunsResponseDto, (await h.get(`/api/companies/${acmeId}/runs`)).body);
    expect(runs.items.find((r) => r._id === discovery)?.linkedBy).toEqual(['label']);
    expect((await h.get(`/api/companies/${otherId}/runs`)).body).toEqual(
      (await h.get(`/api/companies/${acmeId}/runs`)).body,
    );
    expect((await h.get(`/api/companies/${otherId}/observations`)).body).toEqual(
      (await h.get(`/api/companies/${acmeId}/observations`)).body,
    );
  });
});

describe('validation', () => {
  it.each([
    ['bad current', `/api/companies/cmp_x/observations?current=yes`],
    ['bad run state', `/api/jobs/job_x/runs?state=DONE`],
    ['bad workflow key', `/api/companies/cmp_x/runs?workflowKey=Market Discover`],
    ['after with offset', `/api/jobs/job_x/verifications?after=x&offset=3`],
    ['unknown parameter', `/api/jobs/job_x/audit?sort=at`],
  ])('400: %s', async (_name, url) => {
    expectValidationError(await h.get(url));
  });

  it('404 for unknown records', async () => {
    for (const url of [
      '/api/companies/cmp_missing/runs',
      '/api/companies/cmp_missing/observations',
      '/api/companies/cmp_missing/jobs',
      '/api/companies/cmp_missing/sources',
      '/api/companies/cmp_missing/audit',
      '/api/jobs/job_missing/runs',
      '/api/jobs/job_missing/observations',
      '/api/jobs/job_missing/verifications',
      '/api/jobs/job_missing/audit',
    ])
      expect((await h.get(url)).status).toBe(404);
  });
});

describe('run history bound (MAX_LINKED_RUNS)', () => {
  it('keeps the newest linked runs and says when older ones were left out', async () => {
    const db = h.worker.mongo.db;
    const id = `cmp_trunc_${newId('x')}`;
    const t0 = Date.parse('2026-09-01T00:00:00Z');
    const runIds = Array.from({ length: 5 }, (_, i) => `run_trunc_${id}_${i}`);
    await db.collection('workflow_runs').insertMany(
      runIds.map((r, i) => ({
        _id: r,
        workflowKey: 'market.test',
        labels: {},
        state: 'COMPLETED',
        createdAt: new Date(t0 + i * 60_000),
      })) as never[],
      { bypassDocumentValidation: true },
    );
    await db.collection('market_company_observations').insertMany(
      runIds.map((r, i) => ({
        _id: `cobs_trunc_${id}_${i}`,
        runId: r,
        resolution: { entityId: id, state: 'resolved' },
        lastObservedAt: new Date(t0 + i * 60_000),
      })) as never[],
      { bypassDocumentValidation: true },
    );
    const q = entityRunsQuerySchema.parse({});
    const runs = h.api.runtime.engine.runs;
    const bounded = await listEntityRuns(db, runs, 'company', id, q, { maxLinked: 3 });
    expect(bounded.truncated).toBe(true);
    expect(bounded.items.map((r) => r._id)).toEqual([runIds[4], runIds[3], runIds[2]]);
    // Exactly the bound: nothing was left out.
    const exact = await listEntityRuns(db, runs, 'company', id, q, { maxLinked: 5 });
    expect(exact.truncated).toBe(false);
    expect(exact.items).toHaveLength(5);
    expect((await listEntityRuns(db, runs, 'company', id, q, { maxLinked: 4 })).truncated).toBe(true);
    const all = await listEntityRuns(db, runs, 'company', id, q, { maxLinked: 10 });
    expect(all.truncated).toBe(false);
    expect(all.items.map((r) => r._id)).toEqual([...runIds].reverse());
    expect(MAX_LINKED_RUNS).toBe(2000);
  });
});

describe('merge chains', () => {
  const make = async (n: number, tag: string) => {
    const ids = Array.from({ length: n }, (_, i) => `cmp_chain_${tag}_${i}_${newId('x')}`);
    await h.market.companies.col.insertMany(
      ids.map((id, i) => ({
        ...companyDocSchema.parse(
          emptyCompany(id, `Chain ${tag} ${i}`, [`name:chain ${tag} ${i} ${id}`], new Date()),
        ),
        status: 'merged' as const,
        mergedInto: ids[i + 1],
      })),
    );
    return ids;
  };

  it('review L-4: more than MAX_MERGED_IDS records merged into a survivor are reported as truncated', async () => {
    const survivor = `cmp_many_${newId('x')}`;
    await h.market.companies.col.insertOne(
      companyDocSchema.parse(emptyCompany(survivor, 'Many', [`name:many ${survivor}`], new Date())),
    );
    const merge = (n: number, tag: string) =>
      h.market.companies.col.insertMany(
        Array.from({ length: n }, (_, i) => {
          const id = `cmp_many_${tag}_${i}_${newId('x')}`;
          return {
            ...companyDocSchema.parse(emptyCompany(id, `Many ${tag} ${i}`, [`name:many ${id}`], new Date())),
            status: 'merged' as const,
            mergedInto: survivor,
          };
        }),
      );
    await merge(MAX_MERGED_IDS, 'a');
    expect(await mergedIdsInto(h.market.ctx.db, 'company', survivor)).toMatchObject({ truncated: false });
    expect((await mergedIdsInto(h.market.ctx.db, 'company', survivor)).ids).toHaveLength(MAX_MERGED_IDS);
    const runs = () => h.get(`/api/companies/${survivor}/runs`);
    expect(((await runs()).body as { truncated: boolean }).truncated).toBe(false);
    await merge(1, 'b');
    const over = await mergedIdsInto(h.market.ctx.db, 'company', survivor);
    expect(over).toMatchObject({ truncated: true });
    expect(over.ids).toHaveLength(MAX_MERGED_IDS);
    expect(((await runs()).body as { truncated: boolean }).truncated).toBe(true);
  });

  it('a merged company is followed to its survivor across several hops', async () => {
    const ids = await make(3, 'ok');
    const last = ids[ids.length - 1]!;
    await h.market.companies.col.updateOne(
      { _id: last },
      { $set: { status: 'active' }, $unset: { mergedInto: '' } },
    );
    const d = (await h.get(`/api/companies/${ids[0]}`)).body as { survivor: { _id: string; status: string } };
    expect(d.survivor).toMatchObject({ _id: last, status: 'active' });
  });

  it.each([
    ['a cycle', 'cycle'],
    ['a chain longer than MERGE_CHAIN_MAX', 'too_long'],
    ['a broken chain (missing link)', 'broken'],
  ])('%s is a 409, never a merged "survivor"', async (_name, reason) => {
    const ids = reason === 'too_long' ? await make(MERGE_CHAIN_MAX + 3, reason) : await make(2, reason);
    if (reason === 'cycle')
      await h.market.companies.col.updateOne({ _id: ids[1] }, { $set: { mergedInto: ids[0] } });
    if (reason === 'broken')
      await h.market.companies.col.updateOne({ _id: ids[1] }, { $set: { mergedInto: 'cmp_gone' } });
    for (const path of [
      `/api/companies/${ids[0]}`,
      `/api/companies/${ids[0]}/runs`,
      `/api/companies/${ids[0]}/jobs`,
    ]) {
      const res = await h.get(path);
      expect(res.status, path).toBe(409);
      expect((res.body as { error: { code: string; details: { reason: string } } }).error).toMatchObject({
        code: 'conflict',
        details: { reason },
      });
    }
  });
});

describe('merged-record lookup (run history)', () => {
  it('records merged into a survivor are found through the partial by_merged_into index, not a scan', async () => {
    for (const col of [h.market.companies.col, h.market.jobs.col] as const) {
      const plan = await (col as unknown as typeof h.market.jobs.col)
        .find({ mergedInto: acmeId }, { projection: { _id: 1 } })
        .limit(200)
        .explain('queryPlanner');
      const winning = JSON.stringify(plan.queryPlanner.winningPlan);
      expect(winning).toContain('by_merged_into');
      expect(winning).not.toContain('COLLSCAN');
    }
    const spec = (await h.market.jobs.col.listIndexes().toArray()).find((i) => i.name === 'by_merged_into');
    expect(spec?.partialFilterExpression).toEqual({ mergedInto: { $exists: true } });
  });
});

describe('run-label indexes', () => {
  const runs = () => h.worker.mongo.db.collection('workflow_runs');
  const onKey = async (key: Record<string, number>) =>
    (await runs().listIndexes().toArray()).filter((i) => JSON.stringify(i.key) === JSON.stringify(key));

  it('by_label_source/company/job are partial (not sparse) after the migrations', async () => {
    for (const { key, partialFilterExpression } of MARKET_RUN_LABEL_INDEXES) {
      const indexes = await onKey(key);
      expect(indexes).toHaveLength(1);
      expect(indexes[0]).toMatchObject({ key, partialFilterExpression });
      expect(indexes[0]!.sparse).toBeUndefined();
    }
    // A fresh database builds the final partial index under its own name (003 uses the helper).
    const [source] = await onKey({ 'labels.sourceId': 1, createdAt: -1 });
    expect(source!.name).toBe(MARKET_RUN_LABEL_INDEXES[0]!.name);
    const plan = await runs()
      .find({ 'labels.sourceId': boardSourceId })
      .sort({ createdAt: -1 })
      .explain('queryPlanner');
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain(source!.name);
  });

  it('the market run-label migration repairs a legacy sparse by_label_source, idempotently', async () => {
    const key = { 'labels.sourceId': 1, createdAt: -1 } as const;
    for (const i of await onKey(key)) await runs().dropIndex(String(i.name));
    await runs().createIndex(key, { name: 'by_label_source', sparse: true });
    const migration = MIGRATIONS.find((m) => m.id === '2026-09-30-003-market-run-label-indexes')!;
    await migration.up(h.worker.mongo.db);
    const repaired = await onKey(key);
    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.sparse).toBeUndefined();
    expect(repaired[0]!.partialFilterExpression).toEqual({ 'labels.sourceId': { $exists: true } });
    const before = await runs().listIndexes().toArray();
    await migration.up(h.worker.mongo.db);
    await ensureMarketRunLabelIndexes(h.worker.mongo.db);
    expect(await runs().listIndexes().toArray()).toEqual(before);
    // Source run history still pages through it.
    expect((await h.get(`/api/sources/${boardSourceId}/runs`)).status).toBe(200);
  });
});
