import { z } from 'zod';
import { defineCollection } from '@aptamind/db';
import { AUTHORITY_TIERS, evidenceReferenceSchema, factSchema } from '@aptamind/provenance';
import {
  authorizationSchema,
  compensationSchema,
  EMPLOYMENT_TYPES,
  normalizedLocationSchema,
  officeAttendanceSchema,
  RELOCATION_STATUSES,
  remoteScopeSchema,
  requirementSchema,
  responsibilitiesSchema,
  SENIORITY_LEVELS,
  sponsorshipSchema,
  WORK_MODELS,
  interpretationFlagSchema,
} from '../contracts/employment';

export const JOB_SCHEMA_VERSION = 1;

export const JOB_STATES = [
  'DISCOVERED',
  'VERIFIED_LIVE',
  'CHANGED',
  'POSSIBLY_STALE',
  'CLOSED',
  'REOPENED',
  'REPOSTED',
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const lifecycleTransitionSchema = z.object({
  at: z.date(),
  from: z.enum(JOB_STATES).nullable(),
  to: z.enum(JOB_STATES),
  reason: z.string(),
  sourceId: z.string().optional(),
  evidence: z.string().optional(),
});

export const jobLifecycleSchema = z.object({
  state: z.enum(JOB_STATES),
  firstSeenAt: z.date(),
  lastSeenAt: z.date(),
  lastVerifiedAt: z.date().optional(),
  publishedAt: z.date().optional(),
  lastChangedAt: z.date().optional(),
  closedAt: z.date().optional(),
  closeReason: z.string().optional(),
  /**
   * The fields below are a PROJECTION derived from the job's evidence set (`deriveLifecycle`,
   * DECISION_LOG 6a01b36); they are never incremented in place.
   * Consecutive complete authoritative listings that did not include the job.
   */
  consecutiveAbsences: z.number().int().min(0),
  /** Source time of the first absence of the current run of absences (L1). */
  absentSince: z.date().optional(),
  /** Time of the latest `not_found` verification: corroborates an absence-driven close (L1). */
  lastNotFoundAt: z.date().optional(),
  consecutiveNotFound: z.number().int().min(0),
  history: z.array(lifecycleTransitionSchema),
  /**
   * Legacy (no longer written or read): per-source listing marks of the counter-based lifecycle.
   * Listing evidence is now idempotent on (copy, fetch time) in `market_job_evidence`.
   */
  listingMarks: z.record(z.string(), z.object({ snapshotId: z.string(), at: z.date() })).optional(),
  /**
   * Legacy (no longer written or read): a bounded list of recently applied verification
   * operations. The fence is now the operation's evidence key (`ver:<operation id>`).
   */
  appliedVerifications: z.array(z.string()).optional(),
  /**
   * The lifecycle policy version that DERIVED this projection from the job's evidence set
   * (`deriveLifecycle`, DECISION_LOG 6a01b36). Absent: a job last written before derivation — its
   * first recompute records a conservative baseline (see `JobEvidenceService.recompute`).
   */
  derivedVersion: z.string().optional(),
});
export type JobLifecycle = z.infer<typeof jobLifecycleSchema>;

/**
 * A board: a source endpoint as read (`endpointUrl`, `boardToken`) and, for an ATS, the API base
 * derived from it. Recorded on a copy (the board it was last seen on) and on every piece of job
 * evidence (the board actually read, captured at fetch start).
 */
export const copyBoardSchema = z.object({
  endpointUrl: z.string().nullable(),
  boardToken: z.string().nullable(),
  apiBase: z.string().nullable(),
  /** The source's provider (canonical board identity is provider + API base + token). */
  provider: z.string().nullable().optional(),
});
export type CopyBoard = z.infer<typeof copyBoardSchema>;

export const sourceRefSchema = z.object({
  /** `${sourceId}:${externalId}` */
  key: z.string(),
  sourceId: z.string(),
  externalId: z.string(),
  provider: z.string(),
  authority: z.enum(AUTHORITY_TIERS),
  postingUrl: z.string().nullable(),
  applyUrl: z.string().nullable(),
  requisitionId: z.string().nullable(),
  firstSeenAt: z.date(),
  lastSeenAt: z.date(),
  /** Whether the latest successful listing of this source contained the job. */
  present: z.boolean(),
  /**
   * Provider state of the copy as of its latest sighting (PR #11 B-M5, ruling U1). `unlisted`:
   * "hidden by provider" — the entry is on the board but hidden from the public listing (Ashby
   * `isListed: false`). It exists, so it is never absent (never closed by absence), but it is
   * not verified either: the job decays to POSSIBLY_STALE through the stale sweep and stays
   * there (the Ashby check of a skipped entry is `inconclusive`). Cleared when the entry is
   * mapped (listed) again or absent from a listing.
   */
  providerState: z.enum(['unlisted']).optional(),
  /**
   * The board this copy was last seen on (PR #11 re-verify #7 MEDIUM-2): its source's endpoint
   * (`endpointUrl`, `boardToken`) and, for an ATS, the API base derived from it, as of the
   * sighting. Verification reads the copy only on this board, and only while the source's endpoint
   * still is this board. `null`: the board is unknown (the source's endpoint changed after the
   * listing was fetched) — verification is inconclusive until the copy is seen again. Absent on
   * copies seen before it existed; see `VerificationService.boardOfCopy` for how they are read.
   */
  board: copyBoardSchema.nullable().optional(),
  lastObservationId: z.string(),
  contentHash: z.string(),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

/**
 * Canonical Job. Identity and content come from the most authoritative present source copy;
 * employment intelligence comes from deterministic interpretation of that copy, combined with
 * company-level evidence under explicit policy.
 */
export const jobDocSchema = z.object({
  _id: z.string(),
  companyId: z.string(),
  status: z.enum(['active', 'merged']),
  mergedInto: z.string().optional(),
  /** Unique multikey of source keys (`sourceId:externalId`). */
  sourceKeys: z.array(z.string()),
  sourceRefs: z.array(sourceRefSchema),
  urlFingerprints: z.array(z.string()),
  requisitionId: z.string().nullable(),
  identity: z.object({
    title: factSchema(z.string()),
    normalizedTitle: z.string(),
    /** Search tokens of the title (`titleTokens`); set at insertion and by every reconciliation, backfilled by migration. */
    titleTokens: z.array(z.string()).optional(),
    titleKey: z.string(),
    roleFamily: factSchema(z.string()),
    specialization: factSchema(z.string()),
    department: factSchema(z.string()),
    seniority: factSchema(z.enum(SENIORITY_LEVELS)),
  }),
  content: z.object({
    primaryObservationId: z.string(),
    descriptionArtifactId: z.string().optional(),
    descriptionText: z.string(),
    descriptionHash: z.string(),
    /** Word-shingle fingerprint used for syndication/repost detection. */
    shingles: z.array(z.number().int()),
  }),
  employment: z.object({ employmentType: factSchema(z.enum(EMPLOYMENT_TYPES)) }),
  geography: z.object({
    listedLocations: z.array(z.string()),
    locationKey: z.string(),
    normalizedLocations: z.array(normalizedLocationSchema),
    workModel: factSchema(z.enum(WORK_MODELS)),
    remoteScope: factSchema(remoteScopeSchema),
    officeAttendance: factSchema(officeAttendanceSchema),
  }),
  immigration: z.object({
    sponsorship: factSchema(sponsorshipSchema),
    authorization: factSchema(authorizationSchema),
    relocation: factSchema(z.enum(RELOCATION_STATUSES)),
  }),
  compensation: factSchema(compensationSchema),
  requirements: factSchema(z.array(requirementSchema)),
  responsibilities: factSchema(responsibilitiesSchema),
  application: z.object({
    canonicalPostingUrl: z.string().nullable(),
    applyUrl: z.string().nullable(),
    ats: z.object({ provider: z.string(), boardToken: z.string().nullable() }).nullable(),
  }),
  lifecycle: jobLifecycleSchema,
  verification: z.object({
    lastVerifiedAt: z.date().optional(),
    lastOutcome: z.enum(['live', 'not_found', 'inconclusive']).optional(),
    nextVerificationDueAt: z.date().optional(),
  }),
  interpretation: z.object({
    logicVersion: z.string(),
    policyVersion: z.string(),
    taxonomyVersion: z.string(),
    computedAt: z.date(),
    basedOnObservationId: z.string(),
    flags: z.array(interpretationFlagSchema),
  }),
  /** AI proposals retained with provenance; applied only under explicit policy. */
  aiProposals: z
    .array(
      z.object({
        /** Operation id (hash of job, task, workflow idempotency key) — see AiProposalService. */
        id: z.string().optional(),
        task: z.string(),
        meta: z.record(z.string(), z.unknown()),
        data: z.unknown(),
        createdAt: z.date(),
        applied: z.boolean(),
      }),
    )
    .default([]),
  /** Operator corrections (authority `operator`), applied by reconciliation. */
  overrides: z
    .record(
      z.string(),
      z.object({ value: z.unknown(), reason: z.string(), actorId: z.string(), at: z.date() }),
    )
    .default({}),
  /**
   * The operator's decision on a sponsorship conflict (DECISION_LOG 3dfe3c5 (2)): the stating
   * copies' observations and values it decided (override, dismiss or confirm of the
   * `sponsorship_conflict` review). The conflict is suppressed only while the current stating
   * set is a subset of `stating`.
   */
  sponsorshipDecision: z
    .object({
      stating: z.array(
        z.object({
          /** The stating copy (source + record; bc013e8 L2). Absent on decisions recorded before. */
          copy: z.string().optional(),
          observationId: z.string(),
          value: z.enum(['yes', 'no']),
          /** The key's scope (`*` generic) and the stated line's hash (final check M-2). */
          scope: z.string().optional(),
          line: z.string().optional(),
        }),
      ),
      action: z.enum(['correct', 'dismiss', 'confirm']),
      reviewItemId: z.string(),
      actorId: z.string(),
      at: z.date(),
    })
    .optional(),
  duplicateOf: z.array(z.string()).default([]),
  distinctFrom: z.array(z.string()).default([]),
  reposts: z
    .array(z.object({ at: z.date(), sourceKey: z.string(), previousState: z.enum(JOB_STATES) }))
    .default([]),
  quality: z.object({
    conflictFields: z.array(z.string()),
    openReviewCount: z.number().int(),
    sourceCount: z.number().int(),
  }),
  contentHash: z.string(),
  /**
   * Optimistic-concurrency revision, incremented by every lifecycle/source-ref write
   * (`JobService.casUpdate`). Absent on documents written before it existed (= revision 0).
   */
  rev: z.number().int().min(0).optional(),
  schemaVersion: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type JobDoc = z.infer<typeof jobDocSchema>;

export const jobsCollection = defineCollection<JobDoc>({
  name: 'market_jobs',
  description: 'Canonical jobs with lifecycle, employment intelligence and source copies.',
  schema: jobDocSchema,
  schemaVersion: JOB_SCHEMA_VERSION,
  indexes: [
    {
      key: { 'interpretation.policyVersion': 1, status: 1, _id: 1 },
      options: { name: 'by_policy_version' },
      rationale:
        'Re-interpretation backfill (DECISION_LOG 3dfe3c5 L-c): keyset pages of active jobs per outdated policy version, and index-only counts of what is left (the startup warning).',
    },
    {
      key: { sourceKeys: 1 },
      options: {
        name: 'uniq_source_keys',
        unique: true,
        partialFilterExpression: { status: 'active' },
      },
      rationale:
        'A source record (sourceId + external id) maps to exactly one active canonical job; retries cannot duplicate jobs. Partial on active: merged jobs hold no keys, and an empty array would otherwise be indexed as a shared null key.',
    },
    {
      key: { companyId: 1, requisitionId: 1 },
      options: {
        name: 'by_company_requisition',
        partialFilterExpression: { requisitionId: { $type: 'string' } },
      },
      rationale:
        'Resolve syndicated copies by company + requisition id. Not unique: one requisition may cover several locations.',
    },
    {
      key: { updatedAt: 1, _id: 1 },
      options: { name: 'by_updated' },
      rationale: 'OPS-4 lifecycle signal writer: jobs written since its cursor (keyset).',
    },
    {
      key: { urlFingerprints: 1 },
      options: { name: 'by_url_fingerprint' },
      rationale: 'Resolve copies that link to the same canonical/apply URL.',
    },
    {
      key: { mergedInto: 1 },
      options: { name: 'by_merged_into', partialFilterExpression: { mergedInto: { $exists: true } } },
      rationale:
        'Records merged into a survivor (run history includes runs labelled with them). Partial: only merged records are indexed.',
    },
    {
      key: { companyId: 1, 'identity.titleKey': 1 },
      options: { name: 'by_company_title' },
      rationale: 'Duplicate/repost candidate blocking.',
    },
    {
      // Status and state lead: the `hasActiveJobs` distinct has no `companyId` predicate, so a
      // companyId-first key could not bound it (it was a collection scan).
      key: { status: 1, 'lifecycle.state': 1, companyId: 1 },
      options: { name: 'by_company_state' },
      rationale:
        'Covered distinct of the companies with an active, non-CLOSED job (`hasActiveJobs`; bounded to active non-CLOSED keys) and covered live active-job counts of a page of companies (summary `activeJobCount`). `list_company_seen` lacks the state: it would fetch every job.',
    },
    {
      key: { status: 1, 'lifecycle.lastSeenAt': -1, _id: -1 },
      options: { name: 'list_seen' },
      rationale: 'Job list default sort `-lastSeenAt` with the `_id` tiebreak (keyset pagination).',
    },
    {
      key: { status: 1, 'lifecycle.firstSeenAt': -1, _id: -1 },
      options: { name: 'list_first_seen' },
      rationale: 'Job list `sort=firstSeenAt` and `firstSeenAfter/Before` (keyset pagination).',
    },
    {
      key: { status: 1, 'lifecycle.lastChangedAt': -1, _id: -1 },
      options: { name: 'list_changed' },
      rationale:
        'Job list `sort=lastChangedAt` and `changedAfter/Before` (keyset pagination); the dashboard `changed` count (active jobs changed since).',
    },
    {
      key: { status: 1, 'identity.normalizedTitle': 1, _id: 1 },
      options: { name: 'list_title' },
      rationale: 'Job list `sort=title` (keyset pagination).',
    },
    {
      key: { companyId: 1, status: 1, 'lifecycle.lastSeenAt': -1, _id: -1 },
      options: { name: 'list_company_seen' },
      rationale: "A company's jobs, newest first (company record, `companyId` filter), keyset-paginated.",
    },
    {
      key: { status: 1, 'identity.titleTokens': 1 },
      options: { name: 'by_title_tokens' },
      rationale:
        'Job list `q`: every query word is an anchored prefix of some title token (multikey; no text index, whose key shape the index manager cannot compare).',
    },
    {
      key: { 'interpretation.flags.code': 1 },
      options: { name: 'by_flag' },
      rationale: 'Job list `flag` filter (interpretation flags).',
    },
    {
      key: { 'lifecycle.state': 1, 'lifecycle.lastSeenAt': -1 },
      options: { name: 'by_state_seen' },
      rationale: 'Lifecycle dashboards and listing.',
    },
    {
      key: { 'sourceRefs.sourceId': 1, _id: 1 },
      options: { name: 'by_source_copy' },
      rationale:
        "A source's jobs: listing absence application and the paged recompute after a standing change (DECISION_LOG 15c965b).",
    },
    {
      key: { 'verification.nextVerificationDueAt': 1, 'lifecycle.state': 1 },
      options: { name: 'by_verification_due' },
      rationale: 'Due-for-verification queries (freshness).',
    },
    {
      key: { 'geography.workModel.value': 1 },
      options: { name: 'by_work_model' },
      rationale: 'Filter jobs by work model.',
    },
  ],
});

export const evidenceList = z.array(evidenceReferenceSchema);
