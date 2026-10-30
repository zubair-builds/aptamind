import {
  type Clock,
  deterministicId,
  InvalidStateError,
  type JsonObject,
  type JsonValue,
  serializeError,
} from '@aptamind/contracts';
import { type Logger, type MetricsRegistry, withCorrelation } from '@aptamind/observability';
import type { ArtifactStore } from '@aptamind/storage';
import { capabilityKey, isSuspend } from '@aptamind/workflow-sdk';
import type { CancellationCoordinator } from './cancellation';
import type { WorkflowCatalog } from './catalog';
import {
  buildCapabilityContext,
  type CapabilityEnvironment,
  correlationLabels,
  createRecordAccess,
} from './context';
import { type ForEachConfig, forEachConfigSchema, type ForEachOutput } from './control';
import { ExecutionGuard, sleep } from './execution-guard';
import type { NodeOutputStore } from './outputs';
import type { RunDriver } from './ports';
import { resolveTemplate, type RefScope } from './refs';
import { type CapabilityRegistry, validateWith } from './registry';
import { decideOnFailure, itemRetryPolicy } from './retry-policy';
import {
  type FanoutChunkDoc,
  type FanoutState,
  type ItemResult,
  type NodeRunDoc,
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowRunDoc,
} from './schemas';
import type { NodeState } from './state-machine';
import type { ChunkLease, ChunkStore } from './stores/chunk-store';
import type { AttemptFence, NodeRunStore } from './stores/node-run-store';
import type { RunStore } from './stores/run-store';
import type { WakeUps } from './transport';

export interface FanoutDeps {
  runs: RunStore;
  nodeRuns: NodeRunStore;
  chunks: ChunkStore;
  catalog: WorkflowCatalog;
  registry: CapabilityRegistry;
  outputs: NodeOutputStore;
  artifacts: ArtifactStore;
  wake: WakeUps;
  /** Resolved lazily: cancellation and fan-out reference each other. */
  cancellation: () => CancellationCoordinator;
  driver: RunDriver;
  env: CapabilityEnvironment;
  clock: Clock;
  logger: Logger;
  metrics: MetricsRegistry;
  leaseMs: number;
}

const CHUNK_INSERT_BATCH = 50;
const RESULT_FLUSH_EVERY = 10;

/**
 * Bounded fan-out (`core.for_each`).
 *
 * Items are partitioned once into chunk documents (deterministic ids, so a retried
 * coordinator recreates nothing). At most `concurrency` chunks are in flight: a chunk is
 * queued only after atomically taking a slot (`inFlight < concurrency`), and the slot is
 * released in the same transaction that completes the chunk and moves the parent's counters.
 * Items inside a chunk run sequentially with per-item retries; their results are persisted
 * as they complete, so a chunk taken over after a crash skips items already done. Each item
 * has idempotency key `<nodeRun.idempotencyKey>:<itemIndex>` and, for workflow bodies, a
 * child run linked to the parent node and item index (lineage).
 */
export class FanoutCoordinator {
  constructor(private readonly d: FanoutDeps) {}

  /** Partition the items and hand the node over to chunk processing (state FANNING_OUT). */
  async start(args: {
    nodeRun: NodeRunDoc;
    run: WorkflowRunDoc;
    fence: AttemptFence;
    config: ForEachConfig;
    input: { items: unknown };
    inline: boolean;
  }): Promise<NodeState> {
    const { nodeRun, run, config } = args;
    const bodyKey = config.body.capability ? capabilityKey(config.body.capability) : undefined;
    if (config.body.capability && !this.d.registry.has(config.body.capability)) {
      throw new InvalidStateError(`for_each body capability ${bodyKey} is not registered`);
    }
    const { totalItems, totalChunks } = await this.partition(nodeRun, run, config, args.input.items);

    const fanout: FanoutState = {
      totalItems,
      totalChunks,
      batchSize: config.batchSize,
      concurrency: config.concurrency,
      inFlight: 0,
      completedChunks: 0,
      succeededItems: 0,
      failedItems: 0,
      failurePolicy: config.failurePolicy,
      maxFailureRatio: config.maxFailureRatio,
      bodyCapability: bodyKey,
      bodyWorkflow: config.body.workflow
        ? `${config.body.workflow.key}@${config.body.workflow.version ?? 'latest'}`
        : undefined,
    };
    if (!(await this.d.nodeRuns.enterFanout(args.fence, fanout))) return 'RUNNING';
    this.d.logger.info({ totalItems, totalChunks, concurrency: config.concurrency }, 'fan-out started');

    if (totalChunks === 0) {
      await this.maybeFinalize(nodeRun._id, { dispatch: !args.inline });
    } else if (args.inline) {
      // Inside an inline (child) run the chunks are processed in this process, in order.
      for (const id of await this.d.chunks.idsInOrder(nodeRun._id)) {
        await this.processChunk(id, args.fence.workerId, { inline: true });
      }
    } else {
      await this.pump(nodeRun._id);
      return 'FANNING_OUT';
    }
    return (await this.d.nodeRuns.get(nodeRun._id))?.state ?? 'COMPLETED';
  }

