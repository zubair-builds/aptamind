import type { Db } from 'mongodb';
import {
  type Actor,
  type ArtifactRef,
  type Clock,
  InvalidStateError,
  type JsonObject,
  NotFoundError,
  systemClock,
} from '@aptamind/contracts';
import { type Logger, metrics as defaultMetrics, type MetricsRegistry } from '@aptamind/observability';
import type { ArtifactStore } from '@aptamind/storage';
import {
  capabilityKey,
  ServiceRegistry,
  type SubworkflowRequest,
  type SubworkflowResult,
} from '@aptamind/workflow-sdk';
import { CancellationCoordinator } from './cancellation';
import type { WorkflowCatalog } from './catalog';
import type { CapabilityEnvironment } from './context';
import type { Dispatcher } from './dispatcher';
import { FanoutCoordinator } from './fanout';
import { evaluateRunOutcome, planNodeDecisions, resolveOutputNodeId, type NodeSnapshot } from './graph';
import { NodeExecutor } from './node-executor';
import { NodeOutputStore } from './outputs';
import type { RunDriver, SubworkflowParent } from './ports';
import type { CapabilityRegistry } from './registry';
import type { NodeRunDoc, WorkflowRunDoc, WorkflowVersionDoc } from './schemas';
import { assertRunTransition, isTerminalRun, type NodeState } from './state-machine';
import { ChunkStore } from './stores/chunk-store';
import { NodeRunStore } from './stores/node-run-store';
import { RunStore } from './stores/run-store';
import { SubworkflowRunner } from './subworkflows';
import { WakeUps } from './transport';
import { buildRunDocument, type StartRunRequest } from './triggers';

export type { StartRunRequest } from './triggers';

export interface EngineOptions {
  db: Db;
  registry: CapabilityRegistry;
  catalog: WorkflowCatalog;
  artifacts: ArtifactStore;
  dispatcher: Dispatcher;
  logger: Logger;
  services?: ServiceRegistry;
  clock?: Clock;
  metrics?: MetricsRegistry;
  leaseMs?: number;
  /** Outputs larger than this (serialised) are offloaded to artifact storage. */
  maxInlineOutputBytes?: number;
  maxInlineInputBytes?: number;
  maxSubworkflowDepth?: number;
}

/**
 * The generic, domain-agnostic workflow engine — an orchestrator over explicit components:
 *
 * | Concern                               | Component                                  |
 * | ------------------------------------- | ------------------------------------------ |
 * | definitions / immutable versions      | `WorkflowCatalog`                          |
 * | trigger → run document                | `triggers.ts` (`buildRunDocument`)          |
 * | graph / dependency evaluation         | `graph.ts` (pure)                          |
 * | state-transition policy               | `state-machine.ts` (pure)                  |
 * | WorkflowRun / NodeRun / chunk state   | `RunStore`, `NodeRunStore`, `ChunkStore`   |
 * | capability lookup + one node attempt  | `CapabilityRegistry`, `NodeExecutor`       |
 * | retry policy                          | `retry-policy.ts` (pure)                   |
 * | timeout / heartbeat / abort           | `ExecutionGuard`                           |
 * | cancellation                          | `CancellationCoordinator`                  |
 * | bounded fan-out                       | `FanoutCoordinator`                        |
 * | subworkflows                          | `SubworkflowRunner`                        |
 * | outputs / artifact references         | `NodeOutputStore`                          |
 * | transport wake-ups (BullMQ)           | `WakeUps` over a `Dispatcher`              |
 *
 * MongoDB is the source of truth; the queue only wakes workers. The engine itself holds no
 * execution logic beyond composing these and advancing runs.
 */
export class WorkflowEngine implements RunDriver {
  readonly db: Db;
  readonly registry: CapabilityRegistry;
  readonly catalog: WorkflowCatalog;
  readonly artifacts: ArtifactStore;
  readonly services: ServiceRegistry;
  readonly stores: { runs: RunStore; nodeRuns: NodeRunStore; chunks: ChunkStore };
  readonly outputs: NodeOutputStore;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly metrics: MetricsRegistry;
  private readonly maxDepth: number;
  private readonly wake: WakeUps;
  private readonly cancellation: CancellationCoordinator;
  private readonly fanout: FanoutCoordinator;
  private readonly executor: NodeExecutor;
  private readonly subworkflows: SubworkflowRunner;

