import { z } from 'zod';
import type { Actor } from '@aptamind/contracts';
import {
  type CapabilityContext,
  defineCapability,
  recordSetSchema,
  TerminalError,
} from '@aptamind/workflow-sdk';
import { AI_GATEWAY, NET_CLIENT } from '@aptamind/workflow-nodes';
import { jobInterpretationInputSchema, jobInterpretationSchema } from '../contracts/employment';
import { interpretJob } from '../enrichment';
import { copyBoardSchema } from '../jobs/job.schema';
import { assessListing } from '../jobs/listing-policy';
import { countOutdatedInterpretations, selectOutdatedInterpretations } from '../jobs/reinterpret-backfill';
import { MARKET, type MarketDomain } from '../market-domain';
import type { SourceDoc } from '../sources/source.schema';
import { listingItemSchema, listingStampCandidateSchema, presenceItemSchema } from './acquisition';
import { JOB_REQUIREMENTS_PROMPT, jobRequirementsProposalSchema } from './ai-tasks';

/** Create Job Observation + Resolve Job + lifecycle + Reconcile Job, for one listing item. */
export const ingestJobObservation = defineCapability({
  type: 'market.ingest_job_observation',
  version: 1,
  title: 'Ingest Job Observation',
  description:
    'Records a job observation, resolves/deduplicates it to a canonical job, applies lifecycle and reconciles.',
  category: 'domain',
  inputSchema: z.object({
    sourceId: z.string(),
    snapshotId: z.string().optional(),
    artifactId: z.string().optional(),
    item: listingItemSchema,
    observedAt: z.string().nullable().optional(),
    /**
     * The board the listing was read from (`fetch_job_board` output, captured at fetch start;
     * null: unknown). Omitted by workflows that do not carry one (careers crawl): the source's
     * board at the sighting.
     */
    board: copyBoardSchema.nullable().optional(),
  }),
  outputSchema: z.object({
    outcome: z.string(),
    jobId: z.string().optional(),
    observationId: z.string(),
    lifecycleState: z.string().optional(),
  }),
  configSchema: z.object({}),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'Observation id = hash(source, record, payload); the sighting is job evidence keyed by (copy, snapshot fetch time), so a replay records nothing new; the job is re-derived from its evidence set and written under its revision fence (CAS).',
  },
  async execute(ctx, input) {
    const market = ctx.services.get(MARKET);
    const source = await market.sources.get(input.sourceId);
    const r = await market.jobPipeline.process({
      source,
      snapshotId: input.snapshotId,
      artifactId: input.artifactId,
      locator: input.item.locator,
      payload: input.item.payload,
      parser: { name: `${input.item.payload.provider.name}-adapter`, version: '1' },
      ai: input.item.ai,
      runId: ctx.runId,
      at: input.observedAt ? new Date(input.observedAt) : undefined,
      board: input.board,
    });
    return {
      outcome: r.outcome,
      observationId: r.observationId,
      jobId: 'jobId' in r ? r.jobId : undefined,
      lifecycleState: 'lifecycleState' in r ? r.lifecycleState : undefined,
    };
  },
});

const finalizeJobListingInput = z.object({
  sourceId: z.string(),
  snapshotId: z.string(),
  records: recordSetSchema,
  complete: z.boolean(),
  fetchedAt: z.string(),
  fanout: z.object({ total: z.number().int(), succeeded: z.number().int(), failed: z.number().int() }),
  /** `fetch_job_board` output: the board read at fetch start (null or absent: unknown). */
  board: copyBoardSchema.nullable().optional(),
  /** `fetch_job_board` output: false for a reprocessed snapshot, which never changes health. */
  acquired: z.boolean().nullable().optional(),
});

const finalizeJobListingOutput = z.object({
  absenceApplied: z.boolean(),
  reason: z.string().nullable(),
  absent: z.number().int(),
  closed: z.number().int(),
  possiblyStale: z.number().int(),
  /** Jobs this listing had already been applied to (a replay after a crash or retry). */
  alreadyApplied: z.number().int(),
  seen: z.number().int(),
  /** Copies of identified skipped entries whose sighting this listing moved forward (A-L5). */
  skippedTouched: z.number().int().optional(),
});

const finalizeJobListingConfig = z.object({ maxFailureRatio: z.number().min(0).max(1).default(0.1) });

const finalizeJobListingExecution = {
  retryable: true,
  idempotency: 'natural',
  sideEffects: true,
  idempotencyProof:
    'Listing presence/absence is recorded as job evidence keyed by (copy, listing fetch time, outcome), so a replay records nothing new, and each job is re-derived from its whole evidence set under its revision fence (DECISION_LOG 6a01b36). The shrink baseline only moves forward in source time and is written before the applied watermark (a replay re-applies, never skips it); anomaly reviews use a per-baseline dedupe key.',
} as const;

