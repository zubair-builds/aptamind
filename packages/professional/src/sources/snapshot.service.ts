import { createHash } from 'node:crypto';
import type { Collection, Filter } from 'mongodb';
import { z, ZodError } from 'zod';
import { type Actor, deterministicId, newId } from '@aptamind/contracts';
import { getCollection, isDuplicateKeyError, validateDocument, withTransaction } from '@aptamind/db';
import { metrics } from '@aptamind/observability';
import { notFound, ProfessionalError } from '../api/errors';
import { type CursorPage, cursorQuery, pageParamsShape, toPage } from '../api/pagination';
import type { ProfessionalContext } from '../context';
import type { EventStore, NewEvent } from '../events/event.store';
import { PROFESSIONAL_ARTIFACT_LABELS } from '../privacy/artifacts';
import type { SubjectService } from '../subjects/subject.service';
import { SOURCE_KIND_POLICIES } from './policies';
import {
  ACQUISITION_SCHEMA_VERSION,
  type AcquisitionDoc,
  acquisitionsCollection,
  SNAPSHOT_SCHEMA_VERSION,
  type SnapshotDoc,
  snapshotsCollection,
  type SourceDoc,
} from './source.schema';
import type { SourceService } from './source.service';
import { checkUpload, tooLarge } from './upload';

/** Earliest document date an operator may declare. */
const MIN_DECLARED_AS_OF = new Date('1950-01-01T00:00:00Z');
const DAY_MS = 86_400_000;

/** `POST /api/professional/sources/:id/uploads` query: the optional declared document date. */
export const uploadQuerySchema = z.strictObject({
  /** The document's own date (`YYYY-MM-DD`), when the operator knows it (ADR-0019). */
  declaredAsOf: z.iso.date().optional(),
  /** `include=sensitive`: return the content hash and artifact reference (see `api/present.ts`). */
  include: z.enum(['sensitive']).optional(),
});

/** `GET /api/professional/sources/:id/snapshots` query: page parameters only. */
export const listSnapshotsQuerySchema = z.strictObject({
  include: z.enum(['sensitive']).optional(),
  ...pageParamsShape,
});

export interface UploadInput {
  bytes: Uint8Array;
  /** The request's declared media type (`Content-Type`). */
  contentType: string | undefined;
  /** The document's own date, when declared (UTC midnight). */
  declaredAsOf?: Date;
}

/** Upload outcomes, the only label values of `professional_uploads_total` besides the kind. */
export type UploadOutcome =
  | 'created'
  | 'reacquired'
  | 'replayed'
  | 'upload_too_large'
  | 'unsupported_media_type'
  | 'validation_failed'
  | 'not_found'
  | 'subject_archived'
  | 'conflict'
  | 'error';

interface UploadResult {
  snapshot: SnapshotDoc;
  created: boolean;
  outcome: 'created' | 'reacquired' | 'replayed';
}

/**
 * Snapshots of uploaded documents (R-3, R-4): limits and media type are checked before any byte
 * is stored; bytes are stored content-addressed and private (`PROFESSIONAL_ARTIFACT_LABELS`,
 * written directly through the `ArtifactStore`, never as runtime outputs, so no run correlation
 * label reaches them); identical bytes of a source are one snapshot (`det(sourceId, hash)`).
 *
 * Idempotency: every accepted acquisition is a row in the `professional_acquisitions` ledger,
 * inserted in the acquiring transaction; an Idempotency-Key fixes the row's id, so the same key
 * binds one acquisition forever — the same bytes, type and declared date replay (nothing
 * counts), anything else is 409 `conflict`, also when the two race.
 *
 * Chronology (ADR-0019; supervisor ruling): a declared date is authoritative. The first
 * declaration on an `acquired` snapshot converts it to `declared` (`sourceAsOf = declaredAsOf`,
 * even if earlier), keeping the replaced value in `previousSourceAsOf` and an evented
 * `snapshot.dated`; a different declared date on a `declared` snapshot is 409 `conflict`
 * (`declared_date_mismatch`). An undated re-upload is a re-acquisition: it counts, moves
 * `lastAcquiredAt`, and moves an `acquired` `sourceAsOf` forward (A → B → A makes A current).
 * Reprocessing never touches either.
 */
export class SnapshotService {
  readonly col: Collection<SnapshotDoc>;
  readonly acquisitions: Collection<AcquisitionDoc>;

