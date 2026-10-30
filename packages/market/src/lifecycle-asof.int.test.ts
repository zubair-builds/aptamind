/**
 * The derived lifecycle evaluates standing and board AS OF THE EVIDENCE TIME (PR #11
 * re-verification #9, DECISION_LOG 15c965b). The reviewer's sequences, end to end:
 *
 *  - HIGH-1 (a) disabling a source never un-closes a CLOSED job; (b) disabling the source that
 *    kept a job listed never closes it (least of all backdated); (c) a 404 streak never spans a
 *    disabled interval; (d) a standing change re-derives the source's jobs (time-based decay); a
 *    board change after a closure keeps the CLOSED history;
 *  - MEDIUM-1: a merge re-derives the survivor, and a not_found about one copy never closes a job
 *    another copy shows live;
 *  - MEDIUM-3: recompute reads are bounded by a checkpoint (5,000 evidence documents on one job);
 *  - Low 1: a recorder that inserted evidence always completes a revision-bumping write;
 *  - Low 4: reprocessing an uploaded snapshot never changes source health.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestInfra, startFixtureServer, type TestInfra, waitForRun } from '@aptamind/testing';
import type { JobDoc } from './jobs/job.schema';
import { deriveLifecycle } from './jobs/lifecycle';
import { listingEvidenceKey } from './jobs/job-pipeline';
import type { SourceDoc } from './sources/source.schema';
import { createMarketTestRuntime } from './test-harness';

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let companyId: string;
const bodies = new Map<string, unknown>();
const tick = () => new Promise((r) => setTimeout(r, 5));
const DAY = 24 * 3600_000;

beforeAll(async () => {
  infra = await createTestInfra('lifecycle_asof');
  t = await createMarketTestRuntime(infra);
  server = await startFixtureServer(async (req, res) => {
    const body = bodies.get((req.url ?? '').split('?')[0] ?? '');
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  const directory = (
    await t.market.sources.register(
      {
        key: 'directory:asof',
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
    externalId: 'asof-co',
    payload: { name: 'As Of Evidence Ltd', aliases: [], externalIds: [], locations: [], industries: [] },
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

const svc = () => t.market.verification;
let opKey = 0;
const verify = (jobId: string) => svc().verify(jobId, t.runtime.http, { operationKey: `asof-${++opKey}` });
const toStates = (j: JobDoc) => j.lifecycle.history.map((h) => h.to);

async function greenhouse(token: string) {
  const path = (board: string) => `/v1/boards/${board}/jobs`;
  const source = (
    await t.market.sources.register(
      {
        key: `greenhouse:${token}`,
        name: `${token} (greenhouse)`,
        category: 'job_source',
        provider: 'greenhouse',
        endpoint: { boardToken: token, url: `${server.url}${path(token)}?content=true` },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      },
      t.actor,
    )
  ).source;
  const gh = (id: number) => ({
    id,
    title: `Role ${token} ${id}`,
    absolute_url: `https://job-boards.greenhouse.io/${token}/jobs/${id}`,
    location: { name: 'Remote' },
    updated_at: '2026-09-01T10:00:00Z',
    content: `&lt;p&gt;Own the unique ${token} programme number ${id} end to end.&lt;/p&gt;`,
  });
  const of = async (id: number) =>
    (await t.market.jobs.col.findOne({ sourceKeys: `${source._id}:${id}` })) as JobDoc;
  const listing = async (ids: number[], board = token) => {
    bodies.set(path(board), { jobs: ids.map(gh) });
    expect((await t.runSource(source._id)).state).toBe('COMPLETED');
  };
  const live = (id: number) => bodies.set(`${path(token)}/${id}`, gh(id));
  const gone = (id: number) => bodies.delete(`${path(token)}/${id}`);
  /** Close job `id` with two direct 404s. */
  const close = async (id: number) => {
    gone(id);
    const j = await of(id);
    await verify(j._id);
    await tick();
    await verify(j._id);
    const closed = await of(id);
    expect(closed.lifecycle.state).toBe('CLOSED');
    return closed;
  };
  return { source, path, gh, of, listing, live, gone, close };
}

async function careersSite(key: string) {
  return (
    await t.market.sources.register(
      {
        key: `careers:${key}`,
        name: `${key} careers site`,
        category: 'job_source',
        provider: 'careers_page',
        acquisition: { workflowKey: 'market.careers_page.crawl' },
        companyId,
        freshness: { policyClass: 'source.careers_page', maxAgeMinutes: 2160 },
        authority: { tier: 'official_site', listingIsComplete: false },
        governance: { accessMethod: 'public_web' },
      },
      t.actor,
    )
  ).source as SourceDoc;
}

