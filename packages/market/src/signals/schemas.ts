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
      rationale:
        'Signals of one writer, newest first. Resume points live in market_signal_writer_cursors, not here.',
    },
    {
      key: { 'evidence.snapshotId': 1 },
      options: {
        name: 'by_evidence_snapshot',
        partialFilterExpression: { 'evidence.snapshotId': { $exists: true } },
      },
      rationale: 'Retention sweep (OPS-3): a snapshot cited by signal evidence is held.',
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

/** `_id` of the lifecycle writer's resume document in `market_signal_writer_cursors`. */
export const LIFECYCLE_SIGNAL_CURSOR_ID = 'lifecycle';
/** `_id` of the company-change writer's resume document. */
export const COMPANY_CHANGE_CURSOR_ID = 'company_change';

/**
 * OPS-4 signal-writer resume points. Derived bookkeeping: dropping a document only makes the next
 * pass rescan (signal dedupe keys make that a no-op). The lifecycle writer stores the
 * `(updatedAt, _id)` of the last job it scanned; the company-change writer stores the last company
 * id (`''` means the next pass starts at the beginning).
 */
export const signalWriterCursorDocSchema = z.object({
  _id: z.string(),
  /** Lifecycle writer: `updatedAt` of the last job scanned. */
  jobUpdatedAt: z.date().optional(),
  /** Lifecycle writer: `_id` of that job (keyset tiebreak). */
  jobId: z.string().optional(),
  /** Company-change writer: last company id scanned; `''` wraps to the start. */
  companyId: z.string().optional(),
  updatedAt: z.date(),
});
export type SignalWriterCursorDoc = z.infer<typeof signalWriterCursorDocSchema>;

export const signalWriterCursorsCollection = defineCollection<SignalWriterCursorDoc>({
  name: 'market_signal_writer_cursors',
  description:
    'Resume points of the OPS-4 signal writers (lifecycle job keyset and company-change company id).',
  schema: signalWriterCursorDocSchema,
  schemaVersion: SIGNAL_SCHEMA_VERSION,
  // One document per writer, read by `_id`. The job keyset uses `market_jobs.by_updated`.
  indexes: [],
});
