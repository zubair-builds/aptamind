import type { Document } from 'mongodb';
import { z } from 'zod';
import { defineCollection } from '@aptamind/db';
import { idSchema } from '../contracts/ids';
import { TARGET_ORIGINS, TARGET_STATUSES, targetSpecSchema } from '../contracts/targets';
import { actorRefSchema, codeSchema, documentMetaFields } from '../documents';
import { professionalValidator } from '../validators';

export const TARGET_SCHEMA_VERSION = 1;

/**
 * Hardens the derived `$jsonSchema` of the target collections: every nested object that lists its
 * properties is closed, so a spec can never gain a field around the application boundary — e.g.
 * a work-authorization or sponsorship field (R-28) — even when written directly to MongoDB; and
 * `priority`/`version` ≥ 1, `rev` ≥ 0.
 */
function closeNestedObjects(validator: Document): Document {
  const close = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (n.properties && typeof n.properties === 'object') {
      n.additionalProperties = false;
      for (const child of Object.values(n.properties as Record<string, unknown>)) close(child);
    }
    if (n.items) close(n.items);
    for (const k of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(n[k])) (n[k] as unknown[]).forEach(close);
  };
  close(validator.$jsonSchema);
  // Numeric bounds are not part of the derivation; the ones that matter here are added explicitly.
  const props = (validator.$jsonSchema as { properties: Record<string, Record<string, unknown>> }).properties;
  for (const [field, minimum] of [
    ['priority', 1],
    ['version', 1],
    ['rev', 0],
  ] as const)
    if (props[field]) props[field].minimum = minimum;
  return validator;
}
export const TARGET_VERSION_SCHEMA_VERSION = 1;

/**
 * Most **open** targets (proposed, active, paused) one subject can hold: creation and re-opening
 * (activate from archived) are refused beyond it. Archived and declined targets do not count;
 * they are listed with keyset pagination.
 */
export const MAX_TARGETS_PER_SUBJECT = 100;

export const TARGET_BASES = ['confirmed', 'inferred'] as const;
export const TARGET_CHANGE_KINDS = ['created', 'spec_edited', 'status_changed', 'reordered'] as const;
export type TargetChangeKind = (typeof TARGET_CHANGE_KINDS)[number];
/** v0.1: an internal operator relays what the subject said; proposals come from automation. */
export const TARGET_ATTESTATION_MODES = ['operator_relayed', 'automation'] as const;

/**
 * A career target, current state (domain doc §9, R-25 … R-27). Several may be active at once;
 * ranked targets (`active`, `paused`) carry a `priority` (1 = highest, unique per subject; gaps
 * allowed after archive), the others none. Every change bumps `rev` and `version` and writes an
 * immutable version document in the same transaction.
 */
export const careerTargetDocSchema = z.strictObject({
  _id: idSchema('careerTarget'),
  subjectId: idSchema('subject'),
  status: z.enum(TARGET_STATUSES),
  priority: z.number().int().positive().optional(),
  spec: targetSpecSchema,
  origin: z.enum(TARGET_ORIGINS),
  /** `confirmed` when the subject stated or accepted it; `inferred` for proposals (P5.2). */
  basis: z.enum(TARGET_BASES),
  /**
   * The subject edited this proposal: it stays `proposed` (and `inferred` until accepted) but is
   * subject-owned — automation can never edit it again. The flag persists after the proposal is
   * accepted or declined (it records that the subject shaped it).
   */
  subjectEdited: z.literal(true).optional(),
  /** Observations a proposal was derived from (P5.2). */
  proposalEvidence: z.array(idSchema('observation')).max(50).optional(),
  /** Bumped by every change; the `expectedRev` of edits, transitions and reorders. */
  rev: z.number().int().nonnegative(),
  /** The current version number (1 on creation); `(targetId, version)` is the stable reference. */
  version: z.number().int().positive(),
  /** Hash of the create request, so an Idempotency-Key replay with another body is refused. */
  createRequestHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  createdBy: actorRefSchema,
  ...documentMetaFields,
});
export type CareerTargetDoc = z.infer<typeof careerTargetDocSchema>;

/** One immutable version of a target: the full state after a change, with its cause. */
export const careerTargetVersionDocSchema = z.strictObject({
  _id: idSchema('careerTargetVersion'),
  subjectId: idSchema('subject'),
  targetId: idSchema('careerTarget'),
  version: z.number().int().positive(),
  status: z.enum(TARGET_STATUSES),
  priority: z.number().int().positive().optional(),
  spec: targetSpecSchema,
  origin: z.enum(TARGET_ORIGINS),
  basis: z.enum(TARGET_BASES),
  subjectEdited: z.literal(true).optional(),
  cause: z.strictObject({ kind: z.enum(TARGET_CHANGE_KINDS), reason: codeSchema }),
  actor: actorRefSchema,
  attestation: z.strictObject({ mode: z.enum(TARGET_ATTESTATION_MODES) }),
  ...documentMetaFields,
});
export type CareerTargetVersionDoc = z.infer<typeof careerTargetVersionDocSchema>;

export const careerTargetsCollection = defineCollection<CareerTargetDoc>({
  name: 'professional_career_targets',
  description:
    'Career targets of a subject, current state (several active at once, priority-ordered). Viability parts are sensitive.',
  schema: careerTargetDocSchema,
  schemaVersion: TARGET_SCHEMA_VERSION,
  validator: closeNestedObjects(professionalValidator(careerTargetDocSchema)),
  indexes: [
    {
      key: { subjectId: 1, status: 1, priority: 1 },
      options: { name: 'by_subject_status_priority' },
      rationale:
        "A subject's targets by status in priority order (list, ranking reads in the fencing transaction).",
    },
    {
      key: { subjectId: 1, status: 1, createdAt: -1, _id: -1 },
      options: { name: 'by_subject_status_created' },
      rationale: 'Archived / declined history of a subject, keyset-paged over (createdAt, _id).',
    },
    {
      key: { subjectId: 1, createdAt: -1, _id: -1 },
      options: { name: 'by_subject_created' },
      rationale: 'All targets of a subject (status=all), keyset-paged over (createdAt, _id).',
    },
  ],
});

export const careerTargetVersionsCollection = defineCollection<CareerTargetVersionDoc>({
  name: 'professional_career_target_versions',
  description: 'Immutable version history of career targets: full state after every change, with its cause.',
  schema: careerTargetVersionDocSchema,
  schemaVersion: TARGET_VERSION_SCHEMA_VERSION,
  validator: closeNestedObjects(professionalValidator(careerTargetVersionDocSchema)),
  indexes: [
    {
      key: { targetId: 1, version: 1 },
      options: { name: 'uniq_target_version', unique: true },
      rationale: 'One document per (target, version); versions are listed in order and fetched by number.',
    },
    {
      key: { subjectId: 1, createdAt: -1 },
      options: { name: 'by_subject' },
      rationale: 'Erasure enumeration and a subject-wide target history.',
    },
  ],
});
