import { z } from 'zod';
import { artifactRefSchema, jsonValueSchema } from '@aptamind/contracts';
import { defineCapability, TerminalError } from '@aptamind/workflow-sdk';

export const storeArtifact = defineCapability({
  type: 'core.store_artifact',
  version: 1,
  title: 'Store Artifact',
  description: 'Stores text or JSON content as a content-addressed artifact.',
  category: 'storage',
  inputSchema: z.object({ text: z.string().optional(), json: jsonValueSchema.optional() }),
  outputSchema: z.object({ artifact: artifactRefSchema }),
  configSchema: z.object({ mimeType: z.string().optional() }),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'Artifacts are content-addressed (id = sha256 of the bytes); storing the same bytes again returns the same reference.',
  },
  async execute(ctx, input, config) {
    if (input.text !== undefined)
      return { artifact: await ctx.artifacts.put(input.text, config.mimeType ?? 'text/plain') };
    if (input.json !== undefined) return { artifact: await ctx.artifacts.putJson(input.json) };
    throw new TerminalError('Provide text or json');
  },
});

/** Load Artifact: re-read stored content — the basis of reprocessing without refetching. */
export const loadArtifact = defineCapability({
  type: 'core.load_artifact',
  version: 1,
  title: 'Load Artifact',
  description:
    'Loads a stored artifact (integrity-checked) as text or JSON, enabling reprocessing without refetching.',
  category: 'storage',
  inputSchema: z.object({ artifact: artifactRefSchema.partial().extend({ artifactId: z.string() }) }),
  outputSchema: z.object({
    artifactId: z.string(),
    text: z.string().optional(),
    json: jsonValueSchema.optional(),
    size: z.number().int(),
  }),
  configSchema: z.object({
    as: z.enum(['text', 'json']).default('text'),
    maxInlineBytes: z
      .number()
      .int()
      .max(64 * 1024)
      .default(64 * 1024),
  }),
  execution: { retryable: true, idempotency: 'pure', sideEffects: false },
  async execute(ctx, input, config) {
    const bytes = await ctx.artifacts.readBytes(input.artifact);
    if (bytes.byteLength > config.maxInlineBytes) {
      throw new TerminalError(
        `Artifact is ${bytes.byteLength} bytes; pass the artifact reference downstream instead of loading it inline`,
      );
    }
    const text = new TextDecoder().decode(bytes);
    return config.as === 'json'
      ? { artifactId: input.artifact.artifactId, json: JSON.parse(text), size: bytes.byteLength }
      : { artifactId: input.artifact.artifactId, text, size: bytes.byteLength };
  },
});
