import { z } from 'zod';
import { defineCollection } from '@aptamind/db';
import { confidenceSchema, evidenceReferenceSchema, factSchema } from '@aptamind/provenance';
import { atsRefSchema, locationSchema } from '../contracts/common';

export const COMPANY_SCHEMA_VERSION = 1;

export const licenceSchema = z.object({
  register: z.string(),
  country: z.string().length(2),
  route: z.string(),
  typeRating: z.string().nullable(),
  /** `listed` while present in the latest complete import of the register. */
  status: z.enum(['listed', 'no_longer_listed']),
  firstSeenAt: z.date(),
  lastSeenAt: z.date(),
  evidence: z.array(evidenceReferenceSchema),
});
export type Licence = z.infer<typeof licenceSchema>;

/**
 * Sponsorship hiring history of one register route and fiscal year (M11.5), summed over the
 * register's rows attached to the company. History, never capability: it does not change
 * `capability` or `licenceCountries`.
 */
export const sponsorshipHistorySchema = z.object({
  register: z.string(),
  country: z.string().length(2),
  route: z.string(),
  fiscalYear: z.number().int(),
  initialApprovals: z.number().int().min(0),
  initialDenials: z.number().int().min(0),
  continuingApprovals: z.number().int().min(0),
  continuingDenials: z.number().int().min(0),
  /** Register rows summed into this entry. */
  rows: z.number().int().min(1),
  evidence: z.array(evidenceReferenceSchema),
});
export type SponsorshipHistory = z.infer<typeof sponsorshipHistorySchema>;

/** Outcome of the latest careers/ATS discovery for a company (`freshness.careersDiscoveryStatus`). */
export const CAREERS_DISCOVERY_STATUSES = [
  'not_attempted',
  'found',
  'not_found',
  'failed',
  'website_unknown',
] as const;

export const COMPANY_STAGES = [
  'startup',
  'scale_up',
  'mid_market',
  'enterprise',
  'public_sector',
  'non_profit',
] as const;

/**
 * Canonical Company — Aptamind's current best understanding of an employer. Every material
 * field is a Fact (value + evidence + confidence + conflicts + policy version).
 */
