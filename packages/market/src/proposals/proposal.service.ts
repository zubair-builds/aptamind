import { createHash } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import { z } from 'zod';
import {
  type Actor,
  AppError,
  ConflictError,
  deterministicId,
  InvalidStateError,
  type JsonObject,
  NotFoundError,
} from '@aptamind/contracts';
import type { MarketDomain } from '../market-domain';
import {
  assertImportSource,
  checkImportTarget,
  cleanFileName,
  createImport,
} from '../imports/import.service';
import { IMPORT_TYPES, type ImportType } from '../imports/import.schema';
import type { AuditLog } from '../review/audit';
import type { ReviewRepository } from '../review/review.repository';
import type { ReviewItemDoc, ReviewOperationDoc } from '../review/schemas';
import { type CreateSourceInput, normalizeCreateSource } from '../sources/source.service';

/**
 * Agent proposals (MCP and other callers) may only *propose*. A human approves through the
 * existing review resolve flow (`create_new`). Reject and dismiss write nothing canonical.
 *
 * Two phases, the same shape as a review `retry`:
 *
 *   1. The generation-fenced transaction records `result.approved` (and, for an import, the
 *      deterministic `plannedImportId` / `runIdempotencyKey`) and writes nothing canonical.
 *      A missing, disabled, or wrong-type source at this moment releases the decision: the
 *      item stays open, and nothing is registered or imported.
 *   2. After commit, the outbox calls `SourceService.register` or `createImport`. `register`
 *      is idempotent on key. `createImport` is called with the planned id and run idempotency
 *      key, so a replay returns the same import and the same run.
 *
 * If phase 2 throws — process crash, the source disabled after the commit, the staged artifact
 * unreadable — the item is already resolved, `outbox.proposal` stays false, and
 * `result.effectApplied` is unset. Retry `resolve` with the same operation id, or call
 * `resumeApproved`. That runs phase 2 again and does not double-register or double-import.
 * A source that stays disabled keeps the effect pending until it is fixed and resume is called;
 * the review recovery sweep retries the outbox with the other undelivered decisions.
 * Reject and dismiss never enter phase 2.
 */

/** Bytes an import proposal may stage. Checked before the artifact is stored. */
export const IMPORT_PROPOSAL_MAX_BYTES = 5 * 1024 * 1024;
/** Review `reason` / `subject` ceiling. Resolve reasons are at most 2000. */
export const PROPOSAL_REASON_MAX = 2000;
export const PROPOSAL_SUBJECT_MAX = 300;

const PROPOSAL_ACTIONS = ['create_new', 'reject', 'dismiss'] as const;
/** Marker that an idempotency key was spent, whatever the proposal was. */
const PROPOSAL_REQUEST_ACTION = 'proposal.request';

export function sourceProposalDedupeKey(key: string): string {
  return `proposal:source:${key}`;
}

export function importProposalDedupeKey(sha256: string, sourceId: string, type: string): string {
  return `proposal:import:${type}:${sha256}:${sourceId}`;
}

export function boundProposalText(text: string, max = PROPOSAL_REASON_MAX): string {
  return text.length <= max ? text : text.slice(0, max);
}

/** Throws `limit_exceeded` above {@link IMPORT_PROPOSAL_MAX_BYTES}. The limit itself is allowed. */
export function assertProposalBodySize(bytes: number): void {
  if (!Number.isInteger(bytes) || bytes < 0)
    throw new AppError('validation_failed', 'Import proposal body size is not a byte length');
  if (bytes > IMPORT_PROPOSAL_MAX_BYTES)
    throw new AppError(
      'limit_exceeded',
      `Import proposal is ${bytes} bytes; the limit is ${IMPORT_PROPOSAL_MAX_BYTES}`,
      { bytes, limit: IMPORT_PROPOSAL_MAX_BYTES },
    );
}

/** Non-empty line count for text, csv and json. Omitted for other types (not a parsed row count). */
export function textRowCount(body: Uint8Array, contentType: string): number | undefined {
  const ct = contentType.toLowerCase();
  if (!ct.startsWith('text/') && !ct.includes('csv') && !ct.includes('json')) return undefined;
  const text = new TextDecoder().decode(body);
  if (!text) return 0;
  let n = 0;
  for (const line of text.split(/\r?\n/)) if (line.trim()) n += 1;
  return n;
}

