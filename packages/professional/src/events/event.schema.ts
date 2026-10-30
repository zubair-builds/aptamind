import { z } from 'zod';
import { defineCollection } from '@aptamind/db';
import { actorRefSchema, codeSchema, documentMetaFields } from '../documents';
import { idSchema } from '../contracts/ids';
import { professionalValidator } from '../validators';

export const EVENT_SCHEMA_VERSION = 1;

const stateSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, { message: 'not a state code' });

export const EVENT_ENTITY_KINDS = [
  'subject',
  'source',
  'snapshot',
  'extraction',
  'observation',
  'item',
  'assertion',
  'profile',
  'confirmation_request',
  'confirmation_operation',
  'career_target',
  'review_item',
] as const;
export type EventEntityKind = (typeof EVENT_ENTITY_KINDS)[number];

/**
 * The append-only Professional event ledger (R-23, PL-5): every state change with its actor
 * and reason code, written in the same transaction as the change. Ids are deterministic
 * (`det(operationId | runId, entity, seq)`) and written with `$setOnInsert`, so replays add
 * nothing. Events carry codes, states and ids only — never values or text.
 */
export const eventDocSchema = z.strictObject({
  _id: idSchema('event'),
  subjectId: idSchema('subject'),
  entity: z.object({ kind: z.enum(EVENT_ENTITY_KINDS), id: z.string().min(1) }),
  /** Event type code, e.g. `assertion.transitioned`, `subject.created`. */
  type: codeSchema,
  /** Previous / new state (e.g. assertion states `PROPOSED` → `CONFIRMED`). */
  from: stateSchema.optional(),
  to: stateSchema.optional(),
  reason: codeSchema,
  actor: actorRefSchema,
  operationId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  at: z.date(),
  ...documentMetaFields,
});
export type EventDoc = z.infer<typeof eventDocSchema>;

export const eventsCollection = defineCollection<EventDoc>({
  name: 'professional_events',
  description: 'Append-only history of every Professional state change, with actor and reason code.',
  schema: eventDocSchema,
  schemaVersion: EVENT_SCHEMA_VERSION,
  validator: professionalValidator(eventDocSchema),
  indexes: [
    {
      key: { subjectId: 1, at: -1 },
      options: { name: 'by_subject_time' },
      rationale: "A subject's history, newest first.",
    },
    {
      key: { 'entity.kind': 1, 'entity.id': 1, at: -1 },
      options: { name: 'by_entity_time' },
      rationale: "One entity's history (assertion transitions, item changes).",
    },
  ],
});