/**
 * Dedupe key of the shrink anomaly for one baseline INSTANCE, so a confirmation approves only the
 * baseline it was given for. Snapshots are content-addressed (a board that returns to the same
 * content reuses its snapshot id), so the baseline's source time is part of the key.
 */
function shrinkReviewKey(sourceId: string, baseline: { snapshotId: string; at?: Date }): string {
  const ref = baseline.at ? `${baseline.snapshotId}@${baseline.at.getTime()}` : baseline.snapshotId;
  return `source_anomaly:${sourceId}:listing_shrink:${ref}`;
}

/**
 * The source's small-board hold as the listing guard sees it. Positive evidence on the source
 * (a sighting or a live verification) after the hold RE-ARMS it (DECISION_LOG b7f1a76): the next
 * empty listing is held again, not released.
 */
async function smallBoardHoldOf(market: MarketDomain, source: SourceDoc): Promise<{ at: Date } | null> {
  const held = source.health.listingHeld;
  if (held?.reason !== 'small_board_empty') return null;
  const positive = await market.jobs.lastPositiveEvidenceOnSource(source._id);
  return positive && positive > held.lastAt ? null : { at: held.lastAt };
}

/**
 * Finalise a job listing. Absence handling runs only when the listing was complete, the items
 * processed successfully and the listing did not collapse against the source's baseline;
 * otherwise nothing is marked absent (a partial, failed or anomalous refresh must not close
 * jobs). The decision is the pure `assessListing` policy.
 */
