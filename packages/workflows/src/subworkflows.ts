import type { Clock } from '@aptamind/contracts';
import { CancelledError, type SubworkflowRequest, type SubworkflowResult } from '@aptamind/workflow-sdk';
import { sleep } from './execution-guard';
import type { NodeOutputStore } from './outputs';
import type { RunDriver, SubworkflowInvoker, SubworkflowParent } from './ports';
import { MAX_ITEM_RETRY_WAIT_MS } from './retry-policy';
import type { WorkflowRunDoc } from './schemas';
import { isTerminalRun } from './state-machine';
import type { NodeRunStore } from './stores/node-run-store';
import type { RunStore } from './stores/run-store';

const MAX_INLINE_ITERATIONS = 10_000;

/**
 * Subworkflow invocation. A child run is a normal, durable WorkflowRun linked to its parent
 * (`parent.runId`, `parent.nodeRunId`, `parent.itemIndex`, `rootRunId`, `depth`) and pinned to
 * its own immutable version; it is started idempotently (`child:<idempotencyKey>`) and executed
 * inline in the calling worker. Because its node runs are persisted, re-invoking an
 * interrupted child resumes it; re-invoking a finished child returns its recorded result.
 */
export class SubworkflowRunner implements SubworkflowInvoker {
  constructor(
    private readonly d: {
      driver: RunDriver;
      runs: RunStore;
      nodeRuns: NodeRunStore;
      outputs: NodeOutputStore;
      clock: Clock;
    },
  ) {}

  async run(
    parent: SubworkflowParent,
    req: SubworkflowRequest,
    workerId: string,
    signal?: AbortSignal,
  ): Promise<SubworkflowResult> {
    const child = await this.d.driver.startRun({
      workflowKey: req.workflowKey,
      version: req.version,
      input: req.input,
      trigger: { kind: 'subworkflow' },
      idempotencyKey: `child:${req.idempotencyKey}`,
      labels: req.labels,
      parent: { runId: parent.run._id, nodeRunId: parent.nodeRunId, itemIndex: parent.itemIndex },
      mode: 'inline',
    });
    const done = isTerminalRun(child.state) ? child : await this.executeInline(child._id, workerId, signal);
    return {
      runId: done._id,
      state: done.state as SubworkflowResult['state'],
      output: await this.d.outputs.runOutput(done),
      error: done.error ? { name: done.error.name, message: done.error.message } : undefined,
    };
  }

  /**
   * Execute a run to completion (or WAITING) in the current process, persisting every node
   * run, so an interrupted inline run resumes where it left off when invoked again.
   */
  async executeInline(runId: string, workerId: string, signal?: AbortSignal): Promise<WorkflowRunDoc> {
    const current = async () => (await this.d.runs.get(runId)) as WorkflowRunDoc;
    for (let i = 0; i < MAX_INLINE_ITERATIONS; i++) {
      if (signal?.aborted) throw signal.reason ?? new CancelledError();
      const run = await current();
      if (isTerminalRun(run.state) || run.state === 'WAITING') return run;
      await this.d.driver.advanceRun(runId, { dispatch: false });
      const runnable = await this.d.nodeRuns.runnable(runId);
      if (runnable.length === 0) {
        const after = await current();
        if (isTerminalRun(after.state) || after.state === 'WAITING') return after;
        await this.d.driver.advanceRun(runId, { dispatch: false });
        return current();
      }
      for (const nr of runnable) {
        if (nr.state === 'RETRY_SCHEDULED' && nr.nextAttemptAt) {
          const wait = Math.min(
            MAX_ITEM_RETRY_WAIT_MS,
            nr.nextAttemptAt.getTime() - this.d.clock.now().getTime(),
          );
          if (wait > 0) await sleep(wait, signal);
          await this.d.nodeRuns.makeRetryDue(nr._id);
        }
        if (nr.state === 'RUNNING') await this.d.nodeRuns.expireForeignLease(nr._id, workerId);
        await this.d.driver.executeNodeRun(nr._id, workerId, { inline: true });
      }
    }
    throw new Error(`Inline execution of ${runId} did not converge`);
  }
}
