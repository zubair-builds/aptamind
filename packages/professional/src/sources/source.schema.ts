import { z } from 'zod';
import { artifactRefSchema } from '@aptamind/contracts';
import { defineCollection } from '@aptamind/db';
import { actorRefSchema, codeSchema, documentMetaFields } from '../documents';
import { idSchema } from '../contracts/ids';
import { urlSchema } from '../contracts/values';
import { professionalValidator } from '../validators';
import {
  isLinkedInHost,
  isLinkedInUrl,
  LINKEDIN_HOST_REGEX_SOURCE,
  LINKEDIN_URL_REGEX_SOURCE,
} from './linkedin';

export const SOURCE_SCHEMA_VERSION = 1;

/** Most recent Idempotency-Key bindings kept on a source (older keys stop replaying). */
export const MAX_IDEMPOTENCY_BINDINGS = 20;

/** Source kinds (context doc §5.1). */
export const SOURCE_KINDS = [
  'manual_input',
  'questionnaire',
  'cv',
  'linkedin_export',
  'github',
  'portfolio',
  'personal_website',
  'case_study',
  'certificate',
  'uploaded_document',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Who wrote the source's content. */
export const SOURCE_AUTHORSHIP = ['subject', 'platform', 'issuer', 'other'] as const;
/** How content is acquired. LinkedIn is import-only (PL-11): never `fetch`. */
export const SOURCE_ACQUISITION = ['structured_input', 'upload', 'fetch'] as const;
export const SOURCE_STATUSES = ['active', 'archived'] as const;
/**
 * Ownership of sources whose ownership is itself a claim (a GitHub handle, a website URL):
 * `intrinsic` — authored/supplied by the subject (uploads, forms); `claimed` — the ownership
 * claim is not confirmed yet; `confirmed`; `disowned` — the subject rejected the ownership
 * claim, so the source's unconfirmed assertions lose its support.
 */
export const SOURCE_OWNERSHIP_STATES = ['intrinsic', 'claimed', 'confirmed', 'disowned'] as const;
export const SOURCE_HEALTH_STATES = ['unknown', 'ok', 'degraded', 'failing'] as const;

export const sourceDocSchema = z
  .strictObject({
    _id: idSchema('source'),
    subjectId: idSchema('subject'),
    kind: z.enum(SOURCE_KINDS),
    authorship: z.enum(SOURCE_AUTHORSHIP),
    acquisition: z.enum(SOURCE_ACQUISITION),
    /**
     * Normalized external reference (URL or handle) for idempotent registration. Personal data:
     * never part of an id, never logged.
     */
    externalRefKey: z.string().min(1).max(2048).optional(),
    url: urlSchema.optional(),
    policy: z.object({
      /** Hosts a fetch may reach (the stated host only); empty for non-fetch sources. */
      hostScope: z
        .array(
          z
            .string()
            .min(1)
            .max(253)
            .regex(/^[a-z0-9.-]+$/),
        )
        .max(10),
      maxPages: z.number().int().positive(),
    }),
    ownership: z.object({
      state: z.enum(SOURCE_OWNERSHIP_STATES),
      /** The `identity.link` assertion whose confirmation or rejection decides ownership. */
      assertionId: idSchema('assertion').optional(),
    }),
    status: z.enum(SOURCE_STATUSES),
    stats: z.object({
      snapshots: z.number().int().nonnegative(),
      observations: z.number().int().nonnegative(),
      lastAcquiredAt: z.date().optional(),
    }),
    health: z.object({
      state: z.enum(SOURCE_HEALTH_STATES),
      consecutiveFailures: z.number().int().nonnegative(),
      lastErrorCode: codeSchema.optional(),
      checkedAt: z.date().optional(),
    }),
    /** Hash of the registration request (Idempotency-Key replays with another body are refused). */
    createRequestHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    /**
     * Idempotency-Keys (as `det(psrc, subject, 'idem', key)`) bound to this source by a
     * registration that matched its natural key instead of creating it, each with its request
     * hash, so a replay returns this source and a reuse with another body is refused.
     */
    idempotencyBindings: z
      .array(
        z.strictObject({
          keyId: idSchema('source'),
          requestHash: z.string().regex(/^[0-9a-f]{64}$/),
        }),
      )
      .max(MAX_IDEMPOTENCY_BINDINGS)
      .optional(),
    createdBy: actorRefSchema,
    ...documentMetaFields,
  })
  // PL-11: LinkedIn is accepted only as a subject-supplied export, never fetched.
  .refine((s) => !(s.kind === 'linkedin_export' && s.acquisition === 'fetch'), {
    message: 'linkedin_export sources cannot be fetched',
    path: ['acquisition'],
  })
  // PL-11: no source of any kind may point a URL or a fetch scope at a LinkedIn host.
  .refine((s) => !(s.url && isLinkedInUrl(s.url)), {
    message: 'LinkedIn URLs are import-only',
    path: ['url'],
  })
  .refine((s) => !s.policy.hostScope.some(isLinkedInHost), {
    message: 'LinkedIn hosts cannot be in a fetch scope',
    path: ['policy', 'hostScope'],
  });
export type SourceDoc = z.infer<typeof sourceDocSchema>;

export const sourcesCollection = defineCollection<SourceDoc>({
  name: 'professional_sources',
  description: 'Where evidence about a subject comes from: kind, authorship, acquisition policy, ownership.',
  schema: sourceDocSchema,
  schemaVersion: SOURCE_SCHEMA_VERSION,
  validator: professionalValidator(sourceDocSchema, {
    nor: [
      { kind: 'linkedin_export', acquisition: 'fetch' },
      { url: { $regex: LINKEDIN_URL_REGEX_SOURCE, $options: 'i' } },
      { 'policy.hostScope': { $regex: LINKEDIN_HOST_REGEX_SOURCE, $options: 'i' } },
    ],
  }),
  indexes: [
    {
      key: { subjectId: 1, kind: 1, externalRefKey: 1 },
      options: {
        name: 'uniq_subject_kind_ref',
        unique: true,
        partialFilterExpression: { externalRefKey: { $exists: true } },
      },
      rationale:
        'Idempotent registration of the same external source for a subject (ids stay random: the ref is personal data).',
    },
    {
      key: { subjectId: 1, createdAt: -1, _id: -1 },
      options: { name: 'by_subject' },
      rationale: "A subject's sources, newest first (cursor pagination); erasure enumeration.",
    },
  ],
});

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const SNAPSHOT_VIA = ['upload', 'fetch', 'form'] as const;
/**
 * What `sourceAsOf` is: the document date the operator declared (`declared`, authoritative), or
 * the time the bytes were acquired (`acquired`, the latest acquisition of identical bytes).
 */
export const SNAPSHOT_SOURCE_AS_OF_KINDS = ['declared', 'acquired'] as const;
export const SNAPSHOT_INGEST_STATES = ['pending', 'launched'] as const;

/**
 * Raw bytes a source provided at a point in time (content-addressed per source). `sourceAsOf`
 * is the declared document date, else the latest acquisition time (ADR-0019): reprocessing never
 * makes old content newer. Each acquisition is a row in `professional_acquisitions`.
 */
export const snapshotDocSchema = z.strictObject({
  _id: idSchema('snapshot'),
  subjectId: idSchema('subject'),
  sourceId: idSchema('source'),
  artifact: artifactRefSchema,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  mimeType: z.string().min(1).max(200),
  via: z.enum(SNAPSHOT_VIA),
  sourceAsOf: z.date(),
  sourceAsOfKind: z.enum(SNAPSHOT_SOURCE_AS_OF_KINDS),
  /** The declared document date (set once; equals `sourceAsOf` when `declared`). */
  declaredAsOf: z.date().optional(),
  /**
   * The `acquired` chronology a later declaration replaced (a provenance correction, kept, never
   * destroyed; evented as `snapshot.dated`).
   */
  previousSourceAsOf: z
    .strictObject({
      kind: z.enum(SNAPSHOT_SOURCE_AS_OF_KINDS),
      value: z.date(),
      replacedAt: z.date(),
      acquisitionId: idSchema('acquisition'),
    })
    .optional(),
  /** Accepted acquisitions (uploads/fetches) of these bytes; replays never count. */
  acquisitions: z.number().int().positive(),
  firstAcquiredAt: z.date(),
  lastAcquiredAt: z.date(),
  lastRunId: z.string().optional(),
  /**
   * Ingest launch state (P1.3). `pending` from the snapshot's commit until an ingest run is
   * started (`launched`, with its run id); a crash between the two leaves `pending` — the
   * "unprocessed snapshot" the operator sees and reprocesses. Absent (snapshots written before
   * P1.3) reads as `pending`. Processing results live in `professional_extractions`.
   */
  ingest: z
    .strictObject({
      state: z.enum(SNAPSHOT_INGEST_STATES),
      runId: z.string().min(1).max(100).optional(),
      requestedAt: z.date(),
      launchedAt: z.date().optional(),
    })
    .optional(),
  ...documentMetaFields,
});
export type SnapshotDoc = z.infer<typeof snapshotDocSchema>;

export const snapshotsCollection = defineCollection<SnapshotDoc>({
  name: 'professional_snapshots',
  description:
    'Immutable raw source snapshots (private bytes in object storage), content-addressed per source.',
  schema: snapshotDocSchema,
  schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  validator: professionalValidator(snapshotDocSchema),
  indexes: [
    {
      key: { sourceId: 1, contentHash: 1 },
      options: { name: 'uniq_source_hash', unique: true },
      rationale:
        'Content addressing per source: identical bytes are one snapshot (concurrent uploads converge).',
    },
    {
      key: { subjectId: 1, sourceAsOf: -1 },
      options: { name: 'by_subject_asof' },
      rationale: "A subject's evidence in source chronology.",
    },
    {
      key: { 'artifact.artifactId': 1 },
      options: { name: 'by_artifact' },
      rationale: 'Artifact ownership check for private content routes; erasure.',
    },
    {
      key: { sourceId: 1, createdAt: -1, _id: -1 },
      options: { name: 'by_source_created' },
      rationale: "A source's snapshots, newest first (cursor pagination).",
    },
  ],
});

export const ACQUISITION_SCHEMA_VERSION = 1;

/**
 * The per-source acquisition ledger: one row per accepted upload (fetch in P6), inserted in the
 * acquiring transaction. `_id` is `det(pacq, sourceId, 'idem', key)` for an Idempotency-Key
 * (else random), so a key binds exactly one acquisition forever (no eviction): the same
 * `bindingHash` is a replay (nothing counts), another is 409 `conflict`.
 */
export const acquisitionDocSchema = z.strictObject({
  _id: idSchema('acquisition'),
  subjectId: idSchema('subject'),
  sourceId: idSchema('source'),
  snapshotId: idSchema('snapshot'),
  via: z.enum(SNAPSHOT_VIA),
  /** `sha256(contentHash, mimeType, declaredAsOf ?? '')`: what the acquisition was. */
  bindingHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Whether the id came from an Idempotency-Key. */
  keyed: z.boolean(),
  createdBy: actorRefSchema,
  ...documentMetaFields,
});
export type AcquisitionDoc = z.infer<typeof acquisitionDocSchema>;

export const acquisitionsCollection = defineCollection<AcquisitionDoc>({
  name: 'professional_acquisitions',
  description:
    'Per-source acquisition ledger (uploads): binds Idempotency-Keys to what they acquired; ids and hashes only.',
  schema: acquisitionDocSchema,
  schemaVersion: ACQUISITION_SCHEMA_VERSION,
  validator: professionalValidator(acquisitionDocSchema),
  indexes: [
    {
      key: { snapshotId: 1, createdAt: -1 },
      options: { name: 'by_snapshot' },
      rationale: "A snapshot's acquisitions (history).",
    },
    {
      key: { subjectId: 1, createdAt: -1 },
      options: { name: 'by_subject' },
      rationale: "A subject's acquisitions; erasure enumeration.",
    },
  ],
});