async function finalizeListing(
  ctx: CapabilityContext,
  input: z.infer<typeof finalizeJobListingInput>,
  config: z.infer<typeof finalizeJobListingConfig>,
  skipped: ReadonlyArray<{ externalId: string | null; kind?: string }>,
  ops2: {
    path: 'full' | 'confirm';
    present: z.infer<typeof finalizeJobListingInput.shape.records> | null;
    stamp: z.infer<typeof listingStampCandidateSchema> | null;
  } | null = null,
): Promise<z.infer<typeof finalizeJobListingOutput>> {
  const market = ctx.services.get(MARKET);
  const source = await market.sources.get(input.sourceId);
  const confirm = ops2?.path === 'confirm' && !!ops2.present;
  const ids: string[] = [];
  if (confirm) {
    for await (const item of ctx.records.read(ops2.present!)) {
      const parsed = presenceItemSchema.safeParse(item);
      if (parsed.success) ids.push(parsed.data.externalId);
    }
  } else {
    for await (const item of ctx.records.read(input.records)) {
      const parsed = listingItemSchema.safeParse(item);
      if (parsed.success) ids.push(parsed.data.payload.externalId);
    }
  }
  const fetchedAt = new Date(input.fetchedAt);
  // The board the listing was read from (captured at fetch start): evidence is recorded on it.
  const board = input.board ?? null;
  // OPS-2 confirm path: ingest ran over no items, so presence is confirmed here, as an ingest of
  // the unchanged listing would have done; every listed item counts as processed.
  if (confirm) {
    await market.jobPipeline.confirmListingPresence(source, ids, fetchedAt, board, {
      snapshotId: input.snapshotId,
      runId: ctx.runId,
    });
    input = { ...input, fanout: { total: ids.length, succeeded: ids.length, failed: 0 } };
  }
  // Baseline: the last listing whose absences were applied. Sources applied before M6.2 have
  // none yet: their last item count stands in (A-M1). The guard compares against the EFFECTIVE
  // baseline, max(baseline, open jobs present on the source): a held listing (incomplete, item
  // failures) still marks its jobs present without moving the baseline, so a board whose
  // baseline is 0 can have live jobs — its first empty listing must still get the one-run hold
  // (PR #11 re-review MEDIUM-1).
  const presentJobs = await market.jobPipeline.countPresentJobs(source._id);
  const baseline: { count: number | null; snapshotId: string; at?: Date; endpointChangedAt?: Date } = source
    .health.listingBaseline ?? {
    count: source.health.lastItemCount ?? 0,
    snapshotId: `legacy-${source.health.lastSnapshotId ?? 'none'}`,
  };
  const effectiveBaseline = Math.max(baseline.count ?? 0, presentJobs);
  const policy = {
    itemExternalIds: ids,
    skipped,
    complete: input.complete,
    fetchedAt,
    lastListingAppliedAt: source.health.lastListingAppliedAt,
    fanout: input.fanout,
    maxFailureRatio: config.maxFailureRatio,
    baselineCount: effectiveBaseline,
    smallBoardHold: await smallBoardHoldOf(market, source),
  };
  let decision = assessListing(policy);
  const reviewKey = shrinkReviewKey(source._id, baseline);
  if (decision.code === 'shrink') {
    // An operator may have confirmed a shrink from THIS baseline (latest decision wins).
    const confirmedCount = (
      await market.reviews.latestConfirmation(reviewKey, { kind: 'source', id: source._id })
    )?.context.count;
    if (typeof confirmedCount === 'number') decision = assessListing({ ...policy, confirmedCount });
  }
  const { seen } = decision;
  let { reason } = decision;
  // Identified skipped entries are on the board: their copies do not decay, and unlisted ones
  // record the provider state (A-L5, B-M5). Evidence is keyed per copy and listing (replay-safe).
  const touched = skipped.length
    ? await market.jobPipeline.touchSkippedEntries(source, skipped, fetchedAt, board)
    : { touched: 0, unlisted: 0 };
  let res = { absent: 0, closed: 0, possiblyStale: 0, alreadyApplied: 0 };
  // A source disabled while its listing was in flight records no absences (LOW-F): a disabled
  // source is no evidence (and its evidence would not count anyway).
  const apply = decision.apply && source.enabled;
  if (decision.apply && !source.enabled) reason = 'the source was disabled while its listing was in flight';
  if (apply) {
    // Evidence keys make this replay-safe; the source watermark below is only a fast path for
    // whole-listing reprocessing.
    res = await market.jobPipeline.applyListingAbsences(source, seen, fetchedAt, input.snapshotId, board);
    await market.sources.recordListingApplied(source._id, {
      count: decision.baselineAfter ?? seen.size,
      snapshotId: input.snapshotId,
      fetchedAt,
    });
    if (decision.shrink?.confirmed)
      ctx.log.info('operator-confirmed listing shrink applied', { ...decision.shrink });
  } else ctx.log.warn('absence handling skipped', { reason });
  if (decision.code === 'shrink' && decision.shrink) {
    const { baselineCount, count } = decision.shrink;
    const endpointChanged = baseline.endpointChangedAt
      ? ` The source endpoint changed on ${baseline.endpointChangedAt.toISOString()}, after the baseline was taken: check it.`
      : '';
    const anomaly =
      count === 0
        ? `listing returned no jobs (baseline ${baselineCount})`
        : `listing shrank from ${baselineCount} to ${count} jobs`;
    const { item } = await market.reviews.raise({
      type: 'source_anomaly',
      severity: 'medium',
      dedupeKey: reviewKey,
      entity: { kind: 'source', id: source._id },
      subject: `${source.name}: ${anomaly} (no jobs closed)`,
      reason:
        `${anomaly}. Absences were not applied and are held while the board stays this small. ` +
        'Confirm if the board really shrank (the next listing is then applied), or retry.' +
        endpointChanged,
      evidence: [{ sourceId: source._id, snapshotId: input.snapshotId, observedAt: fetchedAt }],
      context: {
        sourceId: source._id,
        snapshotId: input.snapshotId,
        baselineCount,
        baselineSnapshotId: baseline.snapshotId,
        baselineAt: baseline.at?.toISOString() ?? null,
        baselineEndpointChangedAt: baseline.endpointChangedAt?.toISOString() ?? null,
        count,
      },
      allowedActions: ['retry', 'confirm', 'dismiss'],
      // The operator confirms the latest held size, not the first one (A-L6).
      refresh: true,
    });
    // B-H1 ruling: a held listing is a successful fetch with a distinct hold marker (not a
    // failed run); the baseline is untouched.
    await market.sources.recordListingHeld(source._id, {
      reason: 'shrink',
      count,
      baseline: baselineCount,
      reviewId: item._id,
      fetchedAt,
    });
  }
  if (decision.code === 'small_board_empty' && decision.shrink) {
    // L2: a small board that emptied is held for this one run, without a review; the next
    // (later) empty listing is applied.
    await market.sources.recordListingHeld(source._id, {
      reason: 'small_board_empty',
      count: 0,
      baseline: decision.shrink.baselineCount,
      fetchedAt,
    });
  }
  // Reprocessing a stored snapshot never changes source health (LOW-D); nor does a listing whose
  // fetch is no longer the source's latest (a newer fetch failed meanwhile, L-4).
  if (input.acquired !== false)
    await market.sources.recordSuccess(source._id, {
      snapshotId: input.snapshotId,
      itemCount: seen.size,
      runId: ctx.runId,
      fetchAt: fetchedAt,
    });
  // OPS-2: stamp only a listing whose every step can be skipped next time with the same result:
  // clean bytes, every item ingested, absences applied. Anything else clears the stamp, so the
  // next listing takes the full path. A replayed finalize of the same listing ("already applied")
  // keeps what its first execution wrote.
  // The stamp keeps a digest of the listed copies' content as this listing left them. On the
  // confirm path the copies must still hold the content the fetch validated: another run may have
  // ingested other bytes in between, and a confirm writes no content to repair that (H1).
  if (ops2 && input.acquired !== false && decision.code !== 'already_applied') {
    const stamp =
      ops2.stamp?.clean && apply && input.fanout.failed === 0 && source.companyId ? ops2.stamp : null;
    let copies = stamp ? await market.jobPipeline.presenceDigest(source._id, ids) : null;
    if (confirm && copies && copies !== stamp?.copies) {
      ctx.log.warn('listed copies changed during the confirm run; the next listing runs in full');
      copies = null;
    }
    await market.sources.recordListingStamp(
      source._id,
      fetchedAt,
      stamp && copies
        ? {
            snapshotId: input.snapshotId,
            contentHash: stamp.contentHash,
            adapterVersion: stamp.adapterVersion,
            url: stamp.url,
            ...(stamp.etag ? { etag: stamp.etag } : {}),
            ...(stamp.lastModified ? { lastModified: stamp.lastModified } : {}),
            listed: stamp.listed,
            copies,
            at: fetchedAt,
          }
        : null,
    );
  }
  return { absenceApplied: apply, reason, ...res, seen: seen.size, skippedTouched: touched.touched };
}

