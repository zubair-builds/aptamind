import { z } from 'zod';
import { REGION_CODES } from '@aptamind/taxonomy';

/**
 * Employment-intelligence contracts (output of job interpretation).
 *
 * Design rules (context doc §13):
 *  - `remote` is never a boolean: work model + remote scope + constraints.
 *  - explicit job statements override company-level assumptions for that role;
 *  - `company_capable` is never presented as `explicit_yes`;
 *  - unknown stays unknown (`unclear`, nulls) — nothing is invented.
 * Every interpreted field carries evidence spans into the source text and a confidence.
 */

export const evidenceSpanSchema = z.object({
  /** Which text the span refers to. */
  field: z.enum(['title', 'description', 'location', 'provider', 'company']),
  start: z.number().int().min(0).optional(),
  end: z.number().int().min(0).optional(),
  quote: z.string().max(600),
  /**
   * For a `description` span: which rendering the offsets point into. `html_layout` — the
   * canonical statement rendering of the copy's HTML (sponsorship, DECISION_LOG a720377), not
   * `content.descriptionText`; absent or `description_text` — `descriptionText`. Show the quote.
   */
  rendering: z.enum(['html_layout', 'description_text']).optional(),
});
export type EvidenceSpan = z.infer<typeof evidenceSpanSchema>;

/**
 * An interpretation flag. `value` / `evidence` are optional (added by DECISION_LOG 012d041 for
 * `sponsorship_stated`: the stated `yes` / `no` and its structured line); older flags lack them.
 */
export const interpretationFlagSchema = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(['info', 'warning', 'high']),
  /**
   * Only `sponsorship_stated` carries a value: the stated `yes` / `no` (8d96663 L3). Optional, so
   * flags stored before v2.1 (no value) still parse.
   */
  value: z.enum(['yes', 'no']).optional(),
  /** `sponsorship_stated` of a country-specific key (H-1B, Skilled Worker, Blue Card): its countries. */
  scope: z.array(z.string().length(2)).optional(),
  evidence: evidenceSpanSchema.optional(),
});

export const interpretedConfidenceSchema = z.enum(['high', 'medium', 'low', 'unknown']);

function interpreted<T extends z.ZodType>(value: T) {
  return z.object({
    value,
    confidence: interpretedConfidenceSchema,
    evidence: z.array(evidenceSpanSchema).default([]),
    /** Which rule/source decided the value, e.g. `description.explicit`, `provider.workplaceType`. */
    basis: z.string(),
  });
}

export const WORK_MODELS = ['remote', 'hybrid', 'onsite', 'unclear'] as const;
export const REMOTE_SCOPE_TYPES = [
  'worldwide',
  'region',
  'country',
  'selected_countries',
  'timezone',
  'unclear',
  'not_applicable',
] as const;
export const SPONSORSHIP_STATUSES = [
  'explicit_yes',
  'explicit_no',
  'company_capable',
  'historical_evidence',
  'unclear',
] as const;
export const RELOCATION_STATUSES = ['explicit_yes', 'explicit_no', 'possible', 'unclear'] as const;
export const EMPLOYMENT_TYPES = [
  'full_time',
  'part_time',
  'contract',
  'temporary',
  'internship',
  'apprenticeship',
  'freelance',
  'unclear',
] as const;
export const SENIORITY_LEVELS = [
  'intern',
  'junior',
  'mid',
  'senior',
  'staff',
  'principal',
  'lead',
  'manager',
  'director',
  'vp',
  'executive',
  'unclear',
] as const;
export const REQUIREMENT_IMPORTANCE = ['critical', 'important', 'preferred', 'incidental'] as const;
export const REQUIREMENT_CATEGORIES = [
  'skill',
  'experience',
  'education',
  'certification',
  'language',
  'authorization',
  'location',
  'soft_skill',
  'other',
] as const;
export const PAY_PERIODS = ['hour', 'day', 'week', 'month', 'year'] as const;

