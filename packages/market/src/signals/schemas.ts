import { z } from 'zod';
import { jsonObjectSchema } from '@aptamind/contracts';
import { defineCollection } from '@aptamind/db';
import { confidenceSchema, evidenceReferenceSchema } from '@aptamind/provenance';

export const SIGNAL_SCHEMA_VERSION = 1;

export const SIGNAL_TYPES = [
  'funding_event',
  'hiring_intent',
  'team_expansion',
  'new_office',
  'leadership_change',
  'careers_page_spike',
  'product_launch',
  'remote_policy_change',
  'job_mention',
  // Signal vocabulary v1 (DECISION_LOG 2026-10-01 O): lifecycle signals written by OPS-4.
  'job_discovered',
  'job_changed',
  'job_closed',
  'job_reopened',
  'job_reposted',
  // Vocabulary v1 canonical-change signals (OPS-4, writer company-change/1).
  'hiring_acceleration',
  'role_family_expansion',
  'new_location_hiring',
  'sponsorship_change',
] as const;

/**
 * Signal: a market event that may indicate change/opportunity but is not a formal job.
 * v0.1 provides the schema, storage and API seam only; broad signal collection is follow-on work.
 */
export const signalDocSchema = z.object({
  _id: z.string(),
  type: z.enum(SIGNAL_TYPES),
  companyIds: z.array(z.string()),
  actor: z.object({ name: z.string(), role: z.string().optional() }).optional(),
  sourceId: z.string(),
  evidence: z.array(evidenceReferenceSchema),
  occurredAt: z.date().optional(),
  observedAt: z.date(),
  facts: jsonObjectSchema,
  confidence: confidenceSchema,
  state: z.enum(['new', 'triaged', 'actioned', 'dismissed']),
  dedupeKey: z.string(),
  schemaVersion: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type SignalDoc = z.infer<typeof signalDocSchema>;

export const signalsCollection = defineCollection<SignalDoc>({
  name: 'market_signals',
  description: 'Market signals (schema/seam in v0.1).',
  schema: signalDocSchema,
  schemaVersion: SIGNAL_SCHEMA_VERSION,
  indexes: [
    {
      key: { dedupeKey: 1 },
      options: { name: 'uniq_dedupe', unique: true },
      rationale: 'Idempotent signal capture.',
    },
    {
      key: { companyIds: 1, observedAt: -1 },
      options: { name: 'by_company_time' },
      rationale: 'Signals per company.',
    },
    {
      key: { type: 1, state: 1, observedAt: -1 },
      options: { name: 'by_type_state' },
      rationale: 'Signal triage lists.',
    },
    {
      key: { 'facts.writer': 1, createdAt: -1 },
      options: { name: 'by_writer_time', sparse: true },
      rationale: 'OPS-4 writer cursor: the latest signal a writer recorded.',
    },
  ],
});

/**
 * OPS-4 canonical-change detection state: what the company-change writer last saw per company.
 * A DERIVED cache (rebuildable); `rev` fences concurrent passes. The first pass of a company only
 * records a baseline (no signals): unknown history stays unknown, never a burst of "new" signals.
 */
export const companySignalStateDocSchema = z.object({
  _id: z.string(),
  writer: z.string(),
  capability: z.string(),
  remotePolicy: z.string().nullable(),
  roleFamilies: z.array(z.string()),
  locations: z.array(z.string()),
  rev: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type CompanySignalStateDoc = z.infer<typeof companySignalStateDocSchema>;

export const companySignalStateCollection = defineCollection<CompanySignalStateDoc>({
  name: 'market_company_signal_state',
  description: 'Derived per-company state the OPS-4 canonical-change signal writer compares against.',
  schema: companySignalStateDocSchema,
  schemaVersion: SIGNAL_SCHEMA_VERSION,
  indexes: [],
});
