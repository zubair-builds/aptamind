// First: installs the egress guard before anything below is evaluated (PR #11 LOW-3).
import { assertNoEgress } from './testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestInfra, type TestInfra } from '@aptamind/testing';
import { activeJobCounts, activeJobCountsPipeline } from './api/companies';
import { ACTIVE_JOB_MATCH, planStages } from './api/list';
import { marketCollections } from './collections';
import { migrateJobTitleTokens } from './jobs/title-tokens';
import { dropRetiredMarketIndexes } from './migrations';
import { ensureMarketCollections } from './market-domain';

/**
 * Market indexes are stable across boots (`ensureCollections` runs on every start): a second
 * run must not drop and rebuild any index. `$indexStats.accesses.since` is reset whenever an index
 * is (re)created, so it identifies the build.
 */

let infra: TestInfra;

beforeAll(async () => {
  infra = await createTestInfra('market-indexes');
});

afterAll(async () => {
  await infra?.cleanup();
  assertNoEgress();
});

async function builds(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const spec of marketCollections) {
    const stats = await infra.db
      .collection(spec.name)
      .aggregate<{ name: string; accesses: { since: Date } }>([{ $indexStats: {} }])
      .toArray();
    for (const s of stats) out[`${spec.name}.${s.name}`] = s.accesses.since.getTime();
  }
  return out;
}

describe('Market indexes', () => {
  it('ensureMarketCollections twice rebuilds no index', async () => {
    await ensureMarketCollections(infra.db);
    const first = await builds();
    const declared = marketCollections.flatMap((c) => c.indexes.map((i) => `${c.name}.${i.options.name}`));
    for (const name of declared) expect(first).toHaveProperty([name]);
    await new Promise((r) => setTimeout(r, 50));
    await ensureMarketCollections(infra.db);
    expect(await builds()).toEqual(first);
  });

  it('the title-token migration drops the legacy text index and backfills tokens (idempotently)', async () => {
    const jobs = infra.db.collection('market_jobs');
    await jobs.createIndex({ 'identity.normalizedTitle': 'text' }, { name: 'list_title_text' });
    const docs = Array.from({ length: 7 }, (_, i) => ({
      _id: `job_legacy_${i}`,
      identity: {
        title: { value: i % 2 ? `C++ Engineer ${i}` : null },
        normalizedTitle: `Data Analyst ${i}`,
      },
    }));
    // Legacy documents without tokens (written before the field existed).
    await jobs.insertMany(docs as never[], { bypassDocumentValidation: true });
    await jobs.updateOne({ _id: 'job_legacy_0' as never }, { $set: { 'identity.titleTokens': ['kept'] } });
    expect(await migrateJobTitleTokens(infra.db, 3)).toEqual({ updated: 6 });
    expect((await jobs.listIndexes().toArray()).map((i) => i.name)).not.toContain('list_title_text');
    const byId = new Map(
      (await jobs.find({ _id: { $in: docs.map((d) => d._id) } } as never).toArray()).map((d) => [
        String(d._id),
        (d.identity as { titleTokens: string[] }).titleTokens,
      ]),
    );
    expect(byId.get('job_legacy_0')).toEqual(['kept']);
    expect(byId.get('job_legacy_1')).toEqual(['c++', 'engineer', '1']);
    expect(byId.get('job_legacy_2')).toEqual(['data', 'analyst', '2']);
    expect(await migrateJobTitleTokens(infra.db)).toEqual({ updated: 0 });
  });

  it('retired indexes are dropped once (idempotent)', async () => {
    await infra.db
      .collection('market_jobs')
      .createIndex({ 'lifecycle.lastChangedAt': -1 }, { name: 'by_last_changed' });
    expect(await dropRetiredMarketIndexes(infra.db)).toEqual(['market_jobs.by_last_changed']);
    expect(await dropRetiredMarketIndexes(infra.db)).toEqual([]);
  });

  it('by_context_source is partial (only items with a context source), replacing the sparse version', async () => {
    const col = infra.db.collection('market_review_items');
    await col.dropIndex('by_context_source');
    await col.createIndex({ 'context.sourceId': 1, status: 1 }, { name: 'by_context_source', sparse: true });
    await ensureMarketCollections(infra.db);
    const spec = (await col.listIndexes().toArray()).find((i) => i.name === 'by_context_source')!;
    expect(spec.sparse).toBeUndefined();
    expect(spec.partialFilterExpression).toEqual({ 'context.sourceId': { $exists: true } });
    await col.insertMany(
      Array.from({ length: 20 }, (_, i) => ({
        _id: `rev_ctx_${i}`,
        dedupeKey: `ctx:${i}`,
        status: 'open',
        context: i % 4 === 0 ? { sourceId: `src_${i}` } : {},
      })) as never[],
      { bypassDocumentValidation: true },
    );
    const plan = await col.find({ 'context.sourceId': 'src_4', status: 'open' }).explain('queryPlanner');
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('by_context_source');
    const keys = await col
      .find({}, { hint: 'by_context_source' })
      .filter({ 'context.sourceId': { $exists: true } })
      .count();
    expect(keys).toBe(5);
  });

  it('by_company_state keeps active-job company ids and counts covered (list_company_seen cannot)', async () => {
    await ensureMarketCollections(infra.db);
    const jobs = infra.db.collection('market_jobs');
    await jobs.insertMany(
      Array.from({ length: 30 }, (_, i) => ({
        _id: `job_cs_${i}`,
        sourceKeys: [`src_cs:${i}`],
        companyId: `cmp_${i % 6}`,
        status: i % 5 ? 'active' : 'merged',
        lifecycle: { state: i % 3 ? 'VERIFIED_LIVE' : 'CLOSED', lastSeenAt: new Date() },
      })) as never[],
      { bypassDocumentValidation: true },
    );
    const distinct = await infra.db.command({
      explain: { distinct: 'market_jobs', key: 'companyId', query: ACTIVE_JOB_MATCH },
      verbosity: 'queryPlanner',
    });
    const stages = planStages(distinct.queryPlanner.winningPlan);
    expect(JSON.stringify(distinct.queryPlanner.winningPlan)).toContain('by_company_state');
    expect(stages).not.toContain('FETCH');
    expect(stages).not.toContain('COLLSCAN');
    const counts = await jobs
      .aggregate(activeJobCountsPipeline(['cmp_1', 'cmp_2']), { hint: 'by_company_state' })
      .explain('queryPlanner');
    expect(Object.fromEntries(await activeJobCounts(infra.db, ['cmp_1', 'cmp_2', 'cmp_x']))).toEqual({
      cmp_1: 4,
      cmp_2: 4,
    });
    expect(planStages(counts)).not.toContain('FETCH');
    expect(planStages(counts)).not.toContain('COLLSCAN');
    expect(JSON.stringify(counts)).toContain('by_company_state');
    // With only list_company_seen the same distinct has to fetch every job for its state.
    const seen = await jobs
      .aggregate([{ $match: ACTIVE_JOB_MATCH }, { $group: { _id: '$companyId' } }], {
        hint: 'list_company_seen',
      })
      .explain('queryPlanner');
    expect(planStages(seen)).toContain('FETCH');
  });
});
