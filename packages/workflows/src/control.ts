import { z } from 'zod';
import { jsonObjectSchema, jsonValueSchema } from '@aptamind/contracts';
import { defineCapability, recordsInputSchema, retryPolicySchema } from '@aptamind/workflow-sdk';

/**
 * `core.for_each` — bounded-concurrency fan-out. Implemented by the engine itself
 * (`execution.mode = 'fanout'`), but registered like any other capability so its config
 * is validated and its version is recorded on runs.
 *
 * Items are split into chunks of `batchSize`; at most `concurrency` chunks are in flight
 * at any time, regardless of how many items there are. The body runs once per item and
 * is either a registered capability or a subworkflow (executed inline, durably).
 */
export const forEachConfigSchema = z
  .object({
    body: z.object({
      capability: z.object({ type: z.string(), version: z.number().int().positive() }).optional(),
      workflow: z.object({ key: z.string(), version: z.number().int().positive().optional() }).optional(),
      config: jsonObjectSchema.default({}),
      /** Input template; may use `{ "$ref": "item" }` and `{ "$ref": "itemIndex" }`. */
      input: jsonValueSchema.default({ $ref: 'item' }),
      retry: retryPolicySchema.partial().optional(),
      timeoutMs: z.number().int().positive().optional(),
    }),
    concurrency: z.number().int().min(1).max(64).default(4),
    batchSize: z.number().int().min(1).max(1000).default(50),
    failurePolicy: z.enum(['continue', 'fail_fast']).default('continue'),
    /** Fail the node when more than this ratio of items fail (1 = never fail on item errors). */
    maxFailureRatio: z.number().min(0).max(1).default(1),
    /** Collect per-item outputs into the node output (only for small fan-outs). */
    collectOutputs: z.boolean().default(false),
  })
  .refine((c) => !!c.body.capability !== !!c.body.workflow, {
    message: 'body must specify exactly one of capability or workflow',
  });
export type ForEachConfig = z.output<typeof forEachConfigSchema>;

export const forEachInputSchema = z.object({ items: recordsInputSchema });

export const forEachOutputSchema = z.object({
  total: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  failureRatio: z.number(),
  sampleFailures: z.array(z.object({ index: z.number().int(), message: z.string() })),
  outputs: z.array(jsonValueSchema.nullable()).optional(),
});
export type ForEachOutput = z.infer<typeof forEachOutputSchema>;

export const forEachCapability = defineCapability({
  type: 'core.for_each',
  version: 1,
  title: 'For Each (bounded fan-out)',
  description:
    'Runs a capability or subworkflow once per item with bounded concurrency. Items may be an inline array or a record set artifact.',
  category: 'control',
  inputSchema: forEachInputSchema,
  outputSchema: forEachOutputSchema,
  configSchema: forEachConfigSchema,
  execution: {
    retryable: false,
    idempotency: 'key',
    sideEffects: true,
    mode: 'fanout',
    idempotencyProof:
      'Chunks have deterministic ids per node run; each item runs with key <node key>:<item index> and its result is recorded, so a takeover skips recorded items.',
  },
  async execute() {
    throw new Error('core.for_each is executed by the workflow engine, not directly');
  },
});