  private async partition(
    nodeRun: NodeRunDoc,
    run: WorkflowRunDoc,
    config: ForEachConfig,
    items: unknown,
  ): Promise<{ totalItems: number; totalChunks: number }> {
    const now = this.d.clock.now();
    const records = createRecordAccess(this.d.artifacts, {
      runId: run._id,
      nodeRunId: nodeRun._id,
      workflowKey: run.workflowKey,
    });
    let batch: FanoutChunkDoc[] = [];
    let chunkIndex = 0;
    let itemIndex = 0;
    let current: JsonValue[] = [];
    const flushChunk = () => {
      if (!current.length) return;
      batch.push({
        _id: deterministicId('fch', nodeRun._id, chunkIndex),
        runId: run._id,
        nodeRunId: nodeRun._id,
        index: chunkIndex,
        startIndex: itemIndex - current.length,
        items: current,
        state: 'PENDING',
        results: [],
        attempt: 0,
        dispatchSeq: 0,
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now,
      });
      chunkIndex += 1;
      current = [];
    };
    for await (const item of records.read(items as never)) {
      current.push(item as JsonValue);
      itemIndex += 1;
      if (current.length >= config.batchSize) flushChunk();
      if (batch.length >= CHUNK_INSERT_BATCH) {
        await this.d.chunks.insertIdempotent(batch);
        batch = [];
      }
    }
    flushChunk();
    await this.d.chunks.insertIdempotent(batch);
    return { totalItems: itemIndex, totalChunks: chunkIndex };
  }

  /** Queue pending chunks while a concurrency slot is free. Returns how many were queued. */
  async pump(nodeRunId: string): Promise<number> {
    let dispatched = 0;
    for (let i = 0; i < 1000; i++) {
      if (!(await this.d.nodeRuns.claimFanoutSlot(nodeRunId))) break;
      const chunk = await this.d.chunks.queueNext(nodeRunId);
      if (!chunk) {
        await this.d.nodeRuns.releaseFanoutSlot(nodeRunId);
        break;
      }
      await this.d.wake.chunk({ chunkId: chunk._id, dispatchSeq: chunk.dispatchSeq });
      dispatched += 1;
    }
    return dispatched;
  }

  async redispatchChunk(chunkId: string): Promise<void> {
    const c = await this.d.chunks.bumpDispatch(chunkId);
    if (c) await this.d.wake.chunk({ chunkId, dispatchSeq: c.dispatchSeq });
  }

  /** Process one chunk: run the body for every item not yet recorded. */
  async processChunk(chunkId: string, workerId: string, opts: { inline?: boolean } = {}): Promise<boolean> {
    const chunk = await this.d.chunks.claim(chunkId, workerId, !!opts.inline);
    if (!chunk) return false;
    const nodeRun = await this.d.nodeRuns.get(chunk.nodeRunId);
    const run = nodeRun ? await this.d.runs.get(nodeRun.runId) : null;
    const lease: ChunkLease = { chunkId, workerId, attempt: chunk.attempt };
    if (!nodeRun || !run || nodeRun.state !== 'FANNING_OUT') {
      await this.d.chunks.markCancelled(lease);
      return false;
    }
    return withCorrelation(
      {
        workflowRunId: run._id,
        nodeRunId: nodeRun._id,
        workflowKey: run.workflowKey,
        fanoutChunkId: chunkId,
        ...correlationLabels(run.labels),
      },
      () => this.runChunk(chunk, lease, nodeRun, run, !!opts.inline),
    );
  }

