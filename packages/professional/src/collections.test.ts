import type { Document } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { SchemaValidationError, validateDocument } from '@aptamind/db';
import { contentHash } from '@aptamind/contracts';
import { professionalCollections } from './collections';
import { PROFESSIONAL_COLLECTION_VERSIONS } from './schema-versions';
import { parseClaimValue } from './contracts/claims';
import { sampleDocuments } from './fixtures/sample-documents';
import { observationId, observationPayloadHash } from './observations/payload';

const AI_META = {
  provider: 'fixture',
  model: 'fixture-model',
  promptId: 'professional.cv_section_extract',
  promptVersion: '1',
  schemaVersion: '1',
  aiExtractionId: 'paix_1',
};

const byName = new Map(professionalCollections.map((c) => [c.name, c]));
const spec = (name: string) => {
  const s = byName.get(name);
  if (!s) throw new Error(`no spec ${name}`);
  return s;
};

/**
 * Indexes from the domain document §15, transcribed independently of the specs:
 * name → [key, unique, partialFilterExpression]. None is sparse or TTL (checked separately).
 */
const DOC_INDEXES: Record<string, Record<string, [Document, boolean, Document | undefined]>> = {
  professional_subjects: {
    by_status_created: [{ status: 1, createdAt: -1, _id: -1 }, false, undefined],
    by_created: [{ createdAt: -1, _id: -1 }, false, undefined],
    by_reference: [{ reference: 1, createdAt: -1, _id: -1 }, false, undefined],
  },
  professional_sources: {
    uniq_subject_kind_ref: [
      { subjectId: 1, kind: 1, externalRefKey: 1 },
      true,
      { externalRefKey: { $exists: true } },
    ],
    by_subject: [{ subjectId: 1, createdAt: -1, _id: -1 }, false, undefined],
  },
  professional_snapshots: {
    uniq_source_hash: [{ sourceId: 1, contentHash: 1 }, true, undefined],
    by_subject_asof: [{ subjectId: 1, sourceAsOf: -1 }, false, undefined],
    by_artifact: [{ 'artifact.artifactId': 1 }, false, undefined],
    by_source_created: [{ sourceId: 1, createdAt: -1, _id: -1 }, false, undefined],
  },
  professional_acquisitions: {
    by_snapshot: [{ snapshotId: 1, createdAt: -1 }, false, undefined],
    by_subject: [{ subjectId: 1, createdAt: -1 }, false, undefined],
  },
  professional_extractions: {
    by_snapshot_extractor: [
      { snapshotId: 1, 'extractor.name': 1, 'extractor.version': -1 },
      false,
      undefined,
    ],
    by_subject: [{ subjectId: 1, createdAt: -1 }, false, undefined],
    by_text_artifact: [
      { 'textArtifact.artifactId': 1 },
      false,
      { 'textArtifact.artifactId': { $exists: true } },
    ],
  },
  professional_observations: {
    by_subject_created: [{ subjectId: 1, createdAt: -1, _id: -1 }, false, undefined],
    by_subject_resolution: [{ subjectId: 1, 'resolution.state': 1, createdAt: 1 }, false, undefined],
    by_assertion_status: [{ 'resolution.assertionId': 1, status: 1 }, false, undefined],
    by_snapshot_extractor: [{ snapshotId: 1, 'extractor.name': 1, 'extractor.version': 1 }, false, undefined],
  },
  professional_events: {
    by_subject_time: [{ subjectId: 1, at: -1 }, false, undefined],
    by_entity_time: [{ 'entity.kind': 1, 'entity.id': 1, at: -1 }, false, undefined],
  },
  professional_review_items: {
    uniq_open_dedupe: [{ dedupeKey: 1 }, true, { status: 'open' }],
    by_status_priority: [{ status: 1, priority: -1, createdAt: 1 }, false, undefined],
    by_subject: [{ subjectId: 1, createdAt: -1 }, false, undefined],
  },
  // P5.1
  professional_career_targets: {
    by_subject_status_priority: [{ subjectId: 1, status: 1, priority: 1 }, false, undefined],
    by_subject_status_created: [{ subjectId: 1, status: 1, createdAt: -1, _id: -1 }, false, undefined],
    by_subject_created: [{ subjectId: 1, createdAt: -1, _id: -1 }, false, undefined],
  },
  professional_career_target_versions: {
    uniq_target_version: [{ targetId: 1, version: 1 }, true, undefined],
    by_subject: [{ subjectId: 1, createdAt: -1 }, false, undefined],
  },
};