  constructor(opts: EngineOptions) {
    this.db = opts.db;
    this.registry = opts.registry;
    this.catalog = opts.catalog;
    this.artifacts = opts.artifacts;
    this.services = opts.services ?? new ServiceRegistry();
    this.clock = opts.clock ?? systemClock;
    this.logger = opts.logger;
    this.metrics = opts.metrics ?? defaultMetrics;
    this.maxDepth = opts.maxSubworkflowDepth ?? 5;
    const leaseMs = opts.leaseMs ?? 60_000;

    const runs = new RunStore(this.db, this.clock, this.metrics);
    const nodeRuns = new NodeRunStore(this.db, this.clock, leaseMs);
    const chunks = new ChunkStore(this.db, this.clock, leaseMs);
    this.stores = { runs, nodeRuns, chunks };
    this.outputs = new NodeOutputStore(nodeRuns, this.artifacts, {
      maxInlineOutputBytes: opts.maxInlineOutputBytes ?? 64 * 1024,
      maxInlineInputBytes: opts.maxInlineInputBytes ?? 16 * 1024,
    });
    this.wake = new WakeUps(opts.dispatcher, this.logger, this.metrics);
    this.subworkflows = new SubworkflowRunner({
      driver: this,
      runs,
      nodeRuns,
      outputs: this.outputs,
      clock: this.clock,
    });
    const env: CapabilityEnvironment = {
      services: this.services,
      artifacts: this.artifacts,
      subworkflows: this.subworkflows,
    };
    const common = {
      runs,
      nodeRuns,
      catalog: this.catalog,
      registry: this.registry,
      outputs: this.outputs,
      wake: this.wake,
      driver: this as RunDriver,
      env,
      clock: this.clock,
      logger: this.logger,
      metrics: this.metrics,
      leaseMs,
    };
    this.fanout = new FanoutCoordinator({
      ...common,
      chunks,
      artifacts: this.artifacts,
      cancellation: () => this.cancellation,
    });
    this.cancellation = new CancellationCoordinator(runs, nodeRuns, chunks, this.logger, (id) =>
      this.fanout.maybeFinalize(id, { dispatch: false }),
    );
    this.executor = new NodeExecutor({ ...common, cancellation: this.cancellation, fanout: this.fanout });
  }

  // Raw collections, for read models (queries), the sweeper and tests.
  get runs() {
    return this.stores.runs.collection;
  }
  get nodeRuns() {
    return this.stores.nodeRuns.collection;
  }
  get chunks() {
    return this.stores.chunks.collection;
  }

  // ======================================================================================
  // Runs
  // ======================================================================================

  /** Start a run (idempotent on `idempotencyKey`) pinned to one immutable workflow version. */
  async startRun(req: StartRunRequest): Promise<WorkflowRunDoc> {
    if (req.idempotencyKey) {
      const existing = await this.stores.runs.findByIdempotencyKey(req.idempotencyKey);
      if (existing) return existing;
    }
    const version = await this.catalog.getVersion(req.workflowKey, req.version);
    let parentRun: WorkflowRunDoc | null = null;
    if (req.parent) {
      parentRun = await this.stores.runs.get(req.parent.runId);
      if (!parentRun) throw new NotFoundError('WorkflowRun', req.parent.runId);
    }
    const doc = buildRunDocument({ version, req, parentRun, maxDepth: this.maxDepth, now: this.clock.now() });
    const { run, inserted } = await this.stores.runs.insert(doc);
    if (!inserted) return run;
    this.metrics.inc('workflow_runs_started_total', {
      workflow: version.workflowKey,
      trigger: req.trigger.kind,
    });
    this.logger.info(
      { workflowRunId: run._id, workflowKey: version.workflowKey, version: version.version },
      'workflow run started',
    );
    await this.advanceRun(run._id, { dispatch: (req.mode ?? 'queued') === 'queued' });
    return this.getRun(run._id);
  }

  async getRun(runId: string): Promise<WorkflowRunDoc> {
    const run = await this.stores.runs.get(runId);
    if (!run) throw new NotFoundError('WorkflowRun', runId);
    return run;
  }

