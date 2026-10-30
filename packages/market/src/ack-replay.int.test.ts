/**
 * Adversarial at-least-once check (audit H-3): every Market flow is run twice on separate
 * databases — normally, and with every workflow node's first completion acknowledgement lost
 * and every fan-out chunk's first result write lost, so each capability and each item body
 * executes at least twice for the same logical invocation. The resulting domain state must be
 * identical.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { DefaultAiGateway, FixtureAiProvider } from '@aptamind/ai';
import { createTestInfra, startFixtureServer, type TestInfra, waitForRun } from '@aptamind/testing';
import type { WorkflowEngine } from '@aptamind/workflows';
import { AI_GATEWAY, AI_TASKS, AiTaskRegistry } from '@aptamind/workflow-nodes';
import type { MarketDomain } from './market-domain';
import { createMarketTestRuntime } from './test-harness';
import { marketAiTasks } from './workflow-nodes';

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});

interface Faults {
  lostAcks: number;
  lostChunkResults: number;
}

/** Lose the first completion acknowledgement of every node run and the first result write of every chunk. */
function injectFaults(engine: WorkflowEngine): Faults {
  const faults: Faults = { lostAcks: 0, lostChunkResults: 0 };
  const nodeRuns = engine.stores.nodeRuns;
  const finish = nodeRuns.finish.bind(nodeRuns);
  const acked = new Set<string>();
  nodeRuns.finish = async (fence, state, ...rest) => {
    if (state === 'COMPLETED' && !acked.has(fence.nodeRunId)) {
      acked.add(fence.nodeRunId);
      faults.lostAcks += 1;
      throw new Error('injected: acknowledgement lost');
    }
    return finish(fence, state, ...rest);
  };
  const chunks = engine.stores.chunks;
  const append = chunks.appendResults.bind(chunks);
  const written = new Set<string>();
  chunks.appendResults = async (lease, results) => {
    if (results.length && !written.has(lease.chunkId)) {
      written.add(lease.chunkId);
      faults.lostChunkResults += 1;
      throw new Error('injected: chunk results lost');
    }
    return append(lease, results);
  };
  return faults;
}

