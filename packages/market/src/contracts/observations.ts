import { z } from 'zod';
import { atsRefSchema, locationSchema } from './common';

/**
 * Observation payload contracts. Source adapters translate provider-specific shapes into
 * these; provider shapes never reach canonical entities. Raw provider payloads remain in
 * the snapshot artifact, addressed by `locator`.
 */

export const sponsorLicenceObservationSchema = z.object({
  /** Register identifier, e.g. `uk_home_office_licensed_sponsors`. */
  register: z.string(),
  /** Country whose immigration system the licence belongs to. */
  country: z.string().length(2),
  route: z.string(),
  typeRating: z.string().nullable().optional(),
  town: z.string().nullable().optional(),
  county: z.string().nullable().optional(),
});
export type SponsorLicenceObservation = z.infer<typeof sponsorLicenceObservationSchema>;

/**
 * Sponsorship HISTORY evidence (M11.5): what a history register (e.g. the USCIS H-1B Employer
 * Data Hub) says the company did in one fiscal year. Hiring history only: never capability,
 * never a role statement, and evidence for `country` only.
 */
export const sponsorshipHistoryObservationSchema = z.object({
  /** Register id, e.g. `us_uscis_h1b_employer_data_hub`. */
  register: z.string(),
  /** Country whose immigration system the history belongs to. */
  country: z.string().length(2),
  route: z.string(),
  fiscalYear: z.number().int().min(1990).max(2100),
  initialApprovals: z.number().int().min(0),
  initialDenials: z.number().int().min(0),
  continuingApprovals: z.number().int().min(0),
  continuingDenials: z.number().int().min(0),
  /** Where the register places the employer (state: two-letter code). */
  state: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
});
export type SponsorshipHistoryObservation = z.infer<typeof sponsorshipHistoryObservationSchema>;

export const companyObservationPayloadSchema = z.object({
  name: z.string().min(1),
  legalName: z.string().nullable().optional(),
  aliases: z.array(z.string()).default([]),
  domain: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  externalIds: z.array(z.object({ namespace: z.string(), id: z.string() })).default([]),
  locations: z.array(locationSchema).default([]),
  industries: z.array(z.string()).default([]),
  employeeCount: z
    .object({
      estimate: z.number().int().nullable().optional(),
      min: z.number().int().nullable().optional(),
      max: z.number().int().nullable().optional(),
    })
    .nullable()
    .optional(),
  foundedYear: z.number().int().min(1600).max(2100).nullable().optional(),
  fundingStage: z.string().nullable().optional(),
  careersUrl: z.string().nullable().optional(),
  /**
   * The detected board. Discovery also records its region and provider API base (M6.3, A-L3
   * follow-up): observation-level evidence only — the canonical `employment.ats` fact keeps
   * `{provider, boardToken}`.
   */
  ats: atsRefSchema
    .extend({ region: z.string().optional(), apiBase: z.string().url().optional() })
    .nullable()
    .optional(),
  sponsorLicence: sponsorLicenceObservationSchema.nullable().optional(),
  /**
   * Sponsorship history (M11.5). An observation carrying it is history evidence only: it never
   * contributes names, locations or other identity facts to the company it attaches to.
   */
  sponsorshipHistory: sponsorshipHistoryObservationSchema.nullable().optional(),
  remotePolicyText: z.string().nullable().optional(),
  relocationSupportText: z.string().nullable().optional(),
});
export type CompanyObservationPayload = z.infer<typeof companyObservationPayloadSchema>;

export const jobObservationPayloadSchema = z.object({
  externalId: z.string().min(1),
  requisitionId: z.string().nullable().optional(),
  title: z.string().min(1),
  companyName: z.string().nullable().optional(),
  descriptionHtml: z.string().nullable().optional(),
  descriptionText: z.string().nullable().optional(),
  locations: z.array(locationSchema.extend({ text: z.string() })).default([]),
  /** Provider's structured workplace flag — a hint only; explicit description text can override it. */
  workplaceType: z.enum(['remote', 'hybrid', 'onsite']).nullable().optional(),
  employmentTypeText: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  team: z.string().nullable().optional(),
  postingUrl: z.string().nullable().optional(),
  applyUrl: z.string().nullable().optional(),
  publishedAt: z.string().nullable().optional(),
  sourceUpdatedAt: z.string().nullable().optional(),
  compensation: z
    .object({
      text: z.string().nullable().optional(),
      min: z.number().nullable().optional(),
      max: z.number().nullable().optional(),
      currency: z.string().nullable().optional(),
      period: z.enum(['hour', 'day', 'week', 'month', 'year']).nullable().optional(),
    })
    .nullable()
    .optional(),
  provider: z.object({ name: z.string(), boardToken: z.string().nullable().optional() }),
});
export type JobObservationPayload = z.infer<typeof jobObservationPayloadSchema>;
