/**
 * Professional wiring through the real composition root: the platform's migration list creates
 * the Professional collections and the `labels.subjectId` run index exactly once; a second
 * process booting on the same database applies nothing and re-applying the migration bodies is
 * harmless.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createPlatform,
  ensureProfessionalRunLabelIndex,
  MIGRATIONS,
  type Platform,
} from '@aptamind/platform';
import { buildApp } from './app';

const suffix = randomBytes(4).toString('hex');
process.env.MONGODB_DB = `t_prof_platform_${suffix}`;
process.env.QUEUE_PREFIX = `t-prof-platform-${suffix}`;
process.env.S3_BUCKET = 'aptamind-test';

const PROFESSIONAL_MIGRATIONS = [
  '2026-09-29-001-professional-collections',
  '2026-09-29-002-professional-run-label-index',
  '2026-09-30-001-professional-run-label-index-repair',
  '2026-09-30-002-professional-subject-acquisition-count',
];
const PROFESSIONAL_COLLECTIONS = [
  'professional_acquisitions',
  'professional_career_target_versions',
  'professional_career_targets',
  'professional_events',
  'professional_extractions',
  'professional_observations',
  'professional_review_items',
  'professional_schema_versions',
  'professional_snapshots',
  'professional_sources',
  'professional_subjects',
];

const platforms: Platform[] = [];
afterAll(async () => {
  await platforms[0]?.mongo.db.dropDatabase().catch(() => {});
  for (const p of platforms) await p.close().catch(() => {});
});

async function boot(): Promise<Platform> {
  const p = await createPlatform('script');
  platforms.push(p);
  await p.init();
  return p;
}

describe('Professional platform wiring', () => {
  it('migrates once, is idempotent across processes and re-application, and registers the domain', async () => {
    const a = await boot();
    const db = a.mongo.db;
    const applied = async () =>
      db
        .collection<{ _id: string; appliedAt: Date }>('_migrations')
        .find({ _id: { $in: PROFESSIONAL_MIGRATIONS } })
        .sort({ _id: 1 })
        .toArray();

    const first = await applied();
    expect(first.map((m) => m._id)).toEqual(PROFESSIONAL_MIGRATIONS);
    const names = (await db.listCollections({ name: /^professional_/ }, { nameOnly: false }).toArray())
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(PROFESSIONAL_COLLECTIONS);

    const runIndex = (await db.collection('workflow_runs').listIndexes().toArray()).find(
      (i) => i.name === 'by_label_subject',
    );
    expect(runIndex).toMatchObject({
      key: { 'labels.subjectId': 1, createdAt: -1 },
      partialFilterExpression: { 'labels.subjectId': { $exists: true } },
    });
    expect(runIndex?.sparse).toBeUndefined();

    // The helper (also used by the lock-busy fallback) is idempotent and replaces a drifted
    // definition (e.g. the earlier sparse variant).
    await ensureProfessionalRunLabelIndex(db);
    await db.collection('workflow_runs').dropIndex('by_label_subject');
    await db
      .collection('workflow_runs')
      .createIndex({ 'labels.subjectId': 1, createdAt: -1 }, { name: 'by_label_subject', sparse: true });
    // Two repairers at once (two processes booting): neither fails on the other's drop.
    await Promise.all([ensureProfessionalRunLabelIndex(db), ensureProfessionalRunLabelIndex(db)]);
    // The shared helper (ensureRunLabelIndexes) builds the replacement before dropping the sparse
    // index, so it may carry a derived name: exactly one index on the key, partial.
    const onKey = (await db.collection('workflow_runs').listIndexes().toArray()).filter(
      (i) => JSON.stringify(i.key) === JSON.stringify({ 'labels.subjectId': 1, createdAt: -1 }),
    );
    expect(onKey).toHaveLength(1);
    const repaired = onKey[0];
    expect(repaired).toMatchObject({ partialFilterExpression: { 'labels.subjectId': { $exists: true } } });
    expect(repaired?.sparse).toBeUndefined();

    // A second process on the same database applies nothing.
    await boot();
    expect(await applied()).toEqual(first);

    // Re-applying the migration bodies (lock-busy fallback, manual re-run) changes nothing.
    const indexesBefore = await Promise.all(
      PROFESSIONAL_COLLECTIONS.map((n) => db.collection(n).listIndexes().toArray()),
    );
    for (const id of PROFESSIONAL_MIGRATIONS) await MIGRATIONS.find((m) => m.id === id)!.up(db);
    const indexesAfter = await Promise.all(
      PROFESSIONAL_COLLECTIONS.map((n) => db.collection(n).listIndexes().toArray()),
    );
    expect(indexesAfter).toEqual(indexesBefore);

    // The domain is registered for capabilities and exposed to the API.
    expect(a.runtime.services.has({ key: 'professional.domain' })).toBe(true);
    expect(a.professional.ctx.db).toBe(db);
    const app = await buildApp(a); // registers the Professional route module
    try {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