async function scenario(label: string, inject: boolean) {
  const infra: TestInfra = await createTestInfra(label);
  const t = await createMarketTestRuntime(infra, { leaseMs: 1_500 });
  let aiCalls = 0;
  const tasks = new AiTaskRegistry();
  for (const task of marketAiTasks) tasks.register(task);
  t.runtime.services
    .register(
      AI_GATEWAY,
      new DefaultAiGateway(
        new FixtureAiProvider(() => {
          aiCalls += 1;
          return {
            requirements: [
              { text: '5+ years building services', importance: 'critical', category: 'experience' },
            ],
          };
        }),
      ),
    )
    .register(AI_TASKS, tasks);
  let listing = 'acme-listing-t1.json';
  const server = await startFixtureServer(async (req, res) => {
    const url = (req.url ?? '').split('?')[0] ?? '';
    const body = async (...p: string[]) => t.fixture(...p);
    if (url === '/government/publications/register-of-licensed-sponsors-workers') {
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(await body('uk-sponsor', 'publication-page.html'));
    } else if (url === '/media/fixture/2026-09-27_-_Worker_and_Temporary_Worker.csv') {
      res.writeHead(200, { 'content-type': 'text/csv' }).end(await body('uk-sponsor', 'register-t1.csv'));
    } else if (url === '/v1/boards/acme/jobs') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(await body('ats', 'greenhouse', listing));
    } else if (url.startsWith('/posting/')) {
      res.writeHead(404).end('gone');
    } else res.writeHead(404).end();
  });
  cleanups.push(async () => {
    await t.stop();
    await server.close();
    await infra.cleanup();
  });
  const faults = inject ? injectFaults(t.runtime.engine) : null;
  const m: MarketDomain = t.market;
  const run = async (sourceId: string) => {
    const r = await t.runSource(sourceId);
    if (r.state !== 'COMPLETED')
      throw new Error(
        `run ${r.workflowKey} ${r.state}: ${JSON.stringify(r.failedNodeIds)} ${r.error?.message}`,
      );
  };

  // M2: UK sponsor register import.
  const sponsor = (
    await m.sources.register(
      {
        key: 'uk-sponsor-register',
        name: 'UK sponsor register (fixture server)',
        category: 'company_universe',
        provider: 'uk_home_office_sponsor_register',
        endpoint: { url: `${server.url}/government/publications/register-of-licensed-sponsors-workers` },
        acquisition: { workflowKey: 'market.uk_sponsor_register.import' },
        freshness: { policyClass: 'source.sponsor_register', maxAgeMinutes: 4320 },
        authority: { tier: 'official_registry', listingIsComplete: true },
        governance: { accessMethod: 'public_download' },
      },
      t.actor,
    )
  ).source;
  await run(sponsor._id);

  // M3: ATS listing t1, then t2 twice (second complete absence closes 4012345005 — corroborated
  // by a not_found since the first absence, ruling L1).
  const acme = (await m.companies.col.findOne({ 'identity.normalizedName': 'acme ltd' }))!;
  const gh = (
    await m.sources.register(
      {
        key: 'greenhouse:acme',
        name: 'Acme (greenhouse)',
        category: 'job_source',
        provider: 'greenhouse',
        endpoint: { boardToken: 'acme', url: `${server.url}/v1/boards/acme/jobs` },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId: acme._id,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      },
      t.actor,
    )
  ).source;
  await run(gh._id);
  listing = 'acme-listing-t2.json';
  await run(gh._id);
  // Stands in for a not_found verification after the first absence (L1: absence alone never closes).
  // (Recorded directly as verification evidence: the lifecycle is derived from evidence.)
  const absent = (await m.jobs.col.findOne({ sourceKeys: `${gh._id}:4012345005` }))!;
  const copy = absent.sourceRefs.find((r) => r.externalId === '4012345005')!;
  await m.evidence.record([
    {
      _id: `test:nf:${copy.key}`,
      jobId: absent._id,
      copyKey: copy.key,
      sourceId: gh._id,
      board: copy.board ?? null,
      at: new Date(),
      kind: 'verification',
      outcome: 'not_found',
    },
  ]);
  await run(gh._id);

  // M5: two verification runs (two independent operations) of a job whose posting is gone.
  const target = (await m.jobs.col.findOne({ sourceKeys: `${gh._id}:4012345002` }))!;
  await m.jobs.col.updateOne(
    { _id: target._id },
    {
      $set: {
        'application.ats': null,
        'sourceRefs.$[].provider': 'careers_page',
        'sourceRefs.$[].postingUrl': `${server.url}/posting/${target._id}`,
      },
    },
  );
  for (let i = 0; i < 2; i++) {
    const v = await t.runtime.engine.startRun({
      workflowKey: 'market.jobs.verify_due',
      input: { jobIds: [target._id] },
      trigger: { kind: 'manual' },
    });
    expect((await waitForRun(t.runtime.engine, v._id, undefined, 60_000)).state).toBe('COMPLETED');
  }

  // Law H: one AI proposal run.
  await t.runtime.catalog.register({
    key: 'test.ai_requirements',
    title: 'AI requirements proposal',
    nodes: [
      {
        id: 'start',
        capability: { type: 'core.manual_trigger', version: 1 },
        input: { payload: { $ref: 'run.input' } },
      },
      {
        id: 'propose',
        capability: { type: 'market.propose_job_requirements', version: 1 },
        input: { jobId: { $ref: 'nodes.start.output.payload.jobId' } },
      },
    ],
    edges: [{ from: 'start', to: 'propose' }],
  });
  const aiJob = (await m.jobs.col.findOne({ sourceKeys: `${gh._id}:4012345001` }))!;
  const ai = await t.runtime.engine.startRun({
    workflowKey: 'test.ai_requirements',
    input: { jobId: aiJob._id },
    trigger: { kind: 'manual' },
  });
  expect((await waitForRun(t.runtime.engine, ai._id)).state).toBe('COMPLETED');

  return { summary: await summarize(m), aiCalls, faults, aiLedger: await m.aiProposals.col.find().toArray() };
}

