import { z } from 'zod';
import { defineCapability } from '@aptamind/workflow-sdk';
import { MARKET } from '../market-domain';

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
