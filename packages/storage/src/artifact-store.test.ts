import type { ArtifactRef } from '@aptamind/contracts';
import type { Db } from 'mongodb';
import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactDeletedError, ArtifactStore } from './artifact-store';
import { MemoryObjectStorage } from './object-storage';

/** Enough of a collection for ArtifactStore: findOne, insertOne, updateOne. */
class FakeArtifacts {
  readonly docs = new Map<string, Record<string, unknown>>();

  async findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    for (const doc of this.docs.values()) {
      if (matches(doc, filter)) return structuredClone(doc);
    }
    return null;
  }

  async insertOne(doc: Record<string, unknown>): Promise<void> {
    this.docs.set(String(doc._id), structuredClone(doc));
  }

  async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<void> {
    for (const [id, doc] of this.docs) {
      if (!matches(doc, filter)) continue;
      const set = update.$set as Record<string, unknown> | undefined;
      if (set) Object.assign(doc, set);
      const inc = update.$inc as Record<string, number> | undefined;
      if (inc) {
        for (const [key, n] of Object.entries(inc)) doc[key] = ((doc[key] as number) ?? 0) + n;
      }
      const unset = update.$unset as Record<string, unknown> | undefined;
      if (unset) {
        for (const key of Object.keys(unset)) delete doc[key];
      }
      this.docs.set(id, doc);
      return;
    }
  }
}

function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    if (expected && typeof expected === 'object' && '$exists' in expected) {
      const exists = doc[key] !== undefined;
      if ((expected as { $exists: boolean }).$exists !== exists) return false;
      continue;
    }
    if (doc[key] !== expected) return false;
  }
  return true;
}

function fakeDb(col: FakeArtifacts): Db {
  return { collection: () => col } as unknown as Db;
}

describe('ArtifactStore.deleteBytes', () => {
  let storage: MemoryObjectStorage;
  let docs: FakeArtifacts;
  let now: Date;
  let store: ArtifactStore;

  beforeEach(() => {
    storage = new MemoryObjectStorage();
    docs = new FakeArtifacts();
    now = new Date('2026-03-01T00:00:00Z');
    store = new ArtifactStore(fakeDb(docs), storage, { now: () => now });
  });

  async function put(body: string): Promise<ArtifactRef> {
    return store.put(body, 'text/plain');
  }

  it('does not delete when the caller says the artifact is still referenced', async () => {
    const ref = await put('still-needed');
    const seen: string[] = [];
    const result = await store.deleteBytes(ref.artifactId, async (id) => {
      seen.push(id);
      return true;
    });
    expect(result).toBe('referenced');
    expect(seen).toEqual([ref.artifactId]);
    expect(await storage.exists(ref.storageKey)).toBe(true);
    expect((await store.get(ref.artifactId)).deletedAt).toBeUndefined();
    expect(new TextDecoder().decode(await store.readBytes(ref))).toBe('still-needed');
  });

  it('deletes bytes, keeps the document, and a later read fails even if bytes are put back', async () => {
    const ref = await put('original-bytes');
    expect(await store.deleteBytes(ref.artifactId, async () => false)).toBe('deleted');
    expect(await storage.exists(ref.storageKey)).toBe(false);

    const doc = await store.get(ref.artifactId);
    expect(doc._id).toBe(ref.artifactId);
    expect(doc.deletedAt).toEqual(now);
    expect(docs.docs.has(ref.artifactId)).toBe(true);

    await storage.put(ref.storageKey, new TextEncoder().encode('garbage'), 'text/plain');
    await expect(store.readBytes({ artifactId: ref.artifactId })).rejects.toBeInstanceOf(
      ArtifactDeletedError,
    );
    await expect(store.readBytes(ref)).rejects.toThrow(/bytes were deleted/);

    let called = false;
    expect(
      await store.deleteBytes(ref.artifactId, async () => {
        called = true;
        return false;
      }),
    ).toBe('deleted');
    expect(called).toBe(false);
    // A repeat delete is a no-op (it must not race a concurrent put that restores bytes); reads
    // still refuse while the document is marked deleted.
    expect(await storage.exists(ref.storageKey)).toBe(true);
  });

  it('marks a missing object deleted and does not surface a storage error on read', async () => {
    const ref = await put('vanished');
    await storage.delete(ref.storageKey);
    expect(await store.deleteBytes(ref.artifactId, async () => false)).toBe('deleted');
    expect((await store.get(ref.artifactId)).deletedAt).toEqual(now);
    await expect(store.readBytes(ref)).rejects.toBeInstanceOf(ArtifactDeletedError);
  });

  it('returns missing for an unknown artifact id', async () => {
    expect(await store.deleteBytes('art_no_such_artifact', async () => false)).toBe('missing');
  });

  it('put of the same bytes after a delete uploads again and clears deletedAt', async () => {
    const body = 'restore-me';
    const ref = await put(body);
    await store.deleteBytes(ref.artifactId, async () => false);
    await storage.put(ref.storageKey, new TextEncoder().encode('leftover-garbage'), 'text/plain');

    const again = await store.put(body, 'text/plain');
    expect(again.artifactId).toBe(ref.artifactId);
    expect(again.storageKey).toBe(ref.storageKey);
    expect((await store.get(ref.artifactId)).deletedAt).toBeUndefined();
    expect(new TextDecoder().decode(await store.readBytes(again))).toBe(body);
    const stored = storage.objects.get(ref.storageKey);
    expect(new TextDecoder().decode(stored?.body ?? new Uint8Array())).toBe(body);
  });
});
