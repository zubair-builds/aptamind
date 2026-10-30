/**
 * H1 (P1.2 re-verification): upgrading a P1.1 database. Migrations run before
 * `professional.ensureReady()`, so migration 002 must widen the closed P1.1 validator itself
 * before it backfills `acquisitionCount` — otherwise the `$set` fails with 121
 * (DocumentValidationFailure) and the boot mislabels it as a busy lock.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatform, MIGRATIONS, type Platform } from '@aptamind/platform';
import { subjectsCollection } from '@aptamind/professional';

const suffix = randomBytes(4).toString('hex');
process.env.MONGODB_DB = `t_prof_mig_${suffix}`;
process.env.QUEUE_PREFIX = `t-prof-mig-${suffix}`;
process.env.S3_BUCKET = 'aptamind-test';

const M002 = '2026-09-30-002-professional-subject-acquisition-count';
const platforms: Platform[] = [];
let infra: { db: Platform['mongo']['db'] };
beforeAll(async () => {
  // Connected, not initialised: the database is seeded as P1.1 left it before the real boot.
  const p = await createPlatform('api');
  platforms.push(p);
  infra = { db: p.mongo.db };
});
afterAll(async () => {
  await platforms[0]?.mongo.db.dropDatabase().catch(() => {});
  for (const p of platforms) await p.close().catch(() => {});
});

/** The P1.1 (main) subjects validator: closed, without `acquisitionCount`. */
function p11Validator() {
  const v = structuredClone(subjectsCollection.validator) as {
    $jsonSchema: { properties: Record<string, unknown>; required: string[] };
  };
  delete v.$jsonSchema.properties.acquisitionCount;
  v.$jsonSchema.required = v.$jsonSchema.required.filter((r) => r !== 'acquisitionCount');
  return v;
}

describe('migration 002 on a P1.1 database', () => {
  it('widens the validator, then backfills; recorded once and idempotent', async () => {
    await infra.db.createCollection('professional_subjects', {
      validator: p11Validator(),
      validationLevel: 'moderate',
    });
    const now = new Date();
    const actor = { kind: 'system', id: 'p11' };
    await infra.db.collection('professional_subjects').insertOne({
      _id: 'psub_legacy1' as never,
      status: 'active',
      reference: 'legacy-1',
      consent: {
        dataClass: 'synthetic',
        processingBasis: 'consent',
        aiProcessing: 'denied',
        recordedBy: actor,
        recordedAt: now,
      },
      sourceCount: 0,
      rev: 0,
      createdBy: actor,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    // The closed P1.1 validator really refuses the field (the failure mode being fixed).
    await expect(
      infra.db
        .collection('professional_subjects')
        .updateOne({ _id: 'psub_legacy1' as never }, { $set: { acquisitionCount: 0 } }),
    ).rejects.toMatchObject({ code: 121 });
    // Everything up to P1.1 is applied; only 002 is pending.
    const applied = MIGRATIONS.filter((m) => m.id !== M002);
    await infra.db.collection('_migrations').insertMany(
      applied.map((m) => ({
        _id: m.id as never,
        description: m.description,
        appliedAt: now,
        durationMs: 0,
      })),
    );

    // The real boot: migrations (under the lock), then ensureReady. A failure must surface.
    await platforms[0]!.init();
    expect(await infra.db.collection('_migrations').findOne({ _id: M002 as never })).not.toBeNull();
    expect(
      await infra.db.collection('professional_subjects').findOne({ _id: 'psub_legacy1' as never }),
    ).toMatchObject({
      acquisitionCount: 0,
    });
    // A second boot is a no-op.
    const again = await createPlatform('api');
    platforms.push(again);
    await again.init();
    expect(await infra.db.collection('_migrations').countDocuments({ _id: M002 as never })).toBe(1);
  });

  it('a real migration failure fails the boot (it is not mistaken for a busy lock)', async () => {
    const failing = {
      id: '9999-12-31-001-test-failure',
      description: 'test',
      up: async () => {
        throw new Error('injected migration failure');
      },
    };
    MIGRATIONS.push(failing);
    try {
      const p = await createPlatform('api');
      platforms.push(p);
      await expect(p.init()).rejects.toThrow('injected migration failure');
      expect(await infra.db.collection('_migrations').findOne({ _id: failing.id as never })).toBeNull();
    } finally {
      MIGRATIONS.splice(MIGRATIONS.indexOf(failing), 1);
    }
  });

  it('a held migration lock falls back to ensuring collections directly', async () => {
    const pending = {
      id: '9999-12-31-002-test-pending',
      description: 'test',
      up: async () => {
        throw new Error('must not run while another process holds the lock');
      },
    };
    MIGRATIONS.push(pending);
    const now = new Date();
    await infra.db.collection('_locks').insertOne({
      _id: 'migrations' as never,
      owner: 'other-process',
      acquiredAt: now,
      expiresAt: new Date(now.getTime() + 600_000),
    });
    try {
      const p = await createPlatform('api');
      platforms.push(p);
      // Only the fallback re-creates this index (migrations are skipped, ensureReady does not).
      await infra.db.createCollection('workflow_runs').catch((err: { codeName?: string }) => {
        if (err?.codeName !== 'NamespaceExists') throw err;
      });
      await infra.db
        .collection('workflow_runs')
        .dropIndex('by_label_subject')
        .catch((err: { codeName?: string }) => {
          if (err?.codeName !== 'IndexNotFound') throw err;
        });
      const before = await infra.db.collection('workflow_runs').listIndexes().toArray();
      expect(before.map((i) => i.name)).not.toContain('by_label_subject');
      await expect(p.init()).resolves.toBeUndefined();
      expect(await infra.db.collection('_migrations').findOne({ _id: pending.id as never })).toBeNull();
      const indexes = await infra.db.collection('workflow_runs').listIndexes().toArray();
      expect(indexes.map((i) => i.name)).toContain('by_label_subject');
    } finally {
      MIGRATIONS.splice(MIGRATIONS.indexOf(pending), 1);
      await infra.db.collection('_locks').deleteOne({ _id: 'migrations' as never });
    }
  });
});
