import { z } from 'zod';
import {
  EMPLOYMENT_TYPES,
  HUMAN_LANGUAGES,
  INDUSTRIES,
  ROLE_FAMILIES,
  SENIORITY_LEVELS,
  SKILL_CATEGORIES,
} from '@aptamind/taxonomy';
import { idSchema } from './ids';
import type { FieldClass, Section, Sensitivity } from './sections';
import {
  compensationSchema,
  countryCodeSchema,
  dateOrPresentSchema,
  jurisdictionSchema,
  normalizedKeySchema,
  organizationSchema,
  partialDateSchema,
  placeSchema,
  PREFERRED_WORK_MODELS,
  timezoneWindowSchema,
  urlSchema,
} from './values';

/**
 * Claim types v1 (domain doc §3.2). Each claim type has one normalized value schema, one
 * section, one field class and one sensitivity. Values use `@aptamind/taxonomy` codes where a
 * vocabulary exists; the raw label is always kept and an unmatched concept is `null` — never
 * dropped or guessed.
 *
 * Protected characteristics (date of birth/age, gender, marital status, nationality, ethnicity,
 * religion, health, photo, national id, street address) have no field in any claim type.
 */
export const CLAIM_SCHEMA_VERSION = 1;

const text = (max: number) => z.string().trim().min(1).max(max);
const INDUSTRY_CODES = INDUSTRIES.map((i) => i.code) as [string, ...string[]];

export const LINK_KINDS = ['website', 'github', 'linkedin', 'portfolio', 'other'] as const;
export const SKILL_KINDS = ['skill', 'tool'] as const;
export const SKILL_PROFICIENCIES = ['beginner', 'intermediate', 'advanced', 'expert'] as const;
export const SKILL_CONTEXTS = ['listed', 'used_in_role', 'repo'] as const;
export const EDUCATION_LEVELS = [
  'secondary',
  'vocational',
  'associate',
  'bachelor',
  'master',
  'doctorate',
  'other',
] as const;
export const EDUCATION_STATUSES = ['completed', 'in_progress', 'unknown'] as const;
export const LANGUAGE_PROFICIENCIES = [
  'native',
  'fluent',
  'professional',
  'basic',
  'cefr:A1',
  'cefr:A2',
  'cefr:B1',
  'cefr:B2',
  'cefr:C1',
  'cefr:C2',
] as const;
export const WORK_AUTHORIZATION_STATUSES = ['citizen_or_equivalent', 'permanent', 'visa', 'none'] as const;
export const TRI_STATE = ['yes', 'no', 'unknown'] as const;
export const RELOCATION_WILLINGNESS = ['yes', 'no', 'conditional'] as const;
export const PORTFOLIO_KINDS = ['case_study', 'repository', 'publication', 'talk', 'design_file'] as const;

export const CLAIM_VALUE_SCHEMAS = {
  'identity.name': z.strictObject({ display: text(200), preferred: text(200).optional() }),
  'identity.link': z.strictObject({ kind: z.enum(LINK_KINDS), url: urlSchema }),
  'positioning.headline': z.strictObject({ text: text(300) }),
  'experience.role': z.strictObject({
    organization: organizationSchema,
    title: text(200),
    titleKey: normalizedKeySchema,
    roleFamily: z.enum(ROLE_FAMILIES).optional(),
    seniority: z.enum(SENIORITY_LEVELS).optional(),
    employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
    start: partialDateSchema,
    end: dateOrPresentSchema,
    /** Where the role was performed (history), not where the subject lives now. */
    location: placeSchema.optional(),
  }),
  skill: z.strictObject({
    label: text(120),
    concept: z.string().min(1).nullable(),
    category: z.enum(SKILL_CATEGORIES).optional(),
    kind: z.enum(SKILL_KINDS),
    /** Only when stated by the subject; never inferred. */
    proficiency: z.enum(SKILL_PROFICIENCIES).optional(),
    context: z.enum(SKILL_CONTEXTS),
  }),
  education: z.strictObject({
    institution: z.strictObject({ name: text(200), key: normalizedKeySchema }),
    qualification: text(200),
    field: text(200).optional(),
    level: z.enum(EDUCATION_LEVELS).optional(),
    start: partialDateSchema.optional(),
    end: partialDateSchema.optional(),
    status: z.enum(EDUCATION_STATUSES),
  }),
  certification: z.strictObject({
    name: text(200),
    issuer: text(200),
    issued: partialDateSchema.optional(),
    expires: partialDateSchema.optional(),
    url: urlSchema.optional(),
  }),
  language: z.strictObject({
    label: text(80),
    language: z.enum(HUMAN_LANGUAGES).nullable(),
    proficiency: z.enum(LANGUAGE_PROFICIENCIES),
  }),
  'location.current': z.strictObject({
    city: text(120).optional(),
    region: text(120).optional(),
    country: countryCodeSchema,
  }),
  work_authorization: z.strictObject({
    jurisdiction: jurisdictionSchema,
    status: z.enum(WORK_AUTHORIZATION_STATUSES),
    visaType: text(80).optional(),
    validUntil: partialDateSchema.optional(),
    sponsorshipRequired: z.enum(TRI_STATE),
  }),
  'mobility.relocation': z.strictObject({
    willing: z.enum(RELOCATION_WILLINGNESS),
    destinations: z.array(jurisdictionSchema).max(50),
  }),
  'preference.remote': z.strictObject({
    acceptable: z.array(z.enum(PREFERRED_WORK_MODELS)).min(1),
    preferred: z.enum(PREFERRED_WORK_MODELS).optional(),
    timezoneWindow: timezoneWindowSchema.optional(),
  }),
  project: z.strictObject({
    name: text(200),
    role: text(200).optional(),
    period: z
      .strictObject({ start: partialDateSchema.optional(), end: dateOrPresentSchema.optional() })
      .optional(),
    url: urlSchema.optional(),
    technologies: z.array(text(120)).max(100),
    /** Reference to the evidence holding the summary; never the text itself. */
    summaryRef: z.string().min(1).optional(),
  }),
  achievement: z.strictObject({
    text: text(500),
    metrics: z.array(z.strictObject({ value: z.number(), unit: text(40), quote: text(300) })).max(20),
  }),
  'portfolio.evidence': z.strictObject({
    kind: z.enum(PORTFOLIO_KINDS),
    title: text(200),
    url: urlSchema.optional(),
    /** Item ids of the roles/projects this evidence supports. */
    relatesTo: z.array(idSchema('item')).max(50),
  }),
  industry: z.strictObject({ label: text(120), code: z.enum(INDUSTRY_CODES).nullable() }),
  'preference.compensation': compensationSchema,
  /** The observation holding the career statement (never the statement text). */
  'preference.career': z.strictObject({ statementRef: idSchema('observation') }),
} as const;

