/**
 * OPS-2: ATS boards refresh cheaply and politely. An unchanged listing (same bytes, or a 304 to
 * the stamped validators) only confirms presence; a changed one runs the full ingest; failures
 * back the source off; three 404s open one review; ATS schedules are spread by source id.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IncomingHttpHeaders } from 'node:http';
import { HttpError } from '@aptamind/net';
import { createTestInfra, startFixtureServer, type TestInfra, waitForRun } from '@aptamind/testing';
import { getAdapter } from './connectors';
import { MARKET } from './market-domain';
import { atsBoardIdentity, registerAtsBoard } from './sources/board-registration';
import { spreadCron } from './sources/schedule-spread';
import type { SourceDoc } from './sources/source.schema';
import { createMarketTestRuntime } from './test-harness';
import { registerJobSource } from './workflow-nodes/companies';

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let companyId: string;
let otherCompanyId: string;

interface BoardResponse {
  status?: number;
  body?: unknown;
  etag?: string;
  retryAfter?: string;
  /** Served once; later requests get `then`. */
  then?: BoardResponse;
}
const boards = new Map<string, BoardResponse>();
const requests: Array<{ path: string; headers: IncomingHttpHeaders }> = [];

const board = (
  token: string,
  from: number,
  to: number,
  opts: { total?: number; edit?: number; upper?: number } = {},
) => {
  const jobs = [];
  for (let id = from; id <= to; id++) {
    const title = `${token} engineer ${id}${opts.edit === id ? ' (senior)' : ''}`;
    jobs.push({
      id,
      title: opts.upper === id ? title.toUpperCase() : title,
      location: { name: 'London, UK' },
      content: `<p>Build ${token} systems, role ${id}.${opts.edit === id ? ' Now senior.' : ''}</p>`,
    });
  }
  return { jobs, meta: { total: opts.total ?? jobs.length } };
};

const pathOf = (token: string) => `/v1/boards/${token}/jobs`;

async function makeCompany(name: string): Promise<string> {
  const directory = (
    await t.market.sources.register(
      {
        key: `directory:ops2:${name}`,
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
    externalId: name,
    payload: { name, aliases: [], externalIds: [], locations: [], industries: [] },
    parser: { name: 'test', version: '1' },
  });
  if (company.outcome !== 'created' && company.outcome !== 'matched') throw new Error('company not created');
  return company.companyId;
}

beforeAll(async () => {
  infra = await createTestInfra('ats_refresh_efficiency');
  t = await createMarketTestRuntime(infra);
  server = await startFixtureServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    requests.push({ path, headers: req.headers });
    const r = boards.get(path);
    if (r?.then) boards.set(path, r.then);
    if (!r || r.status === 404) {
      res.writeHead(404).end();
      return;
    }
    if (r.status && r.status !== 200) {
      res.writeHead(r.status, r.retryAfter ? { 'retry-after': r.retryAfter } : {}).end();
      return;
    }
    if (r.etag && req.headers['if-none-match'] === r.etag) {
      res.writeHead(304, { etag: r.etag }).end();
      return;
    }
    res
      .writeHead(200, { 'content-type': 'application/json', ...(r.etag ? { etag: r.etag } : {}) })
      .end(JSON.stringify(r.body));
  });
  companyId = await makeCompany('Acme Ltd');
  otherCompanyId = await makeCompany('Globex Ltd');
});

afterAll(async () => {
  await t?.stop();
  await server?.close();
  await infra?.cleanup();
});

async function registerBoard(token: string, schedule?: { intervalMinutes: number }): Promise<SourceDoc> {
  return (
    await t.market.sources.register(
      {
        key: `greenhouse:${token}`,
        name: `${token} (greenhouse)`,
        category: 'job_source',
        provider: 'greenhouse',
        endpoint: { boardToken: token, url: `${server.url}${pathOf(token)}` },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId,
        ...(schedule ? { schedule: { ...schedule, timezone: 'UTC' } } : {}),
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      },
      t.actor,
    )
  ).source;
}

interface RefreshResult {
  state: string;
  path: string | null;
  ingested: boolean;
  finalize: { absenceApplied: boolean; absent: number; seen: number } | null;
}