export const remoteScopeSchema = z.object({
  type: z.enum(REMOTE_SCOPE_TYPES),
  /** ISO alpha-2 countries where the role may be performed (remote) — empty if not restricted to countries. */
  countries: z.array(z.string().length(2)).default([]),
  /** Taxonomy region codes, e.g. EMEA, EU, EEA, EUROPE, NORTH_AMERICA, LATAM, APAC. */
  regions: z.array(z.string()).default([]),
  excludedCountries: z.array(z.string().length(2)).default([]),
  excludedRegions: z.array(z.string()).default([]),
  timezone: z
    .object({
      /** UTC offsets in hours (inclusive) the worker must be within, when stated. */
      minUtcOffset: z.number().nullable(),
      maxUtcOffset: z.number().nullable(),
      text: z.string(),
    })
    .nullable()
    .default(null),
});
export type RemoteScope = z.infer<typeof remoteScopeSchema>;

export const officeAttendanceSchema = z.object({
  required: z.boolean().nullable(),
  daysPerWeek: z.number().min(0).max(7).nullable().default(null),
  officeLocations: z.array(z.string()).default([]),
});

export const normalizedLocationSchema = z.object({
  text: z.string(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  country: z.string().length(2).nullable(),
  isRemoteLabel: z.boolean(),
});
export type NormalizedLocation = z.infer<typeof normalizedLocationSchema>;

export const sponsorshipSchema = z.object({
  status: z.enum(SPONSORSHIP_STATUSES),
  /** What the job itself says, independent of company capability. */
  roleStatement: z.enum(['yes', 'no', 'none']),
  /**
   * Company-level capability evidence, kept separate from the role statement:
   * `licensed` — a current sponsor licence (capability tier); `previously_licensed` — a licence no
   * longer on the register (past capability, M11.1: never hiring history and never a role
   * signal); `historical` — hiring-history evidence (reserved for sponsorship-history datasets,
   * M11.5); `none`; `unknown` (no company context).
   */
  companyCapability: z.enum(['licensed', 'previously_licensed', 'historical', 'none', 'unknown']),
  /** Countries the company capability applies to (e.g. GB for the UK register). */
  capabilityCountries: z.array(z.string().length(2)).default([]),
});
export type Sponsorship = z.infer<typeof sponsorshipSchema>;

export const authorizationSchema = z.object({
  required: z.boolean().nullable(),
  countries: z.array(z.string().length(2)).default([]),
  /**
   * Taxonomy region codes named by the requirement (e.g. `EU` for "eligible to work in an EU
   * country"). Only known taxonomy codes (PR #21 L7); shown as given, never expanded to countries.
   */
  regions: z
    .array(z.string().refine((code) => REGION_CODES.includes(code), 'unknown taxonomy region code'))
    .default([]),
  /** e.g. security clearance, citizenship. */
  qualifiers: z.array(z.string()).default([]),
});

export const compensationSchema = z.object({
  status: z.enum(['parsed', 'unknown', 'ambiguous', 'malformed']),
  min: z.number().nonnegative().nullable(),
  max: z.number().nonnegative().nullable(),
  currency: z.string().length(3).nullable(),
  period: z.enum(PAY_PERIODS).nullable(),
  basis: z.enum(['base_salary', 'total_compensation', 'ote', 'contract_rate', 'unknown']),
  /** Annualised equivalents with the assumptions used (e.g. 2080 hours/year). Null when not derivable. */
  annualized: z
    .object({ min: z.number().nullable(), max: z.number().nullable(), assumptions: z.array(z.string()) })
    .nullable(),
  equityText: z.string().nullable(),
  bonusText: z.string().nullable(),
  originalText: z.string().nullable(),
  warnings: z.array(z.string()).default([]),
});
export type Compensation = z.infer<typeof compensationSchema>;

export const requirementSchema = z.object({
  text: z.string(),
  normalizedConcept: z.string().nullable(),
  category: z.enum(REQUIREMENT_CATEGORIES),
  importance: z.enum(REQUIREMENT_IMPORTANCE),
  explicitness: z.enum(['explicit', 'inferred']),
  yearsMin: z.number().min(0).max(40).nullable(),
  section: z.string().nullable(),
  evidence: evidenceSpanSchema,
  confidence: interpretedConfidenceSchema,
});
export type Requirement = z.infer<typeof requirementSchema>;

const scopeSignal = z.object({ present: z.boolean(), evidence: z.array(evidenceSpanSchema).default([]) });
export const responsibilitiesSchema = z.object({
  architecture: scopeSignal,
  implementation: scopeSignal,
  ownership: scopeSignal,
  leadership: scopeSignal,
  management: scopeSignal,
  productCollaboration: scopeSignal,
  operationalResponsibility: scopeSignal,
});

export const titleInterpretationSchema = z.object({
  original: z.string(),
  normalized: z.string(),
  roleFamily: z.string().nullable(),
  specialization: z.string().nullable(),
  seniority: z.enum(SENIORITY_LEVELS),
  department: z.string().nullable(),
});

export const jobInterpretationSchema = z.object({
  title: interpreted(titleInterpretationSchema),
  employmentType: interpreted(z.enum(EMPLOYMENT_TYPES)),
  locations: z.array(normalizedLocationSchema),
  workModel: interpreted(z.enum(WORK_MODELS)),
  remoteScope: interpreted(remoteScopeSchema),
  officeAttendance: interpreted(officeAttendanceSchema),
  sponsorship: interpreted(sponsorshipSchema),
  authorization: interpreted(authorizationSchema),
  relocation: interpreted(z.enum(RELOCATION_STATUSES)),
  compensation: interpreted(compensationSchema),
  requirements: z.array(requirementSchema),
  responsibilities: responsibilitiesSchema,
  /** Material ambiguity worth human review (e.g. conflicting work-model statements). */
  flags: z.array(interpretationFlagSchema).default([]),
  logicVersion: z.string(),
  policyVersion: z.string(),
  taxonomyVersion: z.string(),
});
export type JobInterpretation = z.infer<typeof jobInterpretationSchema>;

/** Input to the deterministic interpreter. */
export const jobInterpretationInputSchema = z.object({
  title: z.string(),
  descriptionText: z.string(),
  /**
   * The canonical rendering sponsorship statements are read from (DECISION_LOG a720377 (1)):
   * `html_layout` — the enrichment rendering of the copy's `descriptionHtml` whenever it contains
   * markup, with the start offsets of the lines holding text from outside the statement context
   * (`layoutLineStarts`: tables, struck or hidden text, …; never a stated value, 5a13fed);
   * `description_text` — `descriptionText` itself, when there is no markup. Absent: read
   * `descriptionText`. Sponsorship evidence offsets point into `text` and say which rendering.
   */
  statementSource: z
    .object({
      rendering: z.enum(['html_layout', 'description_text']),
      text: z.string(),
      layoutLineStarts: z.array(z.number().int().min(0)).default([]),
    })
    .optional(),
  locationTexts: z.array(z.string()).default([]),
  provider: z
    .object({
      workplaceType: z.enum(['remote', 'hybrid', 'onsite']).nullable().optional(),
      employmentTypeText: z.string().nullable().optional(),
      department: z.string().nullable().optional(),
      compensation: z
        .object({
          text: z.string().nullable().optional(),
          min: z.number().nullable().optional(),
          max: z.number().nullable().optional(),
          currency: z.string().nullable().optional(),
          period: z.enum(PAY_PERIODS).nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .default({}),
  company: z
    .object({
      /** Countries where the company holds a sponsor licence (from registry evidence). */
      sponsorLicenceCountries: z.array(z.string().length(2)).default([]),
      /**
       * Countries with sponsorship HIRING HISTORY (e.g. visa-disclosure datasets; weaker than
       * capability). No productised source populates it yet (M11.5).
       */
      historicalSponsorshipCountries: z.array(z.string().length(2)).default([]),
      /** Countries of sponsor licences no longer on the register: past capability, not history. */
      previousLicenceCountries: z.array(z.string().length(2)).default([]),
      hqCountry: z.string().length(2).nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type JobInterpretationInput = z.input<typeof jobInterpretationInputSchema>;
