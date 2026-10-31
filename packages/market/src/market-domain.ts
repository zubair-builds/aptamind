import type { Db } from 'mongodb';
import { type Actor, ConflictError } from '@aptamind/contracts';
import { ensureCollections } from '@aptamind/db';
import { createServiceToken } from '@aptamind/workflow-sdk';
import { CompanyPipeline } from './companies/company-pipeline';
import { CompanyService } from './companies/company.service';
import { AiProposalService } from './ai/ai-operations';
import { marketCollections } from './collections';
import type { MarketContext, RunLauncher, ScheduleSync } from './context';
import { CompanyChangeSignalWriter } from './signals/company-change-signals';
import { LifecycleSignalWriter } from './signals/lifecycle-signals';
import { RetentionService } from './retention/retention.service';
import { FreshnessService } from './freshness/freshness.service';
import { INTERPRETATION_POLICY_VERSION } from './enrichment/interpret';
import { JobEvidenceService } from './jobs/evidence.service';
import { JobPipeline } from './jobs/job-pipeline';
import { countOutdatedInterpretations } from './jobs/reinterpret-backfill';
import { JobService } from './jobs/job.service';
import { ObservationService } from './observations/observation.service';
import { MarketDashboard } from './queries/dashboard';
import { CompanyReconciler } from './reconciliation/company-reconciler';
import { JobReconciler } from './reconciliation/job-reconciler';
import { AuditLog } from './review/audit';
import { retireLegacyListingReviews } from './review/legacy-reviews';
import { ReviewRepository } from './review/review.repository';
import { type ReviewResolvedHook, ReviewService } from './review/review.service';
import { ReviewTriage } from './review/triage';
import { SourceService } from './sources/source.service';
import { ensureSystemSources } from './system-sources';
import { VerificationService } from './verification/verification.service';

export interface MarketDomainOptions {
  launcher?: RunLauncher;
  schedules?: ScheduleSync;
  onReviewResolved?: ReviewResolvedHook;
}

/**
 * The Market domain: owns business meaning (resolution, reconciliation, lifecycle,
 * employment policy, review). Workflows call into it through capabilities; the API calls
 * into it directly. It depends on the generic runtime only through the narrow
 * `RunLauncher` / `ScheduleSync` ports.
 */
/** Companies per queued careers discovery batch run. */
const CAREERS_QUEUE_CHUNK = 100;

export class MarketDomain {
  readonly audit: AuditLog;
  readonly reviews: ReviewRepository;
  readonly sources: SourceService;
  readonly observations: ObservationService;
  readonly companies: CompanyService;
  readonly companyReconciler: CompanyReconciler;
  readonly companyPipeline: CompanyPipeline;
  readonly jobs: JobService;
  /** The job evidence store; every lifecycle is derived from it (DECISION_LOG 6a01b36). */
  readonly evidence: JobEvidenceService;
  readonly jobReconciler: JobReconciler;
  readonly jobPipeline: JobPipeline;
  readonly verification: VerificationService;
  readonly freshness: FreshnessService;
  readonly retention: RetentionService;
  readonly lifecycleSignals: LifecycleSignalWriter;
  readonly companyChangeSignals: CompanyChangeSignalWriter;
  readonly reviewService: ReviewService;
  readonly reviewTriage: ReviewTriage;
  readonly dashboard: MarketDashboard;
  readonly aiProposals: AiProposalService;
  private readonly launcher?: RunLauncher;

