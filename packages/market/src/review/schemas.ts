import { z } from 'zod';
import { jsonObjectSchema, jsonValueSchema } from '@aptamind/contracts';
import { defineCollection } from '@aptamind/db';
import { evidenceReferenceSchema } from '@aptamind/provenance';

export const REVIEW_SCHEMA_VERSION = 1;

export const REVIEW_TYPES = [
  'company_resolution', // candidate could not be safely resolved to one company
  'company_duplicate', // two canonical companies appear to be the same entity
  'job_duplicate', // uncertain duplicate / syndication
  'field_conflict', // material conflicting evidence on a canonical field
  'employment_conflict', // conflicting work-model / sponsorship evidence
  'salary_suspicious', // salary text could not be normalised safely
  'parser_failure', // source data could not be parsed
  'source_anomaly', // e.g. dataset shrank drastically; destructive updates held back
  'careers_discovery', // careers/ATS discovery ambiguous or failed
  'lifecycle_failure', // a job's lifecycle repeatedly could not be re-derived from its evidence
] as const;
export type ReviewType = (typeof REVIEW_TYPES)[number];

export const REVIEW_ACTIONS = [
  'confirm',
  'correct',
  'merge',
  'create_new',
  'keep_separate',
  'reject',
  'retry',
  'dismiss',
] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

/**
 * Why a claimed decision was released: `invalid_decision` — the decision itself cannot be
 * applied (input rules); `domain_conflict` — a domain precondition no longer holds (e.g. the
 * target was merged away or an identity clash appeared after the claim).
 */
export const REVIEW_FAILURE_KINDS = ['invalid_decision', 'domain_conflict'] as const;

/** Lifecycle of a review operation (see `reviewOperationDocSchema`). */
export const REVIEW_OPERATION_STATES = ['claimed', 'applied', 'finalized', 'completed', 'failed'] as const;
export type ReviewOperationState = (typeof REVIEW_OPERATION_STATES)[number];

