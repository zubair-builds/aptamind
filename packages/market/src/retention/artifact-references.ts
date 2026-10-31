import type { Db } from 'mongodb';
import { getCollection } from '@aptamind/db';
import { companiesCollection } from '../companies/company.schema';
import { importsCollection } from '../imports/import.schema';
import { jobEvidenceCollection } from '../jobs/evidence';
import { jobsCollection } from '../jobs/job.schema';
import {
  companyObservationsCollection,
  jobObservationsCollection,
  type RETENTION_HOLD_REASONS,
  snapshotsCollection,
} from '../observations/schemas';
import { auditEventsCollection, reviewItemsCollection } from '../review/schemas';
import { signalsCollection } from '../signals/schemas';
import { jobVerificationsCollection } from '../verification/schemas';

/**
 * Why a snapshot is still needed, or null when the sweep may release it.
 * Order matches `RETENTION_HOLD_REASONS`. The sweep (`RetentionService.holdReason`) and the
 * FE-4 purge both use this, so a citation that holds a snapshot also holds its bytes.
 */
export async function snapshotHoldReason(
  db: Db,
  s: { _id: string; sourceId: string },
): Promise<(typeof RETENTION_HOLD_REASONS)[number] | null> {
  const latest = await getCollection(db, snapshotsCollection)
    .find({ sourceId: s.sourceId }, { projection: { _id: 1 } })
    .sort({ lastFetchedAt: -1, _id: -1 })
    .limit(1)
    .next();
  if (latest?._id === s._id) return 'latest_of_source';
  if (
    await found(db, reviewItemsCollection.name, {
      'evidence.snapshotId': s._id,
      status: 'open',
    })
  )
    return 'open_review';
  const current = { snapshotId: s._id, superseded: { $ne: true } };
  if (
    (await found(db, companyObservationsCollection.name, current)) ||
    (await found(db, jobObservationsCollection.name, current))
  )
    return 'current_observation';
  if (await found(db, jobEvidenceCollection.name, { snapshotId: s._id })) return 'job_evidence';
  if (await found(db, signalsCollection.name, { 'evidence.snapshotId': s._id })) return 'signal_evidence';
  if (await citedByCanonicalFact(db, s._id)) return 'canonical_fact';
  return null;
}

/**
 * Whether a market document still needs an artifact's bytes (FE-4).
 *
 * The reference count is every `market_snapshots` row with that artifact id: all must carry
 * `expiredAt` and none may be pinned. Content-addressed bytes are shared across sources, so
 * one live snapshot keeps the object for every source. Each of those snapshots is then passed
 * through `snapshotHoldReason`. Any hold keeps the bytes, including when `expiredAt` is still
 * set because a release has not been reverted yet: latest of source, open review, current
 * observation, job evidence, signal evidence, canonical fact.
 *
 * Any other stored artifact id also keeps the bytes, so a pointer is not left dangling:
 * open review evidence and `context.reportArtifactId`; company and job observations; imports;
 * job verifications (the raw check body); job `content.descriptionArtifactId` and fact
 * evidence; company fact, licence and history evidence; signal evidence; audit
 * `details.boardArtifactId` (the board-liveness fetch recorded at company creation).
 * A closed review does not keep bytes. Job evidence, signal evidence and canonical facts cite
 * `snapshotId`; `snapshotHoldReason` covers those the same way the sweep does.
 *
 * Returns a short reason, or null when the bytes may be deleted.
 */
export async function artifactReferenceHold(db: Db, artifactId: string): Promise<string | null> {
  const snaps = await getCollection(db, snapshotsCollection)
    .find(
      { 'artifact.artifactId': artifactId },
      { projection: { _id: 1, sourceId: 1, expiredAt: 1, pinned: 1 } },
    )
    .toArray();
  for (const s of snaps) {
    if (!s.expiredAt) return 'snapshot_unreleased';
    if (s.pinned) return 'snapshot_pinned';
  }
  // Re-read every hold reason on the released snapshots. The sweep may still be reverting a
  // release, or a job-evidence, signal, or canonical-fact citation may have landed while
  // `expiredAt` is set. Either blocks the byte delete.
  for (const s of snaps) {
    const reason = await snapshotHoldReason(db, s);
    if (reason) return reason;
  }
  if (
    await found(db, reviewItemsCollection.name, {
      status: 'open',
      $or: [{ 'evidence.artifactId': artifactId }, { 'context.reportArtifactId': artifactId }],
    })
  )
    return 'open_review';
  if (await found(db, companyObservationsCollection.name, { artifactId })) return 'company_observation';
  if (await found(db, jobObservationsCollection.name, { artifactId })) return 'job_observation';
  if (await found(db, importsCollection.name, { artifactId })) return 'import';
  if (await found(db, jobVerificationsCollection.name, { artifactId })) return 'job_verification';
  if (await found(db, jobsCollection.name, { $or: paths(artifactId, JOB_PATHS) })) return 'job';
  if (await found(db, companiesCollection.name, { $or: paths(artifactId, COMPANY_PATHS) })) return 'company';
  if (await found(db, signalsCollection.name, { 'evidence.artifactId': artifactId })) return 'signal';
  if (await found(db, auditEventsCollection.name, { 'details.boardArtifactId': artifactId }))
    return 'board_liveness';
  return null;
}

