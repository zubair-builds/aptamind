import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Document } from 'mongodb';
import { createTestInfra, type TestInfra } from '@aptamind/testing';
import {
  ensureMarketRunLabelIndexes,
  ensureRunLabelIndexes,
  MIGRATIONS,
  replacementIndexName,
  type RunLabelIndexSpec,
} from '@aptamind/platform';

/**
 * `ensureRunLabelIndexes` (PR #22 review H1): one helper for every run-label index. Concurrent
 * callers converge without errors, and a key is never left without an index while a legacy
 * (sparse) definition is replaced — the replacement is built before the legacy index is dropped.
 */

let infra: TestInfra;
const SPECS: RunLabelIndexSpec[] = [
  {
    key: { 'labels.sourceId': 1, createdAt: -1 },
    name: 'by_label_source',
    partialFilterExpression: { 'labels.sourceId': { $exists: true } },
  },
  {
    key: { 'labels.companyId': 1, createdAt: -1 },
    name: 'by_label_company',
    partialFilterExpression: { 'labels.companyId': { $exists: true } },
  },
];

beforeAll(async () => {
  infra = await createTestInfra('run-label-indexes');
  await infra.db
    .collection('workflow_runs')
    .insertOne(
      { _id: 'run_1' as never, labels: {}, createdAt: new Date() },
      { bypassDocumentValidation: true },
    );
});

afterAll(async () => {
  await infra?.cleanup();
});

const runs = () => infra.db.collection('workflow_runs');
const sameKey = (a: Document, b: Document) => JSON.stringify(a) === JSON.stringify(b);
const onKey = async (spec: RunLabelIndexSpec) =>
  (await runs().listIndexes().toArray()).filter((i) => sameKey(i.key as Document, spec.key));

async function legacySparse() {
  for (const spec of SPECS) {
    for (const i of await onKey(spec)) await runs().dropIndex(String(i.name));
    await runs().createIndex(spec.key, { name: spec.name, sparse: true });
  }
}

async function expectConverged() {
  for (const spec of SPECS) {
    const indexes = await onKey(spec);
    expect(indexes, spec.name).toHaveLength(1);
    expect(indexes[0]!.sparse).toBeUndefined();
    expect(indexes[0]!.partialFilterExpression).toEqual(spec.partialFilterExpression);
  }
}

describe('ensureRunLabelIndexes', () => {
  it('creates the partial indexes under their names on a fresh collection, idempotently', async () => {
    await ensureRunLabelIndexes(infra.db, SPECS);
    await expectConverged();
    for (const spec of SPECS) expect((await onKey(spec))[0]!.name).toBe(spec.name);
    const before = await runs().listIndexes().toArray();
    await ensureRunLabelIndexes(infra.db, SPECS);
    expect(await runs().listIndexes().toArray()).toEqual(before);
  });

  it('replaces a legacy sparse index by building the replacement first', async () => {
    await legacySparse();
    await ensureRunLabelIndexes(infra.db, SPECS);
    await expectConverged();
    for (const spec of SPECS) expect((await onKey(spec))[0]!.name).toBe(replacementIndexName(spec));
    // Converged: nothing changes on the next run.
    const before = await runs().listIndexes().toArray();
    await ensureRunLabelIndexes(infra.db, SPECS);
    expect(await runs().listIndexes().toArray()).toEqual(before);
  });

  it('10 rounds × 3 concurrent callers from a legacy sparse state: no call fails, no key is ever unindexed', async () => {
    let failures = 0;
    let unindexed = 0;
    for (let round = 0; round < 10; round++) {
      await legacySparse();
      let watching = true;
      const watcher = (async () => {
        while (watching) {
          const indexes = await runs().listIndexes().toArray();
          for (const spec of SPECS)
            if (!indexes.some((i) => sameKey(i.key as Document, spec.key))) unindexed++;
        }
      })();
      const results = await Promise.allSettled([1, 2, 3].map(() => ensureRunLabelIndexes(infra.db, SPECS)));
      watching = false;
      await watcher;
      failures += results.filter((r) => r.status === 'rejected').length;
      await expectConverged();
    }
    expect(failures).toBe(0);
    expect(unindexed).toBe(0);
  }, 120_000);
});

describe('migration 2026-09-27-003 on a fresh database', () => {
  it('converges when the API already built the partial indexes while the worker held the lock', async () => {
    await runs().dropIndexes();
    await ensureMarketRunLabelIndexes(infra.db);
    await MIGRATIONS.find((m) => m.id === '2026-09-27-003-run-label-indexes')!.up(infra.db);
    await expectConverged();
  });

  it('converges while the API lock-busy fallback builds the same indexes concurrently', async () => {
    const m003 = MIGRATIONS.find((m) => m.id === '2026-09-27-003-run-label-indexes')!;
    for (let round = 0; round < 10; round += 1) {
      await runs().dropIndexes();
      const results = await Promise.allSettled([m003.up(infra.db), ensureMarketRunLabelIndexes(infra.db)]);
      expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
      await expectConverged();
    }
  }, 120_000);
});