const importProposalContextSchema = z.object({
  type: z.enum(IMPORT_TYPES),
  sourceId: z.string().min(1),
  fileName: z.string().min(1).max(255).optional(),
  contentType: z.string().min(1).max(200),
  artifactId: z.string().min(1),
  sha256: z.string().length(64),
  size: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative().optional(),
});
export type ImportProposalContext = z.infer<typeof importProposalContextSchema>;

export function sourceProposalInput(context: JsonObject): CreateSourceInput {
  const input = context.input;
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new AppError('validation_failed', 'Source proposal is missing its input');
  return input as CreateSourceInput;
}

export function importProposalContext(context: unknown): ImportProposalContext {
  const parsed = importProposalContextSchema.safeParse(context);
  if (!parsed.success)
    throw new AppError(
      'validation_failed',
      `Import proposal context is invalid: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    );
  return parsed.data;
}

/**
 * What `ReviewService` calls for an approved proposal. `assertApprovable` runs inside the
 * generation-fenced transaction (no canonical writes). `executeApproved` runs after commit.
 */
export interface ProposalEffectPort {
  assertApprovable(item: ReviewItemDoc, op: ReviewOperationDoc, session: ClientSession): Promise<JsonObject>;
  executeApproved(item: ReviewItemDoc, op: ReviewOperationDoc): Promise<JsonObject>;
}

export interface ProposalResult {
  item: ReviewItemDoc;
  /** True only when this call inserted the review item. */
  created: boolean;
}

function requestEntity(idempotencyKey: string) {
  return { kind: 'proposal_request', id: idempotencyKey };
}

function requireIdempotencyKey(key: string): string {
  if (typeof key !== 'string' || key.length < 1 || key.length > 200)
    throw new AppError('validation_failed', 'idempotencyKey must be 1–200 characters', {
      param: 'idempotencyKey',
    });
  return key;
}

function jsonClone(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function bodyBytes(body: Uint8Array | string): Uint8Array {
  return typeof body === 'string' ? new TextEncoder().encode(body) : body;
}

/**
 * Raises `source_proposal` and `import_proposal` review items. Canonical registration and
 * import happen only when a human resolves the item with `create_new`.
 */
export class ProposalService implements ProposalEffectPort {
  constructor(
    private readonly reviews: ReviewRepository,
    private readonly audit: AuditLog,
    private readonly market: MarketDomain,
  ) {}

  /**
   * Validate `input` and raise a `source_proposal`. The source is not registered.
   * `enabled` is stored as given (schema default true when omitted), never forced off.
   * One open item per source key. The same `idempotencyKey` returns that item and writes
   * one audit event; a key reused for a different proposal is a conflict.
   */
  async proposeSource(
    input: CreateSourceInput,
    actor: Actor,
    opts: { idempotencyKey: string },
  ): Promise<ProposalResult> {
    const idempotencyKey = requireIdempotencyKey(opts.idempotencyKey);
    const { parsed, authority } = normalizeCreateSource(input);
    const stored = jsonClone({ ...parsed, authority });
    const dedupeKey = sourceProposalDedupeKey(parsed.key);
    const entity = { kind: 'source' as const, id: parsed.key };
    const replay = await this.replay(idempotencyKey, dedupeKey);
    if (replay) return replay;
    const { item, created } = await this.reviews.raise({
      type: 'source_proposal',
      severity: 'low',
      dedupeKey,
      entity,
      subject: boundProposalText(`Proposed source ${parsed.key}`, PROPOSAL_SUBJECT_MAX),
      reason: boundProposalText(
        `Proposed source "${parsed.name}" (${parsed.key}) awaits approval before it is registered.`,
      ),
      context: { input: stored },
      allowedActions: [...PROPOSAL_ACTIONS],
    });
    await this.finishPropose(
      idempotencyKey,
      dedupeKey,
      item,
      created,
      actor,
      'proposal.source_proposed',
      entity,
      { key: parsed.key },
    );
    return { item, created };
  }

  /**
   * Stage `body` as a content-addressed artifact and raise an `import_proposal`.
   * No snapshot, import record, or source run. `checkImportTarget` runs first; a refusal
   * stores nothing. The same bytes and source reuse one open item (`proposal:import:<sha256>:<sourceId>`).
   */
  async proposeImport(
    input: {
      type: ImportType;
      sourceId: string;
      fileName?: string;
      body: Uint8Array | string;
      contentType: string;
    },
    actor: Actor,
    opts: { idempotencyKey: string },
  ): Promise<ProposalResult> {
    const idempotencyKey = requireIdempotencyKey(opts.idempotencyKey);
    const type = z.enum(IMPORT_TYPES).safeParse(input.type);
    if (!type.success) throw new AppError('validation_failed', 'Unknown import type', { param: 'type' });
    if (typeof input.sourceId !== 'string' || !input.sourceId)
      throw new AppError('validation_failed', 'sourceId is required', { param: 'sourceId' });
    if (
      typeof input.contentType !== 'string' ||
      input.contentType.length < 1 ||
      input.contentType.length > 200
    )
      throw new AppError('validation_failed', 'contentType must be 1–200 characters', {
        param: 'contentType',
      });
    const bytes = bodyBytes(input.body);
    assertProposalBodySize(bytes.byteLength);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const dedupeKey = importProposalDedupeKey(sha256, input.sourceId, input.type);
    const entity = { kind: 'source' as const, id: input.sourceId };
    const replay = await this.replay(idempotencyKey, dedupeKey);
    if (replay) return replay;
    // Refusal leaves no artifact (same rule as a snapshot upload).
    await checkImportTarget(this.market, type.data, input.sourceId);
    const artifact = await this.market.ctx.artifacts.put(bytes, input.contentType, {
      labels: { sourceId: input.sourceId, via: 'proposal' },
    });
    const fileName = input.fileName !== undefined ? cleanFileName(input.fileName) : undefined;
    const rowCount = textRowCount(bytes, input.contentType);
    const context: JsonObject = {
      type: type.data,
      sourceId: input.sourceId,
      contentType: input.contentType,
      artifactId: artifact.artifactId,
      sha256: artifact.sha256,
      size: artifact.size,
      ...(fileName ? { fileName } : {}),
      ...(rowCount !== undefined ? { rowCount } : {}),
    };
    const label = fileName ?? 'upload';
    const { item, created } = await this.reviews.raise({
      type: 'import_proposal',
      severity: 'low',
      dedupeKey,
      entity,
      subject: boundProposalText(`Proposed ${type.data} import ${label}`, PROPOSAL_SUBJECT_MAX),
      reason: boundProposalText(
        `Proposed ${type.data} import of ${label} (${artifact.size} bytes) for source ${input.sourceId} is staged and will not run until a reviewer approves it.`,
      ),
      evidence: [
        {
          sourceId: input.sourceId,
          artifactId: artifact.artifactId,
          observedAt: this.market.ctx.clock.now(),
          locator: 'import-proposal',
        },
      ],
      context,
      allowedActions: [...PROPOSAL_ACTIONS],
    });
    await this.finishPropose(
      idempotencyKey,
      dedupeKey,
      item,
      created,
      actor,
      'proposal.import_proposed',
      entity,
      { sha256: artifact.sha256, artifactId: artifact.artifactId, type: type.data },
    );
    return { item, created };
  }

  /**
   * Run a committed approval whose post-commit effect did not finish. Also reached by
   * `resolve` with the same operation id (the outbox is delivered either way).
   */
  async resumeApproved(itemId: string): Promise<ReviewItemDoc> {
    const op = await this.market.reviewService.operations.findOne({ _id: itemId });
    if (!op) throw new NotFoundError('ReviewOperation', itemId);
    if (op.result?.approved !== true)
      throw new InvalidStateError(`Review item ${itemId} has no committed proposal approval to resume`);
    return this.market.reviewService.deliverDecided(itemId);
  }

  /** Inside the fenced transaction: re-check, then return the plan stored on the operation. */
  async assertApprovable(
    item: ReviewItemDoc,
    op: ReviewOperationDoc,
    session: ClientSession,
  ): Promise<JsonObject> {
    if (item.type === 'source_proposal') {
      const normalized = normalizeCreateSource(sourceProposalInput(item.context));
      return { kind: 'source', key: normalized.parsed.key };
    }
    if (item.type === 'import_proposal') {
      const ctx = importProposalContext(item.context);
      const source = await this.market.sources.col.findOne({ _id: ctx.sourceId }, { session });
      if (!source) throw new NotFoundError('Source', ctx.sourceId);
      assertImportSource(source, ctx.type);
      const artifact = await this.market.ctx.artifacts.get(ctx.artifactId);
      if (artifact.deletedAt) throw new InvalidStateError(`Staged artifact ${ctx.artifactId} was deleted`);
      if (artifact.sha256 !== ctx.sha256)
        throw new AppError('validation_failed', 'Staged artifact does not match the proposal', {
          artifactId: ctx.artifactId,
        });
      return {
        kind: 'import',
        plannedImportId: deterministicId('imp', 'proposal', item._id, op.operationId),
        runIdempotencyKey: `proposal-import:${item._id}:${op.operationId}`,
        sourceId: ctx.sourceId,
        artifactId: ctx.artifactId,
      };
    }
    throw new AppError('validation_failed', `Not a proposal review (${item.type})`);
  }

  /**
   * After the approval commits. Idempotent: a second call registers the same source or
   * returns the import already created for `plannedImportId`.
   */
  async executeApproved(item: ReviewItemDoc, op: ReviewOperationDoc): Promise<JsonObject> {
    const actor = op.decisionActor as Actor;
    if (item.type === 'source_proposal') {
      const { source, created } = await this.market.sources.register(
        sourceProposalInput(item.context),
        actor,
      );
      return { effectApplied: true, sourceId: source._id, created, key: source.key };
    }
    if (item.type === 'import_proposal') {
      const ctx = importProposalContext(item.context);
      const plannedImportId =
        typeof op.result?.plannedImportId === 'string'
          ? op.result.plannedImportId
          : deterministicId('imp', 'proposal', item._id, op.operationId);
      const runIdempotencyKey =
        typeof op.result?.runIdempotencyKey === 'string'
          ? op.result.runIdempotencyKey
          : `proposal-import:${item._id}:${op.operationId}`;
      // Checked again at execution. A disabled or wrong-type source throws; the outbox stays
      // pending so resume can succeed once the source is fixed. Nothing is stored on that throw
      // (`createImport` checks before it uploads).
      await checkImportTarget(this.market, ctx.type, ctx.sourceId);
      const body = await this.market.ctx.artifacts.readBytes({
        artifactId: ctx.artifactId,
        sha256: ctx.sha256,
      });
      const doc = await createImport(
        this.market,
        {
          type: ctx.type,
          sourceId: ctx.sourceId,
          ...(ctx.fileName ? { fileName: ctx.fileName } : {}),
          body,
          contentType: ctx.contentType,
          id: plannedImportId,
          runIdempotencyKey,
        },
        actor,
      );
      return {
        effectApplied: true,
        importId: doc._id,
        snapshotId: doc.snapshotId,
        runId: doc.runId,
        artifactId: doc.artifactId,
      };
    }
    throw new AppError('validation_failed', `Not a proposal review (${item.type})`);
  }

  /** A spent idempotency key returns its review item, or conflicts when the proposal differs. */
  private async replay(idempotencyKey: string, dedupeKey: string): Promise<ProposalResult | null> {
    const marker = await this.audit.findOnce(
      idempotencyKey,
      PROPOSAL_REQUEST_ACTION,
      requestEntity(idempotencyKey),
    );
    if (!marker) return null;
    const prior = marker.details.dedupeKey;
    const reviewItemId = marker.details.reviewItemId;
    if (typeof prior !== 'string' || typeof reviewItemId !== 'string') return null;
    if (prior !== dedupeKey)
      throw new ConflictError(`Idempotency key was already used for ${prior}`, { dedupeKey: prior });
    return { item: await this.reviews.get(reviewItemId), created: false };
  }

  private async finishPropose(
    idempotencyKey: string,
    dedupeKey: string,
    item: ReviewItemDoc,
    created: boolean,
    actor: Actor,
    action: 'proposal.source_proposed' | 'proposal.import_proposed',
    entity: { kind: 'source'; id: string },
    details: JsonObject,
  ): Promise<void> {
    await this.audit.record({
      actor,
      action,
      entity,
      reviewItemId: item._id,
      onceKey: `${idempotencyKey}:${dedupeKey}`,
      details: { dedupeKey, reviewItemId: item._id, ...details },
    });
    await this.audit.record({
      actor,
      action: PROPOSAL_REQUEST_ACTION,
      entity: requestEntity(idempotencyKey),
      reviewItemId: item._id,
      onceKey: idempotencyKey,
      details: { dedupeKey, reviewItemId: item._id, proposal: action },
    });
    const stored = await this.audit.findOnce(
      idempotencyKey,
      PROPOSAL_REQUEST_ACTION,
      requestEntity(idempotencyKey),
    );
    if (stored && stored.details.dedupeKey !== dedupeKey) {
      // Lost a race with another proposal on this key: drop the item this call just inserted.
      if (created)
        await this.reviews.col.deleteOne({ _id: item._id, status: 'open', occurrences: 1, dedupeKey });
      throw new ConflictError(`Idempotency key was already used for ${String(stored.details.dedupeKey)}`, {
        dedupeKey: stored.details.dedupeKey,
      });
    }
  }
}