async function outputs(runId: string, state: string): Promise<RefreshResult> {
  const out = async (node: string) =>
    (await t.runtime.engine.stores.nodeRuns.findCompletedOutput(runId, node))?.output as
      Record<string, unknown> | undefined;
  const fetch = await out('fetch');
  return {
    state,
    path: (fetch?.path as string | undefined) ?? null,
    ingested: (((await out('ingest')) as { total?: number } | undefined)?.total ?? 0) > 0,
    finalize: ((await out('finalize')) as RefreshResult['finalize']) ?? null,
  };
}

async function refresh(source: SourceDoc): Promise<RefreshResult> {
  const r = await t.runSource(source._id);
  return outputs(r._id, r.state);
}

async function scheduledRefresh(source: SourceDoc, scheduledFor: Date): Promise<RefreshResult> {
  const run = await t.runtime.engine.startRun({
    workflowKey: 'market.ats.refresh',
    input: { sourceId: source._id },
    labels: { sourceId: source._id },
    trigger: { kind: 'schedule', scheduleId: `sch_test_${source._id}`, scheduledFor },
  });
  const r = await waitForRun(t.runtime.engine, run._id, ['COMPLETED', 'FAILED', 'CANCELLED'], 60_000);
  return outputs(r._id, r.state);
}

const jobsOf = (source: SourceDoc) =>
  t.market.jobs.col.find({ 'sourceRefs.sourceId': source._id }).sort({ _id: 1 }).toArray();
const observationsOf = (source: SourceDoc) =>
  t.market.observations.jobObservations.countDocuments({ sourceId: source._id });
const hitsOf = (token: string) => requests.filter((r) => r.path === pathOf(token));
const titleOf = async (source: SourceDoc, externalId: string) =>
  (await jobsOf(source)).find((j) => j.sourceRefs.some((r) => r.externalId === externalId))!.identity.title
    .value;

/** An ingest of `body`'s item `externalId` by another run whose fetch was at `at`. */
async function ingestFrom(source: SourceDoc, body: unknown, externalId: string, at: Date): Promise<void> {
  const item = getAdapter('greenhouse')
    .parseListing(body, { boardToken: source.endpoint.boardToken! })
    .jobs.find((j) => j.payload.externalId === externalId)!;
  await t.market.jobPipeline.process({
    source: await t.market.sources.get(source._id),
    locator: item.locator,
    payload: item.payload,
    parser: { name: 'greenhouse-adapter', version: '1' },
    runId: 'run_ops2_other',
    at,
  });
}

