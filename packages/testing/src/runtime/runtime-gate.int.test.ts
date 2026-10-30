/**
 * F1 acceptance gate — reliability properties of the workflow runtime, each proven against
 * real MongoDB, Redis/BullMQ and an S3-compatible store:
 *
 *  1. editing a workflow creates a new immutable version; history stays linked to the old one
 *  2. restart durability: completed nodes are never re-executed after an interruption
 *  3. idempotent retry when a failure happens after the side effect but before acknowledgement
 *  4. bounded fan-out (100 records, concurrency 10) with inspectable lineage and aggregates
 *  5. retry semantics: retryable vs terminal, bounded attempts, backoff, timeout, history
 *  6. large content travels by ArtifactRef (hash/size/mime, integrity, dedupe)
 *  7. BullMQ is transport only: completed state is fully readable, and new work is durably
 *     accepted, while the queue is unavailable
 *  8. lease fencing (audit H-1): a worker that stalls after claiming and is taken over cannot
 *     begin an attempt or run the capability body
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { serializeError } from '@aptamind/contracts';
import type { NodeRunDoc, WorkflowRunDoc } from '@aptamind/workflows';
import {
  type Dispatcher,
  FANOUT_QUEUE,
  nodeQueueName,
  RecordingDispatcher,
  type WorkflowWorkerHost,
} from '@aptamind/workflows';
import { defineCapability, type WorkflowSpec } from '@aptamind/workflow-sdk';
import {
  concurrencyProbe,
  createTestInfra,
  createTestRuntime,
  type TestInfra,
  waitFor,
  waitForRun,
} from '../index';

const trigger = {
  id: 'start',
  capability: { type: 'core.manual_trigger', version: 1 },
  input: { payload: { $ref: 'run.input' } },
};

/** A second version of `test.echo` (capability versions are part of the contract). */
const echoV2 = defineCapability({
  type: 'test.echo',
  version: 2,
  title: 'Echo v2',
  description: 'Returns its input and the capability version.',
  category: 'transform',
  inputSchema: z.object({ value: z.unknown().optional() }),
  outputSchema: z.object({ value: z.unknown().optional(), echoedBy: z.number() }),
  configSchema: z.object({}),
  execution: { retryable: false, idempotency: 'pure', sideEffects: false },
  async execute(_ctx, input) {
    return { value: input.value, echoedBy: 2 };
  },
});

const bigText = defineCapability({
  type: 'test.big_text',
  version: 1,
  title: 'Big text',
  description: 'Produces a large output (forces artifact offload).',
  category: 'transform',
  inputSchema: z.object({ size: z.number().int(), seed: z.string() }),
  outputSchema: z.object({ text: z.string() }),
  configSchema: z.object({}),
  execution: { retryable: false, idempotency: 'pure', sideEffects: false },
  async execute(_ctx, input) {
    return { text: `${input.seed}${'x'.repeat(input.size)}` };
  },
});

const measure = defineCapability({
  type: 'test.measure',
  version: 1,
  title: 'Measure',
  description: 'Length and hash of a text input.',
  category: 'transform',
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ length: z.number(), sha256: z.string() }),
  configSchema: z.object({}),
  execution: { retryable: false, idempotency: 'pure', sideEffects: false },
  async execute(_ctx, input) {
    return { length: input.text.length, sha256: createHash('sha256').update(input.text).digest('hex') };
  },
});

/** Simulates Redis being unreachable: every transport call fails. */
class FailingDispatcher implements Dispatcher {
  calls = 0;
  private fail(): never {
    this.calls += 1;
    throw new Error('connect ECONNREFUSED 127.0.0.1:6379 (simulated Redis outage)');
  }
  async dispatchNode(): Promise<void> {
    this.fail();
  }
  async dispatchChunk(): Promise<void> {
    this.fail();
  }
  async isNodeJobPending(): Promise<boolean> {
    this.fail();
  }
  async isChunkJobPending(): Promise<boolean> {
    this.fail();
  }
}

const extra = [echoV2, bigText, measure];
let infra: TestInfra;
let runtime: ReturnType<typeof createTestRuntime>;
let host: WorkflowWorkerHost | undefined;

function startHost(workerId: string) {
  host = runtime.createWorkerHost({
    workerId,
    schedulerEnabled: false,
    sweeperIntervalMs: 200,
    concurrency: 16,
  });
  host.start();
}
async function stopHost() {
  await host?.stop();
  host = undefined;
}
async function nodeRun(runId: string, nodeId: string): Promise<NodeRunDoc> {
  return (await runtime.engine.nodeRuns.findOne({ runId, nodeId })) as NodeRunDoc;
}
async function executions(key: string): Promise<{ docs: number; executions: number }> {
  const col = infra.db.collection('test_side_effects');
  const docs = await col.countDocuments({ _id: key as never });
  const doc = await col.findOne({ _id: key as never });
  return { docs, executions: (doc?.executions as number | undefined) ?? 0 };
}
async function register(spec: WorkflowSpec) {
  return runtime.catalog.register(spec);
}
/** Process-local "previous worker": same database, but its transport never delivers anything. */
function isolatedProcess() {
  return createTestRuntime(infra, {
    leaseMs: 1_500,
    capabilities: extra,
    dispatcher: new RecordingDispatcher(),
  });
}

beforeAll(async () => {
  infra = await createTestInfra('runtime_gate');
  runtime = createTestRuntime(infra, { leaseMs: 1_500, staleDispatchMs: 300, capabilities: extra });
});

afterAll(async () => {
  await stopHost();
  await runtime?.http.close();
  await infra?.cleanup();
});

beforeEach(async () => {
  await infra.db.collection('test_controls').deleteMany({});
  if (!host) startHost('gate-w1');
});

