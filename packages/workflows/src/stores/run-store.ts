import type { Db, Filter } from 'mongodb';
import type { Actor, Clock, SerializedError } from '@aptamind/contracts';
import { getCollection, isDuplicateKeyError, validateDocument } from '@aptamind/db';
import type { MetricsRegistry } from '@aptamind/observability';
import { type WorkflowRunDoc, workflowRunsCollection } from '../schemas';
import { isTerminalRun, type RunState, runStatesAllowing } from '../state-machine';

const TERMINAL: RunState[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

/**
 * WorkflowRun persistence. Every state change is a compare-and-set guarded by the states the
 * state machine allows as "from" (`runStatesAllowing`), so concurrent coordinators cannot
 * move a run backwards or out of a terminal state.
 */
export class RunStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly metrics: MetricsRegistry,
  ) {}

  get collection() {
    return getCollection(this.db, workflowRunsCollection);
  }

  get(runId: string): Promise<WorkflowRunDoc | null> {
    return this.collection.findOne({ _id: runId });
  }

  findByIdempotencyKey(key: string): Promise<WorkflowRunDoc | null> {
    return this.collection.findOne({ idempotencyKey: key });
  }

  /** Insert a new run; a lost race on `idempotencyKey` returns the winner instead. */
  async insert(run: WorkflowRunDoc): Promise<{ run: WorkflowRunDoc; inserted: boolean }> {
    try {
      await this.collection.insertOne(validateDocument(workflowRunsCollection, run));
      return { run, inserted: true };
    } catch (err) {
      if (isDuplicateKeyError(err) && run.idempotencyKey) {
        const existing = await this.findByIdempotencyKey(run.idempotencyKey);
        if (existing) return { run: existing, inserted: false };
      }
      throw err;
    }
  }

  async isCancelling(runId: string): Promise<boolean> {
    const r = await this.collection.findOne({ _id: runId }, { projection: { state: 1 } });
    return !!r && (r.state === 'CANCELLING' || r.state === 'CANCELLED');
  }

  /** Guarded transition; terminal transitions also stamp `finishedAt`/`durationMs` and metrics. */
  async transition(runId: string, to: RunState, set: Partial<WorkflowRunDoc> = {}): Promise<boolean> {
    const now = this.clock.now();
    const terminal = TERMINAL.includes(to);
    const res = await this.collection.findOneAndUpdate(
      { _id: runId, state: { $in: runStatesAllowing(to) } },
      { $set: { ...set, ...(terminal ? { finishedAt: now } : {}), state: to, updatedAt: now } },
      { returnDocument: 'after' },
    );
    if (res && terminal && res.finishedAt && res.startedAt) {
      const durationMs = res.finishedAt.getTime() - res.startedAt.getTime();
      await this.collection.updateOne({ _id: runId }, { $set: { durationMs } });
      this.metrics.inc('workflow_runs_finished_total', { workflow: res.workflowKey, state: to });
      this.metrics.observe('workflow_run_duration_ms', durationMs, { workflow: res.workflowKey });
    }
    return !!res;
  }

  async requestCancellation(runId: string, actor: Actor, reason: string): Promise<void> {
    const now = this.clock.now();
    await this.collection.updateOne(
      { _id: runId, state: { $in: runStatesAllowing('CANCELLING') } },
      {
        $set: {
          state: 'CANCELLING',
          cancelRequestedAt: now,
          error: { name: 'Cancelled', message: reason, details: { actor } } as SerializedError,
          updatedAt: now,
        },
      },
    );
  }

  /** Re-open a FAILED run after an operator retry. */
  async reopenFailed(runId: string): Promise<void> {
    await this.collection.updateOne(
      { _id: runId, state: 'FAILED' },
      {
        $set: { state: 'RUNNING', updatedAt: this.clock.now(), failedNodeIds: [] },
        $unset: { error: '', finishedAt: '', durationMs: '' },
      },
    );
  }

  async wakeIfWaiting(runId: string): Promise<void> {
    await this.collection.updateOne(
      { _id: runId, state: 'WAITING' },
      { $set: { state: 'RUNNING', updatedAt: this.clock.now() } },
    );
  }

  activeChildren(runId: string): Promise<WorkflowRunDoc[]> {
    return this.collection.find({ 'parent.runId': runId, state: { $nin: TERMINAL } }).toArray();
  }

  find(filter: Filter<WorkflowRunDoc>) {
    return this.collection.find(filter);
  }

  static isTerminal(run: Pick<WorkflowRunDoc, 'state'>): boolean {
    return isTerminalRun(run.state);
  }
}
