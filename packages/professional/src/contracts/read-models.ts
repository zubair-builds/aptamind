import { z } from 'zod';
import { confidenceSchema, FACT_STATUSES } from '@aptamind/provenance';
import { BASES } from './basis';
import { CLAIM_VALUE_SCHEMAS, type ClaimType } from './claims';
import { idSchema } from './ids';
import { RANKED_TARGET_STATUSES, targetFitSchema, targetViabilitySchema } from './targets';
import { dateTimeSchema } from './values';

/**
 * Sectioned read models v1 (domain doc §14, PL-9, PL-13) — the Opportunity seam.
 *
 * Each read model is exported separately and stamped with the exact profile version it was
 * generated from. The capability profile can never carry eligibility data (location, work
 * authorization, relocation) or compensation: its entries are typed by capability-section
 * claim types only and every object is strict, so an extra field fails validation. A future
 * fit computation that reads `CapabilityProfileV1` therefore cannot read viability facts.
 *
 * Roles are exported **without** their workplace `location` (kept on the item/assertion): a
 * role's place is a proxy for where the subject can live or work, which is eligibility.
 *
 * Every entry is internally consistent: `confirmed ⇔ basis = confirmed`, and `value = null ⇔
 * status ∈ { unknown, conflicting }`. Eligibility entries may also be `expired` (a work
 * authorization whose `validUntil` has passed; the value is still shown).
 *
 * Identity claims (name, links) are personal data and are not part of any v1 read model.
 */

export const READ_MODEL_SCHEMA_VERSION = 1;

/** Which exact canonical state a read was generated from (`(subjectId, profileVersion)`). */
export const readModelStampSchema = z.strictObject({
  subjectId: idSchema('subject'),
  profileVersion: z.number().int().nonnegative(),
  policyVersion: z.string().min(1),
  taxonomyVersion: z.string().min(1),
  generatedAt: dateTimeSchema,
});
export type ReadModelStamp = z.infer<typeof readModelStampSchema>;

const VALUELESS_STATUSES = ['unknown', 'conflicting'] as const;
export const ELIGIBILITY_STATUSES = [...FACT_STATUSES, 'expired'] as const;

/**
 * One canonical item as exposed to readers: value plus basis, confidence, status, confirmed.
 * `valueSchema` defaults to the claim type's value schema (read models may expose less).
 */
function entry<T extends ClaimType>(
  claimType: T,
  opts: { valueSchema?: z.ZodType; statuses?: readonly [string, ...string[]] } = {},
) {
  return z
    .strictObject({
      itemId: idSchema('item'),
      claimType: z.literal(claimType),
      /** `null` exactly when the item's status is `unknown` or `conflicting`. */
      value: (opts.valueSchema ?? CLAIM_VALUE_SCHEMAS[claimType]).nullable(),
      status: z.enum(opts.statuses ?? FACT_STATUSES),
      basis: z.enum(BASES).nullable(),
      confidence: confidenceSchema,
      confirmed: z.boolean(),
    })
    .superRefine((e, ctx) => {
      if (e.confirmed !== (e.basis === 'confirmed'))
        ctx.addIssue({
          code: 'custom',
          path: ['confirmed'],
          message: 'confirmed must equal basis = confirmed',
        });
      const valueless = (VALUELESS_STATUSES as readonly string[]).includes(e.status);
      if (valueless !== (e.value === null))
        ctx.addIssue({
          code: 'custom',
          path: ['value'],
          message: 'value must be null iff status is unknown/conflicting',
        });
      if (e.status === 'expired' && claimType !== 'work_authorization')
        ctx.addIssue({ code: 'custom', path: ['status'], message: 'only work authorization can be expired' });
    });
}

/** A role as exported to capability readers: no workplace location (eligibility proxy). */
export const capabilityRoleValueSchema = CLAIM_VALUE_SCHEMAS['experience.role'].omit({ location: true });

