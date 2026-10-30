/**
 * P0.3: the Professional core collections on a real MongoDB (replica set, random DB name).
 *
 * - Server-side validators reject writes that bypass the application boundary (raw `$set`s and
 *   inserts, scripts, other processes). They are the Foundation derivation of the Zod schemas
 *   (types, required fields, enums) hardened stream-locally (`professionalValidator`): id-prefix
 *   and machine-code `pattern`s, string lengths, closed top level, and `$nor` rules for LinkedIn.
 *   Zod refinements that JSON Schema cannot express (claim payload shape per claim type,
 *   provenance rules, URL parsing) are enforced at the application boundary only.
 * - Indexes on the server match the specs, and the unique ones enforce idempotency.
 * - `ensureProfessionalCollections` (the migration body and boot step) is idempotent and
 *   repairs drift without touching documents.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Collection, Document } from 'mongodb';
import { validateDocument } from '@aptamind/db';
import { createTestInfra, type TestInfra } from '@aptamind/testing';
import { professionalCollections } from './collections';
import { parseClaimValue } from './contracts/claims';
import { sampleDocuments } from './fixtures/sample-documents';
import { ensureProfessionalCollections } from './professional-domain';
import {
  ensureVersionedCollections,
  PROFESSIONAL_COLLECTION_VERSIONS,
  SCHEMA_VERSIONS_COLLECTION,
} from './schema-versions';

let infra: TestInfra;
const samples = sampleDocuments();
const specOf = (name: string) => professionalCollections.find((c) => c.name === name)!;

beforeAll(async () => {
  infra = await createTestInfra('professional_collections');
  await ensureProfessionalCollections(infra.db);
  // One real, schema-valid document per collection (validated at the application boundary first).
  for (const spec of professionalCollections) {
    const doc = validateDocument(spec, samples[spec.name as keyof typeof samples]);
    await infra.db.collection(spec.name).insertOne(doc);
  }
});
afterAll(async () => {
  await infra?.cleanup();
});

async function serverIndexes(name: string) {
  const idx = await infra.db.collection(name).listIndexes().toArray();
  return Object.fromEntries(
    idx
      .filter((i) => i.name !== '_id_')
      .map((i) => [
        i.name,
        {
          key: i.key,
          unique: Boolean(i.unique),
          partial: i.partialFilterExpression,
          sparse: Boolean(i.sparse),
          ttl: i.expireAfterSeconds,
        },
      ]),
  );
}
function specIndexes(name: string) {
  return Object.fromEntries(
    specOf(name).indexes.map((i) => [
      i.options.name,
      {
        key: i.key,
        unique: Boolean(i.options.unique),
        partial: i.options.partialFilterExpression,
        sparse: Boolean(i.options.sparse),
        ttl: i.options.expireAfterSeconds,
      },
    ]),
  );
}
async function validatorOf(name: string): Promise<Document | undefined> {
  const info = (await infra.db.listCollections({ name }).next()) as { options?: Document } | null;
  return info?.options?.validator;
}

const REJECTED = /Document failed validation/;

describe('server-side validators on Professional collections (invalid writes rejected)', () => {
  const cases: Array<[collection: string, invalid: Document[]]> = [
    [
      'professional_subjects',
      [
        { status: 'deleted' },
        { 'consent.aiProcessing': 'maybe' },
        { 'consent.dataClass': 'real_personal' },
        { reference: 5 },
        { createdBy: 'someone' },
      ],
    ],
    [
      'professional_sources',
      [
        { kind: 'myspace' },
        { acquisition: 'scrape' },
        { 'ownership.state': 'bogus' },
        { 'stats.snapshots': 'many' },
        { 'health.state': 'fine' },
      ],
    ],
    [
      'professional_snapshots',
      [{ acquisitions: 'many' }, { via: 'pigeon' }, { sourceAsOf: 'yesterday' }, { 'artifact.size': 'big' }],
    ],
    [
      'professional_extractions',
      [
        { status: 'bogus' },
        { current: 'yes' },
        { 'counts.protectedDropped': 'x' },
        { skipReason: 'bored' },
        { 'extractor.kind': 'magic' },
      ],
    ],
    [
      'professional_observations',
      [
        { claimType: 'date_of_birth' },
        { mode: 'guessed' },
        { status: 'deleted' },
        { 'resolution.state': 'bogus' },
        { 'evidence.spanVerified': 'yes' },
        { payload: 'free text' },
        { 'confidence.level': 'certain' },
      ],
    ],
    [
      'professional_events',
      [{ 'entity.kind': 'bogus' }, { at: 'now' }, { 'actor.kind': 'hacker' }, { reason: 7 }],
    ],
    [
      'professional_acquisitions',
      [{ bindingHash: 'free text' }, { snapshotId: 'art_1' }, { via: 'scrape' }, { note: 'x' }],
    ],
    [
      'professional_review_items',
      [{ status: 'bogus' }, { type: 'bogus' }, { priority: 'high' }, { allowedActions: ['explode'] }],
    ],
    [
      'professional_career_targets',
      [
        { status: 'dreaming' },
        { priority: 0 },
        { basis: 'guessed' },
        { 'spec.fit.roleFamilies': ['astronaut'] },
        // R-28: no eligibility field can be added to a target, at any depth.
        { 'spec.viability.workAuthorization': 'visa' },
        { 'spec.sponsorshipRequired': 'yes' },
        { 'spec.fit.location': 'Berlin' },
      ],
    ],
    [
      'professional_career_target_versions',
      [
        { version: 0 },
        { 'cause.kind': 'whim' },
        { 'attestation.mode': 'telepathy' },
        { 'spec.visa': 'H-1B' },
      ],
    ],
  ];

  it('covers every Professional collection', () => {
    expect(cases.map(([n]) => n).sort()).toEqual(professionalCollections.map((c) => c.name).sort());
  });

  it.each(cases)(
    '%s accepts valid writes and rejects writes that violate its schema',
    async (name, invalid) => {
      expect((await validatorOf(name))?.$jsonSchema, `${name} has a validator`).toBeTruthy();
      const col: Collection<Document> = infra.db.collection(name);
      const doc = await col.findOne({});
      expect(doc, `${name} has a real document`).not.toBeNull();
      await infra.db.command({ collMod: name, validationLevel: 'strict' });
      try {
        await col.updateOne({ _id: doc!._id }, { $set: { updatedAt: new Date() } });
        for (const $set of invalid) {
          await expect(col.updateOne({ _id: doc!._id }, { $set }), JSON.stringify($set)).rejects.toThrow(
            REJECTED,
          );
        }
        await expect(col.insertOne({ _id: `bad_${name}` as never })).rejects.toThrow(REJECTED);
      } finally {
        await infra.db.command({ collMod: name, validationLevel: 'moderate' });
      }
    },
  );
});

describe('raw writes around the application boundary (A-M1)', () => {
  let n = 0;
  /** A schema-valid document with fresh unique keys, then the patch under test. */
  const raw = (name: string, patch: Document): Document => {
    n += 1;
    const base = validateDocument(specOf(name), samples[name as keyof typeof samples]) as Document;
    const prefix = String(base._id).split('_')[0];
    const unique: Document = { _id: `${prefix}_raw${n}` };
    if (name === 'professional_review_items') unique.dedupeKey = `raw:${n}`;
    if (name === 'professional_snapshots') unique.contentHash = n.toString(16).padStart(64, '0');
    return { ...base, ...unique, ...patch };
  };
  const cases: Array<[string, string, Document]> = [
    ['professional_events', 'free-text reason', { reason: 'Subject said she moved to Berlin' }],
    ['professional_events', 'code with a trailing newline (PCRE $)', { reason: 'operator_created\n' }],
    ['professional_snapshots', 'id with a trailing newline (PCRE $)', { subjectId: 'psub_abc\n' }],
    ['professional_review_items', 'free-text reason code', { reasonCode: 'PDF was weird' }],
    ['professional_observations', 'free-text warning', { warnings: ['quote looked odd to me'] }],
    ['professional_extractions', 'free-text error code', { error: { code: 'Parser blew up on line 3' } }],
    ['professional_subjects', 'email as reference', { reference: 'jane.doe@example.org' }],
    ['professional_subjects', 'extra top-level field', { fullName: 'Jane Doe' }],
    ['professional_sources', 'extra top-level field', { notes: 'free text' }],
    ['professional_snapshots', 'wrong subject id prefix', { subjectId: 'cmp_123' }],
    ['professional_observations', 'wrong id prefix', { _id: 'obs_123' }],
    [
      'professional_observations',
      'over-long quote',
      { evidence: { artifactId: 'art_1', locator: 'x', quote: 'x'.repeat(301), spanVerified: true } },
    ],
    ['professional_sources', 'LinkedIn export fetched', { kind: 'linkedin_export', acquisition: 'fetch' }],
    ['professional_sources', 'LinkedIn URL', { url: 'https://www.LinkedIn.com/in/someone' }],
    ['professional_sources', 'LinkedIn short URL', { url: 'http://lnkd.in/abc' }],
    ['professional_sources', 'LinkedIn China URL', { url: 'https://www.linkedin.cn/in/x' }],
    ['professional_sources', 'LinkedIn CDN URL', { url: 'https://media.licdn.com/x' }],
    [
      'professional_sources',
      'LinkedIn CDN fetch scope',
      { policy: { hostScope: ['static.licdn.com'], maxPages: 5 } },
    ],
    [
      'professional_sources',
      'LinkedIn fetch scope',
      { policy: { hostScope: ['uk.linkedin.com'], maxPages: 5 } },
    ],
  ];

  it.each(cases)('%s rejects a raw insert: %s', async (name, _label, patch) => {
    await expect(infra.db.collection(name).insertOne(raw(name, patch))).rejects.toThrow(REJECTED);
  });

  it('the same raw inserts pass without the violation (the rule, not the fixture, rejects)', async () => {
    for (const name of new Set(cases.map(([n]) => n))) {
      await expect(infra.db.collection(name).insertOne(raw(name, {}))).resolves.toBeTruthy();
    }
    await expect(
      infra.db
        .collection('professional_sources')
        .insertOne(raw('professional_sources', { url: 'https://notlinkedin.com/x' })),
    ).resolves.toBeTruthy();
  });

  it('observation payloads are stored normalized (A-M2)', async () => {
    const doc = validateDocument(specOf('professional_observations'), {
      ...samples.professional_observations,
      _id: 'pobs_normalized',
      payload: { label: '  TypeScript  ', concept: 'typescript', kind: 'skill', context: 'listed' },
    });
    await infra.db.collection('professional_observations').insertOne(doc as Document);
    const stored = await infra.db
      .collection('professional_observations')
      .findOne({ _id: 'pobs_normalized' as never });
    expect(stored?.payload).toEqual(
      parseClaimValue('skill', {
        label: 'TypeScript',
        concept: 'typescript',
        kind: 'skill',
        context: 'listed',
      }),
    );
  });
});

