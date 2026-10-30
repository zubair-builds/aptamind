import { Queue, Worker, type Job, type JobsOptions, type Processor, type WorkerOptions } from 'bullmq';
import { Redis, type RedisOptions } from 'ioredis';

/**
 * Redis/BullMQ execution transport.
 *
 * IMPORTANT: BullMQ is transport only. Durable workflow state lives in MongoDB. Every job
 * payload is a small pointer (e.g. `{ nodeRunId }`) and every consumer must tolerate
 * duplicate, late or lost deliveries — the workflow sweeper re-dispatches from MongoDB
 * if Redis loses jobs.
 */

export interface QueueTransportOptions {
  url: string;
  prefix: string;
}

export function createRedisConnection(url: string, extra: RedisOptions = {}): Redis {
  return new Redis(url, {
    // Required by BullMQ for blocking connections.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    ...extra,
  });
}

export interface QueueCounts {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  paused: number;
  oldestWaitingAgeMs: number | null;
}

export class QueueTransport {
  private readonly connection: Redis;
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];

  constructor(private readonly opts: QueueTransportOptions) {
    this.connection = createRedisConnection(opts.url);
  }

  get redis(): Redis {
    return this.connection;
  }

  queue(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: this.connection,
        prefix: this.opts.prefix,
        defaultJobOptions: {
          // Retries are owned by the workflow runtime (state in Mongo), not by BullMQ.
          attempts: 1,
          removeOnComplete: { age: 24 * 3600, count: 10_000 },
          removeOnFail: { age: 7 * 24 * 3600, count: 50_000 },
        },
      });
      this.queues.set(name, q);
    }
    return q;
  }

  /**
   * Enqueue a job. `jobId` makes dispatch idempotent while the job still exists in Redis;
   * consumers must still claim work atomically in MongoDB.
   */
  async enqueue<T extends object>(
    queueName: string,
    jobName: string,
    data: T,
    opts: Pick<JobsOptions, 'jobId' | 'delay' | 'priority'> = {},
  ): Promise<void> {
    await this.queue(queueName).add(jobName, data, opts);
  }

  createWorker<T extends object>(
    queueName: string,
    processor: Processor<T>,
    opts: Pick<WorkerOptions, 'concurrency' | 'lockDuration' | 'stalledInterval' | 'maxStalledCount'> = {},
  ): Worker<T> {
    const connection = createRedisConnection(this.opts.url);
    const worker = new Worker<T>(queueName, processor, {
      connection,
      prefix: this.opts.prefix,
      concurrency: opts.concurrency ?? 4,
      lockDuration: opts.lockDuration ?? 60_000,
      stalledInterval: opts.stalledInterval ?? 30_000,
      maxStalledCount: opts.maxStalledCount ?? 2,
    });
    // BullMQ never closes a connection it was given, and closing a worker that is still
    // connecting rejects its pending commands ("Connection is closed") with nobody listening —
    // an unhandled rejection that is fatal to the process. Close only once ready, then release
    // the worker's own connection.
    const close = worker.close.bind(worker);
    worker.close = async (force?: boolean) => {
      await worker.waitUntilReady().catch(() => undefined);
      try {
        await close(force);
      } finally {
        connection.disconnect();
      }
    };
    this.workers.push(worker as Worker);
    return worker;
  }

  async counts(queueName: string): Promise<QueueCounts> {
    const q = this.queue(queueName);
    const c = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed', 'paused');
    const [oldest] = await q.getJobs(['waiting'], 0, 0, true);
    return {
      waiting: c.waiting ?? 0,
      active: c.active ?? 0,
      delayed: c.delayed ?? 0,
      failed: c.failed ?? 0,
      completed: c.completed ?? 0,
      paused: c.paused ?? 0,
      oldestWaitingAgeMs: oldest ? Date.now() - oldest.timestamp : null,
    };
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.connection.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.workers.map((w) => w.close()));
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
    this.connection.disconnect();
  }
}

export type { Job };