describe('Professional collection specs', () => {
  it('declares exactly the P0.3 core collections (+ P5.1 career targets), all prefixed professional_', () => {
    expect([...byName.keys()].sort()).toEqual(Object.keys(DOC_INDEXES).sort());
    for (const name of byName.keys()) expect(name).toMatch(/^professional_[a-z_]+$/);
  });

  it.each(Object.keys(DOC_INDEXES))(
    '%s has the documented indexes (keys, uniqueness, partial filters)',
    (name) => {
      const actual = Object.fromEntries(
        spec(name).indexes.map((i) => [
          i.options.name,
          [i.key, Boolean(i.options.unique), i.options.partialFilterExpression],
        ]),
      );
      expect(actual).toEqual(DOC_INDEXES[name]);
      for (const i of spec(name).indexes) {
        expect(i.rationale.length).toBeGreaterThan(10);
        expect(i.options.sparse, `${i.options.name} sparse`).toBeUndefined();
        expect(i.options.expireAfterSeconds, `${i.options.name} TTL`).toBeUndefined();
      }
    },
  );

  it.each(Object.keys(DOC_INDEXES))(
    '%s has a server-side validator requiring the document meta and subjectId',
    (name) => {
      const v = spec(name).validator as Document;
      expect(v?.$jsonSchema?.bsonType).toBe('object');
      const required: string[] = v.$jsonSchema.required;
      for (const f of ['_id', 'schemaVersion', 'createdAt', 'updatedAt']) expect(required).toContain(f);
      if (name !== 'professional_subjects') expect(required).toContain('subjectId');
      expect(spec(name).schemaVersion).toBe(1);
    },
  );

  it.each(Object.keys(DOC_INDEXES))('%s validator is closed and carries id/code patterns (A-M1)', (name) => {
    const js = (spec(name).validator as Document).$jsonSchema;
    expect(js.additionalProperties).toBe(false);
    expect(js.properties._id.pattern).toMatch(/^\^p[a-z]+_/);
    if (name !== 'professional_subjects')
      expect(js.properties.subjectId.pattern).toBe('^psub_[A-Za-z0-9]+(?!\\n)$');
  });

  it('machine-code fields carry the code pattern server-side', () => {
    const CODE = '^[a-z][a-z0-9_.:-]*(?!\\n)$';
    const js = (n: string) => (spec(n).validator as Document).$jsonSchema;
    expect(js('professional_events').properties.reason.pattern).toBe(CODE);
    expect(js('professional_review_items').properties.reasonCode.pattern).toBe(CODE);
    expect(js('professional_review_items').properties.resolution.properties.reasonCode.pattern).toBe(CODE);
    expect(js('professional_extractions').properties.error.properties.code.pattern).toBe(CODE);
    expect(js('professional_observations').properties.warnings.items.pattern).toBe(CODE);
    expect(js('professional_observations').properties.quarantine.properties.reasonCode.pattern).toBe(CODE);
    expect(js('professional_sources').properties.health.properties.lastErrorCode.pattern).toBe(CODE);
    expect(js('professional_observations').properties.evidence.properties.quote.maxLength).toBe(300);
  });

  it('the sources validator refuses LinkedIn fetches and LinkedIn URLs/scopes server-side', () => {
    const nor = (spec('professional_sources').validator as Document).$nor as Document[];
    expect(nor).toContainEqual({ kind: 'linkedin_export', acquisition: 'fetch' });
    expect(nor.some((c) => c.url?.$regex)).toBe(true);
    expect(nor.some((c) => c['policy.hostScope']?.$regex)).toBe(true);
  });
});