  constructor(
    private readonly ctx: ProfessionalContext,
    private readonly subjects: SubjectService,
    private readonly sources: SourceService,
    private readonly events: EventStore,
  ) {
    this.col = getCollection(ctx.db, snapshotsCollection);
    this.acquisitions = getCollection(ctx.db, acquisitionsCollection);
  }

  async upload(
    sourceId: string,
    input: UploadInput,
    actor: Actor,
    idempotencyKey?: string,
  ): Promise<{ snapshot: SnapshotDoc; created: boolean }> {
    let kind = 'unknown';
    try {
      const source = await this.sources.get(sourceId);
      kind = source.kind;
      if (source.acquisition !== 'upload')
        throw new ProfessionalError('validation_failed', 'Source does not accept uploads', {
          field: 'acquisition',
        });
      if (source.status !== 'active')
        throw new ProfessionalError('validation_failed', 'Source is not active', { field: 'source' });
      const checked = checkUpload(
        input.bytes,
        input.contentType,
        SOURCE_KIND_POLICIES[source.kind].uploadMimeTypes,
        { maxBytes: this.ctx.config.limits.maxUploadBytes, maxPages: source.policy.maxPages },
      );
      const prepared = { bytes: input.bytes, ...checked, via: 'upload' as const };
      const { snapshot, created, outcome } = await this.acquire(
        source,
        prepared,
        input.declaredAsOf,
        actor,
        idempotencyKey,
      );
      countUpload(outcome, kind);
      return { snapshot, created };
    } catch (err) {
      countUpload(err instanceof ProfessionalError ? outcomeOf(err.code) : 'error', kind);
      throw err;
    }
  }

  /**
   * Stores a structured form (canonical JSON, validated by the caller) as a `form` snapshot of a
   * `structured_input` source — same content addressing, ledger, fence and chronology as uploads
   * (a form is dated by when it was received).
   */
  async submitForm(
    source: SourceDoc,
    formJson: string,
    actor: Actor,
    idempotencyKey?: string,
  ): Promise<{ snapshot: SnapshotDoc; created: boolean }> {
    if (source.acquisition !== 'structured_input')
      throw new ProfessionalError('validation_failed', 'Source does not accept statements', {
        field: 'sourceId',
      });
    if (source.status !== 'active')
      throw new ProfessionalError('validation_failed', 'Source is not active', { field: 'source' });
    const bytes = new TextEncoder().encode(formJson);
    if (bytes.byteLength > this.ctx.config.limits.maxUploadBytes) throw tooLarge('bytes');
    const prepared = {
      bytes,
      mimeType: 'application/json',
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      via: 'form' as const,
    };
    const { snapshot, created } = await this.acquire(source, prepared, undefined, actor, idempotencyKey);
    return { snapshot, created };
  }

  private async acquire(
    source: SourceDoc,
    checked: PreparedBytes,
    declaredAsOf: Date | undefined,
    actor: Actor,
    idempotencyKey?: string,
  ): Promise<UploadResult> {
    const now = this.ctx.clock.now();
    // Up to "tomorrow" in UTC: an operator east of UTC may legitimately date a document today.
    const latest = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS + DAY_MS);
    if (declaredAsOf && (declaredAsOf < MIN_DECLARED_AS_OF || declaredAsOf > latest))
      throw new ProfessionalError('validation_failed', 'declaredAsOf out of range', {
        field: 'declaredAsOf',
      });

    const acquisitionId = idempotencyKey
      ? deterministicId('pacq', source._id, 'idem', idempotencyKey)
      : newId('pacq');
    const bindingHash = createHash('sha256')
      .update(`${checked.contentHash}\n${checked.mimeType}\n${declaredAsOf?.toISOString() ?? ''}`)
      .digest('hex');
    // A key replay returns its snapshot (also after an archive) and stores nothing.
    if (idempotencyKey) {
      const replay = await this.replayOf(acquisitionId, bindingHash);
      if (replay) return replay;
    }
    const subject = await this.subjects.get(source.subjectId);
    if (subject.status !== 'active')
      throw new ProfessionalError('subject_archived', 'Subject is archived', { id: subject._id });