describe('OPS-2: unchanged-listing short-circuit', () => {
  it('first fetch is full; an identical body confirms presence without ingest', async () => {
    boards.set(pathOf('same'), { body: board('same', 1, 12) });
    const source = await registerBoard('same');

    const first = await refresh(source);
    expect(first).toMatchObject({ state: 'COMPLETED', path: 'full', ingested: true });
    expect(first.finalize?.absenceApplied).toBe(true);
    const before = await jobsOf(source);
    expect(before).toHaveLength(12);
    const observations = await observationsOf(source);
    expect((await t.market.sources.get(source._id)).health.listingStamp).toMatchObject({ listed: 12 });

    const second = await refresh(source);
    expect(second).toMatchObject({ state: 'COMPLETED', path: 'confirm', ingested: false });
    expect(second.finalize).toMatchObject({ absenceApplied: true, absent: 0, seen: 12 });
    const after = await jobsOf(source);
    // Canonical jobs and observations unchanged; presence confirmed and verification moved on.
    expect(after).toHaveLength(12);
    expect(await observationsOf(source)).toBe(observations);
    for (const job of after) {
      const was = before.find((j) => j._id === job._id)!;
      expect(job.lifecycle.state).toBe('VERIFIED_LIVE');
      expect(job.lifecycle.lastVerifiedAt!.getTime()).toBeGreaterThan(
        was.lifecycle.lastVerifiedAt!.getTime(),
      );
      expect(job.sourceRefs[0]!.lastSeenAt.getTime()).toBeGreaterThan(
        was.sourceRefs[0]!.lastSeenAt.getTime(),
      );
    }
    const health = (await t.market.sources.get(source._id)).health;
    expect(health.status).toBe('healthy');
    expect(health.listingStamp?.at.getTime()).toBeGreaterThan(before[0]!.lifecycle.lastVerifiedAt!.getTime());
  });

  it('a 304 to the stamped ETag confirms presence the same way', async () => {
    boards.set(pathOf('etag'), { body: board('etag', 1, 12), etag: '"v1"' });
    const source = await registerBoard('etag');
    expect((await refresh(source)).path).toBe('full');
    expect((await t.market.sources.get(source._id)).health.listingStamp?.etag).toBe('"v1"');
    const before = await jobsOf(source);
    const observations = await observationsOf(source);

    const second = await refresh(source);
    expect(hitsOf('etag').at(-1)?.headers['if-none-match']).toBe('"v1"');
    expect(second).toMatchObject({ state: 'COMPLETED', path: 'confirm', ingested: false });
    const after = await jobsOf(source);
    expect(after).toHaveLength(12);
    expect(await observationsOf(source)).toBe(observations);
    for (const job of after) {
      expect(job.lifecycle.state).toBe('VERIFIED_LIVE');
      expect(job.lifecycle.lastVerifiedAt!.getTime()).toBeGreaterThan(
        before.find((j) => j._id === job._id)!.lifecycle.lastVerifiedAt!.getTime(),
      );
    }
  });

  it('a changed body runs the full path: new, changed and removed jobs', async () => {
    boards.set(pathOf('change'), { body: board('change', 1, 12) });
    const source = await registerBoard('change');
    expect((await refresh(source)).path).toBe('full');

    boards.set(pathOf('change'), { body: board('change', 2, 13, { edit: 5 }) });
    const changed = await refresh(source);
    expect(changed).toMatchObject({ state: 'COMPLETED', path: 'full', ingested: true });
    expect(changed.finalize).toMatchObject({ absenceApplied: true, absent: 1 });
    const jobs = await jobsOf(source);
    const byId = (id: string) => jobs.find((j) => j.sourceRefs.some((r) => r.externalId === id))!;
    expect(jobs).toHaveLength(13);
    expect(byId('13').lifecycle.state).toBe('VERIFIED_LIVE');
    expect(byId('5').lifecycle.state).toBe('CHANGED');
    expect(byId('1').sourceRefs[0]!.present).toBe(false);
  });

  it('a sharp shrink is still held, and a held listing is never short-circuited', async () => {
    boards.set(pathOf('shrink'), { body: board('shrink', 1, 20) });
    const source = await registerBoard('shrink');
    expect((await refresh(source)).path).toBe('full');
    expect((await refresh(source)).path).toBe('confirm');

    boards.set(pathOf('shrink'), { body: board('shrink', 1, 3) });
    for (let i = 0; i < 2; i++) {
      const held = await refresh(source);
      expect(held).toMatchObject({ state: 'COMPLETED', path: 'full', ingested: true });
      expect(held.finalize?.absenceApplied).toBe(false);
      const s = await t.market.sources.get(source._id);
      expect(s.health.listingHeld?.reason).toBe('shrink');
      expect(s.health.listingStamp).toBeUndefined();
    }
    const open = await t.market.reviews.col
      .find({ type: 'source_anomaly', 'entity.id': source._id, status: 'open' })
      .toArray();
    expect(open).toHaveLength(1);
    expect((await jobsOf(source)).filter((j) => j.lifecycle.state === 'CLOSED')).toHaveLength(0);
  });

  it('H1: copies changed since the stamp (a slower run ingested other bytes) force the full path', async () => {
    const served = board('drift', 1, 12);
    boards.set(pathOf('drift'), { body: served });
    const source = await registerBoard('drift');
    expect((await refresh(source)).path).toBe('full');
    const stampedAt = (await t.market.sources.get(source._id)).health.listingStamp!.at;
    // A run that fetched an edited body after the stamp ingests job 5 late.
    await ingestFrom(source, board('drift', 1, 12, { edit: 5 }), '5', new Date(stampedAt.getTime() + 1));
    expect(await titleOf(source, '5')).toBe('drift engineer 5 (senior)');

    const next = await refresh(source);
    expect(next).toMatchObject({ state: 'COMPLETED', path: 'full', ingested: true });
    expect(await titleOf(source, '5')).toBe('drift engineer 5');
  });

  it('H1: a late ingest between the confirm decision and finalize is never stamped as the served body', async () => {
    boards.set(pathOf('race'), { body: board('race', 1, 12) });
    const source = await registerBoard('race');
    expect((await refresh(source)).path).toBe('full');
    const stampedAt = (await t.market.sources.get(source._id)).health.listingStamp!.at;
    const pipeline = t.market.jobPipeline;
    const confirmable = pipeline.presenceConfirmable.bind(pipeline);
    const spy = vi.spyOn(pipeline, 'presenceConfirmable').mockImplementationOnce(async (...args) => {
      const ok = await confirmable(...args);
      // Run X fetched the edited body before this run's fetch; its ingest lands now.
      await ingestFrom(source, board('race', 1, 12, { edit: 5 }), '5', new Date(stampedAt.getTime() + 1));
      return ok;
    });
    try {
      expect((await refresh(source)).path).toBe('confirm');
    } finally {
      spy.mockRestore();
    }
    // The board still serves the first body: the next run must restore job 5 from it.
    const next = await refresh(source);
    expect(next).toMatchObject({ state: 'COMPLETED', path: 'full', ingested: true });
    expect(await titleOf(source, '5')).toBe('race engineer 5');
    expect((await refresh(source)).path).toBe('confirm');
  });

  it('H1: a late ingest the content hash ignores (title case) still drops the stamp', async () => {
    boards.set(pathOf('casec'), { body: board('casec', 1, 12) });
    const source = await registerBoard('casec');
    expect((await refresh(source)).path).toBe('full');
    const stampedAt = (await t.market.sources.get(source._id)).health.listingStamp!.at;
    const pipeline = t.market.jobPipeline;
    const confirmable = pipeline.presenceConfirmable.bind(pipeline);
    const spy = vi.spyOn(pipeline, 'presenceConfirmable').mockImplementationOnce(async (...args) => {
      const ok = await confirmable(...args);
      // Run X fetched job 5 with an upper-cased title; its ingest lands before this run finalizes.
      await ingestFrom(source, board('casec', 1, 12, { upper: 5 }), '5', new Date(stampedAt.getTime() + 1));
      return ok;
    });
    try {
      expect((await refresh(source)).path).toBe('confirm');
    } finally {
      spy.mockRestore();
    }
    expect(await titleOf(source, '5')).toBe('CASEC ENGINEER 5');
    const next = await refresh(source);
    expect(next).toMatchObject({ state: 'COMPLETED', path: 'full', ingested: true });
    expect(await titleOf(source, '5')).toBe('casec engineer 5');

    // With no race, a confirm run ends exactly like a forced full run.
    expect((await refresh(source)).path).toBe('confirm');
    const view = async () =>
      (await jobsOf(source)).map((j) => ({
        title: j.identity.title.value,
        state: j.lifecycle.state,
        refs: j.sourceRefs.map((r) => [r.key, r.present, r.contentHash, r.lastObservationId]),
      }));
    const confirmed = await view();
    await t.market.sources.col.updateOne({ _id: source._id }, { $unset: { 'health.listingStamp': '' } });
    expect((await refresh(source)).path).toBe('full');
    expect(await view()).toEqual(confirmed);
    expect((await refresh(source)).path).toBe('confirm');
  });

  it('a truncated listing (partial parse) always takes the full path', async () => {
    boards.set(pathOf('partial'), { body: board('partial', 1, 12, { total: 15 }) });
    const source = await registerBoard('partial');
    for (let i = 0; i < 2; i++) {
      const r = await refresh(source);
      expect(r).toMatchObject({ state: 'COMPLETED', path: 'full', ingested: true });
      expect(r.finalize?.absenceApplied).toBe(false);
    }
    expect((await t.market.sources.get(source._id)).health.listingStamp).toBeUndefined();
  });
});