/** v1 (runs pinned to template versions before M6.1): no skipped entries (`fetch_job_board@1` marks such listings incomplete). */
export const finalizeJobListingV1 = defineCapability({
  type: 'market.finalize_job_listing',
  version: 1,
  title: 'Finalize Job Listing',
  description:
    'Applies safe absence handling for complete authoritative listings and records source health.' +
    ' Changed in place in PR #11 (accepted exception, see streams/market.md): ' +
    'M6.2 shrink guard (per-baseline review) replaces the empty-listing guard; small boards that empty are held one run (L2).',
  category: 'domain',
  inputSchema: finalizeJobListingInput,
  outputSchema: finalizeJobListingOutput,
  configSchema: finalizeJobListingConfig,
  execution: finalizeJobListingExecution,
  async execute(ctx, input, config) {
    return finalizeListing(ctx, input, config, []);
  },
});

/**
 * Finalise a job listing (v2, M6.1): entries the adapter skipped (`fetch_job_board@2`
 * `skipped[]`) are on the board, so their records count as seen and are never marked absent.
 */
export const finalizeJobListing = defineCapability({
  type: 'market.finalize_job_listing',
  version: 2,
  title: 'Finalize Job Listing',
  description:
    'Applies safe absence handling for complete authoritative listings (skipped entries count as seen) and records source health.',
  category: 'domain',
  inputSchema: finalizeJobListingInput.extend({
    /** `fetch_job_board@2` output `skipped[]`: entries on the board the adapter did not map. */
    skipped: z.array(z.object({ externalId: z.string().nullable() }).passthrough()),
  }),
  outputSchema: finalizeJobListingOutput,
  configSchema: finalizeJobListingConfig,
  execution: finalizeJobListingExecution,
  async execute(ctx, input, config) {
    return finalizeListing(ctx, input, config, input.skipped);
  },
});

/**
 * Finalise a job listing (v3, OPS-2). After a `confirm` fetch (unchanged listing, no ingest) it
 * confirms the presence of every listed job, then runs the same listing policy as v2; on either
 * path it writes or clears the source's listing stamp.
 */
export const finalizeJobListingV3 = defineCapability({
  type: 'market.finalize_job_listing',
  version: 3,
  title: 'Finalize Job Listing',
  description:
    'Confirms presence for an unchanged listing (no ingest), applies safe absence handling for complete authoritative listings, records source health and the listing stamp.',
  category: 'domain',
  inputSchema: finalizeJobListingInput.extend({
    skipped: z.array(z.object({ externalId: z.string().nullable() }).passthrough()),
    /** `fetch_job_board@3` output `path` (`deferred` never reaches the finalizer). */
    path: z.enum(['full', 'confirm']),
    /** Confirm path: the `{ externalId }` items of the unchanged listing (`records` is empty). */
    present: finalizeJobListingInput.shape.records.nullable().optional(),
    stamp: listingStampCandidateSchema.nullable().optional(),
  }),
  outputSchema: finalizeJobListingOutput,
  configSchema: finalizeJobListingConfig,
  execution: {
    ...finalizeJobListingExecution,
    idempotencyProof:
      finalizeJobListingExecution.idempotencyProof +
      ' Confirmed presence is the same per-copy listing evidence key as an ingest; the listing stamp is written only while its fetch is the latest, with a digest of the listed copies read at write time (a confirm whose copies no longer match the digest it was validated on clears the stamp instead).',
  },
  async execute(ctx, input, config) {
    if (input.path === 'confirm' && !input.present)
      throw new TerminalError('finalize_job_listing@3: the confirm path needs the present items');
    return finalizeListing(ctx, input, config, input.skipped, {
      path: input.path,
      present: input.present ?? null,
      stamp: input.stamp ?? null,
    });
  },
});

