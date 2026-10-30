/**
 * Job-listing shrink guard (M6.2), mirroring the sponsor-register guard: a complete listing that
 * collapses against the source's baseline (the last listing whose absences were applied) applies
 * no absences and raises a `source_anomaly` review — every time it recurs, across replays — until
 * the listing recovers or an operator confirms the shrink.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestInfra, startFixtureServer, type TestInfra } from '@aptamind/testing';
import type { WorkflowEngine } from '@aptamind/workflows';
import { latestDecisionQuery } from './review/review.repository';
import type { SourceDoc } from './sources/source.schema';
import { createMarketTestRuntime } from './test-harness';

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let companyId: string;
const boards = new Map<string, unknown>();

/**
 * A Greenhouse board `token` listing jobs `from`…`to` (inclusive). Titles and text are per
 * board so jobs of different boards of the same company never resolve to one another.
 */
const board = (token: string, from: number, to: number) => {
  const jobs = [];
  for (let id = from; id <= to; id++)
    jobs.push({
      id,
      title: `${token} engineer ${id}`,
      location: { name: 'London, UK' },
      content: `<p>Build ${token} systems, role ${id}.</p>`,
    });
  return { jobs, meta: { total: jobs.length } };
};

beforeAll(async () => {
  infra = await createTestInfra('listing_shrink');
  t = await createMarketTestRuntime(infra);
  server = await startFixtureServer(async (req, res) => {
    const body = boards.get((req.url ?? '').split('?')[0] ?? '');
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  const directory = (
    await t.market.sources.register(
      {
        key: 'directory:shrink',
        name: 'Directory',
        category: 'company_universe',
        provider: 'fixture',
        acquisition: { workflowKey: 'market.noop' },
        freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 100000 },
        authority: { tier: 'official_site' },
      },
      t.actor,
    )
  ).source;
  const company = await t.market.companyPipeline.process({
    sourceId: directory._id,
    externalId: 'acme',
    payload: { name: 'Acme Ltd', aliases: [], externalIds: [], locations: [], industries: [] },
    parser: { name: 'test', version: '1' },
  });
  if (company.outcome !== 'created' && company.outcome !== 'matched') throw new Error('company not created');
  companyId = company.companyId;
});

afterAll(async () => {
  await t?.stop();
  await server?.close();
  await infra?.cleanup();
});

async function registerBoard(token: string): Promise<SourceDoc> {
  return (
    await t.market.sources.register(
      {
        key: `greenhouse:${token}`,
        name: `${token} (greenhouse)`,
        category: 'job_source',
        provider: 'greenhouse',
        endpoint: { boardToken: token, url: `${server.url}/v1/boards/${token}/jobs` },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      },
      t.actor,
    )
  ).source;
}

interface FinalizeOutput {
  absenceApplied: boolean;
  reason: string | null;
  absent: number;
  closed: number;
  possiblyStale: number;
}

async function refresh(source: SourceDoc): Promise<FinalizeOutput> {
  const r = await t.runSource(source._id);
  if (r.state !== 'COMPLETED') throw new Error(`run ${r.state}: ${r.error?.message}`);
  return (await t.runtime.engine.stores.nodeRuns.findCompletedOutput(r._id, 'finalize'))!
    .output as unknown as FinalizeOutput;
}

const states = async (source: SourceDoc) => {
  const jobs = await t.market.jobs.col.find({ 'sourceRefs.sourceId': source._id }).toArray();
  const count: Record<string, number> = {};
  for (const j of jobs) count[j.lifecycle.state] = (count[j.lifecycle.state] ?? 0) + 1;
  return { count, absences: jobs.reduce((a, j) => a + j.lifecycle.consecutiveAbsences, 0) };
};

const anomalies = (source: SourceDoc, status: 'open' | 'resolved' | 'dismissed' = 'open') =>
  t.market.reviews.col.find({ type: 'source_anomaly', 'entity.id': source._id, status }).toArray();

/** Lose the first completion acknowledgement of every node run; returns a restore function. */
function loseFirstAcks(engine: WorkflowEngine): () => void {
  const nodeRuns = engine.stores.nodeRuns;
  const finish = nodeRuns.finish;
  const acked = new Set<string>();
  nodeRuns.finish = async (fence, state, ...rest) => {
    if (state === 'COMPLETED' && !acked.has(fence.nodeRunId)) {
      acked.add(fence.nodeRunId);
      throw new Error('injected: acknowledgement lost');
    }
    return finish.call(nodeRuns, fence, state, ...rest);
  };
  return () => {
    nodeRuns.finish = finish;
  };
}

describe('M6.2: job-listing shrink guard', () => {
  it('200 → 5 closes nothing and raises source_anomaly, however often it recurs; the next normal listing proceeds', async () => {
    const token = 'acme-shrink';
    const source = await registerBoard(token);
    const path = `/v1/boards/${token}/jobs`;
    boards.set(path, board(token, 1, 200));
    expect(await refresh(source)).toMatchObject({ absenceApplied: true });
    expect((await t.market.sources.get(source._id)).health.listingBaseline).toMatchObject({ count: 200 });

    boards.set(path, board(token, 1, 5));
    const held = await refresh(source);
    expect(held).toMatchObject({ absenceApplied: false, absent: 0, closed: 0 });
    expect(held.reason).toMatch(/shrank from 200 to 5/);
    // The held listing does not become the new baseline: a repeat is held again (the empty-guard
    // variant of this bug let the second anomalous listing through).
    expect(await refresh(source)).toMatchObject({ absenceApplied: false });
    // Replays: every node's first acknowledgement lost — still held, still one review.
    const restore = loseFirstAcks(t.runtime.engine);
    try {
      expect(await refresh(source)).toMatchObject({ absenceApplied: false });
    } finally {
      restore();
    }
    expect(await states(source)).toEqual({ count: { VERIFIED_LIVE: 200 }, absences: 0 });
    const open = await anomalies(source);
    expect(open).toHaveLength(1);
    // One item for the question; `occurrences` counts every raise (a replayed node raises again).
    expect(open[0]!.occurrences).toBeGreaterThanOrEqual(3);
    expect(open[0]).toMatchObject({
      severity: 'medium',
      allowedActions: ['retry', 'confirm', 'dismiss'],
      context: expect.objectContaining({ sourceId: source._id, baselineCount: 200, count: 5 }),
    });
    // B-H1 ruling: a held listing is a successful fetch, marked as held (not a failed run).
    const s = await t.market.sources.get(source._id);
    expect(s.health.listingBaseline).toMatchObject({ count: 200 });
    expect(s.health.status).toBe('healthy');
    expect(s.health.lastError).toBeUndefined();
    expect(s.health.listingHeld).toMatchObject({ count: 5, baseline: 200, reviewId: open[0]!._id });
    expect(s.health.listingHeld!.since).toBeInstanceOf(Date);

    // Back to normal (one job genuinely gone): absences apply again.
    boards.set(path, board(token, 1, 199));
    expect(await refresh(source)).toMatchObject({ absenceApplied: true, absent: 1, possiblyStale: 1 });
    expect(await states(source)).toEqual({ count: { VERIFIED_LIVE: 199, POSSIBLY_STALE: 1 }, absences: 1 });
    const after = await t.market.sources.get(source._id);
    expect(after.health).toMatchObject({ status: 'healthy', listingBaseline: { count: 199 } });
    expect(after.health.listingHeld).toBeUndefined(); // cleared when a listing is applied
  }, 240_000);

  it('an operator-confirmed shrink is applied on the next listing, and the confirmation does not outlive its baseline', async () => {
    const token = 'acme-confirm';
    const source = await registerBoard(token);
    const path = `/v1/boards/${token}/jobs`;
    boards.set(path, board(token, 1, 40));
    await refresh(source);
    boards.set(path, board(token, 1, 10));
    expect(await refresh(source)).toMatchObject({ absenceApplied: false });
    const [review] = await anomalies(source);
    await t.market.reviewService.resolve(
      review!._id,
      { action: 'confirm', reason: 'the company paused hiring' },
      t.actor,
    );

    // Confirmed: the shrink is real, so the 30 missing jobs are absent now.
    expect(await refresh(source)).toMatchObject({ absenceApplied: true, absent: 30, possiblyStale: 30 });
    expect((await t.market.sources.get(source._id)).health.listingBaseline).toMatchObject({ count: 10 });

    // The board recovers, then collapses again: the old confirmation belonged to the old
    // baseline and does not approve this one.
    boards.set(path, board(token, 1, 40));
    expect(await refresh(source)).toMatchObject({ absenceApplied: true });
    boards.set(path, board(token, 1, 10));
    expect(await refresh(source)).toMatchObject({ absenceApplied: false });
    expect(await anomalies(source)).toHaveLength(1);
    expect((await states(source)).count.VERIFIED_LIVE).toBe(40);
  }, 240_000);

  it('a confirmation covers only the confirmed size: a further collapse is held again', async () => {
    const token = 'acme-collapse';
    const source = await registerBoard(token);
    const path = `/v1/boards/${token}/jobs`;
    boards.set(path, board(token, 1, 100));
    await refresh(source);
    boards.set(path, board(token, 1, 40));
    await refresh(source);
    const [review] = await anomalies(source);
    await t.market.reviewService.resolve(review!._id, { action: 'confirm', reason: 'real' }, t.actor);
    boards.set(path, board(token, 1, 3));
    expect(await refresh(source)).toMatchObject({ absenceApplied: false });
    expect(await states(source)).toEqual({ count: { VERIFIED_LIVE: 100 }, absences: 0 });
  }, 240_000);

  it('an empty listing after a non-empty board (baseline ≥ 10) is held every time, not just once', async () => {
    const token = 'acme-empty';
    const source = await registerBoard(token);
    const path = `/v1/boards/${token}/jobs`;
    boards.set(path, board(token, 1, 12));
    await refresh(source);
    boards.set(path, { jobs: [], meta: { total: 0 } });
    for (let i = 0; i < 3; i++) expect(await refresh(source)).toMatchObject({ absenceApplied: false });
    expect(await states(source)).toEqual({ count: { VERIFIED_LIVE: 12 }, absences: 0 });
    expect(await anomalies(source)).toHaveLength(1);
  }, 120_000);

  it('ruling L2: a small board (baseline < 10) that empties is held for one run, then absences accrue (never closing alone)', async () => {
    const token = 'acme-small';
    const source = await registerBoard(token);
    const path = `/v1/boards/${token}/jobs`;
    boards.set(path, board(token, 1, 3));
    await refresh(source);
    boards.set(path, { jobs: [], meta: { total: 0 } });
    // First empty listing: held automatically, no review.
    expect(await refresh(source)).toMatchObject({ absenceApplied: false });
    const held = await t.market.sources.get(source._id);
    expect(held.health.status).toBe('healthy');
    expect(held.health.listingHeld).toMatchObject({ reason: 'small_board_empty', count: 0, baseline: 3 });
    expect(held.health.listingHeld!.reviewId).toBeUndefined();
    expect(await states(source)).toEqual({ count: { VERIFIED_LIVE: 3 }, absences: 0 });
    // Replaying the held listing (same snapshot) holds it again, it does not release the hold.
    const snap = await t.market.observations.snapshots
      .find({ sourceId: source._id })
      .sort({ lastFetchedAt: -1 })
      .limit(1)
      .next();
    const r = await t.runSource(source._id, { snapshotId: snap!._id });
    expect(r.state).toBe('COMPLETED');
    expect(await states(source)).toEqual({ count: { VERIFIED_LIVE: 3 }, absences: 0 });
    // The next consecutive empty listing releases it: absences accrue …
    expect(await refresh(source)).toMatchObject({ absenceApplied: true, absent: 3, possiblyStale: 3 });
    expect((await t.market.sources.get(source._id)).health.listingHeld).toBeUndefined();
    // … but absence alone never closes (L1).
    expect(await refresh(source)).toMatchObject({ absenceApplied: true, absent: 3, closed: 0 });
    expect(await states(source)).toEqual({ count: { POSSIBLY_STALE: 3 }, absences: 6 });
    expect(await anomalies(source)).toHaveLength(0);
  }, 120_000);

  it('A-M1: a source without a baseline (pre-M6.2) whose last count is 0 is still held against its live jobs', async () => {
    const token = 'acme-legacy';
    const source = await registerBoard(token);
    const path = `/v1/boards/${token}/jobs`;
    boards.set(path, board(token, 1, 12));
    await refresh(source);
    // As the old empty guard left it: an empty listing was held and recorded itemCount 0.
    await t.market.sources.col.updateOne(
      { _id: source._id },
      { $unset: { 'health.listingBaseline': '' }, $set: { 'health.lastItemCount': 0 } },
    );
    boards.set(path, { jobs: [], meta: { total: 0 } });
    expect(await refresh(source)).toMatchObject({ absenceApplied: false });
    expect(await refresh(source)).toMatchObject({ absenceApplied: false });
    expect(await states(source)).toEqual({ count: { VERIFIED_LIVE: 12 }, absences: 0 });
  }, 120_000);

  it.each([
    ['the baseline write', 'health.listingBaseline'],
    ['the applied-watermark write', 'health.lastListingAppliedAt'],
  ])(
    'a crash at %s replays into a converged baseline (no stale baseline lets a shrink through)',
    async (_label, field) => {
      const token = `acme-crash-${field.split('.')[1]}`;
      const source = await registerBoard(token);
      const path = `/v1/boards/${token}/jobs`;
      boards.set(path, board(token, 1, 30));
      await refresh(source);
      // Inject: the first write touching `field` throws (the process "crashes" there).
      const sources = t.market.sources;
      const real = sources.col;
      let crashed = false;
      const crashing = new Proxy(real, {
        get(target, prop, receiver) {
          if (prop !== 'updateOne') return Reflect.get(target, prop, receiver) as unknown;
          return async (...args: Parameters<typeof real.updateOne>) => {
            if (!crashed && JSON.stringify(args[1]).includes(field)) {
              crashed = true;
              throw new Error(`injected crash at ${field}`);
            }
            return target.updateOne(...args);
          };
        },
      });
      Object.defineProperty(sources, 'col', { get: () => crashing, configurable: true });
      try {
        boards.set(path, board(token, 1, 100));
        await refresh(source); // the finalize node fails once and is retried
      } finally {
        delete (sources as unknown as Record<string, unknown>).col;
      }
      expect(crashed).toBe(true);
      const s = await t.market.sources.get(source._id);
      expect(s.health.listingBaseline).toMatchObject({ count: 100 });
      // 40 is a shrink against the real baseline (100), not against the stale one (30).
      boards.set(path, board(token, 1, 40));
      expect(await refresh(source)).toMatchObject({ absenceApplied: false });
      expect((await states(source)).count.VERIFIED_LIVE).toBe(100);
    },
    120_000,
  );
});

describe('PR #11 review follow-ups: shrink reviews', () => {
  it('A-L6: re-raising refreshes the open item (count, subject); a later dismiss on the key revokes the confirmation', async () => {
    const token = 'acme-revoke';
    const source = await registerBoard(token);
    const path = `/v1/boards/${token}/jobs`;
    boards.set(path, board(token, 1, 100));
    await refresh(source);
    boards.set(path, board(token, 1, 40));
    await refresh(source);
    boards.set(path, board(token, 1, 30));
    await refresh(source);
    const [first] = await anomalies(source);
    // The open item describes the LATEST held listing, which is what the operator confirms.
    expect(first).toMatchObject({ occurrences: 2, context: expect.objectContaining({ count: 30 }) });
    expect(first!.subject).toMatch(/from 100 to 30 jobs/);
    await t.market.reviewService.resolve(first!._id, { action: 'confirm', reason: 'real' }, t.actor);
    // A further collapse from the confirmed size raises a new item on the same (baseline) key …
    boards.set(path, board(token, 1, 3));
    expect(await refresh(source)).toMatchObject({ absenceApplied: false });
    const [second] = await anomalies(source);
    expect(second!.dedupeKey).toBe(first!.dedupeKey);
    // … and dismissing it revokes the standing confirmation: 30 is held again.
    await t.market.reviewService.resolve(
      second!._id,
      { action: 'dismiss', reason: 'not sure any more' },
      t.actor,
    );
    boards.set(path, board(token, 1, 30));
    expect(await refresh(source)).toMatchObject({ absenceApplied: false });
    expect(await states(source)).toEqual({ count: { VERIFIED_LIVE: 100 }, absences: 0 });
  }, 240_000);

  it('an endpoint change via PATCH flags the baseline: a collapse on the new endpoint is held and says so', async () => {
    const token = 'acme-moved';
    const source = await registerBoard(token);
    boards.set(`/v1/boards/${token}/jobs`, board(token, 1, 40));
    await refresh(source);
    // Pointed at another board by mistake (10 jobs).
    boards.set(`/v1/boards/${token}-other/jobs`, board(token, 1, 10));
    await t.market.sources.update(
      source._id,
      { endpoint: { boardToken: token, url: `${server.url}/v1/boards/${token}-other/jobs` } },
      t.actor,
    );
    const flagged = await t.market.sources.get(source._id);
    expect(flagged.health.listingBaseline).toMatchObject({ count: 40 });
    expect(flagged.health.listingBaseline!.endpointChangedAt).toBeInstanceOf(Date);
    expect(await refresh(source)).toMatchObject({ absenceApplied: false });
    const [review] = await anomalies(source);
    expect(review!.reason).toMatch(/endpoint changed/);
    expect(review!.context.baselineEndpointChangedAt).toEqual(expect.any(String));
    expect(await states(source)).toEqual({ count: { VERIFIED_LIVE: 40 }, absences: 0 });
    // Fixed: back on the real board, the listing applies and the flag is gone with the old baseline.
    await t.market.sources.update(
      source._id,
      { endpoint: { boardToken: token, url: `${server.url}/v1/boards/${token}/jobs` } },
      t.actor,
    );
    expect(await refresh(source)).toMatchObject({ absenceApplied: true });
    const after = await t.market.sources.get(source._id);
    expect(after.health.listingBaseline).toMatchObject({ count: 40 });
    expect(after.health.listingBaseline!.endpointChangedAt).toBeUndefined();
  }, 120_000);

  it('B-M2: the standing-confirmation lookup is served by the by_entity index', async () => {
    const { filter, sort } = latestDecisionQuery('source_anomaly:src_x:listing_shrink:snap@1', {
      kind: 'source',
      id: 'src_x',
    });
    const plan = (await t.market.reviews.col.find(filter).sort(sort).limit(1).explain('queryPlanner')) as {
      queryPlanner: { winningPlan: unknown };
    };
    const stages: Array<{ stage?: string; indexName?: string }> = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      const o = n as Record<string, unknown>;
      if (typeof o.stage === 'string') stages.push(o as { stage: string; indexName?: string });
      for (const v of Object.values(o)) if (typeof v === 'object') walk(v);
    };
    walk(plan.queryPlanner.winningPlan);
    expect(stages.some((st) => st.stage === 'COLLSCAN')).toBe(false);
    expect(stages.find((st) => st.stage === 'IXSCAN')?.indexName).toBe('by_entity');
  });

  it('A-M2/B-M1: orphaned pre-M6.2 empty-listing reviews are dismissed idempotently at startup', async () => {
    const source = await registerBoard('acme-legacy-review');
    const now = new Date();
    const legacy = {
      _id: `rev_legacy_${source._id}`,
      type: 'source_anomaly' as const,
      severity: 'medium' as const,
      priority: 200,
      status: 'open' as const,
      dedupeKey: `source_anomaly:${source._id}:empty`,
      entity: { kind: 'source' as const, id: source._id },
      subject: `${source.name}: listing returned no jobs`,
      reason:
        'The board previously had jobs; no jobs were closed. Confirm the board is really empty or retry.',
      evidence: [],
      candidates: [],
      observationIds: [],
      context: { sourceId: source._id, snapshotId: 'snap_legacy' },
      allowedActions: ['retry' as const, 'confirm' as const, 'dismiss' as const],
      occurrences: 1,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    await t.market.reviews.col.insertOne(legacy);
    await t.market.ensureReady();
    await t.market.ensureReady(); // a second process starting: nothing more happens
    const item = await t.market.reviews.get(legacy._id);
    expect(item).toMatchObject({
      status: 'dismissed',
      resolution: expect.objectContaining({
        action: 'dismiss',
        actor: expect.objectContaining({ kind: 'system' }),
      }),
    });
    expect(item.resolution!.reason).toMatch(/Superseded by the M6.2 listing shrink guard/);
    expect(await t.market.audit.list({ reviewItemId: legacy._id })).toHaveLength(1);
  });
});