describe('OPS-2: source backoff and not-found streak', () => {
  it('three consecutive 404s open exactly one source_anomaly review; the source stays enabled', async () => {
    boards.set(pathOf('gone'), { status: 404 });
    const source = await registerBoard('gone');
    for (let i = 0; i < 4; i++) expect((await refresh(source)).state).toBe('FAILED');
    const reviews = await t.market.reviews.col
      .find({ type: 'source_anomaly', 'entity.id': source._id, dedupeKey: /board_not_found/ })
      .toArray();
    expect(reviews).toHaveLength(1);
    const s = await t.market.sources.get(source._id);
    expect(s.enabled).toBe(true);
    // Only the last three runs of the streak are kept (enough for the rule).
    expect(s.health.notFoundRuns).toHaveLength(3);
    expect(s.health.consecutiveFailures).toBe(4);
    // A non-404 outcome ends the streak.
    boards.set(pathOf('gone'), { body: board('gone', 1, 2) });
    expect((await refresh(source)).state).toBe('COMPLETED');
    const healed = await t.market.sources.get(source._id);
    expect(healed.health.notFoundRuns).toBeUndefined();
    expect(healed.health.backoffUntil).toBeUndefined();
  });

  it('a failed scheduled run defers the next scheduled fires by interval × 2', async () => {
    boards.set(pathOf('flaky'), { status: 404 });
    const source = await registerBoard('flaky', { intervalMinutes: 60 });
    const slot = new Date(Date.now() - 60_000);
    expect((await scheduledRefresh(source, slot)).state).toBe('FAILED');
    const until = (await t.market.sources.get(source._id)).health.backoffUntil!;
    expect(until.getTime()).toBe(slot.getTime() + 2 * 60 * 60_000);

    boards.set(pathOf('flaky'), { body: board('flaky', 1, 2) });
    const hits = hitsOf('flaky').length;
    const deferred = await scheduledRefresh(source, new Date(slot.getTime() + 60 * 60_000));
    expect(deferred).toMatchObject({ state: 'COMPLETED', path: 'deferred', ingested: false, finalize: null });
    expect(hitsOf('flaky')).toHaveLength(hits);
    // A manual run is never deferred, and its success ends the backoff.
    expect((await refresh(source)).path).toBe('full');
    expect((await t.market.sources.get(source._id)).health.backoffUntil).toBeUndefined();
  });
});

