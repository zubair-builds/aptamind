import { z } from 'zod';
import { jsonObjectSchema } from '@aptamind/contracts';
import { defineCapability } from '@aptamind/workflow-sdk';

const triggerInput = z.object({
  payload: jsonObjectSchema.default({}),
  trigger: z
    .object({
      kind: z.string(),
      scheduledFor: z.union([z.string(), z.date()]).optional(),
      scheduleId: z.string().optional(),
    })
    .passthrough()
    .optional(),
});

const triggerOutput = z.object({
  payload: jsonObjectSchema,
  triggerKind: z.string(),
  firedAt: z.string(),
  scheduledFor: z.string().optional(),
});

/** Entry node for manually/API-triggered runs: exposes the run input as `payload`. */
export const manualTrigger = defineCapability({
  type: 'core.manual_trigger',
  version: 1,
  title: 'Manual Trigger',
  description: 'Entry point for runs started by an operator or the API. Outputs the run input as `payload`.',
  category: 'trigger',
  inputSchema: triggerInput,
  outputSchema: triggerOutput,
  configSchema: z.object({}),
  execution: { retryable: false, idempotency: 'pure', sideEffects: false },
  async execute(ctx, input) {
    return {
      payload: input.payload,
      triggerKind: input.trigger?.kind ?? 'manual',
      firedAt: ctx.clock.now().toISOString(),
    };
  },
});

/**
 * Entry node for scheduled runs. Accepts manual triggers too (so a scheduled workflow can
 * be run on demand) and exposes the scheduled fire time for idempotent downstream keys.
 */
export const scheduleTrigger = defineCapability({
  type: 'core.schedule_trigger',
  version: 1,
  title: 'Schedule Trigger',
  description:
    'Entry point for schedule-fired runs. Outputs the schedule payload and the scheduled fire time.',
  category: 'trigger',
  inputSchema: triggerInput,
  outputSchema: triggerOutput,
  configSchema: z.object({ allowManual: z.boolean().default(true) }),
  execution: { retryable: false, idempotency: 'pure', sideEffects: false },
  async execute(ctx, input, config) {
    const kind = input.trigger?.kind ?? 'manual';
    if (kind !== 'schedule' && !config.allowManual)
      throw new Error(`Run was triggered by ${kind}, not a schedule`);
    const scheduledFor = input.trigger?.scheduledFor;
    return {
      payload: input.payload,
      triggerKind: kind,
      firedAt: ctx.clock.now().toISOString(),
      scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : undefined,
    };
  },
});
