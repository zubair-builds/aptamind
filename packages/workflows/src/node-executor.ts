import { type Clock, serializeError } from '@aptamind/contracts';
import { type Logger, type MetricsRegistry, withCorrelation } from '@aptamind/observability';
import { allowsReexecution, type AnyCapability, capabilityKey, isSuspend } from '@aptamind/workflow-sdk';
import type { CancellationCoordinator } from './cancellation';
import type { WorkflowCatalog } from './catalog';
import { buildCapabilityContext, type CapabilityEnvironment, correlationLabels } from './context';
import { forEachConfigSchema } from './control';
import {
  AcknowledgementError,
  AttemptsExhaustedError,
  DefinitionError,
  UnsafeReexecutionError,
} from './errors';
import { ExecutionGuard, type HeartbeatResult } from './execution-guard';
import type { FanoutCoordinator } from './fanout';
import type { NodeOutputStore } from './outputs';
import type { RunDriver } from './ports';
import { resolveTemplate, type RefScope } from './refs';
import { type CapabilityRegistry, validateWith } from './registry';
import { type AttemptBudget, allowedAttempts, decideOnFailure } from './retry-policy';
import type { NodeRunDoc, ResolvedNode, WorkflowRunDoc, WorkflowVersionDoc } from './schemas';
import type { NodeState } from './state-machine';
import type { AttemptFence, NodeRunStore } from './stores/node-run-store';
import type { RunStore } from './stores/run-store';
import type { WakeUps } from './transport';

export interface NodeExecutorDeps {
  runs: RunStore;
  nodeRuns: NodeRunStore;
  catalog: WorkflowCatalog;
  registry: CapabilityRegistry;
  outputs: NodeOutputStore;
  wake: WakeUps;
  cancellation: CancellationCoordinator;
  fanout: FanoutCoordinator;
  driver: RunDriver;
  env: CapabilityEnvironment;
  clock: Clock;
  logger: Logger;
  metrics: MetricsRegistry;
  leaseMs: number;
}

interface Attempt {
  nodeRun: NodeRunDoc;
  run: WorkflowRunDoc;
  fence: AttemptFence;
  inline: boolean;
}

/**
 * Executes one node attempt: claim → resolve capability → validate/resolve input → execute
 * under an ExecutionGuard (timeout, heartbeat, cancellation) → persist the outcome through
 * the lease-fenced NodeRunStore → ask the RunDriver to advance the graph. Failure handling
 * is delegated to the retry policy; fan-out nodes are handed to the FanoutCoordinator.
 */
export class NodeExecutor {
  constructor(private readonly d: NodeExecutorDeps) {}

  /**
   * Claim and execute a node run. Returns the resulting node state, or `null` when the node
   * could not be claimed (already running elsewhere, finished, or cancelled) — duplicate
   * transport deliveries are therefore harmless.
   */
  async execute(
    nodeRunId: string,
    workerId: string,
    opts: { inline?: boolean } = {},
  ): Promise<NodeState | null> {
    const inline = !!opts.inline;
    const pre = await this.d.nodeRuns.get(nodeRunId);
    if (!pre) return null;
    const run = await this.d.runs.get(pre.runId);
    if (!run) return null;
    if (run.state === 'CANCELLING' || run.state === 'CANCELLED') {
      await this.d.cancellation.cancelNodeIfPending(nodeRunId, run._id);
      return 'CANCELLED';
    }
    if (run.state === 'COMPLETED' || run.state === 'FAILED') return null;

    const claimed = await this.d.nodeRuns.claim(nodeRunId, workerId);
    if (!claimed) return null;
    // Any attempt still marked running belongs to a worker whose lease expired.
    const takeover = claimed.attempts.some((a) => a.status === 'running');
    // Fenced: if this worker stalled after claiming and was taken over, it stops here.
    const fence = await this.d.nodeRuns.beginAttempt(claimed, workerId);
    if (!fence) {
      this.d.logger.warn({ nodeRunId, workerId }, 'stale claim: lease taken over before the attempt began');
      return null;
    }
    if (takeover) {
      this.d.metrics.inc('workflow_node_lease_takeovers_total', {
        capability: capabilityKey(claimed.capability),
      });
    }
    const attempt: Attempt = { nodeRun: claimed, run, fence, inline };

    const budget = budgetOf(claimed);
    if (fence.attempt > allowedAttempts(budget)) {
      return this.failWithoutExecuting(attempt, new AttemptsExhaustedError(allowedAttempts(budget)));
    }
    // A `no_retry` capability whose previous attempt was interrupted is never re-run.
    if (takeover && this.d.registry.has(claimed.capability)) {
      const def = this.d.registry.get(claimed.capability);
      if (!allowsReexecution(def.execution)) {
        return this.failWithoutExecuting(attempt, new UnsafeReexecutionError(capabilityKey(def)));
      }
    }
    return withCorrelation(
      { workflowRunId: run._id, nodeRunId, workflowKey: run.workflowKey, ...correlationLabels(run.labels) },
      () => this.runAttempt(attempt),
    );
  }

