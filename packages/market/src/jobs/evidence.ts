import { z } from 'zod';
import { defineCollection } from '@aptamind/db';
import { copyBoardSchema, lifecycleTransitionSchema } from './job.schema';

export const JOB_EVIDENCE_SCHEMA_VERSION = 1;
/** The rules under which evidence is recorded (what `outcome` means for each `kind`). */
export const JOB_EVIDENCE_LOGIC_VERSION = 'job-evidence/1';

export const JOB_EVIDENCE_KINDS = ['verification', 'listing', 'baseline'] as const;
export const JOB_EVIDENCE_OUTCOMES = [
  'live',
  'not_found',
  'inconclusive',
  'present',
  'absent',
  'closed',
] as const;
export type JobEvidenceOutcome = (typeof JOB_EVIDENCE_OUTCOMES)[number];

/**
 * One piece of evidence about a job's existence (DECISION_LOG 6a01b36). Append-only and
 * idempotent: `_id` is the idempotency key, so a replayed step records nothing new.
 *
 *  - `verification`: one applied verification operation (`live` / `not_found` / `inconclusive`),
 *    key `ver:<operation id>`;
 *  - `listing`: one listing's statement about one copy — `present` (a mapped sighting, or a
 *    skipped entry: `skipped: true`) or `absent` (a complete listing that did not contain it),
 *    key `listing:<copy key>@<fetch time ms>:<outcome>`;
 *  - `baseline`: the conservative starting point of a job last written before derivation (a
 *    positive at its `lastVerifiedAt`, the presence of its present copies, its closure), keys
 *    `baseline:<job id>[:<copy key>|:closed]`. No negatives are carried over.
 *
 * `board` is the board actually read (captured when the fetch STARTED, carried through the fetch
 * output); evidence counts for a copy only when it equals the board the copy was seen on. The
 * lifecycle is a pure function of this set (`deriveLifecycle`). No personal data and no raw
 * bodies: posting identifiers, times and outcomes only.
 */
export const jobEvidenceDocSchema = z.object({
  _id: z.string(),
  /** The job the evidence was recorded against (informational: derivation reads by `copyKey`). */
  jobId: z.string(),
  /** `${sourceId}:${externalId}` of the copy; null for job-level baseline evidence. */
  copyKey: z.string().nullable(),
  sourceId: z.string().nullable(),
  board: copyBoardSchema.nullable(),
  at: z.date(),
  kind: z.enum(JOB_EVIDENCE_KINDS),
  outcome: z.enum(JOB_EVIDENCE_OUTCOMES),
  logicVersion: z.string(),
  /** Verification: a board-derived read (Ashby), which only corroborates an absence run. */
  boardDerived: z.boolean().optional(),
  /** Listing `present`: an entry on the board the adapter did not map (not a verification, U1). */
  skipped: z.boolean().optional(),
  /**
   * Listing `present` (mapped) and copy baselines: the copy's material content hash. `CHANGED` and
   * `REPOSTED` are derived from these in time order (DECISION_LOG 15c965b), never from the job's
   * state when the sighting arrived.
   */
  contentHash: z.string().optional(),
  /** Baseline: the legacy closure reason, lifecycle history and last content change. */
  reason: z.string().optional(),
  history: z.array(lifecycleTransitionSchema).optional(),
  lastChangedAt: z.date().optional(),
  verificationId: z.string().optional(),
  snapshotId: z.string().optional(),
  runId: z.string().optional(),
  schemaVersion: z.number().int(),
  createdAt: z.date(),
});
export type JobEvidenceDoc = z.infer<typeof jobEvidenceDocSchema>;

export const jobEvidenceCollection = defineCollection<JobEvidenceDoc>({
  name: 'market_job_evidence',
  description:
    'Append-only evidence of job existence (verifications, listing presence/absence per copy, legacy baselines); the lifecycle is derived from it.',
  schema: jobEvidenceDocSchema,
  schemaVersion: JOB_EVIDENCE_SCHEMA_VERSION,
  indexes: [
    {
      key: { copyKey: 1, at: 1 },
      options: { name: 'by_copy_time' },
      rationale:
        "A job's evidence set: every copy's evidence (read by copy key, so a merge carries its copies' evidence to the survivor).",
    },
    {
      key: { jobId: 1, at: 1 },
      options: { name: 'by_job_time' },
      rationale: "Evidence recorded against a job, in time order (the job's baseline; diagnostics).",
    },
    {
      key: { createdAt: 1, _id: 1 },
      options: { name: 'by_created' },
      rationale:
        'The freshness sweep re-derives every job named by evidence recorded since its watermark (in record order), whether or not the recorder re-derived it (DECISION_LOG 9b0cb03).',
    },
    {
      key: { jobId: 1, kind: 1, copyKey: 1, at: 1 },
      options: { name: 'by_job_baseline' },
      rationale:
        "A job's own (job-level) baseline evidence up to a time: with `by_copy_time`, the checkpoint's evidence count is answered from the indexes.",
    },
    {
      key: { snapshotId: 1 },
      options: {
        name: 'by_snapshot',
        partialFilterExpression: { snapshotId: { $exists: true } },
      },
      rationale:
        'Retention sweep (OPS-3): a snapshot cited as job evidence is held. Partial: evidence without a snapshot is not indexed.',
    },
  ],
});

