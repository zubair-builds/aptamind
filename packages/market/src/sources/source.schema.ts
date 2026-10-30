import { z } from 'zod';
import { jsonObjectSchema } from '@aptamind/contracts';
import { defineCollection } from '@aptamind/db';
import { AUTHORITY_TIERS } from '@aptamind/provenance';
import { SOURCE_CATEGORIES } from '../contracts/common';
import { titleTokens } from '../jobs/title-tokens';

export const SOURCE_SCHEMA_VERSION = 1;

/** Collation for case-insensitive source key lookups (`by_key_ci`); queries must use the same one. */
export const KEY_CASE_INSENSITIVE = { locale: 'en', strength: 2 } as const;

export const sourceGovernanceSchema = z.object({
  accessMethod: z.enum([
    'public_api',
    'public_download',
    'public_web',
    'manual_upload',
    'licensed_feed',
    'internal',
  ]),
  termsNotes: z.string().optional(),
  commercialUseNotes: z.string().optional(),
  retentionRestrictions: z.string().optional(),
  redistributionRestrictions: z.string().optional(),
  crawlPolicy: z.string().optional(),
  rateLimitPerMinute: z.number().int().positive().optional(),
  lastComplianceReviewAt: z.coerce.date().optional(),
});
export type SourceGovernance = z.infer<typeof sourceGovernanceSchema>;

/** `health.status`: `degraded` after one failed logical run, `failing` after three in a row. */
export const SOURCE_HEALTH_STATUSES = ['never_run', 'healthy', 'degraded', 'failing'] as const;

/**
 * A Source is the durable definition of an information origin: what it provides, how it is
 * acquired (a workflow + configuration), how often, what authority it has for which facts,
 * and its operational health. Not a bare URL.
 */
