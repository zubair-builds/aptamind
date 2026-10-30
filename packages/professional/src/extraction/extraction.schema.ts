import { z } from 'zod';
import { artifactRefSchema } from '@aptamind/contracts';
import { defineCollection } from '@aptamind/db';
import { codeSchema, documentMetaFields } from '../documents';
import { idSchema } from '../contracts/ids';
import { professionalValidator } from '../validators';

export const EXTRACTION_SCHEMA_VERSION = 1;

export const EXTRACTOR_KINDS = ['text', 'deterministic', 'ai'] as const;
export const EXTRACTION_STATUSES = ['running', 'completed', 'skipped', 'failed'] as const;
export const EXTRACTION_SKIP_REASONS = [
  'ai_not_permitted',
  'ai_unavailable',
  'unsupported_format',
  'limits_exceeded',
] as const;

export const extractorRefSchema = z.object({
  name: z.string().min(1).max(80),
  /** Integer version: orders numerically (`10 > 9`) in indexes and supersession. */
  version: z.number().int().positive(),
  kind: z.enum(EXTRACTOR_KINDS),
});

/**
 * One extractor run over one snapshot: `det(snapshotId, extractorName, extractorVersion)`. A
 * `completed` extraction is the replay marker; a newer extractor version marks the older one
 * not `current` for the same snapshot only (R-10).
 */
export const extractionDocSchema = z.strictObject({
  _id: idSchema('extraction'),
  subjectId: idSchema('subject'),
  sourceId: idSchema('source'),
  snapshotId: idSchema('snapshot'),
  extractor: extractorRefSchema,
  status: z.enum(EXTRACTION_STATUSES),
  current: z.boolean(),
  /** Normalized text (content-addressed artifact) for text extractors. */
  textArtifact: artifactRefSchema.optional(),
  /** Section map of the normalized text: offsets and content hashes, never text. */
  sections: z.array(
    z.object({
      id: z.string().min(1).max(40),
      class: z.string().min(1).max(40),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
      hash: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
  /** Counts only; `protectedDropped` counts protected data dropped before persistence (R-11). */
  counts: z.object({
    observations: z.number().int().nonnegative(),
    dropped: z.number().int().nonnegative(),
    protectedDropped: z.number().int().nonnegative(),
    unverifiedSpans: z.number().int().nonnegative(),
  }),
  skipReason: z.enum(EXTRACTION_SKIP_REASONS).optional(),
  error: z.object({ code: codeSchema }).optional(),
  runId: z.string().optional(),
  completedAt: z.date().optional(),
  ...documentMetaFields,
});
export type ExtractionDoc = z.infer<typeof extractionDocSchema>;

export const extractionsCollection = defineCollection<ExtractionDoc>({
  name: 'professional_extractions',
  description: 'Extractor runs per snapshot (ledger and replay marker): status, section map, counts.',
  schema: extractionDocSchema,
  schemaVersion: EXTRACTION_SCHEMA_VERSION,
  validator: professionalValidator(extractionDocSchema),
  indexes: [
    {
      key: { snapshotId: 1, 'extractor.name': 1, 'extractor.version': -1 },
      options: { name: 'by_snapshot_extractor' },
      rationale: 'Latest version of an extractor for a snapshot; supersession by extractor version.',
    },
    {
      key: { subjectId: 1, createdAt: -1 },
      options: { name: 'by_subject' },
      rationale: "A subject's extractions; erasure enumeration.",
    },
    {
      key: { 'textArtifact.artifactId': 1 },
      options: {
        name: 'by_text_artifact',
        partialFilterExpression: { 'textArtifact.artifactId': { $exists: true } },
      },
      rationale:
        'Artifact ownership check (generic artifact routes refuse Professional text, FE-P6); erasure.',
    },
  ],
});
