import type { ClientSession, Filter, UpdateFilter } from 'mongodb';
import { NotFoundError, type Page } from '@aptamind/contracts';
import { getCollection } from '@aptamind/db';
import type { MarketContext } from '../context';
import type { JobLookup, JobSummary } from '../resolution/job-resolver';
import { escapeRegex } from '../sources/source.service';
import { jobVerificationsCollection } from '../verification/schemas';
import { type JobDoc, jobsCollection, type JobState } from './job.schema';
import { followMergeChain } from '../merge-chain';

/**
 * "Hidden by provider" (ruling U1): every present copy of the job is one its provider hides from
 * the public board (`providerState: 'unlisted'`). Such a job exists but cannot be verified; it
 * decays to POSSIBLY_STALE and is never closed by absence. The job-level flag for the API
 * summary/detail (M7.3) is derived here, never in the UI.
 */
export function isHiddenByProvider(j: Pick<JobDoc, 'sourceRefs'>): boolean {
  const present = j.sourceRefs.filter((r) => r.present);
  return present.length > 0 && present.every((r) => r.providerState === 'unlisted');
}

export function summarizeJob(j: JobDoc): JobSummary {
  return {
    id: j._id,
    companyId: j.companyId,
    state: j.lifecycle.state,
    requisitionId: j.requisitionId,
    titleKey: j.identity.titleKey,
    locationKey: j.geography.locationKey,
    shingles: j.content.shingles,
    sourceIds: [...new Set(j.sourceRefs.map((r) => r.sourceId))],
    presentSourceIds: [...new Set(j.sourceRefs.filter((r) => r.present).map((r) => r.sourceId))],
    distinctFrom: j.distinctFrom,
  };
}

export interface JobListQuery {
  q?: string;
  state?: string;
  companyId?: string;
  workModel?: string;
  remoteScope?: string;
  sponsorship?: string;
  country?: string;
  hasConflicts?: boolean;
  limit: number;
  offset: number;
}

/** Canonical job persistence + lookup port for the resolver + read models. */
export class JobService implements JobLookup {
  constructor(private readonly ctx: MarketContext) {}

  get col() {
    return getCollection(this.ctx.db, jobsCollection);
  }

  async get(id: string): Promise<JobDoc> {
    const j = await this.col.findOne({ _id: id });
    if (!j) throw new NotFoundError('Job', id);
    return j;
  }

  /**
   * Compare-and-set on the job's revision: applies `update` only if nobody wrote the job since
   * `job` was read (plus any extra guard), and bumps the revision. Every read-modify-write of
   * `lifecycle` or `sourceRefs` goes through this, so concurrent writers never lose updates —
   * the loser re-reads and recomputes.
   */
  async casUpdate(
    job: Pick<JobDoc, '_id' | 'rev'>,
    update: UpdateFilter<JobDoc>,
    guard: Filter<JobDoc> = {},
    opts: { session?: ClientSession } = {},
  ): Promise<boolean> {
    const revFilter = revisionFilter(job);
    const res = await this.col.updateOne(
      { _id: job._id, ...revFilter, ...guard } as Filter<JobDoc>,
      { ...update, $inc: { ...((update.$inc as object) ?? {}), rev: 1 } } as UpdateFilter<JobDoc>,
      opts.session ? { session: opts.session } : {},
    );
    return res.matchedCount > 0;
  }

  /**
   * Open jobs with a present copy on `sourceId`: part of the effective listing baseline
   * (`max(listingBaseline.count, this)`) used by the listing guard and the board-derived
   * verification gate (PR #11 ruling on MEDIUM-1).
   */
  countPresentOnSource(sourceId: string): Promise<number> {
    return this.col.countDocuments({
      status: 'active',
      'lifecycle.state': { $ne: 'CLOSED' },
      sourceRefs: { $elemMatch: { sourceId, present: true } },
    });
  }