    // Bytes first (a snapshot never references missing content), private and content-addressed.
    // A failure after this leaves Professional-labelled bytes no snapshot references (never
    // served; erasure sweeps them — domain doc §13); content addressing forbids deleting here.
    const artifact = await this.ctx.artifacts.put(checked.bytes, checked.mimeType, {
      labels: { ...PROFESSIONAL_ARTIFACT_LABELS },
    });
    const ctx: AcquisitionContext = {
      source,
      acquisitionId,
      keyed: idempotencyKey !== undefined,
      bindingHash,
      artifact,
      checked,
      declaredAsOf,
      now,
      actor,
    };
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.record(ctx);
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        // The key's acquisition committed concurrently: a replay, or a conflict.
        if (ctx.keyed) {
          const replay = await this.replayOf(acquisitionId, bindingHash);
          if (replay) return replay;
        }
        // Two first uploads of identical bytes raced on the unique (sourceId, contentHash) index:
        // the loser re-runs and finds the winner's snapshot — a re-acquisition.
        if (attempt >= 2) throw err;
      }
    }
  }

  private record(a: AcquisitionContext): Promise<UploadResult> {
    const { source, acquisitionId, declaredAsOf, now } = a;
    const subjectId = source.subjectId;
    return withTransaction(this.ctx.db.client, async (session) => {
      // De-duplication is internal: the unique (sourceId, contentHash) index. Snapshot ids are
      // random, so no id (and no id derived from one) reveals or confirms the content.
      const existing = await this.col.findOne(
        { sourceId: source._id, contentHash: a.checked.contentHash },
        { session },
      );
      const snapshotId = existing?._id ?? newId('psnap');
      if (
        existing &&
        declaredAsOf &&
        existing.sourceAsOfKind === 'declared' &&
        existing.sourceAsOf.getTime() !== declaredAsOf.getTime()
      )
        throw new ProfessionalError('conflict', 'A different document date is already declared', {
          reason: 'declared_date_mismatch',
          id: snapshotId,
        });
      // Fence: the subject is still active. Writing the subject document also makes every
      // acquisition of the subject conflict with a concurrent archive (and with each other: a
      // subject's uploads serialise here, retried by the transaction — fine at operator rates).
      const fenced = await this.subjects.col.updateOne(
        { _id: subjectId, status: 'active' },
        { $inc: { acquisitionCount: 1 } },
        { session },
      );
      if (!fenced.matchedCount)
        throw new ProfessionalError('subject_archived', 'Subject is archived', { id: subjectId });
      // The ledger row binds the Idempotency-Key; a duplicate id aborts the transaction.
      await this.acquisitions.insertOne(
        validateDocument(acquisitionsCollection, {
          _id: acquisitionId,
          subjectId,
          sourceId: source._id,
          snapshotId,
          via: a.checked.via,
          bindingHash: a.bindingHash,
          keyed: a.keyed,
          createdBy: { kind: a.actor.kind, id: a.actor.id },
          schemaVersion: ACQUISITION_SCHEMA_VERSION,
          createdAt: now,
          updatedAt: now,
        }),
        { session },
      );

      const entity = { kind: 'snapshot' as const, id: snapshotId };
      const event = (type: string, extra: Partial<NewEvent> = {}): NewEvent => ({
        subjectId,
        entity,
        type,
        reason: a.checked.via,
        ...extra,
      });
      if (!existing) {
        const doc = validateDocument(snapshotsCollection, {
          _id: snapshotId,
          subjectId,
          sourceId: source._id,
          artifact: a.artifact,
          contentHash: a.checked.contentHash,
          mimeType: a.checked.mimeType,
          via: a.checked.via,
          sourceAsOf: declaredAsOf ?? now,
          sourceAsOfKind: declaredAsOf ? 'declared' : 'acquired',
          ...(declaredAsOf ? { declaredAsOf } : {}),
          acquisitions: 1,
          firstAcquiredAt: now,
          lastAcquiredAt: now,
          ingest: { state: 'pending', requestedAt: now },
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          createdAt: now,
          updatedAt: now,
        });
        await this.col.insertOne(doc, { session });
        await this.sources.col.updateOne(
          { _id: source._id },
          { $inc: { 'stats.snapshots': 1 }, $max: { 'stats.lastAcquiredAt': now }, $set: { updatedAt: now } },
          { session },
        );
        await this.events.append(
          `${snapshotId}:${acquisitionId}`,
          [event('snapshot.created', { to: doc.sourceAsOfKind })],
          a.actor,
          session,
        );
        return { snapshot: doc, created: true, outcome: 'created' };
      }

      const events = [event('snapshot.reacquired', { to: existing.sourceAsOfKind })];
      const $set: Record<string, unknown> = { updatedAt: now };
      const $max: Record<string, Date> = { lastAcquiredAt: now };
      if (existing.sourceAsOfKind === 'acquired' && declaredAsOf) {
        // A declared date is authoritative: correct the provenance, keep what it replaces.
        $set.sourceAsOf = declaredAsOf;
        $set.sourceAsOfKind = 'declared';
        $set.declaredAsOf = declaredAsOf;
        $set.previousSourceAsOf = {
          kind: 'acquired',
          value: existing.sourceAsOf,
          replacedAt: now,
          acquisitionId,
        };
        events.push(event('snapshot.dated', { from: 'acquired', to: 'declared', reason: 'declared_date' }));
      } else if (existing.sourceAsOfKind === 'acquired') {
        $max.sourceAsOf = now;
      }
      const updated = await this.col.findOneAndUpdate(
        { _id: snapshotId },
        { $inc: { acquisitions: 1 }, $max, $set },
        { session, returnDocument: 'after' },
      );
      if (!updated)
        throw new ProfessionalError('conflict', 'Snapshot changed concurrently', { id: snapshotId });
      await this.sources.col.updateOne(
        { _id: source._id },
        { $max: { 'stats.lastAcquiredAt': now }, $set: { updatedAt: now } },
        { session },
      );
      await this.events.append(`${snapshotId}:${acquisitionId}`, events, a.actor, session);
      return { snapshot: updated, created: false, outcome: 'reacquired' };
    });
  }

  /** The snapshot a keyed acquisition produced; the same key for anything else is a conflict. */
  private async replayOf(acquisitionId: string, bindingHash: string): Promise<UploadResult | null> {
    const row = await this.acquisitions.findOne({ _id: acquisitionId });
    if (!row) return null;
    if (row.bindingHash !== bindingHash)
      throw new ProfessionalError('conflict', 'Idempotency-Key was used for a different upload', {
        reason: 'idempotency_key_reused',
      });
    return { snapshot: await this.get(row.snapshotId), created: false, outcome: 'replayed' };
  }

  async get(id: string): Promise<SnapshotDoc> {
    const s = await this.col.findOne({ _id: id });
    if (!s) throw notFound('snapshot', id);
    return s;
  }

  /** A source's snapshots, newest first, cursor-paged. */
  async list(
    sourceId: string,
    query: z.input<typeof listSnapshotsQuerySchema>,
  ): Promise<CursorPage<SnapshotDoc>> {
    const q = listSnapshotsQuerySchema.parse(query);
    await this.sources.get(sourceId);
    const { after, sort } = cursorQuery(q);
    const docs = await this.col
      .find({ sourceId, ...after } as Filter<SnapshotDoc>)
      .sort(sort)
      .limit(q.limit + 1)
      .toArray();
    return toPage(docs, q.limit);
  }

  /** The snapshot's private bytes (callers check subject access on `snapshot.subjectId` first). */
  async content(snapshot: SnapshotDoc): Promise<Uint8Array> {
    return this.ctx.artifacts.readBytes({ artifactId: snapshot.artifact.artifactId });
  }
}

