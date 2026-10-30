import { z } from 'zod';
import { artifactRefSchema } from '@aptamind/contracts';
import { defineCollection } from '@aptamind/db';
import { companyObservationPayloadSchema, jobObservationPayloadSchema } from '../contracts/observations';
import { copyBoardSchema } from '../jobs/job.schema';
import { RETENTION_CLASSES } from '../retention/policy';

export const OBSERVATION_SCHEMA_VERSION = 1;

/** Why a retention sweep kept a snapshot. Order is the order `holdReason` checks them. */
export const RETENTION_HOLD_REASONS = [
  'latest_of_source',
  'open_review',
  'current_observation',
  'job_evidence',
  'signal_evidence',
  'canonical_fact',
] as const;

/**
 * Raw snapshot: what a source returned at a point in time. Content-addressed per source:
 * fetching identical bytes again records another fetch on the same snapshot.
 */
export const snapshotDocSchema = z.object({
  _id: z.string(),
  sourceId: z.string(),
  artifact: artifactRefSchema,
  contentHash: z.string(),
  url: z.string().optional(),
  httpStatus: z.number().int().optional(),
  contentType: z.string().optional(),
  firstFetchedAt: z.date(),
  lastFetchedAt: z.date(),
  /** Distinct fetch operations (runs) that produced these bytes. */
  fetchCount: z.number().int().min(0),
  runIds: z.array(z.string()),
  /** How it was acquired: fetch, browser, manual upload, reprocess. */
  via: z.enum(['http', 'browser', 'upload', 'crawl']),
  itemCount: z.number().int().optional(),
  /**
   * The board its latest fetch read (the source endpoint when that fetch STARTED; for an upload,
   * the source endpoint at upload). Reprocessing the snapshot records its evidence on this board
   * (DECISION_LOG 6a01b36); absent on snapshots stored before it existed (the board is unknown).
   */
  fetchBoard: copyBoardSchema.nullable().optional(),
  /**
   * An uploaded snapshot: the run whose processing was its acquisition (the first one). Any other
   * run processing it is a reprocess, which never changes source health (re-verify #9 Low 4).
   */
  acquisitionRunId: z.string().optional(),
  /**
   * Retention (OPS-3, DECISION_LOG 2026-10-01 O "Artifact retention"). Optional for snapshots
   * stored before it existed: the sweep backfills them. `pinned` snapshots never expire.
   * `expiredAt` marks the snapshot's raw bytes as released (eligible for deletion); the record
   * itself stays as history. Byte deletion needs an ArtifactStore delete (Foundation Exception).
   */
  retentionClass: z.enum(RETENTION_CLASSES).optional(),
  expiresAt: z.date().optional(),
  pinned: z.boolean().optional(),
  pinnedReason: z.string().optional(),
  expiredAt: z.date().optional(),
  /** The last sweep that found the snapshot still referenced, and why. */
  retentionHold: z.object({ at: z.date(), reason: z.enum(RETENTION_HOLD_REASONS) }).optional(),
  schemaVersion: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type SnapshotDoc = z.infer<typeof snapshotDocSchema>;

export const snapshotsCollection = defineCollection<SnapshotDoc>({
  name: 'market_snapshots',
  description: 'Immutable raw source snapshots (bytes in object storage).',
  schema: snapshotDocSchema,
  schemaVersion: OBSERVATION_SCHEMA_VERSION,
  indexes: [
    {
      key: { sourceId: 1, contentHash: 1 },
      options: { name: 'uniq_source_hash', unique: true },
      rationale: 'Content addressing per source; retries do not duplicate snapshots.',
    },
    {
      key: { sourceId: 1, lastFetchedAt: -1, _id: -1 },
      options: { name: 'by_source_recent' },
      rationale:
        'Latest snapshots of a source; keyset-paginated `GET /api/sources/:id/snapshots` (`_id` tiebreak).',
    },
    {
      // A partial filter cannot say "expiredAt is absent": `$exists: false` is rejected in
      // partialFilterExpression. A plain index still serves `{ expiresAt: { $lte } }` sorted by
      // expiresAt; the sweep filters `pinned` and missing `expiredAt` itself.
      key: { expiresAt: 1 },
      options: { name: 'by_expires' },
      rationale:
        'OPS-3 retention sweep: snapshots due by expiresAt. Not partial — MongoDB partial indexes do not allow `$exists: false` for "expiredAt absent".',
    },
  ],
});

const resolutionSchema = z.object({
  state: z.enum(['pending', 'resolved', 'review', 'rejected', 'failed']),
  entityId: z.string().optional(),
  method: z.string().optional(),
  confidence: z.enum(['high', 'medium', 'low', 'unknown']).optional(),
  reviewItemId: z.string().optional(),
  resolvedAt: z.date().optional(),
  error: z.string().optional(),
  resolverVersion: z.string().optional(),
});
export type ObservationResolution = z.infer<typeof resolutionSchema>;

const observationBase = {
  _id: z.string(),
  sourceId: z.string(),
  snapshotId: z.string().optional(),
  artifactId: z.string().optional(),
  /** Where inside the snapshot this observation came from (JSON pointer, CSV row, URL). */
  locator: z.string().optional(),
  externalId: z.string().optional(),
  /** Hash of the payload; content never changes after insert. */
  contentHash: z.string(),
  /** Processing time of the first time Aptamind recorded this content. */
  firstObservedAt: z.date(),
  /** Processing time of the last time Aptamind (re)processed this content — replays move it. */
  lastObservedAt: z.date(),
  /**
   * SOURCE chronology: when the source was (last) fetched and found to contain this content —
   * the fetch time of the snapshot it came from (or the recording time when there is no
   * snapshot). Reprocessing an old snapshot reuses that snapshot's fetch time, so it can never
   * make old content newer than content from a later fetch; only a genuinely later fetch of the
   * same content moves it forward (`$max`). Supersession and fact recency use this, never
   * processing time. Optional for documents written before it existed (fall back to
   * `lastObservedAt`).
   */
  sourceObservedAt: z.date().optional(),
  /** Distinct runs that observed this record (replays within a run do not count). */
  seenCount: z.number().int().positive(),
  seenRunIds: z.array(z.string()).optional(),
  /**
   * A newer observation of the same source record (sourceId + externalId, or locator) exists.
   * Superseded observations stay stored as history/evidence; reconciliation reads current ones.
   */
  superseded: z.boolean().optional(),
  parser: z.object({ name: z.string(), version: z.string() }),
  ai: z.object({ provider: z.string(), model: z.string(), promptVersion: z.string() }).optional(),
  warnings: z.array(z.string()).default([]),
  resolution: resolutionSchema,
  runId: z.string().optional(),
  schemaVersion: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
};

export const companyObservationDocSchema = z.object({
  ...observationBase,
  payload: companyObservationPayloadSchema,
});
export type CompanyObservationDoc = z.infer<typeof companyObservationDocSchema>;

export const jobObservationDocSchema = z.object({ ...observationBase, payload: jobObservationPayloadSchema });
export type JobObservationDoc = z.infer<typeof jobObservationDocSchema>;

export const companyObservationsCollection = defineCollection<CompanyObservationDoc>({
  name: 'market_company_observations',
  description: 'Append-only statements a source made about a company.',
  schema: companyObservationDocSchema,
  schemaVersion: OBSERVATION_SCHEMA_VERSION,
  indexes: [
    {
      key: { 'resolution.entityId': 1, lastObservedAt: -1, _id: -1 },
      options: { name: 'by_company_recent', sparse: true },
      rationale:
        "A company's observation history, newest first (`GET /api/companies/:id/observations`, keyset `_id` tiebreak).",
    },
    {
      key: { 'resolution.entityId': 1, 'resolution.state': 1, superseded: 1 },
      options: { name: 'by_company_current' },
      rationale:
        'Reconcile a company from the current observation of each source record (bounded by records, not history).',
    },
    {
      key: { sourceId: 1, locator: 1, sourceObservedAt: -1 },
      options: { name: 'by_source_locator', sparse: true },
      rationale: 'Supersede older observations of a source record identified by locator.',
    },
    {
      key: { sourceId: 1, lastObservedAt: -1 },
      options: { name: 'by_source_time' },
      rationale: 'Source/time queries; delisting detection.',
    },
    {
      key: { sourceId: 1, externalId: 1, sourceObservedAt: -1 },
      options: { name: 'by_source_external' },
      rationale: 'Observation history of one source record in source chronology (supersession).',
    },
    {
      key: { 'resolution.state': 1, createdAt: 1 },
      options: { name: 'by_resolution_state' },
      rationale: 'Unresolved/review backlog metrics.',
    },
    {
      key: { snapshotId: 1, superseded: 1 },
      options: {
        name: 'by_snapshot',
        partialFilterExpression: { snapshotId: { $exists: true } },
      },
      rationale:
        'Retention sweep (OPS-3): is a snapshot still the evidence of a current observation. Partial on snapshotId (not sparse): `$ne: true` matches observations that omit superseded, which a sparse index on both fields would skip.',
    },
  ],
});

export const jobObservationsCollection = defineCollection<JobObservationDoc>({
  name: 'market_job_observations',
  description: 'Append-only statements a source made about a job posting.',
  schema: jobObservationDocSchema,
  schemaVersion: OBSERVATION_SCHEMA_VERSION,
  indexes: [
    {
      key: { 'resolution.entityId': 1, lastObservedAt: -1, _id: -1 },
      options: { name: 'by_job_recent', sparse: true },
      rationale: 'Reconcile a job from its source copies; provenance UI.',
    },
    {
      key: { sourceId: 1, externalId: 1, lastObservedAt: -1 },
      options: { name: 'by_source_external_time' },
      rationale: 'Latest observation per source record.',
    },
    {
      key: { sourceId: 1, lastObservedAt: -1 },
      options: { name: 'by_source_time' },
      rationale: 'Source/time queries.',
    },
    {
      key: { 'resolution.state': 1, createdAt: 1 },
      options: { name: 'by_resolution_state' },
      rationale: 'Unresolved/review backlog metrics.',
    },
    {
      key: { snapshotId: 1, superseded: 1 },
      options: {
        name: 'by_snapshot',
        partialFilterExpression: { snapshotId: { $exists: true } },
      },
      rationale:
        'Retention sweep (OPS-3): is a snapshot still the evidence of a current observation. Partial on snapshotId (not sparse): `$ne: true` matches observations that omit superseded, which a sparse index on both fields would skip.',
    },
  ],
});

/** Source chronology of an observation (see `sourceObservedAt`). */
export function sourceTimeOf(o: { sourceObservedAt?: Date; lastObservedAt: Date }): Date {
  return o.sourceObservedAt ?? o.lastObservedAt;
}