/** Who re-interprets a job in a batch run (the audit events of `recordRunChange`). */
const REINTERPRETATION_ACTOR = { kind: 'system', id: 'market-reinterpretation' } as Actor;

export const reconcileJob = defineCapability({
  type: 'market.reconcile_job',
  version: 1,
  title: 'Reconcile Job',
  description:
    'Recomputes canonical job identity, content and employment intelligence from its source copies.' +
    ' Changed in place in M6.2 (accepted exception, see streams/market.md): ' +
    'optional config recordRunChange (default false) records a job.reinterpreted audit event linked to the run when the job changes (MR2).',
  category: 'domain',
  inputSchema: z.object({ jobId: z.string() }),
  outputSchema: z.object({
    jobId: z.string(),
    changed: z.boolean(),
    conflictFields: z.array(z.string()),
    workModel: z.string().nullable(),
    sponsorship: z.string().nullable(),
  }),
  configSchema: z.object({
    /**
     * Record the run on the job when it changes it (an audit event `job.reinterpreted`, M6.2 MR2):
     * set by batch runs that carry no `jobId` label (the re-interpretation backfill).
     */
    recordRunChange: z.boolean().default(false),
  }),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'Recomputes derived fields from the current source copies, written only if the job revision is unchanged since it was read. With recordRunChange, a job.reinterpreted audit event with a deterministic id (run id, job, change) is recorded when the job changed: a replay records nothing new.',
  },
  async execute(ctx, input, config) {
    const market = ctx.services.get(MARKET);
    const job = await market.jobs.resolveActive(input.jobId);
    const company = await market.companies.resolveActive(job.companyId);
    const { job: j, changed } = await market.jobReconciler.reconcile(job, company);
    const from = job.interpretation.policyVersion;
    const to = j.interpretation.policyVersion;
    if (config.recordRunChange && (changed || from !== to))
      await market.audit.record({
        actor: REINTERPRETATION_ACTOR,
        action: 'job.reinterpreted',
        entity: { kind: 'job', id: j._id },
        runId: ctx.runId,
        idempotencyKey: `run:${ctx.runId}`,
        details: { fromPolicyVersion: from ?? null, toPolicyVersion: to ?? null, contentChanged: changed },
      });
    return {
      jobId: j._id,
      changed,
      conflictFields: j.quality.conflictFields,
      workModel: j.geography.workModel.value,
      sponsorship: j.immigration.sponsorship.value?.status ?? null,
    };
  },
});

/**
 * Re-interpretation backfill, page selection (DECISION_LOG 8d96663 (3)): jobs whose employment
 * `interpretation.policyVersion` is older than the current one, any lifecycle state and source,
 * merged jobs skipped. `market.jobs.reinterpret_outdated` re-reconciles them with
 * `market.reconcile_job` (the `market.job.reinterpret` code).
 */
export const selectOutdatedJobInterpretations = defineCapability({
  type: 'market.select_outdated_job_interpretations',
  version: 1,
  title: 'Select Outdated Job Interpretations',
  description:
    'Returns a keyset page of jobs (any lifecycle state or source; merged skipped) whose employment policy version is older than the current one.',
  category: 'domain',
  inputSchema: z.object({
    after: z.string().default(''),
    limit: z.number().int().min(1).max(5000).default(1000),
  }),
  outputSchema: z.object({
    policyVersion: z.string(),
    jobIds: z.array(z.string()),
    skippedMerged: z.number().int(),
    skippedNewer: z.number().int(),
    nextAfter: z.string().nullable(),
    outdatedTotal: z.number().int(),
  }),
  configSchema: z.object({}),
  execution: { retryable: true, idempotency: 'pure', sideEffects: false, defaultTimeoutMs: 10 * 60_000 },
  async execute(ctx, input) {
    const page = await selectOutdatedInterpretations(ctx.services.get(MARKET).ctx.db, input);
    ctx.log.info('reinterpret backfill: page selected', {
      policyVersion: page.policyVersion,
      selected: page.jobIds.length,
      skippedMerged: page.skippedMerged,
      skippedNewer: page.skippedNewer,
      outdatedTotal: page.outdatedTotal,
      nextAfter: page.nextAfter,
    });
    return page;
  },
});

