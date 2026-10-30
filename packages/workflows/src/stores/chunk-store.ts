import type { Db, Filter } from 'mongodb';
import type { Clock, JsonValue } from '@aptamind/contracts';
import { getCollection, isDuplicateKeyError, validateDocument, withTransaction } from '@aptamind/db';
import { type FanoutChunkDoc, fanoutChunksCollection, type ItemResult, nodeRunsCollection } from '../schemas';

/**
 * The lease token of one chunk claim. Every worker-authoritative chunk write is fenced on the
 * chunk id, `RUNNING`, the lease owner AND the claim generation (`attempt`): the same worker id
 * can hold a newer claim of the same chunk after its old lease expired.
 */
export interface ChunkLease {
  chunkId: string;
  workerId: string;
  attempt: number;
}

export interface ChunkCompletion {
  lease: ChunkLease;
  nodeRunId: string;
  state: 'COMPLETED' | 'CANCELLED';
  succeeded: number;
  failed: number;
  /** Queued (non-inline) chunks hold a concurrency slot that is released with completion. */
  releaseSlot: boolean;
}

export interface FanoutAggregate {
  succeeded: number;
  failed: number;
  cancelledChunks: number;
}

const OPEN_STATES: FanoutChunkDoc['state'][] = ['PENDING', 'QUEUED', 'RUNNING'];

/**
 * Fan-out chunk persistence. Chunks are created once (deterministic ids), claimed with a lease
 * like node runs, and their completion is committed in the same transaction as the parent's
 * counters and concurrency-slot release.
 */