/**
 * A job's lifecycle-fold checkpoint (DECISION_LOG 15c965b): the fold state over its evidence up
 * to `watermark`, so a recompute reads only the evidence after it. A DERIVED cache — never
 * authoritative, always rebuildable from the evidence (dropping it only costs a full fold). It is
 * used only while its policy version, the job's copies (`copiesKey`) and the sources' standing up
 * to the watermark (`standingKey`) are unchanged, and while the evidence at or before the watermark
 * still numbers `count` (evidence is append-only, so any late evidence changes it and forces a full
 * fold, whether or not its recorder recomputed — DECISION_LOG 9b0cb03). A write never replaces a checkpoint that folded
 * more (a later watermark, or as many evidence documents or more at the same watermark).
 */
export const jobLifecycleCheckpointDocSchema = z.object({
  _id: z.string(),
  version: z.string(),
  copiesKey: z.string(),
  standingKey: z.string(),
  watermark: z.date(),
  count: z.number().int().min(0),
  /** The serialized fold state (`FoldState`, maps as entry arrays). */
  state: z.record(z.string(), z.unknown()),
  updatedAt: z.date(),
});
export type JobLifecycleCheckpointDoc = z.infer<typeof jobLifecycleCheckpointDocSchema>;

export const jobLifecycleCheckpointsCollection = defineCollection<JobLifecycleCheckpointDoc>({
  name: 'market_job_lifecycle_checkpoints',
  description: 'Derived, rebuildable checkpoints of the job lifecycle fold (bounded recompute reads).',
  schema: jobLifecycleCheckpointDocSchema,
  schemaVersion: JOB_EVIDENCE_SCHEMA_VERSION,
  indexes: [],
});

/**
 * The recorded-evidence sweep's progress (DECISION_LOG 9b0cb03): the (`createdAt`, `_id`) of the
 * last evidence document whose job the freshness sweep re-derived. Only moves forward. Derived
 * bookkeeping: dropping it only makes the next sweep re-derive from the start (idempotent).
 */
export const jobEvidenceSweepDocSchema = z.object({
  _id: z.string(),
  at: z.date().optional(),
  id: z.string().optional(),
  updatedAt: z.date(),
});
export type JobEvidenceSweepDoc = z.infer<typeof jobEvidenceSweepDocSchema>;

export const jobEvidenceSweepsCollection = defineCollection<JobEvidenceSweepDoc>({
  name: 'market_job_evidence_sweeps',
  description: 'Watermark of the sweep that re-derives every job named by recently recorded evidence.',
  schema: jobEvidenceSweepDocSchema,
  schemaVersion: JOB_EVIDENCE_SCHEMA_VERSION,
  indexes: [],
});

/**
 * A job whose lifecycle re-derivation by the recorded-evidence sweep is failing (re-verify #12,
 * final M1-M3): one document per job, upserted at each failure (before the sweep's watermark moves
 * past the job's evidence) and deleted at its next success once its review is dismissed (M6.2
 * L1: kept while that dismissal has not succeeded, so the job stays on the retry list). `code` is
 * the last error code (never a message); `since` the start of the streak; `dismissedCode` the code
 * an operator dismissed its review for during this streak (not raised again until the code
 * changes or the job recovers). Derived bookkeeping.
 */
export const jobLifecycleFailureDocSchema = z.object({
  _id: z.string(),
  failures: z.number().int().min(1),
  code: z.string(),
  since: z.date(),
  lastAt: z.date(),
  dismissedCode: z.string().optional(),
});
export type JobLifecycleFailureDoc = z.infer<typeof jobLifecycleFailureDocSchema>;

export const jobLifecycleFailuresCollection = defineCollection<JobLifecycleFailureDoc>({
  name: 'market_job_lifecycle_failures',
  description:
    'Jobs whose lifecycle re-derivation by the recorded-evidence sweep is failing (retried first).',
  schema: jobLifecycleFailureDocSchema,
  schemaVersion: JOB_EVIDENCE_SCHEMA_VERSION,
  indexes: [
    {
      key: { lastAt: 1, _id: 1 },
      options: { name: 'by_last_attempt' },
      rationale: 'The sweep retries failing jobs least recently tried first.',
    },
  ],
});