describe('indexes', () => {
  it.each(professionalCollections.map((c) => c.name))('%s: server indexes match the spec', async (name) => {
    expect(await serverIndexes(name)).toEqual(specIndexes(name));
  });

  it('unique indexes enforce idempotency keys', async () => {
    const snap = samples.professional_snapshots;
    await expect(
      infra.db
        .collection('professional_snapshots')
        .insertOne({ ...snap, _id: 'psnap_dup' } as unknown as Document),
    ).rejects.toThrow(/E11000/);

    // Sources: unique per (subject, kind, externalRefKey) only when a ref exists.
    const src = samples.professional_sources;
    const sources = infra.db.collection('professional_sources');
    await sources.insertOne({ ...src, _id: 'psrc_ref1', kind: 'github', externalRefKey: 'k1' } as Document);
    await expect(
      sources.insertOne({ ...src, _id: 'psrc_ref2', kind: 'github', externalRefKey: 'k1' } as Document),
    ).rejects.toThrow(/E11000/);
    await sources.insertOne({ ...src, _id: 'psrc_noref2' } as Document);

    // Review items: one OPEN item per dedupe key; resolved ones do not block.
    const rv = samples.professional_review_items;
    const reviews = infra.db.collection('professional_review_items');
    await expect(reviews.insertOne({ ...rv, _id: 'prvw_dup' } as unknown as Document)).rejects.toThrow(
      /E11000/,
    );
    await reviews.insertOne({ ...rv, _id: 'prvw_old', status: 'resolved' } as unknown as Document);
  });
});

