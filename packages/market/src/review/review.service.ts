import type { ClientSession } from 'mongodb';
import { z } from 'zod';
import {
  type Actor,
  AppError,
  ConflictError,
  errorMessage,
  InvalidStateError,
  type JsonObject,
  jsonValueSchema,
  deterministicId,
  newId,
} from '@aptamind/contracts';
import {
  getCollection,
  isDuplicateKeyError,
  SchemaValidationError,
  validateDocument,
  withTransaction,
} from '@aptamind/db';
import { metrics } from '@aptamind/observability';
import { candidateFromPayload } from '../companies/company-pipeline';
import type { CompanyDoc } from '../companies/company.schema';
import type { CompanyService } from '../companies/company.service';
import type { MarketContext, RunLauncher } from '../context';
import { companyObservationPayloadSchema } from '../contracts/observations';
import type { JobEvidenceService } from '../jobs/evidence.service';
import type { JobService } from '../jobs/job.service';
import type { ObservationService } from '../observations/observation.service';
import type { CompanyReconciler } from '../reconciliation/company-reconciler';
import {
  JOB_OVERRIDE_PATHS,
  type JobReconciler,
  overrideProblem,
  sponsorshipCorrectionProblem,
} from '../reconciliation/job-reconciler';
import { COMPANY_RESOLVER_VERSION } from '../resolution/company-resolver';
import type { SourceService } from '../sources/source.service';
import type { AuditLog } from './audit';
import type { ReviewRepository } from './review.repository';
import { ReviewRetryIntents } from './retry-intents';
import {
  REVIEW_ACTIONS,
  REVIEW_SCHEMA_VERSION,
  type ReviewAction,
  type ReviewItemDoc,
  type ReviewOperationDoc,
  reviewOperationsCollection,
  type ReviewType,
} from './schemas';

/** An owner that has not renewed its claim for this long is presumed crashed (recoverable). */
export const REVIEW_CLAIM_STALE_MS = 10 * 60_000;
/** A working owner renews its claim this often — well inside the stale window. */
export const REVIEW_HEARTBEAT_MS = 60_000;
/** How many recovered owners an operation remembers (`recoveredFrom` stays bounded). */
const RECOVERY_HISTORY = 20;

/** The actor recorded when the recovery relay takes over an abandoned resolution. */
const SYSTEM_RECOVERY_ACTOR: Actor = { kind: 'system', id: 'review-recovery' } as Actor;

type Decision = ReviewOperationDoc['decision'];
type ActiveState = 'claimed' | 'applied';
const ACTIVE_STATES: ActiveState[] = ['claimed', 'applied'];

/**
 * The item's claim marker for an operation's current owner (as `markClaimed` writes it). An owner
 * that recovered the operation (its owner id is not the decision's) keeps who it recovered it from
 * and who it is, as `claim` wrote them on the takeover (M6.2 L5).
 */
function markerOf(op: ReviewOperationDoc, at: Date) {
  const recovered = op.owner.operationId !== op.operationId && op.recoveredFrom?.length;
  return {
    operationId: op.owner.operationId,
    actor: op.decisionActor,
    ...op.decision,
    at,
    ...(recovered ? { recoveredFrom: op.recoveredFrom!.at(-1)!, recoveredBy: op.owner.actor } : {}),
  };
}

function sameDecision(a: Decision, b: Decision): boolean {
  return (
    a.action === b.action &&
    (a.targetId ?? null) === (b.targetId ?? null) &&
    (a.field ?? null) === (b.field ?? null) &&
    JSON.stringify(a.value ?? null) === JSON.stringify(b.value ?? null)
  );
}

export const resolveReviewInputSchema = z.object({
  action: z.enum(REVIEW_ACTIONS),
  reason: z.string().min(3).max(2000),
  /** Target entity for `merge` / `keep_separate` (defaults to the single candidate). */
  targetId: z.string().optional(),
  /** Corrected value for `correct`. */
  field: z.string().optional(),
  value: jsonValueSchema.optional(),
  /**
   * If-Match (bc013e8 M2): the evidence digest (`context.evidenceHash`) of the item as the operator
   * was shown it. A decision on evidence that has changed since is refused (409); the decision
   * records this digest.
   */
  evidenceHash: z.string().min(1).optional(),
});
export type ResolveReviewInput = z.infer<typeof resolveReviewInputSchema>;

/** Job fields a `correct` decision can override (operator overrides, `job.overrides`). */
export const JOB_OVERRIDABLE: ReadonlySet<string> = new Set(Object.keys(JOB_OVERRIDE_PATHS));
/** Company fields a `correct` decision can set (as operator observations). */
export const COMPANY_CORRECTABLE = new Set(['identity.domain', 'identity.website', 'identity.displayName']);

/** The actions with domain effects each review type supports (`confirm`/`dismiss` have none). */
export const EFFECT_ACTIONS: Record<ReviewType, ReviewAction[]> = {
  company_resolution: ['merge', 'create_new', 'reject'],
  company_duplicate: ['merge', 'keep_separate'],
  job_duplicate: ['merge', 'keep_separate'],
  field_conflict: ['correct', 'retry'],
  employment_conflict: ['correct', 'retry'],
  salary_suspicious: ['correct', 'retry'],
  parser_failure: ['retry'],
  source_anomaly: ['retry'],
  careers_discovery: ['retry'],
  // Informational (re-verify #12): the sweep keeps retrying the job; dismiss once looked at.
  lifecycle_failure: [],
};
const TARGETED: ReviewAction[] = ['merge', 'keep_separate'];

function invalid(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('validation_failed', message, details);
}

/**
 * A failure that retrying the same decision cannot fix: the decision is invalid or a domain
 * precondition does not hold. (A lost claim — `ConflictError` — is not the decision's failure.)
 */
export function isDeterministicFailure(err: unknown): boolean {
  if (err instanceof ConflictError) return false;
  if (err instanceof AppError) return ['validation_failed', 'invalid_state', 'not_found'].includes(err.code);
  return err instanceof SchemaValidationError || err instanceof z.ZodError;
}

/** Hook so a workflow waiting on a review item can be resumed when it is decided. */
export type ReviewResolvedHook = (item: ReviewItemDoc, actor: Actor) => Promise<void>;

/**
 * Review resolution (WF7): the operator's decision is applied to domain state through the
 * same services automation uses, and every decision is audited (and retained as future
 * evaluation data).
 */
export class ReviewService {
  /** Claim lease timing. A healthy owner renews every `heartbeatMs`; tests shorten both. */
  readonly lease = { staleMs: REVIEW_CLAIM_STALE_MS, heartbeatMs: REVIEW_HEARTBEAT_MS };
  /** Durable intents of `retry` decisions and their dispatcher (the only path to a source run). */
  readonly retryIntents: ReviewRetryIntents;

  constructor(
    private readonly ctx: MarketContext,
    private readonly repo: ReviewRepository,
    private readonly audit: AuditLog,
    private readonly companies: CompanyService,
    private readonly companyReconciler: CompanyReconciler,
    private readonly jobs: JobService,
    private readonly jobReconciler: JobReconciler,
    private readonly observations: ObservationService,
    private readonly sources: SourceService,
    private readonly launcher?: RunLauncher,
    private readonly onResolved?: ReviewResolvedHook,
    private readonly evidence?: JobEvidenceService,
  ) {
    this.retryIntents = new ReviewRetryIntents(ctx, sources);
  }

  get operations() {
    return getCollection(this.ctx.db, reviewOperationsCollection);
  }

