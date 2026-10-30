import { z } from 'zod';
import { defineCapability } from '@aptamind/workflow-sdk';
import { MARKET } from '../market-domain';

/** OPS-3 retention and OPS-4 signal capabilities. */

/** OPS-3: release expired, unreferenced Market snapshots (marks only; never deletes records). */
export const retentionSweep = defineCapability({
  type: 'market.retention_sweep',
  version: 1,
  title: 'Retention Sweep',
  description:
    'Backfills retention metadata, then releases snapshots past expiry that no open review, current observation or latest-of-source read still needs; held ones get their expiry extended.',
  category: 'domain',
  inputSchema: z.object({ limit: z.number().int().positive().max(5000).optional() }),
  outputSchema: z.object({
    policyVersion: z.string(),
    scanned: z.number().int(),
    backfilled: z.number().int(),
    released: z.number().int(),
    held: z.object({
      latest_of_source: z.number().int(),
      open_review: z.number().int(),
      current_observation: z.number().int(),
    }),
    dryRun: z.boolean(),
  }),
  configSchema: z.object({}),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'State-based: releases only snapshots with no expiredAt, guarded on the expiresAt it read; holds extend expiry past now so a replay finds nothing due. Records are never deleted.',
    defaultTimeoutMs: 10 * 60_000,
  },
  async execute(ctx, input) {
    return ctx.services.get(MARKET).retention.sweep({ limit: input.limit });
  },
});

/** OPS-4: lifecycle signals (vocabulary v1) from recorded job lifecycle transitions. */
export const writeLifecycleSignals = defineCapability({
  type: 'market.write_lifecycle_signals',
  version: 1,
  title: 'Write Lifecycle Signals',
  description:
    'Writes job_discovered/changed/closed/reopened/reposted signals, with evidence, for lifecycle transitions of jobs written since the writer cursor.',
  category: 'domain',
  inputSchema: z.object({ maxJobs: z.number().int().positive().max(100_000).optional() }),
  outputSchema: z.object({
    scannedJobs: z.number().int(),
    written: z.number().int(),
    existing: z.number().int(),
    since: z.date().nullable(),
  }),
  configSchema: z.object({}),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'Each signal has a deterministic id and unique dedupe key (job, target state, transition time); a replay inserts nothing new.',
    defaultTimeoutMs: 10 * 60_000,
  },
  async execute(ctx, input) {
    return ctx.services.get(MARKET).lifecycleSignals.run({ maxJobs: input.maxJobs });
  },
});
