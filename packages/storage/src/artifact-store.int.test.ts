import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectMongo, type MongoHandle } from '@aptamind/db';
import { ArtifactDeletedError, ArtifactStore } from './artifact-store';
import { S3ObjectStorage } from './object-storage';

/**
 * FE-4 against real MongoDB and S3 DeleteObject. Not part of the unit project.
 * Content-addressed keys are unique per run so the shared bucket is not clobbered.
 */
let mongo: MongoHandle | undefined;
let storage: S3ObjectStorage | undefined;
let store: ArtifactStore;
const keys: string[] = [];
let now = new Date('2026-04-01T00:00:00Z');

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

beforeAll(async () => {
  const dbName = `t_fe4_art_${randomBytes(4).toString('hex')}`;
  mongo = await connectMongo({
    uri: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true',
    dbName,
    appName: 'test-artifact-delete',
  });
  storage = new S3ObjectStorage({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? 'us-east-1',
    bucket: process.env.S3_BUCKET ?? 'aptamind-artifacts',
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
    forcePathStyle: true,
  });
  await storage.ensureReady();
  store = new ArtifactStore(mongo.db, storage, { now: () => now });
});

afterAll(async () => {
  if (storage) {
    for (const key of keys) await storage.delete(key).catch(() => {});
  }
  if (mongo) {
    await mongo.db.dropDatabase().catch(() => {});
    await mongo.close();
  }
});

describe('artifact byte delete (FE-4)', () => {
  it('deletes, refuses a later read, is idempotent, and put restores the bytes', async () => {
    const body = `fe4-delete-${randomBytes(8).toString('hex')}`;
    const ref = await store.put(body, 'text/plain');
    keys.push(ref.storageKey);
    expect(await storage!.exists(ref.storageKey)).toBe(true);

    expect(await store.deleteBytes(ref.artifactId, async () => false)).toBe('deleted');
    expect(await storage!.exists(ref.storageKey)).toBe(false);
    const doc = await store.get(ref.artifactId);
    expect(doc.deletedAt).toEqual(now);
    await expect(store.readBytes(ref)).rejects.toBeInstanceOf(ArtifactDeletedError);

    await storage!.put(ref.storageKey, new TextEncoder().encode('garbage'), 'text/plain');
    await expect(store.readBytes(ref)).rejects.toBeInstanceOf(ArtifactDeletedError);
    expect(await store.deleteBytes(ref.artifactId, async () => false)).toBe('deleted');
    await storage!.delete(ref.storageKey);
    expect(await store.deleteBytes(ref.artifactId, async () => false)).toBe('deleted');

    now = new Date('2026-04-02T00:00:00Z');
    const again = await store.put(body, 'text/plain');
    expect(again.artifactId).toBe(ref.artifactId);
    expect((await store.get(ref.artifactId)).deletedAt).toBeUndefined();
    expect(await store.readText(again)).toBe(body);
    expect(await storage!.exists(ref.storageKey)).toBe(true);
  });

  it('does not delete when the reference check returns true, and a missing id is a no-op', async () => {
    const body = `fe4-keep-${randomBytes(8).toString('hex')}`;
    const ref = await store.put(body, 'text/plain');
    keys.push(ref.storageKey);
    expect(await store.deleteBytes(ref.artifactId, async () => true)).toBe('referenced');
    expect(await store.readText(ref)).toBe(body);
    expect(await store.deleteBytes('art_missing', async () => false)).toBe('missing');
  });
});
