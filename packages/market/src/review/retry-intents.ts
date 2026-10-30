import type { ClientSession } from 'mongodb';
import { type Actor, AppError, deterministicId, errorMessage, type JsonObject } from '@aptamind/contracts';
import { getCollection, validateDocument } from '@aptamind/db';
import { metrics } from '@aptamind/observability';
import type { MarketContext } from '../context';
import type { SourceService } from '../sources/source.service';
import {
  REVIEW_SCHEMA_VERSION,
  type ReviewOperationDoc,
  reviewOperationsCollection,
  type ReviewRetryIntentDoc,
  reviewRetryIntentsCollection,
} from './schemas';

/** An undelivered intent untouched for this long is picked up by the dispatcher sweep. */
export const RETRY_INTENT_STALE_MS = 10 * 60_000;

/** Operation states in which the decision is final: never released, never re-decided. */
const DECIDED: ReadonlyArray<ReviewOperationDoc['state']> = ['applied', 'finalized', 'completed'];

export type RetryDispatchOutcome =
  { state: 'delivered'; runId: string } | { state: 'cancelled' | 'failed'; reason: string };

/** A launch failure that repeating cannot fix (the source is gone or disabled). */
function isDeterministicLaunchFailure(err: unknown): boolean {
  return err instanceof AppError && ['validation_failed', 'invalid_state', 'not_found'].includes(err.code);
}

/**
 * The durable retry intents of review `retry` decisions (see `reviewRetryIntentDocSchema`) and
 * their dispatcher. The only path by which a review decision starts a source run:
 *
 *   persist   inside the generation-fenced transaction that moves the operation to `applied`
 *             (the authority to launch commits iff the decision won)
 *   dispatch  verify the intent is its item's decided retry → record the attempt → start the run
 *             with the intent's idempotency key → record `delivered` + run id
 *
 * No owner ever calls the launcher on the strength of a lease check.
 */
export class ReviewRetryIntents {
  /** Sweep timing; tests shorten it. */
  readonly timing = { staleMs: RETRY_INTENT_STALE_MS };

  constructor(
    private readonly ctx: MarketContext,
    private readonly sources: SourceService,
  ) {}

  get col() {
    return getCollection(this.ctx.db, reviewRetryIntentsCollection);
  }

  private get operations() {
    return getCollection(this.ctx.db, reviewOperationsCollection);
  }

  /** One intent per logical decision (stable across recovery of the same operation). */
  static idFor(reviewItemId: string, operationId: string): string {
    return deterministicId('rri', reviewItemId, operationId);
  }

  /**
   * Persist the intent in the caller's transaction — which must be the generation-fenced
   * transaction committing the decision. Idempotent (deterministic id, insert-if-absent).
   */
  async persist(
    args: {
      reviewItemId: string;
      operationId: string;
      generation: number;
      sourceId: string;
      actor: { kind: string; id: string };
      input: JsonObject;
    },
    session: ClientSession,
  ): Promise<ReviewRetryIntentDoc> {
    const now = this.ctx.clock.now();
    const id = ReviewRetryIntents.idFor(args.reviewItemId, args.operationId);
    const doc = validateDocument(reviewRetryIntentsCollection, {
      _id: id,
      reviewItemId: args.reviewItemId,
      operationId: args.operationId,
      generation: args.generation,
      sourceId: args.sourceId,
      actor: { kind: args.actor.kind, id: args.actor.id },
      input: args.input,
      idempotencyKey: `review-retry:${id}`,
      state: 'pending',
      attempts: 0,
      schemaVersion: REVIEW_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    });
    await this.col.updateOne({ _id: id }, { $setOnInsert: doc }, { upsert: true, session });
    return (await this.col.findOne({ _id: id }, { session }))!;
  }

  /**
   * Deliver one intent: start its source run exactly once (logically) or settle it as
   * `cancelled` / `failed` without launching. Safe to call repeatedly and concurrently: a
   * delivered intent returns its run; concurrent or crash-interrupted dispatches converge on the
   * one run keyed by the intent. Transient launch failures are recorded and rethrown (the intent
   * stays undelivered for a later dispatch).
   */
  async dispatch(id: string): Promise<RetryDispatchOutcome> {
    const intent = await this.col.findOne({ _id: id });
    if (!intent) throw new AppError('not_found', `Retry intent ${id} does not exist`);
    const settled = outcomeOf(intent);
    if (settled) return settled;

    // Authority: the intent must be the committed effect of its item's decided `retry`
    // operation. `applied` and later states never regress (no release, no new decision), so
    // this predicate, once true, stays true — checking it before the launch is not a
    // check-then-act race. An intent that fails it can never launch.
    const problem = await this.authorityProblem(intent);
    if (problem) return this.settle(intent, 'cancelled', problem);

    const claimed = await this.claimAttempt(id);
    if (!claimed) return outcomeOf((await this.col.findOne({ _id: id }))!)!;

    let runId: string;
    try {
      ({ runId } = await this.launch(claimed));
    } catch (err) {
      if (isDeterministicLaunchFailure(err)) return this.settle(claimed, 'failed', errorMessage(err));
      await this.col.updateOne(
        { _id: id, state: 'dispatching' },
        {
          $set: {
            lastError: { message: errorMessage(err), at: this.ctx.clock.now() },
            updatedAt: this.ctx.clock.now(),
          },
        },
      );
      throw err;
    }
    await this.markDelivered(id, runId);
    return { state: 'delivered', runId };
  }

