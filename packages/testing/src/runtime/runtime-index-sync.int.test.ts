import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCollection, ensureCollections } from '@aptamind/db';
import type { CollectionSpec } from '@aptamind/db';
import { MongoClient, type Document } from 'mongodb';
import { createTestInfra, type TestInfra } from '../index';

// FE-1: `ensureCollections` must be idempotent for text indexes and tolerate a concurrent
// process dropping a changed index first.
let infra: TestInfra;

beforeAll(async () => {
  infra = await createTestInfra('index-sync');
});
afterAll(async () => {
  await infra.cleanup();
});

const schema = z.object({ _id: z.string(), title: z.string(), tenant: z.string() });

function spec(name: string, indexes: CollectionSpec<Document>['indexes']): CollectionSpec<Document> {
  return defineCollection({ name, schema, indexes } as unknown as CollectionSpec<Document>);
}

describe('FE-1 ensureCollections index sync', () => {
  it('does not drop or rebuild an unchanged text index on repeated calls', async () => {
    const s = spec('fe1_text', [
      {
        key: { tenant: 1, title: 'text' },
        options: { name: 'by_tenant_title_text' },
        rationale: 'FE-1 test',
      },
    ]);
    await ensureCollections(infra.db, [s]);
    await infra.db
      .collection<{ _id: string; title: string; tenant: string }>('fe1_text')
      .insertOne({ _id: 'a', title: 'engineer', tenant: 't' });

    // A separate client with command monitoring observes every dropIndexes command.
    const client = new MongoClient(infra.mongoUri, { monitorCommands: true });
    await client.connect();
    const dropped: string[] = [];
    client.on('commandStarted', (e) => {
      if (e.commandName === 'dropIndexes') dropped.push(String(e.command.index));
    });
    try {
      const db = client.db(infra.dbName);
      await ensureCollections(db, [s]);
      await ensureCollections(db, [s]);
    } finally {
      await client.close();
    }
    expect(dropped).toEqual([]);
    const hits = await infra.db
      .collection<{ _id: string }>('fe1_text')
      .find({ tenant: 't', $text: { $search: 'engineer' } })
      .toArray();
    expect(hits.map((d) => d._id)).toEqual(['a']);
  });

  it('rebuilds a text index whose text fields actually changed', async () => {
    await ensureCollections(infra.db, [
      spec('fe1_text2', [{ key: { title: 'text' }, options: { name: 'by_text' }, rationale: 'FE-1 test' }]),
    ]);
    await ensureCollections(infra.db, [
      spec('fe1_text2', [
        { key: { title: 'text', tenant: 'text' }, options: { name: 'by_text' }, rationale: 'FE-1 test' },
      ]),
    ]);
    const idx = (await infra.db.collection('fe1_text2').listIndexes().toArray()).find(
      (i) => i.name === 'by_text',
    );
    expect(Object.keys(idx?.weights ?? {}).sort()).toEqual(['tenant', 'title']);
  });

  it('two processes applying a changed index spec concurrently both succeed', async () => {
    const before = spec('fe1_race', [
      { key: { tenant: 1 }, options: { name: 'by_tenant' }, rationale: 'FE-1 test' },
    ]);
    const after = spec('fe1_race', [
      { key: { tenant: 1, title: 1 }, options: { name: 'by_tenant' }, rationale: 'FE-1 test' },
    ]);
    for (let round = 0; round < 5; round++) {
      await ensureCollections(infra.db, [before]);
      const results = await Promise.allSettled([
        ensureCollections(infra.db, [after]),
        ensureCollections(infra.db, [after]),
        ensureCollections(infra.db, [after]),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
      const idx = (await infra.db.collection('fe1_race').listIndexes().toArray()).find(
        (i) => i.name === 'by_tenant',
      );
      expect(idx?.key).toEqual({ tenant: 1, title: 1 });
    }
  });

  it('rebuilds (rather than failing) when only a text option changes', async () => {
    const base = { key: { title: 'text' }, rationale: 'FE-1 test' };
    const variants: Record<string, unknown>[] = [
      {},
      { weights: { title: 5 } },
      { weights: { title: 5 }, default_language: 'spanish' },
      { weights: { title: 5 }, default_language: 'spanish', language_override: 'lang' },
    ];
    for (const extra of variants) {
      await ensureCollections(infra.db, [
        spec('fe1_textopts', [{ ...base, options: { name: 'by_text', ...extra } }] as never),
      ]);
      const idx = (await infra.db.collection('fe1_textopts').listIndexes().toArray()).find(
        (i) => i.name === 'by_text',
      );
      expect(idx?.default_language).toBe(extra.default_language ?? 'english');
      expect(idx?.language_override).toBe(extra.language_override ?? 'language');
      expect(idx?.weights).toEqual((extra.weights as object) ?? { title: 1 });
    }
  });

  it('does not rebuild a wildcard text index with explicit weights', async () => {
    const s = spec('fe1_wild', [
      { key: { '$**': 'text' }, options: { name: 'by_wild', weights: { title: 3 } }, rationale: 'FE-1 test' },
    ] as never);
    await ensureCollections(infra.db, [s]);
    const client = new MongoClient(infra.mongoUri, { monitorCommands: true });
    await client.connect();
    const dropped: string[] = [];
    client.on('commandStarted', (e) => {
      if (e.commandName === 'dropIndexes') dropped.push(String(e.command.index));
    });
    try {
      await ensureCollections(client.db(infra.dbName), [s]);
    } finally {
      await client.close();
    }
    expect(dropped).toEqual([]);
  });

  it('detects field-order changes, including a field moved across the text part', async () => {
    const orders: CollectionSpec<Document>['indexes'][] = [
      [{ key: { a: 1, b: 1, title: 'text' }, options: { name: 'by_ord' }, rationale: 'FE-1 test' }],
      [{ key: { a: 1, title: 'text', b: 1 }, options: { name: 'by_ord' }, rationale: 'FE-1 test' }],
    ];
    for (const indexes of orders) await ensureCollections(infra.db, [spec('fe1_order', indexes)]);
    const text = (await infra.db.collection('fe1_order').listIndexes().toArray()).find(
      (i) => i.name === 'by_ord',
    );
    expect(Object.keys(text?.key ?? {})).toEqual(['a', '_fts', '_ftsx', 'b']);

    await ensureCollections(infra.db, [
      spec('fe1_order2', [{ key: { a: 1, b: 1 }, options: { name: 'by_ab' }, rationale: 'FE-1 test' }]),
    ]);
    await ensureCollections(infra.db, [
      spec('fe1_order2', [{ key: { b: 1, a: 1 }, options: { name: 'by_ab' }, rationale: 'FE-1 test' }]),
    ]);
    const plain = (await infra.db.collection('fe1_order2').listIndexes().toArray()).find(
      (i) => i.name === 'by_ab',
    );
    expect(Object.keys(plain?.key ?? {})).toEqual(['b', 'a']);
  });

  it('converges when another process drops the index while our build is running', async () => {
    const col = infra.db.collection<{ _id: number; tenant: string; title: string }>('fe1_abort');
    const docs = Array.from({ length: 150_000 }, (_, i) => ({
      _id: i,
      tenant: `t${i % 97}`,
      title: `x${i}`,
    }));
    for (let i = 0; i < docs.length; i += 25_000) await col.insertMany(docs.slice(i, i + 25_000));
    const before = spec('fe1_abort', [
      { key: { tenant: 1 }, options: { name: 'by_t' }, rationale: 'FE-1 test' },
    ]);
    const after = spec('fe1_abort', [
      { key: { tenant: 1, title: 1 }, options: { name: 'by_t' }, rationale: 'FE-1 test' },
    ]);
    await ensureCollections(infra.db, [before]);

    // Process A applies the new spec; process B (a late booter with the old view) drops `by_t`
    // as soon as A's build is observed in progress — the IndexBuildAborted window.
    const a = ensureCollections(infra.db, [after]);
    let aborted = false;
    for (let i = 0; i < 400 && !aborted; i++) {
      const ops = await infra.mongo.client
        .db('admin')
        .aggregate(
          [{ $currentOp: { allUsers: true } }, { $match: { 'command.createIndexes': 'fe1_abort' } }],
          {
            readConcern: { level: 'local' },
          },
        )
        .toArray();
      if (ops.length) {
        await col.dropIndex('by_t').catch(() => {});
        aborted = true;
      } else await new Promise((r) => setTimeout(r, 5));
    }
    await expect(a).resolves.toBeUndefined();
    // B then completes its own sync; both end with the spec's definition.
    await ensureCollections(infra.db, [after]);
    const idx = (await col.listIndexes().toArray()).find((i) => i.name === 'by_t');
    expect(idx?.key).toEqual({ tenant: 1, title: 1 });
    expect(aborted).toBe(true);
  }, 120_000);
});
