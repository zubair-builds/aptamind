/**
 * B-3: review resolution is generation-safe, crash-safe and recoverable without poisoning the
 * item — against real MongoDB (replica set, transactions), Redis and S3. Races are driven by
 * deterministic barriers (a step pauses until the test releases it); the only wait on time is
 * the lease-renewal test, which waits on a condition of the lease itself.
 *
 * The regressions of the B-3 repair (numbers as in the repair brief):
 *   1  two simultaneous resolvers                    7  invalid / missing merge target, before claim
 *   2  stale owner after takeover                    8  unsupported / invalid correction, before claim
 *   3  stale owner cannot write an old decision      9  create_new identity conflict (before claim,
 *      over a newer one (independent Codex probe)        after claim → released, poisoned recovery)
 *   4  retry-source crash after launch              10  transient apply failure → recovered
 *   5  audit crash                                   11  one failed recovery does not block another
 *   6  workflow-resume crash                         12  generation predicates: effect, close, takeover
 *   plus: a slow but healthy owner keeps its claim (lease renewal).
 *
 * The final two-blocker repair (independent audit of b715f80):
 *   B3-R1  an obsolete retry decision can never launch a source run (Codex scenario 2); a committed
 *          retry cannot be superseded; retry-intent crash matrix (before persist, before dispatch,
 *          during the dispatcher claim, after launch before the delivered marker, repeated and
 *          concurrent delivery, superseded/uncommitted intent cancelled)
 *   B3-R2  a stale company reconciliation can never overwrite newer canonical state (Codex probe);
 *          two reconcilers from one revision (loser recomputes); a review override during a source
 *          reconciliation; reconciliation writes only the fields it derives
 *   plus:  missing / disabled retry source rejected before claim; audit and workflow resume crash
 *          AFTER the effect and before its delivered marker (one event, one resume).
 *
 * Invariant under test throughout: a resolver that no longer owns the current generation
 * cannot change anything — canonical state, the item, or the operation.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Collection } from 'mongodb';
import { AppError, ConflictError } from '@aptamind/contracts';
import { createTestInfra, startFixtureServer, type TestInfra, waitFor, waitForRun } from '@aptamind/testing';
import type { JobDoc } from './jobs/job.schema';
import type { SourceDoc } from './sources/source.schema';
import { createMarketTestRuntime } from './test-harness';
import { REVIEW_CLAIM_STALE_MS, REVIEW_HEARTBEAT_MS } from './review/review.service';
import type { ReviewItemDoc } from './review/schemas';

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let source: SourceDoc;
let directoryId: string;
let acmeId: string;

beforeAll(async () => {
  infra = await createTestInfra('review');
  t = await createMarketTestRuntime(infra);
  server = await startFixtureServer(async (req, res) => {
    if ((req.url ?? '').startsWith('/v1/boards/acme/jobs')) {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(await t.fixture('ats', 'greenhouse', 'acme-listing-t1.json'));
      return;
    }
    res.writeHead(404).end();
  });
  const directory = (
    await t.market.sources.register(
      {
        key: 'directory:review',
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
  directoryId = directory._id;
  const company = await t.market.companyPipeline.process({
    sourceId: directory._id,
    externalId: 'acme',
    payload: {
      name: 'Acme Ltd',
      domain: 'acme.example',
      aliases: [],
      externalIds: [],
      locations: [],
      industries: [],
    },
    parser: { name: 'test', version: '1' },
  });
  if (company.outcome !== 'created' && company.outcome !== 'matched') throw new Error('company not created');
  acmeId = company.companyId;
  source = (
    await t.market.sources.register(
      {
        key: 'greenhouse:acme-review',
        name: 'Acme (greenhouse)',
        category: 'job_source',
        provider: 'greenhouse',
        endpoint: { boardToken: 'acme', url: `${server.url}/v1/boards/acme/jobs` },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId: company.companyId,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      },
      t.actor,
    )
  ).source;
  expect((await t.runSource(source._id)).state).toBe('COMPLETED');
});

// Owners paused by a barrier model a FROZEN resolver (no lease renewal) unless a test opts in.
beforeEach(() => {
  t.market.reviewService.lease.staleMs = REVIEW_CLAIM_STALE_MS;
  t.market.reviewService.lease.heartbeatMs = 60 * 60_000;
});
afterEach(() => {
  t.market.reviewService.lease.staleMs = REVIEW_CLAIM_STALE_MS;
  t.market.reviewService.lease.heartbeatMs = REVIEW_HEARTBEAT_MS;
});

afterAll(async () => {
  await t?.stop();
  await server?.close();
  await infra?.cleanup();
});

const job = async (externalId: string): Promise<JobDoc> =>
  (await t.market.jobs.col.findOne({ sourceKeys: `${source._id}:${externalId}` })) as JobDoc;

describe('B-3: concurrent review resolution', () => {
  const alice = { kind: 'internal-operator' as const, id: 'alice' };
  const bob = { kind: 'internal-operator' as const, id: 'bob' };

  async function duplicateReview(a: string, b: string) {
    const [ja, jb] = [await job(a), await job(b)];
    const { item } = await t.market.reviews.raise({
      type: 'job_duplicate',
      severity: 'low',
      dedupeKey: `job_duplicate:test:${ja._id}:${jb._id}`,
      entity: { kind: 'job', id: ja._id },
      subject: 'possible duplicate',
      reason: 'test',
      candidates: [{ kind: 'job', id: jb._id, label: 'other' }],
      allowedActions: ['merge', 'keep_separate', 'dismiss'],
    });
    return { item, ja, jb };
  }

  /** Count domain-mutation executions (the private `apply` step). */
  function countApplies() {
    const svc = t.market.reviewService as unknown as { apply: (...a: unknown[]) => Promise<unknown> };
    const original = svc.apply.bind(svc);
    const calls: string[] = [];
    svc.apply = async (...args: unknown[]) => {
      calls.push((args[1] as { decision: { action: string } }).decision.action);
      return original(...args);
    };
    return { calls, restore: () => (svc.apply = original) };
  }

  it('two simultaneous resolutions: exactly one claims, mutates and records a resolution', async () => {
    const { item, ja, jb } = await duplicateReview('4012345001', '4012345003');
    const svc = t.market.reviewService;
    // Barrier: both resolvers are inside the claim step before either proceeds.
    const originalClaim = svc.claim.bind(svc);
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    svc.claim = async (...args) => {
      arrived += 1;
      if (arrived === 2) release();
      await gate;
      return originalClaim(...args);
    };
    const applies = countApplies();
    let results: PromiseSettledResult<unknown>[];
    try {
      results = await Promise.allSettled([
        svc.resolve(item._id, { action: 'merge', reason: 'same role', targetId: jb._id }, alice),
        svc.resolve(item._id, { action: 'keep_separate', reason: 'different roles', targetId: jb._id }, bob),
      ]);
    } finally {
      svc.claim = originalClaim;
      applies.restore();
    }
    expect(arrived).toBe(2);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(ConflictError);
    expect(applies.calls).toHaveLength(1); // domain mutation exactly once

    const closed = await t.market.reviews.get(item._id);
    expect(closed.status).toBe('resolved');
    expect(closed.claim).toBeUndefined();
    expect(closed.resolution?.action).toBe(applies.calls[0]);
    const audits = (await t.market.audit.list({ reviewItemId: item._id })).filter((a) =>
      a.action.startsWith('review.'),
    );
    expect(audits).toHaveLength(1);

    const [a, b] = [await t.market.jobs.get(ja._id), await t.market.jobs.get(jb._id)];
    if (closed.resolution?.action === 'merge') {
      // Merged once: the survivor holds both copies once; nothing marked distinct.
      const survivor = a.status === 'active' ? a : b;
      expect(survivor.sourceRefs.filter((r) => r.sourceId === source._id)).toHaveLength(2);
      expect([...a.distinctFrom, ...b.distinctFrom]).toEqual([]);
    } else {
      expect(a.status).toBe('active');
      expect(b.status).toBe('active');
      expect(a.distinctFrom).toContain(b._id);
    }

    // A late resolver cannot mutate after the winner.
    const late = countApplies();
    try {
      await expect(
        svc.resolve(item._id, { action: 'dismiss', reason: 'late decision' }, bob),
      ).rejects.toBeInstanceOf(ConflictError);
    } finally {
      late.restore();
    }
    expect(late.calls).toHaveLength(0);
  });

  /** Make the item's resolution operation look abandoned (owner silent past the stale window). */
  async function ageOperation(itemId: string) {
    await t.market.reviewService.operations.updateOne(
      { _id: itemId },
      { $set: { 'owner.at': new Date(Date.now() - REVIEW_CLAIM_STALE_MS - 60_000) } },
    );
  }
  type Private = Record<string, (...a: unknown[]) => Promise<unknown>>;
  /** Replace a private step of the review service; returns a restore function. */
  function patch(
    name: string,
    impl: (original: (...a: unknown[]) => Promise<unknown>, ...a: unknown[]) => Promise<unknown>,
  ) {
    const svc = t.market.reviewService as unknown as Private;
    const original = svc[name]!.bind(svc);
    svc[name] = (...a: unknown[]) => impl(original, ...a);
    return () => (svc[name] = original);
  }

  it('the winner can resume after an interruption; others stay locked out; the mutation is not duplicated', async () => {
    const { item, ja, jb } = await duplicateReview('4012345002', '4012345004');
    const restore = patch('close', async () => {
      throw new Error('simulated crash after the domain mutation, before closing the item');
    });
    try {
      await expect(
        t.market.reviewService.resolve(
          item._id,
          { action: 'merge', reason: 'same role', targetId: jb._id },
          alice,
          { operationId: 'op-alice' },
        ),
      ).rejects.toThrow('simulated crash');
    } finally {
      restore();
    }
    expect(await t.market.reviews.get(item._id)).toMatchObject({
      status: 'open',
      claim: { operationId: 'op-alice', action: 'merge' },
    });
    expect(await t.market.reviewService.operations.findOne({ _id: item._id })).toMatchObject({
      state: 'applied',
      generation: 1,
    });

    // Someone else cannot take over or apply a different decision.
    const applies = countApplies();
    try {
      await expect(
        t.market.reviewService.resolve(
          item._id,
          { action: 'keep_separate', reason: 'not the same', targetId: jb._id },
          bob,
        ),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(applies.calls).toHaveLength(0);
      // The owner resumes with the same operation id: the stored decision completes, and the
      // already-persisted effect result is not re-applied.
      const done = await t.market.reviewService.resolve(
        item._id,
        { action: 'merge', reason: 'same role', targetId: jb._id },
        alice,
        { operationId: 'op-alice' },
      );
      expect(done).toMatchObject({
        status: 'resolved',
        resolution: { action: 'merge', operationId: 'op-alice' },
      });
      expect(applies.calls).toHaveLength(0);
    } finally {
      applies.restore();
    }
    const [a, b] = [await t.market.jobs.get(ja._id), await t.market.jobs.get(jb._id)];
    const survivor = a.status === 'active' ? a : b;
    expect(survivor.sourceRefs.filter((r) => r.sourceId === source._id)).toHaveLength(2); // not duplicated
    expect(survivor.duplicateOf).toHaveLength(1);
    const events = await t.market.audit.list({ reviewItemId: item._id });
    expect(events.filter((e) => e.action === 'job.merged')).toHaveLength(1);
    expect(events.filter((e) => e.action === 'review.merge')).toHaveLength(1);
  });

  it('a resolution abandoned by a crashed resolver is recovered, completing the stored decision only', async () => {
    const { item, jb } = await duplicateReview('4012345003', '4012345005');
    const svc = t.market.reviewService;
    // A resolver without an idempotency key claims and crashes before mutating anything.
    await svc.claim(
      item._id,
      'op-crashed',
      { action: 'keep_separate', reason: 'crashed', targetId: jb._id },
      alice,
    );
    // While the claim is fresh, nobody else can proceed.
    await expect(
      svc.resolve(item._id, { action: 'merge', reason: 'same role', targetId: jb._id }, bob),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await t.market.reviews.get(item._id)).status).toBe('open');

    // Once stale, a recovery completes the stored decision (keep_separate), not bob's merge.
    await ageOperation(item._id);
    const applies = countApplies();
    try {
      await expect(
        svc.resolve(item._id, { action: 'merge', reason: 'same role', targetId: jb._id }, bob),
      ).rejects.toBeInstanceOf(ConflictError);
    } finally {
      applies.restore();
    }
    expect(applies.calls).toEqual(['keep_separate']);
    const closed = await t.market.reviews.get(item._id);
    expect(closed).toMatchObject({ status: 'resolved', resolution: { action: 'keep_separate' } });
    expect(closed.resolution?.actor).toMatchObject({ id: 'alice' }); // the decision's author
    expect(await svc.operations.findOne({ _id: item._id })).toMatchObject({
      state: 'completed',
      generation: 2,
      recoveredFrom: ['op-crashed'],
    });
  });

  it('many concurrent resolvers without a barrier: one wins', async () => {
    const { item } = await duplicateReview('4012345005', '4012345001');
    const applies = countApplies();
    let results: PromiseSettledResult<unknown>[];
    try {
      results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          t.market.reviewService.resolve(
            item._id,
            { action: 'dismiss', reason: `resolver ${i}` },
            {
              kind: 'internal-operator',
              id: `u${i}`,
            },
          ),
        ),
      );
    } finally {
      applies.restore();
    }
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(applies.calls).toHaveLength(1);
  });
});