const JOB_FACT_PREFIXES = [
  'identity.title',
  'identity.roleFamily',
  'identity.specialization',
  'identity.department',
  'identity.seniority',
  'employment.employmentType',
  'geography.workModel',
  'geography.remoteScope',
  'geography.officeAttendance',
  'immigration.sponsorship',
  'immigration.authorization',
  'immigration.relocation',
  'compensation',
  'requirements',
  'responsibilities',
] as const;

const COMPANY_FACT_PREFIXES = [
  'identity.displayName',
  'identity.legalName',
  'identity.domain',
  'identity.website',
  'classification.industries',
  'classification.stage',
  'classification.businessModel',
  'firmographics.foundedYear',
  'firmographics.employeeEstimate',
  'firmographics.employeeRange',
  'firmographics.fundingStage',
  'geography.headquarters',
  'geography.hiringCountries',
  'employment.careersUrls',
  'employment.ats',
  'employment.remotePolicy',
  'employment.sponsorship.capability',
  'employment.relocationSupport',
  'employment.eorIndicators',
] as const;

/** Evidence arrays that are not facts (no `conflicts`). */
const COMPANY_EVIDENCE_PREFIXES = [
  'classification.schemes',
  'employment.sponsorship.licences',
  'employment.sponsorship.history',
  'organization.founders',
  'organization.leadership',
] as const;

const JOB_PATHS = ['content.descriptionArtifactId', ...factPaths(JOB_FACT_PREFIXES, true)];
const COMPANY_PATHS = [
  'descriptionArtifactId',
  ...factPaths(COMPANY_FACT_PREFIXES, true),
  ...factPaths(COMPANY_EVIDENCE_PREFIXES, false),
];

function factPaths(prefixes: readonly string[], conflicts: boolean): string[] {
  const out: string[] = [];
  for (const p of prefixes) {
    out.push(`${p}.evidence.artifactId`);
    if (conflicts) out.push(`${p}.conflicts.evidence.artifactId`);
  }
  return out;
}

function paths(artifactId: string, fields: readonly string[]): Array<Record<string, string>> {
  return fields.map((field) => ({ [field]: artifactId }));
}

function snapshotClauses(
  prefixes: readonly string[],
  snapshotId: string,
  conflicts: boolean,
): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  for (const p of prefixes) {
    out.push({ [`${p}.evidence.snapshotId`]: snapshotId });
    if (conflicts) out.push({ [`${p}.conflicts.evidence.snapshotId`]: snapshotId });
  }
  return out;
}

/** Company or job fact evidence, or a legacy job listing mark, names this snapshot. */
async function citedByCanonicalFact(db: Db, snapshotId: string): Promise<boolean> {
  const company = await getCollection(db, companiesCollection).findOne(
    {
      $or: [
        ...snapshotClauses(COMPANY_FACT_PREFIXES, snapshotId, true),
        ...snapshotClauses(COMPANY_EVIDENCE_PREFIXES, snapshotId, false),
      ],
    },
    { projection: { _id: 1 } },
  );
  if (company) return true;
  const job = await getCollection(db, jobsCollection).findOne(
    {
      $or: [...snapshotClauses(JOB_FACT_PREFIXES, snapshotId, true), { $expr: listingMarkCites(snapshotId) }],
    },
    { projection: { _id: 1 } },
  );
  return job != null;
}

/** True when any legacy `lifecycle.listingMarks` value names this snapshot. */
function listingMarkCites(snapshotId: string) {
  return {
    $gt: [
      {
        $size: {
          $filter: {
            input: { $objectToArray: { $ifNull: ['$lifecycle.listingMarks', {}] } },
            as: 'm',
            cond: { $eq: ['$$m.v.snapshotId', snapshotId] },
          },
        },
      },
      0,
    ],
  };
}

async function found(db: Db, name: string, filter: Record<string, unknown>): Promise<boolean> {
  const doc = await db.collection(name).findOne(filter, { projection: { _id: 1 } });
  return doc != null;
}
