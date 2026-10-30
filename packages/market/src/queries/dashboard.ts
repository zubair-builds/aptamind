import { getCollection } from '@aptamind/db';
import { companiesCollection } from '../companies/company.schema';
import type { MarketContext } from '../context';
import { jobsCollection } from '../jobs/job.schema';
import { companyObservationsCollection, jobObservationsCollection } from '../observations/schemas';
import { reviewItemsCollection } from '../review/schemas';
import { sourcesCollection } from '../sources/source.schema';
import { jobVerificationsCollection } from '../verification/schemas';

const count = (rows: Array<{ _id: string | null; n: number }>) =>
  Object.fromEntries(rows.map((r) => [r._id ?? 'unknown', r.n]));

/**
 * Operational + data-quality read models (FR-25, PRD §12 Dashboard, §15 metrics).
 */
export class MarketDashboard {
  constructor(private readonly ctx: MarketContext) {}

  async summary(windowMs = 24 * 3600_000) {
    const db = this.ctx.db;
    const since = new Date(this.ctx.clock.now().getTime() - windowMs);
    const sources = getCollection(db, sourcesCollection);
    const companies = getCollection(db, companiesCollection);
    const jobs = getCollection(db, jobsCollection);
    const reviews = getCollection(db, reviewItemsCollection);
    const [
      sourceHealth,
      failingSources,
      jobStates,
      reviewByType,
      oldestReview,
      companiesTotal,
      companiesCreated,
      companiesChanged,
      jobsCreated,
      jobsChanged,
      jobsClosed,
    ] = await Promise.all([
      sources
        .aggregate<{ _id: string; n: number }>([
          { $match: { key: { $not: /^system:/ } } },
          { $group: { _id: '$health.status', n: { $sum: 1 } } },
        ])
        .toArray(),
      sources
        .find(
          { 'health.status': { $in: ['failing', 'degraded'] } },
          { projection: { key: 1, name: 1, health: 1 } },
        )
        .sort({ 'health.lastFailureAt': -1 })
        .limit(10)
        .toArray(),
      jobs
        .aggregate<{ _id: string; n: number }>([
          { $match: { status: 'active' } },
          { $group: { _id: '$lifecycle.state', n: { $sum: 1 } } },
        ])
        .toArray(),
      reviews
        .aggregate<{ _id: string; n: number }>([
          { $match: { status: 'open' } },
          { $group: { _id: '$type', n: { $sum: 1 } } },
        ])
        .toArray(),
      reviews.find({ status: 'open' }).sort({ createdAt: 1 }).limit(1).next(),
      companies.countDocuments({ status: 'active' }),
      companies.countDocuments({ status: 'active', createdAt: { $gte: since } }),
      companies.countDocuments({ status: 'active', 'freshness.lastChangedAt': { $gte: since } }),
      jobs.countDocuments({ status: 'active', createdAt: { $gte: since } }),
      jobs.countDocuments({ status: 'active', 'lifecycle.lastChangedAt': { $gte: since } }),
      jobs.countDocuments({ status: 'active', 'lifecycle.closedAt': { $gte: since } }),
    ]);
    return {
      window: { since, ms: windowMs },
      sources: { byHealth: count(sourceHealth), failing: failingSources },
      companies: { total: companiesTotal, created: companiesCreated, changed: companiesChanged },
      jobs: { byState: count(jobStates), created: jobsCreated, changed: jobsChanged, closed: jobsClosed },
      review: {
        openByType: count(reviewByType),
        open: reviewByType.reduce((a, r) => a + r.n, 0),
        oldestOpenAgeMs: oldestReview
          ? this.ctx.clock.now().getTime() - oldestReview.createdAt.getTime()
          : null,
      },
    };
  }