  private async runAttempt(a: Attempt): Promise<NodeState> {
    const { nodeRun, run, fence } = a;
    const version = await this.d.catalog.getVersionById(run.versionId);
    let node: ResolvedNode;
    let def: AnyCapability;
    try {
      ({ node, def } = this.resolveCapability(version, nodeRun));
    } catch (err) {
      return this.failWithoutExecuting(a, err);
    }
    const capName = capabilityKey(node.capability);
    const started = Date.now();
    const logBuffer: NodeRunDoc['logs'] = [];
    const guard = new ExecutionGuard({
      timeoutMs: node.timeoutMs,
      heartbeatEveryMs: Math.floor(this.d.leaseMs / 3),
      heartbeat: () => this.heartbeat(fence, run._id),
    });

    try {
      const config = validateWith(def.configSchema, node.config ?? {}, 'config', capName);
      const outputCache = new Map<string, unknown>();
      const scope: RefScope = {
        run: { input: run.input, labels: run.labels },
        trigger: run.trigger,
        nodeOutput: (nodeId) => this.d.outputs.load(run._id, nodeId, outputCache),
      };
      const input = validateWith(
        def.inputSchema,
        await resolveTemplate(node.input ?? {}, scope),
        'input',
        capName,
      );
      await this.d.outputs.recordInput(fence, input);

      if (def.execution.mode === 'fanout') {
        // The coordinator attempt only partitions work; chunks carry their own leases.
        guard.stopTimeout();
        return await this.d.fanout.start({
          nodeRun,
          run,
          fence,
          config: forEachConfigSchema.parse(config),
          input: input as { items: unknown },
          inline: a.inline,
        });
      }

      const ctx = buildCapabilityContext({
        env: this.d.env,
        run,
        nodeRun,
        attempt: fence.attempt,
        idempotencyKey: nodeRun.idempotencyKey,
        signal: guard.signal,
        clock: this.d.clock,
        logger: this.d.logger,
        logBuffer,
        heartbeat: () => guard.beat(),
        resume: nodeRun.resumePayload,
      });
      // Last fence before capability code runs: never execute on a lease already lost.
      if (!(await this.d.nodeRuns.holdsLease(fence))) {
        this.d.logger.warn({ nodeRunId: nodeRun._id }, 'lease lost before execution; not executing');
        return 'RUNNING';
      }
      const result = await guard.run(def.execute(ctx, input, config));

      if (isSuspend(result)) {
        await this.d.nodeRuns.suspend(fence, result.wait, logBuffer);
        await this.advance(a);
        return 'WAITING';
      }
      const output = validateWith(def.outputSchema, result, 'output', capName);
      let committed: boolean;
      try {
        const stored = await this.d.outputs.store(run, nodeRun._id, output);
        committed = await this.d.nodeRuns.finish(fence, 'COMPLETED', stored, logBuffer);
      } catch (err) {
        throw new AcknowledgementError(err);
      }
      this.d.metrics.observe('workflow_node_duration_ms', Date.now() - started, {
        capability: capName,
        status: 'completed',
      });
      if (!committed) {
        this.d.logger.warn({ nodeRunId: nodeRun._id }, 'node result discarded: lease no longer held');
        return 'RUNNING';
      }
      this.d.metrics.inc('workflow_node_runs_total', { capability: capName, status: 'completed' });
      await this.advance(a);
      return 'COMPLETED';
    } catch (rawErr) {
      this.d.metrics.observe('workflow_node_duration_ms', Date.now() - started, {
        capability: capName,
        status: 'failed',
      });
      return this.handleFailure(a, node, def, guard, guard.failureOf(rawErr), logBuffer);
    } finally {
      guard.dispose();
    }
  }

