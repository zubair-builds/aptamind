import { z } from 'zod';
import { defineCollection } from '@aptamind/db';
import { actorRefSchema, codeSchema, documentMetaFields } from '../documents';
import { idSchema } from '../contracts/ids';
import { professionalValidator } from '../validators';
import { EVENT_ENTITY_KINDS } from '../events/event.schema';

export const REVIEW_SCHEMA_VERSION = 1;

/** Operator data-quality problems — never subject truth (that is the confirmation queue). */
export const PROFESSIONAL_REVIEW_TYPES = [
  'parser_failure',
  'unsupported_format',
  'limits_exceeded',
  'extraction_suspect',
  'fetch_failure',
  'source_anomaly',
] as const;
export const PROFESSIONAL_REVIEW_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export const PROFESSIONAL_REVIEW_ACTIONS = ['retry', 'quarantine', 'dismiss'] as const;

export const reviewItemDocSchema = z.strictObject({
  _id: idSchema('reviewItem'),
  subjectId: idSchema('subject'),
  type: z.enum(PROFESSIONAL_REVIEW_TYPES),
  /** One open item per question; includes the subject/entity ids (never personal values). */
  dedupeKey: z.string().min(1).max(300),
  status: z.enum(PROFESSIONAL_REVIEW_STATUSES),
  entity: z.object({ kind: z.enum(EVENT_ENTITY_KINDS), id: z.string().min(1) }),
  /** Reason code only; review reasons never carry document text (R-37). */
  reasonCode: codeSchema,
  allowedActions: z.array(z.enum(PROFESSIONAL_REVIEW_ACTIONS)).min(1),
  /** Higher first. */
  priority: z.number().int(),
  occurrences: z.number().int().positive(),
  resolution: z
    .object({
      action: z.enum(PROFESSIONAL_REVIEW_ACTIONS),
      reasonCode: codeSchema,
      actor: actorRefSchema,
      at: z.date(),
    })
    .optional(),
  ...documentMetaFields,
});
export type ReviewItemDoc = z.infer<typeof reviewItemDocSchema>;

export const reviewItemsCollection = defineCollection<ReviewItemDoc>({
  name: 'professional_review_items',
  description:
    'Operator data-quality queue for Professional ingestion (parser failures, limits, fetch failures).',
  schema: reviewItemDocSchema,
  schemaVersion: REVIEW_SCHEMA_VERSION,
  validator: professionalValidator(reviewItemDocSchema),
  indexes: [
    {
      key: { dedupeKey: 1 },
      options: { name: 'uniq_open_dedupe', unique: true, partialFilterExpression: { status: 'open' } },
      rationale: 'Idempotency: the same problem never produces two open review items.',
    },
    {
      key: { status: 1, priority: -1, createdAt: 1 },
      options: { name: 'by_status_priority' },
      rationale: 'Review queue ordering.',
    },
    {
      key: { subjectId: 1, createdAt: -1 },
      options: { name: 'by_subject' },
      rationale: "A subject's review items; erasure enumeration.",
    },
  ],
});
