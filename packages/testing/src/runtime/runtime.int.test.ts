import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UNAUTHENTICATED_INTERNAL_OPERATOR } from '@aptamind/contracts';
import type { WorkflowSpec } from '@aptamind/workflow-sdk';
import { type WorkflowWorkerHost, nodeQueueName } from '@aptamind/workflows';
import {
  concurrencyProbe,
  createTestInfra,
  createTestRuntime,
  startFixtureServer,
  type TestInfra,
  testWorkflows,
  waitFor,
  waitForRun,
} from '../index';

const trigger = {
  id: 'start',
  capability: { type: 'core.manual_trigger', version: 1 },
  input: { payload: { $ref: 'run.input' }, trigger: { $ref: 'trigger' } },
};

let infra: TestInfra;
let runtime: ReturnType<typeof createTestRuntime>;
let host: WorkflowWorkerHost;

beforeAll(async () => {
  infra = await createTestInfra('runtime');
  runtime = createTestRuntime(infra, { leaseMs: 2_000 });
  await runtime.registerWorkflows(testWorkflows);
  host = runtime.createWorkerHost({
    workerId: 'w1',
    schedulerEnabled: false,
    sweeperIntervalMs: 300,
    concurrency: 8,
  });
  host.start();
});

afterAll(async () => {
  await host?.stop();
  await runtime?.http.close();
  await infra?.cleanup();
});

beforeEach(async () => {
  await infra.db.collection('test_controls').deleteMany({});
});

async function register(spec: WorkflowSpec) {
  return (await runtime.catalog.register(spec)).version;
}