export const capabilityProfileV1Schema = z.strictObject({
  model: z.literal('professional.capability_profile'),
  schemaVersion: z.literal(READ_MODEL_SCHEMA_VERSION),
  stamp: readModelStampSchema,
  headline: entry('positioning.headline').nullable(),
  roles: z.array(entry('experience.role', { valueSchema: capabilityRoleValueSchema })),
  skills: z.array(entry('skill')),
  education: z.array(entry('education')),
  certifications: z.array(entry('certification')),
  languages: z.array(entry('language')),
  projects: z.array(entry('project')),
  achievements: z.array(entry('achievement')),
  portfolioEvidence: z.array(entry('portfolio.evidence')),
  industries: z.array(entry('industry')),
});
export type CapabilityProfileV1 = z.infer<typeof capabilityProfileV1Schema>;

export const eligibilityV1Schema = z.strictObject({
  model: z.literal('professional.eligibility'),
  schemaVersion: z.literal(READ_MODEL_SCHEMA_VERSION),
  stamp: readModelStampSchema,
  location: entry('location.current', { statuses: ELIGIBILITY_STATUSES }).nullable(),
  /** One entry per jurisdiction, including expiry (`validUntil`; status `expired` once passed). */
  workAuthorization: z.array(entry('work_authorization', { statuses: ELIGIBILITY_STATUSES })),
  relocation: entry('mobility.relocation', { statuses: ELIGIBILITY_STATUSES }).nullable(),
});
export type EligibilityV1 = z.infer<typeof eligibilityV1Schema>;

export const preferencesV1Schema = z.strictObject({
  model: z.literal('professional.preferences'),
  schemaVersion: z.literal(READ_MODEL_SCHEMA_VERSION),
  stamp: readModelStampSchema,
  remote: entry('preference.remote').nullable(),
  compensation: entry('preference.compensation').nullable(),
  career: entry('preference.career').nullable(),
});
export type PreferencesV1 = z.infer<typeof preferencesV1Schema>;

/**
 * Career targets, fit part only (INTEGRATION_CONTRACTS §4): what kind of work each ranked target
 * (`active`, `paused`) is about — label, role families, titles, domains and the other fit fields.
 * Never geography, work models, compensation, constraints or the free-text rationale: those are
 * the viability part (`CareerTargetViabilityV1`, sensitive).
 */
export const careerTargetsV1Schema = z.strictObject({
  model: z.literal('professional.career_targets'),
  schemaVersion: z.literal(READ_MODEL_SCHEMA_VERSION),
  stamp: readModelStampSchema,
  /** Addressable as `(targetId, version)` (PL-13); ordered by priority (1 = highest). */
  targets: z.array(
    z.strictObject({
      targetId: idSchema('careerTarget'),
      version: z.number().int().positive(),
      priority: z.number().int().positive(),
      /** Ranked targets only: priorities exist for `active` and `paused` targets. */
      status: z.enum(RANKED_TARGET_STATUSES),
      /** `confirmed` for targets the subject stated or accepted; `inferred` for proposals. */
      basis: z.enum(['confirmed', 'inferred']),
      label: z.string().min(1).max(120),
      fit: targetFitSchema,
    }),
  ),
});
export type CareerTargetsV1 = z.infer<typeof careerTargetsV1Schema>;

/** The viability part of each career target (sensitive; `include=sensitive`), same versions. */
export const careerTargetViabilityV1Schema = z.strictObject({
  model: z.literal('professional.career_target_viability'),
  schemaVersion: z.literal(READ_MODEL_SCHEMA_VERSION),
  stamp: readModelStampSchema,
  targets: z.array(
    z.strictObject({
      targetId: idSchema('careerTarget'),
      version: z.number().int().positive(),
      viability: targetViabilitySchema,
    }),
  ),
});
export type CareerTargetViabilityV1 = z.infer<typeof careerTargetViabilityV1Schema>;

/** The read-model registry: model name → schema. */
export const READ_MODELS_V1 = {
  'professional.capability_profile': capabilityProfileV1Schema,
  'professional.eligibility': eligibilityV1Schema,
  'professional.preferences': preferencesV1Schema,
  'professional.career_targets': careerTargetsV1Schema,
  'professional.career_target_viability': careerTargetViabilityV1Schema,
} as const;
