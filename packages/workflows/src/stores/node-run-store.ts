import type { Db } from 'mongodb';
import {
  type Actor,
  type Clock,
  deterministicId,
  type JsonObject,
  type SerializedError,
} from '@aptamind/contracts';
import { getCollection, isDuplicateKeyError, validateDocument } from '@aptamind/db';
import type { WaitSpec } from '@aptamind/workflow-sdk';
import {
  type AttemptRecord,
  type FanoutState,
  type NodeRunDoc,
  nodeRunsCollection,
  type ResolvedNode,
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowRunDoc,
} from '../schemas';
import { type NodeState, nodeStatesAllowing } from '../state-machine';

export const MAX_NODE_LOGS = 200;

type Logs = NodeRunDoc['logs'];

/**
 * The lease token of one attempt. Every worker-authoritative write is fenced on the node run id,
 * its state, the lease owner AND the attempt number: a worker id alone is never sufficient, since
 * the same worker id can hold a newer attempt of the same node after its old lease expired.
 */
export interface AttemptFence {
  nodeRunId: string;
  workerId: string;
  attempt: number;
  attemptStartedAt: Date;
}

export type FinalNodeState = 'COMPLETED' | 'FAILED' | 'CANCELLED';

const PENDING_STATES: NodeState[] = ['QUEUED', 'RETRY_SCHEDULED', 'WAITING'];

/**
 * NodeRun persistence: creation keyed by (run, node), lease-based claims, attempt history and
 * lease-fenced completion. The attempt history is append-only — attempts are never removed,
 * only their status/finish time is set exactly once.
 */