  constructor(
    readonly ctx: MarketContext,
    opts: MarketDomainOptions = {},
  ) {
    this.launcher = opts.launcher;
    this.audit = new AuditLog(ctx);
    this.reviews = new ReviewRepository(ctx);
    this.sources = new SourceService(ctx, this.audit, opts.launcher, opts.schedules);
    this.observations = new ObservationService(ctx);
    this.companies = new CompanyService(ctx, this.audit);
    this.companyReconciler = new CompanyReconciler(ctx, this.companies, this.reviews);
    this.companyPipeline = new CompanyPipeline(
      ctx,
      this.observations,
      this.companies,
      this.companyReconciler,
      this.reviews,
    );
    this.jobs = new JobService(ctx);
    this.evidence = new JobEvidenceService(ctx, this.jobs, this.reviews);
    this.jobReconciler = new JobReconciler(ctx, this.reviews);
    this.jobPipeline = new JobPipeline(
      ctx,
      this.observations,
      this.jobs,
      this.companies,
      this.companyPipeline,
      this.jobReconciler,
      this.reviews,
      this.evidence,
    );
    this.verification = new VerificationService(ctx, this.jobs, this.evidence);
    this.freshness = new FreshnessService(ctx, this.evidence);
    this.retention = new RetentionService(ctx);
    this.lifecycleSignals = new LifecycleSignalWriter(ctx);
    this.companyChangeSignals = new CompanyChangeSignalWriter(ctx);
    this.reviewService = new ReviewService(
      ctx,
      this.reviews,
      this.audit,
      this.companies,
      this.companyReconciler,
      this.jobs,
      this.jobReconciler,
      this.observations,
      this.sources,
      opts.launcher,
      opts.onReviewResolved,
      this.evidence,
    );
    // Stale employment_conflict items are dismissed by the system (DECISION_LOG 8d96663 (4)):
    // deterministic operation id per item, so a re-run resumes or skips.
    this.jobReconciler.closeStaleReviews = async (items) => {
      for (const { id, reason } of items) {
        try {
          await this.reviewService.resolve(id, { action: 'dismiss', reason }, EMPLOYMENT_CONFLICT_CLOSER, {
            operationId: `rop_flag_gone_${id}`,
          });
        } catch (err) {
          ctx.logger.warn(
            { reviewItemId: id, err: (err as Error).message },
            'stale employment_conflict item not closed',
          );
        }
      }
    };
    // A job whose lifecycle re-derivation recovered: its open `lifecycle_failure` review is
    // dismissed by the system (audited, deterministic operation id — a replay resumes or skips).
    // `false` asks the sweep to keep the job on its retry list and try again (M6.2 L1) — also
    // while another resolver (an operator's resolution claim) is deciding the item: that claim is
    // never taken; the dismissal is retried once they finished (then nothing is left open) or
    // released. A stale claim is recovered by `resolve` as always: it completes the OPERATOR's
    // stored decision, never the system's.
    this.evidence.onLifecycleRecovered = async (jobId) => {
      const open = await this.reviews.col.findOne(
        { dedupeKey: `lifecycle_failure:${jobId}`, status: 'open' },
        { projection: { _id: 1 } },
      );
      if (!open) return true;
      try {
        await this.reviewService.resolve(
          open._id,
          { action: 'dismiss', reason: "The job's lifecycle was re-derived successfully." },
          LIFECYCLE_RECOVERY_ACTOR,
          { operationId: `rop_recovered_${open._id}` },
        );
        return true;
      } catch (err) {
        if (err instanceof ConflictError) {
          // Closed by someone else: done. Still open — another resolver (an operator's resolution
          // claim) is deciding it: never taken; retried after they finish or release (review L-2).
          const now = await this.reviews.col.findOne({ _id: open._id }, { projection: { status: 1 } });
          return now?.status !== 'open';
        }
        ctx.logger.warn(
          { jobId, reviewItemId: open._id, err: err instanceof Error ? err.name : 'unknown' },
          'lifecycle_failure review not dismissed after recovery (retried by the next sweep)',
        );
        return false;
      }
    };
    // A standing change re-derives the source's jobs (bounded pages): through a durable run when a
    // launcher is wired (keyed by the change, so a replay starts one run), inline otherwise.
    this.sources.onStandingChanged = async (source, at, actor) => {
      if (opts.launcher)
        await opts.launcher.startRun({
          workflowKey: 'market.source.recompute_jobs',
          input: { sourceId: source._id },
          // Not labelled `sourceId`: this is no acquisition run of the source.
          labels: { standingOfSource: source._id },
          trigger: { kind: 'manual', actor: { kind: actor.kind, id: actor.id } },
          idempotencyKey: `standing:${source._id}:${at.getTime()}`,
        });
      else await this.recomputeSourceJobs(source._id);
    };
    this.reviewTriage = new ReviewTriage(ctx, this.reviews, this.audit);
    this.dashboard = new MarketDashboard(ctx);
    this.aiProposals = new AiProposalService(ctx, this.jobs);
  }