describe('Professional document schemas (application boundary)', () => {
  const samples = sampleDocuments();

  it.each(Object.keys(DOC_INDEXES))('%s accepts its synthetic sample document', (name) => {
    expect(() => validateDocument(spec(name), samples[name as keyof typeof samples])).not.toThrow();
  });

  const invalid: Array<[string, (d: Record<string, unknown>) => Record<string, unknown>, string]> = [
    ['professional_subjects', (d) => ({ ...d, _id: 'src_1' }), 'foreign id prefix'],
    [
      'professional_subjects',
      (d) => ({ ...d, consent: { ...(d.consent as object), dataClass: 'real_personal' } }),
      'data class beyond v0.1 (FE-P2)',
    ],
    ['professional_sources', (d) => ({ ...d, kind: 'linkedin_export', acquisition: 'fetch' }), 'PL-11'],
    ['professional_sources', (d) => ({ ...d, subjectId: 'cmp_1' }), 'foreign subject id'],
    ['professional_snapshots', (d) => ({ ...d, contentHash: 'not-a-hash' }), 'content hash'],
    [
      'professional_extractions',
      (d) => ({ ...d, error: { code: 'Parser blew up on line 3' } }),
      'free-text error',
    ],
    [
      'professional_observations',
      (d) => ({ ...d, payload: { label: 'TypeScript', kind: 'skill', context: 'listed' } }),
      'payload invalid for its claim type',
    ],
    ['professional_observations', (d) => ({ ...d, claimType: 'date_of_birth' }), 'unknown claim type'],
    [
      'professional_observations',
      (d) => ({ ...d, evidence: { ...(d.evidence as object), quote: 'x'.repeat(301) } }),
      'quote > 300',
    ],
    [
      'professional_events',
      (d) => ({ ...d, reason: 'Subject said she moved to Berlin' }),
      'free-text reason',
    ],
    ['professional_review_items', (d) => ({ ...d, allowedActions: [] }), 'no allowed action'],
    ['professional_subjects', (d) => ({ ...d, reference: 'jane.doe@example.org' }), 'email as reference'],
    ['professional_subjects', (d) => ({ ...d, reference: 'Jane Doe' }), 'name as reference'],
    ['professional_sources', (d) => ({ ...d, url: 'https://www.linkedin.com/in/someone' }), 'LinkedIn URL'],
    ['professional_sources', (d) => ({ ...d, url: 'https://lnkd.in/abc' }), 'LinkedIn short URL'],
    [
      'professional_sources',
      (d) => ({ ...d, policy: { hostScope: ['uk.linkedin.com'], maxPages: 5 } }),
      'LinkedIn fetch scope',
    ],
    ['professional_sources', (d) => ({ ...d, url: 'javascript:alert(1)' }), 'non-http URL'],
    ['professional_sources', (d) => ({ ...d, notes: 'free text' }), 'unknown field'],
    [
      'professional_extractions',
      (d) => ({ ...d, extractor: { name: 'cv_structured', version: '1', kind: 'deterministic' } }),
      'string extractor version',
    ],
    [
      'professional_observations',
      (d) => ({ ...d, extractor: { kind: 'ai', name: 'cv_ai', version: 1 }, mode: 'inferred' }),
      'AI observation without AI metadata',
    ],
    [
      'professional_observations',
      (d) => ({ ...d, extractor: { kind: 'ai', name: 'cv_ai', version: 1, ai: AI_META }, mode: 'stated' }),
      'AI cannot state',
    ],
    [
      'professional_observations',
      (d) => ({ ...d, evidence: { ...(d.evidence as object), spanVerified: false } }),
      'extracted with an unverified span',
    ],
    [
      'professional_observations',
      (d) => ({
        ...d,
        evidence: {
          artifactId: (d.evidence as { artifactId: string }).artifactId,
          locator: 'x',
          spanVerified: true,
        },
      }),
      'extracted without a quote',
    ],
    [
      'professional_observations',
      (d) => ({
        ...d,
        claimType: 'preference.compensation',
        payload: { currency: 'EUR', min: 1, period: 'year', basis: 'base_salary' },
        mode: 'inferred',
      }),
      'inferred compensation',
    ],
    [
      'professional_observations',
      (d) => ({ ...d, payload: { ...(d.payload as object), proficiency: 'expert' } }),
      'extracted skill proficiency',
    ],
  ];

  it('accepts the provenance rules when they hold', () => {
    const ok = (patch: Record<string, unknown>) =>
      validateDocument(spec('professional_observations'), { ...samples.professional_observations, ...patch });
    expect(() =>
      ok({ extractor: { kind: 'ai', name: 'cv_ai', version: 1, ai: AI_META }, mode: 'inferred' }),
    ).not.toThrow();
    expect(() =>
      ok({
        payload: { ...samples.professional_observations.payload, proficiency: 'expert' },
        mode: 'stated',
      }),
    ).not.toThrow();
  });

  it('stores the normalized payload; ids hash the normalized value (A-M2)', () => {
    const raw = { label: '  TypeScript ', concept: 'typescript', kind: 'skill', context: 'listed' };
    const stored = validateDocument(spec('professional_observations'), {
      ...samples.professional_observations,
      payload: raw,
    });
    expect(stored.payload).toEqual(parseClaimValue('skill', raw));
    expect(stored.payload).toEqual(samples.professional_observations.payload);
    expect(observationPayloadHash('skill', raw)).toBe(observationPayloadHash('skill', stored.payload));
    const id = (payload: unknown) =>
      observationId({
        snapshotId: 'psnap_1',
        extractor: { name: 'x', version: 1 },
        claimType: 'skill',
        locator: 'l',
        payload,
      });
    expect(id(raw)).toBe(id(stored.payload));
    const role = {
      organization: { name: 'Acme', key: 'acme' },
      title: 'Engineer',
      titleKey: 'engineer',
      start: { year: 2019 },
      end: { open: true, asOf: '2024-01-15T00:00:00Z' },
    };
    const roleDoc = validateDocument(spec('professional_observations'), {
      ...samples.professional_observations,
      claimType: 'experience.role',
      payload: role,
    });
    expect((roleDoc.payload.end as { asOf: unknown }).asOf).toEqual(new Date('2024-01-15T00:00:00Z'));
  });

  it.each(invalid.map(([name, mutate, label]) => [name, label, mutate] as const))(
    '%s rejects: %s',
    (name, _label, mutate) => {
      const doc = mutate({ ...(samples[name as keyof typeof samples] as Record<string, unknown>) });
      expect(() => validateDocument(spec(name), doc)).toThrow(SchemaValidationError);
    },
  );

  it('validation errors on observation payloads name paths and codes, never the value', () => {
    const doc = {
      ...samples.professional_observations,
      payload: { label: 'CANARY-PAYLOAD-7f3a', concept: 5, kind: 'skill', context: 'listed' },
    };
    try {
      validateDocument(spec('professional_observations'), doc);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('payload.concept: invalid_type');
      expect((err as Error).message).not.toContain('CANARY-PAYLOAD-7f3a');
    }
  });
});