describe('OPS-2: a run backs off only when it failed for good (H2)', () => {
  it('a scheduled run retries a short 429 inside the run and is never deferred by itself', async () => {
    boards.set(pathOf('blip'), { status: 429, retryAfter: '5', then: { body: board('blip', 1, 2) } });
    const source = await registerBoard('blip', { intervalMinutes: 60 });
    const r = await scheduledRefresh(source, new Date());
    expect(r).toMatchObject({ state: 'COMPLETED', path: 'full', ingested: true });
    expect(hitsOf('blip')).toHaveLength(2);
    expect((await t.market.sources.get(source._id)).health.backoffUntil).toBeUndefined();
  });

  it('a run whose every attempt fails ends FAILED and only then backs the source off', async () => {
    boards.set(pathOf('down'), { status: 503 });
    const source = await registerBoard('down', { intervalMinutes: 60 });
    const slot = new Date();
    const r = await scheduledRefresh(source, slot);
    expect(r.state).toBe('FAILED');
    expect(hitsOf('down')).toHaveLength(4);
    const health = (await t.market.sources.get(source._id)).health;
    expect(health.consecutiveFailures).toBe(1);
    expect(health.backoffUntil?.getTime()).toBe(slot.getTime() + 2 * 60 * 60_000);
  });

  it('M3: a retry that meets a cooling host after this board failed ends FAILED, not deferred', async () => {
    boards.set(pathOf('retrycool'), { status: 503 });
    const source = await registerBoard('retrycool', { intervalMinutes: 60 });
    const request = t.runtime.http.request.bind(t.runtime.http);
    let calls = 0;
    // Attempt 1 reaches the board (503); by attempt 2 another board's Retry-After cools the host,
    // so the client refuses, as it does for a cool-down longer than the request time-out.
    const spy = vi.spyOn(t.runtime.http, 'request').mockImplementation(async (req) => {
      if (!req.url.includes(pathOf('retrycool')) || ++calls === 1) return request(req);
      throw new HttpError('host is cooling down', true, undefined, { host: 'fixture' }, 3_600_000);
    });
    try {
      const r = await scheduledRefresh(source, new Date());
      expect(r).toMatchObject({ state: 'FAILED', finalize: null });
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBe(2);
    expect(hitsOf('retrycool')).toHaveLength(1);
    const s = await t.market.sources.get(source._id);
    expect(s.health.consecutiveFailures).toBe(1);
    expect(s.health.backoffUntil).toBeUndefined();
  });
});

describe('OPS-2: a listing the adapter cannot read', () => {
  it('fails for good on the first attempt and backs the source off', async () => {
    boards.set(pathOf('garbled'), { body: { unexpected: true } });
    const source = await registerBoard('garbled', { intervalMinutes: 60 });
    const slot = new Date();
    expect((await scheduledRefresh(source, slot)).state).toBe('FAILED');
    expect(hitsOf('garbled')).toHaveLength(1);
    const until = (await t.market.sources.get(source._id)).health.backoffUntil;
    expect(until?.getTime()).toBe(slot.getTime() + 2 * 60 * 60_000);
  });
});

describe('OPS-2: schedule spread', () => {
  it('a new ATS board gets a cron spread by its id; the migration converts old interval schedules and is safe to run twice', async () => {
    const fresh = await registerBoard('spread', { intervalMinutes: 360 });
    expect(fresh.schedule).toMatchObject({ intervalMinutes: 360, cron: spreadCron(fresh._id, 360)! });
    expect(fresh.schedule!.cron).toMatch(/^\d{1,2} [0-5]-23\/6 \* \* \*$/);

    // Two boards registered before OPS-2: interval schedules, no cron, in the scheduler too.
    const legacy: SourceDoc[] = [];
    for (const token of ['legacy-a', 'legacy-b']) {
      const s = await registerBoard(token, { intervalMinutes: 360 });
      await t.market.sources.col.updateOne({ _id: s._id }, { $unset: { 'schedule.cron': '' } });
      await t.market.sources.syncSchedule(await t.market.sources.get(s._id));
      legacy.push(s);
    }
    const scheduleOf = async (s: SourceDoc) =>
      (await t.runtime.scheduler.list()).find((d) => d.owner?.kind === 'source' && d.owner.id === s._id);
    expect((await scheduleOf(legacy[0]!))?.intervalMinutes).toBe(360);

    const startedAt = Date.now();
    expect(await t.market.sources.spreadAtsSchedules()).toBe(2);
    const firstPass = [];
    for (const s of legacy) {
      const cron = spreadCron(s._id, 360)!;
      expect((await t.market.sources.get(s._id)).schedule).toMatchObject({ cron, intervalMinutes: 360 });
      const sch = (await scheduleOf(s))!;
      expect(sch.cron).toBe(cron);
      expect(sch.intervalMinutes).toBeUndefined();
      expect(sch.nextFireAt!.getTime()).toBeGreaterThanOrEqual(startedAt);
      firstPass.push(sch.nextFireAt!.getTime());
    }

    expect(await t.market.sources.spreadAtsSchedules()).toBe(0);
    for (const [i, s] of legacy.entries())
      expect((await scheduleOf(s))!.nextFireAt!.getTime()).toBe(firstPass[i]);
  });

  const legacyBoard = async (token: string) => {
    const s = await registerBoard(token, { intervalMinutes: 360 });
    await t.market.sources.col.updateOne({ _id: s._id }, { $unset: { 'schedule.cron': '' } });
    await t.market.sources.syncSchedule(await t.market.sources.get(s._id));
    return s;
  };
  const schedules = () => infra.db.collection('workflow_schedules');
  const entryOf = (s: SourceDoc) => schedules().findOne({ 'owner.kind': 'source', 'owner.id': s._id });

  it('M4: a fire due when the migration runs moves at most one interval away', async () => {
    const s = await legacyBoard('legacy-due');
    const due = new Date(Date.now() - 10 * 60_000);
    await schedules().updateOne({ 'owner.kind': 'source', 'owner.id': s._id }, { $set: { nextFireAt: due } });
    const startedAt = Date.now();
    expect(await t.market.sources.spreadAtsSchedules()).toBe(1);
    const entry = await entryOf(s);
    expect(entry).toMatchObject({ cron: spreadCron(s._id, 360) });
    const next = (entry!.nextFireAt as Date).getTime();
    expect(next).toBeGreaterThanOrEqual(startedAt);
    expect(next).toBeLessThanOrEqual(Date.now() + 360 * 60_000);
    // Idempotent: a second run changes nothing.
    expect(await t.market.sources.spreadAtsSchedules()).toBe(0);
    expect(((await entryOf(s))!.nextFireAt as Date).getTime()).toBe(next);
  });

  it('the migration never re-enables a source an operator disabled while it ran', async () => {
    const s = await legacyBoard('legacy-off');
    const sources = t.market.sources;
    const sync = sources.syncSchedule.bind(sources);
    const spy = vi.spyOn(sources, 'syncSchedule').mockImplementationOnce(async (doc) => {
      await sources.setEnabled(s._id, false, t.actor);
      return sync(doc);
    });
    try {
      await sources.spreadAtsSchedules();
    } finally {
      spy.mockRestore();
    }
    expect((await sources.get(s._id)).enabled).toBe(false);
    expect(await entryOf(s)).toMatchObject({ enabled: false });
  });
});

describe('OPS-2: discovery registers boards ignoring case', () => {
  const ctx = () => ({
    runId: `run_ops2_${Math.random().toString(36).slice(2)}`,
    clock: { now: () => new Date() },
    signal: new AbortController().signal,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    services: {
      get: (token: unknown) => {
        if (token === MARKET) return t.market;
        throw new Error('unexpected service');
      },
      has: (token: unknown) => token === MARKET,
    },
  });
  const config = { refreshIntervalMinutes: 360, enableSchedule: true };

  it('VvAcross after an import of vvacross reuses the source, and another company gets an owner review', async () => {
    // What the ats_boards import registers for `lever,VvAcross,,<acme domain>`.
    const company = await t.market.companies.resolveActive(companyId);
    const imported = await registerAtsBoard(
      t.market.sources,
      {
        company,
        provider: 'lever',
        boardToken: 'VvAcross',
        identity: { ...atsBoardIdentity('lever', 'VvAcross'), key: 'lever:vvacross' },
        refreshIntervalMinutes: 360,
        enableSchedule: true,
      },
      t.actor,
    );
    const count = () =>
      t.market.sources.col.countDocuments({ provider: 'lever', 'endpoint.boardToken': /vvacross/i });

    const same = await registerJobSource.execute(
      ctx() as never,
      { companyId, provider: 'lever', boardToken: 'VvAcross' } as never,
      config,
    );
    expect(same).toEqual({ sourceId: imported.source._id, key: 'lever:vvacross', created: false });
    expect(await count()).toBe(1);

    const other = await registerJobSource.execute(
      ctx() as never,
      { companyId: otherCompanyId, provider: 'lever', boardToken: 'VVACROSS' } as never,
      config,
    );
    expect(other).toMatchObject({ sourceId: imported.source._id, created: false });
    expect(await count()).toBe(1);
    const owner = await t.market.reviews.col
      .find({ type: 'careers_discovery', dedupeKey: /^careers_discovery:board:lever:vvacross:/ })
      .toArray();
    expect(owner).toHaveLength(1);
    expect((await t.market.sources.get(imported.source._id)).companyId).toBe(companyId);
  });
});

// Last: a long Retry-After cools the fixture host down in this runtime's limiter.
describe('OPS-2: Retry-After', () => {
  it('a 429 with a long Retry-After ends the run and delays the next scheduled fire beyond the computed backoff', async () => {
    boards.set(pathOf('busy'), { status: 429, retryAfter: '7200' });
    const source = await registerBoard('busy', { intervalMinutes: 15 });
    const slot = new Date();
    const r = await scheduledRefresh(source, slot);
    expect(r.state).toBe('FAILED');
    // One request: the run is not retried inside the provider's Retry-After.
    expect(hitsOf('busy')).toHaveLength(1);
    const until = (await t.market.sources.get(source._id)).health.backoffUntil!;
    // Computed backoff 30 min; Retry-After (capped by the client at 1 h) wins.
    expect(until.getTime()).toBeGreaterThan(slot.getTime() + 55 * 60_000);
    const deferred = await scheduledRefresh(source, new Date(slot.getTime() + 45 * 60_000));
    expect(deferred.path).toBe('deferred');
    expect(hitsOf('busy')).toHaveLength(1);
  });

  it('M3: another board on the cooling host is deferred, with no attempt, failure or backoff of its own', async () => {
    boards.set(pathOf('calm'), { body: board('calm', 1, 2) });
    const source = await registerBoard('calm', { intervalMinutes: 60 });
    const r = await scheduledRefresh(source, new Date());
    expect(r).toMatchObject({ state: 'COMPLETED', path: 'deferred', finalize: null });
    expect(hitsOf('calm')).toHaveLength(0);
    const s = await t.market.sources.get(source._id);
    expect(s.health.lastAttemptAt).toBeUndefined();
    expect(s.health.consecutiveFailures).toBe(0);
    expect(s.health.lastError).toBeUndefined();
    expect(s.health.backoffUntil).toBeUndefined();
    expect(s.stats.attempts).toBe(0);
  });
});
