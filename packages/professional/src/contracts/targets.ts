import { z } from 'zod';
import {
  COMPANY_STAGES,
  EMPLOYMENT_TYPES,
  INDUSTRIES,
  ROLE_FAMILIES,
  SENIORITY_LEVELS,
  SPECIALIZATIONS,
} from '@aptamind/taxonomy';
import {
  compensationFields,
  jurisdictionSchema,
  PREFERRED_WORK_MODELS,
  timezoneWindowSchema,
  withCompensationRules,
} from './values';

/**
 * Career target specification (domain doc §9, R-25 … R-28). Taxonomy-coded so a future
 * Opportunity join can compare targets with Market jobs without importing Market.
 *
 * A spec keeps two parts apart (INTEGRATION_CONTRACTS §4, Fit ≠ Viability):
 * - `fit` — capability-relevant direction: role families, specializations, titles, seniority,
 *   skills focus, industries/domains, company stages, employment types. A future fit
 *   computation may read this part only.
 * - `viability` — where and on which terms the subject can work: geography (live in, commute to,
 *   work remotely from — i.e. location and relocation), work models, timezone window,
 *   compensation, constraints. **Sensitive**: excluded from every response unless
 *   `include=sensitive`. The free-text `rationale` is treated the same way (it may mention
 *   viability facts).
 *
 * **Eligibility is excluded by schema**: no work-authorization, sponsorship-need or visa field
 * exists here (R-28). Opportunity reads the eligibility section for those.
 */

const INDUSTRY_CODES = INDUSTRIES.map((i) => i.code) as [string, ...string[]];
const text = (max: number) => z.string().trim().min(1).max(max);

export const TARGET_STATUSES = ['proposed', 'active', 'paused', 'archived', 'declined'] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];
/** Statuses that carry a priority (ranked, ordered by `priority`, 1 = highest). */
export const RANKED_TARGET_STATUSES = ['active', 'paused'] as const satisfies readonly TargetStatus[];
export type RankedTargetStatus = (typeof RANKED_TARGET_STATUSES)[number];
/**
 * `stated` by the subject (operator-relayed in v0.1); `proposal` derived from evidence (P5.2,
 * status `proposed` until accepted); `accepted_proposal` once the subject accepted it.
 */
export const TARGET_ORIGINS = ['stated', 'proposal', 'accepted_proposal'] as const;
export type TargetOrigin = (typeof TARGET_ORIGINS)[number];

export const GEOGRAPHY_SCOPES = ['country', 'region', 'city', 'anywhere'] as const;
export const GEOGRAPHY_MODES = ['live_in', 'commute_to', 'remote_from'] as const;
export const CONSTRAINT_KINDS = ['start_date', 'max_travel', 'contract_length', 'other'] as const;

/** The fit-relevant part of a target: what kind of work (never where or on which terms). */
export const targetFitSchema = z.strictObject({
  roleFamilies: z.array(z.enum(ROLE_FAMILIES)).min(1).max(10),
  specializations: z.array(z.enum(SPECIALIZATIONS)).max(20).optional(),
  titles: z.array(text(200)).max(20).optional(),
  seniority: z.strictObject({
    min: z.enum(SENIORITY_LEVELS).optional(),
    max: z.enum(SENIORITY_LEVELS).optional(),
  }),
  /** Skills the subject wants to use or grow: the raw label, and the taxonomy concept when known. */
  skillsFocus: z
    .array(z.strictObject({ label: text(120), concept: z.string().min(1).max(120).nullable() }))
    .max(50)
    .optional(),
  industries: z.array(z.enum(INDUSTRY_CODES)).max(30).optional(),
  domains: z.array(text(120)).max(50).optional(),
  excludedIndustries: z.array(z.enum(INDUSTRY_CODES)).max(30).optional(),
  companyStages: z.array(z.enum(COMPANY_STAGES)).optional(),
  employmentTypes: z.array(z.enum(EMPLOYMENT_TYPES)).optional(),
});
export type TargetFit = z.infer<typeof targetFitSchema>;

/** The viability part of a target (sensitive): where and on which terms. */
export const targetViabilitySchema = z.strictObject({
  geography: z
    .array(
      z.strictObject({
        scope: z.enum(GEOGRAPHY_SCOPES),
        code: jurisdictionSchema.optional(),
        city: text(120).optional(),
        mode: z.enum(GEOGRAPHY_MODES),
      }),
    )
    .max(50),
  workModels: z
    .strictObject({
      acceptable: z.array(z.enum(PREFERRED_WORK_MODELS)).min(1),
      preferred: z.enum(PREFERRED_WORK_MODELS).optional(),
    })
    .optional(),
  remoteScope: z.strictObject({ timezoneWindow: timezoneWindowSchema.optional() }).optional(),
  compensation: withCompensationRules(
    z.strictObject({ ...compensationFields, negotiable: z.boolean().optional() }),
  ).optional(),
  constraints: z
    .array(
      z.strictObject({
        kind: z.enum(CONSTRAINT_KINDS),
        value: text(200),
        strength: z.enum(['hard', 'soft']),
      }),
    )
    .max(20),
});
export type TargetViability = z.infer<typeof targetViabilitySchema>;

/** A viability part that says nothing: unknown stays unknown. */
export function emptyTargetViability(): TargetViability {
  return { geography: [], constraints: [] };
}

export const targetSpecSchema = z.strictObject({
  /** Operator/subject-given short name, shown in lists. */
  label: text(120),
  fit: targetFitSchema,
  /** Sensitive: returned only with `include=sensitive`. */
  viability: targetViabilitySchema,
  /** Sensitive (free text): returned only with `include=sensitive`. */
  rationale: text(2000).optional(),
});
export type TargetSpec = z.infer<typeof targetSpecSchema>;

/** The spec parts that are sensitive and omitted unless `include=sensitive`. */
export const SENSITIVE_TARGET_SPEC_FIELDS = ['viability', 'rationale'] as const;

/** The spec as returned without `include=sensitive`. */
export const targetSpecPublicSchema = targetSpecSchema.omit({ viability: true, rationale: true });
export type TargetSpecPublic = z.infer<typeof targetSpecPublicSchema>;