  /**
   * Evaluate the graph (pure, `graph.ts`), persist newly ready/skipped node runs, update the
   * run's aggregate state and wake workers for new nodes. Safe to call concurrently and
   * repeatedly: node-run creation is keyed by (run, node). Returns the ids of node runs this
   * call created in QUEUED state.
   */
  async advanceRun(runId: string, opts: { dispatch: boolean }): Promise<string[]> {
    const { runs, nodeRuns } = this.stores;
    const run = await runs.get(runId);
    if (!run || isTerminalRun(run.state)) return [];
    if (run.state === 'CANCELLING') {
      await this.cancellation.finishIfIdle(runId);
      return [];
    }
    const version = await this.catalog.getVersionById(run.versionId);
    const existing = await nodeRuns.snapshots(runId);
    const snapshots = new Map<string, NodeSnapshot>(existing.map((n) => [n.nodeId, snapshotOf(n)]));
    const failed = existing.filter((n) => n.state === 'FAILED');

    const created: NodeRunDoc[] = [];
    if (failed.length === 0) {
      // Re-plan until stable: a concurrently created node run may differ from our assumption.
      for (let pass = 0; pass <= version.nodes.length; pass++) {
        const decisions = planNodeDecisions(version, snapshots);
        if (!decisions.length) break;
        for (const d of decisions) {
          const node = version.nodes.find((n) => n.id === d.nodeId);
          if (!node) continue;
          const nr = await nodeRuns.create(run, node, d.action === 'run' ? 'QUEUED' : 'SKIPPED');
          if (nr.inserted && d.action === 'run') created.push(nr.doc);
          snapshots.set(node.id, snapshotOf(nr.doc));
        }
      }
    }

    switch (evaluateRunOutcome(version, snapshots)) {
      case 'failed':
        if (run.state !== 'FAILED') {
          await runs.transition(runId, 'FAILED', {
            error: failed[0]?.error ?? { name: 'NodeFailed', message: 'A node failed' },
            failedNodeIds: failed.map((f) => f.nodeId),
          });
        }
        break;
      case 'completed':
        await runs.transition(runId, 'COMPLETED', await this.runOutput(runId, version));
        break;
      case 'waiting':
        if (run.state !== 'WAITING') await runs.transition(runId, 'WAITING');
        break;
      case 'active':
        if (run.state === 'WAITING') await runs.transition(runId, 'RUNNING');
        break;
    }

    if (opts.dispatch) {
      for (const nr of created) {
        await this.wake.node({ nodeRunId: nr._id, queue: nr.queue, dispatchSeq: nr.dispatchSeq });
      }
    }
    return created.map((n) => n._id);
  }

  private async runOutput(
    runId: string,
    version: WorkflowVersionDoc,
  ): Promise<Pick<WorkflowRunDoc, 'output' | 'outputRef'>> {
    const outNodeId = resolveOutputNodeId(version);
    if (!outNodeId) return {};
    const nr = await this.stores.nodeRuns.findCompletedOutput(runId, outNodeId);
    if (!nr || nr.state !== 'COMPLETED') return {};
    return nr.outputRef ? { outputRef: nr.outputRef } : { output: nr.output };
  }

  // ======================================================================================
  // Node execution (delegated)
  // ======================================================================================

  executeNodeRun(
    nodeRunId: string,
    workerId: string,
    opts: { inline?: boolean } = {},
  ): Promise<NodeState | null> {
    return this.executor.execute(nodeRunId, workerId, opts);
  }

  loadNodeOutput(runId: string, nodeId: string, cache?: Map<string, unknown>): Promise<unknown> {
    return this.outputs.load(runId, nodeId, cache);
  }

  // ======================================================================================
  // Operator actions: cancel, retry, resume
  // ======================================================================================

  async cancelRun(runId: string, actor: Actor, reason = 'cancelled by operator'): Promise<WorkflowRunDoc> {
    const run = await this.getRun(runId);
    if (isTerminalRun(run.state)) return run;
    assertRunTransition(run.state, 'CANCELLING');
    await this.cancellation.cancelRun(runId, actor, reason);
    return this.getRun(runId);
  }

