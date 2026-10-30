import type { Collection, Db, Filter } from 'mongodb';
import { z } from 'zod';
import { type Actor, contentHash, deterministicId, newId } from '@aptamind/contracts';
import { getCollection, isDuplicateKeyError, validateDocument, withTransaction } from '@aptamind/db';
import { notFound, ProfessionalError } from '../api/errors';
import { type CursorPage, cursorQuery, pageParamsShape, toPage } from '../api/pagination';
import type { ProfessionalContext } from '../context';
import type { EventStore, NewEvent } from '../events/event.store';
import {
  AI_PROCESSING,
  DATA_CLASSES,
  SUBJECT_SCHEMA_VERSION,
  SUBJECT_STATUSES,
  type SubjectDoc,
  subjectDocSchema,
  subjectsCollection,
} from './subject.schema';

const referenceSchema = subjectDocSchema.shape.reference;
const processingBasisSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, { message: 'processingBasis must be a lower-case code' });

/** `POST /api/professional/subjects` body (R-1). */
export const createSubjectInputSchema = z.strictObject({
  reference: referenceSchema,
  consent: z.strictObject({
    dataClass: z.enum(DATA_CLASSES),
    processingBasis: processingBasisSchema,
    aiProcessing: z.enum(AI_PROCESSING),
  }),
});
export type CreateSubjectInput = z.infer<typeof createSubjectInputSchema>;

/** `PATCH /api/professional/subjects/:id` body: reference and/or consent (event-recorded). */
export const updateSubjectInputSchema = z
  .strictObject({
    reference: referenceSchema.optional(),
    consent: z
      .strictObject({
        dataClass: z.enum(DATA_CLASSES).optional(),
        processingBasis: processingBasisSchema.optional(),
        aiProcessing: z.enum(AI_PROCESSING).optional(),
      })
      .optional(),
    /** The subject `rev` the operator saw; a newer subject → 409 `stale_subject_revision`. */
    expectedRev: z.number().int().nonnegative().optional(),
  })
  .refine((u) => u.reference !== undefined || u.consent !== undefined, {
    message: 'nothing to update',
  });
export type UpdateSubjectInput = z.infer<typeof updateSubjectInputSchema>;

/** `GET /api/professional/subjects` query: filters and page parameters; unknown keys → 400. */
export const listSubjectsQuerySchema = z.strictObject({
  status: z.enum(SUBJECT_STATUSES).optional(),
  reference: referenceSchema.optional(),
  ...pageParamsShape,
});
export type ListSubjectsQuery = z.infer<typeof listSubjectsQuerySchema>;

/** Idempotency keys are opaque client tokens; they only ever reach ids through a hash. */
export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/, { message: 'invalid Idempotency-Key' });

const CONSENT_EVENT = {
  dataClass: 'subject.consent.data_class_changed',
  processingBasis: 'subject.consent.processing_basis_changed',
  aiProcessing: 'subject.consent.ai_processing_changed',
} as const;

/** Subjects: explicit creation with consent (R-1), reference/consent edits, archive. */
export class SubjectService {
  readonly col: Collection<SubjectDoc>;

  constructor(
    private readonly ctx: ProfessionalContext,
    private readonly events: EventStore,
  ) {
    this.col = getCollection(ctx.db, subjectsCollection);
  }

  /**
   * Creates a subject. With an Idempotency-Key the id is `det(psub, 'idem', key)`: a replay
   * returns the same subject (`created: false`); the same key with another body is refused
   * (409 `idempotency_key_reused`). The subject and its `subject.created` event commit together.
   */
  async create(
    input: CreateSubjectInput,
    actor: Actor,
    idempotencyKey?: string,
  ): Promise<{ subject: SubjectDoc; created: boolean }> {
    const parsed = createSubjectInputSchema.parse(input);
    const requestHash = contentHash(parsed);
    const _id = idempotencyKey ? deterministicId('psub', 'idem', idempotencyKey) : newId('psub');
    const now = this.ctx.clock.now();
    const actorRef = { kind: actor.kind, id: actor.id };
    const doc = validateDocument(subjectsCollection, {
      _id,
      status: 'active',
      reference: parsed.reference,
      consent: { ...parsed.consent, recordedBy: actorRef, recordedAt: now },
      sourceCount: 0,
      acquisitionCount: 0,
      rev: 0,
      createRequestHash: requestHash,
      createdBy: actorRef,
      schemaVersion: SUBJECT_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    });
    try {
      await withTransaction(this.ctx.db.client, async (session) => {
        await this.col.insertOne(doc, { session });
        await this.events.append(
          `${_id}:create`,
          [
            {
              subjectId: _id,
              entity: { kind: 'subject', id: _id },
              type: 'subject.created',
              to: 'active',
              reason: 'operator_created',
            },
          ],
          actor,
          session,
        );
      });
      return { subject: doc, created: true };
    } catch (err) {
      if (!isDuplicateKeyError(err) || !idempotencyKey) throw err;
      const existing = await this.col.findOne({ _id });
      if (!existing) throw err;
      if (existing.createRequestHash !== requestHash)
        throw new ProfessionalError(
          'idempotency_key_reused',
          'Idempotency-Key was used with a different request',
        );
      return { subject: readSubject(existing), created: false };
    }
  }

  async get(id: string): Promise<SubjectDoc> {
    const s = await this.col.findOne({ _id: id });
    if (!s) throw notFound('subject', id);
    return readSubject(s);
  }