  /** Intelligence/data-quality metrics (context §22.2). */
  async dataQuality(windowMs = 7 * 24 * 3600_000) {
    const db = this.ctx.db;
    const since = new Date(this.ctx.clock.now().getTime() - windowMs);
    const cobs = getCollection(db, companyObservationsCollection);
    const jobs = getCollection(db, jobsCollection);
    const reviews = getCollection(db, reviewItemsCollection);
    const [
      companyRes,
      jobRes,
      workModel,
      remoteScope,
      sponsorship,
      salary,
      confidence,
      verifications,
      reviewOutcomes,
      dupReviews,
      liveJobs,
      staleJobs,
      companies,
      merged,
      lag,
    ] = await Promise.all([
      cobs
        .aggregate<{ _id: string; n: number }>([{ $group: { _id: '$resolution.state', n: { $sum: 1 } } }])
        .toArray(),
      getCollection(db, jobObservationsCollection)
        .aggregate<{ _id: string; n: number }>([{ $group: { _id: '$resolution.state', n: { $sum: 1 } } }])
        .toArray(),
      jobs
        .aggregate<{ _id: string; n: number }>([
          { $match: { status: 'active' } },
          { $group: { _id: '$geography.workModel.value', n: { $sum: 1 } } },
        ])
        .toArray(),
      jobs
        .aggregate<{ _id: string; n: number }>([
          { $match: { status: 'active' } },
          { $group: { _id: '$geography.remoteScope.value.type', n: { $sum: 1 } } },
        ])
        .toArray(),
      jobs
        .aggregate<{ _id: string; n: number }>([
          { $match: { status: 'active' } },
          { $group: { _id: '$immigration.sponsorship.value.status', n: { $sum: 1 } } },
        ])
        .toArray(),
      jobs
        .aggregate<{ _id: string; n: number }>([
          { $match: { status: 'active' } },
          { $group: { _id: '$compensation.value.status', n: { $sum: 1 } } },
        ])
        .toArray(),
      jobs
        .aggregate<{ _id: string; n: number }>([
          { $match: { status: 'active' } },
          { $group: { _id: '$geography.workModel.confidence.level', n: { $sum: 1 } } },
        ])
        .toArray(),
      getCollection(db, jobVerificationsCollection)
        .aggregate<{ _id: string; n: number }>([
          { $match: { at: { $gte: since } } },
          { $group: { _id: '$outcome', n: { $sum: 1 } } },
        ])
        .toArray(),
      reviews
        .aggregate<{ _id: string; n: number }>([
          { $match: { status: { $ne: 'open' }, updatedAt: { $gte: since } } },
          { $group: { _id: '$resolution.action', n: { $sum: 1 } } },
        ])
        .toArray(),
      reviews
        .aggregate<{ _id: string; n: number }>([
          { $match: { type: { $in: ['company_duplicate', 'job_duplicate'] } } },
          { $group: { _id: '$type', n: { $sum: 1 } } },
        ])
        .toArray(),
      jobs.countDocuments({
        status: 'active',
        'lifecycle.state': { $in: ['VERIFIED_LIVE', 'CHANGED', 'REOPENED', 'REPOSTED'] },
      }),
      jobs.countDocuments({ status: 'active', 'lifecycle.state': 'POSSIBLY_STALE' }),
      getCollection(db, companiesCollection).countDocuments({ status: 'active' }),
      getCollection(db, companiesCollection).countDocuments({ status: 'merged' }),
      cobs
        .aggregate<{ avg: number }>([
          { $match: { 'resolution.resolvedAt': { $exists: true }, createdAt: { $gte: since } } },
          { $group: { _id: null, avg: { $avg: { $subtract: ['$resolution.resolvedAt', '$createdAt'] } } } },
        ])
        .next(),
    ]);
    const totalCompanyObs = companyRes.reduce((a, r) => a + r.n, 0);
    const unresolvedCompanyObs = companyRes.filter((r) => r._id !== 'resolved').reduce((a, r) => a + r.n, 0);
    const corrections = reviewOutcomes
      .filter((r) => ['correct', 'merge', 'create_new'].includes(r._id))
      .reduce((a, r) => a + r.n, 0);
    const decided = reviewOutcomes.reduce((a, r) => a + r.n, 0);
    const activeJobs = liveJobs + staleJobs;
    return {
      window: { since, ms: windowMs },
      entityQuality: {
        companyObservationResolution: count(companyRes),
        unresolvedCompanyRate: totalCompanyObs ? unresolvedCompanyObs / totalCompanyObs : null,
        jobObservationResolution: count(jobRes),
        duplicateReviews: count(dupReviews),
        mergedCompanies: merged,
        duplicateCompanyRate: companies + merged ? merged / (companies + merged) : null,
        observationToCanonicalLagMs: lag?.avg ?? null,
      },
      jobQuality: {
        verifiedLiveRate: activeJobs ? liveJobs / activeJobs : null,
        staleRate: activeJobs ? staleJobs / activeJobs : null,
        verificationsByOutcome: count(verifications),
      },
      intelligence: {
        workModel: count(workModel),
        remoteScope: count(remoteScope),
        sponsorship: count(sponsorship),
        salaryStatus: count(salary),
        workModelConfidence: count(confidence),
      },
      review: {
        decisionsByAction: count(reviewOutcomes),
        correctionRate: decided ? corrections / decided : null,
      },
    };
  }
}
