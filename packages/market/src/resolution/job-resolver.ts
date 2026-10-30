import { jaccard } from '../jobs/fingerprint';
import type { JobState } from '../jobs/job.schema';

/**
 * Deterministic job entity resolution (context §12.2, FR-14).
 *
 * Distinguishes: same source record, syndicated copy (same job on another source), same
 * requisition in another location (distinct job), repost of a closed job, materially similar
 * but uncertain (new job + review), and distinct jobs.
 */

export const JOB_RESOLVER_VERSION = 'job-resolver/1';
export const SYNDICATION_SIMILARITY = 0.8;
export const POSSIBLE_DUPLICATE_SIMILARITY = 0.5;

export interface JobCandidate {
  sourceId: string;
  sourceKey: string;
  companyId: string;
  requisitionId: string | null;
  titleKey: string;
  locationKey: string;
  urlFingerprints: string[];
  shingles: number[];
}

export interface JobSummary {
  id: string;
  companyId: string;
  state: JobState;
  requisitionId: string | null;
  titleKey: string;
  locationKey: string;
  shingles: number[];
  sourceIds: string[];
  presentSourceIds: string[];
  distinctFrom: string[];
}

export interface JobLookup {
  bySourceKey(key: string): Promise<JobSummary | null>;
  byUrlFingerprints(fps: string[], companyId: string): Promise<JobSummary[]>;
  byRequisition(companyId: string, requisitionId: string): Promise<JobSummary[]>;
  byCompanyTitle(companyId: string, titleKey: string): Promise<JobSummary[]>;
}

export type JobResolutionDecision =
  | {
      kind: 'existing';
      jobId: string;
      relation: 'same_source' | 'syndicated' | 'same_requisition' | 'repost';
      method: string;
      similarity?: number;
    }
  | {
      kind: 'new';
      reason: string;
      possibleDuplicate?: { jobId: string; similarity: number };
      relatedJobIds: string[];
    };

const sameLocation = (a: string, b: string) => !a || !b || a === b;

export async function resolveJobCandidate(
  c: JobCandidate,
  lookup: JobLookup,
): Promise<JobResolutionDecision> {
  const own = await lookup.bySourceKey(c.sourceKey);
  if (own) return { kind: 'existing', jobId: own.id, relation: 'same_source', method: 'source_key' };

  if (c.urlFingerprints.length) {
    const byUrl = (await lookup.byUrlFingerprints(c.urlFingerprints, c.companyId)).filter(
      (j) => !j.presentSourceIds.includes(c.sourceId),
    );
    const hit = byUrl[0];
    if (hit) return { kind: 'existing', jobId: hit.id, relation: 'syndicated', method: 'url_fingerprint' };
  }

  const related: string[] = [];
  if (c.requisitionId) {
    const sameReq = await lookup.byRequisition(c.companyId, c.requisitionId);
    const hit = sameReq.find(
      (j) => sameLocation(j.locationKey, c.locationKey) && !j.presentSourceIds.includes(c.sourceId),
    );
    if (hit)
      return {
        kind: 'existing',
        jobId: hit.id,
        relation: hit.state === 'CLOSED' ? 'repost' : 'same_requisition',
        method: 'requisition_id',
      };
    related.push(...sameReq.map((j) => j.id)); // same requisition, different location → distinct sibling jobs
  }

  const similar = await lookup.byCompanyTitle(c.companyId, c.titleKey);
  let best: { job: JobSummary; sim: number } | null = null;
  for (const j of similar) {
    if (!sameLocation(j.locationKey, c.locationKey)) continue;
    // Two different live postings on the same board are distinct openings, not duplicates.
    if (j.presentSourceIds.includes(c.sourceId) && j.state !== 'CLOSED') continue;
    const sim = jaccard(c.shingles, j.shingles);
    if (!best || sim > best.sim) best = { job: j, sim };
  }
  if (best && best.sim >= SYNDICATION_SIMILARITY) {
    return {
      kind: 'existing',
      jobId: best.job.id,
      relation: best.job.state === 'CLOSED' ? 'repost' : 'syndicated',
      method: 'title_location_description',
      similarity: best.sim,
    };
  }
  if (best && best.sim >= POSSIBLE_DUPLICATE_SIMILARITY) {
    return {
      kind: 'new',
      reason: 'similar posting exists; uncertain duplicate',
      possibleDuplicate: { jobId: best.job.id, similarity: best.sim },
      relatedJobIds: related,
    };
  }
  return {
    kind: 'new',
    reason: related.length ? 'same requisition, different location' : 'no matching job',
    relatedJobIds: related,
  };
}
