import { z } from 'zod';
import { actorSchema } from '@aptamind/contracts';

/**
 * A machine code (reason, error or event code): lower-case, no spaces. Free text never goes
 * into these fields, so documents copied into logs, events or review reasons carry no PII.
 */
export const codeSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9_.:-]*$/, { message: 'not a code' });

/** The acting `Actor` as recorded on documents (ADR-0008 seam). */
export const actorRefSchema = actorSchema;

/** Fields every Professional document carries (`subjectId` is added per collection). */
export const documentMetaFields = {
  schemaVersion: z.number().int().positive(),
  createdAt: z.date(),
  updatedAt: z.date(),
};