describe('migration idempotency', () => {
  it('re-running is a no-op: same validators, same indexes, documents untouched', async () => {
    const names = professionalCollections.map((c) => c.name);
    const before = await Promise.all(
      names.map(async (n) => ({
        validator: await validatorOf(n),
        indexes: await serverIndexes(n),
        docs: await infra.db.collection(n).find({}).sort({ _id: 1 }).toArray(),
      })),
    );
    await ensureProfessionalCollections(infra.db);
    await ensureProfessionalCollections(infra.db);
    const after = await Promise.all(
      names.map(async (n) => ({
        validator: await validatorOf(n),
        indexes: await serverIndexes(n),
        docs: await infra.db.collection(n).find({}).sort({ _id: 1 }).toArray(),
      })),
    );
    expect(after).toEqual(before);
  });

  it('concurrent runs converge (two processes booting at once)', async () => {
    await Promise.all([ensureProfessionalCollections(infra.db), ensureProfessionalCollections(infra.db)]);
    for (const n of professionalCollections.map((c) => c.name)) {
      expect(await serverIndexes(n)).toEqual(specIndexes(n));
    }
  });

  it('repairs drift: a dropped index and a removed validator are restored', async () => {
    await infra.db.collection('professional_observations').dropIndex('by_assertion_status');
    await infra.db.command({ collMod: 'professional_events', validator: {} });
    expect((await validatorOf('professional_events'))?.$jsonSchema).toBeUndefined();
    await ensureProfessionalCollections(infra.db);
    expect(await serverIndexes('professional_observations')).toEqual(
      specIndexes('professional_observations'),
    );
    expect(await validatorOf('professional_events')).toEqual(specOf('professional_events').validator);
  });

  it('works on a fresh database from nothing', async () => {
    const fresh = infra.mongo.client.db(`${infra.dbName}_fresh`);
    try {
      await ensureProfessionalCollections(fresh);
      const names = (await fresh.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort();
      expect(names).toEqual(
        [...professionalCollections.map((c) => c.name), SCHEMA_VERSIONS_COLLECTION].sort(),
      );
      const versions = await fresh.collection(SCHEMA_VERSIONS_COLLECTION).find({}).toArray();
      expect(Object.fromEntries(versions.map((v) => [v._id, v.version]))).toEqual(
        PROFESSIONAL_COLLECTION_VERSIONS,
      );
    } finally {
      await fresh.dropDatabase();
    }
  });

  it('the recorded version only moves forward, even when an older process read before a newer one recorded', async () => {
    const versions = infra.db.collection<{ _id: string; version: number }>(SCHEMA_VERSIONS_COLLECTION);
    const spec = professionalCollections.filter((c) => c.name === 'professional_events');
    const at = (v: number) => ({ ...PROFESSIONAL_COLLECTION_VERSIONS, professional_events: v });
    // A Db whose version read sees nothing recorded (the older process read before the newer wrote).
    const staleRead = new Proxy(infra.db, {
      get(target, prop) {
        if (prop === 'collection')
          return (name: string) => {
            const c = target.collection(name);
            if (name !== SCHEMA_VERSIONS_COLLECTION) return c;
            return new Proxy(c, {
              get: (t, k) => (k === 'find' ? () => ({ toArray: async () => [] }) : Reflect.get(t, k, t)),
            });
          };
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    try {
      await ensureVersionedCollections(infra.db, spec, at(5));
      await ensureVersionedCollections(staleRead, spec, at(4));
      expect((await versions.findOne({ _id: 'professional_events' }))?.version).toBe(5);
    } finally {
      await versions.updateOne({ _id: 'professional_events' }, { $set: { version: 0 } });
      await ensureProfessionalCollections(infra.db);
    }
  });

  it('never downgrades: an older definition leaves a newer recorded validator and indexes alone', async () => {
    const newer = { $jsonSchema: { bsonType: 'object', description: 'applied by a newer release' } };
    const versions = infra.db.collection<{ _id: string; version: number }>(SCHEMA_VERSIONS_COLLECTION);
    await infra.db.command({ collMod: 'professional_subjects', validator: newer });
    await infra.db.collection('professional_subjects').createIndex({ updatedAt: 1 }, { name: 'from_newer' });
    await versions.updateOne({ _id: 'professional_subjects' }, { $set: { version: 99 } });
    try {
      const warnings: unknown[] = [];
      const res = await ensureVersionedCollections(infra.db, undefined, undefined, (msg, data) =>
        warnings.push({ msg, data }),
      );
      expect(res.skippedNewer).toEqual(['professional_subjects']);
      expect(warnings).toEqual([
        { msg: expect.stringContaining('skipped'), data: { collections: ['professional_subjects'] } },
      ]);
      expect(await validatorOf('professional_subjects')).toEqual(newer);
      expect(Object.keys(await serverIndexes('professional_subjects'))).toContain('from_newer');
      expect((await versions.findOne({ _id: 'professional_subjects' }))?.version).toBe(99);
      // Other collections are still converged by this (current) code.
      expect(res.applied).toContain('professional_snapshots');
    } finally {
      await versions.updateOne({ _id: 'professional_subjects' }, { $set: { version: 0 } });
      await infra.db.collection('professional_subjects').dropIndex('from_newer');
      await ensureProfessionalCollections(infra.db);
    }
    expect(await validatorOf('professional_subjects')).toEqual(specOf('professional_subjects').validator);
    expect((await versions.findOne({ _id: 'professional_subjects' }))?.version).toBe(
      PROFESSIONAL_COLLECTION_VERSIONS.professional_subjects,
    );
  });
});