  private async handleFailure(
    a: Attempt,
    node: ResolvedNode,
    def: AnyCapability,
    guard: ExecutionGuard,
    err: unknown,
    logBuffer: NodeRunDoc['logs'],
  ): Promise<NodeState> {
    const { nodeRun, fence } = a;
    const capName = capabilityKey(node.capability);
    const serialized = serializeError(err);
    const decision = decideOnFailure({
      error: err,
      timedOut: guard.timedOut,
      cancelled: guard.cancelled,
      leaseLost: guard.leaseLost,
      capabilityRetryable: def.execution.retryable,
      reexecutionAllowed: allowsReexecution(def.execution),
      acknowledgementFailure: err instanceof AcknowledgementError,
      attemptNo: fence.attempt,
      budget: budgetOf(nodeRun),
      policy: node.retry,
    });
    switch (decision.kind) {
      case 'cancelled':
        await this.d.nodeRuns.finish(fence, 'CANCELLED', { error: serialized }, logBuffer, 'cancelled');
        await this.d.cancellation.finishIfIdle(a.run._id);
        return 'CANCELLED';
      case 'lease_lost':
        // Another worker owns the node now; it records the outcome.
        return 'RUNNING';
      case 'retry': {
        const scheduled = await this.d.nodeRuns.scheduleRetry(
          fence,
          serialized,
          decision.delayMs,
          decision.attemptStatus,
          logBuffer,
          { acknowledgement: decision.acknowledgement },
        );
        this.d.metrics.inc('workflow_node_retries_total', { capability: capName });
        if (scheduled && !a.inline) {
          await this.d.wake.node({
            nodeRunId: nodeRun._id,
            queue: nodeRun.queue,
            dispatchSeq: scheduled.dispatchSeq,
            delayMs: decision.delayMs,
          });
        }
        return 'RETRY_SCHEDULED';
      }
      case 'fail':
        this.d.metrics.inc('workflow_node_runs_total', { capability: capName, status: 'failed' });
        this.d.logger.warn(
          { err: serialized, capability: capName, attempt: fence.attempt },
          'node failed permanently',
        );
        await this.d.nodeRuns.finish(
          fence,
          'FAILED',
          { error: serialized },
          logBuffer,
          decision.attemptStatus,
        );
        await this.advance(a);
        return 'FAILED';
    }
  }

  /** Capability lookup: the node must exist in the pinned version and its exact type@version be registered. */
  private resolveCapability(
    version: WorkflowVersionDoc,
    nodeRun: NodeRunDoc,
  ): { node: ResolvedNode; def: AnyCapability } {
    const node = version.nodes.find((n) => n.id === nodeRun.nodeId);
    if (!node) throw new DefinitionError(`Node ${nodeRun.nodeId} missing from ${version._id}`);
    if (!this.d.registry.has(node.capability)) {
      // A worker without this capability version registered fails visibly rather than silently.
      throw new DefinitionError(
        `Capability ${capabilityKey(node.capability)} is not registered in this worker`,
      );
    }
    return { node, def: this.d.registry.get(node.capability) };
  }

  private async failWithoutExecuting(a: Attempt, err: unknown): Promise<NodeState> {
    await this.d.nodeRuns.finish(a.fence, 'FAILED', { error: serializeError(err) });
    await this.advance(a);
    return 'FAILED';
  }

  private async heartbeat(fence: AttemptFence, runId: string): Promise<HeartbeatResult> {
    const held = await this.d.nodeRuns.renewLease(fence);
    if (await this.d.runs.isCancelling(runId)) return 'cancelled';
    return held ? 'ok' : 'lease_lost';
  }

  private advance(a: Attempt): Promise<string[]> {
    return this.d.driver.advanceRun(a.run._id, { dispatch: !a.inline });
  }
}

export function budgetOf(
  nr: Pick<NodeRunDoc, 'maxAttempts' | 'manualRetries' | 'resumeCount' | 'ackRetries'>,
): AttemptBudget {
  return {
    maxAttempts: nr.maxAttempts,
    manualRetries: nr.manualRetries,
    resumeCount: nr.resumeCount ?? 0,
    ackRetries: nr.ackRetries ?? 0,
  };
}