  /**
   * Queue careers discovery for companies an import created or changed (OPS-1). Only companies
   * that are due (a domain, never tried or tried more than 30 days ago) are queued, in batch runs
   * of `CAREERS_QUEUE_CHUNK`. Each run is keyed by `key` and its chunk number, so a retried step
   * starts no second run. Without a launcher (a test host) nothing is queued: the hourly schedule
   * picks the companies up.
   */
  async queueCareersDiscovery(
    companyIds: string[],
    key: string,
  ): Promise<{ due: number; queued: number; runIds: string[] }> {
    const due = await this.freshness.filterDueForCareersDiscovery(companyIds);
    if (!due.length) return { due: 0, queued: 0, runIds: [] };
    if (!this.launcher) {
      this.ctx.logger.info({ due: due.length }, 'careers discovery not queued: no run launcher wired');
      return { due: due.length, queued: 0, runIds: [] };
    }
    const runIds: string[] = [];
    for (let i = 0; i < due.length; i += CAREERS_QUEUE_CHUNK) {
      const chunk = due.slice(i, i + CAREERS_QUEUE_CHUNK);
      const run = await this.launcher.startRun({
        workflowKey: 'market.careers_discovery.batch',
        input: { companyIds: chunk, limit: chunk.length },
        labels: { queuedBy: key },
        trigger: { kind: 'event', event: 'market.import.companies_changed' },
        idempotencyKey: `careers_discovery:${key}:${i / CAREERS_QUEUE_CHUNK}`,
      });
      runIds.push(run._id);
    }
    return { due: due.length, queued: due.length, runIds };
  }

  /**
   * Re-derive every active, not-CLOSED job with a copy on `sourceId` (a standing change never
   * reopens a closure: DECISION_LOG 15c965b), in `_id` pages of `pageSize` (each page one bounded
   * query; `by_source_copy`). With a pending standing marker (DECISION_LOG 9b0cb03 L2/L3) it
   * resumes after the marker's cursor, saves the cursor after each page — so an interrupted run,
   * its retry or the sweep never restarts from the top — and removes the marker when done; a
   * newer change (another `pendingAt`) supersedes it, and this pass stops. Honours `signal`
   * between jobs. Idempotent: a recompute is a pure derivation.
   */
  async recomputeSourceJobs(
    sourceId: string,
    opts: {
      pageSize?: number;
      signal?: AbortSignal;
      /** The run re-deriving: each job it changes records it (`job.lifecycle_rederived`, M6.2 MR2). */
      runId?: string;
    } = {},
  ): Promise<{ jobs: number; written: number; pages: number }> {
    const pageSize = opts.pageSize ?? 200;
    const out = { jobs: 0, written: 0, pages: 0 };
    const sources = this.sources.col;
    const marker = (await sources.findOne({ _id: sourceId }, { projection: { standingRecompute: 1 } }))
      ?.standingRecompute;
    const mine = marker ? { _id: sourceId, 'standingRecompute.pendingAt': marker.pendingAt } : null;
    let after: string | null = marker?.cursor ?? null;
    for (;;) {
      opts.signal?.throwIfAborted();
      const page: Array<{ _id: string }> = await this.jobs.col
        .find(
          {
            'sourceRefs.sourceId': sourceId,
            status: 'active',
            'lifecycle.state': { $ne: 'CLOSED' },
            ...(after ? { _id: { $gt: after } } : {}),
          },
          { projection: { _id: 1 } },
        )
        .sort({ _id: 1 })
        .limit(pageSize)
        .toArray();
      if (!page.length) {
        if (mine) await sources.updateOne(mine, { $unset: { standingRecompute: '' } });
        return out;
      }
      out.pages += 1;
      for (const { _id } of page) {
        opts.signal?.throwIfAborted();
        out.jobs += 1;
        const r = await this.evidence.recompute(_id, { schedule: { kind: 'sweep' } });
        if (r.written) out.written += 1;
        await this.evidence.recordRunChange(opts.runId, r, 'source_standing', { sourceId });
      }
      after = page[page.length - 1]!._id;
      if (
        mine &&
        !(await sources.updateOne(mine, { $set: { 'standingRecompute.cursor': after } })).matchedCount
      )
        return out; // superseded by a newer standing change: its own pass re-derives every job
    }
  }