export const companyDocSchema = z.object({
  _id: z.string(),
  status: z.enum(['active', 'merged']),
  mergedInto: z.string().optional(),
  /** Unique multikey: `name:<strict>`, `domain:<d>`, `ext:<ns>:<id>`. Prevents duplicate creation under concurrency. */
  identityKeys: z.array(z.string()),
  identity: z.object({
    displayName: factSchema(z.string()),
    legalName: factSchema(z.string()),
    normalizedName: z.string(),
    looseKey: z.string(),
    firstToken: z.string(),
    aliases: z.array(z.object({ name: z.string(), strictKey: z.string(), sourceIds: z.array(z.string()) })),
    domain: factSchema(z.string()),
    website: factSchema(z.string()),
    externalIds: z.array(z.object({ namespace: z.string(), id: z.string() })),
    /** Pairs an operator declared distinct (suppresses repeated duplicate reviews). */
    distinctFrom: z.array(z.string()).default([]),
  }),
  classification: z.object({
    industries: factSchema(z.array(z.string())),
    stage: factSchema(z.enum(COMPANY_STAGES)),
    businessModel: factSchema(z.string()),
    /** Configurable classification schemes (e.g. a future Shariah screening methodology). */
    schemes: z
      .array(
        z.object({
          scheme: z.string(),
          value: z.string(),
          confidence: confidenceSchema,
          evidence: z.array(evidenceReferenceSchema),
        }),
      )
      .default([]),
  }),
  firmographics: z.object({
    foundedYear: factSchema(z.number().int()),
    employeeEstimate: factSchema(z.number().int()),
    employeeRange: factSchema(
      z.object({ min: z.number().int().nullable(), max: z.number().int().nullable() }),
    ),
    fundingStage: factSchema(z.string()),
  }),
  geography: z.object({
    headquarters: factSchema(locationSchema),
    offices: z.array(locationSchema),
    registeredLocations: z.array(locationSchema),
    hiringCountries: factSchema(z.array(z.string())),
  }),
  employment: z.object({
    careersUrls: factSchema(z.array(z.string())),
    ats: factSchema(z.array(atsRefSchema)),
    remotePolicy: factSchema(z.string()),
    sponsorship: z.object({
      /** Company-level capability only. Never implies any specific role sponsors. */
      capability: factSchema(z.enum(['licensed', 'previously_licensed'])),
      licenceCountries: z.array(z.string()),
      licences: z.array(licenceSchema),
      /** Hiring history per register route and fiscal year (M11.5; absent before it). */
      history: z.array(sponsorshipHistorySchema).default([]),
      /** Countries with at least one approval in `history` (hiring history, not capability). */
      historyCountries: z.array(z.string()).default([]),
    }),
    relocationSupport: factSchema(z.string()),
    eorIndicators: factSchema(z.array(z.string())),
  }),
  /** Seam for future people/organization enrichment (not populated in v0.1). */
  organization: z.object({
    founders: z.array(z.object({ name: z.string(), evidence: z.array(evidenceReferenceSchema) })).default([]),
    leadership: z
      .array(
        z.object({
          name: z.string(),
          title: z.string().optional(),
          evidence: z.array(evidenceReferenceSchema),
        }),
      )
      .default([]),
  }),
  quality: z.object({
    observationCount: z.number().int(),
    sourceIds: z.array(z.string()),
    conflictFields: z.array(z.string()),
    openReviewCount: z.number().int(),
    lastObservedAt: z.date().optional(),
  }),
  freshness: z.object({
    lastReconciledAt: z.date().optional(),
    lastChangedAt: z.date().optional(),
    careersCheckedAt: z.date().optional(),
    careersDiscoveryStatus: z.enum(CAREERS_DISCOVERY_STATUSES).default('not_attempted'),
  }),
  reconciliation: z
    .object({
      logicVersion: z.string(),
      policyVersion: z.string(),
      computedAt: z.date(),
      contentHash: z.string(),
    })
    .optional(),
  /**
   * Revision of the reconciled state: advanced by every write of fields the reconciler derives
   * (the reconciler's own compare-and-set write, and a merge into this company). A
   * reconciliation commits only if the revision it read is still current. Absent = 0.
   */
  rev: z.number().int().min(0).optional(),
  schemaVersion: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type CompanyDoc = z.infer<typeof companyDocSchema>;

export const companiesCollection = defineCollection<CompanyDoc>({
  name: 'market_companies',
  description: 'Canonical companies with fact-level provenance.',
  schema: companyDocSchema,
  schemaVersion: COMPANY_SCHEMA_VERSION,
  indexes: [
    {
      key: { identityKeys: 1 },
      // Partial on active: merged companies hold no keys, and an empty array would otherwise be
      // indexed as a shared null key (so only one merged company could ever exist).
      options: { name: 'uniq_identity_keys', unique: true, partialFilterExpression: { status: 'active' } },
      rationale:
        'Uniqueness of normalized domain, external ids and strict legal name across companies. Concurrent imports cannot create duplicates; a second insert fails and re-resolves.',
    },
    {
      key: { 'identity.looseKey': 1 },
      options: { name: 'by_loose_key' },
      rationale: 'Probable-match lookup (legal-form-insensitive).',
    },
    {
      key: { 'identity.firstToken': 1 },
      options: { name: 'by_first_token' },
      rationale: 'Candidate blocking for fuzzy fallback.',
    },
    {
      key: { 'identity.aliases.strictKey': 1 },
      options: { name: 'by_alias' },
      rationale: 'Alias lookup during resolution.',
    },
    {
      key: { status: 1, 'identity.normalizedName': 1, _id: 1 },
      options: { name: 'by_status_name' },
      rationale:
        'Company list sorted by name with the `_id` tiebreak (keyset pagination, `sort=name`), and the anchored name-prefix search.',
    },
    {
      key: { status: 1, createdAt: -1, _id: -1 },
      options: { name: 'list_created' },
      rationale: 'Company list `sort=createdAt` (keyset pagination).',
    },
    {
      key: { status: 1, 'freshness.lastChangedAt': -1, _id: -1 },
      options: { name: 'list_changed' },
      rationale:
        'Company list `sort=lastChangedAt` and `changedAfter/Before` (keyset pagination); the dashboard `changed` count (active companies changed since).',
    },
    {
      key: { 'identity.domain.value': 1 },
      options: { name: 'by_domain' },
      rationale: 'Company list: anchored domain-prefix search and `hasDomain`.',
    },
    {
      key: { mergedInto: 1 },
      options: { name: 'by_merged_into', partialFilterExpression: { mergedInto: { $exists: true } } },
      rationale:
        'Records merged into a survivor (run history includes runs labelled with them). Partial: only merged records are indexed.',
    },
    {
      key: { 'quality.sourceIds': 1 },
      options: { name: 'by_source_ids' },
      rationale: 'Company list `sourceId` filter (companies a source contributed to).',
    },
    {
      key: { 'employment.sponsorship.licenceCountries': 1 },
      options: { name: 'by_sponsor_country' },
      rationale: 'Filter sponsor-licensed companies.',
    },
    {
      key: { 'freshness.careersDiscoveryStatus': 1, 'freshness.careersCheckedAt': 1 },
      options: { name: 'by_careers_discovery' },
      rationale: 'Due careers-discovery queries.',
    },
    {
      key: { status: 1, 'freshness.careersCheckedAt': 1, _id: 1 },
      options: {
        name: 'by_careers_due_with_domain',
        partialFilterExpression: { 'identity.domain.value': { $type: 'string' } },
      },
      rationale:
        'Scheduled careers discovery (OPS-1): companies with a domain, never tried or tried longest ago first.',
    },
  ],
});