export const reviewItemDocSchema = z.object({
  _id: z.string(),
  type: z.enum(REVIEW_TYPES),
  severity: z.enum(['low', 'medium', 'high']),
  /** Higher first. Derived from severity and business impact. */
  priority: z.number().int(),
  status: z.enum(['open', 'resolved', 'dismissed']),
  /** Idempotency: the same underlying question never produces two open items. */
  dedupeKey: z.string(),
  entity: z.object({ kind: z.enum(['company', 'job', 'observation', 'source']), id: z.string() }),
  subject: z.string(),
  reason: z.string(),
  evidence: z.array(evidenceReferenceSchema),
  candidates: z.array(
    z.object({
      kind: z.enum(['company', 'job']),
      id: z.string(),
      label: z.string(),
      score: z.number().optional(),
      details: jsonObjectSchema.optional(),
    }),
  ),
  observationIds: z.array(z.string()),
  /** Type-specific context (e.g. the unresolved candidate, the competing values). */
  context: jsonObjectSchema,
  allowedActions: z.array(z.enum(REVIEW_ACTIONS)),
  occurrences: z.number().int().positive(),
  /**
   * RESOLVING: an open item with a claim is being resolved by exactly one operation. Only a
   * decision that passed validation is ever claimed; the claim is taken atomically (only while
   * unclaimed); only its owner (current generation) may apply the decision and close the item;
   * the owner can resume with the same operation id after an interruption. A claim whose owner
   * stopped renewing it for `REVIEW_CLAIM_STALE_MS` (its resolver crashed) can be recovered by
   * another operation, which completes the stored decision — never a different one.
   * Informational: the operation record is authoritative.
   */
  claim: z
    .object({
      operationId: z.string(),
      actor: z.object({ kind: z.string(), id: z.string() }),
      action: z.enum(REVIEW_ACTIONS),
      reason: z.string(),
      targetId: z.string().optional(),
      field: z.string().optional(),
      value: jsonValueSchema.optional(),
      at: z.date(),
      /** Set when a stale claim was recovered: the interrupted operation and who recovered it. */
      recoveredFrom: z.string().optional(),
      recoveredBy: z.object({ kind: z.string(), id: z.string() }).optional(),
    })
    .optional(),
  /**
   * Advisory, cooperative triage claim (API-9, `review/triage.ts`): who is working on the open
   * item, until `expiresAt`. Not the resolution claim above; `resolve` does not require it. The
   * holder is a client token stored only as its hash; v0.1 has no user identities (ADR-0008).
   */
  assignment: z
    .object({
      holderHash: z.string(),
      actor: z.object({ kind: z.string(), id: z.string() }),
      claimedAt: z.date(),
      expiresAt: z.date(),
    })
    .optional(),
  /**
   * The last claimed decision that failed deterministically after its claim (e.g. its merge
   * target was merged away meanwhile). Its operation released the item: it stays open and a
   * corrected decision can be made.
   */
  lastFailure: z
    .object({
      operationId: z.string(),
      action: z.enum(REVIEW_ACTIONS),
      kind: z.enum(REVIEW_FAILURE_KINDS),
      code: z.string(),
      message: z.string(),
      at: z.date(),
    })
    .optional(),
  resolution: z
    .object({
      action: z.enum(REVIEW_ACTIONS),
      reason: z.string(),
      value: jsonValueSchema.optional(),
      targetId: z.string().optional(),
      actor: z.object({ kind: z.string(), id: z.string() }),
      at: z.date(),
      result: jsonObjectSchema.optional(),
      operationId: z.string().optional(),
    })
    .optional(),
  schemaVersion: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ReviewItemDoc = z.infer<typeof reviewItemDocSchema>;

export const reviewItemsCollection = defineCollection<ReviewItemDoc>({
  name: 'market_review_items',
  description: 'Human review queue for material ambiguity and conflicts.',
  schema: reviewItemDocSchema,
  schemaVersion: REVIEW_SCHEMA_VERSION,
  indexes: [
    {
      key: { dedupeKey: 1 },
      options: { name: 'uniq_open_dedupe', unique: true, partialFilterExpression: { status: 'open' } },
      rationale: 'At most one open review item per underlying question; retries re-use it.',
    },
    {
      key: { status: 1, priority: -1, createdAt: 1, _id: 1 },
      options: { name: 'by_status_priority' },
      rationale:
        'Review queue ordering (`sort=priority`, the open-queue default) with the `_id` tiebreak (keyset pagination).',
    },
    {
      key: { status: 1, createdAt: -1, _id: -1 },
      options: { name: 'list_created' },
      rationale: 'Review queue `sort=createdAt` and `createdAfter/Before` (keyset pagination).',
    },
    {
      key: { status: 1, updatedAt: -1, _id: -1 },
      options: { name: 'list_updated' },
      rationale: 'Review queue `sort=updatedAt` (the resolved/dismissed default; keyset pagination).',
    },
    {
      key: { 'context.sourceId': 1, status: 1 },
      // Partial, not sparse: a sparse compound index still holds every item (they all have `status`).
      options: {
        name: 'by_context_source',
        partialFilterExpression: { 'context.sourceId': { $exists: true } },
      },
      rationale:
        'Review queue `scopeId`: items whose retry source is the scope (parser/source problems); only items with a `context.sourceId` are indexed.',
    },
    {
      key: { 'entity.kind': 1, 'entity.id': 1, status: 1 },
      options: { name: 'by_entity' },
      rationale: 'Review state on company/job detail pages.',
    },
    {
      key: { 'candidates.id': 1, status: 1 },
      options: { name: 'by_candidate' },
      rationale: 'Open reviews referencing an entity as a candidate.',
    },
    {
      key: { type: 1, status: 1 },
      options: { name: 'by_type_status' },
      rationale: 'Backlog metrics by type.',
    },
  ],
});

const actorRefSchema = z.object({ kind: z.string(), id: z.string() });

/**
 * The durable resolution operation of one review item (one record per item: resolved items are
 * never reopened). It carries the stored decision, the domain-effect result, a generation that
 * fences the current owner, and an outbox for the post-decision effects:
 *
 *   (decision validated) → claimed G
 *     ──canonical effects + result, ONE transaction whose first write re-asserts G──► applied G
 *       (for `retry` the canonical effect is the durable retry intent — the source run itself
 *        is launched later from the intent, never directly by an owner)
 *     ──derived recompute; close item + finalize, one transaction fenced on G──► finalized
 *     ──retry dispatch + audit + workflow resume (outbox)──► completed
 *
 *   claimed G ──deterministic failure (nothing committed)──► failed ──new decision──► claimed G+1
 *   claimed/applied ──transient failure──► unchanged (lastError); resumed or recovered later
 *
 * Only the owner of the current generation can change domain state or advance the operation;
 * the owner renews `owner.at` (heartbeat) while working. A claim not renewed for the stale
 * window is recovered by advancing the generation, after which the old owner can no longer
 * write anything. Records are retained (never TTL-expired): they are the item's replay fence.
 */
export const reviewOperationDocSchema = z.object({
  /** The review item id. */
  _id: z.string(),
  /** The logical operation id of the decision (API: `api:<Idempotency-Key>`). Stable. */
  operationId: z.string(),
  generation: z.number().int().positive(),
  owner: z.object({ operationId: z.string(), actor: actorRefSchema, at: z.date() }),
  decision: z.object({
    action: z.enum(REVIEW_ACTIONS),
    reason: z.string(),
    targetId: z.string().optional(),
    field: z.string().optional(),
    value: jsonValueSchema.optional(),
  }),
  decisionActor: actorRefSchema,
  /** The evidence digest the decision was made on (If-Match), when one was sent. */
  shownEvidenceHash: z.string().optional(),
  state: z.enum(REVIEW_OPERATION_STATES),
  /** Result of the domain effects (e.g. the source run launched by `retry`), persisted first. */
  result: jsonObjectSchema.optional(),
  /**
   * Post-decision effects still owed. `retry` is present only for a `retry` decision: the
   * dispatch of its durable retry intent (see `reviewRetryIntentDocSchema`).
   */
  outbox: z.object({ audit: z.boolean(), resume: z.boolean(), retry: z.boolean().optional() }).optional(),
  /** Owners whose claims were recovered (most recent last; bounded). */
  recoveredFrom: z.array(z.string()).optional(),
  /** Set with state `failed`: why the decision was released (the item was re-opened for it). */
  failure: z
    .object({
      kind: z.enum(REVIEW_FAILURE_KINDS),
      code: z.string(),
      message: z.string(),
      at: z.date(),
      generation: z.number().int().positive(),
    })
    .optional(),
  /** The last transient failure while applying (the operation stays recoverable). */
  lastError: z
    .object({ message: z.string(), at: z.date(), generation: z.number().int().positive() })
    .optional(),
  schemaVersion: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
  completedAt: z.date().optional(),
});
export type ReviewOperationDoc = z.infer<typeof reviewOperationDocSchema>;

export const reviewOperationsCollection = defineCollection<ReviewOperationDoc>({
  name: 'market_review_operations',
  description: 'Durable review resolution operations: decision, effect results, generation, outbox.',
  schema: reviewOperationDocSchema,
  schemaVersion: REVIEW_SCHEMA_VERSION,
  indexes: [
    {
      key: { operationId: 1 },
      options: { name: 'uniq_operation', unique: true },
      rationale: 'One logical decision per operation id (Idempotency-Key replays find it).',
    },
    {
      key: { state: 1, 'owner.at': 1 },
      options: { name: 'by_state_owner_at' },
      rationale:
        'Recovery relay: claimed/applied/finalized operations whose owner went silent (state $in, never completed/failed history).',
    },
  ],
});

/**
 * Durable authority to launch the source run of a `retry` review decision (transactional
 * outbox). Written ONLY inside the generation-fenced transaction that moves the item's
 * operation from `claimed` to `applied`, so it exists iff the retry decision won: an owner that
 * lost its generation (or a decision that was released) commits no intent and can never cause
 * a run. An `applied` operation is never released or re-decided, so a committed intent stays
 * valid; the dispatcher still re-checks that the intent's operation is the item's decided
 * `retry` (a monotonic predicate) and cancels an intent that is not.
 *
 *   pending ──dispatch (attempt recorded)──► dispatching ──run started──► delivered
 *   pending/dispatching ──operation is not the decided retry──► cancelled (never launches)
 *   pending/dispatching ──source missing/disabled (deterministic)──► failed (never launches)
 *
 * Exactly one logical run per intent: the run is started with `idempotencyKey` (unique in the
 * workflow run store), so a re-dispatch after a crash — or concurrent dispatchers — return the
 * same run.
 */
export const REVIEW_RETRY_INTENT_STATES = [
  'pending',
  'dispatching',
  'delivered',
  'cancelled',
  'failed',
] as const;

export const reviewRetryIntentDocSchema = z.object({
  /** Deterministic: `deterministicId('rri', reviewItemId, operationId)`. */
  _id: z.string(),
  reviewItemId: z.string(),
  /** The logical decision (the operation's stable `operationId`) this intent belongs to. */
  operationId: z.string(),
  /** The generation whose fenced transaction committed the intent. */
  generation: z.number().int().positive(),
  sourceId: z.string(),
  actor: actorRefSchema,
  input: jsonObjectSchema,
  /** The run's idempotency key: one logical run per intent. */
  idempotencyKey: z.string(),
  state: z.enum(REVIEW_RETRY_INTENT_STATES),
  attempts: z.number().int().min(0),
  lastAttemptAt: z.date().optional(),
  runId: z.string().optional(),
  deliveredAt: z.date().optional(),
  lastError: z.object({ message: z.string(), at: z.date() }).optional(),
  /** Why the intent was cancelled or failed (terminal; it never launches). */
  terminalReason: z.string().optional(),
  schemaVersion: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ReviewRetryIntentDoc = z.infer<typeof reviewRetryIntentDocSchema>;

export const reviewRetryIntentsCollection = defineCollection<ReviewRetryIntentDoc>({
  name: 'market_review_retry_intents',
  description:
    'Durable, generation-bound intents to launch the source run of a review retry decision (outbox).',
  schema: reviewRetryIntentDocSchema,
  schemaVersion: REVIEW_SCHEMA_VERSION,
  indexes: [
    {
      key: { reviewItemId: 1 },
      options: { name: 'by_review_item' },
      rationale: 'The retry intent of a review item.',
    },
    {
      key: { state: 1, updatedAt: 1 },
      options: { name: 'by_state_updated' },
      rationale: 'Dispatcher sweep: undelivered (pending/dispatching) intents, oldest first.',
    },
  ],
});

export const auditEventDocSchema = z.object({
  _id: z.string(),
  at: z.date(),
  actor: z.object({ kind: z.string(), id: z.string() }),
  action: z.string(),
  entity: z.object({ kind: z.string(), id: z.string() }),
  reviewItemId: z.string().optional(),
  runId: z.string().optional(),
  details: jsonObjectSchema,
  schemaVersion: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type AuditEventDoc = z.infer<typeof auditEventDocSchema>;

export const auditEventsCollection = defineCollection<AuditEventDoc>({
  name: 'market_audit_events',
  description:
    'Append-only audit log of operator and system decisions (merges, overrides, review resolutions).',
  schema: auditEventDocSchema,
  schemaVersion: REVIEW_SCHEMA_VERSION,
  indexes: [
    {
      key: { 'entity.kind': 1, 'entity.id': 1, at: -1, _id: -1 },
      options: { name: 'by_entity_time' },
      rationale: 'Entity audit history.',
    },
    { key: { at: -1 }, options: { name: 'by_time' }, rationale: 'Recent audit events.' },
    {
      key: { reviewItemId: 1 },
      options: { name: 'by_review', sparse: true },
      rationale: 'Audit trail of a review decision.',
    },
  ],
});