/** Domain state that must not depend on how many times capabilities executed. */
async function summarize(m: MarketDomain) {
  const companies = await m.companies.col.find({}).sort({ 'identity.normalizedName': 1 }).toArray();
  const jobs = await m.jobs.col.find({}).toArray();
  const byKey = (keys: string[]) =>
    keys
      .map((k) => k.split(':').slice(1).join(':'))
      .sort()
      .join(',');
  return {
    companies: companies.map((c) => ({
      name: c.identity.normalizedName,
      status: c.status,
      licences: c.employment.sponsorship.licences.map((l) => `${l.route}:${l.status}`).sort(),
      capability: c.employment.sponsorship.capability.value,
    })),
    companyObservations: await m.observations.companyObservations.countDocuments({}),
    jobObservations: await m.observations.jobObservations.countDocuments({}),
    snapshots: await m.observations.snapshots.countDocuments({}),
    fetchCounts: (await m.observations.snapshots.find({}).toArray()).map((s) => s.fetchCount).sort(),
    seenCounts: (await m.observations.jobObservations.find({}).toArray()).map((o) => o.seenCount).sort(),
    jobs: jobs
      .map((j) => ({
        keys: byKey(j.sourceKeys),
        title: j.identity.title.value,
        state: j.lifecycle.state,
        absences: j.lifecycle.consecutiveAbsences,
        notFound: j.lifecycle.consecutiveNotFound,
        transitions: j.lifecycle.history.map((h) => `${h.from}->${h.to}`),
        workModel: j.geography.workModel.value,
        proposals: j.aiProposals.length,
        refs: j.sourceRefs.length,
      }))
      .sort((a, b) => a.keys.localeCompare(b.keys)),
    reviews: (await m.reviews.col.find({}).toArray()).map((r) => `${r.type}:${r.status}:${r.subject}`).sort(),
    verifications: (await m.verification.col.find({}).toArray())
      .map((v) => `${v.outcome}:${v.status}`)
      .sort(),
    // Source health counters are LOGICAL (per run): replays must not inflate them (H-3 follow-up).
    sourceStats: (
      await m.sources.col.find({ key: { $in: ['uk-sponsor-register', 'greenhouse:acme'] } }).toArray()
    )
      .map(
        (s) =>
          `${s.key}:${s.stats.attempts}/${s.stats.successes}/${s.stats.failures}:${s.health.consecutiveFailures}:${s.health.status}`,
      )
      .sort(),
  };
}

describe('H-3: every side-effecting capability is safe under re-execution at the acknowledgement boundary', () => {
  it('produces identical domain state with every acknowledgement and chunk result write lost once', async () => {
    const baseline = await scenario('ack_base', false);
    const replayed = await scenario('ack_faults', true);
    expect(replayed.faults!.lostAcks).toBeGreaterThanOrEqual(20); // one per node run (every node of every run)
    expect(replayed.faults!.lostChunkResults).toBeGreaterThanOrEqual(1); // first result write of every chunk
    expect(replayed.summary).toEqual(baseline.summary);
    // Sanity: the scenario exercised what it claims to.
    const closed = baseline.summary.jobs.find((j) => j.keys === '4012345005');
    expect(closed?.state).toBe('CLOSED');
    const verified = baseline.summary.jobs.find((j) => j.keys === '4012345002');
    expect(verified).toMatchObject({ state: 'CLOSED', notFound: 2 });
    expect(baseline.summary.jobs.find((j) => j.keys === '4012345001')?.proposals).toBe(1);
    // Logical run counters: 1 sponsor run, 3 ATS runs — however often their steps were replayed.
    expect(baseline.summary.sourceStats).toEqual([
      'greenhouse:acme:3/3/0:0:healthy',
      'uk-sponsor-register:1/1/0:0:healthy',
    ]);
    // AI: re-execution after a lost acknowledgement reused the recorded result — no second call.
    expect(baseline.aiCalls).toBe(1);
    expect(replayed.aiCalls).toBe(1);
    expect(replayed.aiLedger).toHaveLength(1);
    expect(replayed.aiLedger[0]).toMatchObject({ status: 'completed', calls: 1 });
  }, 600_000);
});