  /**
   * Resolve a review item through its durable resolution operation (one record per item):
   *
   *   validate the decision (shape + every domain precondition checkable now) — nothing is
   *            persisted for a decision that fails here
   *   → claim  (the operation: decision + owner, generation G)
   *   → apply  canonical effects and their result in ONE transaction whose first write
   *            re-asserts generation G; a stale owner's transaction commits nothing. For
   *            `retry` the effect is a durable retry intent: the authority to launch the source
   *            run commits only with the decision (no owner launches on a lease check)
   *   → derive recompute derived state (reconciliation — idempotent, from canonical inputs,
   *            and revision-fenced, so a stale recompute never lands)
   *   → close  the item and mark the operation `finalized` in one transaction fenced on G
   *   → outbox retry-intent dispatch, audit event and workflow resume, each recorded as
   *            delivered, then `completed`
   *
   * The owner renews its claim while working (heartbeat), so a slow but healthy resolution is
   * never taken over. It may resume with the same `operationId` (API: Idempotency-Key). An
   * operation whose owner stopped renewing for the stale window can be recovered by anyone:
   * recovery advances the generation (the old owner can no longer change anything) and
   * completes the STORED decision, never a new one; a caller whose own decision differs gets a
   * `ConflictError`. If the stored decision fails deterministically after its claim (e.g. the
   * merge target was merged away meanwhile), nothing was committed: the operation is marked
   * `failed` and the item is released for a corrected decision. Transient failures leave the
   * operation claimed for a resume or recovery.
   */
  async resolve(
    id: string,
    input: ResolveReviewInput,
    actor: Actor,
    opts: { operationId?: string } = {},
  ): Promise<ReviewItemDoc> {
    const parsed = resolveReviewInputSchema.parse(input);
    const operationId = opts.operationId ?? newId('rop');
    const item = await this.repo.get(id);
    const resume = item.status === 'open' && (await this.isResumeOf(id, operationId));
    // An early answer for a new decision; the claim CAS is the authoritative check, and a resumed
    // operation is judged on its own stored digest when applied (final check L-2).
    if (
      !resume &&
      parsed.evidenceHash &&
      item.status === 'open' &&
      typeof item.context?.evidenceHash === 'string' &&
      item.context.evidenceHash !== parsed.evidenceHash
    ) {
      throw new ConflictError(`Review item ${id}: its evidence changed since it was shown; reload it`, {
        reason: 'evidence_changed',
        shownEvidenceHash: parsed.evidenceHash,
        currentEvidenceHash: item.context.evidenceHash,
      });
    }
    const decision = normalizeDecision(item, parsed);
    if (item.status === 'open' && !resume) {
      // Before anything durable: an invalid decision never becomes the item's operation.
      await this.validateDecision(item, decision);
    }
    const { op, generation } = await this.claim(id, operationId, decision, actor, parsed.evidenceHash);
    const closed = await this.drive(op, generation);
    if (!sameDecision(decision, op.decision)) {
      throw new ConflictError(
        `Review item ${id} was completed with the interrupted decision "${op.decision.action}", not "${parsed.action}"`,
        { completedAction: op.decision.action, requestedAction: parsed.action },
      );
    }
    return closed;
  }

  /**
   * Whether `resolve` would accept `decision` for `item` right now: the same validation it runs
   * before claiming (read-only; nothing is written). An item that is not open, or is being
   * resolved (claimed), accepts nothing. Used to compute a review item's `supportedActions`.
   */
  async accepts(
    item: ReviewItemDoc,
    decision: {
      action: ReviewAction;
      targetId?: string;
      field?: string;
      value?: ResolveReviewInput['value'];
    },
  ): Promise<boolean> {
    if (item.status !== 'open' || item.claim) return false;
    try {
      await this.validateDecision(
        item,
        normalizeDecision(item, { ...decision, reason: 'supported-action check' }),
      );
      return true;
    } catch (err) {
      if (isDeterministicFailure(err) || (err instanceof AppError && err.code === 'unavailable'))
        return false;
      throw err;
    }
  }

  /** Whether `operationId` names the item's live operation (a resume, not a new decision). */
  private async isResumeOf(id: string, operationId: string): Promise<boolean> {
    const op = await this.operations.findOne(
      { _id: id },
      { projection: { operationId: 1, 'owner.operationId': 1, state: 1 } },
    );
    return (
      !!op &&
      op.state !== 'failed' &&
      (op.operationId === operationId || op.owner.operationId === operationId)
    );
  }

  /**
   * Take ownership of the item's resolution: create the operation, take over a released
   * (`failed`) one with a new decision, resume the caller's own, or recover a stale one
   * (advancing the generation). Anything else is a `ConflictError`. Does not validate: callers
   * validate new decisions first; recovery completes the stored one.
   */
  async claim(
    id: string,
    operationId: string,
    decision: ResolveReviewInput | Decision,
    actor: Actor,
    shownEvidenceHash?: string,
  ): Promise<{ op: ReviewOperationDoc; generation: number }> {
    const now = this.ctx.clock.now();
    const actorRef = { kind: actor.kind, id: actor.id };
    const stored: Decision = {
      action: decision.action,
      reason: decision.reason,
      targetId: decision.targetId,
      field: decision.field,
      value: decision.value,
    };
    const owner = { operationId, actor: actorRef, at: now };
    const item = await this.repo.get(id);
    if (item.status === 'open') {
      const doc: ReviewOperationDoc = {
        _id: id,
        operationId,
        generation: 1,
        owner,
        decision: stored,
        decisionActor: actorRef,
        // The digest the decision was made on (If-Match): a resume or recovery never applies it
        // to other evidence (final check L-2).
        ...(shownEvidenceHash ? { shownEvidenceHash } : {}),
        state: 'claimed',
        schemaVersion: REVIEW_SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now,
      };
      let inserted = false;
      try {
        await this.operations.insertOne(validateDocument(reviewOperationsCollection, doc));
        inserted = true;
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
      }
      if (inserted) {
        if (!(await this.markClaimed(id, operationId, actorRef, stored, now, shownEvidenceHash))) {
          // The claim CAS did not match: release the operation (nothing was done).
          await this.operations.deleteOne({ _id: id, operationId, generation: 1, state: 'claimed' });
          throw await this.claimRefused(id, shownEvidenceHash);
        }
        await this.confirmClaimed(id, operationId, 1);
        return { op: doc, generation: 1 };
      }
    }
    const existing = await this.operations.findOne({ _id: id });
    if (!existing) {
      throw new ConflictError(`Review item ${id} is already ${item.status}`, { status: item.status });
    }
    if (existing.state === 'failed' && item.status === 'open') {
      // The previous decision was released: this decision takes the item as the next generation.
      const next = await this.operations.findOneAndUpdate(
        { _id: id, generation: existing.generation, state: 'failed' },
        {
          $set: {
            operationId,
            owner,
            decision: stored,
            decisionActor: actorRef,
            state: 'claimed',
            updatedAt: now,
            ...(shownEvidenceHash ? { shownEvidenceHash } : {}),
          },
          $inc: { generation: 1 },
          $unset: {
            result: '',
            outbox: '',
            failure: '',
            lastError: '',
            completedAt: '',
            ...(shownEvidenceHash ? {} : { shownEvidenceHash: '' }),
          },
        },
        { returnDocument: 'after' },
      );
      if (next) {
        if (!(await this.markClaimed(id, operationId, actorRef, stored, now, shownEvidenceHash))) {
          // Release: the released (failed) operation is restored as it was.
          await this.operations.replaceOne({ _id: id, generation: next.generation, operationId }, existing);
          throw await this.claimRefused(id, shownEvidenceHash);
        }
        await this.confirmClaimed(id, operationId, next.generation);
        return { op: next, generation: next.generation };
      }
      throw new ConflictError(`Review item ${id} is already being resolved`);
    }
    if (existing.owner.operationId === operationId || existing.operationId === operationId) {
      if (existing.owner.operationId === operationId)
        return { op: existing, generation: existing.generation };
      if (existing.state === 'finalized' || existing.state === 'completed') {
        // The logical operation is decided; its original caller may observe the outcome.
        return { op: existing, generation: existing.generation };
      }
      throw new ConflictError(`Review item ${id}: this operation's claim was recovered by another resolver`);
    }
    if (existing.state === 'finalized' || existing.state === 'completed') {
      await this.drive(existing, existing.generation); // help deliver a pending outbox
      throw new ConflictError(
        `Review item ${id} is already ${item.status === 'open' ? 'resolved' : item.status}`,
        { status: item.status },
      );
    }
    if (existing.owner.at.getTime() < now.getTime() - this.lease.staleMs) {
      const recovered = await this.takeOver(existing, owner, now);
      if (recovered) {
        // The whole marker, not its fields: the stalled owner may never have written one (L4).
        await this.repo.col.updateOne(
          { _id: id, status: 'open' },
          {
            $set: {
              claim: {
                ...markerOf(recovered, now),
                recoveredFrom: existing.owner.operationId,
                recoveredBy: actorRef,
              },
              updatedAt: now,
            },
          },
        );
        await this.confirmClaimed(id, operationId, recovered.generation);
        return { op: recovered, generation: recovered.generation };
      }
    }
    throw new ConflictError(
      `Review item ${id} is already being resolved by ${existing.owner.actor.kind}:${existing.owner.actor.id}`,
      { claimedBy: existing.owner.actor, claimedAt: existing.owner.at },
    );
  }