  private async runChunk(
    chunk: FanoutChunkDoc,
    lease: ChunkLease,
    nodeRun: NodeRunDoc,
    run: WorkflowRunDoc,
    inline: boolean,
  ): Promise<boolean> {
    const { workerId } = lease;
    const version = await this.d.catalog.getVersionById(run.versionId);
    const node = version.nodes.find((n) => n.id === nodeRun.nodeId);
    if (!node) throw new InvalidStateError(`Node ${nodeRun.nodeId} missing`);
    const config = forEachConfigSchema.parse(node.config);
    const done = new Set(chunk.results.map((r) => r.index));
    const pending: ItemResult[] = [];
    const outputCache = new Map<string, unknown>();
    const guard = new ExecutionGuard({
      heartbeatEveryMs: Math.floor(this.d.leaseMs / 3),
      heartbeat: async () => {
        const held = await this.d.chunks.renewLease(lease);
        if (await this.d.runs.isCancelling(run._id)) return 'cancelled';
        return held ? 'ok' : 'lease_lost';
      },
    });
    let leaseLost = false;
    const flush = async () => {
      if (!(await this.d.chunks.appendResults(lease, pending.splice(0, pending.length)))) leaseLost = true;
    };
    let stopEarly = false;
    try {
      for (let i = 0; i < chunk.items.length; i++) {
        const itemIndex = chunk.startIndex + i;
        if (done.has(itemIndex)) continue;
        if (guard.signal.aborted) break;
        // Fence: a worker whose chunk claim was taken over must not run any further item.
        if (leaseLost || !(await this.d.chunks.holdsLease(lease))) break;
        const result = await this.runItem({
          run,
          nodeRun,
          config,
          item: chunk.items[i] ?? null,
          itemIndex,
          workerId,
          chunkGuard: guard,
          outputCache,
        });
        pending.push(result);
        if (pending.length >= RESULT_FLUSH_EVERY) await flush();
        if (result.status === 'failed' && config.failurePolicy === 'fail_fast') {
          stopEarly = true;
          break;
        }
      }
      await flush();
    } finally {
      guard.dispose();
    }

    const fresh = await this.d.chunks.get(chunk._id);
    if (leaseLost || !fresh || fresh.leaseOwner !== workerId || fresh.attempt !== lease.attempt) return false;
    const succeeded = fresh.results.filter((r) => r.status === 'succeeded').length;
    const failed = fresh.results.filter((r) => r.status === 'failed').length;
    const committed = await this.d.chunks.commitCompletion({
      lease,
      nodeRunId: nodeRun._id,
      state: guard.cancelled ? 'CANCELLED' : 'COMPLETED',
      succeeded,
      failed,
      releaseSlot: !inline,
    });
    if (!committed) return false;
    const capability = nodeRun.fanout?.bodyCapability ?? 'subworkflow';
    this.d.metrics.inc('workflow_fanout_items_total', { capability, status: 'succeeded' }, succeeded);
    this.d.metrics.inc('workflow_fanout_items_total', { capability, status: 'failed' }, failed);

    // fail_fast: cancel remaining chunks so the node can finalise.
    if (stopEarly) await this.d.chunks.cancelPendingForNode(nodeRun._id);
    const finalized = await this.maybeFinalize(nodeRun._id, { dispatch: !inline });
    if (!finalized && !inline) await this.pump(nodeRun._id);
    return true;
  }

  private async runItem(args: {
    run: WorkflowRunDoc;
    nodeRun: NodeRunDoc;
    config: ForEachConfig;
    item: JsonValue;
    itemIndex: number;
    workerId: string;
    chunkGuard: ExecutionGuard;
    outputCache: Map<string, unknown>;
  }): Promise<ItemResult> {
    const { run, nodeRun, config, item, itemIndex } = args;
    const scope: RefScope = {
      run: { input: run.input, labels: run.labels },
      trigger: run.trigger,
      nodeOutput: (nodeId) => this.d.outputs.load(run._id, nodeId, args.outputCache),
      item,
      itemIndex,
    };
    const idempotencyKey = `${nodeRun.idempotencyKey}:${itemIndex}`;

    if (config.body.workflow) {
      // Workflow body: one durable child run per item (idempotent on the item key).
      try {
        const input = (await resolveTemplate(config.body.input, scope)) as JsonObject;
        const res = await this.d.env.subworkflows.run(
          { run, nodeRunId: nodeRun._id, itemIndex },
          {
            workflowKey: config.body.workflow.key,
            version: config.body.workflow.version,
            input,
            idempotencyKey,
          },
          args.workerId,
          args.chunkGuard.signal,
        );
        if (res.state === 'COMPLETED') {
          return {
            index: itemIndex,
            status: 'succeeded',
            attempts: 1,
            childRunId: res.runId,
            output: collect(config, res.output),
          };
        }
        return {
          index: itemIndex,
          status: 'failed',
          attempts: 1,
          childRunId: res.runId,
          error: {
            name: res.error?.name ?? 'ChildRunFailed',
            message: res.error?.message ?? `child run ${res.state}`,
          },
        };
      } catch (err) {
        return { index: itemIndex, status: 'failed', attempts: 1, error: serializeError(err, false) };
      }
    }

    const capRef = config.body.capability as { type: string; version: number };
    const def = this.d.registry.get(capRef);
    const capName = capabilityKey(capRef);
    const retry = itemRetryPolicy(config.body.retry, def.execution.retryable);
    const timeoutMs = config.body.timeoutMs ?? def.execution.defaultTimeoutMs ?? 60_000;
    let lastErr: unknown;
    let attempt = 0;
    while (attempt < retry.maxAttempts) {
      attempt += 1;
      const guard = new ExecutionGuard({ timeoutMs, parent: args.chunkGuard.signal });
      try {
        const cfg = validateWith(def.configSchema, config.body.config ?? {}, 'config', capName);
        const input = validateWith(
          def.inputSchema,
          await resolveTemplate(config.body.input, scope),
          'input',
          capName,
        );
        const ctx = buildCapabilityContext({
          env: this.d.env,
          run,
          nodeRun,
          attempt,
          idempotencyKey,
          signal: guard.signal,
          clock: this.d.clock,
          logger: this.d.logger,
          logBuffer: [],
          heartbeat: () => args.chunkGuard.beat(),
          itemIndex,
        });
        const result = await guard.run(def.execute(ctx, input, cfg));
        if (isSuspend(result))
          throw new InvalidStateError('Suspension is not supported inside for_each bodies');
        const output = validateWith(def.outputSchema, result, 'output', capName);
        return { index: itemIndex, status: 'succeeded', attempts: attempt, output: collect(config, output) };
      } catch (err) {
        lastErr = guard.failureOf(err);
        const decision = decideOnFailure({
          error: lastErr,
          timedOut: guard.timedOut,
          cancelled: args.chunkGuard.signal.aborted,
          leaseLost: false,
          capabilityRetryable: def.execution.retryable,
          attemptNo: attempt,
          budget: { maxAttempts: retry.maxAttempts, manualRetries: 0, resumeCount: 0 },
          policy: retry,
        });
        if (decision.kind !== 'retry') break;
        await sleep(decision.delayMs, args.chunkGuard.signal).catch(() => {});
      } finally {
        guard.dispose();
      }
    }
    return { index: itemIndex, status: 'failed', attempts: attempt, error: serializeError(lastErr, false) };
  }

