import { z } from 'zod';
import { defineCollection } from '@aptamind/db';
import { copyBoardSchema } from '../jobs/job.schema';

export const VERIFICATION_SCHEMA_VERSION = 1;

/**
 * One logical verification operation (id = hash(job, operation key)). It moves through
 * `claimed` → `checked` (result persisted) → lifecycle applied (`lifecycleApplied`: its result
 * is recorded as job evidence `ver:<id>` and the job re-derived) → `applied` (complete). Documents
 * written before `status` existed are complete (`applied`).
 */
export const jobVerificationDocSchema = z.object({
  _id: z.string(),
  jobId: z.string(),
  status: z.enum(['claimed', 'checked', 'applied']).optional(),
  operationKey: z.string().optional(),
  sourceId: z.string().optional(),
  /** The copy the check read (`${sourceId}:${externalId}`); its verification evidence is on it. */
  copyKey: z.string().optional(),
  /** The board the check read the copy on (null: none, e.g. an inconclusive check). */
  board: copyBoardSchema.nullable().optional(),
  method: z.enum(['ats_api', 'posting_url', 'listing_presence']).optional(),
  url: z.string().optional(),
  httpStatus: z.number().int().optional(),
  outcome: z.enum(['live', 'not_found', 'inconclusive']).optional(),
  detail: z.string().optional(),
  artifactId: z.string().optional(),
  runId: z.string().optional(),
  stateBefore: z.string().optional(),
  stateAfter: z.string().optional(),
  /**
   * Set once the result was recorded as job evidence (`ver:<id>`, idempotent) and the job
   * re-derived. The evidence key, not this flag, makes the operation count at most once.
   */
  lifecycleApplied: z.boolean().optional(),
  /** The job revision produced by applying this operation. */
  appliedJobRevision: z.number().int().optional(),
  /**
   * A board-derived check (Ashby reads the whole board): its `not_found` only corroborates a
   * job-level absence run (b7f1a76), which the derivation checks at the evidence's time.
   */
  boardDerived: z.boolean().optional(),
  /**
   * Legacy (no longer written or read): the absence-run fence of the counter-based apply
   * (a9af734). The lifecycle is now derived from the evidence set, which orders by time.
   */
  fence: z
    .object({
      absentSince: z.date().nullable(),
      lastSeenAt: z.date().nullable(),
      lastVerifiedAt: z.date().nullable(),
    })
    .optional(),
  /**
   * The verification logic version the check ran under (`VERIFICATION_LOGIC_VERSION`, PR #11
   * re-verify #7 LOW-2). A result recorded under another version (or before this existed) is
   * applied as `inconclusive`: the rules that produced it are not the ones in force.
   */
  logicVersion: z.string().optional(),
  /** The outcome the lifecycle received when it differs from `outcome` (a re-gated result). */
  appliedOutcome: z.enum(['live', 'not_found', 'inconclusive']).optional(),
  /** Why the recorded outcome was applied as `appliedOutcome`. */
  appliedNote: z.string().optional(),
  at: z.date(),
  schemaVersion: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type JobVerificationDoc = z.infer<typeof jobVerificationDocSchema>;

export const jobVerificationsCollection = defineCollection<JobVerificationDoc>({
  name: 'market_job_verifications',
  description: 'Evidence of each job verification attempt.',
  schema: jobVerificationDocSchema,
  schemaVersion: VERIFICATION_SCHEMA_VERSION,
  indexes: [
    {
      key: { jobId: 1, at: -1, _id: -1 },
      options: { name: 'by_job_time' },
      rationale: 'Verification history on job detail.',
    },
    {
      key: { jobId: 1, status: 1 },
      options: { name: 'by_job_status' },
      rationale: 'In-flight (claimed/checked) operations of a job; recovery of interrupted verifications.',
    },
    {
      key: { sourceId: 1, outcome: 1, at: -1 },
      options: { name: 'by_source_outcome_time' },
      rationale:
        'Latest live verification against a source (its own positive evidence: small-board hold re-arm and the empty-board gate, DECISION_LOG a9af734 M2).',
    },
    {
      key: { at: -1, outcome: 1 },
      options: { name: 'by_time_outcome' },
      rationale: 'Verification-rate metrics.',
    },
  ],
});