  /**
   * Recover a silent owner's operation. Compare-and-set on the generation that was read AND a
   * still-expired lease: an owner that renewed meanwhile keeps it, and a takeover decided on an
   * outdated read (someone else recovered first) fails.
   */
  private takeOver(existing: ReviewOperationDoc, owner: ReviewOperationDoc['owner'], now: Date) {
    return this.operations.findOneAndUpdate(
      {
        _id: existing._id,
        generation: existing.generation,
        state: { $in: ACTIVE_STATES },
        'owner.at': { $lt: new Date(now.getTime() - this.lease.staleMs) },
      },
      {
        $set: { owner, updatedAt: now },
        $inc: { generation: 1 },
        $push: { recoveredFrom: { $each: [existing.owner.operationId], $slice: -RECOVERY_HISTORY } },
      },
      { returnDocument: 'after' },
    );
  }

  /** Informational (UI shows RESOLVING); the operation record is authoritative. */
  private async markClaimed(
    id: string,
    operationId: string,
    actor: { kind: string; id: string },
    decision: Decision,
    now: Date,
    shownEvidenceHash?: string,
  ): Promise<ReviewItemDoc | null> {
    // ONE compare-and-set (bc013e8 M1, final check M-1): owning the operation record is the
    // mutex, so a leftover claim marker (a crash between release's writes) is simply replaced.
    // With If-Match only while the item still carries the digest the operator was shown (or none:
    // an item without a digest accepts any, L-1). Claimed, the item is no longer refreshed, so the
    // decision covers exactly the digest and stating set this CAS saw.
    return this.repo.col.findOneAndUpdate(
      {
        _id: id,
        status: 'open',
        ...(shownEvidenceHash
          ? {
              $or: [
                { 'context.evidenceHash': shownEvidenceHash },
                { 'context.evidenceHash': { $exists: false } },
              ],
            }
          : {}),
      },
      { $set: { claim: { operationId, actor, ...decision, at: now }, updatedAt: now } },
      { returnDocument: 'after' },
    );
  }

  /**
   * After `markClaimed`: the claim marker is only this owner's if the operation still is — same
   * generation, same owner (final check L4). A resolver that stalled between writing the operation
   * and the marker may have been taken over meanwhile (and the new owner may have released or
   * completed it); its late marker would then be an orphan that keeps the item "resolving" and
   * never refreshed. So it takes back the marker it wrote (filtered on its own operation id: a
   * newer owner's marker is never touched) — handing it to the current owner while that one is
   * still active — and stops. The owner it handed to may have released or been replaced between
   * the read and the hand-back (its own release then found A's marker, not its own, and left it):
   * so after the hand-back the operation is read again, and if it is no longer that owner's active
   * generation, the handed-back marker is removed (filtered on that owner's id and the marker's
   * `at`: a still newer owner's marker, even one under the same operation id, is never touched;
   * M6.2 L5, review L-a).
   */
  private async confirmClaimed(id: string, operationId: string, generation: number): Promise<void> {
    const op = await this.operations.findOne({ _id: id });
    if (op && op.generation === generation && op.owner.operationId === operationId) return;
    const mine = { _id: id, 'claim.operationId': operationId };
    if (op && (ACTIVE_STATES as string[]).includes(op.state)) {
      const handed = await this.repo.col.updateOne(mine, { $set: { claim: markerOf(op, op.owner.at) } });
      if (handed.modifiedCount > 0) {
        const now = await this.operations.findOne(
          { _id: id },
          { projection: { generation: 1, state: 1, 'owner.operationId': 1 } },
        );
        if (
          !now ||
          now.generation !== op.generation ||
          now.owner.operationId !== op.owner.operationId ||
          !(ACTIVE_STATES as string[]).includes(now.state)
        )
          // Only the marker this hand-back wrote (its owner's id AND its `at`, the owner's lease
          // time): a re-claim under the same operation id (a retry of B as a new generation)
          // wrote its own `at` and is never removed (M6.2 review L-a).
          await this.repo.col.updateOne(
            { _id: id, 'claim.operationId': op.owner.operationId, 'claim.at': op.owner.at },
            { $unset: { claim: '' } },
          );
      }
    } else await this.repo.col.updateOne(mine, { $unset: { claim: '' } });
    throw new ConflictError(`Review item ${id}: this operation's claim was recovered by another resolver`);
  }

  /** Why a claim CAS matched nothing: changed evidence (If-Match) or an item no longer open. */
  private async claimRefused(id: string, shown: string | undefined): Promise<ConflictError> {
    const item = await this.repo.col.findOne({ _id: id }, { projection: { status: 1, context: 1 } });
    if (item?.status === 'open' && shown)
      return new ConflictError(`Review item ${id}: its evidence changed since it was shown; reload it`, {
        reason: 'evidence_changed',
        shownEvidenceHash: shown,
        currentEvidenceHash: (item.context?.evidenceHash as string | undefined) ?? null,
      });
    return new ConflictError(`Review item ${id} is no longer open`, {
      reason: 'not_open',
      status: item?.status ?? 'missing',
    });
  }

  /** Advance the operation to completion from whatever step it reached. */
  private async drive(start: ReviewOperationDoc, generation: number): Promise<ReviewItemDoc> {
    let op = start;
    if (op.state === 'claimed' || op.state === 'applied') {
      const stopHeartbeat = this.startHeartbeat(op._id, generation);
      try {
        const item = await this.repo.get(op._id);
        if (op.state === 'claimed') op = await this.applyOrRelease(item, op, generation);
        if (op.state === 'applied') {
          await this.derive(item, op, generation);
          op = await this.close(item, op, generation);
        }
      } catch (err) {
        if (!(err instanceof ConflictError) && !isDeterministicFailure(err)) {
          await this.recordError(op._id, generation, err);
        }
        throw err;
      } finally {
        stopHeartbeat();
      }
    }
    if (op.state === 'finalized') op = await this.deliverOutbox(op);
    return this.repo.get(op._id);
  }