/** Checked bytes ready to store: media type, content address and how they arrived. */
interface PreparedBytes {
  bytes: Uint8Array;
  mimeType: string;
  contentHash: string;
  via: 'upload' | 'form';
}

interface AcquisitionContext {
  source: SourceDoc;
  acquisitionId: string;
  keyed: boolean;
  bindingHash: string;
  artifact: SnapshotDoc['artifact'];
  checked: PreparedBytes;
  declaredAsOf: Date | undefined;
  now: Date;
  actor: Actor;
}

const OUTCOME_CODES = new Set<string>([
  'upload_too_large',
  'unsupported_media_type',
  'validation_failed',
  'not_found',
  'subject_archived',
  'conflict',
]);
const outcomeOf = (code: string): UploadOutcome =>
  OUTCOME_CODES.has(code) ? (code as UploadOutcome) : 'error';

/** The upload outcome of an error (route-level rejections included): ZodError → `validation_failed`. */
export function uploadOutcomeOf(err: unknown): UploadOutcome {
  if (err instanceof ProfessionalError) return outcomeOf(err.code);
  if (err instanceof ZodError) return 'validation_failed';
  return 'error';
}

/** `professional_uploads_total{outcome, source_kind}`: enum labels only. */
export function countUpload(outcome: UploadOutcome, sourceKind: string): void {
  metrics.inc('professional_uploads_total', { outcome, source_kind: sourceKind });
}