// Independent re-audit probes (B-3): a review resolution is a durable operation — one decision,
// one logical set of domain effects, a generation that fences a recovered owner, and an outbox
// for the audit event and the workflow resume.
describe('B-3: review resolution is a crash-idempotent durable operation', () => {
  const alice = { kind: 'internal-operator' as const, id: 'alice' };
  const bob = { kind: 'internal-operator' as const, id: 'bob' };
  const svc = () => t.market.reviewService;
  type Private = Record<string, (...a: unknown[]) => Promise<unknown>>;
  function patch(
    name: string,
    impl: (original: (...a: unknown[]) => Promise<unknown>, ...a: unknown[]) => Promise<unknown>,
  ) {
    const s = svc() as unknown as Private;
    const original = s[name]!.bind(s);
    s[name] = (...a: unknown[]) => impl(original, ...a);
    return () => (s[name] = original);
  }
  async function ageOperation(itemId: string) {
    await svc().operations.updateOne(
      { _id: itemId },
      { $set: { 'owner.at': new Date(Date.now() - REVIEW_CLAIM_STALE_MS - 60_000) } },
    );
  }
  async function sourceRetryReview(tag: string) {
    const { item } = await t.market.reviews.raise({
      type: 'source_anomaly',
      severity: 'low',
      dedupeKey: `source_anomaly:test:${tag}:${Date.now()}`,
      entity: { kind: 'source', id: source._id },
      subject: 'listing looked wrong',
      reason: 'test',
      allowedActions: ['retry', 'dismiss'],
    });
    return item;
  }
  it('the original owner cannot apply or finalize after its claim was recovered (generation fence)', async () => {
    const { item, ja, jb } = await (async () => {
      const [ja, jb] = [await job('4012345004'), await job('4012345005')];
      const { item } = await t.market.reviews.raise({
        type: 'job_duplicate',
        severity: 'low',
        dedupeKey: `job_duplicate:gen:${ja._id}:${jb._id}:${Date.now()}`,
        entity: { kind: 'job', id: ja._id },
        subject: 'possible duplicate',
        reason: 'test',
        candidates: [{ kind: 'job', id: jb._id, label: 'other' }],
        allowedActions: ['merge', 'keep_separate', 'dismiss'],
      });
      return { item, ja, jb };
    })();
    // A (generation 1) stalls inside its domain effects.
    let arrived!: () => void;
    const stalled = new Promise<void>((r) => (arrived = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const restore = patch('apply', async (original, ...a) => {
      if (first) {
        first = false;
        arrived();
        await gate;
      }
      return original(...a);
    });
    try {
      const a = svc().resolve(
        item._id,
        { action: 'keep_separate', reason: 'different', targetId: jb._id },
        alice,
        {
          operationId: 'op-A',
        },
      );
      await stalled;
      // B recovers the silent claim (generation 2) and completes the stored decision.
      await ageOperation(item._id);
      const b = await svc().resolve(
        item._id,
        { action: 'keep_separate', reason: 'different', targetId: jb._id },
        bob,
      );
      expect(b.status).toBe('resolved');
      // A wakes up: it can neither persist its result nor finalize.
      release();
      await expect(a).rejects.toBeInstanceOf(ConflictError);
    } finally {
      restore();
    }
    const op = (await svc().operations.findOne({ _id: item._id }))!;
    expect(op).toMatchObject({ state: 'completed', generation: 2, recoveredFrom: ['op-A'] });
    const events = await t.market.audit.list({ reviewItemId: item._id });
    expect(events.filter((e) => e.action === 'review.keep_separate')).toHaveLength(1);
    expect(events.filter((e) => e.action === 'job.marked_distinct')).toHaveLength(1);
    expect((await t.market.jobs.get(ja._id)).distinctFrom.filter((x) => x === jb._id)).toHaveLength(1);
  });

  it('audit delivery: a crash after the domain mutation and before the audit event records it once', async () => {
    const item = await sourceRetryReview('audit-crash');
    const audit = t.market.audit as unknown as { record: (e: { action: string }) => Promise<unknown> };
    const record = audit.record.bind(audit);
    let crashed = false;
    audit.record = async (e) => {
      if (!crashed && e.action === 'review.dismiss') {
        crashed = true;
        throw new Error('simulated crash before the audit event');
      }
      return record(e as never);
    };
    try {
      await expect(
        svc().resolve(item._id, { action: 'dismiss', reason: 'noise' }, alice, { operationId: 'op-audit' }),
      ).rejects.toThrow('simulated crash');
    } finally {
      audit.record = record;
    }
    // The decision is durable (item closed) and the outbox still owes the audit event.
    expect((await t.market.reviews.get(item._id)).status).toBe('dismissed');
    expect(await svc().operations.findOne({ _id: item._id })).toMatchObject({
      state: 'finalized',
      outbox: { audit: false },
    });
    // Nobody retries: the recovery relay delivers it.
    await ageOperation(item._id);
    expect((await svc().recoverIncomplete()).recovered).toBeGreaterThanOrEqual(1);
    await svc().recoverIncomplete();
    // The caller's own retry is also safe.
    await svc().resolve(item._id, { action: 'dismiss', reason: 'noise' }, alice, { operationId: 'op-audit' });
    const events = await t.market.audit.list({ reviewItemId: item._id });
    expect(events.filter((e) => e.action === 'review.dismiss')).toHaveLength(1);
    expect(await svc().operations.findOne({ _id: item._id })).toMatchObject({
      state: 'completed',
      outbox: { audit: true, resume: true },
    });
  });

  it('workflow resume: a crash after resolving and before resuming the waiting workflow resumes it once', async () => {
    const item = await sourceRetryReview('resume-crash');
    await t.runtime.catalog.register({
      key: 'test.review_wait',
      title: 'waits for a review decision',
      nodes: [
        {
          id: 'start',
          capability: { type: 'core.manual_trigger', version: 1 },
          input: { payload: { $ref: 'run.input' } },
        },
        {
          id: 'wait',
          capability: { type: 'test.suspend', version: 1 },
          input: { key: { $ref: 'nodes.start.output.payload.key' } },
        },
      ],
      edges: [{ from: 'start', to: 'wait' }],
    });
    const run = await t.runtime.engine.startRun({
      workflowKey: 'test.review_wait',
      input: { key: item._id },
      trigger: { kind: 'manual' },
    });
    await waitFor(
      async () =>
        (await t.runtime.engine.nodeRuns.findOne({ runId: run._id, nodeId: 'wait' }))?.state === 'WAITING',
    );

    const restore = patch('onResolved', async () => {
      throw new Error('simulated crash before resuming the workflow');
    });
    try {
      await expect(
        svc().resolve(item._id, { action: 'dismiss', reason: 'noise' }, alice, { operationId: 'op-resume' }),
      ).rejects.toThrow('simulated crash');
    } finally {
      restore();
    }
    expect((await t.runtime.engine.nodeRuns.findOne({ runId: run._id, nodeId: 'wait' }))?.state).toBe(
      'WAITING',
    );
    expect(await svc().operations.findOne({ _id: item._id })).toMatchObject({
      state: 'finalized',
      outbox: { audit: true, resume: false },
    });
    // Recovery delivers the resume; running it again changes nothing.
    await ageOperation(item._id);
    await svc().recoverIncomplete();
    await svc().resolve(item._id, { action: 'dismiss', reason: 'noise' }, alice, {
      operationId: 'op-resume',
    });
    const done = await waitForRun(t.runtime.engine, run._id, undefined, 30_000);
    expect(done.state).toBe('COMPLETED');
    const wait = (await t.runtime.engine.nodeRuns.findOne({ runId: run._id, nodeId: 'wait' }))!;
    expect(wait.resumeCount).toBe(1);
    expect(await svc().operations.findOne({ _id: item._id })).toMatchObject({ state: 'completed' });
  });
});

// --- B-3 final repair: generation fencing of every effect, validation before the claim,
// --- release of deterministically failed decisions, isolated recovery, lease renewal.

const alice = { kind: 'internal-operator' as const, id: 'alice' };
const bob = { kind: 'internal-operator' as const, id: 'bob' };
const carol = { kind: 'internal-operator' as const, id: 'carol' };
const svc = () => t.market.reviewService;
type Private = Record<string, (...a: unknown[]) => Promise<unknown>>;

/** Replace a private step of the review service; returns a restore function. */
function patch(
  name: string,
  impl: (original: (...a: unknown[]) => Promise<unknown>, ...a: unknown[]) => Promise<unknown>,
) {
  const s = svc() as unknown as Private;
  const original = s[name]!.bind(s);
  s[name] = (...a: unknown[]) => impl(original, ...a);
  return () => (s[name] = original);
}

/** A barrier: the first caller of `pause()` stops until `release()`; `arrived` resolves then. */
function barrier() {
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((r) => (arrive = r));
  const gate = new Promise<void>((r) => (release = r));
  let used = false;
  return {
    arrived,
    release,
    /** Pause the first call only; later calls pass through. */
    async pause() {
      if (used) return;
      used = true;
      arrive();
      await gate;
    },
  };
}

/** Pause the first call of a private step at its entry (before anything it would write). */
function pauseFirst(step: string) {
  const b = barrier();
  const restore = patch(step, async (original, ...a) => {
    await b.pause();
    return original(...a);
  });
  return { ...b, restore };
}

/** Make the item's operation look abandoned: its owner stopped renewing the claim. */
async function ageOperation(itemId: string, extraMs = 60_000) {
  await svc().operations.updateOne(
    { _id: itemId },
    { $set: { 'owner.at': new Date(Date.now() - REVIEW_CLAIM_STALE_MS - extraMs) } },
  );
}

/** Count executions of the effect step (`apply`) per decision action. */
function countApplies() {
  const calls: string[] = [];
  const restore = patch('apply', async (original, ...a) => {
    calls.push((a[1] as { decision: { action: string } }).decision.action);
    return original(...a);
  });
  return { calls, restore };
}

let seq = 0;
async function employmentReview(jobId: string, tag: string): Promise<ReviewItemDoc> {
  const { item } = await t.market.reviews.raise({
    type: 'employment_conflict',
    severity: 'medium',
    dedupeKey: `employment_conflict:b3:${tag}:${++seq}:${Date.now()}`,
    entity: { kind: 'job', id: jobId },
    subject: 'work model disagrees',
    reason: 'test',
    allowedActions: ['correct', 'retry', 'dismiss'],
  });
  return item;
}

const workModel = (value: string, reason = `operator says ${value}`) => ({
  action: 'correct' as const,
  reason,
  field: 'workModel',
  value,
});

/** The canonical work model of a job: the stored override and the reconciled fact. */
async function canonicalWorkModel(jobId: string) {
  const j = await t.market.jobs.get(jobId);
  return {
    override: (j.overrides.workModel?.value as string | undefined) ?? null,
    by: j.overrides.workModel?.actorId ?? null,
    workModel: j.geography.workModel.value,
  };
}

async function expectRejectedBeforeClaim(promise: Promise<unknown>, itemId: string, message: RegExp) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe('validation_failed');
  expect((err as AppError).message).toMatch(message);
  // Nothing durable: no operation, the item open and unclaimed.
  expect(await svc().operations.findOne({ _id: itemId })).toBeNull();
  const item = await t.market.reviews.get(itemId);
  expect(item.status).toBe('open');
  expect(item.claim).toBeUndefined();
}

describe('B-3 (3): a stale resolver cannot change canonical state after losing its generation', () => {
  it('Codex probe: A pauses before its canonical write, B recovers, R2 decides newer; A resumes and writes nothing', async () => {
    const j = await job('4012345005');
    const r1 = await employmentReview(j._id, 'probe-r1');
    const a = pauseFirst('apply');
    let aOutcome: Promise<unknown>;
    try {
      // A claims generation 1 with "remote" and pauses immediately before its canonical write.
      aOutcome = svc()
        .resolve(r1._id, workModel('remote'), alice, { operationId: 'op-probe-A' })
        .then(
          () => 'resolved',
          (e: unknown) => e,
        );
      await a.arrived;
      expect(await svc().operations.findOne({ _id: r1._id })).toMatchObject({
        state: 'claimed',
        generation: 1,
      });

      // A is frozen past the stale window; B recovers (generation 2) and completes R1.
      await ageOperation(r1._id);
      const b = await svc().resolve(r1._id, workModel('remote'), bob);
      expect(b).toMatchObject({ status: 'resolved', resolution: { value: 'remote' } });
      expect(await canonicalWorkModel(j._id)).toMatchObject({ override: 'remote', workModel: 'remote' });

      // A newer review R2 applies a newer canonical decision.
      const r2 = await employmentReview(j._id, 'probe-r2');
      await svc().resolve(r2._id, workModel('onsite'), carol);
      expect(await canonicalWorkModel(j._id)).toEqual({
        override: 'onsite',
        by: 'carol',
        workModel: 'onsite',
      });

      // A resumes: its domain write is rejected and it cannot finalize.
      a.release();
      expect(await aOutcome).toBeInstanceOf(ConflictError);
    } finally {
      a.restore();
    }
    // The stale mutation never happened.
    expect(await canonicalWorkModel(j._id)).toEqual({ override: 'onsite', by: 'carol', workModel: 'onsite' });
    expect(await svc().operations.findOne({ _id: r1._id })).toMatchObject({
      state: 'completed',
      generation: 2,
      recoveredFrom: ['op-probe-A'],
    });
    const closed = await t.market.reviews.get(r1._id);
    expect(closed.resolution).toMatchObject({
      action: 'correct',
      value: 'remote',
      operationId: 'op-probe-A',
    });
    const events = await t.market.audit.list({ reviewItemId: r1._id });
    expect(events.filter((e) => e.action === 'review.correct')).toHaveLength(1);
  });
});

describe('B-3 (12): every owner step is fenced on the generation — the stale owner changes nothing', () => {
  // A pauses at the entry of `step`; B takes over (generation 2) WITHOUT advancing the state, so
  // only the generation distinguishes the owners. A resumes: nothing it does may land.
  it.each([
    ['apply', 'claimed'],
    ['close', 'applied'],
  ])('stale owner paused before %s', async (step, stateWhenPaused) => {
    const j = await job('4012345005');
    const before = await canonicalWorkModel(j._id);
    const value = step === 'apply' ? 'hybrid' : 'unclear';
    const r = await employmentReview(j._id, `fence-${step}`);
    const a = pauseFirst(step);
    let aOutcome: Promise<unknown>;
    try {
      aOutcome = svc()
        .resolve(r._id, workModel(value), alice, { operationId: `op-fence-${step}-A` })
        .then(
          () => 'resolved',
          (e: unknown) => e,
        );
      await a.arrived;
      expect(await svc().operations.findOne({ _id: r._id })).toMatchObject({
        state: stateWhenPaused,
        generation: 1,
      });
      await ageOperation(r._id);
      const { generation } = await svc().claim(r._id, `op-fence-${step}-B`, workModel(value), bob);
      expect(generation).toBe(2);
      const opBefore = await svc().operations.findOne({ _id: r._id });
      const canonicalBefore = await canonicalWorkModel(j._id);

      a.release();
      expect(await aOutcome).toBeInstanceOf(ConflictError);

      // Nothing changed: canonical state, the item and the operation are as B left them.
      expect(await canonicalWorkModel(j._id)).toEqual(canonicalBefore);
      if (step === 'apply') expect(canonicalBefore).toEqual(before); // A's write never landed
      const item = await t.market.reviews.get(r._id);
      expect(item.status).toBe('open');
      expect(item.resolution).toBeUndefined();
      const opAfter = await svc().operations.findOne({ _id: r._id });
      expect(opAfter).toMatchObject({ state: stateWhenPaused, generation: 2 });
      expect(opAfter?.owner.operationId).toBe(`op-fence-${step}-B`);
      expect(opAfter?.result).toEqual(opBefore?.result);
    } finally {
      a.restore();
    }
    // B, the owner, completes the stored decision exactly once.
    const done = await svc().resolve(r._id, workModel(value), bob, { operationId: `op-fence-${step}-B` });
    expect(done).toMatchObject({ status: 'resolved', resolution: { value } });
    expect(await canonicalWorkModel(j._id)).toMatchObject({ override: value, workModel: value });
    const events = await t.market.audit.list({ reviewItemId: r._id });
    expect(events.filter((e) => e.action === 'review.correct')).toHaveLength(1);
  });

  it('a takeover decided on an outdated read fails (compare-and-set on the generation read)', async () => {
    const j = await job('4012345005');
    const r = await employmentReview(j._id, 'takeover');
    const before = await canonicalWorkModel(j._id);
    await svc().claim(r._id, 'op-take-A', workModel('remote'), alice); // A crashes
    await ageOperation(r._id);
    // R2 reads generation 1 (stale) and pauses right before its compare-and-set.
    const r2 = pauseFirst('takeOver');
    let r2Outcome: Promise<unknown>;
    try {
      r2Outcome = svc()
        .claim(r._id, 'op-take-R2', workModel('remote'), carol)
        .then(
          (x) => x,
          (e: unknown) => e,
        );
      await r2.arrived;
      // Meanwhile R1 recovers (generation 2) and then itself freezes.
      const r1 = await svc().claim(r._id, 'op-take-R1', workModel('remote'), bob);
      expect(r1.generation).toBe(2);
      await ageOperation(r._id);
      r2.release();
      expect(await r2Outcome).toBeInstanceOf(ConflictError);
    } finally {
      r2.restore();
    }
    const op = await svc().operations.findOne({ _id: r._id });
    expect(op).toMatchObject({ state: 'claimed', generation: 2, recoveredFrom: ['op-take-A'] });
    expect(op?.owner.operationId).toBe('op-take-R1');
    expect(await canonicalWorkModel(j._id)).toEqual(before);
    // R1 resumes and completes the stored decision.
    await svc().resolve(r._id, workModel('remote'), bob, { operationId: 'op-take-R1' });
    expect(await canonicalWorkModel(j._id)).toMatchObject({ override: 'remote', workModel: 'remote' });
  });
});

describe('B-3: a slow but healthy owner keeps its claim (lease renewal)', () => {
  it('an apply longer than the stale window is not recovered while its owner is alive', async () => {
    svc().lease.staleMs = 1_500;
    svc().lease.heartbeatMs = 100;
    const j = await job('4012345005');
    const r = await employmentReview(j._id, 'slow');
    const a = pauseFirst('apply');
    let aOutcome: Promise<unknown>;
    try {
      aOutcome = svc()
        .resolve(r._id, workModel('remote'), alice, { operationId: 'op-slow' })
        .then(
          (x) => x,
          (e: unknown) => e,
        );
      await a.arrived;
      const claimedAt = (await svc().operations.findOne({ _id: r._id }))!.owner.at.getTime();
      // Wait (on the lease itself) until the owner has kept renewing well past two stale windows.
      await waitFor(
        async () =>
          (await svc().operations.findOne({ _id: r._id }))!.owner.at.getTime() > claimedAt + 2 * 1_500,
        { timeoutMs: 20_000, intervalMs: 50, message: 'owner did not renew its lease' },
      );
      // Nobody can take it over: not the sweep, not another resolver.
      await svc().recoverIncomplete();
      await expect(svc().resolve(r._id, workModel('onsite'), bob)).rejects.toBeInstanceOf(ConflictError);
      expect(await svc().operations.findOne({ _id: r._id })).toMatchObject({
        state: 'claimed',
        generation: 1,
      });
      a.release();
      expect(await aOutcome).toMatchObject({ status: 'resolved', resolution: { value: 'remote' } });
    } finally {
      a.restore();
    }
    expect(await svc().operations.findOne({ _id: r._id })).toMatchObject({
      state: 'completed',
      generation: 1,
    });
    expect(await canonicalWorkModel(j._id)).toMatchObject({ override: 'remote', workModel: 'remote' });
  });
});

describe('final check L4: a late claim marker never outlives its owner', () => {
  /**
   * A writes its operation (generation 1) and stalls right before its claim marker. B takes the
   * stale operation over (generation 2) and `after(opB)` models what B does next; then A's late
   * `markClaimed` lands.
   */
  async function lateMarker(tag: string, after: (opB: Record<string, unknown>) => Promise<void>) {
    const j = await job('4012345005');
    const r = await employmentReview(j._id, tag);
    const a = pauseFirst('markClaimed');
    let aOutcome: Promise<unknown>;
    try {
      aOutcome = svc()
        .resolve(r._id, workModel('remote'), alice, { operationId: `op-${tag}-A` })
        .then(
          (x) => x,
          (e: unknown) => e,
        );
      await a.arrived;
      await ageOperation(r._id);
      const taken = await svc().claim(r._id, `op-${tag}-B`, workModel('remote'), bob);
      expect(taken.generation).toBe(2);
      await after(taken.op as unknown as Record<string, unknown>);
      a.release();
      expect(await aOutcome).toBeInstanceOf(ConflictError);
    } finally {
      a.restore();
    }
    return r;
  }

  it('the new owner released: A takes its orphan marker back; the item is decidable and refreshes', async () => {
    const r = await lateMarker('l4rel', async (opB) => {
      await (svc() as unknown as Private).release!(
        opB,
        2,
        new AppError('validation_failed', 'B could not apply the stored decision'),
      );
      expect((await t.market.reviews.get(String(opB._id))).claim).toBeUndefined();
    });
    const item = await t.market.reviews.get(r._id);
    expect(item.status).toBe('open');
    expect(item.claim).toBeUndefined(); // no orphan "resolving" marker
    expect(await svc().operations.findOne({ _id: r._id })).toMatchObject({
      state: 'failed',
      generation: 2,
      owner: { operationId: 'op-l4rel-B' },
    });
    // Refreshes reach it again (a claimed item is never refreshed) and a new decision proceeds.
    const { item: refreshed } = await t.market.reviews.raise({
      type: 'employment_conflict',
      severity: 'medium',
      dedupeKey: item.dedupeKey,
      entity: item.entity,
      subject: 'work model disagrees',
      reason: 'refreshed after the release',
      allowedActions: ['correct', 'retry', 'dismiss'],
      refresh: true,
    });
    expect(refreshed.reason).toBe('refreshed after the release');
    const done = await svc().resolve(r._id, workModel('onsite'), carol);
    expect(done).toMatchObject({ status: 'resolved', resolution: { value: 'onsite' } });
  });

  it('the new owner is still working: the marker is handed back to it, never left as A', async () => {
    const r = await lateMarker('l4act', async () => {});
    const item = await t.market.reviews.get(r._id);
    expect(item.claim?.operationId).toBe('op-l4act-B');
    // Still a recovered claim (M6.2 L5): the handed-back marker keeps who recovered it from whom.
    expect(item.claim).toMatchObject({ recoveredFrom: 'op-l4act-A', recoveredBy: { id: bob.id } });
    const op = await svc().operations.findOne({ _id: r._id });
    expect(op).toMatchObject({ state: 'claimed', generation: 2, owner: { operationId: 'op-l4act-B' } });
    // B completes the stored decision.
    await svc().resolve(r._id, workModel('remote'), bob, { operationId: 'op-l4act-B' });
    expect((await t.market.reviews.get(r._id)).status).toBe('resolved');
  });
});

describe('M6.2 L5: a hand-back racing a release never leaves an orphan marker', () => {
  it("A reads B's active operation, B releases, then A writes B's marker: A takes it back", async () => {
    const j = await job('4012345005');
    const r = await employmentReview(j._id, 'l5race');
    const a = pauseFirst('markClaimed');
    const proto = Collection.prototype as unknown as {
      updateOne: (this: Collection, ...args: unknown[]) => Promise<unknown>;
    };
    const updateOne = proto.updateOne;
    let raced = false;
    let opB: Record<string, unknown> | undefined;
    // Just before A's hand-back write lands, B releases its operation (validation_failed).
    proto.updateOne = async function (this: Collection, ...args: unknown[]) {
      const [filter, update] = args as [Record<string, unknown>, Record<string, Record<string, unknown>>];
      if (
        !raced &&
        this.collectionName === 'market_review_items' &&
        filter['claim.operationId'] === 'op-l5race-A' &&
        update.$set?.claim
      ) {
        raced = true;
        await (svc() as unknown as Private).release!(
          opB,
          2,
          new AppError('validation_failed', 'B could not apply the stored decision'),
        );
      }
      return updateOne.apply(this, args);
    };
    try {
      const aOutcome = svc()
        .resolve(r._id, workModel('remote'), alice, { operationId: 'op-l5race-A' })
        .then(
          (x) => x,
          (e: unknown) => e,
        );
      await a.arrived;
      await ageOperation(r._id);
      const taken = await svc().claim(r._id, 'op-l5race-B', workModel('remote'), bob);
      expect(taken.generation).toBe(2);
      opB = taken.op as unknown as Record<string, unknown>;
      a.release();
      expect(await aOutcome).toBeInstanceOf(ConflictError);
    } finally {
      proto.updateOne = updateOne;
      a.restore();
    }
    expect(raced).toBe(true);
    expect(await svc().operations.findOne({ _id: r._id })).toMatchObject({ state: 'failed', generation: 2 });
    const item = await t.market.reviews.get(r._id);
    expect(item.status).toBe('open');
    expect(item.claim).toBeUndefined(); // no orphan "resolving" marker on the failed operation
    const done = await svc().resolve(r._id, workModel('onsite'), carol);
    expect(done).toMatchObject({ status: 'resolved', resolution: { value: 'onsite' } });
  });

  it("review L-a (ABA): B releases, B′ re-claims under B's operation id before A's clean-up — B′'s marker stays", async () => {
    const j = await job('4012345005');
    const r = await employmentReview(j._id, 'l5aba');
    const a = pauseFirst('markClaimed');
    const proto = Collection.prototype as unknown as {
      updateOne: (this: Collection, ...args: unknown[]) => Promise<unknown>;
    };
    const updateOne = proto.updateOne;
    let raced = false;
    let opB: Record<string, unknown> | undefined;
    proto.updateOne = async function (this: Collection, ...args: unknown[]) {
      const [filter, update] = args as [Record<string, unknown>, Record<string, Record<string, unknown>>];
      if (
        !raced &&
        this.collectionName === 'market_review_items' &&
        filter['claim.operationId'] === 'op-l5aba-A' &&
        update.$set?.claim
      ) {
        raced = true;
        // B releases; A's hand-back lands (B's marker); then B's retry re-claims, same operation id.
        await (svc() as unknown as Private).release!(
          opB,
          2,
          new AppError('validation_failed', 'B could not apply the stored decision'),
        );
        const res = await updateOne.apply(this, args);
        await new Promise((ok) => setTimeout(ok, 5));
        const again = await svc().claim(r._id, 'op-l5aba-B', workModel('remote'), bob);
        expect(again.generation).toBe(3);
        return res;
      }
      return updateOne.apply(this, args);
    };
    try {
      const aOutcome = svc()
        .resolve(r._id, workModel('remote'), alice, { operationId: 'op-l5aba-A' })
        .then(
          (x) => x,
          (e: unknown) => e,
        );
      await a.arrived;
      await ageOperation(r._id);
      const taken = await svc().claim(r._id, 'op-l5aba-B', workModel('remote'), bob);
      expect(taken.generation).toBe(2);
      opB = taken.op as unknown as Record<string, unknown>;
      a.release();
      expect(await aOutcome).toBeInstanceOf(ConflictError);
    } finally {
      proto.updateOne = updateOne;
      a.restore();
    }
    expect(raced).toBe(true);
    const op = (await svc().operations.findOne({ _id: r._id }))!;
    expect(op).toMatchObject({ state: 'claimed', generation: 3, owner: { operationId: 'op-l5aba-B' } });
    const item = await t.market.reviews.get(r._id);
    expect(item.claim).toMatchObject({ operationId: 'op-l5aba-B', at: op.owner.at }); // B′'s live marker
    await svc().resolve(r._id, workModel('remote'), bob, { operationId: 'op-l5aba-B' });
    expect((await t.market.reviews.get(r._id)).status).toBe('resolved');
  });
});

describe('B-3 (7–9): invalid decisions are rejected before the claim; the item never poisons', () => {
  async function jobDuplicate(tag: string, candidates: string[]) {
    const ja = await job('4012345002');
    const { item } = await t.market.reviews.raise({
      type: 'job_duplicate',
      severity: 'low',
      dedupeKey: `job_duplicate:b3:${tag}:${Date.now()}`,
      entity: { kind: 'job', id: ja._id },
      subject: 'possible duplicate',
      reason: 'test',
      candidates: await Promise.all(
        candidates.map(async (c) => ({ kind: 'job' as const, id: (await job(c))._id, label: c })),
      ),
      allowedActions: ['merge', 'keep_separate', 'dismiss'],
    });
    return item;
  }

  it('7a: a merge target that is not a candidate is rejected before claim; a correct decision then succeeds', async () => {
    const item = await jobDuplicate('not-candidate', ['4012345003']);
    const outsider = (await job('4012345005'))._id;
    const applies = countApplies();
    try {
      await expectRejectedBeforeClaim(
        svc().resolve(item._id, { action: 'merge', reason: 'same role', targetId: outsider }, alice),
        item._id,
        /not a candidate/,
      );
      expect(applies.calls).toEqual([]);
      const done = await svc().resolve(
        item._id,
        { action: 'keep_separate', reason: 'different roles', targetId: item.candidates[0]!.id },
        alice,
      );
      expect(done.status).toBe('resolved');
    } finally {
      applies.restore();
    }
  });

  it('7b: a missing merge target (several candidates) is rejected before claim; a correct decision then succeeds', async () => {
    const item = await jobDuplicate('missing-target', ['4012345003', '4012345005']);
    await expectRejectedBeforeClaim(
      svc().resolve(item._id, { action: 'merge', reason: 'same role' }, alice),
      item._id,
      /targetId is required/,
    );
    const done = await svc().resolve(
      item._id,
      { action: 'keep_separate', reason: 'different roles', targetId: item.candidates[1]!.id },
      alice,
    );
    expect(done).toMatchObject({ status: 'resolved', resolution: { targetId: item.candidates[1]!.id } });
  });

  it('8: unsupported corrections (field, value, action) are rejected before claim; a valid one succeeds', async () => {
    const j = await job('4012345005');
    const item = await employmentReview(j._id, 'unsupported');
    const before = await canonicalWorkModel(j._id);
    await expectRejectedBeforeClaim(
      svc().resolve(item._id, { action: 'correct', reason: 'fix', field: 'title', value: 'x' }, alice),
      item._id,
      /cannot be corrected/,
    );
    await expectRejectedBeforeClaim(
      svc().resolve(item._id, workModel('on-the-moon'), alice),
      item._id,
      /Invalid value for workModel/,
    );
    await expectRejectedBeforeClaim(
      svc().resolve(item._id, { action: 'correct', reason: 'fix', field: 'workModel' }, alice),
      item._id,
      /field and value are required/,
    );
    await expectRejectedBeforeClaim(
      svc().resolve(item._id, { action: 'merge', reason: 'fix', targetId: j._id }, alice),
      item._id,
      /not allowed/,
    );
    expect(await canonicalWorkModel(j._id)).toEqual(before);
    const done = await svc().resolve(item._id, workModel('hybrid'), alice);
    expect(done.status).toBe('resolved');
    expect(await canonicalWorkModel(j._id)).toMatchObject({ override: 'hybrid', workModel: 'hybrid' });
  });

  it('8b: company corrections — unsupported field rejected before claim; a valid correction commits under the fence', async () => {
    const { item } = await t.market.reviews.raise({
      type: 'field_conflict',
      severity: 'medium',
      dedupeKey: `field_conflict:b3:company:${Date.now()}`,
      entity: { kind: 'company', id: acmeId },
      subject: 'website disagrees',
      reason: 'test',
      allowedActions: ['correct', 'dismiss'],
    });
    await expectRejectedBeforeClaim(
      svc().resolve(
        item._id,
        { action: 'correct', reason: 'fix', field: 'identity.legalName', value: 'X' },
        alice,
      ),
      item._id,
      /cannot be corrected/,
    );
    const done = await svc().resolve(
      item._id,
      { action: 'correct', reason: 'fix', field: 'identity.website', value: 'https://acme.example/about' },
      alice,
    );
    expect(done.status).toBe('resolved');
    const observationId = done.resolution?.result?.observationId as string;
    expect(await t.market.observations.companyObservations.findOne({ _id: observationId })).toMatchObject({
      resolution: { state: 'resolved', entityId: acmeId, reviewItemId: item._id },
    });
  });

  async function companyResolution(tag: string, candidates: string[]) {
    const name = `Zeta Widgets ${tag} Ltd`;
    const { observation } = await t.market.observations.recordCompanyObservation({
      sourceId: directoryId,
      externalId: `zeta-${tag}-${Date.now()}`,
      payload: { name, aliases: [], externalIds: [], locations: [], industries: [] },
      parser: { name: 'test', version: '1' },
    });
    const { item } = await t.market.reviews.raise({
      type: 'company_resolution',
      severity: 'medium',
      dedupeKey: `company_resolution:b3:${tag}:${Date.now()}`,
      entity: { kind: 'observation', id: observation._id },
      subject: `Resolve company "${name}"`,
      reason: 'test',
      candidates: candidates.map((id) => ({ kind: 'company' as const, id, label: id })),
      observationIds: [observation._id],
      allowedActions: ['merge', 'create_new', 'reject', 'dismiss'],
    });
    return item;
  }
  /** Create another company holding exactly the identity `create_new` would give this item. */
  async function clashingCompany(item: ReviewItemDoc) {
    const plan = (await (svc() as unknown as Private).createNewPlan!(item)) as {
      candidate: { name: string };
      qualifier: string;
      id: string;
    };
    const clash = await t.market.companies.createFromCandidate(plan.candidate, {
      nameQualifier: plan.qualifier,
    });
    return { clash: clash!, plan };
  }

  it('9a: create_new that would clash with an existing identity is rejected before claim; merge then succeeds', async () => {
    const probe = await companyResolution('clash-before', [acmeId]);
    const { clash } = await clashingCompany(probe);
    // Same question, with the clashing company offered as a candidate.
    await t.market.reviews.col.updateOne(
      { _id: probe._id },
      { $push: { candidates: { kind: 'company', id: clash._id, label: 'existing' } } },
    );
    await expectRejectedBeforeClaim(
      svc().resolve(probe._id, { action: 'create_new', reason: 'different company' }, alice),
      probe._id,
      new RegExp(`identity of company ${clash._id}.*merge`),
    );
    const done = await svc().resolve(
      probe._id,
      { action: 'merge', reason: 'it is the existing one', targetId: clash._id },
      alice,
    );
    expect(done).toMatchObject({ status: 'resolved', resolution: { result: { companyId: clash._id } } });
  });

  it('9b: a clash appearing after the claim releases the item (nothing committed); a corrected decision succeeds', async () => {
    const item = await companyResolution('clash-after', [acmeId]);
    let plan: { id: string } | undefined;
    // The clash appears between the claim and the effects (a concurrent import created it).
    const restore = patch('apply', async (original, ...a) => {
      if (!plan) plan = (await clashingCompany(item)).plan;
      return original(...a);
    });
    try {
      const err = await svc()
        .resolve(item._id, { action: 'create_new', reason: 'different company' }, alice, {
          operationId: 'op-clash',
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('invalid_state');
    } finally {
      restore();
    }
    // Released: the operation failed, the item is open, unclaimed and carries the reason.
    expect(await svc().operations.findOne({ _id: item._id })).toMatchObject({
      state: 'failed',
      generation: 1,
      failure: { kind: 'domain_conflict', code: 'invalid_state', generation: 1 },
    });
    const open = await t.market.reviews.get(item._id);
    expect(open.status).toBe('open');
    expect(open.claim).toBeUndefined();
    expect(open.lastFailure).toMatchObject({
      operationId: 'op-clash',
      action: 'create_new',
      kind: 'domain_conflict',
    });
    // Nothing of the failed decision committed (one transaction with the fence).
    expect(await t.market.companies.col.findOne({ _id: plan!.id })).toBeNull();
    expect(
      await t.market.observations.companyObservations.findOne({ _id: item.observationIds[0] }),
    ).toMatchObject({
      resolution: { state: 'pending' },
    });
    // The sweep leaves a released operation alone.
    await ageOperation(item._id);
    await svc().recoverIncomplete();
    expect(await svc().operations.findOne({ _id: item._id })).toMatchObject({
      state: 'failed',
      generation: 1,
    });
    // A corrected decision takes the item as the next generation and completes.
    const done = await svc().resolve(item._id, { action: 'reject', reason: 'not a real company' }, bob);
    expect(done).toMatchObject({ status: 'resolved', resolution: { action: 'reject' } });
    expect(await svc().operations.findOne({ _id: item._id })).toMatchObject({
      state: 'completed',
      generation: 2,
    });
    expect(
      await t.market.observations.companyObservations.findOne({ _id: item.observationIds[0] }),
    ).toMatchObject({
      resolution: { state: 'rejected' },
    });
  });

  it('9c: an invalid decision already persisted (e.g. by an older release) is released by recovery, not retried forever', async () => {
    const item = await companyResolution('poisoned', [acmeId]);
    // Bypass validation, as the pre-fix code did: the bad decision is the stored one.
    await svc().claim(
      item._id,
      'op-poison',
      { action: 'merge', reason: 'bad', targetId: 'cmp_not_a_candidate' },
      alice,
    );
    // While fresh, a corrected decision is refused (someone is resolving) …
    await expect(svc().resolve(item._id, { action: 'reject', reason: 'fix' }, bob)).rejects.toBeInstanceOf(
      ConflictError,
    );
    // … and once stale, the sweep's recovery fails deterministically and releases the item.
    await ageOperation(item._id);
    const sweep = await svc().recoverIncomplete();
    expect(sweep.failed).toBeGreaterThanOrEqual(1);
    const op = await svc().operations.findOne({ _id: item._id });
    expect(op).toMatchObject({ state: 'failed', generation: 2, failure: { kind: 'invalid_decision' } });
    expect(op?.recoveredFrom).toEqual(['op-poison']);
    // Later sweeps do not touch it again (no retry loop, no growing history).
    await ageOperation(item._id);
    await svc().recoverIncomplete();
    expect(await svc().operations.findOne({ _id: item._id })).toMatchObject({
      state: 'failed',
      generation: 2,
    });
    const done = await svc().resolve(item._id, { action: 'reject', reason: 'fix' }, bob);
    expect(done.status).toBe('resolved');
  });
});

describe('B-3 (10, 11): transient failures stay recoverable; the sweep isolates failures', () => {
  it('10: a transient failure keeps the operation claimed; recovery completes the stored decision', async () => {
    const j = await job('4012345005');
    const r = await employmentReview(j._id, 'transient');
    let failures = 0;
    const restore = patch('apply', async (original, ...a) => {
      if (failures++ === 0) throw new Error('simulated transient failure (connection reset)');
      return original(...a);
    });
    try {
      await expect(
        svc().resolve(r._id, workModel('onsite'), alice, { operationId: 'op-transient' }),
      ).rejects.toThrow('connection reset');
      expect(await svc().operations.findOne({ _id: r._id })).toMatchObject({
        state: 'claimed',
        generation: 1,
        lastError: { message: 'simulated transient failure (connection reset)', generation: 1 },
      });
      expect((await t.market.reviews.get(r._id)).claim?.operationId).toBe('op-transient');
      // Not released: another decision is refused while the claim is fresh.
      await expect(svc().resolve(r._id, workModel('remote'), bob)).rejects.toBeInstanceOf(ConflictError);
      await ageOperation(r._id);
      const sweep = await svc().recoverIncomplete();
      expect(sweep).toMatchObject({ recovered: 1, failed: 0 });
    } finally {
      restore();
    }
    expect(await svc().operations.findOne({ _id: r._id })).toMatchObject({
      state: 'completed',
      generation: 2,
    });
    expect(await t.market.reviews.get(r._id)).toMatchObject({
      status: 'resolved',
      resolution: { value: 'onsite', actor: { id: 'alice' } },
    });
    expect(await canonicalWorkModel(j._id)).toMatchObject({ override: 'onsite', workModel: 'onsite' });
  });

  it('11: one operation failing recovery does not block another; its history stays bounded', async () => {
    const j = await job('4012345005');
    const x = await employmentReview(j._id, 'sweep-x');
    const y = await employmentReview(j._id, 'sweep-y');
    await svc().claim(x._id, 'op-x', workModel('hybrid'), alice);
    await svc().claim(y._id, 'op-y', { action: 'dismiss', reason: 'noise' }, alice);
    // X is older, so the sweep reaches it first.
    await ageOperation(x._id, 120_000);
    await ageOperation(y._id, 60_000);
    const restore = patch('apply', async (original, ...a) => {
      if ((a[0] as ReviewItemDoc)._id === x._id)
        throw new Error('simulated persistent infrastructure failure');
      return original(...a);
    });
    try {
      expect(await svc().recoverIncomplete()).toMatchObject({ recovered: 1, failed: 1 });
      expect(await svc().operations.findOne({ _id: y._id })).toMatchObject({ state: 'completed' });
      expect((await t.market.reviews.get(y._id)).status).toBe('dismissed');
      expect(await svc().operations.findOne({ _id: x._id })).toMatchObject({
        state: 'claimed',
        generation: 2,
        lastError: { message: 'simulated persistent infrastructure failure' },
      });
      // Failing again and again: retried once per stale window, history bounded.
      for (let i = 0; i < 25; i++) {
        await ageOperation(x._id);
        expect(await svc().recoverIncomplete()).toMatchObject({ recovered: 0, failed: 1 });
      }
      const op = await svc().operations.findOne({ _id: x._id });
      expect(op?.generation).toBe(27);
      expect(op?.recoveredFrom?.length).toBe(20);
    } finally {
      restore();
    }
    await ageOperation(x._id);
    expect(await svc().recoverIncomplete()).toMatchObject({ recovered: 1, failed: 0 });
    expect(await t.market.reviews.get(x._id)).toMatchObject({
      status: 'resolved',
      resolution: { value: 'hybrid' },
    });
  });
});

// --- Final two-blocker repair: B3-R1 (an obsolete retry decision can never launch a source run)
// --- and B3-R2 (a stale reconciliation can never overwrite newer canonical company state), plus
// --- the exact post-effect crash windows of the outbox and the retry-source validations.

type Fn = (...a: unknown[]) => Promise<unknown>;

/** Replace a method on any object; returns a restore function. */
function patchOn(obj: object, name: string, impl: (original: Fn, ...a: unknown[]) => Promise<unknown>) {
  const o = obj as Record<string, Fn>;
  const original = o[name]!.bind(o);
  o[name] = (...a: unknown[]) => impl(original, ...a);
  return () => (o[name] = original);
}

/** Pause the first call of `obj[name]` at its entry until released. */
function pauseFirstOn(obj: object, name: string) {
  const b = barrier();
  const restore = patchOn(obj, name, async (original, ...a) => {
    await b.pause();
    return original(...a);
  });
  return { ...b, restore };
}

/** Let the first call of `obj[name]` do its work, then fail as if the process died right after. */
function crashAfterFirst(obj: object, name: string, message: string) {
  let crashed = false;
  return patchOn(obj, name, async (original, ...a) => {
    const result = await original(...a);
    if (!crashed) {
      crashed = true;
      throw new Error(message);
    }
    return result;
  });
}

/** Fail the first call of `obj[name]` before it does anything. */
function crashBeforeFirst(obj: object, name: string, message: string) {
  let crashed = false;
  return patchOn(obj, name, async (original, ...a) => {
    if (!crashed) {
      crashed = true;
      throw new Error(message);
    }
    return original(...a);
  });
}

const retry = { action: 'retry' as const, reason: 'transient upstream failure' };
const intents = () => svc().retryIntents;
const intentsOf = (itemId: string) => intents().col.find({ reviewItemId: itemId }).toArray();
const operationOf = (itemId: string) => svc().operations.findOne({ _id: itemId });

async function retryReview(tag: string, sourceId = source._id): Promise<ReviewItemDoc> {
  const { item } = await t.market.reviews.raise({
    type: 'source_anomaly',
    severity: 'low',
    dedupeKey: `source_anomaly:r1:${tag}:${++seq}:${Date.now()}`,
    entity: { kind: 'source', id: sourceId },
    subject: 'listing looked wrong',
    reason: 'test',
    allowedActions: ['retry', 'dismiss'],
  });
  return item;
}

/** Manually triggered runs of the fixture source started since `since` (review retries). */
async function sourceRunIds(since: Date): Promise<string[]> {
  const runs = await t.runtime.engine.runs
    .find({ 'labels.sourceId': source._id, 'trigger.kind': 'manual', createdAt: { $gte: since } })
    .toArray();
  return runs.map((r) => r._id);
}

/** Let launched runs finish so they cannot interfere with later tests. */
async function settleRuns(since: Date) {
  for (const id of await sourceRunIds(since)) await waitForRun(t.runtime.engine, id, undefined, 60_000);
}

/** Make an undelivered intent look abandoned (for the dispatcher sweep). */
async function ageIntent(id: string) {
  await intents().col.updateOne(
    { _id: id },
    { $set: { updatedAt: new Date(Date.now() - intents().timing.staleMs - 60_000) } },
  );
}

describe('B3-R1: an obsolete retry decision can never launch a source run', () => {
  it('Codex scenario 2: A (gen 1, retry) pauses before its effect; B (gen 2) is released; C dismisses (gen 3); A resumes → no run', async () => {
    const since = new Date();
    const item = await retryReview('obsolete');
    // A's only effect is the transaction that commits its retry intent: pause right before it.
    const a = pauseFirstOn(svc(), 'commitEffects');
    let aOutcome: Promise<unknown>;
    let restoreApply = () => {};
    try {
      aOutcome = svc()
        .resolve(item._id, retry, alice, { operationId: 'op-obsolete-A' })
        .then(
          () => 'resolved',
          (e: unknown) => e,
        );
      await a.arrived;
      expect(await operationOf(item._id)).toMatchObject({
        state: 'claimed',
        generation: 1,
        decision: { action: 'retry' },
      });

      // A is frozen past the stale window; B takes generation 2 (recovering the stored D1) —
      // and D1 now fails deterministically for B (the source was disabled after B's claim).
      await ageOperation(item._id);
      let disabled = false;
      restoreApply = patch('apply', async (original, ...args) => {
        if (!disabled) {
          disabled = true;
          await t.market.sources.setEnabled(source._id, false, t.actor);
        }
        return original(...args);
      });
      const bErr = await svc()
        .resolve(item._id, retry, bob, { operationId: 'op-obsolete-B' })
        .then(
          () => null,
          (e: unknown) => e,
        );
      restoreApply();
      expect(bErr).toBeInstanceOf(AppError);
      expect((bErr as AppError).code).toBe('invalid_state');
      expect(await operationOf(item._id)).toMatchObject({
        state: 'failed',
        generation: 2,
        failure: { kind: 'domain_conflict', generation: 2 },
      });
      // The source is healthy again: an obsolete launch attempted now WOULD start a run.
      await t.market.sources.setEnabled(source._id, true, t.actor);

      // C resolves the same item with the newer decision D2 = dismiss (generation 3).
      const c = await svc().resolve(item._id, { action: 'dismiss', reason: 'not needed' }, carol, {
        operationId: 'op-obsolete-C',
      });
      expect(c.status).toBe('dismissed');
      expect(await operationOf(item._id)).toMatchObject({
        state: 'completed',
        generation: 3,
        operationId: 'op-obsolete-C',
        decision: { action: 'dismiss' },
      });

      // A resumes: its fenced effect transaction commits nothing and it cannot finalize.
      a.release();
      expect(await aOutcome).toBeInstanceOf(ConflictError);
    } finally {
      a.restore();
      restoreApply();
      await t.market.sources.setEnabled(source._id, true, t.actor);
    }

    // No obsolete side effect exists — not now, and not after every recovery/dispatcher sweep.
    await ageOperation(item._id);
    for (const i of await intents()
      .col.find({ state: { $in: ['pending', 'dispatching'] } })
      .toArray())
      await ageIntent(i._id);
    await svc().recoverIncomplete();
    expect(await sourceRunIds(since)).toEqual([]);
    expect(await intentsOf(item._id)).toEqual([]);
    const closed = await t.market.reviews.get(item._id);
    expect(closed).toMatchObject({
      status: 'dismissed',
      resolution: { action: 'dismiss', operationId: 'op-obsolete-C', actor: { id: 'carol' } },
    });
    expect(await operationOf(item._id)).toMatchObject({
      state: 'completed',
      generation: 3,
      owner: { operationId: 'op-obsolete-C' },
    });
    const events = await t.market.audit.list({ reviewItemId: item._id });
    expect(events.map((e) => e.action)).toEqual(['review.dismiss']);
  });

  it('once the retry intent committed, the decision has won: a newer decision cannot supersede it; one run', async () => {
    const since = new Date();
    const item = await retryReview('stale-after-intent');
    // A commits its intent (the retry decision has won) and freezes before delivering it.
    const a = pauseFirstOn(svc(), 'derive');
    let aOutcome: Promise<unknown>;
    try {
      aOutcome = svc()
        .resolve(item._id, retry, alice, { operationId: 'op-sai-A' })
        .then(
          () => 'resolved',
          (e: unknown) => e,
        );
      await a.arrived;
      const [intent] = await intentsOf(item._id);
      expect(intent).toMatchObject({ state: 'pending', operationId: 'op-sai-A', generation: 1 });
      expect(await operationOf(item._id)).toMatchObject({ state: 'applied', generation: 1 });
      // C tries a different decision: it recovers the abandoned operation, which completes the
      // STORED (committed) retry — never C's dismiss — and C is told so.
      await ageOperation(item._id);
      const cErr = await svc()
        .resolve(item._id, { action: 'dismiss', reason: 'changed my mind' }, carol)
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(cErr).toBeInstanceOf(ConflictError);
      expect((cErr as ConflictError).message).toMatch(/interrupted decision "retry"/);
      a.release();
      expect(await aOutcome).toBeInstanceOf(ConflictError);
    } finally {
      a.restore();
    }
    const [intent] = await intentsOf(item._id);
    expect(intent).toMatchObject({ state: 'delivered', attempts: 1 });
    expect(await sourceRunIds(since)).toEqual([intent!.runId]);
    expect(await t.market.reviews.get(item._id)).toMatchObject({
      status: 'resolved',
      resolution: { action: 'retry', operationId: 'op-sai-A', result: { runId: intent!.runId } },
    });
    expect(await operationOf(item._id)).toMatchObject({ state: 'completed', generation: 2 });
    await settleRuns(since);
  });
});

describe('B3-R1: retry intent crash matrix — 0 or 1 correct run, never an obsolete or duplicate one', () => {
  it('crash before the intent is persisted: nothing committed; recovery commits one intent and one run', async () => {
    const since = new Date();
    const item = await retryReview('crash-before-intent');
    const restore = crashBeforeFirst(intents(), 'persist', 'simulated crash before persisting the intent');
    try {
      await expect(svc().resolve(item._id, retry, alice, { operationId: 'op-cbi' })).rejects.toThrow(
        'simulated crash',
      );
    } finally {
      restore();
    }
    expect(await operationOf(item._id)).toMatchObject({ state: 'claimed', generation: 1 });
    expect(await intentsOf(item._id)).toEqual([]);
    expect(await sourceRunIds(since)).toEqual([]);

    await ageOperation(item._id);
    expect((await svc().recoverIncomplete()).recovered).toBeGreaterThanOrEqual(1);
    const [intent] = await intentsOf(item._id);
    expect(intent).toMatchObject({ state: 'delivered', operationId: 'op-cbi', generation: 2, attempts: 1 });
    expect(await sourceRunIds(since)).toEqual([intent!.runId]);
    expect(await t.market.reviews.get(item._id)).toMatchObject({
      status: 'resolved',
      resolution: { result: { runId: intent!.runId, retryIntentId: intent!._id } },
    });
    await settleRuns(since);
  });

  it('crash after the intent is persisted, before dispatch: the dispatcher delivers exactly one run', async () => {
    const since = new Date();
    const item = await retryReview('crash-before-dispatch');
    const restore = crashBeforeFirst(intents(), 'dispatch', 'simulated crash before dispatching the intent');
    try {
      await expect(svc().resolve(item._id, retry, alice, { operationId: 'op-cbd' })).rejects.toThrow(
        'simulated crash',
      );
    } finally {
      restore();
    }
    // The decision is durable and owes the dispatch; nothing was launched.
    expect((await t.market.reviews.get(item._id)).status).toBe('resolved');
    expect(await operationOf(item._id)).toMatchObject({ state: 'finalized', outbox: { retry: false } });
    const [pending] = await intentsOf(item._id);
    expect(pending).toMatchObject({ state: 'pending', attempts: 0 });
    expect(await sourceRunIds(since)).toEqual([]);

    // The dispatcher sweep delivers the abandoned intent on its own …
    await ageIntent(pending!._id);
    expect((await intents().dispatchStale()).delivered).toBeGreaterThanOrEqual(1);
    const [delivered] = await intentsOf(item._id);
    expect(delivered).toMatchObject({ state: 'delivered', attempts: 1 });
    // … and the operation's outbox, recovered later, records the same run.
    await ageOperation(item._id);
    await svc().recoverIncomplete();
    expect(await operationOf(item._id)).toMatchObject({
      state: 'completed',
      outbox: { retry: true, audit: true, resume: true },
      result: { runId: delivered!.runId },
    });
    expect(await sourceRunIds(since)).toEqual([delivered!.runId]);
    await settleRuns(since);
  });

  it('crash during the dispatcher claim: the attempt is recorded, nothing launched; recovery launches once', async () => {
    const since = new Date();
    const item = await retryReview('crash-in-claim');
    const restore = crashAfterFirst(intents(), 'claimAttempt', 'simulated crash after recording the attempt');
    try {
      await expect(svc().resolve(item._id, retry, alice, { operationId: 'op-cic' })).rejects.toThrow(
        'simulated crash',
      );
    } finally {
      restore();
    }
    expect((await intentsOf(item._id))[0]).toMatchObject({ state: 'dispatching', attempts: 1 });
    expect(await sourceRunIds(since)).toEqual([]);
    await ageOperation(item._id);
    await svc().recoverIncomplete();
    const [intent] = await intentsOf(item._id);
    expect(intent).toMatchObject({ state: 'delivered', attempts: 2 });
    expect(await sourceRunIds(since)).toEqual([intent!.runId]);
    expect(await operationOf(item._id)).toMatchObject({ state: 'completed' });
    await settleRuns(since);
  });

  it('launch succeeds, crash before the delivered marker: recovery reuses the same logical run', async () => {
    const since = new Date();
    const item = await retryReview('crash-after-launch');
    // The run has started (the launch precedes the marker); the process dies before the marker.
    const restore = crashBeforeFirst(
      intents(),
      'markDelivered',
      'simulated crash after the run started, before recording delivery',
    );
    try {
      await expect(svc().resolve(item._id, retry, alice, { operationId: 'op-cal' })).rejects.toThrow(
        'simulated crash after the run started',
      );
    } finally {
      restore();
    }
    const [first] = await sourceRunIds(since);
    expect(await sourceRunIds(since)).toEqual([first]);
    const [undelivered] = await intentsOf(item._id);
    expect(undelivered).toMatchObject({ state: 'dispatching', attempts: 1 });
    expect(undelivered!.runId).toBeUndefined();
    expect(await operationOf(item._id)).toMatchObject({ state: 'finalized', outbox: { retry: false } });

    await ageOperation(item._id);
    await svc().recoverIncomplete();
    await svc().resolve(item._id, retry, alice, { operationId: 'op-cal' }); // the caller's retry too
    expect(await sourceRunIds(since)).toEqual([first]); // no duplicate logical launch
    const [intent] = await intentsOf(item._id);
    expect(intent).toMatchObject({ state: 'delivered', runId: first, attempts: 2 });
    const run = await t.runtime.engine.getRun(first!);
    expect(run.idempotencyKey).toBe(intent!.idempotencyKey);
    const requested = await t.market.audit.list({ entityKind: 'source', entityId: source._id });
    expect(requested.filter((e) => e.action === 'source.run_requested' && e.runId === first)).toHaveLength(1);
    expect(await t.market.reviews.get(item._id)).toMatchObject({ resolution: { result: { runId: first } } });
    expect(await operationOf(item._id)).toMatchObject({ state: 'completed', result: { runId: first } });
    await settleRuns(since);
  });

  it('repeated and concurrent dispatcher delivery converge on one run', async () => {
    const since = new Date();
    const item = await retryReview('repeated-delivery');
    const restore = crashBeforeFirst(intents(), 'dispatch', 'simulated crash before dispatching the intent');
    try {
      await expect(svc().resolve(item._id, retry, alice, { operationId: 'op-rep' })).rejects.toThrow(
        'simulated crash',
      );
    } finally {
      restore();
    }
    const [pending] = await intentsOf(item._id);
    // Six dispatchers at once, then more, sequentially and via the sweeps.
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => intents().dispatch(pending!._id)));
    const runIds = new Set(outcomes.map((o) => (o.state === 'delivered' ? o.runId : o.state)));
    expect(runIds.size).toBe(1);
    const [runId] = [...runIds];
    for (let i = 0; i < 3; i++)
      expect(await intents().dispatch(pending!._id)).toEqual({ state: 'delivered', runId });
    await ageIntent(pending!._id);
    await ageOperation(item._id);
    await svc().recoverIncomplete();
    await svc().resolve(item._id, retry, alice, { operationId: 'op-rep' });
    expect(await sourceRunIds(since)).toEqual([runId]);
    expect((await intentsOf(item._id))[0]).toMatchObject({ state: 'delivered', runId });
    expect(await operationOf(item._id)).toMatchObject({ state: 'completed', result: { runId } });
    await settleRuns(since);
  });

  it('an intent whose operation is not the decided retry is cancelled and never launches', async () => {
    const since = new Date();
    const now = new Date();
    const stray = async (reviewItemId: string, operationId: string) => {
      const _id = `rri_stray_${reviewItemId}_${operationId}`;
      await intents().col.insertOne({
        _id,
        reviewItemId,
        operationId,
        generation: 1,
        sourceId: source._id,
        actor: { kind: 'internal-operator', id: 'alice' },
        input: {},
        idempotencyKey: `review-retry:${_id}`,
        state: 'pending',
        attempts: 0,
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      return _id;
    };
    // 1) Superseded: the item was decided by a newer, different decision.
    const superseded = await retryReview('superseded-intent');
    await svc().resolve(superseded._id, { action: 'dismiss', reason: 'noise' }, carol);
    const s1 = await stray(superseded._id, 'op-superseded-retry');
    expect(await intents().dispatch(s1)).toMatchObject({ state: 'cancelled', reason: /superseded/ });
    // 2) Not committed: the retry decision is claimed but its effect transaction never committed.
    const uncommitted = await retryReview('uncommitted-intent');
    await svc().claim(uncommitted._id, 'op-uncommitted', retry, alice);
    const s2 = await stray(uncommitted._id, 'op-uncommitted');
    expect(await intents().dispatch(s2)).toMatchObject({ state: 'cancelled', reason: /not committed/ });
    // Terminal: redelivery and the sweep never launch them.
    for (const id of [s1, s2]) {
      expect((await intents().dispatch(id)).state).toBe('cancelled');
      await ageIntent(id);
    }
    await intents().dispatchStale();
    expect(
      await intents()
        .col.find({ _id: { $in: [s1, s2] } })
        .toArray(),
    ).toMatchObject([{ state: 'cancelled' }, { state: 'cancelled' }]);
    expect(await sourceRunIds(since)).toEqual([]);
    // The uncommitted decision itself still completes normally (one run, its own intent).
    await ageOperation(uncommitted._id);
    await svc().recoverIncomplete();
    const own = (await intentsOf(uncommitted._id)).find((i) => i._id !== s2);
    expect(own).toMatchObject({ state: 'delivered' });
    expect(await sourceRunIds(since)).toEqual([own!.runId]);
    await settleRuns(since);
  });
});

describe('B-3: retry-source validation happens before the claim', () => {
  it('a missing retry source is rejected before claim; a corrected decision succeeds', async () => {
    const item = await retryReview('missing-source', 'src_does_not_exist');
    await expectRejectedBeforeClaim(svc().resolve(item._id, retry, alice), item._id, /does not exist/);
    expect(await intentsOf(item._id)).toEqual([]);
    const done = await svc().resolve(item._id, { action: 'dismiss', reason: 'source was removed' }, alice);
    expect(done.status).toBe('dismissed');
  });

  it('a disabled retry source is rejected before claim; once re-enabled the retry launches one run', async () => {
    const since = new Date();
    const item = await retryReview('disabled-source');
    await t.market.sources.setEnabled(source._id, false, t.actor);
    try {
      await expectRejectedBeforeClaim(svc().resolve(item._id, retry, alice), item._id, /is disabled/);
    } finally {
      await t.market.sources.setEnabled(source._id, true, t.actor);
    }
    expect(await intentsOf(item._id)).toEqual([]);
    expect(await sourceRunIds(since)).toEqual([]);
    const done = await svc().resolve(item._id, retry, alice);
    expect(done.status).toBe('resolved');
    expect(await sourceRunIds(since)).toEqual([done.resolution?.result?.runId]);
    await settleRuns(since);
  });
});

describe('B-3: outbox effects that succeeded before the crash are not repeated', () => {
  it('audit: the event is inserted, the process crashes before outbox.audit — recovery keeps one event', async () => {
    const item = await retryReview('audit-exact');
    const restore = crashAfterFirst(t.market.audit, 'record', 'simulated crash after the audit insert');
    try {
      await expect(
        svc().resolve(item._id, { action: 'dismiss', reason: 'noise' }, alice, { operationId: 'op-audit-x' }),
      ).rejects.toThrow('simulated crash after the audit insert');
    } finally {
      restore();
    }
    const dismissed = async () =>
      (await t.market.audit.list({ reviewItemId: item._id })).filter((e) => e.action === 'review.dismiss');
    expect(await dismissed()).toHaveLength(1); // the effect happened …
    expect(await operationOf(item._id)).toMatchObject({ state: 'finalized', outbox: { audit: false } }); // … unmarked
    await ageOperation(item._id);
    await svc().recoverIncomplete();
    await svc().resolve(item._id, { action: 'dismiss', reason: 'noise' }, alice, {
      operationId: 'op-audit-x',
    });
    expect(await dismissed()).toHaveLength(1);
    expect(await operationOf(item._id)).toMatchObject({
      state: 'completed',
      outbox: { audit: true, resume: true },
    });
  });

  it('workflow resume: the workflow is resumed, the process crashes before outbox.resume — resumed once', async () => {
    const item = await retryReview('resume-exact');
    await t.runtime.catalog.register({
      key: 'test.review_wait_exact',
      title: 'waits for a review decision',
      nodes: [
        {
          id: 'start',
          capability: { type: 'core.manual_trigger', version: 1 },
          input: { payload: { $ref: 'run.input' } },
        },
        {
          id: 'wait',
          capability: { type: 'test.suspend', version: 1 },
          input: { key: { $ref: 'nodes.start.output.payload.key' } },
        },
      ],
      edges: [{ from: 'start', to: 'wait' }],
    });
    const run = await t.runtime.engine.startRun({
      workflowKey: 'test.review_wait_exact',
      input: { key: item._id },
      trigger: { kind: 'manual' },
    });
    const waitNode = () => t.runtime.engine.nodeRuns.findOne({ runId: run._id, nodeId: 'wait' });
    await waitFor(async () => (await waitNode())?.state === 'WAITING');
    const restore = crashAfterFirst(svc(), 'onResolved', 'simulated crash after resuming the workflow');
    try {
      await expect(
        svc().resolve(item._id, { action: 'dismiss', reason: 'noise' }, alice, {
          operationId: 'op-resume-x',
        }),
      ).rejects.toThrow('simulated crash after resuming');
    } finally {
      restore();
    }
    expect(await operationOf(item._id)).toMatchObject({
      state: 'finalized',
      outbox: { audit: true, resume: false },
    });
    expect((await waitForRun(t.runtime.engine, run._id, undefined, 30_000)).state).toBe('COMPLETED');
    await ageOperation(item._id);
    await svc().recoverIncomplete();
    await svc().resolve(item._id, { action: 'dismiss', reason: 'noise' }, alice, {
      operationId: 'op-resume-x',
    });
    expect((await waitNode())!.resumeCount).toBe(1);
    expect((await t.runtime.engine.getRun(run._id)).state).toBe('COMPLETED');
    expect(await operationOf(item._id)).toMatchObject({
      state: 'completed',
      outbox: { audit: true, resume: true },
    });
  });
});

// --- B3-R2: company reconciliation is revision-fenced -------------------------------------------

let companySeq = 0;
/** A fresh company (from the directory source) whose website is `website`. */
async function freshCompany(tag: string, website: string): Promise<string> {
  const slug = `${tag}-${++companySeq}-${Date.now()}`;
  const r = await t.market.companyPipeline.process({
    sourceId: directoryId,
    externalId: `recon-${slug}`,
    payload: {
      name: `Recon ${slug} Ltd`,
      domain: `${slug}.example`,
      website,
      aliases: [],
      externalIds: [],
      locations: [],
      industries: [],
    },
    parser: { name: 'test', version: '1' },
  });
  if (r.outcome !== 'created' && r.outcome !== 'matched')
    throw new Error(`company not created: ${r.outcome}`);
  return r.companyId;
}
async function websiteReview(companyId: string, tag: string): Promise<ReviewItemDoc> {
  const { item } = await t.market.reviews.raise({
    type: 'field_conflict',
    severity: 'medium',
    dedupeKey: `field_conflict:r2:${tag}:${++seq}:${Date.now()}`,
    entity: { kind: 'company', id: companyId },
    subject: 'website disagrees',
    reason: 'test',
    allowedActions: ['correct', 'dismiss'],
  });
  return item;
}
const websiteIs = (value: string) => ({
  action: 'correct' as const,
  reason: `the website is ${value}`,
  field: 'identity.website',
  value,
});
const canonicalWebsite = async (companyId: string) =>
  (await t.market.companies.get(companyId)).identity.website.value;
const reconciler = () => t.market.companyReconciler;
const revOf = async (companyId: string) => (await t.market.companies.get(companyId)).rev ?? 0;

/** Count the reconciler's computations (each one a fresh read of the company and its evidence). */
function countComputes() {
  const calls: string[] = [];
  const restore = patchOn(reconciler(), 'compute', async (original, ...a) => {
    calls.push(a[0] as string);
    return original(...a);
  });
  return { calls, restore };
}

describe('B3-R2: a stale reconciliation can never overwrite newer canonical company state', () => {
  it('Codex probe: A computes website=stale and pauses before its write; A loses its generation; R2 writes newer; A resumes → newer stays', async () => {
    const companyId = await freshCompany('stale-probe', 'https://old.example');
    expect(await canonicalWebsite(companyId)).toBe('https://old.example');
    const r1 = await websiteReview(companyId, 'probe-r1');
    // A (generation 1) applies R1 and computes its company snapshot, then pauses right before
    // the final canonical write.
    const a = pauseFirstOn(reconciler(), 'commit');
    let aOutcome: Promise<unknown>;
    try {
      aOutcome = svc()
        .resolve(r1._id, websiteIs('https://stale.example'), alice, { operationId: 'op-recon-A' })
        .then(
          () => 'resolved',
          (e: unknown) => e,
        );
      await a.arrived;
      expect(await operationOf(r1._id)).toMatchObject({ state: 'applied', generation: 1 });

      // A loses its generation: B recovers R1 (generation 2) and completes it.
      await ageOperation(r1._id);
      await svc().resolve(r1._id, websiteIs('https://stale.example'), bob);
      expect(await canonicalWebsite(companyId)).toBe('https://stale.example');

      // A newer review R2 applies a newer correction.
      const r2 = await websiteReview(companyId, 'probe-r2');
      await svc().resolve(r2._id, websiteIs('https://newer.example'), carol);
      expect(await canonicalWebsite(companyId)).toBe('https://newer.example');
      const revBeforeResume = await revOf(companyId);

      // A resumes: its precomputed snapshot is rejected (revision moved); it recomputes from
      // current truth and then cannot finalize R1.
      a.release();
      expect(await aOutcome).toBeInstanceOf(ConflictError);
      expect(await revOf(companyId)).toBeGreaterThan(revBeforeResume);
    } finally {
      a.restore();
    }
    expect(await canonicalWebsite(companyId)).toBe('https://newer.example');
    expect(await operationOf(r1._id)).toMatchObject({
      state: 'completed',
      generation: 2,
      recoveredFrom: ['op-recon-A'],
    });
  });

  it('two reconcilers computed from revision R: one wins; the other detects the mismatch and recomputes', async () => {
    const companyId = await freshCompany('two-reconcilers', 'https://first.example');
    const rev0 = await revOf(companyId);
    const computes = countComputes();
    const x = pauseFirstOn(reconciler(), 'commit');
    try {
      // X computes from revision R and pauses before its write.
      const xOutcome = reconciler().reconcile(companyId);
      await x.arrived;
      // New evidence arrives, and Y — also from revision R — reconciles it and wins.
      const { observation } = await t.market.observations.recordCompanyObservation({
        sourceId: directoryId,
        externalId: `recon-evidence-${companyId}`,
        payload: {
          name: (await t.market.companies.get(companyId)).identity.displayName.value!,
          website: 'https://first.example',
          foundedYear: 1999,
          aliases: [],
          externalIds: [],
          locations: [],
          industries: [],
        },
        parser: { name: 'test', version: '1' },
      });
      await t.market.observations.setCompanyResolution([observation._id], {
        state: 'resolved',
        entityId: companyId,
        method: 'exact',
        confidence: 'high',
        resolverVersion: 'test',
      });
      await reconciler().reconcile(companyId);
      const afterY = await t.market.companies.get(companyId);
      expect(afterY.firmographics.foundedYear.value).toBe(1999);
      expect(afterY.rev).toBeGreaterThan(rev0);
      x.release();
      const xr = await xOutcome;
      // The newer evidence is not reverted by X's stale computation …
      expect((await t.market.companies.get(companyId)).firmographics.foundedYear.value).toBe(1999);
      // … because X's stale plan was discarded and recomputed (it computed twice), not re-submitted.
      expect(computes.calls.filter((c) => c === companyId).length).toBeGreaterThanOrEqual(3);
      expect(xr.company.firmographics.foundedYear.value).toBe(1999);
      expect(xr.company.rev).toBe((afterY.rev ?? 0) + 1);
    } finally {
      x.restore();
      computes.restore();
    }
    expect((await t.market.companies.get(companyId)).firmographics.foundedYear.value).toBe(1999);
  });

  it('a review override arriving while an ordinary source reconciliation runs is not reverted', async () => {
    const companyId = await freshCompany('override-during-source', 'https://source.example');
    // An ordinary (source-triggered) reconciliation computes and pauses before its write.
    const s = pauseFirstOn(reconciler(), 'commit');
    try {
      const sOutcome = reconciler().reconcile(companyId);
      await s.arrived;
      // The operator's correction commits and reconciles.
      const r = await websiteReview(companyId, 'override');
      await svc().resolve(r._id, websiteIs('https://operator.example'), alice);
      expect(await canonicalWebsite(companyId)).toBe('https://operator.example');
      s.release();
      const sr = await sOutcome;
      expect(sr.company.identity.website.value).toBe('https://operator.example');
    } finally {
      s.restore();
    }
    expect(await canonicalWebsite(companyId)).toBe('https://operator.example');
  });

  it('writes only the fields it derives: a concurrent keep_separate (distinctFrom) survives a reconciliation', async () => {
    const companyId = await freshCompany('owned-fields', 'https://owned.example');
    const s = pauseFirstOn(reconciler(), 'commit');
    try {
      const sOutcome = reconciler().reconcile(companyId);
      await s.arrived;
      await t.market.companies.markDistinct(companyId, acmeId, t.actor);
      s.release();
      await sOutcome;
    } finally {
      s.restore();
    }
    expect((await t.market.companies.get(companyId)).identity.distinctFrom).toContain(acmeId);
  });
});
