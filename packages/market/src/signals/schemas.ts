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
  ],
});