export const sourceDocSchema = z.object({
  _id: z.string(),
  /** Stable human/business key, e.g. `uk-sponsor-register`, `greenhouse:acme`. Unique. */
  key: z.string().min(2).max(200),
  name: z.string(),
  /**
   * Search tokens of `name` (`sourceNameTokens`, tokenised like job titles): lower-case, accents
   * removed, split on punctuation. Set on register and rename; absent only on documents written
   * before it existed (the platform migration backfills it).
   */
  nameTokens: z.array(z.string()).optional(),
  /**
   * Whole-name search key (`sourceNameKey`, M7.4: lower-case, accents removed, punctuation runs →
   * one space). **Widen phase:** still written on register and rename and still searched, so a
   * reader of the previous release keeps working; retired in a later release (tighten: re-run the
   * backfill, then unset it and drop `by_name_key`).
   */
  nameKey: z.string().optional(),
  category: z.enum(SOURCE_CATEGORIES),
  /** Provider/connector family, e.g. `uk_home_office_sponsor_register`, `greenhouse`, `careers_page`. */
  provider: z.string(),
  endpoint: z.object({ url: z.string().url().optional(), boardToken: z.string().optional() }).default({}),
  /**
   * When `endpoint` last changed (PATCH; PR #11 re-verify #7 MEDIUM-2). A copy's board is recorded
   * only for a listing fetched at or after it, and a copy without a recorded board is verified
   * only if the endpoint did not change after the copy was last seen. Absent: never changed since
   * this field exists (earlier changes are found in the audit log).
   */
  endpointChangedAt: z.date().optional(),
  acquisition: z.object({
    workflowKey: z.string(),
    workflowVersion: z.number().int().positive().optional(),
    /** Passed as run input (merged with `{ sourceId }`). Never contains secrets — use credential refs. */
    config: jsonObjectSchema.default({}),
    credentialRefs: z.array(z.object({ kind: z.literal('env'), name: z.string() })).default([]),
  }),
  /** Canonical company this source belongs to (job boards / careers pages). */
  companyId: z.string().optional(),
  schedule: z
    .object({
      cron: z.string().optional(),
      intervalMinutes: z.number().int().positive().optional(),
      timezone: z.string().default('UTC'),
    })
    .optional(),
  freshness: z.object({
    /** Data class whose freshness policy applies, e.g. `source.ats_listing`. */
    policyClass: z.string(),
    maxAgeMinutes: z.number().int().positive(),
  }),
  authority: z.object({
    tier: z.enum(AUTHORITY_TIERS),
    /** Field-specific authority notes (e.g. "authoritative for UK sponsor licence presence"). */
    authoritativeFor: z.array(z.string()).default([]),
    /** Whether a successful listing is a complete snapshot (absence of an item is meaningful). */
    listingIsComplete: z.boolean().default(false),
  }),
  governance: sourceGovernanceSchema.default({ accessMethod: 'public_web' }),
  enabled: z.boolean(),
  /**
   * Every enable/disable, appended in the same write as `enabled` (DECISION_LOG 15c965b): from each
   * entry's `at` on the source is `enabled`. The first write seeds the state before it (at the
   * source's creation). Evidence counts according to the standing at its own time (`enabledAt`).
   */
  standingHistory: z.array(z.object({ at: z.date(), enabled: z.boolean() })).optional(),
  /**
   * A standing change whose recompute of the source's jobs is not done yet (DECISION_LOG
   * 9b0cb03 L2): set in the same write as the `standingHistory` entry (`pendingAt` = its `at`),
   * advanced page by page (`cursor`: the last job id re-derived) and removed once every page is
   * done. A retry of the change, or the freshness sweep, resumes a marker still pending.
   */
  standingRecompute: z
    .object({
      pendingAt: z.date(),
      cursor: z.string().nullable(),
      /** When the sweep last tried to resume it (least recently tried go first). */
      lastAttemptAt: z.date().optional(),
    })
    .optional(),
  health: z.object({
    status: z.enum(SOURCE_HEALTH_STATUSES),
    consecutiveFailures: z.number().int().min(0),
    lastAttemptAt: z.date().optional(),
    lastSuccessAt: z.date().optional(),
    lastFailureAt: z.date().optional(),
    lastError: z.string().optional(),
    lastRunId: z.string().optional(),
    lastSnapshotId: z.string().optional(),
    /**
     * Source time (snapshot fetch time) of the latest *complete, successful* dataset import — the
     * delisting marker. Source chronology, not processing time: it only moves forward, so
     * reprocessing an older snapshot cannot delist records a newer snapshot lists. (The name
     * predates this; kept for compatibility.)
     */
    lastCompleteImportStartedAt: z.date().optional(),
    lastItemCount: z.number().int().optional(),
    /**
     * History registers (M11.5): per period (fiscal year), the latest complete import — its
     * snapshot's source time (`completeAt`, only moves forward), evidence-row count (the
     * per-period shrink guard's baseline) and snapshot. The source's rows of a period observed
     * before `completeAt` are replaced (DECISION_LOG "Sponsor register adapters" (3)).
     */
    historyPeriods: z
      .array(
        z.object({
          period: z.number().int(),
          completeAt: z.date(),
          rowCount: z.number().int().min(0),
          snapshotId: z.string(),
          /** Parser (`name/version`) that read the file (delta review L3). */
          parser: z.string().optional(),
        }),
      )
      .optional(),
    /**
     * The latest REAL acquisition of a job listing (a fetch, or an operator upload): its time and
     * whether it succeeded (DECISION_LOG 6a01b36, PR #11 re-verify #8 LOW-D). Moves forward only;
     * reprocessing a stored snapshot never changes it. "Latest listing failed" reads it.
     */
    latestFetch: z.object({ at: z.date(), ok: z.boolean(), runId: z.string().optional() }).optional(),
    /** Run ids of the current failure streak (bounded; cleared by a success; re-verify final L3). */
    failedRuns: z.array(z.string()).optional(),
    /** Fetch time of the last listing whose absences were applied (reprocessing never re-applies). */
    lastListingAppliedAt: z.date().optional(),
    /**
     * Job listings: the shrink guard's baseline (M6.2) — the size (`count`, entries seen) of the
     * last listing whose absences were applied, its snapshot, and its source time (`at`; only
     * moves forward). A held, incomplete or reprocessed listing never moves it, so a collapsed
     * board stays held until it recovers or an operator confirms the shrink. Unlike
     * `lastItemCount` (every successful listing), it is not display data.
     */
    listingBaseline: z
      .object({
        count: z.number().int().min(0),
        snapshotId: z.string(),
        at: z.date(),
        /**
         * Set when the source endpoint changed after this baseline was taken (PATCH): the
         * baseline still guards the next listing (a wrong endpoint is held, not applied), and a
         * held listing's review says the endpoint changed. Gone once a listing is applied.
         */
        endpointChangedAt: z.date().optional(),
      })
      .optional(),
    /**
     * Job listings: set while the guard holds this source's listings (PR #11 B-H1) — a held
     * listing is a successful fetch, not a failed run. `reason`: `shrink` (a collapse against a
     * baseline of ≥ 10, with a `source_anomaly` review) or `small_board_empty` (a small board
     * that emptied: held for one run, no review — ruling L2). `since`/`lastAt`: source times of
     * the first and latest held listing of this episode; `count`/`baseline`: the latest held
     * listing's size and the baseline it was compared with; `reviewId`: the `source_anomaly`
     * raised for it (shrink only; it may since have been resolved or dismissed). Cleared when a
     * listing is applied.
     */
    listingHeld: z
      .object({
        reason: z.enum(['shrink', 'small_board_empty']),
        since: z.date(),
        lastAt: z.date(),
        count: z.number().int().min(0),
        baseline: z.number().int().min(0),
        reviewId: z.string().optional(),
      })
      .optional(),
    /**
     * OPS-2: the last listing finalised cleanly on the full path (or confirmed since). A fetch
     * whose bytes match it (or a 304 to its validators) only confirms presence instead of
     * ingesting every job. Unset by any finalised listing that was not clean.
     */
    listingStamp: z
      .object({
        snapshotId: z.string(),
        contentHash: z.string(),
        adapterVersion: z.string(),
        url: z.string(),
        etag: z.string().optional(),
        lastModified: z.string().optional(),
        /** Listed (public) entries of the listing. */
        listed: z.number().int().min(0),
        /**
         * Digest of the listed copies' (key, content hash) pairs as this listing left them. A
         * confirm needs the copies to still match it (H1). Stamps without one are never used.
         */
        copies: z.string().optional(),
        at: z.date(),
      })
      .optional(),
    /** OPS-2 / M10.3: scheduled runs before this time are deferred without a request. */
    backoffUntil: z.date().optional(),
    /** OPS-2: run ids of the current streak of 404 listing responses (cleared by any other outcome). */
    notFoundRuns: z.array(z.string()).optional(),
  }),
  /**
   * LOGICAL source-run counters: each workflow run counts at most once per outcome, whatever
   * retries, takeovers or acknowledgement replays its steps go through (calls without a run id,
   * e.g. manual uploads, count once per call). `health.consecutiveFailures` counts logical
   * failed runs the same way; it drives `health.status` (degraded / failing).
   */
  stats: z
    .object({ attempts: z.number().int(), successes: z.number().int(), failures: z.number().int() })
    .default({ attempts: 0, successes: 0, failures: 0 }),
  labels: z.record(z.string(), z.string()).default({}),
  schemaVersion: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type SourceDoc = z.infer<typeof sourceDocSchema>;

/**
 * The whole-name search key of a source name (M7.4; widen phase, see `nameKey`): Unicode NFKD
 * without diacritics, lower-case, every run of characters that are not letters or digits → one
 * space, trimmed; bounded to 200 characters. "Acme — Careers (EU)" → "acme careers eu".
 */
export function sourceNameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Search tokens of a source name — the job-title tokeniser (`titleTokens`): Unicode NFKD without
 * diacritics, lower-case, split on anything that is not a letter or digit (`c++`/`.net` kept),
 * bounded. "UK Home Office — Sponsor Register" → `uk`, `home`, `office`, `sponsor`, `register`.
 */
export function sourceNameTokens(name: string): string[] {
  return titleTokens(name);
}

export const sourcesCollection = defineCollection<SourceDoc>({
  name: 'market_sources',
  description: 'Market sources: acquisition config, schedule, authority, governance and health.',
  schema: sourceDocSchema,
  schemaVersion: SOURCE_SCHEMA_VERSION,
  indexes: [
    {
      key: { key: 1 },
      options: { name: 'uniq_key', unique: true },
      rationale: 'Business key; idempotent source registration (e.g. greenhouse:acme).',
    },
    {
      key: { key: 1 },
      options: { name: 'by_key_ci', collation: KEY_CASE_INSENSITIVE },
      rationale:
        'Case-insensitive key lookup: a board file must not register greenhouse:Acme next to greenhouse:acme.',
    },
    {
      key: { category: 1, enabled: 1 },
      options: { name: 'by_category_enabled' },
      rationale: 'Source lists and due queries.',
    },
    {
      key: { companyId: 1 },
      options: { name: 'by_company', sparse: true },
      rationale: 'Job sources of a company.',
    },
    {
      key: { 'health.status': 1 },
      options: { name: 'by_health' },
      rationale: 'Dashboard: failing/degraded sources.',
    },
    {
      key: { 'standingRecompute.lastAttemptAt': 1, 'standingRecompute.pendingAt': 1 },
      options: { name: 'by_standing_resume', sparse: true },
      rationale:
        'The sweep resumes standing recomputes left pending, least recently attempted first (DECISION_LOG 9b0cb03).',
    },
    {
      key: { category: 1, name: 1, _id: 1 },
      options: { name: 'list_category_name' },
      rationale: 'Source list default sort (`category`, then `name`, `_id` tiebreak; keyset pagination).',
    },
    {
      key: { name: 1, _id: 1 },
      options: { name: 'list_name' },
      rationale: 'Source list `sort=name` (keyset pagination).',
    },
    {
      key: { 'health.lastSuccessAt': -1, _id: -1 },
      options: { name: 'list_last_success' },
      rationale: 'Source list `sort=lastSuccessAt` (keyset pagination).',
    },
    {
      key: { createdAt: -1, _id: -1 },
      options: { name: 'list_created' },
      rationale: 'Source list `sort=createdAt` (keyset pagination).',
    },
    {
      key: {
        enabled: 1,
        'freshness.policyClass': 1,
        'freshness.maxAgeMinutes': 1,
        'health.lastSuccessAt': 1,
      },
      options: { name: 'by_freshness' },
      rationale:
        'Server-computed freshness (`freshness=` filter, dashboard overdue list): distinct (class, max age) pairs are read covered, then one bounded `lastSuccessAt` range per pair.',
    },
    {
      key: { nameKey: 1 },
      options: { name: 'by_name_key' },
      rationale:
        'Source list `q` of the previous release: anchored prefix on the whole normalised name (kept until the tighten release).',
    },
    {
      key: { nameTokens: 1 },
      options: { name: 'by_name_tokens' },
      rationale: 'Source list `q`: every query word is an anchored prefix of some name token (multikey).',
    },
    {
      key: { provider: 1 },
      options: { name: 'by_provider' },
      rationale: 'Source list `provider` filter; the distinct providers anchor the key search.',
    },
    {
      key: { enabled: 1, 'health.lastSuccessAt': 1 },
      options: { name: 'by_enabled_last_success' },
      rationale: 'Due-for-refresh / freshness-overdue queries.',
    },
  ],
});

/**
 * One counted outcome of one logical source run (`<source>:<run>:<kind>`). Inserted in the same
 * transaction as the counter increment, so a replayed acquisition step (retry, takeover,
 * acknowledgement replay) never counts the same run twice. Retained with the source.
 */
export const sourceRunOutcomeDocSchema = z.object({
  _id: z.string(),
  sourceId: z.string(),
  runId: z.string(),
  kind: z.enum(['attempt', 'success', 'failure']),
  at: z.date(),
  schemaVersion: z.number().int(),
  createdAt: z.date(),
});
export type SourceRunOutcomeDoc = z.infer<typeof sourceRunOutcomeDocSchema>;

export const sourceRunOutcomesCollection = defineCollection<SourceRunOutcomeDoc>({
  name: 'market_source_run_outcomes',
  description: 'Idempotency markers for source health counters (one per source, run and outcome).',
  schema: sourceRunOutcomeDocSchema,
  schemaVersion: SOURCE_SCHEMA_VERSION,
  indexes: [
    {
      key: { sourceId: 1, at: -1 },
      options: { name: 'by_source_time' },
      rationale: 'Run outcome history of a source.',
    },
  ],
});