describe('collection-definition versions (never downgrade, §15)', () => {
  /**
   * A spec's fingerprint: validator plus indexes, with each compound key's field ORDER kept
   * (`{a:1,b:1}` and `{b:1,a:1}` are different indexes; canonical JSON would sort them).
   */
  const fingerprint = (s: (typeof professionalCollections)[number]) =>
    contentHash({
      validator: s.validator ?? null,
      indexes: s.indexes.map((i) => ({ key: Object.entries(i.key), options: i.options })),
    });

  /**
   * Append-only history: collection → version → fingerprint of the spec at that version. A spec
   * change needs a new version (bump `PROFESSIONAL_COLLECTION_VERSIONS`) and a new row here;
   * existing rows never change. History starts at P1.2 (versions recorded from then on).
   */
  const HISTORY: Record<string, Record<number, string>> = {
    professional_subjects: {
      2: '314bc04981f8ea843bcab0b80a494f9a52bd4ad57ce30928aed0d3b90326425d',
      3: '79d6eb910e79c3e1cffc5c717170f29b23d3d731ef5bc83e1aff21dbf7d335ca',
      4: '09afa129a277d269a95c2cf6ce0bebe2be962d01e7c197eee9817c1a0522a7ea', // P5.1: targetsRev
    },
    professional_sources: { 1: 'f2f8f16e0f207661d5dbf13b298e0201911681402c2421f8a8919a0c061d126b' },
    professional_snapshots: {
      2: 'a104fda52e2c8767124a24dd8f1a06228fced436b5012bd0e485a3fd95c2450c',
      3: 'a104fda52e2c8767124a24dd8f1a06228fced436b5012bd0e485a3fd95c2450c',
      4: '4671f6058074eb36d4ecb7e23fa667a5cd362ac297fd91dc8bf082935fc16470',
    },
    professional_acquisitions: { 1: '017108a4a579998bfaf5e7e5a1c1d7caaf6cd9a180b07a0f1b30b6311f714599' },
    professional_extractions: { 1: '261ded7c46ea95479a6a38e221cf177b6afb306770d58e8a9b6ef4ade80d9683' },
    professional_observations: {
      1: '5bb98f25cb9afea9da2fb9008063373121004c9cf8d042692585f89f0220fae9',
      2: '367778d36556fecb0cacb6c9afcd5116ef8da5954aaf4fbd581b3264353ea395',
    },
    professional_events: { 1: '99ca4bf83c88e4c17b0a8931b894e82ef506d28dc64908db9a84777b1dd2bac9' },
    professional_review_items: { 1: '0f6192a15d7ef2e009a55b426d91a686db808b58109f20378dc705f9ad09ce58' },
    professional_career_targets: { 1: '4c64cbd91abd2c222a69e4bd3a752367f99bd7020f04c2558233c073a67c79c1' },
    professional_career_target_versions: {
      1: '1a069e147e05255e84c7ea66838048ba7150059e177e181ce64f47c8e8c957bb',
    },
  };

  it('every collection has a version, and its spec matches the fingerprint recorded for it', () => {
    expect(Object.keys(PROFESSIONAL_COLLECTION_VERSIONS).sort()).toEqual(
      professionalCollections.map((c) => c.name).sort(),
    );
    for (const s of professionalCollections) {
      const version = PROFESSIONAL_COLLECTION_VERSIONS[s.name]!;
      expect(HISTORY[s.name]?.[version], `${s.name}@${version} has a history row`).toBeDefined();
      expect(fingerprint(s), `${s.name}@${version}: bump the version for a spec change`).toBe(
        HISTORY[s.name]![version],
      );
    }
  });

  it('the fingerprint keeps compound index key order', () => {
    const base = professionalCollections[0]!;
    const swapped = {
      ...base,
      indexes: base.indexes.map((i) => ({ ...i, key: Object.fromEntries(Object.entries(i.key).reverse()) })),
    };
    expect(fingerprint(swapped)).not.toBe(fingerprint(base));
  });
});
