/**
 * Listing integrity (M6.1): an entry the adapter drops — malformed, or unlisted on Ashby — is
 * never evidence that its job disappeared. The job keeps its lifecycle state across repeated
 * listings, snapshot reprocessing, lost acknowledgements (every node re-executed) and a worker
 * restart; the drop is surfaced as a `parser_failure` review instead of being logged only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestInfra, startFixtureServer, type TestInfra } from '@aptamind/testing';
import type { WorkflowEngine } from '@aptamind/workflows';
import type { WorkflowSpec } from '@aptamind/workflow-sdk';
import type { JobDoc } from './jobs/job.schema';
import type { SourceDoc } from './sources/source.schema';
import { createMarketTestRuntime } from './test-harness';
import { atsRefresh } from './workflows';

type Harness = Awaited<ReturnType<typeof createMarketTestRuntime>>;

let infra: TestInfra;
let t: Harness;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let companyId: string;
/** Current response body per board path (JSON). */
const boards = new Map<string, unknown>();

const TARGET = 101;
/** A Greenhouse board of `n` valid jobs (ids 101…), optionally with the target entry malformed. */
function greenhouseBoard(n: number, opts: { malformedTarget?: boolean; revision?: number } = {}) {
  const jobs = Array.from({ length: n }, (_, i) => {
    const id = TARGET + i;
    const job = {
      id,
      title: `Engineer ${id}`,
      updated_at: '2026-09-01T00:00:00Z',
      location: { name: 'London, UK' },
      absolute_url: `https://boards.greenhouse.io/acme/jobs/${id}`,
      content: `<p>Build things. Revision ${opts.revision ?? 0}.</p>`,
      departments: [{ name: 'Engineering' }],
    };
    // Same id, title removed: the entry is still on the board but no longer parses.
    return opts.malformedTarget && id === TARGET ? { ...job, title: null } : job;
  });
  return { jobs, meta: { total: jobs.length } };
}