/** The standing-change recompute run of a source (launched by `setEnabled`). */
async function standingRuns(sourceId: string) {
  return t.runtime.engine.runs.find({ 'labels.standingOfSource': sourceId }).toArray();
}
async function awaitStandingRuns(sourceId: string, n: number) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const runs = await standingRuns(sourceId);
    if (runs.length >= n) {
      for (const r of runs) await waitForRun(t.runtime.engine, r._id, undefined, 30_000);
      return runs;
    }
    if (Date.now() > deadline) throw new Error(`expected ${n} standing runs for ${sourceId}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('HIGH-1: a standing change never rewrites history', () => {
  it('(a) disabling the source that closed a job keeps it CLOSED, with its history', async () => {
    const g = await greenhouse('asof-a');
    await g.listing([1, 2]);
    const closed = await g.close(1);
    await t.market.sources.setEnabled(g.source._id, false, t.actor);
    await awaitStandingRuns(g.source._id, 1);
    await t.market.evidence.recompute(closed._id, { schedule: { kind: 'sweep' } });
    const after = await g.of(1);
    expect(after.lifecycle).toMatchObject({ state: 'CLOSED', closedAt: closed.lifecycle.closedAt });
    expect(after.lifecycle.history).toEqual(closed.lifecycle.history);
  });

  it('(b) disabling the source that kept a job listed does not close it, least of all backdated', async () => {
    const g = await greenhouse('asof-b');
    await g.listing([1, 2, 3]);
    const j = await g.of(1);
    const site = await careersSite('asof-b');
    const p = g.gh(1);
    const out = await t.market.jobPipeline.process({
      source: site,
      locator: 'https://asof-b.example/careers/1',
      payload: {
        externalId: 'site-1',
        title: p.title,
        descriptionText: 'Own the unique asof-b programme number 1 end to end.',
        locations: [{ text: 'Remote' }],
        postingUrl: `${server.url}/careers/asof-b/1`, // local: answers 404
        provider: { name: 'careers_page' },
      },
      parser: { name: 'test', version: '1' },
    });
    expect('jobId' in out && out.jobId).toBe(j._id);
    await tick();
    await g.listing([2, 3]);
    await g.listing([2, 3]);
    g.gone(1);
    await verify(j._id);
    const listed = await g.of(1);
    expect(listed.lifecycle.state).not.toBe('CLOSED'); // the site copy keeps it listed
    await t.market.sources.setEnabled(site._id, false, t.actor);
    await awaitStandingRuns(site._id, 1);
    const after = await g.of(1);
    expect(after.lifecycle.state).not.toBe('CLOSED');
    expect(after.lifecycle.closedAt).toBeUndefined();
    expect(toStates(after)).not.toContain('CLOSED');
    // From the disable on, the site copy is unknown: the next absence counts (a new run).
    await tick();
    await g.listing([2, 3]);
    expect((await g.of(1)).lifecycle).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveAbsences: 1 });
  });

  it('(c) a 404 streak never spans a disabled interval', async () => {
    const g = await greenhouse('asof-c');
    await g.listing([1, 2]);
    const j = await g.of(1);
    g.gone(1);
    await verify(j._id);
    expect((await g.of(1)).lifecycle).toMatchObject({ consecutiveNotFound: 1 });
    await t.market.sources.setEnabled(g.source._id, false, t.actor);
    await tick();
    await t.market.sources.setEnabled(g.source._id, true, t.actor);
    await awaitStandingRuns(g.source._id, 2);
    expect((await g.of(1)).lifecycle).toMatchObject({ consecutiveNotFound: 0 });
    await tick();
    await verify(j._id);
    expect((await g.of(1)).lifecycle).toMatchObject({ state: 'POSSIBLY_STALE', consecutiveNotFound: 1 });
  });

  it('(d) a standing change re-derives the source jobs (time-based decay), once per change', async () => {
    const g = await greenhouse('asof-d');
    await g.listing([1, 2]);
    const j = await g.of(1);
    // Five days pass without a confirmation (the evidence is moved back; its checkpoint dropped).
    await t.market.evidence.col.updateMany({ copyKey: j.sourceRefs[0]!.key }, [
      { $set: { at: { $subtract: ['$at', 5 * DAY] } } },
    ]);
    await t.market.evidence.dropCheckpoint(j._id);
    expect((await g.of(1)).lifecycle.state).toBe('VERIFIED_LIVE'); // nothing recomputed it yet
    await t.market.sources.setEnabled(g.source._id, false, t.actor);
    await awaitStandingRuns(g.source._id, 1);
    expect((await g.of(1)).lifecycle.state).toBe('POSSIBLY_STALE');
    // Idempotent: setting the current value again records and enqueues nothing.
    await t.market.sources.setEnabled(g.source._id, false, t.actor);
    await tick();
    expect(await standingRuns(g.source._id)).toHaveLength(1);
    expect((await t.market.sources.get(g.source._id)).standingHistory?.map((h) => h.enabled)).toEqual([
      true,
      false,
    ]);
  });

  it('a board change after a closure keeps the CLOSED history (a sighting on the new board reopens)', async () => {
    const g = await greenhouse('asof-e');
    await g.listing([1, 2, 3]);
    const closed = await g.close(1);
    await t.market.sources.update(
      g.source._id,
      { endpoint: { boardToken: 'asof-e2', url: `${server.url}${g.path('asof-e2')}?content=true` } },
      t.actor,
    );
    await tick();
    await g.listing([1], 'asof-e2');
    const after = await g.of(1);
    expect(toStates(after)).toEqual([...toStates(closed), 'REOPENED']);
    expect(after.lifecycle.history.slice(0, closed.lifecycle.history.length)).toEqual(
      closed.lifecycle.history,
    );
    // The other copies, seen on the old board, are no evidence about the new board's listing.
    expect((await g.of(2)).lifecycle).toMatchObject({ consecutiveAbsences: 0 });
  });
});

describe('MEDIUM-1: a merge re-derives the survivor', () => {
  it("the reviewer's j1/j2 merge: j1 closed by two 404s, j2 live — the survivor is not CLOSED, and its projection is the derivation", async () => {
    const g = await greenhouse('asof-m');
    await g.listing([2]);
    await tick();
    await g.listing([1, 2]);
    const j1 = await g.of(1);
    const j2 = await g.of(2);
    await g.close(1);
    const { item } = await t.market.reviews.raise({
      type: 'job_duplicate',
      severity: 'low',
      dedupeKey: `job_duplicate:asof:${j1._id}:${j2._id}`,
      entity: { kind: 'job', id: j1._id },
      subject: 'dup',
      reason: 'test',
      candidates: [{ kind: 'job', id: j2._id, label: 'other' }],
      allowedActions: ['merge', 'keep_separate', 'dismiss'],
    });
    await t.market.reviewService.resolve(
      item._id,
      { action: 'merge', reason: 'same', targetId: j2._id },
      t.actor,
    );
    const a = await t.market.jobs.get(j1._id);
    const survivor = a.status === 'active' ? a : await t.market.jobs.get(j2._id);
    expect(survivor.sourceRefs).toHaveLength(2);
    // A not_found about copy 1 never closes the job while copy 2's latest evidence is positive.
    expect(survivor.lifecycle.state).toBe('POSSIBLY_STALE');
    expect((await t.market.evidence.recompute(survivor._id)).written).toBe(false);
  });
});

describe('MEDIUM-3: recompute reads are bounded by the checkpoint', () => {
  it('5,000 listing evidence documents on one job: each recompute reads only the new ones, and equals a full fold', async () => {
    const g = await greenhouse('asof-big');
    await g.listing([1, 2]);
    const j = await g.of(1);
    const copy = j.sourceRefs[0]!;
    const start = Date.now() - 6 * DAY;
    const docs = Array.from({ length: 5000 }, (_, i) => {
      const at = new Date(start + i * 60_000);
      const outcome = i % 3 === 0 ? ('absent' as const) : ('present' as const);
      return {
        _id: listingEvidenceKey(copy.key, at, outcome),
        jobId: j._id,
        copyKey: copy.key,
        sourceId: g.source._id,
        board: copy.board ?? null,
        at,
        kind: 'listing' as const,
        outcome,
        ...(outcome === 'present' ? { contentHash: copy.contentHash } : {}),
      };
    });
    await t.market.evidence.record(docs);
    await t.market.evidence.dropCheckpoint(j._id);
    const full = await t.market.evidence.recompute(j._id, { recorded: { inserted: true } });
    expect(full.read).toBeGreaterThanOrEqual(5000);
    // Each later recompute reads O(new) documents.
    for (let n = 0; n < 3; n++) {
      const at = new Date(Date.now() + n);
      const next = { ...docs[1]!, _id: listingEvidenceKey(copy.key, at, 'present'), at };
      const inserted = await t.market.evidence.record([next]);
      const r = await t.market.evidence.recompute(j._id, {
        recorded: { inserted: inserted > 0 },
      });
      expect(r.read).toBeLessThanOrEqual(2);
      await tick();
    }
    const quiet = await t.market.evidence.recompute(j._id);
    expect(quiet.read).toBe(0);
    // The result equals a full fold of everything.
    const stored = await g.of(1);
    const all = await t.market.evidence.col.find({ copyKey: copy.key }).toArray();
    const sources = await t.market.evidence.sourcesOf([g.source._id]);
    const pure = deriveLifecycle(all, sources, new Date(), {
      copies: stored.sourceRefs,
      firstSeenAt: stored.lifecycle.firstSeenAt,
      lastSeenAt: stored.lifecycle.lastSeenAt,
    });
    expect(stored.lifecycle).toMatchObject({
      state: pure.lifecycle.state,
      consecutiveAbsences: pure.lifecycle.consecutiveAbsences,
      consecutiveNotFound: pure.lifecycle.consecutiveNotFound,
      lastVerifiedAt: pure.lifecycle.lastVerifiedAt,
      history: pure.lifecycle.history,
    });
    // Late evidence (older than the checkpoint's watermark) forces a full fold — detected from the
    // evidence count, whoever recorded it (here nobody tells the recompute about it).
    const late = {
      ...docs[1]!,
      _id: listingEvidenceKey(copy.key, new Date(start + 30), 'absent'),
      at: new Date(start + 30),
      outcome: 'absent' as const,
    };
    expect(await t.market.evidence.record([late])).toBe(1);
    const rebuilt = await t.market.evidence.recompute(j._id);
    expect(rebuilt.read).toBeGreaterThanOrEqual(5000);
  }, 120_000);
});

describe('Low 1: a recorder that inserted evidence always completes a revision-bumping write', () => {
  it('evidence that changes nothing (another board) still bumps the job revision', async () => {
    const g = await greenhouse('asof-l1');
    await g.listing([1, 2]);
    const j = await g.of(1);
    const copy = j.sourceRefs[0]!;
    const at = new Date();
    const other = { endpointUrl: 'https://elsewhere.test/board', boardToken: 'x', apiBase: null };
    const e = {
      _id: listingEvidenceKey(copy.key, at, 'absent'),
      jobId: j._id,
      copyKey: copy.key,
      sourceId: g.source._id,
      board: other,
      at,
      kind: 'listing' as const,
      outcome: 'absent' as const,
    };
    const inserted = await t.market.evidence.record([e]);
    expect(inserted).toBe(1);
    const r = await t.market.evidence.recompute(j._id, { recorded: { inserted: true } });
    expect(r.written).toBe(true);
    const after = await g.of(1);
    expect(after.rev).toBe((j.rev ?? 0) + 1);
    expect(after.lifecycle).toEqual(j.lifecycle); // nothing about the job changed
  });
});

describe('Low 4: reprocessing an uploaded snapshot never changes source health', () => {
  it('the first processing of an upload is its acquisition; a later reprocess changes nothing', async () => {
    const g = await greenhouse('asof-l4');
    const body = JSON.stringify({ jobs: [g.gh(1), g.gh(2)] });
    const { snapshotId } = await t.upload(g.source._id, body, 'application/json');
    expect((await t.runSource(g.source._id, { snapshotId })).state).toBe('COMPLETED');
    expect((await t.market.sources.get(g.source._id)).health).toMatchObject({
      status: 'healthy',
      latestFetch: { ok: true },
    });
    // A real fetch fails, then the upload is reprocessed.
    bodies.delete(g.path('asof-l4'));
    await tick();
    expect((await t.runSource(g.source._id)).state).toBe('FAILED');
    const failed = await t.market.sources.get(g.source._id);
    expect(failed.health.latestFetch).toMatchObject({ ok: false });
    expect((await t.runSource(g.source._id, { snapshotId })).state).toBe('COMPLETED');
    const after = await t.market.sources.get(g.source._id);
    expect(after.health).toMatchObject({
      status: failed.health.status,
      consecutiveFailures: failed.health.consecutiveFailures,
      latestFetch: failed.health.latestFetch,
    });
    expect(after.health.lastSuccessAt?.getTime()).toBe(failed.health.lastSuccessAt?.getTime());
    expect(after.stats).toEqual(failed.stats);
  });
});
