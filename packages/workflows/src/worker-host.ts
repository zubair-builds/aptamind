import type { Worker } from 'bullmq';
import type { Logger } from '@aptamind/observability';
import { metrics } from '@aptamind/observability';
import type { QueueTransport } from '@aptamind/queue';
import { type ChunkJobData, FANOUT_QUEUE, type NodeJobData, nodeQueueName } from './dispatcher';
import type { WorkflowEngine } from './engine';
import type { Scheduler } from './scheduler';
import type { Sweeper } from './sweeper';

export interface WorkerHostOptions {
  workerId: string;
  /** Capability queues this process consumes (e.g. default, io, browser, ai). */
  queues: string[];
  concurrency: number;
  schedulerEnabled: boolean;
  schedulerIntervalMs: number;
  sweeperIntervalMs: number;
  leaseMs: number;
}

export const DEFAULT_CAPABILITY_QUEUES = ['default', 'io', 'browser', 'ai'];

/** Binds transport workers, the scheduler loop and the recovery sweeper to one engine. */
export class WorkflowWorkerHost {
  private readonly workers: Worker[] = [];
  private timers: NodeJS.Timeout[] = [];
  private busy = new Set<string>();
  private stopping = false;

  constructor(
    private readonly engine: WorkflowEngine,
    private readonly transport: QueueTransport,
    private readonly scheduler: Scheduler,
    private readonly sweeper: Sweeper,
    private readonly logger: Logger,
    private readonly opts: WorkerHostOptions,
  ) {}

  start(): void {
    for (const q of this.opts.queues) {
      const w = this.transport.createWorker<NodeJobData>(
        nodeQueueName(q),
        async (job) => {
          const state = await this.engine.executeNodeRun(job.data.nodeRunId, this.opts.workerId);
          return { state };
        },
        { concurrency: this.opts.concurrency, lockDuration: this.opts.leaseMs },
      );
      this.attach(w, q);
    }
    const fw = this.transport.createWorker<ChunkJobData>(
      FANOUT_QUEUE,
      async (job) => ({ processed: await this.engine.processChunk(job.data.chunkId, this.opts.workerId) }),
      { concurrency: this.opts.concurrency, lockDuration: this.opts.leaseMs },
    );
    this.attach(fw, 'fanout');

    if (this.opts.schedulerEnabled)
      this.loop('scheduler', this.opts.schedulerIntervalMs, () => this.scheduler.tick());
    this.loop('sweeper', this.opts.sweeperIntervalMs, () => this.sweeper.sweep());
    this.logger.info(
      { queues: this.opts.queues, workerId: this.opts.workerId },
      'workflow worker host started',
    );
  }

  private attach(w: Worker, label: string): void {
    w.on('failed', (job, err) => {
      metrics.inc('queue_job_failures_total', { queue: label });
      this.logger.error(
        { err, jobId: job?.id, queue: label },
        'transport job failed (state remains in MongoDB; sweeper will recover)',
      );
    });
    w.on('error', (err) => this.logger.error({ err, queue: label }, 'queue worker error'));
    this.workers.push(w);
  }

  private loop(name: string, intervalMs: number, fn: () => Promise<unknown>): void {
    const t = setInterval(() => {
      if (this.stopping || this.busy.has(name)) return;
      this.busy.add(name);
      fn()
        .catch((err) => this.logger.error({ err }, `${name} iteration failed`))
        .finally(() => this.busy.delete(name));
    }, intervalMs);
    this.timers.push(t);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await Promise.allSettled(this.workers.map((w) => w.close()));
    this.logger.info('workflow worker host stopped');
  }
}
