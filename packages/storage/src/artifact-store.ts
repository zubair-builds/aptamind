import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import { z } from 'zod';
import {
  artifactContextSchema,
  type ArtifactContext,
  type ArtifactRef,
  InvalidStateError,
  NotFoundError,
  type Clock,
  systemClock,
} from '@aptamind/contracts';
import { defineCollection, getCollection, isDuplicateKeyError } from '@aptamind/db';
import type { ObjectStorage } from './object-storage';

/**
 * Content-addressed artifact store.
 *
 * Bytes go to object storage under `artifacts/sha256/<aa>/<bb>/<hash>`; MongoDB keeps an
 * `ArtifactRef` document. Storing identical bytes twice is a no-op that returns the original
 * reference (idempotent retries, deduplicated snapshots). `deleteBytes` removes the object
 * only when a caller-supplied check says nothing still references it, and stamps `deletedAt`
 * on the document. The document stays, so provenance can still name the artifact.
 */

export const ARTIFACT_SCHEMA_VERSION = 1;

export const artifactDocSchema = z.object({
  _id: z.string(),
  storageKey: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  /** Context of the first write; later writes of identical bytes only bump `lastStoredAt`. */
  context: artifactContextSchema,
  lastStoredAt: z.date(),
  storeCount: z.number().int().positive(),
  /**
   * Set when the bytes were deleted (FE-4). Absent while the object exists. A later `put` of
   * the same bytes clears it and uploads again.
   */
  deletedAt: z.date().optional(),
  schemaVersion: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ArtifactDoc = z.infer<typeof artifactDocSchema>;

export const artifactsCollection = defineCollection<ArtifactDoc>({
  name: 'artifacts',
  description:
    'References to raw artifacts in object storage (content-addressed). The document stays after a reference-counted byte delete.',
  schema: artifactDocSchema,
  schemaVersion: ARTIFACT_SCHEMA_VERSION,
  indexes: [
    {
      key: { sha256: 1 },
      options: { name: 'uniq_sha256', unique: true },
      rationale: 'Content addressing: one artifact document per distinct byte sequence.',
    },
    {
      key: { 'context.runId': 1, createdAt: -1 },
      options: { name: 'by_run', sparse: true },
      rationale: 'List artifacts produced by a workflow run.',
    },
  ],
});

export function artifactIdForHash(sha256: string): string {
  return `art_${sha256.slice(0, 32)}`;
}

export function storageKeyForHash(sha256: string): string {
  return `artifacts/sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

export function toArtifactRef(doc: ArtifactDoc): ArtifactRef {
  return {
    artifactId: doc._id,
    storageKey: doc.storageKey,
    mimeType: doc.mimeType,
    size: doc.size,
    sha256: doc.sha256,
    createdAt: doc.createdAt,
  };
}

/** The artifact document exists, but its bytes were deleted. Reads must not return stand-in content. */
export class ArtifactDeletedError extends InvalidStateError {
  constructor(artifactId: string) {
    super(`Artifact ${artifactId} bytes were deleted`, { artifactId, reason: 'bytes_deleted' });
    this.name = 'ArtifactDeletedError';
  }
}

export type ArtifactDeleteResult = 'deleted' | 'referenced' | 'missing';

export class ArtifactStore {
  constructor(
    private readonly db: Db,
    private readonly storage: ObjectStorage,
    private readonly clock: Clock = systemClock,
  ) {}

  private get col() {
    return getCollection(this.db, artifactsCollection);
  }

  async put(
    body: Uint8Array | string,
    mimeType: string,
    context: Partial<ArtifactContext> = {},
  ): Promise<ArtifactRef> {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const id = artifactIdForHash(sha256);
    const now = this.clock.now();

    const existing = await this.col.findOne({ _id: id });
    if (existing) {
      // Heal a missing object (bucket wiped, or bytes deleted and marked `deletedAt`) without
      // changing the reference. A deleted document is re-uploaded even when an object is still
      // there, so a later read cannot observe leftover bytes under a cleared mark.
      if (existing.deletedAt || !(await this.storage.exists(existing.storageKey))) {
        await this.storage.put(existing.storageKey, bytes, existing.mimeType, { sha256 });
      }
      await this.col.updateOne(
        { _id: id },
        {
          $set: { lastStoredAt: now, updatedAt: now },
          $inc: { storeCount: 1 },
          ...(existing.deletedAt ? { $unset: { deletedAt: '' } } : {}),
        },
      );
      return toArtifactRef(existing);
    }

    const storageKey = storageKeyForHash(sha256);
    // Write bytes first: a reference must never point at missing content.
    await this.storage.put(storageKey, bytes, mimeType, { sha256 });
    const doc: ArtifactDoc = {
      _id: id,
      storageKey,
      mimeType,
      size: bytes.byteLength,
      sha256,
      context: artifactContextSchema.parse(context),
      lastStoredAt: now,
      storeCount: 1,
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.col.insertOne(doc);
      return toArtifactRef(doc);
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      const winner = await this.col.findOne({ _id: id });
      if (!winner) throw err;
      return toArtifactRef(winner);
    }
  }

  async putJson(value: unknown, context: Partial<ArtifactContext> = {}): Promise<ArtifactRef> {
    return this.put(JSON.stringify(value), 'application/json', context);
  }

  /**
   * Delete the artifact's bytes when `referenced` returns false. The check runs immediately
   * before the object delete (a caller re-checks here; this package does not know which
   * documents point at an artifact). The document is kept and marked `deletedAt`.
   * Calling it again is a no-op. A missing document is a no-op. A missing object is success.
   */
  async deleteBytes(
    artifactId: string,
    referenced: (artifactId: string) => Promise<boolean>,
  ): Promise<ArtifactDeleteResult> {
    const doc = await this.col.findOne({ _id: artifactId });
    if (!doc) return 'missing';
    // Already deleted: no-op. Never delete again here, a concurrent `put` may be restoring bytes.
    if (doc.deletedAt) return 'deleted';
    if (await referenced(artifactId)) return 'referenced';
    await this.storage.delete(doc.storageKey);
    const now = this.clock.now();
    await this.col.updateOne(
      { _id: artifactId, deletedAt: { $exists: false } },
      { $set: { deletedAt: now, updatedAt: now } },
    );
    return 'deleted';
  }

  async get(artifactId: string): Promise<ArtifactDoc> {
    const doc = await this.col.findOne({ _id: artifactId });
    if (!doc) throw new NotFoundError('Artifact', artifactId);
    return doc;
  }

  async readBytes(ref: Pick<ArtifactRef, 'artifactId'> & Partial<ArtifactRef>): Promise<Uint8Array> {
    const stored = await this.col.findOne(
      { _id: ref.artifactId },
      { projection: { storageKey: 1, sha256: 1, deletedAt: 1 } },
    );
    // Check the document even when the caller already has a key: a deleted artifact must not
    // return bytes that happen to sit at that key.
    if (stored?.deletedAt) throw new ArtifactDeletedError(ref.artifactId);
    const inline = ref.storageKey !== undefined && ref.sha256 !== undefined;
    const storageKey = inline ? ref.storageKey : stored?.storageKey;
    const sha256 = inline ? ref.sha256 : stored?.sha256;
    if (!storageKey || !sha256) throw new NotFoundError('Artifact', ref.artifactId);
    const bytes = await this.storage.get(storageKey);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== sha256) {
      throw new Error(
        `Artifact ${ref.artifactId} integrity check failed (expected ${sha256}, got ${actual})`,
      );
    }
    return bytes;
  }

  async readText(ref: Pick<ArtifactRef, 'artifactId'> & Partial<ArtifactRef>): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(ref));
  }

  async readJson<T = unknown>(ref: Pick<ArtifactRef, 'artifactId'> & Partial<ArtifactRef>): Promise<T> {
    return JSON.parse(await this.readText(ref)) as T;
  }

  async listByRun(runId: string, limit = 100): Promise<ArtifactRef[]> {
    const docs = await this.col
      .find({ 'context.runId': runId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return docs.map(toArtifactRef);
  }
}