describe('F1 gate: versioning', () => {
  it('creates a new immutable version on edit and keeps historical runs on the old one', async () => {
    const key = `gate.versioned_${randomBytes(3).toString('hex')}`;
    const specV1: WorkflowSpec = {
      key,
      title: 'versioned',
      nodes: [
        trigger,
        {
          id: 'a',
          capability: { type: 'test.echo', version: 1 },
          input: { value: { $ref: 'run.input.value' } },
        },
      ],
      edges: [{ from: 'start', to: 'a' }],
    };
    const { version: v1, created } = await register(specV1);
    expect(created).toBe(true);
    const versions = infra.db.collection('workflow_versions');
    const v1Stored = await versions.findOne({ _id: v1._id as never });

    const r1 = await runtime.engine.startRun({
      workflowKey: key,
      input: { value: 'one' },
      trigger: { kind: 'manual' },
    });
    expect((await waitForRun(runtime.engine, r1._id)).state).toBe('COMPLETED');

    // Registering the unchanged spec is idempotent.
    expect((await register(specV1)).created).toBe(false);

    // Edit: upgrade the node's capability version.
    const specV2: WorkflowSpec = {
      ...specV1,
      nodes: [
        trigger,
        {
          id: 'a',
          capability: { type: 'test.echo', version: 2 },
          input: { value: { $ref: 'run.input.value' } },
        },
      ],
    };
    const { version: v2, created: created2 } = await register(specV2);
    expect(created2).toBe(true);
    expect(v2.version).toBe(v1.version + 1);
    expect(v2._id).not.toBe(v1._id);
    expect(v2.contentHash).not.toBe(v1.contentHash);
    // The old version document is untouched.
    expect(await versions.findOne({ _id: v1._id as never })).toEqual(v1Stored);
    expect(await versions.countDocuments({ workflowKey: key })).toBe(2);

    // The historical run still points at v1 and recorded the exact capability versions.
    const r1After = await runtime.engine.getRun(r1._id);
    expect(r1After).toMatchObject({ versionId: v1._id, workflowVersion: v1.version });
    expect(r1After.capabilityVersions).toEqual({ start: 'core.manual_trigger@1', a: 'test.echo@1' });
    expect((await nodeRun(r1._id, 'a')).capability).toEqual({ type: 'test.echo', version: 1 });
    expect(r1After.output).toEqual({ value: 'one' });
    const detail = await runtime.queries.getRunDetail(r1._id);
    expect(detail.version.id).toBe(v1._id);
    expect(detail.nodes.find((n) => n.nodeId === 'a')?.capability).toEqual({ type: 'test.echo', version: 1 });

    // New runs use the latest version; each NodeRun records the version it executed.
    const r2 = await runtime.engine.startRun({
      workflowKey: key,
      input: { value: 'two' },
      trigger: { kind: 'manual' },
    });
    const d2 = await waitForRun(runtime.engine, r2._id);
    expect(d2).toMatchObject({
      state: 'COMPLETED',
      versionId: v2._id,
      output: { value: 'two', echoedBy: 2 },
    });
    expect(d2.capabilityVersions.a).toBe('test.echo@2');
    expect((await nodeRun(r2._id, 'a')).capability).toEqual({ type: 'test.echo', version: 2 });

    // A historical version can still be executed exactly as it was defined.
    const r3 = await runtime.engine.startRun({
      workflowKey: key,
      version: v1.version,
      input: { value: 'three' },
      trigger: { kind: 'manual' },
    });
    const d3 = await waitForRun(runtime.engine, r3._id);
    expect(d3).toMatchObject({ state: 'COMPLETED', versionId: v1._id, output: { value: 'three' } });
    expect((await nodeRun(r3._id, 'a')).capability).toEqual({ type: 'test.echo', version: 1 });
  });
});

