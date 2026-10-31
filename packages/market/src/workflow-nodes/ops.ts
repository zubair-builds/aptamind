import { z } from 'zod';
import { defineCapability } from '@aptamind/workflow-sdk';
import { MARKET } from '../market-domain';
import type { HoldReason } from '../retention/retention.service';

/** OPS-3 retention and OPS-4 signal capabilities. */

/** OPS-3: release expired, unreferenced Market snapshots (marks only; never deletes records). */
export const retentionSweep = defineCapability({
  type: 'market.retention_sweep',
  version: 1,
  title: 'Retention Sweep',
  description:
    'Backfills retention metadata, then releases snapshots past expiry that nothing still cites (latest of source, open review, current observation, job evidence, signal evidence, or a canonical fact); held ones get their expiry extended.',
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
      job_evidence: z.number().int(),
      signal_evidence: z.number().int(),
      canonical_fact: z.number().int(),
    } satisfies Record<HoldReason, z.ZodType<number>>),
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

/** FE-4: delete raw bytes of artifacts whose snapshots are all released and otherwise uncited. */
export const retentionPurge = defineCapability({
  type: 'market.retention_purge',
  version: 1,
  title: 'Retention Purge',
  description:
    'Deletes object bytes for artifacts whose snapshots are all released and unpinned, when no hold reason (including job evidence, signal evidence and canonical facts) and no other market record still cites them. The hold is re-checked immediately before the object delete, so a reverted release blocks deletion. At most `limit` artifacts per run (default 500). Records stay.',
  category: 'domain',
  inputSchema: z.object({ limit: z.number().int().positive().max(5000).optional() }),
  outputSchema: z.object({
    scanned: z.number().int(),
    deletable: z.number().int(),
    deleted: z.number().int(),
    keptReferenced: z.number().int(),
    dryRun: z.boolean(),
  }),
  configSchema: z.object({}),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'Deletes bytes only after a reference check, including every hold reason, that runs again immediately before the object delete, then sets bytesDeletedAt so a replay does not select those snapshots. Deleting an artifact twice is a no-op. Records are never removed.',
    defaultTimeoutMs: 10 * 60_000,
  },
  async execute(ctx, input) {
    return ctx.services.get(MARKET).retention.purgeReleased({ limit: input.limit });
  },
});

/** OPS-4: lifecycle signals (vocabulary v1) from recorded job lifecycle transitions. */
export const writeLifecycleSignals = defineCapability({
  type: 'market.write_lifecycle_signals',
  version: 1,
  title: 'Write Lifecycle Signals',
  description:
    'Writes job_discovered/changed/closed/reopened/reposted signals, with evidence, for lifecycle transitions. The first sourced VERIFIED_LIVE (authoritative first sighting) is job_discovered. Resumes from the stored job watermark.',
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

/** OPS-4: canonical-change signals (sponsorship, remote policy, role family, location, acceleration). */
export const writeCompanyChangeSignals = defineCapability({
  type: 'market.write_company_change_signals',
  version: 1,
  title: 'Write Company Change Signals',
  description:
    'Compares each company with the state last seen and writes sponsorship_change, remote_policy_change, role_family_expansion, new_location_hiring and hiring_acceleration signals with evidence (first pass: baseline only; acceleration waits for a later pass with a positive prior window). Resumes from the stored company id.',
  category: 'domain',
  inputSchema: z.object({ maxCompanies: z.number().int().positive().max(1_000_000).optional() }),
  outputSchema: z.object({
    scanned: z.number().int(),
    baselined: z.number().int(),
    written: z.record(z.string(), z.number().int()),
    skippedNoEvidence: z.number().int(),
  }),
  configSchema: z.object({}),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'Signal dedupe keys include the state revision compared against; the state advances by compare-and-set after the signals, so a replay writes the same keys (duplicates ignored).',
    defaultTimeoutMs: 30 * 60_000,
  },
  async execute(ctx, input) {
    return ctx.services.get(MARKET).companyChangeSignals.run({ maxCompanies: input.maxCompanies });
  },
});