  /**
   * The latest positive evidence on `sourceId` ITSELF (DECISION_LOG a9af734 M2): its own copies'
   * sightings (skipped entries included) and live verifications whose `sourceId` is this source.
   * A job's sightings or verifications on OTHER sources do not count, so a job cross-posted and
   * live elsewhere cannot keep this source's small-board hold re-armed forever (b7f1a76 re-arm;
   * the empty-board gate). Null when the source has no evidence.
   */
  async lastPositiveEvidenceOnSource(sourceId: string): Promise<Date | null> {
    let latest: Date | null = null;
    const later = (d: Date | undefined | null) => {
      if (d && (!latest || d > latest)) latest = d;
    };
    const cursor = this.col.find(
      { status: 'active', 'sourceRefs.sourceId': sourceId },
      { projection: { sourceRefs: 1 } },
    );
    for await (const j of cursor)
      for (const r of j.sourceRefs) if (r.sourceId === sourceId) later(r.lastSeenAt);
    const [live] = await getCollection(this.ctx.db, jobVerificationsCollection)
      .find({ sourceId, outcome: 'live' }, { projection: { at: 1 } })
      .sort({ at: -1 })
      .limit(1)
      .toArray();
    later(live?.at);
    return latest;
  }

  /**
   * The active survivor of `id` for API reads: follows `mergedInto` (≤ `MERGE_CHAIN_MAX` hops) and
   * throws `MergeChainError` (409) on a cycle, an over-long or a broken chain — never returns a
   * merged record. 404 for an unknown id.
   */
  async resolveSurvivor(id: string): Promise<JobDoc> {
    return followMergeChain('job', await this.get(id), (next) => this.col.findOne({ _id: next }));
  }

  /**
   * Follow merge pointers to the surviving job (domain paths; stops after `MERGE_CHAIN_MAX` hops
   * and may then return a merged record — API reads use `resolveSurvivor`).
   */
  async resolveActive(id: string): Promise<JobDoc> {
    let j = await this.get(id);
    for (let i = 0; i < 10 && j.status === 'merged' && j.mergedInto; i++) j = await this.get(j.mergedInto);
    return j;
  }

  async bySourceKey(key: string): Promise<JobSummary | null> {
    const j = await this.col.findOne({ sourceKeys: key, status: 'active' });
    if (!j) return null;
    return summarizeJob(j.status === 'merged' ? await this.resolveActive(j._id) : j);
  }

  async byUrlFingerprints(fps: string[], companyId: string): Promise<JobSummary[]> {
    return (
      await this.col
        .find({ status: 'active', companyId, urlFingerprints: { $in: fps } })
        .limit(10)
        .toArray()
    ).map(summarizeJob);
  }

  async byRequisition(companyId: string, requisitionId: string): Promise<JobSummary[]> {
    return (await this.col.find({ status: 'active', companyId, requisitionId }).limit(50).toArray()).map(
      summarizeJob,
    );
  }

  async byCompanyTitle(companyId: string, titleKey: string): Promise<JobSummary[]> {
    return (
      await this.col.find({ status: 'active', companyId, 'identity.titleKey': titleKey }).limit(50).toArray()
    ).map(summarizeJob);
  }

  async list(q: JobListQuery): Promise<Page<JobDoc>> {
    const filter: Filter<JobDoc> = { status: 'active' };
    if (q.q) filter['identity.normalizedTitle'] = { $regex: escapeRegex(q.q.toLowerCase()) };
    if (q.state) filter['lifecycle.state'] = q.state as JobState;
    if (q.companyId) filter.companyId = q.companyId;
    if (q.workModel) filter['geography.workModel.value'] = q.workModel as never;
    if (q.remoteScope) filter['geography.remoteScope.value.type'] = q.remoteScope as never;
    if (q.sponsorship) filter['immigration.sponsorship.value.status'] = q.sponsorship as never;
    if (q.country)
      filter.$or = [
        { 'geography.normalizedLocations.country': q.country },
        { 'geography.remoteScope.value.countries': q.country },
      ];
    if (q.hasConflicts) filter['quality.conflictFields.0'] = { $exists: true };
    const [items, total] = await Promise.all([
      this.col
        .find(filter, { projection: { 'content.descriptionText': 0, 'content.shingles': 0 } })
        .sort({ 'lifecycle.lastSeenAt': -1 })
        .skip(q.offset)
        .limit(q.limit)
        .toArray(),
      this.col.countDocuments(filter),
    ]);
    return { items, total, limit: q.limit, offset: q.offset };
  }
}

/** Matches the exact revision read (a missing revision is revision 0). */
export function revisionFilter(job: Pick<JobDoc, 'rev'>): Filter<JobDoc> {
  return (job.rev ? { rev: job.rev } : { rev: { $in: [0, null] } }) as Filter<JobDoc>;
}