  /**
   * Operator retry of a FAILED node: history is preserved (attempts continue numbering),
   * the attempt budget is extended by one policy's worth, and the run is re-opened.
   * Refused for capabilities that declare themselves unsafe to re-run.
   */
  async retryNodeRun(nodeRunId: string, actor: Actor): Promise<NodeRunDoc> {
    const nr = await this.stores.nodeRuns.get(nodeRunId);
    if (!nr) throw new NotFoundError('NodeRun', nodeRunId);
    if (nr.state !== 'FAILED')
      throw new InvalidStateError(`Only FAILED nodes can be retried (state ${nr.state})`);
    const def = this.registry.get(nr.capability);
    if (def.execution.idempotency === 'no_retry') {
      throw new InvalidStateError(`Capability ${capabilityKey(def)} is not safe to re-run automatically`);
    }
    const run = await this.getRun(nr.runId);
    if (run.state === 'CANCELLED' || run.state === 'CANCELLING')
      throw new InvalidStateError('Run was cancelled');
    const updated = await this.stores.nodeRuns.requeueFailed(nodeRunId, actor);
    if (!updated) throw new InvalidStateError('Node changed state concurrently');
    // Fan-out: re-run only unfinished items; completed chunks keep their results.
    if (def.execution.mode === 'fanout') await this.stores.chunks.deleteUnfinished(nodeRunId);
    if (run.state === 'FAILED') await this.stores.runs.reopenFailed(run._id);
    await this.wake.node({ nodeRunId, queue: updated.queue, dispatchSeq: updated.dispatchSeq });
    return updated;
  }

  /** Resume a WAITING node (e.g. after human review) with a payload visible as `ctx.resume`. */
  async resumeNodeRun(nodeRunId: string, payload: JsonObject, actor: Actor): Promise<NodeRunDoc> {
    const updated = await this.stores.nodeRuns.resume(nodeRunId, payload, actor);
    if (!updated) throw new InvalidStateError(`Node ${nodeRunId} is not waiting`);
    await this.stores.runs.wakeIfWaiting(updated.runId);
    await this.wake.node({ nodeRunId, queue: updated.queue, dispatchSeq: updated.dispatchSeq });
    return updated;
  }

  async resumeByCorrelationKey(correlationKey: string, payload: JsonObject, actor: Actor): Promise<number> {
    const waiting = await this.stores.nodeRuns.waitingOn(correlationKey);
    for (const w of waiting) await this.resumeNodeRun(w._id, payload, actor);
    return waiting.length;
  }

  // ======================================================================================
  // Recovery (used by the sweeper)
  // ======================================================================================

  /** Send a new wake-up for a node run whose transport job may be lost. */
  async redispatchNode(nodeRunId: string): Promise<void> {
    const nr = await this.stores.nodeRuns.bumpDispatch(nodeRunId);
    if (!nr) return;
    const now = this.clock.now().getTime();
    const delayMs = nr.nextAttemptAt ? Math.max(0, nr.nextAttemptAt.getTime() - now) : 0;
    await this.wake.node({ nodeRunId, queue: nr.queue, dispatchSeq: nr.dispatchSeq, delayMs });
  }

  // ======================================================================================
  // Subworkflows and fan-out (delegated)
  // ======================================================================================

  executeRunInline(runId: string, workerId: string, signal?: AbortSignal): Promise<WorkflowRunDoc> {
    return this.subworkflows.executeInline(runId, workerId, signal);
  }

  runSubworkflow(
    parent: SubworkflowParent,
    req: SubworkflowRequest,
    workerId: string,
    signal?: AbortSignal,
  ): Promise<SubworkflowResult> {
    return this.subworkflows.run(parent, req, workerId, signal);
  }

  pumpFanout(nodeRunId: string): Promise<number> {
    return this.fanout.pump(nodeRunId);
  }

  redispatchChunk(chunkId: string): Promise<void> {
    return this.fanout.redispatchChunk(chunkId);
  }

  processChunk(chunkId: string, workerId: string, opts: { inline?: boolean } = {}): Promise<boolean> {
    return this.fanout.processChunk(chunkId, workerId, opts);
  }

  maybeFinalizeFanout(nodeRunId: string, opts: { dispatch: boolean }): Promise<boolean> {
    return this.fanout.maybeFinalize(nodeRunId, opts);
  }
}

function snapshotOf(n: Pick<NodeRunDoc, 'state' | 'output'>): NodeSnapshot {
  return { state: n.state, branch: (n.output as { branch?: unknown } | undefined)?.branch };
}

export type { ArtifactRef };
