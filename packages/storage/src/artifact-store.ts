import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import { z } from 'zod';
import {
  artifactContextSchema,
  type ArtifactContext,
  type ArtifactRef,
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
 * immutable `ArtifactRef` document. Storing identical bytes twice is a no-op that returns
 * the original reference (idempotent retries, deduplicated snapshots).
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
  schemaVersion: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ArtifactDoc = z.infer<typeof artifactDocSchema>;

export const artifactsCollection = defineCollection<ArtifactDoc>({
  name: 'artifacts',
  description: 'Immutable references to raw artifacts stored in object storage (content-addressed).',
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
      // Heal a missing object (e.g. bucket wiped in development) without changing the reference.
      if (!(await this.storage.exists(existing.storageKey))) {
        await this.storage.put(existing.storageKey, bytes, existing.mimeType, { sha256 });
      }
      await this.col.updateOne(
        { _id: id },
        { $set: { lastStoredAt: now, updatedAt: now }, $inc: { storeCount: 1 } },
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

  async get(artifactId: string): Promise<ArtifactDoc> {
    const doc = await this.col.findOne({ _id: artifactId });
    if (!doc) throw new NotFoundError('Artifact', artifactId);
    return doc;
  }

  async readBytes(ref: Pick<ArtifactRef, 'artifactId'> & Partial<ArtifactRef>): Promise<Uint8Array> {
    const doc = ref.storageKey && ref.sha256 ? ref : await this.get(ref.artifactId);
    const bytes = await this.storage.get(doc.storageKey as string);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== doc.sha256) {
      throw new Error(
        `Artifact ${ref.artifactId} integrity check failed (expected ${doc.sha256}, got ${actual})`,
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
