import { z } from 'zod';
import { jsonObjectSchema, jsonValueSchema } from '@aptamind/contracts';
import { defineCapability, TerminalError } from '@aptamind/workflow-sdk';
import { conditionSchema, evaluateCondition } from './transform';

/** If: evaluates conditions against `value`; downstream edges select `branch` true/false. */
export const ifCapability = defineCapability({
  type: 'core.if',
  version: 1,
  title: 'If',
  description: 'Evaluates declarative conditions and emits branch "true" or "false" for conditional edges.',
  category: 'control',
  inputSchema: z.object({ value: jsonValueSchema.optional() }),
  outputSchema: z.object({ branch: z.enum(['true', 'false']), value: jsonValueSchema.optional() }),
  configSchema: z.object({
    conditions: z.array(conditionSchema).min(1),
    mode: z.enum(['all', 'any']).default('all'),
  }),
  execution: { retryable: false, idempotency: 'pure', sideEffects: false },
  async execute(_ctx, input, config) {
    const ok =
      config.mode === 'all'
        ? config.conditions.every((c) => evaluateCondition(input.value, c))
        : config.conditions.some((c) => evaluateCondition(input.value, c));
    return { branch: ok ? ('true' as const) : ('false' as const), value: input.value };
  },
});

/** Switch: first matching case wins; otherwise the default branch. */
export const switchCapability = defineCapability({
  type: 'core.switch',
  version: 1,
  title: 'Switch',
  description: 'Emits the branch of the first case whose conditions match, else the default branch.',
  category: 'control',
  inputSchema: z.object({ value: jsonValueSchema.optional() }),
  outputSchema: z.object({ branch: z.string(), value: jsonValueSchema.optional() }),
  configSchema: z.object({
    cases: z.array(z.object({ branch: z.string(), conditions: z.array(conditionSchema).min(1) })).min(1),
    defaultBranch: z.string().default('default'),
  }),
  execution: { retryable: false, idempotency: 'pure', sideEffects: false },
  async execute(_ctx, input, config) {
    const hit = config.cases.find((c) => c.conditions.every((cond) => evaluateCondition(input.value, cond)));
    return { branch: hit?.branch ?? config.defaultBranch, value: input.value };
  },
});

/** Execute Subworkflow: runs another workflow (durably, inline) as one logical step. */
export const executeSubworkflow = defineCapability({
  type: 'core.execute_subworkflow',
  version: 1,
  title: 'Execute Subworkflow',
  description:
    'Runs another registered workflow as a single step and returns its output. Re-execution resumes the same child run.',
  category: 'control',
  inputSchema: z.object({ input: jsonObjectSchema.default({}) }),
  outputSchema: z.object({ childRunId: z.string(), output: jsonValueSchema.nullable() }),
  configSchema: z.object({ workflowKey: z.string(), version: z.number().int().positive().optional() }),
  execution: {
    retryable: true,
    idempotency: 'key',
    sideEffects: true,
    idempotencyProof:
      'The child run is started with idempotency key child:<ctx.idempotencyKey>; re-invocation resumes or returns the same child run.',
  },
  async execute(ctx, input, config) {
    const res = await ctx.runSubworkflow({
      workflowKey: config.workflowKey,
      version: config.version,
      input: input.input,
      idempotencyKey: ctx.idempotencyKey,
    });
    if (res.state !== 'COMPLETED') {
      throw new TerminalError(
        `Subworkflow ${config.workflowKey} ended in ${res.state}: ${res.error?.message ?? ''}`,
        { childRunId: res.runId },
      );
    }
    return { childRunId: res.runId, output: (res.output ?? null) as z.infer<typeof jsonValueSchema> };
  },
});