describe('F1 gate: durability', () => {
  it('resumes A → B → C after an interruption without re-running completed nodes', async () => {
    await register({
      key: 'gate.abc',
      title: 'A → B → C',
      nodes: [
        trigger,
        { id: 'A', capability: { type: 'test.side_effect', version: 1 } },
        { id: 'B', capability: { type: 'test.side_effect', version: 1 } },
        { id: 'C', capability: { type: 'test.side_effect', version: 1 } },
      ],
      edges: [
        { from: 'start', to: 'A' },
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
      ],
    });
    await stopHost();
    // "Process 1" executes start, A and B, then dies while C is running. Its transport
    // never delivered anything to Redis: recovery must come from Mongo alone.
    const proc1 = isolatedProcess();
    const run = await proc1.engine.startRun({ workflowKey: 'gate.abc', trigger: { kind: 'manual' } });
    for (const id of ['start', 'A', 'B']) {
      expect(await proc1.engine.executeNodeRun((await nodeRun(run._id, id))._id, 'proc1')).toBe('COMPLETED');
    }
    const cId = (await nodeRun(run._id, 'C'))._id;
    const claimed = await proc1.engine.stores.nodeRuns.claim(cId, 'proc1');
    expect(claimed?.state).toBe('RUNNING');
    await proc1.engine.stores.nodeRuns.beginAttempt(claimed as NodeRunDoc, 'proc1');
    const before = { A: await nodeRun(run._id, 'A'), B: await nodeRun(run._id, 'B') };
    await proc1.http.close();

    // While the run is still in progress, completed nodes are re-delivered — directly and as
    // duplicate transport jobs — as a recovering system might. They must not execute again.
    expect(await runtime.engine.executeNodeRun(before.A._id, 'proc2')).toBeNull();
    for (const n of [before.A, before.B]) {
      await runtime.dispatcher.dispatchNode({
        nodeRunId: n._id,
        queue: n.queue,
        dispatchSeq: n.dispatchSeq + 100,
      });
    }

    // "Process 2" starts later with a fresh engine and worker.
    startHost('proc2');
    const done = await waitForRun(runtime.engine, run._id, undefined, 20_000);
    expect(done.state).toBe('COMPLETED');

    for (const id of ['A', 'B'] as const) {
      const after = await nodeRun(run._id, id);
      expect(after.attempts.map((a) => [a.workerId, a.status])).toEqual([['proc1', 'completed']]);
      expect(after.finishedAt).toEqual(before[id].finishedAt);
      expect(await executions(`${run._id}:${id}`)).toEqual({ docs: 1, executions: 1 });
    }
    const c = await nodeRun(run._id, 'C');
    expect(c.attempts.map((a) => [a.workerId, a.status])).toEqual([
      ['proc1', 'lost'],
      ['proc2', 'completed'],
    ]);
    expect(await executions(`${run._id}:C`)).toEqual({ docs: 1, executions: 1 });

    // Completed nodes cannot be claimed again, whatever is delivered.
    expect(await runtime.engine.executeNodeRun(before.A._id, 'proc3')).toBeNull();
    expect(await executions(`${run._id}:A`)).toEqual({ docs: 1, executions: 1 });
  });

  const ackSpec: WorkflowSpec = {
    key: 'gate.ack',
    title: 'effect then ack',
    nodes: [
      trigger,
      {
        id: 'effect',
        capability: { type: 'test.side_effect', version: 1 },
        retry: { maxAttempts: 3, backoffMs: 50 },
      },
      {
        id: 'after',
        capability: { type: 'test.echo', version: 1 },
        input: { value: { $ref: 'nodes.effect.output.key' } },
      },
    ],
    edges: [
      { from: 'start', to: 'effect' },
      { from: 'effect', to: 'after' },
    ],
  };

  it('keeps exactly one durable side effect when acknowledging completion fails after the effect', async () => {
    await register(ackSpec);
    const store = runtime.engine.stores.nodeRuns;
    const original = store.finish.bind(store);
    let injected = 0;
    store.finish = async (fence, state, ...rest) => {
      const nr = await store.get(fence.nodeRunId);
      if (
        state === 'COMPLETED' &&
        nr?.workflowKey === 'gate.ack' &&
        nr.nodeId === 'effect' &&
        injected === 0
      ) {
        injected += 1;
        throw new Error('simulated: connection reset while writing completion');
      }
      return original(fence, state, ...rest);
    };
    try {
      const run = await runtime.engine.startRun({ workflowKey: 'gate.ack', trigger: { kind: 'manual' } });
      const done = await waitForRun(runtime.engine, run._id);
      expect(done.state).toBe('COMPLETED');
      expect(injected).toBe(1);
      const nr = await nodeRun(run._id, 'effect');
      expect(nr.attempts.map((a) => a.status)).toEqual(['failed', 'completed']);
      expect(nr.attempts[0]?.error).toMatchObject({ name: 'AcknowledgementError' });
      // The capability ran twice (at-least-once) but its effect exists exactly once.
      expect(await executions(`${run._id}:effect`)).toEqual({ docs: 1, executions: 2 });
      expect(done.output).toEqual({ value: `${run._id}:effect` });
    } finally {
      store.finish = original;
    }
  });

  it('keeps exactly one durable side effect when the worker dies after the effect, before acknowledgement', async () => {
    await register(ackSpec);
    await stopHost();
    const proc1 = isolatedProcess();
    const run = await proc1.engine.startRun({ workflowKey: 'gate.ack', trigger: { kind: 'manual' } });
    await proc1.engine.executeNodeRun((await nodeRun(run._id, 'start'))._id, 'proc1');
    const effect = await nodeRun(run._id, 'effect');
    const claimed = await proc1.engine.stores.nodeRuns.claim(effect._id, 'proc1');
    await proc1.engine.stores.nodeRuns.beginAttempt(claimed as NodeRunDoc, 'proc1');
    // The side effect is committed exactly as the capability does it, then the process dies.
    await infra.db
      .collection('test_side_effects')
      .updateOne(
        { _id: effect.idempotencyKey as never },
        { $setOnInsert: { tag: 'x', createdAt: new Date() }, $inc: { executions: 1 } },
        { upsert: true },
      );
    await proc1.http.close();

    startHost('proc2');
    const done = await waitForRun(runtime.engine, run._id, undefined, 20_000);
    expect(done.state).toBe('COMPLETED');
    const nr = await nodeRun(run._id, 'effect');
    expect(nr.attempts.map((a) => [a.workerId, a.status])).toEqual([
      ['proc1', 'lost'],
      ['proc2', 'completed'],
    ]);
    expect(await executions(effect.idempotencyKey)).toEqual({ docs: 1, executions: 2 });
  });
});

