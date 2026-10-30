import type { Logger, MetricsRegistry } from '@aptamind/observability';
import type { Dispatcher } from './dispatcher';

/**
 * The engine's only use of the queue: best-effort wake-ups. MongoDB is committed *before* a
 * wake-up is sent, so a failed or lost wake-up (Redis down, flushed, restarted) never loses
 * or corrupts state — the node/chunk is still QUEUED (or leased) in Mongo and the sweeper
 * re-dispatches it. A dispatch failure is therefore logged and counted, never propagated
 * into run state or back to an API caller whose run has already been durably recorded.
 */
export class WakeUps {
  constructor(
    private readonly dispatcher: Dispatcher,
    private readonly logger: Logger,
    private readonly metrics: MetricsRegistry,
  ) {}

  async node(job: {
    nodeRunId: string;
    queue: string;
    dispatchSeq: number;
    delayMs?: number;
  }): Promise<boolean> {
    try {
      await this.dispatcher.dispatchNode(job);
      return true;
    } catch (err) {
      this.failed('node', err, { nodeRunId: job.nodeRunId });
      return false;
    }
  }

  async chunk(job: { chunkId: string; dispatchSeq: number }): Promise<boolean> {
    try {
      await this.dispatcher.dispatchChunk(job);
      return true;
    } catch (err) {
      this.failed('chunk', err, { fanoutChunkId: job.chunkId });
      return false;
    }
  }

  private failed(kind: string, err: unknown, ctx: Record<string, unknown>): void {
    this.metrics.inc('workflow_dispatch_failures_total', { kind });
    this.logger.warn(
      { ...ctx, err },
      'wake-up dispatch failed; state is durable in Mongo and the sweeper will re-dispatch',
    );
  }
}
