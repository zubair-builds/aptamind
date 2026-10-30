import type { Filter } from 'mongodb';
import { getCollection } from '@aptamind/db';
import type { MarketContext } from '../context';
import { JobEvidenceService } from '../jobs/evidence.service';
import { DEFAULT_LIFECYCLE_POLICY } from '../jobs/lifecycle';
import { jobsCollection } from '../jobs/job.schema';
import { JobService } from '../jobs/job.service';
import { type SourceDoc, sourcesCollection } from '../sources/source.schema';
import { companiesCollection } from '../companies/company.schema';
import { freshnessPolicy } from './policies';
import { sourceFreshnessFilter } from './source-freshness';

/** A company whose careers discovery ran within this window is not tried again (OPS-1). */
export const CAREERS_RETRY_AFTER_MS = 30 * 24 * 60 * 60_000;

/**
 * Freshness queries and the stale sweep. Staleness is about *confirmation age*, so the sweep
 * only ever moves jobs to POSSIBLY_STALE (and schedules verification) — it never closes.
 */
export class FreshnessService {
  private readonly evidence: JobEvidenceService;

  constructor(
    private readonly ctx: MarketContext,
    evidence?: JobEvidenceService,
  ) {
    this.evidence = evidence ?? new JobEvidenceService(ctx, new JobService(ctx));
  }

  async jobsDueForVerification(limit: number): Promise<string[]> {
    const now = this.ctx.clock.now();
    const docs = await getCollection(this.ctx.db, jobsCollection)
      .find(
        {
          status: 'active',
          'lifecycle.state': { $ne: 'CLOSED' },
          'verification.nextVerificationDueAt': { $lte: now },
        },
        { projection: { _id: 1 } },
      )
      .sort({ 'verification.nextVerificationDueAt': 1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => d._id);
  }

  /**
   * Enabled non-system sources that are overdue or never succeeded (`sourceFreshnessState`),
   * oldest first — an indexed query (`by_freshness`), not a scan of every source.
   */
  async overdueSources() {
    const now = this.ctx.clock.now();
    const col = getCollection(this.ctx.db, sourcesCollection);
    const overdue = await sourceFreshnessFilter(col, ['overdue', 'never_succeeded'], now);
    const sources = await col
      .find({ $and: [overdue, { key: { $not: /^system:/ } }] } as Filter<SourceDoc>, {
        projection: { key: 1, name: 1, freshness: 1, 'health.status': 1, 'health.lastSuccessAt': 1 },
      })
      .sort({ 'health.lastSuccessAt': 1, _id: 1 })
      .toArray();
    return sources.map((s) => ({
      sourceId: s._id,
      key: s.key,
      name: s.name,
      ageMs: s.health.lastSuccessAt ? now.getTime() - s.health.lastSuccessAt.getTime() : null,
      maxAgeMs: s.freshness.maxAgeMinutes * 60_000,
      status: s.health.status,
    }));
  }

  /** v1 selection (`select_companies_for_discovery` v1): never attempted, or older than the careers policy. */
  async companiesDueForCareersDiscovery(limit: number, sponsorCountry?: string): Promise<string[]> {
    const cutoff = new Date(
      this.ctx.clock.now().getTime() - freshnessPolicy('company.careers').refreshEveryMs,
    );
    const filter: Record<string, unknown> = {
      status: 'active',
      $or: [
        { 'freshness.careersDiscoveryStatus': 'not_attempted' },
        { 'freshness.careersCheckedAt': { $lt: cutoff } },
      ],
    };
    if (sponsorCountry) filter['employment.sponsorship.licenceCountries'] = sponsorCountry;
    const docs = await getCollection(this.ctx.db, companiesCollection)
      .find(filter, { projection: { _id: 1 } })
      .sort({ 'freshness.careersCheckedAt': 1, _id: 1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => d._id);
  }

  /** OPS-1 rule: active, with a domain (discovery needs one), never tried or tried before the window. */
  private careersDueFilter(): Record<string, unknown> {
    const cutoff = new Date(this.ctx.clock.now().getTime() - CAREERS_RETRY_AFTER_MS);
    return {
      status: 'active',
      'identity.domain.value': { $type: 'string' },
      // Missing (never tried) or older than the cutoff.
      'freshness.careersCheckedAt': { $not: { $gte: cutoff } },
    };
  }

  /** Companies due under the OPS-1 rule, oldest attempt first (index `by_careers_due_with_domain`). */
  async companiesWithDomainDueForCareers(limit: number, sponsorCountry?: string): Promise<string[]> {
    const filter = this.careersDueFilter();
    if (sponsorCountry) filter['employment.sponsorship.licenceCountries'] = sponsorCountry;
    const docs = await getCollection(this.ctx.db, companiesCollection)
      .find(filter, { projection: { _id: 1 } })
      .sort({ 'freshness.careersCheckedAt': 1, _id: 1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => d._id);
  }

  /** Of `companyIds`, those due under the OPS-1 rule, in input order. */
  async filterDueForCareersDiscovery(companyIds: string[]): Promise<string[]> {
    if (!companyIds.length) return [];
    const docs = await getCollection(this.ctx.db, companiesCollection)
      .find({ _id: { $in: companyIds }, ...this.careersDueFilter() }, { projection: { _id: 1 } })
      .toArray();
    const due = new Set(docs.map((d) => d._id));
    return companyIds.filter((id) => due.has(id));
  }

  /** With `runId`, each job the sweep changes records the run (`job.lifecycle_rederived`, M6.2 MR2). */
  async staleSweep(limit = 5000, runId?: string): Promise<{ checked: number; markedStale: number }> {
    const now = this.ctx.clock.now();
    const cutoff = new Date(now.getTime() - DEFAULT_LIFECYCLE_POLICY.staleAfterMs);
    const col = getCollection(this.ctx.db, jobsCollection);
    const candidates = await col
      .find(
        {
          status: 'active',
          'lifecycle.state': { $in: ['DISCOVERED', 'VERIFIED_LIVE', 'CHANGED', 'REOPENED', 'REPOSTED'] },
          $or: [
            { 'lifecycle.lastVerifiedAt': { $lt: cutoff } },
            { 'lifecycle.lastVerifiedAt': { $exists: false }, 'lifecycle.lastSeenAt': { $lt: cutoff } },
          ],
        },
        { projection: { _id: 1 } },
      )
      .limit(limit)
      .toArray();
    let markedStale = 0;
    for (const job of candidates) {
      // Staleness is derived like every other state (DECISION_LOG 6a01b36): the job is re-derived
      // from its evidence at `now`, under its revision fence.
      const r = await this.evidence.recompute(job._id, { schedule: { kind: 'sweep' } });
      await this.evidence.recordRunChange(runId, r, 'stale_sweep');
      const { before, after } = r;
      if (after.lifecycle.state === 'POSSIBLY_STALE' && before.lifecycle.state !== 'POSSIBLY_STALE')
        markedStale += 1;
    }
    return { checked: candidates.length, markedStale };
  }
}
