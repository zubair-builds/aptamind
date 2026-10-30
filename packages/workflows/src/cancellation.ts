import type { Actor } from '@aptamind/contracts';
import type { Logger } from '@aptamind/observability';
import type { ChunkStore } from './stores/chunk-store';
import type { NodeRunStore } from './stores/node-run-store';
import type { RunStore } from './stores/run-store';

/**
 * Run cancellation. Cancellation is cooperative and two-phase: the run becomes CANCELLING,
 * pending work (queued/retrying/waiting nodes, unstarted chunks, child runs) is cancelled
 * immediately, and running work observes the flag at its next heartbeat (ExecutionGuard).
 * The run becomes CANCELLED once nothing is executing.
 */
export class CancellationCoordinator {
  constructor(
    private readonly runs: RunStore,
    private readonly nodeRuns: NodeRunStore,
    private readonly chunks: ChunkStore,
    private readonly logger: Logger,
    /** Finalise FANNING_OUT nodes whose chunks were all cancelled. */
    private readonly finalizeFanout: (nodeRunId: string) => Promise<unknown>,
  ) {}

  async cancelRun(runId: string, actor: Actor, reason: string): Promise<void> {
    await this.runs.requestCancellation(runId, actor, reason);
    await this.nodeRuns.cancelPending(runId);
    await this.chunks.cancelPendingForRun(runId);
    for (const f of await this.nodeRuns.fanningOut(runId)) await this.finalizeFanout(f._id);
    for (const c of await this.runs.activeChildren(runId)) {
      await this.cancelRun(c._id, actor, `parent run ${runId} cancelled`);
    }
    await this.finishIfIdle(runId);
    this.logger.info({ workflowRunId: runId, actor }, 'workflow run cancellation requested');
  }

  /** A node delivered after cancellation is cancelled instead of executed. */
  async cancelNodeIfPending(nodeRunId: string, runId: string): Promise<void> {
    await this.nodeRuns.cancelIfPending(nodeRunId);
    await this.finishIfIdle(runId);
  }

  async finishIfIdle(runId: string): Promise<void> {
    if ((await this.nodeRuns.countExecuting(runId)) === 0) await this.runs.transition(runId, 'CANCELLED');
  }
}