  async list(query: z.input<typeof listSubjectsQuerySchema>): Promise<CursorPage<SubjectDoc>> {
    const q = listSubjectsQuerySchema.parse(query);
    const filter: Filter<SubjectDoc> = {};
    if (q.status) filter.status = q.status;
    if (q.reference) filter.reference = q.reference;
    const { after, sort } = cursorQuery(q);
    const docs = await this.col
      .find({ ...filter, ...after } as Filter<SubjectDoc>)
      .sort(sort)
      .limit(q.limit + 1)
      .toArray();
    return toPage(docs.map(readSubject), q.limit);
  }

  /**
   * Reference and consent changes. Each changed field is an event in the same transaction
   * (consent changes are recorded, never silent). Archived subjects are read-only.
   */
  async update(id: string, input: UpdateSubjectInput, actor: Actor): Promise<SubjectDoc> {
    const patch = updateSubjectInputSchema.parse(input);
    const current = await this.get(id);
    if (current.status !== 'active')
      throw new ProfessionalError('subject_archived', 'Subject is archived', { id });
    if (patch.expectedRev !== undefined && patch.expectedRev !== current.rev)
      throw new ProfessionalError('stale_subject_revision', 'Subject changed since it was read', {
        id,
        rev: current.rev,
      });

    const events: NewEvent[] = [];
    const $set: Record<string, unknown> = {};
    const entity = { kind: 'subject' as const, id };
    if (patch.reference !== undefined && patch.reference !== current.reference) {
      $set.reference = patch.reference;
      events.push({ subjectId: id, entity, type: 'subject.reference_changed', reason: 'operator_update' });
    }
    const consent = { ...current.consent };
    let consentChanged = false;
    for (const field of ['dataClass', 'processingBasis', 'aiProcessing'] as const) {
      const next = patch.consent?.[field];
      if (next === undefined || next === current.consent[field]) continue;
      (consent as Record<string, unknown>)[field] = next;
      consentChanged = true;
      events.push({
        subjectId: id,
        entity,
        type: CONSENT_EVENT[field],
        // Consent values are enums; processingBasis is a code (never free text).
        ...(field === 'processingBasis' ? {} : { from: current.consent[field], to: next }),
        reason: 'operator_update',
      });
    }
    if (!events.length) return current;
    const now = this.ctx.clock.now();
    // recordedBy/recordedAt describe the consent record, so only a consent change moves them.
    if (consentChanged) {
      $set.consent = { ...consent, recordedBy: { kind: actor.kind, id: actor.id }, recordedAt: now };
    }
    $set.updatedAt = now;
    validateDocument(subjectsCollection, { ...current, ...$set, rev: current.rev + 1 });

    return withTransaction(this.ctx.db.client, async (session) => {
      const updated = await this.col.findOneAndUpdate(
        { _id: id, status: 'active', rev: current.rev },
        { $set, $inc: { rev: 1 } },
        { session, returnDocument: 'after' },
      );
      if (!updated) throw await this.explainMiss(id, current.rev);
      await this.events.append(`${id}:rev:${current.rev + 1}`, events, actor, session);
      return readSubject(updated);
    });
  }

  /** Archive: no new sources afterwards (R-1/FR-P1). Idempotent. */
  async archive(id: string, actor: Actor): Promise<SubjectDoc> {
    const current = await this.get(id);
    if (current.status === 'archived') return current;
    const now = this.ctx.clock.now();
    return withTransaction(this.ctx.db.client, async (session) => {
      const updated = await this.col.findOneAndUpdate(
        { _id: id, status: 'active' },
        { $set: { status: 'archived', archivedAt: now, updatedAt: now }, $inc: { rev: 1 } },
        { session, returnDocument: 'after' },
      );
      if (!updated) {
        const again = await this.col.findOne({ _id: id }, { session });
        if (again) return readSubject(again);
        throw notFound('subject', id);
      }
      await this.events.append(
        `${id}:archive`,
        [
          {
            subjectId: id,
            entity: { kind: 'subject', id },
            type: 'subject.archived',
            from: 'active',
            to: 'archived',
            reason: 'operator_archived',
          },
        ],
        actor,
        session,
      );
      return readSubject(updated);
    });
  }

  private async explainMiss(id: string, rev: number): Promise<ProfessionalError> {
    const now = await this.col.findOne({ _id: id });
    if (!now) return notFound('subject', id);
    if (now.status !== 'active')
      return new ProfessionalError('subject_archived', 'Subject is archived', { id });
    return new ProfessionalError('stale_subject_revision', 'Subject changed since it was read', {
      id,
      rev: now.rev,
      expected: rev,
    });
  }
}

/**
 * Reader defaults for fields widened during a rollout (domain doc §15): a subject written before
 * P1.2 has no `acquisitionCount` until the backfill migration runs; it reads as 0.
 */
export function readSubject(doc: SubjectDoc): SubjectDoc {
  if (doc.acquisitionCount !== undefined && doc.extractionCount !== undefined) return doc;
  return { ...doc, acquisitionCount: doc.acquisitionCount ?? 0, extractionCount: doc.extractionCount ?? 0 };
}

/** Backfill for the `acquisitionCount` widening (idempotent; run by a platform migration). */
export async function backfillSubjectAcquisitionCount(db: Db): Promise<number> {
  const res = await db
    .collection(subjectsCollection.name)
    .updateMany({ acquisitionCount: { $exists: false } }, { $set: { acquisitionCount: 0 } });
  return res.modifiedCount;
}