/** Re-interpretation backfill, page report: the counts, and what is left (re-run until 0). */
export const reportReinterpretBackfill = defineCapability({
  type: 'market.report_reinterpret_backfill',
  version: 1,
  title: 'Report Re-interpretation Backfill',
  description: 'Logs the counts of a re-interpretation backfill page and how many outdated jobs remain.',
  category: 'domain',
  inputSchema: z.object({
    policyVersion: z.string(),
    selected: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
    nextAfter: z.string().nullable(),
  }),
  outputSchema: z.object({
    policyVersion: z.string(),
    selected: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
    remaining: z.number().int(),
    nextAfter: z.string().nullable(),
    done: z.boolean(),
  }),
  configSchema: z.object({}),
  execution: { retryable: true, idempotency: 'pure', sideEffects: false, defaultTimeoutMs: 10 * 60_000 },
  async execute(ctx, input) {
    const outdatedTotal = await countOutdatedInterpretations(ctx.services.get(MARKET).ctx.db);
    const out = { ...input, remaining: outdatedTotal, done: outdatedTotal === 0 };
    ctx.log.info('reinterpret backfill: page done', out);
    return out;
  },
});

/**
 * Re-derive every open job with a copy on a source, page by page (DECISION_LOG 15c965b): run after
 * the source's standing changed, so time-based decay (and the disable's end of negatives) is
 * applied to its jobs now rather than at their next evidence. It resumes from the source's pending
 * marker's cursor and saves it after every page (a retry never restarts from the top), and
 * honours the abort signal (DECISION_LOG 9b0cb03).
 */
export const recomputeSourceJobs = defineCapability({
  type: 'market.recompute_source_jobs',
  version: 1,
  title: 'Recompute Source Jobs',
  description:
    'Re-derives the lifecycle of every open job with a copy on a source (bounded pages, resumable cursor).' +
    ' Changed in place in M6.2 (accepted exception, see streams/market.md): ' +
    'each job it changes gets a job.lifecycle_rederived audit event linked to the run (MR2).',
  category: 'domain',
  inputSchema: z.object({ sourceId: z.string() }),
  outputSchema: z.object({ jobs: z.number().int(), written: z.number().int(), pages: z.number().int() }),
  configSchema: z.object({ pageSize: z.number().int().min(1).max(1000).default(200) }),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      "A recompute is a pure derivation of the evidence written under the job revision fence; re-running it writes nothing new. Progress is a cursor on the source's pending marker (only ever for that marker), so a retry resumes where it stopped. Each job the run changes gets at most one audit event per distinct change, with a deterministic id (run id, job, change): a replay records nothing new.",
  },
  async execute(ctx, input, config) {
    return ctx.services.get(MARKET).recomputeSourceJobs(input.sourceId, {
      pageSize: config.pageSize,
      signal: ctx.signal,
      runId: ctx.runId,
    });
  },
});

/** The time slice of `freshness_sweep` for resuming pending standing recomputes. */
const FRESHNESS_STANDING_BUDGET_MS = 4 * 60_000;
/** The recorded-evidence sweep's time budget, within its node's timeout (`defaultTimeoutMs`). */
const EVIDENCE_SWEEP_BUDGET_MS = 8 * 60_000;

/**
 * Re-derive every job named by evidence recorded since the last pass (DECISION_LOG 9b0cb03,
 * re-verify #11 M-A, #12): its own node of the freshness workflow, with its own time budget; it
 * keeps going while behind, and reports whether it caught up (`complete`) and how far its
 * watermark trails (`lagMs`). One failing job never stops it (retry list, review after 3).
 */
export const sweepRecordedEvidence = defineCapability({
  type: 'market.sweep_recorded_evidence',
  version: 1,
  title: 'Sweep Recorded Evidence',
  description:
    'Re-derives every job (CLOSED ones included) named by job evidence recorded since the last pass; reports its lag.' +
    ' Changed in place in M6.2 (accepted exception, see streams/market.md): ' +
    'each job it changes gets a job.lifecycle_rederived audit event linked to the run (MR2); a recovered job leaves the retry list only once its lifecycle_failure review is dismissed (L1).',
  category: 'domain',
  inputSchema: z.object({}),
  outputSchema: z.object({
    evidence: z.number().int(),
    jobs: z.number().int(),
    written: z.number().int(),
    complete: z.boolean(),
    lagMs: z.number().nullable(),
    retried: z.number().int(),
    failing: z.number().int(),
  }),
  configSchema: z.object({
    budgetMs: z
      .number()
      .int()
      .min(1000)
      .max(9 * 60_000)
      .default(EVIDENCE_SWEEP_BUDGET_MS),
  }),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    defaultTimeoutMs: 10 * 60_000,
    idempotencyProof:
      'Each job is re-derived from its evidence under its revision fence (a pure derivation); the watermark and the retry list only record progress, and the watermark only moves forward. A review after repeated failures uses a per-job dedupe key; its system dismissal has a deterministic operation id. Each job the run changes gets at most one audit event per distinct change, with a deterministic id (run id, job, change): a replay records nothing new.',
  },
  async execute(ctx, _input, config) {
    return ctx.services
      .get(MARKET)
      .evidence.sweepRecordedEvidence({ budgetMs: config.budgetMs, signal: ctx.signal, runId: ctx.runId });
  },
});