beforeAll(async () => {
  infra = await createTestInfra('listing_integrity');
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
        key: 'directory:integrity',
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

async function registerBoard(provider: 'greenhouse' | 'ashby', token: string): Promise<SourceDoc> {
  const path = provider === 'greenhouse' ? `/v1/boards/${token}/jobs` : `/posting-api/job-board/${token}`;
  return (
    await t.market.sources.register(
      {
        key: `${provider}:${token}`,
        name: `${token} (${provider})`,
        category: 'job_source',
        provider,
        endpoint: { boardToken: token, url: `${server.url}${path}` },
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

async function run(h: Harness, sourceId: string, extra: Record<string, unknown> = {}) {
  const r = await h.runSource(sourceId, extra);
  if (r.state !== 'COMPLETED') throw new Error(`run ${r.state}: ${r.error?.message}`);
  return r;
}

const jobOf = async (source: SourceDoc, externalId: string | number): Promise<JobDoc> =>
  (await t.market.jobs.col.findOne({ sourceKeys: `${source._id}:${externalId}` })) as JobDoc;

/** Lose the first completion acknowledgement of every node run (each node executes twice). */
function loseFirstAcks(engine: WorkflowEngine): () => number {
  let lost = 0;
  const nodeRuns = engine.stores.nodeRuns;
  const finish = nodeRuns.finish.bind(nodeRuns);
  const acked = new Set<string>();
  nodeRuns.finish = async (fence, state, ...rest) => {
    if (state === 'COMPLETED' && !acked.has(fence.nodeRunId)) {
      acked.add(fence.nodeRunId);
      lost += 1;
      throw new Error('injected: acknowledgement lost');
    }
    return finish(fence, state, ...rest);
  };
  return () => lost;
}

describe('M6.1: a dropped listing entry is never treated as absent', () => {
  it('a malformed Greenhouse entry keeps its job live across repeated listings, replays and a restart', async () => {
    const source = await registerBoard('greenhouse', 'acme-malformed');
    const path = `/v1/boards/acme-malformed/jobs`;
    boards.set(path, greenhouseBoard(12));
    await run(t, source._id);
    expect((await jobOf(source, TARGET)).lifecycle.state).toBe('VERIFIED_LIVE');

    // 1 malformed entry out of 12 (≤ 10 %): the listing stays complete and absence handling
    // runs for the other jobs, but the malformed entry's job is seen, not absent.
    boards.set(path, greenhouseBoard(12, { malformedTarget: true }));
    const first = await run(t, source._id);
    const fetchOut = (await t.runtime.engine.stores.nodeRuns.findCompletedOutput(first._id, 'fetch'))!
      .output as { complete: boolean; skipped: Array<{ externalId: string | null; kind: string }> };
    expect(fetchOut.complete).toBe(true);
    expect(fetchOut.skipped).toEqual([
      expect.objectContaining({ externalId: String(TARGET), kind: 'malformed' }),
    ]);
    await run(t, source._id);
    await run(t, source._id);

    // Reprocessing the malformed snapshot is not a new absence either.
    const snap = await t.market.observations.snapshots
      .find({ sourceId: source._id })
      .sort({ lastFetchedAt: -1 })
      .limit(1)
      .next();
    await run(t, source._id, { snapshotId: snap!._id });

    // Every node's first acknowledgement lost: capabilities re-execute; still no absence.
    const lost = loseFirstAcks(t.runtime.engine);
    await run(t, source._id);
    await run(t, source._id);
    expect(lost()).toBeGreaterThanOrEqual(6); // trigger, fetch, ingest, finalize… of both runs

    // Worker restart: a fresh runtime on the same database continues from durable state.
    await t.stop();
    t = await createMarketTestRuntime(infra);
    await run(t, source._id);
    await run(t, source._id);

    const target = await jobOf(source, TARGET);
    expect(target.lifecycle.state).toBe('VERIFIED_LIVE');
    expect(target.lifecycle.consecutiveAbsences).toBe(0);
    expect(target.lifecycle.history.map((h) => h.to)).toEqual(['VERIFIED_LIVE']);
    expect(target.sourceRefs.every((r) => r.present)).toBe(true);
    // A-L5 / ruling U1: the skipped-but-identified entry is on the board, so the latest listing's
    // fetch time is its last sighting — but it was not read, so it is not a verification.
    const latest = await t.market.observations.snapshots
      .find({ sourceId: source._id })
      .sort({ lastFetchedAt: -1 })
      .limit(1)
      .next();
    expect(target.sourceRefs[0]!.lastSeenAt).toEqual(latest!.lastFetchedAt);
    expect(target.lifecycle.lastSeenAt).toEqual(latest!.lastFetchedAt);
    expect(target.lifecycle.lastVerifiedAt!.getTime()).toBeLessThan(latest!.lastFetchedAt.getTime());
    expect(target.sourceRefs[0]!.providerState).toBeUndefined();
    // The other jobs are unaffected (absence handling itself still ran).
    expect(
      (await t.market.jobs.col.find({ 'sourceRefs.sourceId': source._id }).toArray()).map(
        (j) => j.lifecycle.state,
      ),
    ).toEqual(Array(12).fill('VERIFIED_LIVE'));

    // The drop is a reviewable parser problem, not a log line: one open item with counts + sample.
    const reviews = await t.market.reviews.col
      .find({ type: 'parser_failure', 'entity.id': source._id, status: 'open' })
      .toArray();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      severity: 'low',
      context: expect.objectContaining({ sourceId: source._id, malformed: 1, unlisted: 0 }),
    });
    expect((reviews[0]!.context.sample as string[])[0]).toMatch(/skipped malformed job \(id 101\)/);

    // Once the entry parses again the job is simply seen again.
    boards.set(path, greenhouseBoard(12, { revision: 0 }));
    await run(t, source._id);
    expect((await jobOf(source, TARGET)).lifecycle.state).toBe('VERIFIED_LIVE');
  }, 180_000);

  it('a job that becomes unlisted on Ashby is not closed', async () => {
    const source = await registerBoard('ashby', 'gamma-unlisted');
    const path = '/posting-api/job-board/gamma-unlisted';
    const board = (unlisted: boolean) => ({
      jobs: ['a1', 'a2', 'a3'].map((id) => ({
        id,
        title: `Role ${id}`,
        location: 'Remote',
        isListed: !(unlisted && id === 'a1'),
        jobUrl: `https://jobs.ashbyhq.com/gamma-unlisted/${id}`,
        descriptionPlain: 'Build things.',
      })),
    });
    boards.set(path, board(false));
    await run(t, source._id);
    boards.set(path, board(true));
    await run(t, source._id);
    await run(t, source._id);
    await run(t, source._id);
    const a1 = await jobOf(source, 'a1');
    expect(a1.lifecycle.state).toBe('VERIFIED_LIVE');
    expect(a1.lifecycle.consecutiveAbsences).toBe(0);
    // Unlisted is a provider state, not a parse problem: no parser_failure review.
    expect(
      await t.market.reviews.col.countDocuments({ type: 'parser_failure', 'entity.id': source._id }),
    ).toBe(0);
    // B-M5 / ruling U1: the copy records the provider state ("hidden by provider"). A hidden job
    // is not verified by being on the board: it decays honestly through the stale sweep like any
    // unconfirmed job, and the Ashby check of a hidden entry is inconclusive, so it stays
    // POSSIBLY_STALE — never closed by absence, because it is on the board.
    expect(a1.sourceRefs[0]).toMatchObject({ providerState: 'unlisted', present: true });
    // Five days pass without a verification: the copy's only mapped sighting (its last
    // confirmation) is moved back in time — the lifecycle is derived from evidence (6a01b36).
    await t.market.evidence.col.updateMany({ copyKey: a1.sourceRefs[0]!.key, skipped: { $ne: true } }, [
      { $set: { at: { $subtract: ['$at', 5 * 24 * 3600_000] } } },
    ]);
    await t.market.evidence.dropCheckpoint(a1._id); // (derived from the evidence just moved)
    await t.market.evidence.recompute(a1._id); // what the next recompute (e.g. the sweep) derives
    expect((await jobOf(source, 'a1')).lifecycle.state).toBe('POSSIBLY_STALE');
    const v = await t.market.verification.verify((await jobOf(source, 'a1'))._id, t.runtime.http, {
      operationKey: 'hidden-a1',
    });
    expect(v).toMatchObject({ outcome: 'inconclusive', detail: 'ashby API responded 200' });
    await run(t, source._id);
    expect((await jobOf(source, 'a1')).lifecycle).toMatchObject({
      state: 'POSSIBLY_STALE',
      consecutiveAbsences: 0,
    });
    // Listed again: the provider state is cleared by the mapped sighting.
    boards.set(path, board(false));
    await run(t, source._id);
    const relisted = await jobOf(source, 'a1');
    expect(relisted.sourceRefs[0]!.providerState).toBeUndefined();
    expect(relisted.lifecycle.state).toBe('VERIFIED_LIVE');
    // Hidden again, then gone from the board: the absence clears the provider state too.
    boards.set(path, board(true));
    await run(t, source._id);
    expect((await jobOf(source, 'a1')).sourceRefs[0]!.providerState).toBe('unlisted');
    boards.set(path, { jobs: board(false).jobs.filter((j) => j.id !== 'a1') });
    await run(t, source._id);
    expect((await jobOf(source, 'a1')).sourceRefs[0]).toMatchObject({ present: false });
    expect((await jobOf(source, 'a1')).sourceRefs[0]!.providerState).toBeUndefined();
  }, 120_000);

  it('B-M4: an unmappable-entries finding is keyed by (adapter version, malformed set); a dismissed set is not raised again', async () => {
    const source = await registerBoard('greenhouse', 'acme-findings');
    const path = '/v1/boards/acme-findings/jobs';
    const open = () =>
      t.market.reviews.col
        .find({ type: 'parser_failure', 'entity.id': source._id, status: 'open' })
        .toArray();
    boards.set(path, greenhouseBoard(12, { malformedTarget: true }));
    await run(t, source._id);
    await run(t, source._id);
    const [first] = await open();
    expect(first).toMatchObject({
      occurrences: 2,
      context: expect.objectContaining({ adapterVersion: 'greenhouse@1' }),
    });
    expect(first!.dedupeKey).toMatch(
      new RegExp(`^parser_failure:${source._id}:entries:greenhouse@1:[0-9a-f]{16}$`),
    );
    await t.market.reviewService.resolve(
      first!._id,
      { action: 'dismiss', reason: 'known provider quirk' },
      t.actor,
    );
    // The same malformed set again: suppressed.
    await run(t, source._id);
    expect(await open()).toHaveLength(0);
    // Another entry breaks too: a new finding.
    const board = greenhouseBoard(12, { malformedTarget: true });
    board.jobs[5] = { ...board.jobs[5]!, title: null } as unknown as (typeof board.jobs)[number];
    boards.set(path, board);
    await run(t, source._id);
    const [second] = await open();
    expect(second!.dedupeKey).not.toBe(first!.dedupeKey);
    expect(second!.context).toMatchObject({ malformed: 2 });
    // Back to the first (dismissed) set: suppressed, and a suppressed finding supersedes nothing.
    boards.set(path, greenhouseBoard(12, { malformedTarget: true }));
    await run(t, source._id);
    expect((await open()).map((r) => r._id)).toEqual([second!._id]);
    // A third set: a new finding replaces the open one (dismissed as superseded, audited).
    boards.set(
      path,
      (() => {
        const b = greenhouseBoard(12);
        b.jobs[3] = { ...b.jobs[3]!, title: null } as unknown as (typeof b.jobs)[number];
        return b;
      })(),
    );
    await run(t, source._id);
    const now = await open();
    expect(now).toHaveLength(1);
    expect(now[0]!._id).not.toBe(second!._id);
    expect(await t.market.reviews.get(second!._id)).toMatchObject({
      status: 'dismissed',
      resolution: expect.objectContaining({ actor: expect.objectContaining({ kind: 'system' }) }),
    });
    // B LOW-2: a system supersession is not an operator dismissal — the second set, seen again,
    // is raised again (a new item on its key), superseding the third.
    const secondSet = greenhouseBoard(12, { malformedTarget: true });
    secondSet.jobs[5] = { ...secondSet.jobs[5]!, title: null } as unknown as (typeof secondSet.jobs)[number];
    boards.set(path, secondSet);
    await run(t, source._id);
    const again = await open();
    expect(again).toHaveLength(1);
    expect(again[0]!.dedupeKey).toBe(second!.dedupeKey);
    expect(again[0]!._id).not.toBe(second!._id);
  }, 120_000);

  it('a board where more than 10 % of entries fail to parse is not a complete listing', async () => {
    const source = await registerBoard('greenhouse', 'acme-drift');
    const path = '/v1/boards/acme-drift/jobs';
    boards.set(path, greenhouseBoard(10));
    await run(t, source._id);
    // Provider shape drift: two entries malformed (20 %) and job 110 genuinely removed.
    const drifted = greenhouseBoard(9);
    drifted.jobs = drifted.jobs.map((j, i) => (i < 2 ? { ...j, title: null } : j)) as typeof drifted.jobs;
    drifted.meta.total = drifted.jobs.length;
    boards.set(path, drifted);
    const r = await run(t, source._id);
    const finalize = (await t.runtime.engine.stores.nodeRuns.findCompletedOutput(r._id, 'finalize'))!
      .output as { absenceApplied: boolean; reason: string };
    expect(finalize.absenceApplied).toBe(false);
    expect(finalize.reason).toMatch(/not a complete snapshot/);
    await run(t, source._id);
    // Nothing closes while the board cannot be read reliably — not even the removed job.
    expect((await jobOf(source, 110)).lifecycle.state).toBe('VERIFIED_LIVE');
    expect((await jobOf(source, TARGET)).lifecycle.state).toBe('VERIFIED_LIVE');
  }, 120_000);

  it('a run pinned to the pre-M6.1 template (fetch@1 → finalize@1) cannot close a job over a dropped entry', async () => {
    // The v1 pair has no skipped[] channel: fetch@1 reports any listing with a skipped entry as
    // incomplete, so its finalizer applies no absences at all.
    const legacy: WorkflowSpec = JSON.parse(
      JSON.stringify({ ...atsRefresh, key: 'test.ats.refresh_v1' }),
    ) as WorkflowSpec;
    for (const node of legacy.nodes) {
      if (node.capability.type === 'market.fetch_job_board') node.capability.version = 1;
      if (node.capability.type === 'market.finalize_job_listing') {
        node.capability.version = 1;
        delete (node.input as Record<string, unknown>).skipped;
      }
    }
    await t.runtime.catalog.register(legacy);
    const source = await registerBoard('greenhouse', 'acme-legacy');
    await t.market.sources.col.updateOne(
      { _id: source._id },
      { $set: { 'acquisition.workflowKey': legacy.key } },
    );
    const path = '/v1/boards/acme-legacy/jobs';
    boards.set(path, greenhouseBoard(12));
    await run(t, source._id);
    boards.set(path, greenhouseBoard(12, { malformedTarget: true }));
    const r = await run(t, source._id);
    await run(t, source._id);
    const finalize = (await t.runtime.engine.stores.nodeRuns.findCompletedOutput(r._id, 'finalize'))!
      .output as { absenceApplied: boolean; reason: string };
    expect(finalize).toMatchObject({ absenceApplied: false, reason: 'listing is not a complete snapshot' });
    expect((await jobOf(source, TARGET)).lifecycle.state).toBe('VERIFIED_LIVE');
  }, 120_000);
});
