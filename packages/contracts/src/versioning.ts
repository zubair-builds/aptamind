import { z } from 'zod';

/** Fields every important persisted document carries. */
export const documentMetaSchema = z.object({
  schemaVersion: z.number().int().positive(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type DocumentMeta = z.infer<typeof documentMetaSchema>;

/**
 * Regression metadata retained by derived intelligence so it can be recomputed and
 * compared in a controlled way (see context doc §25.4).
 */
export const derivationMetaSchema = z.object({
  logicVersion: z.string(),
  policyVersion: z.string().optional(),
  taxonomyVersion: z.string().optional(),
  promptVersion: z.string().optional(),
  modelVersion: z.string().optional(),
  computedAt: z.coerce.date(),
});
export type DerivationMeta = z.infer<typeof derivationMetaSchema>;