/** Determine Employment Intelligence: the domain-owned policy, callable from any workflow (pure). */
export const determineEmploymentIntelligence = defineCapability({
  type: 'market.determine_employment_intelligence',
  version: 1,
  title: 'Determine Employment Intelligence',
  description:
    'Deterministic work model / remote scope / sponsorship / relocation / salary / requirements interpretation.',
  category: 'domain',
  inputSchema: jobInterpretationInputSchema,
  outputSchema: jobInterpretationSchema,
  configSchema: z.object({}),
  execution: { retryable: false, idempotency: 'pure', sideEffects: false },
  async execute(_ctx, input) {
    return interpretJob(input);
  },
});

/**
 * Interpret Job: re-run interpretation for a stored job without persisting (inspection/regression).
 * It is the interpretation `market.reconcile_job` starts from now — the reconciler's primary copy
 * and its `interpretationInput` (M6.4) — before cross-copy conflicts and operator overrides are
 * applied to the canonical facts.
 */
export const interpretStoredJob = defineCapability({
  type: 'market.interpret_job',
  version: 1,
  title: 'Interpret Job',
  description:
    "Interprets a job's primary source copy with the current logic version, as reconciliation does before cross-copy conflicts and overrides (no writes)." +
    ' Changed in place in PR #11 (accepted exception, see streams/market.md): ' +
    'uses the reconciler interpretation input (M6.4).',
  category: 'domain',
  inputSchema: z.object({ jobId: z.string() }),
  outputSchema: jobInterpretationSchema,
  configSchema: z.object({}),
  execution: { retryable: false, idempotency: 'pure', sideEffects: false },
  async execute(ctx, input) {
    const market = ctx.services.get(MARKET);
    const job = await market.jobs.resolveActive(input.jobId);
    const company = await market.companies.resolveActive(job.companyId);
    return (await market.jobReconciler.interpret(job, company)).interpretation;
  },
});

/**
 * Optional AI requirements proposal. Stored on the job as a proposal with full provenance;
 * canonical requirements remain the deterministic extraction (Law H).
 */
export const proposeJobRequirements = defineCapability({
  type: 'market.propose_job_requirements',
  version: 1,
  title: 'Propose Job Requirements (AI)',
  description: 'Schema-validated AI proposal of requirement importance, stored as a non-canonical proposal.',
  category: 'ai',
  inputSchema: z.object({ jobId: z.string() }),
  outputSchema: z.object({ jobId: z.string(), proposed: z.number().int(), model: z.string() }),
  configSchema: z.object({}),
  execution: {
    retryable: true,
    idempotency: 'key',
    sideEffects: true,
    queue: 'ai',
    defaultTimeoutMs: 5 * 60_000,
    idempotencyProof:
      'Proposal id = hash(job, ctx.idempotencyKey): a stored proposal is returned without a model call, the append is guarded on the id, and an AI-operation ledger records repeated (possibly charged) calls.',
  },
  async execute(ctx, input) {
    const market = ctx.services.get(MARKET);
    const ai = ctx.services.get(AI_GATEWAY);
    if (!ai.available) throw new TerminalError('AI provider not configured');
    const job = await market.jobs.resolveActive(input.jobId);
    const res = await market.aiProposals.proposeOnce(
      { jobId: job._id, task: 'market.job_requirements_proposal', idempotencyKey: ctx.idempotencyKey },
      async () => {
        const r = await ai.structuredExtract({
          task: 'market.job_requirements_proposal',
          prompt: JOB_REQUIREMENTS_PROMPT,
          vars: { title: job.identity.title.value ?? '', text: job.content.descriptionText.slice(0, 50_000) },
          schema: jobRequirementsProposalSchema,
          schemaVersion: '1',
          inputRefs: [{ kind: 'observation', id: job.content.primaryObservationId }],
          signal: ctx.signal,
        });
        return { data: r.data, meta: r.meta as unknown as Record<string, unknown> };
      },
    );
    if (res.reused)
      ctx.log.info('reused recorded AI proposal (no model call)', { proposalId: res.proposalId });
    return {
      jobId: job._id,
      proposed: res.data.requirements.length,
      model: String(res.meta.servedByModel ?? ''),
    };
  },
});