export class NodeRunStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly leaseMs: number,
  ) {}

  get collection() {
    return getCollection(this.db, nodeRunsCollection);
  }

  get(id: string): Promise<NodeRunDoc | null> {
    return this.collection.findOne({ _id: id });
  }

  /** States (and branch outputs) of a run's node runs, for graph evaluation. */
  snapshots(runId: string) {
    return this.collection
      .find({ runId }, { projection: { nodeId: 1, state: 1, 'output.branch': 1, error: 1 } })
      .toArray();
  }

  findCompletedOutput(runId: string, nodeId: string) {
    return this.collection.findOne({ runId, nodeId }, { projection: { state: 1, output: 1, outputRef: 1 } });
  }

  /** Create the node run for (run, node) — idempotent; a concurrent creator's doc wins. */
  async create(
    run: WorkflowRunDoc,
    node: ResolvedNode,
    state: 'QUEUED' | 'SKIPPED',
  ): Promise<{ doc: NodeRunDoc; inserted: boolean }> {
    const now = this.clock.now();
    const doc: NodeRunDoc = {
      _id: deterministicId('nrun', run._id, node.id),
      runId: run._id,
      rootRunId: run.rootRunId,
      workflowKey: run.workflowKey,
      nodeId: node.id,
      // The exact capability type@version this node run executes (from the immutable version).
      capability: node.capability,
      state,
      queue: node.queue,
      idempotencyKey: `${run._id}:${node.id}`,
      attempt: 0,
      maxAttempts: node.retry.maxAttempts,
      manualRetries: 0,
      resumeCount: 0,
      attempts: [],
      dispatchSeq: state === 'QUEUED' ? 1 : 0,
      dispatchedAt: state === 'QUEUED' ? now : undefined,
      skipReason: state === 'SKIPPED' ? 'no active incoming edge' : undefined,
      finishedAt: state === 'SKIPPED' ? now : undefined,
      logs: [],
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.collection.insertOne(validateDocument(nodeRunsCollection, doc));
      return { doc, inserted: true };
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      const existing = await this.collection.findOne({ runId: run._id, nodeId: node.id });
      if (!existing) throw err;
      return { doc: existing, inserted: false };
    }
  }

  /**
   * Atomically claim a runnable node: QUEUED, a due retry, or RUNNING with an expired lease
   * (takeover). Returns null when someone else owns it or it is finished — which makes
   * duplicate transport deliveries harmless.
   */
  async claim(id: string, workerId: string): Promise<NodeRunDoc | null> {
    const now = this.clock.now();
    return this.collection.findOneAndUpdate(
      {
        _id: id,
        $or: [
          { state: 'QUEUED' },
          { state: 'RETRY_SCHEDULED', nextAttemptAt: { $lte: now } },
          { state: 'RUNNING', leaseExpiresAt: { $lt: now } },
        ],
      },
      {
        $set: {
          state: 'RUNNING',
          leaseOwner: workerId,
          leaseExpiresAt: new Date(now.getTime() + this.leaseMs),
          updatedAt: now,
        },
        $inc: { attempt: 1 },
        $unset: { nextAttemptAt: '' },
      },
      { returnDocument: 'after' },
    );
  }

  /**
   * Record the start of an attempt — fenced. One atomic update, applied only while this worker
   * still owns the lease for exactly the claim it made (`state: RUNNING`, `leaseOwner`,
   * `attempt`): any attempt still marked `running` (a previous owner whose lease expired) is
   * closed as `lost` and the new attempt appended. A worker that stalled after claiming and was
   * taken over gets `null` and must not execute. History is never overwritten.
   */
  async beginAttempt(claimed: NodeRunDoc, workerId: string): Promise<AttemptFence | null> {
    const now = this.clock.now();
    const attempt: AttemptRecord = { attempt: claimed.attempt, workerId, startedAt: now, status: 'running' };
    const res = await this.collection.updateOne(
      { _id: claimed._id, state: 'RUNNING', leaseOwner: workerId, attempt: claimed.attempt },
      [
        {
          $set: {
            attempts: {
              $concatArrays: [
                {
                  $map: {
                    input: '$attempts',
                    as: 'a',
                    in: {
                      $cond: [
                        { $eq: ['$$a.status', 'running'] },
                        { $mergeObjects: ['$$a', { status: 'lost', finishedAt: now }] },
                        '$$a',
                      ],
                    },
                  },
                },
                [{ $literal: attempt }],
              ],
            },
            startedAt: { $ifNull: ['$startedAt', now] },
          },
        },
      ],
    );
    if (res.matchedCount === 0) return null;
    return { nodeRunId: claimed._id, workerId, attempt: claimed.attempt, attemptStartedAt: now };
  }

  /** Whether `fence` still owns the node (used right before entering capability code). */
  async holdsLease(fence: AttemptFence): Promise<boolean> {
    const n = await this.collection.countDocuments({
      _id: fence.nodeRunId,
      state: 'RUNNING',
      leaseOwner: fence.workerId,
      attempt: fence.attempt,
      leaseExpiresAt: { $gt: this.clock.now() },
    });
    return n > 0;
  }

  /** Fence filter for one attempt of a running node. */
  private held(fence: AttemptFence) {
    return {
      _id: fence.nodeRunId,
      state: 'RUNNING' as const,
      leaseOwner: fence.workerId,
      attempt: fence.attempt,
    };
  }

  /** Extend the lease. Returns false when this attempt no longer holds it. */
  async renewLease(fence: AttemptFence): Promise<boolean> {
    const res = await this.collection.updateOne(this.held(fence), {
      $set: { leaseExpiresAt: new Date(this.clock.now().getTime() + this.leaseMs) },
    });
    return res.matchedCount > 0;
  }

  async recordInput(fence: AttemptFence, input: NodeRunDoc['input'], truncated: boolean): Promise<void> {
    await this.collection.updateOne(this.held(fence), { $set: { input, inputTruncated: truncated } });
  }

  private attemptClose(
    fence: AttemptFence,
    now: Date,
    status: AttemptRecord['status'],
    error?: SerializedError,
  ) {
    return {
      'attempts.$[a].status': status,
      'attempts.$[a].finishedAt': now,
      'attempts.$[a].durationMs': now.getTime() - fence.attemptStartedAt.getTime(),
      ...(error ? { 'attempts.$[a].error': error } : {}),
    };
  }

  /**
   * Finish the node (COMPLETED/FAILED/CANCELLED). Fenced by the lease: a worker that lost its
   * lease cannot overwrite the new owner's state — its result is discarded (returns false).
   */
  async finish(
    fence: AttemptFence,
    state: FinalNodeState,
    fields: Partial<NodeRunDoc>,
    logs: Logs = [],
    attemptStatus: AttemptRecord['status'] = state === 'COMPLETED'
      ? 'completed'
      : state === 'CANCELLED'
        ? 'cancelled'
        : 'failed',
  ): Promise<boolean> {
    const now = this.clock.now();
    const res = await this.collection.findOneAndUpdate(
      {
        _id: fence.nodeRunId,
        state: { $in: nodeStatesAllowing(state).filter((s) => s === 'RUNNING' || s === 'FANNING_OUT') },
        leaseOwner: fence.workerId,
        attempt: fence.attempt,
      },
      {
        $set: {
          ...fields,
          state,
          finishedAt: now,
          updatedAt: now,
          ...this.attemptClose(fence, now, attemptStatus, fields.error),
        },
        $unset: { leaseOwner: '', leaseExpiresAt: '' },
        $push: { logs: { $each: logs, $slice: -MAX_NODE_LOGS } },
      },
      { arrayFilters: [{ 'a.attempt': fence.attempt }], returnDocument: 'after' },
    );
    if (!res) return false;
    if (res.startedAt) {
      await this.collection.updateOne(
        { _id: fence.nodeRunId },
        { $set: { durationMs: now.getTime() - res.startedAt.getTime() } },
      );
    }
    return true;
  }

  /** Close the attempt as failed and schedule the next one. Returns the updated doc (new dispatchSeq). */
  scheduleRetry(
    fence: AttemptFence,
    error: SerializedError,
    delayMs: number,
    attemptStatus: AttemptRecord['status'],
    logs: Logs,
    opts: { acknowledgement?: boolean } = {},
  ): Promise<NodeRunDoc | null> {
    const now = this.clock.now();
    return this.collection.findOneAndUpdate(
      this.held(fence),
      {
        $set: {
          state: 'RETRY_SCHEDULED',
          error,
          nextAttemptAt: new Date(now.getTime() + delayMs),
          dispatchedAt: now,
          updatedAt: now,
          ...this.attemptClose(fence, now, attemptStatus, error),
        },
        $inc: { dispatchSeq: 1, ...(opts.acknowledgement ? { ackRetries: 1 } : {}) },
        $unset: { leaseOwner: '', leaseExpiresAt: '' },
        $push: { logs: { $each: logs, $slice: -MAX_NODE_LOGS } },
      },
      { arrayFilters: [{ 'a.attempt': fence.attempt }], returnDocument: 'after' },
    );
  }

  async suspend(fence: AttemptFence, wait: WaitSpec, logs: Logs): Promise<boolean> {
    const now = this.clock.now();
    const res = await this.collection.updateOne(
      this.held(fence),
      {
        $set: {
          state: 'WAITING',
          wait: { ...wait, since: now },
          updatedAt: now,
          ...this.attemptClose(fence, now, 'suspended'),
        },
        $unset: { leaseOwner: '', leaseExpiresAt: '', resumePayload: '' },
        $push: { logs: { $each: logs, $slice: -MAX_NODE_LOGS } },
      },
      { arrayFilters: [{ 'a.attempt': fence.attempt }] },
    );
    return res.matchedCount > 0;
  }

  /** The coordinator attempt of a fan-out node ends; the node stays FANNING_OUT until finalised. */
  async enterFanout(fence: AttemptFence, fanout: FanoutState): Promise<boolean> {
    const now = this.clock.now();
    const res = await this.collection.updateOne(
      this.held(fence),
      {
        $set: { state: 'FANNING_OUT', fanout, updatedAt: now, ...this.attemptClose(fence, now, 'completed') },
        $unset: { leaseOwner: '', leaseExpiresAt: '' },
      },
      { arrayFilters: [{ 'a.attempt': fence.attempt }] },
    );
    return res.matchedCount > 0;
  }

  /** Finalise a fan-out node (not lease-fenced: guarded by FANNING_OUT, which only one caller can leave). */
  async finishFanout(id: string, state: FinalNodeState, fields: Partial<NodeRunDoc>): Promise<boolean> {
    const now = this.clock.now();
    const res = await this.collection.updateOne(
      { _id: id, state: 'FANNING_OUT' },
      { $set: { ...fields, state, finishedAt: now, updatedAt: now } },
    );
    return res.modifiedCount > 0;
  }

  // ---- fan-out concurrency slots ---------------------------------------------------------

  /** Atomically take one of the fan-out's `concurrency` slots. */
  async claimFanoutSlot(id: string): Promise<boolean> {
    const res = await this.collection.updateOne(
      { _id: id, state: 'FANNING_OUT', $expr: { $lt: ['$fanout.inFlight', '$fanout.concurrency'] } },
      { $inc: { 'fanout.inFlight': 1 }, $set: { 'fanout.lastPumpAt': this.clock.now() } },
    );
    return res.modifiedCount > 0;
  }

  async releaseFanoutSlot(id: string): Promise<void> {
    await this.collection.updateOne({ _id: id }, { $inc: { 'fanout.inFlight': -1 } });
  }

  // ---- cancellation ----------------------------------------------------------------------

  async cancelPending(runId: string): Promise<void> {
    const now = this.clock.now();
    await this.collection.updateMany(
      { runId, state: { $in: PENDING_STATES } },
      { $set: { state: 'CANCELLED', finishedAt: now, updatedAt: now } },
    );
  }

  async cancelIfPending(id: string): Promise<void> {
    const now = this.clock.now();
    await this.collection.updateOne(
      { _id: id, state: { $in: PENDING_STATES } },
      { $set: { state: 'CANCELLED', finishedAt: now, updatedAt: now } },
    );
  }

  countExecuting(runId: string): Promise<number> {
    return this.collection.countDocuments({ runId, state: { $in: ['RUNNING', 'FANNING_OUT'] } });
  }

  fanningOut(runId: string) {
    return this.collection.find({ runId, state: 'FANNING_OUT' }).toArray();
  }

  // ---- operator actions / recovery ---------------------------------------------------------

  /** Operator retry: FAILED → QUEUED with one more life of attempts; history is kept. */
  requeueFailed(id: string, actor: Actor): Promise<NodeRunDoc | null> {
    const now = this.clock.now();
    return this.collection.findOneAndUpdate(
      { _id: id, state: 'FAILED' },
      {
        $set: { state: 'QUEUED', dispatchedAt: now, updatedAt: now },
        $inc: { manualRetries: 1, dispatchSeq: 1 },
        $unset: { finishedAt: '', fanout: '' },
        $push: {
          logs: {
            at: now,
            level: 'info' as const,
            msg: `manual retry requested by ${actor.kind}:${actor.id}`,
          },
        },
      },
      { returnDocument: 'after' },
    );
  }

  /** WAITING → QUEUED with a resume payload. Resuming is not a retry: it adds one attempt. */
  resume(id: string, payload: JsonObject, actor: Actor): Promise<NodeRunDoc | null> {
    const now = this.clock.now();
    return this.collection.findOneAndUpdate(
      { _id: id, state: 'WAITING' },
      {
        $set: { state: 'QUEUED', resumePayload: payload, dispatchedAt: now, updatedAt: now },
        $inc: { dispatchSeq: 1, resumeCount: 1 },
        $unset: { wait: '' },
        $push: { logs: { at: now, level: 'info' as const, msg: `resumed by ${actor.kind}:${actor.id}` } },
      },
      { returnDocument: 'after' },
    );
  }

  waitingOn(correlationKey: string) {
    return this.collection.find({ state: 'WAITING', 'wait.correlationKey': correlationKey }).toArray();
  }

  /** New transport sequence number for a node that must be (re-)dispatched. */
  bumpDispatch(id: string): Promise<NodeRunDoc | null> {
    return this.collection.findOneAndUpdate(
      { _id: id, state: { $in: ['QUEUED', 'RUNNING', 'RETRY_SCHEDULED'] } },
      { $inc: { dispatchSeq: 1 }, $set: { dispatchedAt: this.clock.now() } },
      { returnDocument: 'after' },
    );
  }

  /** Runnable node runs of a run, oldest first (inline execution). */
  runnable(runId: string) {
    return this.collection
      .find({ runId, state: { $in: ['QUEUED', 'RETRY_SCHEDULED', 'RUNNING'] } })
      .sort({ createdAt: 1 })
      .toArray();
  }

  /** Inline execution does not wait for transport delays: make a scheduled retry due now. */
  async makeRetryDue(id: string): Promise<void> {
    await this.collection.updateOne(
      { _id: id, state: 'RETRY_SCHEDULED' },
      { $set: { nextAttemptAt: this.clock.now() } },
    );
  }

  /** Resuming an interrupted inline run: expire a stale lease held by another (dead) worker id. */
  async expireForeignLease(id: string, workerId: string): Promise<void> {
    await this.collection.updateOne(
      { _id: id, state: 'RUNNING', leaseOwner: { $ne: workerId } },
      { $set: { leaseExpiresAt: new Date(0) } },
    );
  }
}