  /**
   * While this owner works on generation `generation`, renew its lease so a slow resolution is
   * not mistaken for a crashed one. Fenced: a renewal never revives a lost claim.
   */
  private startHeartbeat(id: string, generation: number): () => void {
    const timer = setInterval(() => {
      this.operations
        .updateOne(
          { _id: id, generation, state: { $in: ACTIVE_STATES } },
          { $set: { 'owner.at': this.ctx.clock.now() } },
        )
        .catch((err: unknown) =>
          this.ctx.logger.warn({ reviewItemId: id, err: errorMessage(err) }, 'review claim renewal failed'),
        );
    }, this.lease.heartbeatMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  /**
   * Re-assert ownership (and renew the lease) before a step that is not itself transactional
   * with the fence. A `ConflictError` if the claim was lost.
   */
  private async renewLease(id: string, generation: number): Promise<void> {
    const renewed = await this.operations.updateOne(
      { _id: id, generation, state: { $in: ACTIVE_STATES } },
      { $set: { 'owner.at': this.ctx.clock.now() } },
    );
    if (renewed.matchedCount > 0) return;
    const current = await this.operations.findOne({ _id: id });
    if (!current || current.generation !== generation || current.state === 'failed') throw lost(id);
  }

  /** Record a transient failure for operators; the operation stays recoverable. */
  private async recordError(id: string, generation: number, err: unknown): Promise<void> {
    try {
      await this.operations.updateOne(
        { _id: id, generation, state: { $in: ACTIVE_STATES } },
        { $set: { lastError: { message: errorMessage(err), at: this.ctx.clock.now(), generation } } },
      );
    } catch {
      // Best effort: the original error is what the caller needs.
    }
  }

  /** Apply the decision; a deterministic failure releases the item for a corrected decision. */
  private async applyOrRelease(
    item: ReviewItemDoc,
    op: ReviewOperationDoc,
    generation: number,
  ): Promise<ReviewOperationDoc> {
    // A decision made on other evidence than the item now carries is never applied — also on a
    // resume or recovery of an operation whose claim CAS was refused (final check L-2).
    if (
      op.shownEvidenceHash &&
      typeof item.context?.evidenceHash === 'string' &&
      item.context.evidenceHash !== op.shownEvidenceHash
    ) {
      await this.release(
        op,
        generation,
        new AppError('invalid_state', 'The evidence changed since the decision was made; decide again'),
      );
      throw new ConflictError(`Review item ${op._id}: its evidence changed since it was shown; reload it`, {
        reason: 'evidence_changed',
        shownEvidenceHash: op.shownEvidenceHash,
        currentEvidenceHash: item.context.evidenceHash,
      });
    }
    try {
      return await this.apply(item, op, generation);
    } catch (err) {
      if (isDeterministicFailure(err)) await this.release(op, generation, err);
      throw err;
    }
  }

  /**
   * The stored decision cannot be applied, and nothing of it was committed (canonical effects —
   * including a retry's intent — commit in one transaction; nothing external has happened).
   * Mark the operation `failed` (fenced on the generation) and re-open the item for a new
   * decision.
   */
  private async release(op: ReviewOperationDoc, generation: number, err: unknown): Promise<void> {
    const now = this.ctx.clock.now();
    const kind =
      err instanceof AppError && err.code === 'validation_failed' ? 'invalid_decision' : 'domain_conflict';
    const code = err instanceof AppError ? err.code : 'schema_invalid';
    const message = errorMessage(err);
    const released = await this.operations.updateOne(
      { _id: op._id, generation, state: 'claimed' },
      {
        $set: {
          state: 'failed',
          failure: { kind, code, message, at: now, generation },
          'owner.at': now,
          updatedAt: now,
        },
      },
    );
    if (released.matchedCount === 0) return; // no longer this owner's to release
    await this.repo.col.updateOne(
      { _id: op._id, status: 'open' },
      {
        $set: {
          lastFailure: {
            operationId: op.operationId,
            action: op.decision.action,
            kind,
            code,
            message,
            at: now,
          },
          updatedAt: now,
        },
      },
    );
    await this.repo.col.updateOne(
      { _id: op._id, status: 'open', 'claim.operationId': op.owner.operationId },
      { $unset: { claim: '' } },
    );
    metrics.inc('review_operations_released_total', { kind });
    this.ctx.logger.warn(
      { reviewItemId: op._id, operationId: op.operationId, generation, kind, code, err: message },
      'review decision failed after its claim; item released for a new decision',
    );
  }

  /**
   * Commit canonical effects and the operation's result in ONE transaction whose FIRST write
   * re-asserts ownership (this generation, still `claimed`). If a recovery advanced the
   * generation before, the fence matches nothing and nothing commits (`ConflictError`). If a
   * recovery comes while this transaction is open, it waits for it (the fence write holds the
   * operation) and then finds the lease renewed; if it got in first, this transaction's fence
   * write conflicts, is retried, and fails the fence. A stale owner changes nothing.
   */
  private async commitEffects(
    op: ReviewOperationDoc,
    generation: number,
    writes: (session: ClientSession) => Promise<JsonObject>,
  ): Promise<ReviewOperationDoc> {
    return withTransaction(this.ctx.db.client, async (session) => {
      const now = this.ctx.clock.now();
      const fence = await this.operations.updateOne(
        { _id: op._id, generation, state: 'claimed' },
        { $set: { 'owner.at': now } },
        { session },
      );
      if (fence.matchedCount === 0) {
        const current = await this.operations.findOne({ _id: op._id }, { session });
        // The same owner (a concurrent resume of this operation) already applied it.
        if (
          current &&
          current.generation === generation &&
          ['applied', 'finalized', 'completed'].includes(current.state)
        )
          return current;
        throw lost(op._id);
      }
      const result = await writes(session);
      const applied = await this.operations.findOneAndUpdate(
        { _id: op._id, generation, state: 'claimed' },
        { $set: { state: 'applied', result, updatedAt: now } },
        { session, returnDocument: 'after' },
      );
      if (!applied) throw lost(op._id);
      return applied;
    });
  }

  /**
   * Recompute derived state (reconciliation) after the canonical effects. Idempotent and a pure
   * function of current canonical inputs — the same recompute automation runs — so repeating
   * it on a resume is harmless. A stale owner stops at the lease check.
   */
  private async derive(item: ReviewItemDoc, op: ReviewOperationDoc, generation: number): Promise<void> {
    await this.renewLease(op._id, generation);
    try {
      await this.recompute(item, op);
    } catch (err) {
      if (!isDeterministicFailure(err)) throw err;
      // The decision is committed; a derived recompute that cannot run (e.g. the entity was
      // merged away) must not block closing it. Automation recomputes on the next change.
      this.ctx.logger.warn(
        { reviewItemId: item._id, err: errorMessage(err) },
        'review: derived recompute skipped',
      );
    }
  }

  /** Close the item and finalize the operation in one transaction (owner-only). */
  private async close(
    item: ReviewItemDoc,
    op: ReviewOperationDoc,
    generation: number,
  ): Promise<ReviewOperationDoc> {
    const now = this.ctx.clock.now();
    const status = op.decision.action === 'dismiss' ? 'dismissed' : 'resolved';
    await withTransaction(this.ctx.db.client, async (session) => {
      const fenced = await this.operations.updateOne(
        { _id: op._id, generation, state: 'applied' },
        {
          $set: {
            state: 'finalized',
            outbox: {
              audit: false,
              resume: false,
              ...(op.result?.retryIntentId ? { retry: false } : {}),
            },
            'owner.at': now,
            updatedAt: now,
          },
        },
        { session },
      );
      if (fenced.matchedCount === 0) return;
      await this.repo.col.updateOne(
        { _id: item._id, status: 'open' },
        {
          $set: {
            status,
            resolution: {
              action: op.decision.action,
              reason: op.decision.reason,
              value: op.decision.value,
              targetId: op.decision.targetId,
              actor: op.decisionActor,
              at: now,
              result: op.result,
              operationId: op.operationId,
            },
            updatedAt: now,
          },
          // A closed item is never claimed: the advisory triage claim goes with the item's closing.
          $unset: { claim: '', assignment: '' },
        },
        { session },
      );
    });
    const current = (await this.operations.findOne({ _id: op._id }))!;
    if (current.generation !== generation) throw lost(op._id);
    return current;
  }

  /**
   * Post-decision effects, each idempotent and recorded as delivered: the retry intent's source
   * run (one logical run per intent), the audit event (stable id) and the resume of workflows
   * waiting on the item (a node is resumed only while WAITING). Not owner-fenced — anyone may
   * finish delivering a decided operation.
   */
  private async deliverOutbox(start: ReviewOperationDoc): Promise<ReviewOperationDoc> {
    let op = start;
    if (op.outbox?.retry === false) op = await this.deliverRetry(op);
    const item = await this.repo.get(op._id);
    const actor = op.decisionActor as Actor;
    if (!op.outbox?.audit) {
      await this.audit.record({
        actor,
        action: `review.${op.decision.action}`,
        entity: item.entity,
        reviewItemId: item._id,
        details: {
          type: item.type,
          reason: op.decision.reason,
          result: op.result ?? {},
          field: op.decision.field ?? null,
          value: op.decision.value ?? null,
          operationId: op.operationId,
        },
      });
      await this.operations.updateOne({ _id: op._id }, { $set: { 'outbox.audit': true } });
    }
    if (!op.outbox?.resume) {
      await this.onResolved?.(item, actor);
      await this.operations.updateOne({ _id: op._id }, { $set: { 'outbox.resume': true } });
    }
    const now = this.ctx.clock.now();
    await this.operations.updateOne(
      { _id: op._id, state: 'finalized' },
      { $set: { state: 'completed', completedAt: now, updatedAt: now } },
    );
    return (await this.operations.findOne({ _id: op._id }))!;
  }

  /**
   * Dispatch the decision's retry intent and record the outcome on the operation and the item
   * (the run id is the same on every delivery: the run is keyed by the intent).
   */
  private async deliverRetry(op: ReviewOperationDoc): Promise<ReviewOperationDoc> {
    const intentId = op.result?.retryIntentId as string;
    const outcome = await this.retryIntents.dispatch(intentId);
    const fields: JsonObject =
      outcome.state === 'delivered'
        ? { runId: outcome.runId }
        : { retryOutcome: outcome.state, retryError: outcome.reason };
    const set = (prefix: string) =>
      Object.fromEntries(Object.entries(fields).map(([k, v]) => [`${prefix}.${k}`, v]));
    await this.repo.col.updateOne(
      { _id: op._id, 'resolution.operationId': op.operationId },
      { $set: set('resolution.result') },
    );
    await this.operations.updateOne(
      { _id: op._id, operationId: op.operationId, state: 'finalized' },
      { $set: { ...set('result'), 'outbox.retry': true } },
    );
    return (await this.operations.findOne({ _id: op._id }))!;
  }

  /**
   * Recovery relay: finish operations whose owner went silent — deliver the outbox of decided
   * ones, and take over (new generation) and complete undecided ones with their stored decision.
   * Each operation is recovered in isolation: a failure is recorded, counted and logged, and the
   * sweep continues. A decision that fails deterministically is released (never retried); a
   * transient failure stays recoverable, retried after another stale window (oldest first, so a
   * persistently failing operation cannot starve the others). Called by the periodic freshness
   * sweep; safe to run concurrently. Reads only live operations (index `by_state_owner_at`).
   * Then the retry-intent dispatcher sweep delivers any intent left undelivered.
   */
  async recoverIncomplete(limit = 100): Promise<{
    recovered: number;
    failed: number;
    retries: { delivered: number; settled: number; failed: number };
  }> {
    const now = this.ctx.clock.now();
    const stale = await this.operations
      .find({
        state: { $in: ['claimed', 'applied', 'finalized'] },
        'owner.at': { $lt: new Date(now.getTime() - this.lease.staleMs) },
      })
      .sort({ 'owner.at': 1 })
      .limit(limit)
      .toArray();
    let recovered = 0;
    let failed = 0;
    for (const op of stale) {
      try {
        await this.recoverOne(op);
        recovered += 1;
      } catch (err) {
        if (err instanceof ConflictError) continue; // another resolver holds it now
        failed += 1;
        const kind = isDeterministicFailure(err) ? 'released' : 'transient';
        metrics.inc('review_recovery_failures_total', { kind });
        this.ctx.logger.warn(
          { reviewItemId: op._id, state: op.state, kind, err: errorMessage(err) },
          'review recovery failed for one operation; continuing the sweep',
        );
        if (op.state === 'finalized') {
          // Outbox delivery failed: back off one stale window (claimed ops got that from the takeover).
          await this.operations
            .updateOne(
              { _id: op._id, state: 'finalized' },
              {
                $set: {
                  'owner.at': this.ctx.clock.now(),
                  lastError: {
                    message: errorMessage(err),
                    at: this.ctx.clock.now(),
                    generation: op.generation,
                  },
                },
              },
            )
            .catch(() => undefined);
        }
      }
    }
    if (recovered) metrics.inc('review_operations_recovered_total', {}, recovered);
    const retries = await this.retryIntents.dispatchStale(limit);
    return { recovered, failed, retries };
  }

  private async recoverOne(op: ReviewOperationDoc): Promise<void> {
    if (op.state === 'finalized') {
      await this.deliverOutbox(op);
      return;
    }
    const { op: mine, generation } = await this.claim(
      op._id,
      `recovery:${op._id}:${op.generation + 1}`,
      op.decision,
      SYSTEM_RECOVERY_ACTOR,
    );
    await this.drive(mine, generation);
  }

  // --- validation (before the claim) ------------------------------------------------------------

  /**
   * Every check that can be made before the decision is persisted: the decision's shape (action
   * allowed and supported, required target/field/value present and valid) and the domain
   * preconditions that hold now (target exists and is a candidate, merge legal, `create_new`
   * would not clash with an existing company's identity, source can be retried). Throws
   * `validation_failed`; nothing is written.
   */
  private async validateDecision(item: ReviewItemDoc, d: Decision): Promise<void> {
    if (!item.allowedActions.includes(d.action)) {
      throw invalid(`Action ${d.action} is not allowed for ${item.type}`, { allowed: item.allowedActions });
    }
    if (d.action === 'dismiss' || d.action === 'confirm') return;
    if (!EFFECT_ACTIONS[item.type].includes(d.action)) {
      throw invalid(`Action ${d.action} is not supported for ${item.type}`, {
        supported: EFFECT_ACTIONS[item.type],
      });
    }
    switch (item.type) {
      case 'company_resolution':
        return this.validateCompanyResolution(item, d);
      case 'company_duplicate':
        return this.validateCompanyDuplicate(item, d);
      case 'job_duplicate':
        return this.validateJobDuplicate(item, d);
      case 'field_conflict':
      case 'employment_conflict':
      case 'salary_suspicious':
        return this.validateCorrection(item, d);
      case 'parser_failure':
      case 'source_anomaly':
      case 'careers_discovery':
        return this.validateRetrySource(item);
      case 'lifecycle_failure':
        return;
    }
  }

  private async validateCompanyResolution(item: ReviewItemDoc, d: Decision): Promise<void> {
    if (d.action === 'merge') {
      const target = this.target(item, d);
      const company = await this.companies.col.findOne({ _id: target });
      if (!company) throw invalid(`Merge target company ${target} does not exist`);
      if ((await this.companies.resolveActive(target)).status !== 'active')
        throw invalid(`Merge target company ${target} is not active`);
    } else if (d.action === 'create_new') {
      const plan = await this.createNewPlan(item);
      const holder = await this.companies.col.findOne(
        { identityKeys: { $in: plan.keys }, status: 'active', _id: { $ne: plan.id } },
        { projection: { _id: 1 } },
      );
      if (holder) {
        throw invalid(
          `create_new would duplicate the identity of company ${holder._id}; merge into it instead`,
          { conflictingCompanyId: holder._id },
        );
      }
    }
  }

  private async validateCompanyDuplicate(item: ReviewItemDoc, d: Decision): Promise<void> {
    const other = this.target(item, d);
    if (other === item.entity.id) throw invalid('A company cannot be compared with itself');
    const [a, b] = await Promise.all([
      this.companies.col.findOne({ _id: item.entity.id }),
      this.companies.col.findOne({ _id: other }),
    ]);
    if (!a || !b) throw invalid(`Company ${a ? other : item.entity.id} does not exist`);
    if (d.action !== 'merge') return;
    const [into, from] = mergeOrder(a, b);
    if (from.status === 'merged' && from.mergedInto !== into._id)
      throw invalid(`Company ${from._id} is already merged into ${from.mergedInto}`);
    if ((await this.companies.resolveActive(into._id))._id === from._id)
      throw invalid(`Company ${into._id} is already merged into ${from._id}`);
  }

  private async validateJobDuplicate(item: ReviewItemDoc, d: Decision): Promise<void> {
    const other = this.target(item, d);
    if (other === item.entity.id) throw invalid('A job cannot be compared with itself');
    const [a, b] = await Promise.all([
      this.jobs.col.findOne({ _id: item.entity.id }),
      this.jobs.col.findOne({ _id: other }),
    ]);
    if (!a || !b) throw invalid(`Job ${a ? other : item.entity.id} does not exist`);
    if (d.action !== 'merge') return;
    const [into, from] = mergeOrder(a, b);
    if (from.status === 'merged' && from.mergedInto !== into._id)
      throw invalid(`Job ${from._id} is already merged into ${from.mergedInto}`);
    if (into.status === 'merged') throw invalid(`Job ${into._id} is already merged into ${into.mergedInto}`);
  }

  private async validateCorrection(item: ReviewItemDoc, d: Decision): Promise<void> {
    const { kind, id } = item.entity;
    if (d.action === 'retry') {
      if (kind === 'job' && !(await this.jobs.col.findOne({ _id: id }, { projection: { _id: 1 } })))
        throw invalid(`Job ${id} does not exist`);
      if (kind === 'company' && !(await this.companies.col.findOne({ _id: id }, { projection: { _id: 1 } })))
        throw invalid(`Company ${id} does not exist`);
      return;
    }
    if (!d.field || d.value === undefined) throw invalid('field and value are required for correct');
    if (kind === 'job') {
      if (!JOB_OVERRIDABLE.has(d.field))
        throw invalid(`Field ${d.field} cannot be corrected (allowed: ${[...JOB_OVERRIDABLE].join(', ')})`);
      const job = await this.jobs.col.findOne({ _id: id });
      if (!job) throw invalid(`Job ${id} does not exist`);
      if (d.field === 'sponsorship') {
        // Ruling on PR #21 A-M3/B-M1: a job-level correction decides only the role axis.
        const roleProblem = sponsorshipCorrectionProblem(d.value);
        if (roleProblem) throw invalid(`Invalid value for sponsorship: ${roleProblem}`);
      }
      const problem = overrideProblem(job, d.field, d.value);
      if (problem) throw invalid(`Invalid value for ${d.field}: ${problem}`);
      return;
    }
    if (kind === 'company') {
      const company = await this.companies.col.findOne({ _id: id });
      if (!company) throw invalid(`Company ${id} does not exist`);
      const payload = operatorPayload(company, d.field, d.value); // throws on an unsupported field
      const parsed = companyObservationPayloadSchema.safeParse(payload);
      if (!parsed.success)
        throw invalid(`Invalid value for ${d.field}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
      if (!(await this.sources.getByKey('system:operator')))
        throw new InvalidStateError('Operator source missing; run migrations');
      return;
    }
    throw invalid(`Cannot correct a ${kind}`);
  }

  private async validateRetrySource(item: ReviewItemDoc): Promise<void> {
    const sourceId = retrySourceId(item);
    if (!sourceId) throw invalid('No source to retry');
    const source = await this.sources.col.findOne({ _id: sourceId });
    if (!source) throw invalid(`Source ${sourceId} does not exist`);
    if (!source.enabled) throw invalid(`Source ${source.key} is disabled`);
    if (!this.launcher) throw new AppError('unavailable', 'Run launcher not available');
  }

  // --- effects (after the claim, generation-fenced) ---------------------------------------------

  private async apply(
    item: ReviewItemDoc,
    op: ReviewOperationDoc,
    generation: number,
  ): Promise<ReviewOperationDoc> {
    const d = op.decision;
    const actor = op.decisionActor as Actor;
    const commit = (writes: (session: ClientSession) => Promise<JsonObject>) =>
      this.commitEffects(op, generation, writes);
    if (d.action === 'dismiss' && isStaleOverrideReview(item))
      return commit((session) => this.removeStaleOverride(item, actor, session));
    // An operator decision on a sponsorship conflict records the stating set it decided, in the
    // same transaction as the decision (DECISION_LOG 3dfe3c5 (2)).
    const outcome = await this.sponsorshipDecisionOf(item, d, actor);
    const decided = Array.isArray(outcome) ? outcome : null;
    if (d.action === 'dismiss' || d.action === 'confirm')
      return commit(async (session): Promise<JsonObject> => {
        if (outcome === 'ask_again') return { applied: false, askAgain: true };
        if (!decided) return { applied: false };
        await this.recordSponsorshipDecision(item, d, actor, decided, session);
        return { applied: false, decidedStating: decided.length };
      });
    // A correction on an item never refreshed under 3dfe3c5: the override stands, no decision
    // is recorded, and the question is asked again (reported as such; 5a13fed L-b).
    if (outcome === 'ask_again')
      return commit(async (session) => ({
        ...(await this.applyCorrection(item, d, actor, session)),
        askAgain: true,
      }));
    if (decided)
      return commit(async (session) => {
        const result = await this.applyCorrection(item, d, actor, session);
        await this.recordSponsorshipDecision(item, d, actor, decided, session);
        return { ...result, decidedStating: decided.length };
      });
    switch (item.type) {
      case 'company_resolution':
        return commit((session) => this.applyCompanyResolution(item, d, actor, session));
      case 'company_duplicate':
        return commit((session) => this.applyCompanyDuplicate(item, d, actor, session));
      case 'job_duplicate':
        return commit((session) => this.applyJobDuplicate(item, d, actor, session));
      case 'field_conflict':
      case 'employment_conflict':
      case 'salary_suspicious':
        // `retry` only recomputes derived state (the derive step); it writes nothing canonical.
        if (d.action === 'retry') return commit(async () => ({ reprocessed: item.entity.id }));
        return commit((session) => this.applyCorrection(item, d, actor, session));
      case 'parser_failure':
      case 'source_anomaly':
      case 'careers_discovery':
        return this.applyRetry(item, op, generation);
      case 'lifecycle_failure':
        return commit(async () => ({ applied: false })); // no effect actions
    }
  }

  /**
   * What an operator decision on a sponsorship conflict decides (DECISION_LOG 3dfe3c5 (2),
   * a720377 (3)): for a `sponsorship_conflict` employment_conflict item (`correct` of sponsorship,
   * `dismiss`, `confirm`) or a sponsorship `correct` through a field_conflict item, the stating
   * set the item carries (`context.stating`, what the operator saw). An item that carries none
   * (never refreshed since 3dfe3c5) decides nothing: `ask_again`. Null for any other item or
   * decision, and for a system closure (not an operator decision).
   */
  private async sponsorshipDecisionOf(
    item: ReviewItemDoc,
    d: Decision,
    actor: Actor,
  ): Promise<SponsorshipDecisionOutcome> {
    if (item.entity.kind !== 'job' || actor.kind === 'system') return null;
    const conflictItem =
      item.type === 'employment_conflict' &&
      item.context?.flag === 'sponsorship_conflict' &&
      (d.action === 'dismiss' ||
        d.action === 'confirm' ||
        (d.action === 'correct' && d.field === 'sponsorship'));
    // A sponsorship correction through a field_conflict item decides the conflict too (a720377 (3)).
    const fieldItem =
      item.type === 'field_conflict' &&
      Array.isArray(item.context?.fields) &&
      item.context.fields.includes('immigration.sponsorship') &&
      d.action === 'correct' &&
      d.field === 'sponsorship';
    if (!conflictItem && !fieldItem) return null;
    const stored = item.context.stating;
    // Only what the operator saw: an item never refreshed under 3dfe3c5 carries no stating set;
    // its decision records nothing and the question is asked again (a720377 (3)).
    if (!Array.isArray(stored)) return 'ask_again';
    return stored.flatMap((x) => {
      const e = x as {
        copy?: unknown;
        observationId?: unknown;
        value?: unknown;
        scope?: unknown;
        line?: unknown;
      };
      return typeof e.observationId === 'string' && (e.value === 'yes' || e.value === 'no')
        ? [
            {
              ...(typeof e.copy === 'string' ? { copy: e.copy } : {}),
              observationId: e.observationId,
              value: e.value,
              ...(typeof e.scope === 'string' ? { scope: e.scope } : {}),
              ...(typeof e.line === 'string' ? { line: e.line } : {}),
            },
          ]
        : [];
    });
  }

  private async recordSponsorshipDecision(
    item: ReviewItemDoc,
    d: Decision,
    actor: Actor,
    stating: StatingDecision,
    session: ClientSession,
  ): Promise<void> {
    const now = this.ctx.clock.now();
    await this.jobs.col.updateOne(
      { _id: item.entity.id },
      {
        $set: {
          sponsorshipDecision: {
            stating,
            action: d.action as 'correct' | 'dismiss' | 'confirm',
            reviewItemId: item._id,
            actorId: actor.id,
            at: now,
          },
          updatedAt: now,
        },
        $inc: { rev: 1 },
      },
      { session },
    );
  }

  private target(item: ReviewItemDoc, d: Decision): string {
    const id = d.targetId;
    if (!id) throw invalid('targetId is required when there is more than one candidate');
    if (!item.candidates.some((c) => c.id === id))
      throw invalid(`targetId ${id} is not a candidate of this review item`);
    return id;
  }

  /** The company `create_new` creates: deterministic id and identity (a replay finds it). */
  private async createNewPlan(item: ReviewItemDoc) {
    const first = await this.observations.companyObservations
      .find({ _id: { $in: item.observationIds } })
      .sort({ _id: 1 })
      .limit(1)
      .next();
    if (!first) throw invalid('Review item has no observations to create a company from');
    const base = candidateFromPayload(first.payload);
    const candidate = { ...base, domain: null, externalIds: [] };
    const qualifier = (base.town ?? base.country ?? item._id.slice(-6))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-');
    return {
      candidate,
      qualifier,
      id: deterministicId('cmp', item._id, 'create_new'),
      keys: this.companies.identityKeysFor(candidate, qualifier),
    };
  }

  private async applyCompanyResolution(
    item: ReviewItemDoc,
    d: Decision,
    actor: Actor,
    session: ClientSession,
  ): Promise<JsonObject> {
    if (d.action === 'reject') {
      await this.observations.setCompanyResolution(
        item.observationIds,
        { state: 'rejected', reviewItemId: item._id, resolverVersion: 'operator' },
        { session },
      );
      return { rejectedObservations: item.observationIds.length };
    }
    if (d.action === 'merge') {
      // Resolved inside the review transaction (a concurrent merge → its survivor).
      const companyId = (await this.companies.resolveActive(this.target(item, d), session))._id;
      await this.observations.setCompanyResolution(
        item.observationIds,
        {
          state: 'resolved',
          entityId: companyId,
          method: 'operator_merge',
          confidence: 'high',
          reviewItemId: item._id,
          resolverVersion: 'operator',
        },
        { session },
      );
      await this.retryDependentJobObservations(item, session);
      return { companyId, attachedObservations: item.observationIds.length };
    }
    if (d.action === 'create_new') {
      const plan = await this.createNewPlan(item);
      const created = await this.companies.createFromCandidate(plan.candidate, {
        nameQualifier: plan.qualifier,
        id: plan.id,
        session,
      });
      if (!created)
        throw new InvalidStateError(
          'Could not create a distinct company (identity clash); try merge instead',
        );
      for (const c of item.candidates)
        await this.companies.markDistinct(created._id, c.id, actor, item._id, { session });
      await this.observations.setCompanyResolution(
        item.observationIds,
        {
          state: 'resolved',
          entityId: created._id,
          method: 'operator_create',
          confidence: 'high',
          reviewItemId: item._id,
          resolverVersion: COMPANY_RESOLVER_VERSION,
        },
        { session },
      );
      await this.retryDependentJobObservations(item, session);
      return { companyId: created._id };
    }
    throw invalid(`Unsupported action ${d.action}`);
  }

  /**
   * Job observations that were waiting on this company decision become pending again; the
   * next run of their source resolves them (observations are replay-safe).
   */
  private async retryDependentJobObservations(item: ReviewItemDoc, session: ClientSession): Promise<void> {
    await this.observations.jobObservations.updateMany(
      { 'resolution.state': 'review', 'resolution.reviewItemId': item._id },
      { $set: { 'resolution.state': 'pending', updatedAt: this.ctx.clock.now() } },
      { session },
    );
  }

  private async applyCompanyDuplicate(
    item: ReviewItemDoc,
    d: Decision,
    actor: Actor,
    session: ClientSession,
  ): Promise<JsonObject> {
    const other = this.target(item, d);
    if (d.action === 'keep_separate') {
      await this.companies.markDistinct(item.entity.id, other, actor, item._id, { session });
      return { distinct: [item.entity.id, other] };
    }
    if (d.action === 'merge') {
      // The older company survives (stable ids for downstream consumers).
      const [a, b] = await Promise.all([this.companies.get(item.entity.id), this.companies.get(other)]);
      const [into, from] = mergeOrder(a, b);
      await this.companies.merge(into._id, from._id, actor, d.reason, item._id, { session });
      return { survivorId: into._id, mergedId: from._id };
    }
    throw invalid(`Unsupported action ${d.action}`);
  }

  private async applyJobDuplicate(
    item: ReviewItemDoc,
    d: Decision,
    actor: Actor,
    session: ClientSession,
  ): Promise<JsonObject> {
    const other = this.target(item, d);
    if (d.action === 'keep_separate') {
      await this.jobs.col.updateOne(
        { _id: item.entity.id },
        { $addToSet: { distinctFrom: other } },
        { session },
      );
      await this.jobs.col.updateOne(
        { _id: other },
        { $addToSet: { distinctFrom: item.entity.id } },
        { session },
      );
      await this.audit.record(
        {
          actor,
          action: 'job.marked_distinct',
          entity: { kind: 'job', id: item.entity.id },
          reviewItemId: item._id,
          details: { other },
        },
        { session },
      );
      return { distinct: [item.entity.id, other] };
    }
    if (d.action === 'merge') {
      const [a, b] = await Promise.all([this.jobs.get(item.entity.id), this.jobs.get(other)]);
      const [into, from] = mergeOrder(a, b);
      const now = this.ctx.clock.now();
      if (from.status === 'merged' && from.mergedInto !== into._id) {
        throw new InvalidStateError(`Job ${from._id} is already merged into ${from.mergedInto}`);
      }
      // Guarded on `active`: a resumed or concurrent merge moves the source copies once.
      const moved = await this.jobs.col.updateOne(
        { _id: from._id, status: 'active' },
        {
          $set: { status: 'merged', mergedInto: into._id, sourceKeys: [], updatedAt: now },
          $inc: { rev: 1 },
        },
        { session },
      );
      if (moved.modifiedCount > 0) {
        await this.jobs.col.updateOne(
          { _id: into._id },
          {
            $addToSet: { sourceKeys: { $each: from.sourceKeys }, duplicateOf: from._id },
            $push: { sourceRefs: { $each: from.sourceRefs } },
            // A sponsorship decision survives the merge: the survivor's, else the merged job's
            // (DECISION_LOG a720377 (3)); its stating set still covers only what was decided.
            $set: {
              updatedAt: now,
              ...(!into.sponsorshipDecision && from.sponsorshipDecision
                ? { sponsorshipDecision: from.sponsorshipDecision }
                : {}),
            },
            $inc: { rev: 1 },
          },
          { session },
        );
        await this.observations.jobObservations.updateMany(
          { 'resolution.entityId': from._id },
          { $set: { 'resolution.entityId': into._id, 'resolution.method': 'operator_merge' } },
          { session },
        );
      }
      await this.audit.record(
        {
          actor,
          action: 'job.merged',
          entity: { kind: 'job', id: into._id },
          reviewItemId: item._id,
          // Stable across a resumed merge (from.sourceKeys is emptied by the merge itself).
          details: { mergedJobId: from._id, movedSourceKeys: from.sourceRefs.map((r) => r.key).sort() },
        },
        { session },
      );
      return { survivorId: into._id, mergedId: from._id };
    }
    throw invalid(`Unsupported action ${d.action}`);
  }

  /**
   * Dismissing a "stored override was not applied" review removes that stale override (PR #21
   * re-verify M3), so the question cannot come back on the next reconciliation. Only an override
   * that still carries a company-axis status is removed (a newer correction is kept). Audited.
   */
  private async removeStaleOverride(
    item: ReviewItemDoc,
    actor: Actor,
    session: ClientSession,
  ): Promise<JsonObject> {
    const field = String(item.context.override);
    const now = this.ctx.clock.now();
    // Read the removed override in the same atomic step, so the audit records what was removed.
    const before = await this.jobs.col.findOneAndUpdate(
      {
        _id: item.entity.id,
        [`overrides.${field}.value.status`]: { $in: ['company_capable', 'historical_evidence'] },
      },
      { $unset: { [`overrides.${field}`]: '' }, $set: { updatedAt: now }, $inc: { rev: 1 } },
      { session, returnDocument: 'before', projection: { [`overrides.${field}`]: 1 } },
    );
    const removed = (before?.overrides as Record<string, unknown> | undefined)?.[field];
    if (before)
      await this.audit.record(
        {
          actor,
          action: 'job.override_removed',
          entity: { kind: 'job', id: item.entity.id },
          reviewItemId: item._id,
          details: {
            field,
            reason: 'stale company-axis sponsorship override dismissed',
            // The override as it was stored ({ value, reason, actorId, at }), JSON-safe.
            removed: removed === undefined ? null : (JSON.parse(JSON.stringify(removed)) as JsonObject),
          },
        },
        { session },
      );
    return { removedOverride: before ? field : null };
  }

  private async applyCorrection(
    item: ReviewItemDoc,
    d: Decision,
    actor: Actor,
    session: ClientSession,
  ): Promise<JsonObject> {
    if (d.action !== 'correct') throw invalid(`Unsupported action ${d.action}`);
    if (!d.field || d.value === undefined) throw invalid('field and value are required for correct');
    if (item.entity.kind === 'job') {
      if (!JOB_OVERRIDABLE.has(d.field)) throw invalid(`Field ${d.field} cannot be corrected`);
      const now = this.ctx.clock.now();
      // The revision moves, so a reconciliation derived from the pre-override job cannot land.
      await this.jobs.col.updateOne(
        { _id: item.entity.id },
        {
          $set: {
            [`overrides.${d.field}`]: { value: d.value, reason: d.reason, actorId: actor.id, at: now },
            updatedAt: now,
          },
          $inc: { rev: 1 },
        },
        { session },
      );
      return { overridden: d.field };
    }
    if (item.entity.kind === 'company') {
      // Company corrections are recorded as operator observations so they flow through
      // the same reconciliation (with `operator` authority) and keep provenance.
      const operator = await this.sources.getByKey('system:operator');
      if (!operator) throw new InvalidStateError('Operator source missing; run migrations');
      const company = await this.companies.get(item.entity.id);
      const { observation } = await this.observations.recordCompanyObservation(
        {
          sourceId: operator._id,
          externalId: `${company._id}:${d.field}`,
          payload: operatorPayload(company, d.field, d.value) as never,
          parser: { name: 'operator-correction', version: '1' },
        },
        { session },
      );
      await this.observations.setCompanyResolution(
        [observation._id],
        {
          state: 'resolved',
          entityId: company._id,
          method: 'operator',
          confidence: 'high',
          reviewItemId: item._id,
          resolverVersion: 'operator',
        },
        { session },
      );
      return { correctedField: d.field, observationId: observation._id };
    }
    throw invalid(`Cannot correct ${item.entity.kind}`);
  }

  /**
   * Retry a source: the one effect outside Mongo. The effect committed here is the durable
   * retry intent — in the same generation-fenced transaction that records the decision as
   * `applied` — never the launch itself. A stale owner (or a decision released meanwhile)
   * commits no intent and so can never start a run; the run is started from the committed
   * intent by the dispatcher (outbox), keyed by the intent (one logical run).
   */
  private async applyRetry(
    item: ReviewItemDoc,
    op: ReviewOperationDoc,
    generation: number,
  ): Promise<ReviewOperationDoc> {
    if (op.decision.action !== 'retry') throw invalid(`Unsupported action ${op.decision.action}`);
    const sourceId = retrySourceId(item);
    if (!sourceId) throw new InvalidStateError('No source to retry');
    if (!this.launcher) throw new AppError('unavailable', 'Run launcher not available');
    const input = JSON.parse(JSON.stringify(item.context.retryInput ?? {})) as JsonObject;
    return this.commitEffects(op, generation, async (session) => {
      // Re-checked inside the fenced transaction: a source removed or disabled since the
      // validation releases the decision (nothing committed).
      const source = await this.sources.col.findOne({ _id: sourceId }, { session });
      if (!source) throw new InvalidStateError(`Source ${sourceId} no longer exists`);
      if (!source.enabled) throw new InvalidStateError(`Source ${source.key} is disabled`);
      const intent = await this.retryIntents.persist(
        {
          reviewItemId: item._id,
          operationId: op.operationId,
          generation,
          sourceId,
          actor: op.decisionActor,
          input,
        },
        session,
      );
      return { retryIntentId: intent._id, sourceId };
    });
  }

  /** Derived recompute after a decision's canonical effects (see `derive`). */
  private async recompute(item: ReviewItemDoc, op: ReviewOperationDoc): Promise<void> {
    const d = op.decision;
    const result = op.result ?? {};
    // A decided sponsorship conflict is re-derived at once (its flag becomes "decided").
    const decidedConflict = typeof result.decidedStating === 'number' || result.askAgain === true;
    if (
      !decidedConflict &&
      (d.action === 'dismiss' ||
        d.action === 'confirm' ||
        d.action === 'reject' ||
        d.action === 'keep_separate')
    )
      return;
    switch (item.type) {
      case 'company_resolution':
      case 'company_duplicate': {
        const companyId = (result.companyId ?? result.survivorId) as string | undefined;
        if (companyId) await this.companyReconciler.reconcile(companyId);
        return;
      }
      case 'job_duplicate': {
        const survivorId = result.survivorId as string | undefined;
        if (!survivorId) return;
        // The survivor now holds both jobs' copies: re-derive its lifecycle from their evidence
        // (DECISION_LOG 15c965b). Idempotent, so a resumed decision re-runs it harmlessly.
        await this.evidence?.recompute(survivorId);
        const merged = await this.jobs.get(survivorId);
        await this.jobReconciler.reconcile(merged, await this.companies.resolveActive(merged.companyId));
        return;
      }
      case 'field_conflict':
      case 'employment_conflict':
      case 'salary_suspicious':
        if (item.entity.kind === 'job') {
          const job =
            d.action === 'retry'
              ? await this.jobs.resolveActive(item.entity.id)
              : await this.jobs.get(item.entity.id);
          await this.jobReconciler.reconcile(job, await this.companies.resolveActive(job.companyId));
        } else if (item.entity.kind === 'company') {
          await this.companyReconciler.reconcile(item.entity.id);
        }
        return;
      default:
        return;
    }
  }
}

function lost(id: string): ConflictError {
  return new ConflictError(`Review item ${id}: resolution claim was lost (recovered by another resolver)`);
}

/** Fill in the implied target (a single candidate) so a stored decision is explicit. */
function normalizeDecision(item: ReviewItemDoc, d: ResolveReviewInput): Decision {
  const targetId =
    d.targetId ??
    (TARGETED.includes(d.action) && item.candidates.length === 1 ? item.candidates[0]?.id : undefined);
  return { action: d.action, reason: d.reason, targetId, field: d.field, value: d.value };
}

/** What an operator decision decides about a sponsorship conflict (a720377 (3)). */
type StatingDecision = Array<{
  copy?: string;
  observationId: string;
  value: 'yes' | 'no';
  scope?: string;
  line?: string;
}>;
type SponsorshipDecisionOutcome = StatingDecision | 'ask_again' | null;

/** The older entity survives a merge (stable ids for downstream consumers). */
function mergeOrder<T extends { createdAt: Date }>(a: T, b: T): [into: T, from: T] {
  return a.createdAt <= b.createdAt ? [a, b] : [b, a];
}

function retrySourceId(item: ReviewItemDoc): string | undefined {
  return item.entity.kind === 'source' ? item.entity.id : (item.context.sourceId as string | undefined);
}

/** The operator observation that carries a company correction. */
function operatorPayload(company: CompanyDoc, field: string, value: unknown): Record<string, unknown> {
  if (!COMPANY_CORRECTABLE.has(field))
    throw invalid(
      `Company field ${field} cannot be corrected in v0.1 (allowed: ${[...COMPANY_CORRECTABLE].join(', ')})`,
    );
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${field} must be a non-empty string`);
  const payload: Record<string, unknown> = {
    name: company.identity.displayName.value ?? company.identity.normalizedName,
    aliases: [],
    externalIds: [],
    locations: [],
    industries: [],
  };
  if (field === 'identity.domain') payload.domain = value;
  else if (field === 'identity.website') payload.website = value;
  else payload.name = value;
  return payload;
}

/** A job `field_conflict` raised for a stored override that reconciliation could not apply. */
function isStaleOverrideReview(item: ReviewItemDoc): boolean {
  return (
    item.type === 'field_conflict' && item.entity.kind === 'job' && typeof item.context.override === 'string'
  );
}