export const selectJobsDueVerification = defineCapability({
  type: 'market.select_jobs_due_verification',
  version: 1,
  title: 'Select Jobs Due for Verification',
  description: 'Returns non-closed jobs whose freshness policy says they are due for verification.',
  category: 'domain',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(5000).default(200),
    jobIds: z.array(z.string()).optional(),
  }),
  outputSchema: z.object({ jobIds: z.array(z.string()) }),
  configSchema: z.object({}),
  execution: { retryable: true, idempotency: 'pure', sideEffects: false },
  async execute(ctx, input) {
    if (input.jobIds?.length) return { jobIds: input.jobIds };
    return { jobIds: await ctx.services.get(MARKET).freshness.jobsDueForVerification(input.limit) };
  },
});

export const verifyJob = defineCapability({
  type: 'market.verify_job',
  version: 1,
  title: 'Verify Job',
  description:
    'Re-checks the authoritative source for a job; records evidence; applies lifecycle policy (never closes on one failed fetch).' +
    ' Changed in place in PR #11 (accepted exception, see streams/market.md): ' +
    "verifies on the copy's source endpoint (regional hosts, M6.3; the default host without one, E1); an Ashby not_found needs positive proof of absence on a board that is not a shrink (A-H1, L1).",
  category: 'domain',
  inputSchema: z.object({ jobId: z.string() }),
  outputSchema: z.object({
    jobId: z.string(),
    outcome: z.string(),
    stateBefore: z.string(),
    stateAfter: z.string(),
    detail: z.string(),
  }),
  configSchema: z.object({}),
  execution: {
    retryable: true,
    idempotency: 'key',
    sideEffects: true,
    queue: 'io',
    idempotencyProof:
      'Verification operation id = hash(job, ctx.idempotencyKey): claimed, result persisted, recorded as job evidence keyed by the operation id (once, whatever the replays), the job re-derived from its evidence set under its revision fence, then completed.',
  },
  async execute(ctx, input) {
    const v = await ctx.services.get(MARKET).verification.verify(input.jobId, ctx.services.get(NET_CLIENT), {
      // The node/item idempotency key identifies the logical verification operation.
      operationKey: ctx.idempotencyKey,
      runId: ctx.runId,
      signal: ctx.signal,
    });
    return {
      jobId: v.jobId,
      outcome: v.outcome ?? 'inconclusive',
      stateBefore: v.stateBefore ?? '',
      stateAfter: v.stateAfter ?? '',
      detail: v.detail ?? '',
    };
  },
});

export const freshnessSweep = defineCapability({
  type: 'market.freshness_sweep',
  version: 1,
  title: 'Freshness Sweep',
  description:
    'Marks unconfirmed jobs POSSIBLY_STALE (never closed), reports overdue sources, relays abandoned review resolutions to completion, and resumes standing recomputes left pending (within a time slice).' +
    ' Changed in place in M6.2 (accepted exception, see streams/market.md): ' +
    'each job its stale sweep or resumed standing recomputes change gets a job.lifecycle_rederived audit event linked to the run (MR2).',
  category: 'domain',
  inputSchema: z.object({}),
  outputSchema: z.object({
    checked: z.number().int(),
    markedStale: z.number().int(),
    overdueSources: z.number().int(),
    recoveredReviews: z.number().int().optional(),
    /** Sources whose pending standing recompute this sweep resumed (DECISION_LOG 9b0cb03). */
    resumedStandingRecomputes: z.number().int().optional(),
  }),
  configSchema: z.object({}),
  execution: {
    retryable: true,
    idempotency: 'natural',
    sideEffects: true,
    idempotencyProof:
      'State-based: marks jobs stale only from a live state past the freshness window, via revision CAS; a replay finds them already stale. Review recovery drives durable review operations (generation-fenced, stored decision, idempotent effects and outbox). Standing recomputes resume from their pending marker cursor (pure re-derivations). Each job the run changes gets at most one audit event per distinct change, with a deterministic id (run id, job, change): a replay records nothing new.',
    // Its parts: the stale sweep, the review relay and a standing-resume slice of at most 4 min.
    defaultTimeoutMs: 10 * 60_000,
  },
  async execute(ctx) {
    const market = ctx.services.get(MARKET);
    const sweep = await market.freshness.staleSweep(undefined, ctx.runId);
    const overdue = await market.freshness.overdueSources();
    const { recovered } = await market.reviewService.recoverIncomplete();
    const resumed = await market.resumeStandingRecomputes({
      signal: ctx.signal,
      runId: ctx.runId,
      budgetMs: FRESHNESS_STANDING_BUDGET_MS,
    });
    return {
      ...sweep,
      overdueSources: overdue.length,
      recoveredReviews: recovered,
      resumedStandingRecomputes: resumed,
    };
  },
});
