import { z } from 'zod';
import { defineCollection } from '@aptamind/db';
import { actorRefSchema, documentMetaFields } from '../documents';
import { idSchema } from '../contracts/ids';
import { professionalValidator } from '../validators';

export const SUBJECT_SCHEMA_VERSION = 1;

export const SUBJECT_STATUSES = ['active', 'archived'] as const;

/**
 * Data classes v0.1 may process. Until artifact deletion and erasure exist (FE-P2) only
 * synthetic and owner-consented data is allowed, so no other class can be recorded.
 */
export const DATA_CLASSES = ['synthetic', 'owner_consented'] as const;
export const AI_PROCESSING = ['allowed', 'denied'] as const;

export const consentSchema = z.object({
  dataClass: z.enum(DATA_CLASSES),
  /** Lawful basis recorded by the operator (a code, not free text). */
  processingBasis: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/),
  /** AI extraction runs only when `allowed` (R-36). */
  aiProcessing: z.enum(AI_PROCESSING),
  recordedBy: actorRefSchema,
  recordedAt: z.date(),
});
export type Consent = z.infer<typeof consentSchema>;

/** The professional. Carries no personal data: `reference` is an opaque operator handle. */
export const subjectDocSchema = z.strictObject({
  _id: idSchema('subject'),
  status: z.enum(SUBJECT_STATUSES),
  /**
   * Opaque operator handle for finding the subject: a token (letters, digits, `_ . : -`), so an
   * email address or a "First Last" name cannot be stored here.
   */
  reference: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, { message: 'reference must be an opaque token' }),
  consent: consentSchema,
  /** Registered sources (incremented in the registering transaction; fences archive races). */
  sourceCount: z.number().int().nonnegative(),
  /**
   * Accepted acquisitions (uploads) of any of the subject's sources, new snapshot or repeat
   * (incremented in the acquiring transaction; fences archive races like `sourceCount`).
   *
   * Widened for the rollout (widen → backfill → tighten, domain doc §15): optional in the
   * server validator and defaulted to 0 when read, because subjects written before P1.2 (and
   * by not-yet-upgraded writers during a rolling deploy) lack it. Migration
   * `2026-09-30-002-professional-subject-acquisition-count` backfills it; a later release makes
   * it required.
   */
  acquisitionCount: z.number().int().nonnegative().default(0),
  /**
   * Extractions committed for the subject's snapshots (P1.3): incremented in the extraction
   * transaction under `status: active`, which fences extraction against archive/erasure. Optional
   * (widened, read as 0) like `acquisitionCount`.
   */
  extractionCount: z.number().int().nonnegative().default(0),
  /** Bumped by every subject edit (reference, consent, archive); `expectedRev` on PATCH. */
  rev: z.number().int().nonnegative(),
  /**
   * Career-target ranking fence (P5.1): incremented inside every transaction that creates a
   * target, changes its status or reorders, so concurrent ranking changes of one subject
   * serialize (write conflict) and priorities stay unique. Optional (widen → backfill →
   * tighten): readers treat an absent value as 0; it never becomes required before every
   * writer is on P5.1.
   */
  targetsRev: z.number().int().nonnegative().optional(),
  /** Hash of the create request, so an Idempotency-Key replay with another body is refused. */
  createRequestHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  createdBy: actorRefSchema,
  archivedAt: z.date().optional(),
  ...documentMetaFields,
});
export type SubjectDoc = z.infer<typeof subjectDocSchema>;

/** A subject as returned by the API: internal fields (the target ranking fence) stripped. */
export type SubjectView = Omit<SubjectDoc, 'targetsRev'>;

export function subjectView(doc: SubjectDoc): SubjectView {
  const { targetsRev: _fence, ...view } = doc;
  return view;
}

export const subjectsCollection = defineCollection<SubjectDoc>({
  name: 'professional_subjects',
  description:
    'Professionals (subjects) with their consent record. Opaque ids; no personal data on the subject document.',
  schema: subjectDocSchema,
  schemaVersion: SUBJECT_SCHEMA_VERSION,
  validator: professionalValidator(subjectDocSchema),
  indexes: [
    {
      key: { status: 1, createdAt: -1, _id: -1 },
      options: { name: 'by_status_created' },
      rationale: 'Subject list filtered by status, newest first (cursor pagination).',
    },
    {
      key: { createdAt: -1, _id: -1 },
      options: { name: 'by_created' },
      rationale: 'Unfiltered subject list, newest first (cursor pagination).',
    },
    {
      key: { reference: 1, createdAt: -1, _id: -1 },
      options: { name: 'by_reference' },
      rationale: 'Find a subject by its opaque operator reference (cursor-paged like the other lists).',
    },
  ],
});