export type ClaimType = keyof typeof CLAIM_VALUE_SCHEMAS;
export const CLAIM_TYPES = Object.keys(CLAIM_VALUE_SCHEMAS) as ClaimType[];
export type ClaimValue<T extends ClaimType> = z.infer<(typeof CLAIM_VALUE_SCHEMAS)[T]>;

/** How an observation finds its item (domain doc §4). */
export type ItemKeying = 'singleton' | 'keyed' | 'matched';

export interface ClaimTypeDef {
  section: Section;
  fieldClass: FieldClass;
  sensitivity: Sensitivity;
  /** Material conflicts and unconfirmed values open confirmation requests (§7.2). */
  material: boolean;
  itemKeying: ItemKeying;
  /** Stream milestone that first extracts this claim type. */
  milestone: 'P2' | 'P5' | 'P7';
  /**
   * Top-level value fields that are `sensitive` although the claim type is not: an observation
   * carrying one is treated like a sensitive claim type (P1.3 re-verify: a timezone window
   * reveals approximate location).
   */
  sensitiveFields?: readonly string[];
}

/** The claim-type registry. A test pins every row to the domain document. */
export const CLAIM_TYPE_DEFS: Readonly<Record<ClaimType, Readonly<ClaimTypeDef>>> = Object.freeze({
  'identity.name': def('identity', 'current_state', 'personal', true, 'singleton', 'P2'),
  'identity.link': def('identity', 'set_member', 'personal', false, 'keyed', 'P2'),
  'positioning.headline': def('capability', 'current_state', 'standard', false, 'singleton', 'P2'),
  'experience.role': def('capability', 'historical', 'standard', true, 'matched', 'P2'),
  skill: def('capability', 'set_member', 'standard', false, 'keyed', 'P2'),
  education: def('capability', 'historical', 'standard', true, 'keyed', 'P2'),
  certification: def('capability', 'historical', 'standard', true, 'keyed', 'P2'),
  language: def('capability', 'set_member', 'standard', false, 'keyed', 'P2'),
  'location.current': def('eligibility', 'current_state', 'sensitive', true, 'singleton', 'P2'),
  // Historical for conflicts; an expired `validUntil` makes the canonical status `expired`.
  work_authorization: def('eligibility', 'historical', 'sensitive', true, 'keyed', 'P2'),
  'mobility.relocation': def('eligibility', 'current_state', 'sensitive', false, 'singleton', 'P2'),
  'preference.remote': Object.freeze({
    ...def('preferences', 'current_state', 'standard', false, 'singleton', 'P2'),
    sensitiveFields: Object.freeze(['timezoneWindow']),
  }),
  project: def('capability', 'historical', 'standard', false, 'matched', 'P7'),
  achievement: def('capability', 'historical', 'standard', false, 'keyed', 'P7'),
  'portfolio.evidence': def('capability', 'set_member', 'standard', false, 'keyed', 'P7'),
  industry: def('capability', 'set_member', 'standard', false, 'keyed', 'P7'),
  'preference.compensation': def('preferences', 'current_state', 'sensitive', false, 'singleton', 'P7'),
  'preference.career': def('preferences', 'current_state', 'sensitive', false, 'singleton', 'P5'),
});

function def(
  section: Section,
  fieldClass: FieldClass,
  sensitivity: Sensitivity,
  material: boolean,
  itemKeying: ItemKeying,
  milestone: ClaimTypeDef['milestone'],
): Readonly<ClaimTypeDef> {
  return Object.freeze({ section, fieldClass, sensitivity, material, itemKeying, milestone });
}

export function claimTypesInSection(section: Section): ClaimType[] {
  return CLAIM_TYPES.filter((t) => CLAIM_TYPE_DEFS[t].section === section);
}

/** A typed claim: a claim type with its normalized value. */
export type Claim = { [K in ClaimType]: { claimType: K; value: ClaimValue<K> } }[ClaimType];

const claimOptions = CLAIM_TYPES.map((t) =>
  z.strictObject({ claimType: z.literal(t), value: CLAIM_VALUE_SCHEMAS[t] }),
);

export const claimSchema = z.discriminatedUnion(
  'claimType',
  claimOptions as unknown as [(typeof claimOptions)[number], ...(typeof claimOptions)[number][]],
) as unknown as z.ZodType<Claim>;

/** Parses a claim value for its claim type (throws `ZodError` on an invalid value). */
export function parseClaimValue<T extends ClaimType>(claimType: T, value: unknown): ClaimValue<T> {
  return CLAIM_VALUE_SCHEMAS[claimType].parse(value) as ClaimValue<T>;
}
