import { z } from 'zod';
import { artifactRefSchema, jsonValueSchema } from '@aptamind/contracts';
import { defineCapability, TerminalError } from '@aptamind/workflow-sdk';
import { AI_GATEWAY, AI_TASKS } from '../tokens';

export const aiMetaSchema = z.object({
  provider: z.string(),
  model: z.string(),
  servedByModel: z.string(),
  promptId: z.string(),
  promptVersion: z.string(),
  schemaVersion: z.string(),
  inputRefs: z.array(z.object({ kind: z.string(), id: z.string() })),
  inputHash: z.string(),
  latencyMs: z.number(),
  usage: z.object({ inputTokens: z.number().nullable(), outputTokens: z.number().nullable() }),
  estimatedCostUsd: z.number().nullable(),
  requestId: z.string().nullable(),
  generatedAt: z.string(),
});

/**
 * Structured AI Extract. Output is schema-validated and carries full provenance metadata.
 * It is a proposal: downstream domain capabilities decide whether it affects canonical data.
 */
export const aiExtract = defineCapability({
  type: 'core.ai_extract',
  version: 1,
  title: 'Structured AI Extract',
  description: 'Runs a registered, versioned extraction task through the provider-neutral AI gateway.',
  category: 'ai',
  inputSchema: z.object({
    text: z.string().optional(),
    artifact: artifactRefSchema.optional(),
    vars: z.record(z.string(), z.string()).default({}),
  }),
  outputSchema: z.object({ data: jsonValueSchema, meta: aiMetaSchema }),
  configSchema: z.object({ task: z.string(), maxInputChars: z.number().int().positive().default(60_000) }),
  execution: {
    retryable: true,
    idempotency: 'pure',
    sideEffects: false,
    queue: 'ai',
    defaultTimeoutMs: 5 * 60_000,
    idempotencyProof:
      'No durable side effects; the result becomes the node output. A re-execution before the output is recorded calls the model again (cost, not correctness).',
  },
  async execute(ctx, input, config) {
    const gateway = ctx.services.get(AI_GATEWAY);
    if (!gateway.available)
      throw new TerminalError('AI provider not configured; structured AI extraction unavailable');
    const task = ctx.services.get(AI_TASKS).get(config.task);
    const text = input.text ?? (input.artifact ? await ctx.artifacts.readText(input.artifact) : '');
    if (text.length > config.maxInputChars) {
      throw new TerminalError(
        `Input is ${text.length} chars (limit ${config.maxInputChars}); split it upstream rather than truncating`,
      );
    }
    const res = await gateway.structuredExtract({
      task: task.id,
      prompt: task.prompt,
      vars: { ...input.vars, text },
      schema: task.schema,
      schemaVersion: task.schemaVersion,
      inputRefs: input.artifact
        ? [{ kind: 'artifact', id: input.artifact.artifactId }]
        : [{ kind: 'text', id: ctx.idempotencyKey }],
      signal: ctx.signal,
    });
    return {
      data: res.data as z.infer<typeof jsonValueSchema>,
      meta: { ...res.meta, generatedAt: res.meta.generatedAt.toISOString() },
    };
  },
});