  /**
   * Record a dispatch attempt (`dispatching`, attempts + 1). Exclusivity is not needed for
   * correctness: the run's idempotency key is unique in the workflow run store, so concurrent
   * dispatchers start the same run. `null` if the intent was settled meanwhile.
   */
  private claimAttempt(id: string): Promise<ReviewRetryIntentDoc | null> {
    const now = this.ctx.clock.now();
    return this.col.findOneAndUpdate(
      { _id: id, state: { $in: ['pending', 'dispatching'] } },
      { $set: { state: 'dispatching', lastAttemptAt: now, updatedAt: now }, $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    );
  }

  /** Start the intent's source run; the idempotency key makes a replay return the same run. */
  private launch(intent: ReviewRetryIntentDoc): Promise<{ runId: string }> {
    return this.sources.runNow(intent.sourceId, intent.actor as Actor, intent.input, {
      idempotencyKey: intent.idempotencyKey,
    });
  }

  private async markDelivered(id: string, runId: string): Promise<void> {
    const now = this.ctx.clock.now();
    await this.col.updateOne(
      { _id: id, state: { $in: ['pending', 'dispatching'] } },
      { $set: { state: 'delivered', runId, deliveredAt: now, updatedAt: now }, $unset: { lastError: '' } },
    );
    metrics.inc('review_retry_intents_delivered_total');
  }

  /** Why the intent has no authority to launch, or `null` if it has. */
  private async authorityProblem(intent: ReviewRetryIntentDoc): Promise<string | null> {
    const op = await this.operations.findOne({ _id: intent.reviewItemId });
    if (!op) return 'the review operation does not exist';
    if (op.operationId !== intent.operationId)
      return `superseded: the item's decision is operation ${op.operationId}`;
    if (op.decision.action !== 'retry') return `superseded: the item's decision is ${op.decision.action}`;
    if (!DECIDED.includes(op.state)) return `the retry decision is not committed (operation ${op.state})`;
    if (op.result?.retryIntentId !== intent._id) return 'the committed decision does not name this intent';
    return null;
  }

  /** Terminal, compare-and-set from an undelivered state; returns the settled outcome. */
  private async settle(
    intent: ReviewRetryIntentDoc,
    state: 'cancelled' | 'failed',
    reason: string,
  ): Promise<RetryDispatchOutcome> {
    const now = this.ctx.clock.now();
    const settled = await this.col.findOneAndUpdate(
      { _id: intent._id, state: { $in: ['pending', 'dispatching'] } },
      { $set: { state, terminalReason: reason, updatedAt: now } },
      { returnDocument: 'after' },
    );
    const current = settled ?? (await this.col.findOne({ _id: intent._id }))!;
    if (settled) {
      metrics.inc('review_retry_intents_settled_total', { state });
      this.ctx.logger.warn(
        { reviewItemId: intent.reviewItemId, retryIntentId: intent._id, state, reason },
        'review retry intent settled without launching',
      );
    }
    return outcomeOf(current)!;
  }

  /**
   * Dispatcher sweep: deliver intents left undelivered for the stale window (their owner and
   * the operation's outbox both stopped). Each intent in isolation; failures are counted and
   * logged and the sweep continues.
   */
  async dispatchStale(limit = 100): Promise<{ delivered: number; settled: number; failed: number }> {
    const cutoff = new Date(this.ctx.clock.now().getTime() - this.timing.staleMs);
    const stale = await this.col
      .find({ state: { $in: ['pending', 'dispatching'] }, updatedAt: { $lt: cutoff } })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .toArray();
    const counts = { delivered: 0, settled: 0, failed: 0 };
    for (const intent of stale) {
      try {
        const outcome = await this.dispatch(intent._id);
        if (outcome.state === 'delivered') counts.delivered += 1;
        else counts.settled += 1;
      } catch (err) {
        counts.failed += 1;
        metrics.inc('review_retry_dispatch_failures_total');
        this.ctx.logger.warn(
          { reviewItemId: intent.reviewItemId, retryIntentId: intent._id, err: errorMessage(err) },
          'review retry intent dispatch failed; will retry after the stale window',
        );
      }
    }
    return counts;
  }
}

function outcomeOf(intent: ReviewRetryIntentDoc): RetryDispatchOutcome | null {
  if (intent.state === 'delivered') return { state: 'delivered', runId: intent.runId! };
  if (intent.state === 'cancelled' || intent.state === 'failed')
    return { state: intent.state, reason: intent.terminalReason ?? intent.state };
  return null;
}