describe('F1 durable workflow runtime', () => {
  it('executes a multi-node workflow and records exact versions per run', async () => {
    const spec: WorkflowSpec = {
      key: 'test.multi',
      title: 'multi',
      nodes: [
        trigger,
        {
          id: 'a',
          capability: { type: 'test.echo', version: 1 },
          input: { value: { $ref: 'nodes.start.output.payload.greeting' } },
        },
        {
          id: 'b',
          capability: { type: 'test.echo', version: 1 },
          input: { value: { $ref: 'nodes.a.output.value' } },
        },
      ],
      edges: [
        { from: 'start', to: 'a' },
        { from: 'a', to: 'b' },
      ],
    };
    const v1 = await register(spec);
    expect((await register(spec)).version).toBe(v1.version); // idempotent registration
    const run = await runtime.engine.startRun({
      workflowKey: 'test.multi',
      input: { greeting: 'hi' },
      trigger: { kind: 'manual' },
    });
    const done = await waitForRun(runtime.engine, run._id);
    expect(done.state).toBe('COMPLETED');
    expect(done.output).toEqual({ value: 'hi' });
    expect(done.capabilityVersions).toEqual({
      start: 'core.manual_trigger@1',
      a: 'test.echo@1',
      b: 'test.echo@1',
    });
    const nodes = await runtime.engine.nodeRuns.find({ runId: run._id }).toArray();
    expect(nodes.map((n) => n.state).sort()).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED']);

    // Editing the workflow creates a new immutable version; the old run still references v1.
    const v2 = await register({ ...spec, title: 'multi (edited)' });
    expect(v2.version).toBe(v1.version + 1);
    expect((await runtime.engine.getRun(run._id)).versionId).toBe(v1._id);
  });

  it('retries transient failures without duplicating side effects and keeps attempt history', async () => {
    await register({
      key: 'test.retry',
      title: 'retry',
      nodes: [
        trigger,
        {
          id: 'effect',
          capability: { type: 'test.side_effect', version: 1 },
          config: { failFirstAttempts: 2 },
          retry: { maxAttempts: 4, backoffMs: 20 },
        },
      ],
      edges: [{ from: 'start', to: 'effect' }],
    });
    const run = await runtime.engine.startRun({ workflowKey: 'test.retry', trigger: { kind: 'manual' } });
    const done = await waitForRun(runtime.engine, run._id);
    expect(done.state).toBe('COMPLETED');
    const nr = await runtime.engine.nodeRuns.findOne({ runId: run._id, nodeId: 'effect' });
    expect(nr?.attempts.map((a) => a.status)).toEqual(['failed', 'failed', 'completed']);
    expect(nr?.attempts[0]?.error?.message).toMatch(/transient failure/);
    const effects = await infra.db
      .collection('test_side_effects')
      .find({ _id: `${run._id}:effect` as never })
      .toArray();
    expect(effects).toHaveLength(1); // three executions, one side effect
    expect(effects[0]?.executions).toBe(3);
  });

  it('fails terminally without retrying, stays inspectable, and supports operator retry', async () => {
    await infra.db.collection('test_controls').insertOne({ _id: 'fail' as never, enabled: true });
    await register({
      key: 'test.terminal',
      title: 'terminal',
      nodes: [
        trigger,
        { id: 'check', capability: { type: 'test.fail_if', version: 1 } },
        { id: 'after', capability: { type: 'test.echo', version: 1 } },
      ],
      edges: [
        { from: 'start', to: 'check' },
        { from: 'check', to: 'after' },
      ],
    });
    const run = await runtime.engine.startRun({ workflowKey: 'test.terminal', trigger: { kind: 'manual' } });
    const failed = await waitForRun(runtime.engine, run._id);
    expect(failed.state).toBe('FAILED');
    expect(failed.failedNodeIds).toEqual(['check']);
    const nr = await runtime.engine.nodeRuns.findOne({ runId: run._id, nodeId: 'check' });
    expect(nr?.attempts).toHaveLength(1);
    expect(nr?.error?.message).toBe('controlled terminal failure');
    const detail = await runtime.queries.getRunDetail(run._id);
    expect(detail.nodes.find((n) => n.nodeId === 'check')?.nodeRun?.state).toBe('FAILED');

    await infra.db
      .collection('test_controls')
      .updateOne({ _id: 'fail' as never }, { $set: { enabled: false } });
    await runtime.engine.retryNodeRun(nr!._id, UNAUTHENTICATED_INTERNAL_OPERATOR);
    const done = await waitForRun(runtime.engine, run._id, ['COMPLETED']);
    const after = await runtime.engine.nodeRuns.findOne({ _id: nr!._id });
    expect(after?.attempts.map((a) => a.status)).toEqual(['failed', 'completed']);
    expect(after?.manualRetries).toBe(1);
    expect(done.error).toBeUndefined();
  });

  it('bounds fan-out concurrency over many items and aggregates item results', async () => {
    concurrencyProbe.active = 0;
    concurrencyProbe.max = 0;
    await register({
      key: 'test.fanout',
      title: 'fanout',
      nodes: [
        trigger,
        {
          id: 'items',
          capability: { type: 'test.emit_items', version: 1 },
          input: { count: { $ref: 'nodes.start.output.payload.count' } },
        },
        {
          id: 'each',
          capability: { type: 'core.for_each', version: 1 },
          config: {
            body: {
              capability: { type: 'test.concurrency_body', version: 1 },
              input: { n: { $ref: 'item.n' } },
              config: { failWhenDivisibleBy: 50 },
            },
            concurrency: 3,
            batchSize: 7,
          },
          input: { items: { $ref: 'nodes.items.output.records' } },
        },
      ],
      edges: [
        { from: 'start', to: 'items' },
        { from: 'items', to: 'each' },
      ],
    });
    const run = await runtime.engine.startRun({
      workflowKey: 'test.fanout',
      input: { count: 300 },
      trigger: { kind: 'manual' },
    });
    const done = await waitForRun(runtime.engine, run._id, undefined, 60_000);
    expect(done.state).toBe('COMPLETED');
    expect(done.output).toMatchObject({ total: 300, succeeded: 294, failed: 6 });
    expect((done.output as { sampleFailures: unknown[] }).sampleFailures).toHaveLength(6);
    // Items within a chunk run sequentially, so simultaneous executions == chunks in flight.
    expect(concurrencyProbe.max).toBeLessThanOrEqual(3);
    expect(concurrencyProbe.max).toBeGreaterThan(1);
    const each = await runtime.engine.nodeRuns.findOne({ runId: run._id, nodeId: 'each' });
    expect(each?.fanout).toMatchObject({
      totalItems: 300,
      totalChunks: 43,
      completedChunks: 43,
      inFlight: 0,
    });
    expect(
      await infra.db
        .collection('test_items')
        .countDocuments({ _id: { $regex: `^${run._id}:each:` } as never }),
    ).toBe(300);
  });

  it('times out slow nodes with a clear failure state', async () => {
    await register({
      key: 'test.timeout',
      title: 'timeout',
      nodes: [
        trigger,
        {
          id: 'slow',
          capability: { type: 'test.sleep', version: 1 },
          config: { ms: 5_000 },
          timeoutMs: 200,
          retry: { maxAttempts: 1 },
        },
      ],
      edges: [{ from: 'start', to: 'slow' }],
    });
    const run = await runtime.engine.startRun({ workflowKey: 'test.timeout', trigger: { kind: 'manual' } });
    const done = await waitForRun(runtime.engine, run._id);
    expect(done.state).toBe('FAILED');
    const nr = await runtime.engine.nodeRuns.findOne({ runId: run._id, nodeId: 'slow' });
    expect(nr?.error?.name).toBe('NodeTimeoutError');
    expect(nr?.attempts[0]?.status).toBe('timed_out');
  });

  it('cancels a running workflow', async () => {
    await register({
      key: 'test.cancel',
      title: 'cancel',
      nodes: [
        trigger,
        { id: 'slow', capability: { type: 'test.sleep', version: 1 }, config: { ms: 20_000 } },
        { id: 'never', capability: { type: 'test.echo', version: 1 } },
      ],
      edges: [
        { from: 'start', to: 'slow' },
        { from: 'slow', to: 'never' },
      ],
    });
    const run = await runtime.engine.startRun({ workflowKey: 'test.cancel', trigger: { kind: 'manual' } });
    await waitFor(
      async () =>
        (await runtime.engine.nodeRuns.findOne({ runId: run._id, nodeId: 'slow', state: 'RUNNING' })) ?? null,
    );
    await runtime.engine.cancelRun(run._id, UNAUTHENTICATED_INTERNAL_OPERATOR);
    const done = await waitForRun(runtime.engine, run._id, ['CANCELLED'], 10_000);
    expect(done.state).toBe('CANCELLED');
    expect(await runtime.engine.nodeRuns.findOne({ runId: run._id, nodeId: 'never' })).toBeNull();
  });

  it('follows conditional branches and skips inactive paths', async () => {
    await register({
      key: 'test.branch',
      title: 'branch',
      nodes: [
        trigger,
        {
          id: 'check',
          capability: { type: 'core.if', version: 1 },
          config: { conditions: [{ path: 'size', op: 'gt', value: 10 }] },
          input: { value: { $ref: 'nodes.start.output.payload' } },
        },
        { id: 'big', capability: { type: 'test.echo', version: 1 }, input: { value: 'big' } },
        { id: 'small', capability: { type: 'test.echo', version: 1 }, input: { value: 'small' } },
      ],
      edges: [
        { from: 'start', to: 'check' },
        { from: 'check', to: 'big', when: { branch: 'true' } },
        { from: 'check', to: 'small', when: { branch: 'false' } },
      ],
    });
    const run = await runtime.engine.startRun({
      workflowKey: 'test.branch',
      input: { size: 3 },
      trigger: { kind: 'manual' },
    });
    const done = await waitForRun(runtime.engine, run._id);
    expect(done.state).toBe('COMPLETED');
    const byNode = Object.fromEntries(
      (await runtime.engine.nodeRuns.find({ runId: run._id }).toArray()).map((n) => [n.nodeId, n.state]),
    );
    expect(byNode).toMatchObject({ check: 'COMPLETED', big: 'SKIPPED', small: 'COMPLETED' });
  });

  it('stores fetched content as an artifact that can be reloaded and reprocessed without refetching', async () => {
    const server = await startFixtureServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/csv' });
      res.end('name,town\nAcme Ltd,London\nBeta Limited,Leeds\n');
    });
    try {
      await register({
        key: 'test.artifacts',
        title: 'artifacts',
        nodes: [
          trigger,
          {
            id: 'download',
            capability: { type: 'core.http_request', version: 1 },
            input: { url: { $ref: 'nodes.start.output.payload.url' } },
          },
          {
            id: 'parse',
            capability: { type: 'core.parse_csv', version: 1 },
            input: { artifact: { $ref: 'nodes.download.output.artifact' } },
          },
        ],
        edges: [
          { from: 'start', to: 'download' },
          { from: 'download', to: 'parse' },
        ],
      });
      await register({
        key: 'test.reprocess',
        title: 'reprocess from snapshot',
        nodes: [
          trigger,
          {
            id: 'parse',
            capability: { type: 'core.parse_csv', version: 1 },
            input: { artifact: { $ref: 'nodes.start.output.payload.artifact' } },
          },
        ],
        edges: [{ from: 'start', to: 'parse' }],
      });
      const run = await runtime.engine.startRun({
        workflowKey: 'test.artifacts',
        input: { url: `${server.url}/sponsors.csv` },
        trigger: { kind: 'manual' },
      });
      const done = await waitForRun(runtime.engine, run._id);
      expect(done.state).toBe('COMPLETED');
      const download = await runtime.engine.loadNodeOutput(run._id, 'download');
      const artifact = (download as { artifact: { artifactId: string; sha256: string } }).artifact;
      expect(artifact.sha256).toHaveLength(64);
      expect(await infra.artifacts.readText(artifact)).toContain('Acme Ltd');
      expect((done.output as { rowCount: number }).rowCount).toBe(2);

      const hitsBefore = server.hits.length;
      const re = await runtime.engine.startRun({
        workflowKey: 'test.reprocess',
        input: { artifact },
        trigger: { kind: 'manual' },
      });
      const reDone = await waitForRun(runtime.engine, re._id);
      expect(reDone.state).toBe('COMPLETED');
      expect((reDone.output as { rowCount: number }).rowCount).toBe(2);
      expect(server.hits.length).toBe(hitsBefore); // no refetch
    } finally {
      await server.close();
    }
  });

  it('suspends for review and resumes with an operator decision', async () => {
    await register({
      key: 'test.wait',
      title: 'wait',
      nodes: [
        trigger,
        {
          id: 'approve',
          capability: { type: 'test.suspend', version: 1 },
          input: { key: { $ref: 'nodes.start.output.payload.key' } },
        },
      ],
      edges: [{ from: 'start', to: 'approve' }],
    });
    const run = await runtime.engine.startRun({
      workflowKey: 'test.wait',
      input: { key: 'rev_123' },
      trigger: { kind: 'manual' },
    });
    const waiting = await waitForRun(runtime.engine, run._id, ['WAITING']);
    expect(waiting.state).toBe('WAITING');
    expect(
      await runtime.engine.resumeByCorrelationKey(
        'rev_123',
        { approved: true },
        UNAUTHENTICATED_INTERNAL_OPERATOR,
      ),
    ).toBe(1);
    const done = await waitForRun(runtime.engine, run._id);
    expect(done.state).toBe('COMPLETED');
    expect(done.output).toEqual({ approved: true });
  });

  it('executes subworkflows durably and idempotently', async () => {
    await register({
      key: 'test.child',
      title: 'child',
      nodes: [
        trigger,
        {
          id: 'effect',
          capability: { type: 'test.side_effect', version: 1 },
          input: { tag: { $ref: 'nodes.start.output.payload.tag' } },
        },
      ],
      edges: [{ from: 'start', to: 'effect' }],
    });
    await register({
      key: 'test.parent',
      title: 'parent',
      nodes: [
        trigger,
        {
          id: 'child',
          capability: { type: 'core.execute_subworkflow', version: 1 },
          config: { workflowKey: 'test.child' },
          input: { input: { tag: 'from-parent' } },
        },
      ],
      edges: [{ from: 'start', to: 'child' }],
    });
    const run = await runtime.engine.startRun({ workflowKey: 'test.parent', trigger: { kind: 'manual' } });
    const done = await waitForRun(runtime.engine, run._id);
    expect(done.state).toBe('COMPLETED');
    const out = done.output as { childRunId: string; output: { key: string } };
    const child = await runtime.engine.getRun(out.childRunId);
    expect(child).toMatchObject({
      state: 'COMPLETED',
      parent: { runId: run._id },
      rootRunId: run._id,
      depth: 1,
    });
    const again = await runtime.engine.runSubworkflow(
      { run: done, nodeRunId: 'x' },
      { workflowKey: 'test.child', input: { tag: 'from-parent' }, idempotencyKey: `${run._id}:child` },
      'w-test',
    );
    expect(again.runId).toBe(out.childRunId);
  });

  it('deduplicates schedule fires and survives concurrent schedulers', async () => {
    const s = await runtime.scheduler.upsert({
      workflowKey: 'test.multi',
      intervalMinutes: 60,
      enabled: true,
      input: { greeting: 'scheduled' },
      owner: { kind: 'test', id: 'sched-1' },
    });
    await runtime.engine.db
      .collection('workflow_schedules')
      .updateOne({ _id: s._id as never }, { $set: { nextFireAt: new Date(Date.now() - 1000) } });
    const [a, b] = await Promise.all([runtime.scheduler.tick(), runtime.scheduler.tick()]);
    expect(a + b).toBe(1);
    const runs = await runtime.engine.runs.find({ 'trigger.scheduleId': s._id }).toArray();
    expect(runs).toHaveLength(1);
    expect((await waitForRun(runtime.engine, runs[0]!._id)).state).toBe('COMPLETED');
  });

  it('recovers queued work when the transport loses jobs (Redis flush)', async () => {
    await host.stop();
    try {
      await register({
        key: 'test.lost',
        title: 'lost',
        nodes: [trigger, { id: 'effect', capability: { type: 'test.side_effect', version: 1 } }],
        edges: [{ from: 'start', to: 'effect' }],
      });
      const run = await runtime.engine.startRun({ workflowKey: 'test.lost', trigger: { kind: 'manual' } });
      await runtime.engine.nodeRuns.updateOne(
        { runId: run._id },
        { $set: { dispatchedAt: new Date(Date.now() - 60_000) } },
      );
      await infra.transport.queue(nodeQueueName('default')).obliterate({ force: true });
      host = runtime.createWorkerHost({ workerId: 'w2', schedulerEnabled: false, sweeperIntervalMs: 200 });
      host.start();
      const done = await waitForRun(runtime.engine, run._id);
      expect(done.state).toBe('COMPLETED');
    } finally {
      // host restarted above
    }
  });

  it('takes over a node from a crashed (SIGKILLed) worker process without duplicating side effects', async () => {
    await infra.db.collection('test_controls').insertOne({ _id: 'hang' as never, enabled: true });
    await host.stop(); // only the child worker may pick the node up first
    const child = fork(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/crash-worker.ts'),
      [],
      {
        execArgv: ['--import', 'tsx'],
        env: {
          ...process.env,
          TEST_DB_NAME: infra.dbName,
          TEST_QUEUE_PREFIX: infra.queuePrefix,
          TEST_LEASE_MS: '1500',
        },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve());
        child.once('exit', (code) => reject(new Error(`crash worker exited early (${code})`)));
      });
      const run = await runtime.engine.startRun({ workflowKey: 'test.crash', trigger: { kind: 'manual' } });
      // Barrier: the child has begun its attempt and its capability body has committed its side
      // effect (the durable `started` marker) — only then is it killed. Killing merely after the
      // claim raced with the attempt start and the side effect.
      await waitFor(
        async () =>
          (await infra.db
            .collection('test_side_effects')
            .findOne({ _id: `${run._id}:work:started` as never })) ?? null,
        { timeoutMs: 20_000, message: 'child worker to start the capability body' },
      );
      const running = await runtime.engine.nodeRuns.findOne({ runId: run._id, nodeId: 'work' });
      expect(running).toMatchObject({ state: 'RUNNING', leaseOwner: 'crash-worker', attempt: 1 });
      expect(running?.attempts.map((a) => [a.workerId, a.status])).toEqual([['crash-worker', 'running']]);
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGKILL');
      await exited; // the process is gone before a replacement worker starts
      await infra.db
        .collection('test_controls')
        .updateOne({ _id: 'hang' as never }, { $set: { enabled: false } });

      host = runtime.createWorkerHost({ workerId: 'w3', schedulerEnabled: false, sweeperIntervalMs: 200 });
      host.start();
      const done = await waitForRun(runtime.engine, run._id, undefined, 30_000);
      expect(done.state).toBe('COMPLETED');
      const nr = await runtime.engine.nodeRuns.findOne({ runId: run._id, nodeId: 'work' });
      expect(nr?.attempts.map((a) => [a.workerId, a.status])).toEqual([
        ['crash-worker', 'lost'],
        ['w3', 'completed'],
      ]);
      const started = await infra.db
        .collection('test_side_effects')
        .findOne({ _id: `${run._id}:work:started` as never });
      expect(started?.n).toBe(2); // executed twice, recorded against one idempotency key
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});
