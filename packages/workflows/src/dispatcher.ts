import type { QueueTransport } from '@aptamind/queue';

/**
 * Transport abstraction between the engine and the queue. Payloads are pointers only;
 * all state is in MongoDB.
 */
export interface Dispatcher {
  dispatchNode(job: {
    nodeRunId: string;
    queue: string;
    dispatchSeq: number;
    delayMs?: number;
  }): Promise<void>;
  dispatchChunk(job: { chunkId: string; dispatchSeq: number }): Promise<void>;
  /** Whether a transport job for this dispatch is still waiting/delayed/active. */
  isNodeJobPending(job: { nodeRunId: string; queue: string; dispatchSeq: number }): Promise<boolean>;
  isChunkJobPending(job: { chunkId: string; dispatchSeq: number }): Promise<boolean>;
}

export const NODE_QUEUE_PREFIX = 'wf-node-';
export const FANOUT_QUEUE = 'wf-fanout';

export function nodeQueueName(capabilityQueue: string): string {
  return `${NODE_QUEUE_PREFIX}${capabilityQueue}`;
}

export interface NodeJobData {
  nodeRunId: string;
}
export interface ChunkJobData {
  chunkId: string;
}

function jobId(id: string, seq: number): string {
  // BullMQ custom ids must not contain ':'
  return `${id}__${seq}`;
}

export class BullMqDispatcher implements Dispatcher {
  constructor(private readonly transport: QueueTransport) {}

  async dispatchNode(job: {
    nodeRunId: string;
    queue: string;
    dispatchSeq: number;
    delayMs?: number;
  }): Promise<void> {
    await this.transport.enqueue<NodeJobData>(
      nodeQueueName(job.queue),
      'node',
      { nodeRunId: job.nodeRunId },
      {
        jobId: jobId(job.nodeRunId, job.dispatchSeq),
        delay: job.delayMs && job.delayMs > 0 ? job.delayMs : undefined,
      },
    );
  }

  async dispatchChunk(job: { chunkId: string; dispatchSeq: number }): Promise<void> {
    await this.transport.enqueue<ChunkJobData>(
      FANOUT_QUEUE,
      'chunk',
      { chunkId: job.chunkId },
      { jobId: jobId(job.chunkId, job.dispatchSeq) },
    );
  }

  private async pending(queue: string, id: string): Promise<boolean> {
    const j = await this.transport.queue(queue).getJob(id);
    if (!j) return false;
    const state = await j.getState();
    return (
      state === 'waiting' ||
      state === 'delayed' ||
      state === 'active' ||
      state === 'prioritized' ||
      state === 'waiting-children'
    );
  }

  isNodeJobPending(job: { nodeRunId: string; queue: string; dispatchSeq: number }): Promise<boolean> {
    return this.pending(nodeQueueName(job.queue), jobId(job.nodeRunId, job.dispatchSeq));
  }

  isChunkJobPending(job: { chunkId: string; dispatchSeq: number }): Promise<boolean> {
    return this.pending(FANOUT_QUEUE, jobId(job.chunkId, job.dispatchSeq));
  }
}

/** Dispatcher that records dispatches in memory — used by unit tests and inline execution. */
export class RecordingDispatcher implements Dispatcher {
  readonly nodes: Array<{ nodeRunId: string; queue: string; dispatchSeq: number; delayMs?: number }> = [];
  readonly chunks: Array<{ chunkId: string; dispatchSeq: number }> = [];
  async dispatchNode(job: { nodeRunId: string; queue: string; dispatchSeq: number; delayMs?: number }) {
    this.nodes.push(job);
  }
  async dispatchChunk(job: { chunkId: string; dispatchSeq: number }) {
    this.chunks.push(job);
  }
  async isNodeJobPending() {
    return false;
  }
  async isChunkJobPending() {
    return false;
  }
}
