import type { Db } from 'mongodb';
import { z } from 'zod';
import { jsonObjectSchema } from '@aptamind/contracts';
import {
  createServiceToken,
  defineCapability,
  RetryableError,
  TerminalError,
  type WorkflowSpec,
} from '@aptamind/workflow-sdk';

/** Test-only capabilities used by runtime integration tests (and the crash-test child worker). */
export const TEST_DB = createServiceToken<Db>('test.db');

export const concurrencyProbe = { active: 0, max: 0 };

async function control(db: Db, id: string): Promise<Record<string, unknown>> {
  return ((await db.collection('test_controls').findOne({ _id: id as never })) ?? {}) as Record<
    string,
    unknown
  >;
}

export const echo = defineCapability({
  type: 'test.echo',
  version: 1,
  title: 'Echo',
  description: 'Returns its input.',
  category: 'transform',
  inputSchema: z.object({ value: z.unknown().optional() }),
  outputSchema: z.object({ value: z.unknown().optional() }),
  configSchema: z.object({}),
  execution: { retryable: false, idempotency: 'pure', sideEffects: false },
  async execute(_ctx, input) {
    return { value: input.value };
  },
});

/** Performs an idempotent side effect keyed by ctx.idempotencyKey, then optionally fails. */
export const sideEffect = defineCapability({
  type: 'test.side_effect',
  version: 1,
  title: 'Side effect',
  description: 'Upserts a document keyed by the idempotency key; fails the first N attempts.',
  category: 'domain',
  inputSchema: z.object({ tag: z.string().default('x') }),
  outputSchema: z.object({ key: z.string(), attempt: z.number() }),
  configSchema: z.object({ failFirstAttempts: z.number().int().min(0).default(0) }),
  execution: {
    retryable: true,
    idempotency: 'key',
    sideEffects: true,
    idempotencyProof: 'Upserts one document keyed by ctx.idempotencyKey.',
  },
  async execute(ctx, input, config) {
    const db = ctx.services.get(TEST_DB);
    await db
      .collection('test_side_effects')
      .updateOne(
        { _id: ctx.idempotencyKey as never },
        { $setOnInsert: { tag: input.tag, createdAt: new Date() }, $inc: { executions: 1 } },
        { upsert: true },
      );
    if (ctx.attempt <= config.failFirstAttempts)
      throw new RetryableError(`transient failure on attempt ${ctx.attempt}`);
    return { key: ctx.idempotencyKey, attempt: ctx.attempt };
  },
});

export const failIfControlled = defineCapability({
  type: 'test.fail_if',
  version: 1,
  title: 'Fail if controlled',
  description: 'Fails terminally while test_controls.fail.enabled is true.',
  category: 'domain',
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  configSchema: z.object({}),
  execution: { retryable: false, idempotency: 'pure', sideEffects: false },
  async execute(ctx) {
    const c = await control(ctx.services.get(TEST_DB), 'fail');
    if (c.enabled) throw new TerminalError('controlled terminal failure');
    return { ok: true };
  },
});

export const sleep = defineCapability({
  type: 'test.sleep',
  version: 1,
  title: 'Sleep',
  description:
    'Records that its body started (a probe keyed by the idempotency key, counting executions), then sleeps (respecting cancellation); hangs while test_controls.hang.enabled.',
  category: 'domain',
  inputSchema: z.object({}),
  outputSchema: z.object({ slept: z.number() }),
  configSchema: z.object({ ms: z.number().int().min(0).default(50) }),
  execution: {
    retryable: true,
    idempotency: 'key',
    sideEffects: true,
    idempotencyProof:
      'Test probe: one marker document keyed by ctx.idempotencyKey whose counter deliberately records every execution.',
  },
  async execute(ctx, _input, config) {
    const db = ctx.services.get(TEST_DB);
    await db
      .collection('test_side_effects')
      .updateOne({ _id: `${ctx.idempotencyKey}:started` as never }, { $inc: { n: 1 } }, { upsert: true });
    const hang = (await control(db, 'hang')).enabled === true;
    const ms = hang ? 10 * 60_000 : config.ms;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      ctx.signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(ctx.signal.reason);
      });
    });
    return { slept: ms };
  },
});

export const concurrencyBody = defineCapability({
  type: 'test.concurrency_body',
  version: 1,
  title: 'Concurrency probe',
  description: 'Tracks max simultaneous executions; records one side effect per item.',
  category: 'domain',
  inputSchema: z.object({ n: z.number() }),
  outputSchema: z.object({ doubled: z.number() }),
  configSchema: z.object({ failWhenDivisibleBy: z.number().int().optional() }),
  execution: {
    retryable: false,
    idempotency: 'key',
    sideEffects: true,
    idempotencyProof: 'Upserts one document keyed by ctx.idempotencyKey (per item).',
  },
  async execute(ctx, input, config) {
    concurrencyProbe.active += 1;
    concurrencyProbe.max = Math.max(concurrencyProbe.max, concurrencyProbe.active);
    try {
      await new Promise((r) => setTimeout(r, 5));
      await ctx.services
        .get(TEST_DB)
        .collection('test_items')
        .updateOne(
          { _id: ctx.idempotencyKey as never },
          { $inc: { n: 1 }, $set: { value: input.n } },
          { upsert: true },
        );
      if (config.failWhenDivisibleBy && input.n % config.failWhenDivisibleBy === 0)
        throw new TerminalError(`item ${input.n} rejected`);
      return { doubled: input.n * 2 };
    } finally {
      concurrencyProbe.active -= 1;
    }
  },
});

export const suspendForApproval = defineCapability({
  type: 'test.suspend',
  version: 1,
  title: 'Wait for approval',
  description: 'Suspends until resumed with { approved }.',
  category: 'control',
  inputSchema: z.object({ key: z.string() }),
  outputSchema: z.object({ approved: z.boolean() }),
  configSchema: z.object({}),
  execution: { retryable: false, idempotency: 'pure', sideEffects: false },
  async execute(ctx, input) {
    if (!ctx.resume)
      return ctx.suspend({ kind: 'review', reason: 'approval required', correlationKey: input.key });
    return { approved: ctx.resume.approved === true };
  },
});

export const emitItems = defineCapability({
  type: 'test.emit_items',
  version: 1,
  title: 'Emit items',
  description: 'Writes N numbered records as a record set.',
  category: 'transform',
  inputSchema: z.object({ count: z.number().int().min(0) }),
  outputSchema: z.object({ records: z.any(), count: z.number() }),
  configSchema: z.object({}),
  execution: { retryable: false, idempotency: 'pure', sideEffects: false },
  async execute(ctx, input) {
    const records = await ctx.records.write(Array.from({ length: input.count }, (_, i) => ({ n: i + 1 })));
    return { records, count: input.count };
  },
});

export const testCapabilities = [
  echo,
  sideEffect,
  failIfControlled,
  sleep,
  concurrencyBody,
  suspendForApproval,
  emitItems,
];

const trigger = {
  id: 'start',
  capability: { type: 'core.manual_trigger', version: 1 },
  input: { payload: { $ref: 'run.input' }, trigger: { $ref: 'trigger' } },
};

export const testWorkflows: WorkflowSpec[] = [
  {
    key: 'test.crash',
    title: 'Crash recovery',
    nodes: [
      trigger,
      {
        id: 'work',
        capability: { type: 'test.sleep', version: 1 },
        config: { ms: 10 },
        retry: { maxAttempts: 3, backoffMs: 10 },
      },
    ],
    edges: [{ from: 'start', to: 'work' }],
  },
];

export const jsonInput = jsonObjectSchema;