describe('F1 gate: bounded fan-out', () => {
  /** Poll fan-out state while it runs, recording the maximum observed parallelism. */
  function watchFanout(runId: string) {
    const seen = { inFlight: 0, activeChunks: 0 };
    let stop = false;
    const loop = (async () => {
      while (!stop) {
        const each = await runtime.engine.nodeRuns.findOne({ runId, nodeId: 'each' });
        if (each?._id) {
          seen.inFlight = Math.max(seen.inFlight, each.fanout?.inFlight ?? 0);
          const active = await runtime.engine.chunks.countDocuments({
            nodeRunId: each._id,
            state: { $in: ['QUEUED', 'RUNNING'] },
          });
          seen.activeChunks = Math.max(seen.activeChunks, active);
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    })();
    return {
      seen,
      async stop() {
        stop = true;
        await loop;
      },
    };
  }

  it('processes 100 records at concurrency 10 with inspectable per-item lineage and aggregates', async () => {
    concurrencyProbe.active = 0;
    concurrencyProbe.max = 0;
    await register({
      key: 'gate.fanout100',
      title: 'fan-out 100 @ 10',
      nodes: [
        trigger,
        { id: 'records', capability: { type: 'test.emit_items', version: 1 }, input: { count: 100 } },
        {
          id: 'each',
          capability: { type: 'core.for_each', version: 1 },
          config: {
            body: {
              capability: { type: 'test.concurrency_body', version: 1 },
              input: { n: { $ref: 'item.n' } },
            },
            concurrency: 10,
            batchSize: 1,
            collectOutputs: true,
          },
          input: { items: { $ref: 'nodes.records.output.records' } },
        },
      ],
      edges: [
        { from: 'start', to: 'records' },
        { from: 'records', to: 'each' },
      ],
    });
    const run = await runtime.engine.startRun({ workflowKey: 'gate.fanout100', trigger: { kind: 'manual' } });
    const watch = watchFanout(run._id);
    const done = await waitForRun(runtime.engine, run._id, undefined, 60_000);
    await watch.stop();
    expect(done.state).toBe('COMPLETED');

    // No uncontrolled parallelism: at most 10 chunks (= items, batchSize 1) at any time.
    expect(watch.seen.inFlight).toBeLessThanOrEqual(10);
    expect(watch.seen.activeChunks).toBeLessThanOrEqual(10);
    expect(concurrencyProbe.max).toBeLessThanOrEqual(10);
    expect(concurrencyProbe.max).toBeGreaterThan(1);

    // Aggregate state.
    const each = await nodeRun(run._id, 'each');
    expect(each.state).toBe('COMPLETED');
    expect(each.fanout).toMatchObject({
      totalItems: 100,
      totalChunks: 100,
      completedChunks: 100,
      succeededItems: 100,
      failedItems: 0,
      inFlight: 0,
      concurrency: 10,
    });
    const output = done.output as { total: number; succeeded: number; outputs: Array<{ doubled: number }> };
    expect(output).toMatchObject({ total: 100, succeeded: 100, failed: 0 });
    expect(output.outputs.map((o) => o.doubled)).toEqual(Array.from({ length: 100 }, (_, i) => (i + 1) * 2));

    // Exactly one effect per item, keyed by the per-item idempotency key.
    const items = await infra.db
      .collection('test_items')
      .find({ _id: { $regex: `^${run._id}:each:` } as never })
      .toArray();
    expect(items).toHaveLength(100);
    expect(items.every((i) => i.n === 1)).toBe(true);

    // Lineage: run → node run → chunk → item, inspectable through the read model.
    const detail = await runtime.queries.getRunDetail(run._id);
    expect(detail.nodes.find((n) => n.nodeId === 'each')?.chunkStates).toEqual({ COMPLETED: 100 });
    const chunks = await runtime.queries.listChunks(each._id, 200);
    expect(chunks.total).toBe(100);
    const indexes = chunks.items.flatMap((c) => {
      expect(c).toMatchObject({ runId: run._id, nodeRunId: each._id, state: 'COMPLETED' });
      return c.results.map((r) => r.index);
    });
    expect(indexes.sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it('links one child run per item to its parent node and item index (workflow body)', async () => {
    await register({
      key: 'gate.child',
      title: 'child',
      nodes: [
        trigger,
        {
          id: 'echo',
          capability: { type: 'test.echo', version: 1 },
          input: { value: { $ref: 'run.input.n' } },
        },
      ],
      edges: [{ from: 'start', to: 'echo' }],
    });
    await register({
      key: 'gate.fanout_children',
      title: 'fan-out children',
      nodes: [
        trigger,
        { id: 'records', capability: { type: 'test.emit_items', version: 1 }, input: { count: 100 } },
        {
          id: 'each',
          capability: { type: 'core.for_each', version: 1 },
          config: {
            body: { workflow: { key: 'gate.child' }, input: { n: { $ref: 'item.n' } } },
            concurrency: 10,
            batchSize: 5,
          },
          input: { items: { $ref: 'nodes.records.output.records' } },
        },
      ],
      edges: [
        { from: 'start', to: 'records' },
        { from: 'records', to: 'each' },
      ],
    });
    const run = await runtime.engine.startRun({
      workflowKey: 'gate.fanout_children',
      trigger: { kind: 'manual' },
    });
    const watch = watchFanout(run._id);
    const done = await waitForRun(runtime.engine, run._id, undefined, 90_000);
    await watch.stop();
    expect(done.state).toBe('COMPLETED');
    expect(watch.seen.inFlight).toBeLessThanOrEqual(10);
    expect(watch.seen.activeChunks).toBeLessThanOrEqual(10);

    const each = await nodeRun(run._id, 'each');
    const children = (await runtime.engine.runs
      .find({ 'parent.runId': run._id })
      .toArray()) as WorkflowRunDoc[];
    expect(children).toHaveLength(100);
    for (const c of children) {
      expect(c).toMatchObject({
        state: 'COMPLETED',
        workflowKey: 'gate.child',
        rootRunId: run._id,
        depth: 1,
        parent: { runId: run._id, nodeRunId: each._id },
        output: { value: (c.parent?.itemIndex ?? -1) + 1 },
      });
    }
    expect(children.map((c) => c.parent?.itemIndex).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
      Array.from({ length: 100 }, (_, i) => i),
    );
    const detail = await runtime.queries.getRunDetail(run._id);
    expect(detail.children).toEqual({ COMPLETED: 100 });
    const chunks = await runtime.queries.listChunks(each._id, 50);
    const childIds = new Set(children.map((c) => c._id));
    expect(
      chunks.items.flatMap((c) => c.results).every((r) => r.childRunId && childIds.has(r.childRunId)),
    ).toBe(true);
  });
});

describe('F1 gate: retry semantics', () => {
  it('retries retryable failures with exponential backoff and keeps every attempt', async () => {
    await register({
      key: 'gate.retry_ok',
      title: 'retry then succeed',
      nodes: [
        trigger,
        {
          id: 'effect',
          capability: { type: 'test.side_effect', version: 1 },
          config: { failFirstAttempts: 2 },
          retry: { maxAttempts: 3, backoffMs: 300, maxBackoffMs: 5_000 },
        },
      ],
      edges: [{ from: 'start', to: 'effect' }],
    });
    const run = await runtime.engine.startRun({ workflowKey: 'gate.retry_ok', trigger: { kind: 'manual' } });
    expect((await waitForRun(runtime.engine, run._id)).state).toBe('COMPLETED');
    const nr = await nodeRun(run._id, 'effect');
    expect(nr.attempts.map((a) => a.status)).toEqual(['failed', 'failed', 'completed']);
    expect(nr.attempts[0]?.error?.message).toBe('transient failure on attempt 1');
    expect(nr.attempts.every((a) => typeof a.durationMs === 'number')).toBe(true);
    const gap = (i: number) =>
      (nr.attempts[i]?.startedAt.getTime() ?? 0) - (nr.attempts[i - 1]?.finishedAt?.getTime() ?? 0);
    expect(gap(1)).toBeGreaterThanOrEqual(290); // 300 ms
    expect(gap(2)).toBeGreaterThanOrEqual(590); // 600 ms
    expect(nr.nextAttemptAt).toBeUndefined();
    expect(await executions(`${run._id}:effect`)).toEqual({ docs: 1, executions: 3 });
  });

  it('stops after the bounded number of attempts and never retries again', async () => {
    await register({
      key: 'gate.retry_exhausted',
      title: 'always failing',
      nodes: [
        trigger,
        {
          id: 'effect',
          capability: { type: 'test.side_effect', version: 1 },
          config: { failFirstAttempts: 1_000 },
          retry: { maxAttempts: 3, backoffMs: 50 },
        },
      ],
      edges: [{ from: 'start', to: 'effect' }],
    });
    const run = await runtime.engine.startRun({
      workflowKey: 'gate.retry_exhausted',
      trigger: { kind: 'manual' },
    });
    const done = await waitForRun(runtime.engine, run._id);
    expect(done).toMatchObject({ state: 'FAILED', failedNodeIds: ['effect'] });
    expect(done.error?.message).toBe('transient failure on attempt 3');
    // Give the sweeper time to (wrongly) resurrect it.
    await new Promise((r) => setTimeout(r, 1_000));
    const nr = await nodeRun(run._id, 'effect');
    expect(nr.state).toBe('FAILED');
    expect(nr.attempts.map((a) => a.status)).toEqual(['failed', 'failed', 'failed']);
    expect(nr.attempt).toBe(3);
    expect(await executions(`${run._id}:effect`)).toEqual({ docs: 1, executions: 3 });
  });

  it('does not retry terminal errors', async () => {
    await infra.db.collection('test_controls').insertOne({ _id: 'fail' as never, enabled: true });
    await register({
      key: 'gate.terminal',
      title: 'terminal',
      nodes: [
        trigger,
        { id: 'check', capability: { type: 'test.fail_if', version: 1 }, retry: { maxAttempts: 5 } },
      ],
      edges: [{ from: 'start', to: 'check' }],
    });
    const run = await runtime.engine.startRun({ workflowKey: 'gate.terminal', trigger: { kind: 'manual' } });
    expect((await waitForRun(runtime.engine, run._id)).state).toBe('FAILED');
    const nr = await nodeRun(run._id, 'check');
    expect(nr.attempts).toHaveLength(1);
    expect(nr.error).toMatchObject({ name: 'TerminalError', retryable: false });
  });

  it('times out each attempt, retries within budget, then fails with the timeout recorded', async () => {
    await register({
      key: 'gate.timeout',
      title: 'timeout',
      nodes: [
        trigger,
        {
          id: 'slow',
          capability: { type: 'test.sleep', version: 1 },
          config: { ms: 5_000 },
          timeoutMs: 150,
          retry: { maxAttempts: 2, backoffMs: 50 },
        },
      ],
      edges: [{ from: 'start', to: 'slow' }],
    });
    const run = await runtime.engine.startRun({ workflowKey: 'gate.timeout', trigger: { kind: 'manual' } });
    expect((await waitForRun(runtime.engine, run._id)).state).toBe('FAILED');
    const nr = await nodeRun(run._id, 'slow');
    expect(nr.attempts.map((a) => a.status)).toEqual(['timed_out', 'timed_out']);
    expect(nr.error?.name).toBe('NodeTimeoutError');
    expect(nr.attempts.every((a) => (a.durationMs ?? 0) < 2_000)).toBe(true);
  });
});

describe('F1 gate: artifacts', () => {
  it('passes large content by ArtifactRef with hash, size and mime metadata', async () => {
    await register({
      key: 'gate.big',
      title: 'big output',
      nodes: [
        trigger,
        {
          id: 'big',
          capability: { type: 'test.big_text', version: 1 },
          input: { size: 100_000, seed: { $ref: 'run.input.seed' } },
        },
        {
          id: 'measure',
          capability: { type: 'test.measure', version: 1 },
          input: { text: { $ref: 'nodes.big.output.text' } },
        },
      ],
      edges: [
        { from: 'start', to: 'big' },
        { from: 'big', to: 'measure' },
      ],
    });
    const seed = randomBytes(8).toString('hex');
    const run = await runtime.engine.startRun({
      workflowKey: 'gate.big',
      input: { seed },
      trigger: { kind: 'manual' },
    });
    const done = await waitForRun(runtime.engine, run._id);
    expect(done.state).toBe('COMPLETED');

    const expectedText = `${seed}${'x'.repeat(100_000)}`;
    const expectedJson = JSON.stringify({ text: expectedText });
    const big = await nodeRun(run._id, 'big');
    expect(big.output).toBeUndefined(); // not inline in Mongo
    expect(big.outputPreview).toHaveLength(2048);
    expect(big.outputRef).toMatchObject({
      sha256: createHash('sha256').update(expectedJson).digest('hex'),
      size: Buffer.byteLength(expectedJson),
      mimeType: 'application/json',
    });
    const meta = await runtime.engine.artifacts.get(big.outputRef!.artifactId);
    expect(meta.context).toMatchObject({
      runId: run._id,
      nodeRunId: big._id,
      labels: { kind: 'node-output' },
    });
    expect(await infra.storage.exists(meta.storageKey)).toBe(true);
    expect(await runtime.engine.loadNodeOutput(run._id, 'big')).toEqual({ text: expectedText });

    // Downstream received the full content through the reference; its recorded input is a preview.
    expect(done.output).toEqual({
      length: expectedText.length,
      sha256: createHash('sha256').update(expectedText).digest('hex'),
    });
    expect((await nodeRun(run._id, 'measure')).inputTruncated).toBe(true);
    expect((await runtime.queries.getRunDetail(run._id)).artifacts.map((a) => a.artifactId)).toContain(
      big.outputRef!.artifactId,
    );
  });

  it('stores content once by hash and detects corruption on load', async () => {
    const body = `artifact ${randomBytes(16).toString('hex')}`;
    const a = await runtime.engine.artifacts.put(body, 'text/plain', { labels: { kind: 'gate' } });
    const b = await runtime.engine.artifacts.put(body, 'text/plain', { labels: { kind: 'gate' } });
    expect(b).toEqual(a);
    expect(a).toMatchObject({
      sha256: createHash('sha256').update(body).digest('hex'),
      size: Buffer.byteLength(body),
      mimeType: 'text/plain',
    });
    expect((await runtime.engine.artifacts.get(a.artifactId)).storeCount).toBe(2);
    expect(await runtime.engine.artifacts.readText(a)).toBe(body);

    await infra.storage.put(a.storageKey, new TextEncoder().encode('tampered'), 'text/plain');
    await expect(runtime.engine.artifacts.readBytes(a)).rejects.toThrow(/integrity/);
  });
});

describe('F1 gate: BullMQ is transport only', () => {
  it('keeps completed state fully readable and accepts new work durably while the queue is unavailable', async () => {
    await register({
      key: 'gate.transport',
      title: 'transport',
      nodes: [
        trigger,
        { id: 'effect', capability: { type: 'test.side_effect', version: 1 } },
        {
          id: 'echo',
          capability: { type: 'test.echo', version: 1 },
          input: { value: { $ref: 'nodes.effect.output.key' } },
        },
      ],
      edges: [
        { from: 'start', to: 'effect' },
        { from: 'effect', to: 'echo' },
      ],
    });
    const completed = await runtime.engine.startRun({
      workflowKey: 'gate.transport',
      trigger: { kind: 'manual' },
    });
    expect((await waitForRun(runtime.engine, completed._id)).state).toBe('COMPLETED');

    // Redis loses everything and becomes unreachable.
    await stopHost();
    for (const q of [nodeQueueName('default'), FANOUT_QUEUE]) {
      await infra.transport.queue(q).obliterate({ force: true });
    }
    const failing = new FailingDispatcher();
    const outage = createTestRuntime(infra, { leaseMs: 1_500, capabilities: extra, dispatcher: failing });

    // Completed state is knowable from Mongo alone.
    const detail = await outage.queries.getRunDetail(completed._id);
    expect(detail.run).toMatchObject({ state: 'COMPLETED', output: { value: `${completed._id}:effect` } });
    expect(detail.nodes.map((n) => [n.nodeId, n.nodeRun?.state])).toEqual([
      ['start', 'COMPLETED'],
      ['effect', 'COMPLETED'],
      ['echo', 'COMPLETED'],
    ]);
    const effect = await outage.queries.getNodeRun((await nodeRun(completed._id, 'effect'))._id);
    expect(effect).toMatchObject({ capability: { type: 'test.side_effect', version: 1 }, attempt: 1 });
    expect(effect.attempts.map((a) => a.status)).toEqual(['completed']);
    expect(
      (await outage.queries.listRuns({ workflowKey: 'gate.transport', limit: 10, offset: 0 })).total,
    ).toBe(1);

    // New work is accepted: the run and its first node are durably recorded even though no
    // wake-up could be sent (the failure is logged and counted, not thrown).
    const pending = await outage.engine.startRun({
      workflowKey: 'gate.transport',
      trigger: { kind: 'manual' },
    });
    expect(failing.calls).toBeGreaterThan(0);
    expect(pending.state).toBe('RUNNING');
    expect((await nodeRun(pending._id, 'start')).state).toBe('QUEUED');
    await outage.http.close();

    // Redis is back: the sweeper re-dispatches from Mongo and the run completes.
    startHost('gate-w2');
    const recovered = await waitForRun(runtime.engine, pending._id, undefined, 20_000);
    expect(recovered.state).toBe('COMPLETED');
    expect(await executions(`${pending._id}:effect`)).toEqual({ docs: 1, executions: 1 });
    await waitFor(async () => (await runtime.engine.getRun(completed._id)).state === 'COMPLETED');
  });
});

describe('F1 gate: lease fencing (H-1)', () => {
  it('rejects a stale worker at attempt start after takeover; the new owner stays authoritative', async () => {
    await register({
      key: 'gate.fence',
      title: 'fence',
      nodes: [trigger, { id: 'effect', capability: { type: 'test.side_effect', version: 1 } }],
      edges: [{ from: 'start', to: 'effect' }],
    });
    await stopHost(); // no background worker/sweeper may interfere with the interleaving
    // Two workers sharing one controllable clock; no transport (nothing is delivered).
    let nowMs = Date.now();
    const clock = { now: () => new Date(nowMs) };
    const opts = { leaseMs: 1_000, capabilities: extra, dispatcher: new RecordingDispatcher(), clock };
    const workerA = createTestRuntime(infra, opts);
    const workerB = createTestRuntime(infra, opts);
    try {
      const run = await workerA.engine.startRun({ workflowKey: 'gate.fence', trigger: { kind: 'manual' } });
      expect(await workerA.engine.executeNodeRun((await nodeRun(run._id, 'start'))._id, 'A')).toBe(
        'COMPLETED',
      );
      const effectId = (await nodeRun(run._id, 'effect'))._id;

      // A claims, then stalls just before beginning its attempt.
      const storeA = workerA.engine.stores.nodeRuns;
      const originalBegin = storeA.beginAttempt.bind(storeA);
      let arrived!: () => void;
      const stalled = new Promise<void>((r) => (arrived = r));
      let resume!: () => void;
      const gate = new Promise<void>((r) => (resume = r));
      storeA.beginAttempt = async (...args) => {
        arrived();
        await gate;
        return originalBegin(...args);
      };
      const execA = workerA.engine.executeNodeRun(effectId, 'A');
      await stalled;
      expect(await nodeRun(run._id, 'effect')).toMatchObject({
        state: 'RUNNING',
        leaseOwner: 'A',
        attempt: 1,
      });

      // A's lease expires; B takes over and completes the node.
      nowMs += 5_000;
      expect(await workerB.engine.executeNodeRun(effectId, 'B')).toBe('COMPLETED');

      // A resumes: it is rejected before the capability body runs.
      resume();
      expect(await execA).toBeNull();
      storeA.beginAttempt = originalBegin;

      const nr = await nodeRun(run._id, 'effect');
      expect(nr).toMatchObject({ state: 'COMPLETED', attempt: 2 });
      expect(nr.leaseOwner).toBeUndefined();
      expect(nr.attempts.map((a) => [a.attempt, a.workerId, a.status])).toEqual([[2, 'B', 'completed']]);
      expect(await executions(`${run._id}:effect`)).toEqual({ docs: 1, executions: 1 }); // only B executed
    } finally {
      await workerA.http.close();
      await workerB.http.close();
    }
  });

  it('a stale worker that already began its attempt cannot enter the capability after losing the lease', async () => {
    await register({
      key: 'gate.fence2',
      title: 'fence 2',
      nodes: [trigger, { id: 'effect', capability: { type: 'test.side_effect', version: 1 } }],
      edges: [{ from: 'start', to: 'effect' }],
    });
    await stopHost();
    let nowMs = Date.now();
    const clock = { now: () => new Date(nowMs) };
    const opts = { leaseMs: 1_000, capabilities: extra, dispatcher: new RecordingDispatcher(), clock };
    const workerA = createTestRuntime(infra, opts);
    const workerB = createTestRuntime(infra, opts);
    try {
      const run = await workerA.engine.startRun({ workflowKey: 'gate.fence2', trigger: { kind: 'manual' } });
      await workerA.engine.executeNodeRun((await nodeRun(run._id, 'start'))._id, 'A');
      const effectId = (await nodeRun(run._id, 'effect'))._id;
      // A stalls after beginning its attempt (while recording its input).
      const outputsA = workerA.engine.outputs;
      const originalRecord = outputsA.recordInput.bind(outputsA);
      let arrived!: () => void;
      const stalled = new Promise<void>((r) => (arrived = r));
      let resume!: () => void;
      const gate = new Promise<void>((r) => (resume = r));
      outputsA.recordInput = async (...args) => {
        arrived();
        await gate;
        return originalRecord(...args);
      };
      const execA = workerA.engine.executeNodeRun(effectId, 'A');
      await stalled;
      nowMs += 5_000;
      expect(await workerB.engine.executeNodeRun(effectId, 'B')).toBe('COMPLETED');
      resume();
      expect(await execA).toBe('RUNNING'); // gave up: not executed, nothing recorded
      outputsA.recordInput = originalRecord;
      const nr = await nodeRun(run._id, 'effect');
      expect(nr.attempts.map((a) => [a.attempt, a.workerId, a.status])).toEqual([
        [1, 'A', 'lost'],
        [2, 'B', 'completed'],
      ]);
      expect(await executions(`${run._id}:effect`)).toEqual({ docs: 1, executions: 1 });
    } finally {
      await workerA.http.close();
      await workerB.http.close();
    }
  });

  it('a stale fan-out chunk worker runs no item after its chunk is taken over', async () => {
    await register({
      key: 'gate.fence_chunk',
      title: 'fence chunk',
      nodes: [
        trigger,
        { id: 'records', capability: { type: 'test.emit_items', version: 1 }, input: { count: 10 } },
        {
          id: 'each',
          capability: { type: 'core.for_each', version: 1 },
          config: {
            body: {
              capability: { type: 'test.concurrency_body', version: 1 },
              input: { n: { $ref: 'item.n' } },
            },
            concurrency: 1,
            batchSize: 5, // two chunks: the node stays FANNING_OUT after the first completes
          },
          input: { items: { $ref: 'nodes.records.output.records' } },
        },
      ],
      edges: [
        { from: 'start', to: 'records' },
        { from: 'records', to: 'each' },
      ],
    });
    await stopHost();
    let nowMs = Date.now();
    const clock = { now: () => new Date(nowMs) };
    const opts = { leaseMs: 1_000, capabilities: extra, dispatcher: new RecordingDispatcher(), clock };
    const workerA = createTestRuntime(infra, opts);
    const workerB = createTestRuntime(infra, opts);
    try {
      const run = await workerA.engine.startRun({
        workflowKey: 'gate.fence_chunk',
        trigger: { kind: 'manual' },
      });
      for (const id of ['start', 'records', 'each']) {
        await workerA.engine.executeNodeRun((await nodeRun(run._id, id))._id, 'A');
      }
      const each = await nodeRun(run._id, 'each');
      expect(each.state).toBe('FANNING_OUT');
      const chunk = (await runtime.engine.chunks.findOne({ nodeRunId: each._id, index: 0 }))!;
      expect(chunk.state).toBe('QUEUED');

      // A claims the chunk, then stalls before running any item.
      const chunksA = workerA.engine.stores.chunks;
      const originalClaim = chunksA.claim.bind(chunksA);
      let arrived!: () => void;
      const stalled = new Promise<void>((r) => (arrived = r));
      let resume!: () => void;
      const gate = new Promise<void>((r) => (resume = r));
      chunksA.claim = async (...args) => {
        const claimed = await originalClaim(...args);
        arrived();
        await gate;
        return claimed;
      };
      const processA = workerA.engine.processChunk(chunk._id, 'A');
      await stalled;
      nowMs += 5_000; // A's chunk lease expires
      expect(await workerB.engine.processChunk(chunk._id, 'B')).toBe(true);
      resume();
      expect(await processA).toBe(false);
      chunksA.claim = originalClaim;

      const items = await infra.db
        .collection('test_items')
        .find({ _id: { $regex: `^${run._id}:each:` } as never })
        .toArray();
      expect(items).toHaveLength(5); // chunk 0 only
      expect(items.every((i) => i.n === 1)).toBe(true); // each item body executed once (by B)
      const done = (await runtime.engine.chunks.findOne({ _id: chunk._id }))!;
      expect(done).toMatchObject({ state: 'COMPLETED', attempt: 2 });
      expect(done.results.map((r) => r.index).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    } finally {
      await workerA.http.close();
      await workerB.http.close();
    }
  });

  // Independent re-audit probes (H-1): the SAME worker id holds attempt 1, loses the lease, and
  // claims attempt 2. The stale attempt-1 token must not be able to write anything.
  it('same worker id, two attempts: every authoritative write of the stale attempt is rejected', async () => {
    await register({
      key: 'gate.fence_same_worker',
      title: 'fence same worker',
      nodes: [trigger, { id: 'effect', capability: { type: 'test.side_effect', version: 1 } }],
      edges: [{ from: 'start', to: 'effect' }],
    });
    await stopHost();
    let nowMs = Date.now();
    const clock = { now: () => new Date(nowMs) };
    const w = createTestRuntime(infra, {
      leaseMs: 1_000,
      capabilities: extra,
      dispatcher: new RecordingDispatcher(),
      clock,
    });
    try {
      const store = w.engine.stores.nodeRuns;
      const run = await w.engine.startRun({
        workflowKey: 'gate.fence_same_worker',
        trigger: { kind: 'manual' },
      });
      await w.engine.executeNodeRun((await nodeRun(run._id, 'start'))._id, 'W');
      const id = (await nodeRun(run._id, 'effect'))._id;

      const claim1 = (await store.claim(id, 'W'))!;
      const stale = (await store.beginAttempt(claim1, 'W'))!;
      expect(stale.attempt).toBe(1);
      nowMs += 5_000; // attempt 1's lease expires; the same worker id claims again
      const claim2 = (await store.claim(id, 'W'))!;
      const current = (await store.beginAttempt(claim2, 'W'))!;
      expect(current.attempt).toBe(2);

      const unchanged = async () =>
        expect(await nodeRun(run._id, 'effect')).toMatchObject({
          state: 'RUNNING',
          leaseOwner: 'W',
          attempt: 2,
        });
      expect(await store.renewLease(stale)).toBe(false);
      await unchanged();
      expect(await store.finish(stale, 'COMPLETED', { output: { stale: true } })).toBe(false);
      await unchanged();
      expect(await store.finish(stale, 'FAILED', { error: serializeError(new Error('stale')) })).toBe(false);
      await unchanged();
      expect(
        await store.scheduleRetry(stale, serializeError(new Error('stale')), 0, 'failed', []),
      ).toBeNull();
      await unchanged();
      expect(await store.suspend(stale, { kind: 'review', reason: 'stale' }, [])).toBe(false);
      await unchanged();
      expect(await store.enterFanout(stale, { totalItems: 0 } as never)).toBe(false);
      await unchanged();
      await store.recordInput(stale, { stale: true }, false);
      const after = await nodeRun(run._id, 'effect');
      expect(after.input).toBeUndefined();
      expect(after.output).toBeUndefined();
      expect(after.attempts.map((a) => [a.attempt, a.status])).toEqual([
        [1, 'lost'],
        [2, 'running'],
      ]);

      // The current attempt still owns the node.
      expect(await store.renewLease(current)).toBe(true);
      expect(await store.finish(current, 'COMPLETED', { output: { ok: true } })).toBe(true);
      expect(await nodeRun(run._id, 'effect')).toMatchObject({ state: 'COMPLETED', output: { ok: true } });
    } finally {
      await w.http.close();
    }
  });

  it('same worker id, two chunk claims: the stale claim cannot renew, append, complete or cancel', async () => {
    await register({
      key: 'gate.fence_chunk_same_worker',
      title: 'fence chunk same worker',
      nodes: [
        trigger,
        { id: 'records', capability: { type: 'test.emit_items', version: 1 }, input: { count: 10 } },
        {
          id: 'each',
          capability: { type: 'core.for_each', version: 1 },
          config: {
            body: {
              capability: { type: 'test.concurrency_body', version: 1 },
              input: { n: { $ref: 'item.n' } },
            },
            concurrency: 1,
            batchSize: 5,
          },
          input: { items: { $ref: 'nodes.records.output.records' } },
        },
      ],
      edges: [
        { from: 'start', to: 'records' },
        { from: 'records', to: 'each' },
      ],
    });
    await stopHost();
    let nowMs = Date.now();
    const clock = { now: () => new Date(nowMs) };
    const w = createTestRuntime(infra, {
      leaseMs: 1_000,
      capabilities: extra,
      dispatcher: new RecordingDispatcher(),
      clock,
    });
    try {
      const chunks = w.engine.stores.chunks;
      const run = await w.engine.startRun({
        workflowKey: 'gate.fence_chunk_same_worker',
        trigger: { kind: 'manual' },
      });
      for (const id of ['start', 'records', 'each']) {
        await w.engine.executeNodeRun((await nodeRun(run._id, id))._id, 'W');
      }
      const each = await nodeRun(run._id, 'each');
      const chunk = (await runtime.engine.chunks.findOne({ nodeRunId: each._id, index: 0 }))!;
      const c1 = (await chunks.claim(chunk._id, 'W', false))!;
      nowMs += 5_000;
      const c2 = (await chunks.claim(chunk._id, 'W', false))!;
      expect([c1.attempt, c2.attempt]).toEqual([1, 2]);
      const stale = { chunkId: chunk._id, workerId: 'W', attempt: c1.attempt };
      const current = { chunkId: chunk._id, workerId: 'W', attempt: c2.attempt };
      const result = { index: 0, status: 'succeeded' as const, attempts: 1, output: { stale: true } };

      expect(await chunks.holdsLease(stale)).toBe(false);
      expect(await chunks.renewLease(stale)).toBe(false);
      expect(await chunks.appendResults(stale, [result])).toBe(false);
      expect(
        await chunks.commitCompletion({
          lease: stale,
          nodeRunId: each._id,
          state: 'COMPLETED',
          succeeded: 1,
          failed: 0,
          releaseSlot: false,
        }),
      ).toBe(false);
      await chunks.markCancelled(stale);
      const after = (await runtime.engine.chunks.findOne({ _id: chunk._id }))!;
      expect(after).toMatchObject({ state: 'RUNNING', leaseOwner: 'W', attempt: 2 });
      expect(after.results).toEqual([]);
      expect((await nodeRun(run._id, 'each')).fanout?.completedChunks ?? 0).toBe(0);

      // The current claim still owns the chunk.
      expect(await chunks.holdsLease(current)).toBe(true);
      expect(await chunks.renewLease(current)).toBe(true);
      expect(await chunks.appendResults(current, [{ ...result, output: { ok: true } }])).toBe(true);
      expect(
        await chunks.commitCompletion({
          lease: current,
          nodeRunId: each._id,
          state: 'COMPLETED',
          succeeded: 1,
          failed: 0,
          releaseSlot: false,
        }),
      ).toBe(true);
    } finally {
      await w.http.close();
    }
  });
});
