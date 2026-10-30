import { z } from 'zod';
import { actorSchema } from '@aptamind/contracts';
import { defineCollection } from '@aptamind/db';

export const IMPORT_SCHEMA_VERSION = 1;

export const IMPORT_TYPES = ['companies', 'ats_boards', 'snapshot', 'jobs'] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];

/** Derived from the run when read (never stored). */
export const IMPORT_STATUSES = [
  'processing',
  'completed',
  'completed_with_issues',
  'failed',
  'cancelled',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/**
 * One operator file pushed through the evidence path (market-imports.md). Append-only: status
 * and counts are derived from the run when read, so they cannot drift.
 */
export const importDocSchema = z.object({
  _id: z.string(),
  type: z.enum(IMPORT_TYPES),
  fileName: z.string().max(255),
  contentType: z.string(),
  bytes: z.number().int().nonnegative(),
  contentHash: z.string(),
  artifactId: z.string(),
  snapshotId: z.string(),
  snapshotUnchanged: z.boolean(),
  sourceId: z.string(),
  runId: z.string().nullable(),
  createdBy: actorSchema,
  createdAt: z.date(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  schemaVersion: z.number().int(),
});
export type ImportDoc = z.infer<typeof importDocSchema>;

export const importsCollection = defineCollection<ImportDoc>({
  name: 'market_imports',
  description: 'Operator file imports: each points at the snapshot and run that did the work.',
  schema: importDocSchema,
  schemaVersion: IMPORT_SCHEMA_VERSION,
  indexes: [
    {
      key: { createdAt: -1, _id: -1 },
      options: { name: 'by_recent' },
      rationale: 'Import list, newest first (keyset on createdAt, _id).',
    },
    {
      key: { sourceId: 1, createdAt: -1, _id: -1 },
      options: { name: 'by_source_recent' },
      rationale: 'Import list filtered by source.',
    },
    {
      key: { type: 1, createdAt: -1, _id: -1 },
      options: { name: 'by_type_recent' },
      rationale: 'Import list filtered by type.',
    },
  ],
});