  /** Finalise a fan-out node once every chunk is terminal. Idempotent. */
  async maybeFinalize(nodeRunId: string, opts: { dispatch: boolean }): Promise<boolean> {
    const nr = await this.d.nodeRuns.get(nodeRunId);
    if (!nr || nr.state !== 'FANNING_OUT' || !nr.fanout) return false;
    if ((await this.d.chunks.countOpen(nodeRunId)) > 0) return false;
    const run = await this.d.runs.get(nr.runId);
    const version = run ? await this.d.catalog.getVersionById(run.versionId) : null;
    const node = version?.nodes.find((n) => n.id === nr.nodeId);
    const config = node ? forEachConfigSchema.parse(node.config) : null;

    const { succeeded, failed } = await this.d.chunks.aggregate(nodeRunId);
    const total = nr.fanout.totalItems;
    const failureRatio = total ? failed / total : 0;
    const output: ForEachOutput = {
      total,
      succeeded,
      failed,
      failureRatio,
      sampleFailures: await this.d.chunks.sampleFailures(nodeRunId),
      outputs: config?.collectOutputs ? await this.d.chunks.collectOutputs(nodeRunId, total) : undefined,
    };
    const runCancelled = run?.state === 'CANCELLING' || run?.state === 'CANCELLED';
    const exceeded =
      (nr.fanout.failurePolicy === 'fail_fast' && failed > 0) || failureRatio > nr.fanout.maxFailureRatio;
    const state = runCancelled ? 'CANCELLED' : exceeded ? 'FAILED' : 'COMPLETED';
    const now = this.d.clock.now();
    const stored = run
      ? await this.d.outputs.store(run, nr._id, output)
      : { output: output as unknown as JsonValue };
    const finished = await this.d.nodeRuns.finishFanout(nodeRunId, state, {
      ...stored,
      durationMs: nr.startedAt ? now.getTime() - nr.startedAt.getTime() : undefined,
      ...(state === 'FAILED'
        ? {
            error: {
              name: 'FanoutFailed',
              message: `${failed}/${total} items failed (policy ${nr.fanout.failurePolicy}, max ratio ${nr.fanout.maxFailureRatio})`,
            },
          }
        : {}),
    });
    if (!finished) return false;
    this.d.logger.info({ nodeRunId, total, succeeded, failed, state }, 'fan-out finished');
    if (runCancelled) await this.d.cancellation().finishIfIdle(nr.runId);
    else await this.d.driver.advanceRun(nr.runId, opts);
    return true;
  }
}

function collect(config: ForEachConfig, output: unknown): JsonValue | undefined {
  if (!config.collectOutputs) return undefined;
  const json = JSON.stringify(output ?? null);
  return json.length <= 4096
    ? ((output ?? null) as JsonValue)
    : ({ truncated: true, preview: json.slice(0, 512) } as JsonValue);
}
