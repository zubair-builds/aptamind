import { z } from 'zod';
import { artifactRefSchema } from '@aptamind/contracts';

/**
 * A potentially large collection of records passed between nodes by reference.
 * Records are stored as a JSON Lines artifact so they never bloat workflow state
 * documents (a UK sponsor dataset is >100k rows).
 */
export const recordSetSchema = z.object({
  kind: z.literal('recordset'),
  format: z.literal('jsonl'),
  artifact: artifactRefSchema,
  count: z.number().int().nonnegative(),
});
export type RecordSet = z.infer<typeof recordSetSchema>;

/** Either an inline array (small) or a record set (large). */
export const recordsInputSchema = z.union([z.array(z.unknown()), recordSetSchema]);
export type RecordsInput = z.infer<typeof recordsInputSchema>;

export function isRecordSet(value: unknown): value is RecordSet {
  return recordSetSchema.safeParse(value).success;
}
