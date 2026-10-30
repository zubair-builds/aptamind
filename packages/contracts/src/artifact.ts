import { z } from 'zod';

/**
 * Immutable reference to a stored artifact (raw HTML, CSV, JSON payload, ...).
 * The bytes live in S3-compatible object storage; MongoDB stores only this reference.
 */
export const artifactRefSchema = z.object({
  artifactId: z.string(),
  storageKey: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  createdAt: z.coerce.date(),
});
export type ArtifactRef = z.infer<typeof artifactRefSchema>;

export const artifactContextSchema = z.object({
  runId: z.string().optional(),
  nodeRunId: z.string().optional(),
  workflowKey: z.string().optional(),
  /** Free-form labels, e.g. `{ sourceId: 'src_...' }`. Kept generic on purpose. */
  labels: z.record(z.string(), z.string()).default({}),
});
export type ArtifactContext = z.infer<typeof artifactContextSchema>;