export class ChunkStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly leaseMs: number,
  ) {}

  get collection() {
    return getCollection(this.db, fanoutChunksCollection);
  }

  get(id: string): Promise<FanoutChunkDoc | null> {
    return this.collection.findOne({ _id: id });
  }

  /** Insert chunks, ignoring ones that already exist (a retried coordinator recreates the same ids). */
  async insertIdempotent(batch: FanoutChunkDoc[]): Promise<void> {
    if (!batch.length) return;
    try {
      await this.collection.insertMany(
        batch.map((c) => validateDocument(fanoutChunksCollection, c)),
        { ordered: false },
      );
    } catch (err) {
      const writeErrors = (err as { writeErrors?: Array<{ code?: number }> }).writeErrors;
      const all = Array.isArray(writeErrors) ? writeErrors : [];
      if (!isDuplicateKeyError(err) && !(all.length && all.every((e) => e.code === 11000))) throw err;
    }
  }

  /** Move the next PENDING chunk to QUEUED (the caller already holds a concurrency slot). */
  queueNext(nodeRunId: string): Promise<FanoutChunkDoc | null> {
    const now = this.clock.now();
    return this.collection.findOneAndUpdate(
      { nodeRunId, state: 'PENDING' },
      { $set: { state: 'QUEUED', dispatchedAt: now, updatedAt: now }, $inc: { dispatchSeq: 1 } },
      { sort: { index: 1 }, returnDocument: 'after' },
    );
  }

  bumpDispatch(id: string): Promise<FanoutChunkDoc | null> {
    return this.collection.findOneAndUpdate(
      { _id: id, state: { $in: ['QUEUED', 'RUNNING'] } },
      { $inc: { dispatchSeq: 1 }, $set: { dispatchedAt: this.clock.now() } },
      { returnDocument: 'after' },
    );
  }

  /** Claim a queued chunk, or take over one whose lease expired. Inline runs may claim PENDING chunks. */
  async claim(id: string, workerId: string, inline: boolean): Promise<FanoutChunkDoc | null> {
    const now = this.clock.now();
    const filter: Filter<FanoutChunkDoc> = {
      _id: id,
      $or: [
        { state: 'QUEUED' },
        { state: 'RUNNING', leaseExpiresAt: { $lt: now } },
        ...(inline ? [{ state: 'PENDING' as const }] : []),
      ],
    };
    const chunk = await this.collection.findOneAndUpdate(
      filter,
      {
        $set: {
          state: 'RUNNING',
          leaseOwner: workerId,
          leaseExpiresAt: new Date(now.getTime() + this.leaseMs),
          updatedAt: now,
        },
        $inc: { attempt: 1 },
      },
      { returnDocument: 'after' },
    );
    if (chunk && !chunk.startedAt) await this.collection.updateOne({ _id: id }, { $set: { startedAt: now } });
    return chunk;
  }

  /** Fence filter for one claim generation of a running chunk. */
  private held(lease: ChunkLease): Filter<FanoutChunkDoc> {
    return { _id: lease.chunkId, state: 'RUNNING', leaseOwner: lease.workerId, attempt: lease.attempt };
  }

  /** Whether this claim still owns the chunk (checked before each item runs). */
  async holdsLease(lease: ChunkLease): Promise<boolean> {
    const n = await this.collection.countDocuments({
      ...this.held(lease),
      leaseExpiresAt: { $gt: this.clock.now() },
    });
    return n > 0;
  }

  /** Cancel a chunk this claim holds (fenced: never overwrites another claim's result). */
  async markCancelled(lease: ChunkLease): Promise<void> {
    const now = this.clock.now();
    await this.collection.updateOne(this.held(lease), {
      $set: { state: 'CANCELLED', finishedAt: now, updatedAt: now },
      $unset: { leaseOwner: '', leaseExpiresAt: '' },
    });
  }

  async renewLease(lease: ChunkLease): Promise<boolean> {
    const res = await this.collection.updateOne(this.held(lease), {
      $set: { leaseExpiresAt: new Date(this.clock.now().getTime() + this.leaseMs) },
    });
    return res.matchedCount > 0;
  }

  /** Durably record item results (lease-fenced) so a takeover skips items already done. */
  async appendResults(lease: ChunkLease, results: ItemResult[]): Promise<boolean> {
    if (!results.length) return true;
    const now = this.clock.now();
    const res = await this.collection.updateOne(this.held(lease), {
      $push: { results: { $each: results } },
      $set: { leaseExpiresAt: new Date(now.getTime() + this.leaseMs), updatedAt: now },
    });
    return res.matchedCount > 0;
  }

  /** Complete a chunk and move the parent's counters in one transaction (crash-safe accounting). */
  commitCompletion(c: ChunkCompletion): Promise<boolean> {
    const nodeRuns = getCollection(this.db, nodeRunsCollection);
    const now = this.clock.now();
    return withTransaction(this.db.client, async (session) => {
      const res = await this.collection.updateOne(
        this.held(c.lease),
        {
          $set: { state: c.state, finishedAt: now, updatedAt: now },
          $unset: { leaseOwner: '', leaseExpiresAt: '' },
        },
        { session },
      );
      if (res.modifiedCount === 0) return false;
      await nodeRuns.updateOne(
        { _id: c.nodeRunId },
        {
          $inc: {
            'fanout.completedChunks': 1,
            'fanout.succeededItems': c.succeeded,
            'fanout.failedItems': c.failed,
            ...(c.releaseSlot ? { 'fanout.inFlight': -1 } : {}),
          },
          $set: { updatedAt: now },
        },
        { session },
      );
      return true;
    });
  }

  async cancelPendingForRun(runId: string): Promise<void> {
    const now = this.clock.now();
    await this.collection.updateMany(
      { runId, state: { $in: ['PENDING', 'QUEUED'] } },
      { $set: { state: 'CANCELLED', finishedAt: now, updatedAt: now } },
    );
  }

  async cancelPendingForNode(nodeRunId: string): Promise<void> {
    const now = this.clock.now();
    await this.collection.updateMany(
      { nodeRunId, state: { $in: ['PENDING', 'QUEUED'] } },
      { $set: { state: 'CANCELLED', finishedAt: now, updatedAt: now } },
    );
  }

  /** Operator retry of a fan-out: completed chunks keep their results; the rest are rebuilt. */
  async deleteUnfinished(nodeRunId: string): Promise<void> {
    await this.collection.deleteMany({ nodeRunId, state: { $ne: 'COMPLETED' } });
  }

  countOpen(nodeRunId: string): Promise<number> {
    return this.collection.countDocuments({ nodeRunId, state: { $in: OPEN_STATES } });
  }

  idsInOrder(nodeRunId: string): Promise<string[]> {
    return this.collection
      .find({ nodeRunId }, { projection: { _id: 1 } })
      .sort({ index: 1 })
      .map((c) => String(c._id))
      .toArray();
  }

  /** Aggregate item outcomes from chunk results (the source of truth, not the counters). */
  async aggregate(nodeRunId: string): Promise<FanoutAggregate> {
    const countStatus = (status: string) => ({
      $sum: { $size: { $filter: { input: '$results', cond: { $eq: ['$$this.status', status] } } } },
    });
    const agg = await this.collection
      .aggregate<FanoutAggregate>([
        { $match: { nodeRunId } },
        {
          $group: {
            _id: null,
            succeeded: countStatus('succeeded'),
            failed: countStatus('failed'),
            cancelledChunks: { $sum: { $cond: [{ $eq: ['$state', 'CANCELLED'] }, 1, 0] } },
          },
        },
      ])
      .next();
    return {
      succeeded: agg?.succeeded ?? 0,
      failed: agg?.failed ?? 0,
      cancelledChunks: agg?.cancelledChunks ?? 0,
    };
  }

  sampleFailures(nodeRunId: string, limit = 20) {
    return this.collection
      .aggregate<{ index: number; message: string }>([
        { $match: { nodeRunId } },
        { $unwind: '$results' },
        { $match: { 'results.status': 'failed' } },
        { $sort: { 'results.index': 1 } },
        { $limit: limit },
        {
          $project: {
            _id: 0,
            index: '$results.index',
            message: { $ifNull: ['$results.error.message', 'failed'] },
          },
        },
      ])
      .toArray();
  }

  async collectOutputs(nodeRunId: string, total: number): Promise<Array<JsonValue | null>> {
    const rows = await this.collection
      .aggregate<{ index: number; output: JsonValue | null }>([
        { $match: { nodeRunId } },
        { $unwind: '$results' },
        { $sort: { 'results.index': 1 } },
        { $project: { _id: 0, index: '$results.index', output: { $ifNull: ['$results.output', null] } } },
      ])
      .toArray();
    const outputs: Array<JsonValue | null> = new Array(total).fill(null);
    for (const r of rows) outputs[r.index] = r.output;
    return outputs;
  }
}