  /**
   * Resume standing recomputes left pending (a crash after the change, a failed or cancelled
   * run) for longer than `graceMs`, from their cursors — at most `limit` sources per call, within
   * `budgetMs` overall. Each source is isolated (DECISION_LOG 9b0cb03 L-3): it has its own time
   * budget (`perSourceBudgetMs`), and a failure or an exhausted budget is logged and left to a
   * later sweep (its cursor saved), never starving the others. Sources rotate (re-verify #12
   * LOW-4): each attempt is stamped (`standingRecompute.lastAttemptAt`) and the least recently
   * attempted go first, so a source that keeps failing never blocks newer pending ones. Returns
   * the sources completed.
   */
  async resumeStandingRecomputes(
    opts: {
      graceMs?: number;
      limit?: number;
      perSourceBudgetMs?: number;
      budgetMs?: number;
      signal?: AbortSignal;
      /** The sweep's run (recorded on the jobs it changes, M6.2 MR2). */
      runId?: string;
    } = {},
  ): Promise<number> {
    const cutoff = new Date(this.ctx.clock.now().getTime() - (opts.graceMs ?? 15 * 60_000));
    const deadline = Date.now() + (opts.budgetMs ?? 4 * 60_000);
    const pending = await this.sources.col
      .find(
        { 'standingRecompute.pendingAt': { $lte: cutoff } },
        { projection: { _id: 1, 'standingRecompute.pendingAt': 1 } },
      )
      // Never attempted first (a missing field sorts first), then least recently attempted.
      .sort({ 'standingRecompute.lastAttemptAt': 1, 'standingRecompute.pendingAt': 1 })
      .limit(opts.limit ?? 20)
      .toArray();
    let completed = 0;
    for (const { _id, standingRecompute } of pending) {
      opts.signal?.throwIfAborted();
      const left = deadline - Date.now();
      if (left <= 0) break;
      await this.sources.col.updateOne(
        { _id, 'standingRecompute.pendingAt': standingRecompute!.pendingAt },
        { $set: { 'standingRecompute.lastAttemptAt': this.ctx.clock.now() } },
      );
      const budget = AbortSignal.timeout(Math.min(opts.perSourceBudgetMs ?? 60_000, left));
      const signal = opts.signal ? AbortSignal.any([opts.signal, budget]) : budget;
      try {
        await this.recomputeSourceJobs(_id, { signal, runId: opts.runId });
        completed += 1;
      } catch (err) {
        if (opts.signal?.aborted) throw err; // the sweep itself was cancelled
        this.ctx.logger.warn(
          { sourceId: _id, err: err instanceof Error ? err.name : 'unknown' },
          'standing recompute not finished (resumed from its cursor by a later sweep)',
        );
      }
    }
    return completed;
  }

  /** Idempotent: collections, validators, indexes, built-in sources and review migrations. */
  async ensureReady(): Promise<void> {
    await ensureMarketCollections(this.ctx.db);
    await ensureSystemSources(this.sources);
    await retireLegacyListingReviews(this.reviews, this.reviewService, this.ctx.logger);
    const spread = await this.sources.spreadAtsSchedules();
    if (spread)
      this.ctx.logger.info({ sources: spread }, 'Market: ATS board schedules spread across the interval');
    const unrecognised = await this.sources.unrecognisedJobSourceProviders();
    if (unrecognised.length)
      this.ctx.logger.warn(
        { sources: unrecognised.map((s) => ({ id: s._id, key: s.key, provider: s.provider })) },
        'job sources with a provider outside the supported set: their copies are never authoritative (re-register them under a supported provider)',
      );
    await this.warnOutdatedInterpretations();
  }

  /**
   * Startup warning while jobs interpreted under an older policy version remain (DECISION_LOG
   * 3dfe3c5 (4)): the deploy step `market.jobs.reinterpret_outdated` has not finished. An
   * index-only count (`by_policy_version`); never fails startup.
   */
  async warnOutdatedInterpretations(): Promise<number> {
    try {
      const outdated = await countOutdatedInterpretations(this.ctx.db);
      if (outdated > 0)
        this.ctx.logger.warn(
          { outdatedJobs: outdated, policyVersion: INTERPRETATION_POLICY_VERSION },
          'Market: jobs interpreted under an older employment policy remain; run market.jobs.reinterpret_outdated until done (reprocessing runbook, Market deploy)',
        );
      return outdated;
    } catch (err) {
      this.ctx.logger.warn({ err: (err as Error).message }, 'Market: outdated-interpretation count failed');
      return -1;
    }
  }
}

/** The system actor that closes employment_conflict items whose flag is gone (8d96663 (4)). */
export const EMPLOYMENT_CONFLICT_CLOSER = { kind: 'system', id: 'market-employment-conflicts' } as Actor;

export async function ensureMarketCollections(db: Db): Promise<void> {
  await ensureCollections(db, marketCollections);
}

const LIFECYCLE_RECOVERY_ACTOR = { kind: 'system', id: 'market-lifecycle-recovery' } as Actor;

/** Service token through which market capabilities reach the domain. */
export const MARKET = createServiceToken<MarketDomain>('market.domain');

export function createMarketDomain(ctx: MarketContext, opts: MarketDomainOptions = {}): MarketDomain {
  return new MarketDomain(ctx, opts);
}
