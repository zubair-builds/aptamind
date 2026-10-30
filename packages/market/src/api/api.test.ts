import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { emptyCompany } from '../companies/company.service';
import { escapeRegex } from '../sources/source.service';
import { companyDto } from './dto';
import { companyListQuerySchema } from './companies';
import { jobListQuerySchema } from './jobs';
import { noQuerySchema } from './query';
import { reviewListQuerySchema } from './review';
import { sourceListQuerySchema } from './sources';
import { toWire } from './wire';
import { summaryFact } from './summary';
import { OVERRIDDEN_BY_OPERATOR } from '../reconciliation/overrides';

describe('toWire', () => {
  it('turns dates into ISO strings, defaults into optionals, and keeps enums and nesting', () => {
    const doc = z.object({
      at: z.date(),
      when: z.coerce.date().optional(),
      nested: z.object({ list: z.array(z.object({ d: z.date().nullable() })) }),
      kind: z.enum(['a', 'b']),
      tags: z.array(z.string()).default([]),
      rec: z.record(z.string(), z.date()),
    });
    const wire = toWire(doc);
    const ok = {
      at: '2026-09-29T10:00:00.000Z',
      nested: { list: [{ d: null }, { d: '2026-09-29T10:00:00.000Z' }] },
      kind: 'a',
      rec: { x: '2026-09-29T10:00:00.000Z' },
    };
    expect(wire.safeParse(ok).success).toBe(true);
    expect(wire.safeParse({ ...ok, kind: 'c' }).success).toBe(false);
    expect(wire.safeParse({ ...ok, at: new Date() }).success).toBe(false);
    expect(wire.safeParse({ ...ok, at: 'yesterday' }).success).toBe(false);
  });

  it('a stored document round-trips through JSON into its DTO', () => {
    const doc = emptyCompany('cmp_1', 'Acme Ltd', ['name:acme ltd'], new Date('2026-09-29T10:00:00Z'));
    expect(companyDto.safeParse(JSON.parse(JSON.stringify(doc))).success).toBe(true);
    expect(companyDto.safeParse(doc).success).toBe(false); // Date objects are not the wire form
  });
});

describe('escapeRegex', () => {
  it('truncates before escaping: a cut never leaves a lone trailing backslash', () => {
    const q = `${'a'.repeat(99)}.`;
    const pattern = escapeRegex(q);
    expect(pattern).toBe(`${'a'.repeat(99)}\\.`);
    const re = new RegExp(`^${pattern}`);
    expect(re.test(q)).toBe(true);
    expect(re.test(`${'a'.repeat(99)}x`)).toBe(false);
    for (const tail of ['.', '\\', '(', '[', '?', '$'])
      for (let n = 95; n <= 101; n++)
        expect(() => new RegExp(escapeRegex('b'.repeat(n) + tail))).not.toThrow();
    expect(escapeRegex('x'.repeat(300))).toHaveLength(100);
  });
});

describe('query schemas', () => {
  it('reject unknown parameters', () => {
    for (const s of [
      companyListQuerySchema,
      jobListQuerySchema,
      sourceListQuerySchema,
      reviewListQuerySchema,
    ])
      expect(s.safeParse({ bogus: '1' }).success).toBe(false);
    expect(noQuerySchema.safeParse({ view: 'x' }).success).toBe(false);
    expect(noQuerySchema.parse({})).toEqual({});
  });

  it('reject misspelt enum values', () => {
    expect(jobListQuerySchema.safeParse({ state: 'OPEN' }).success).toBe(false);
    expect(jobListQuerySchema.safeParse({ workModel: 'Remote' }).success).toBe(false);
    expect(companyListQuerySchema.safeParse({ careersStatus: 'foundd' }).success).toBe(false);
    expect(sourceListQuerySchema.safeParse({ health: 'ok' }).success).toBe(false);
    expect(reviewListQuerySchema.safeParse({ type: 'duplicate' }).success).toBe(false);
  });

  it('normalise countries and booleans; keep v1 defaults', () => {
    expect(companyListQuerySchema.parse({ sponsorCountry: 'gb', hasConflicts: 'true' })).toMatchObject({
      sponsorCountry: ['GB'],
      hasConflicts: true,
      limit: 50,
      offset: 0,
    });
    expect(companyListQuerySchema.parse({}).hasConflicts).toBeUndefined();
    expect(jobListQuerySchema.safeParse({ country: 'USA' }).success).toBe(false);
  });

  it('review status: open by default; `all` and an explicit empty value mean every status', () => {
    expect(reviewListQuerySchema.parse({}).status).toBe('open');
    expect(reviewListQuerySchema.parse({ status: 'resolved' }).status).toBe('resolved');
    expect(reviewListQuerySchema.parse({ status: 'all' }).status).toBeUndefined();
    expect(reviewListQuerySchema.parse({ status: '' }).status).toBeUndefined();
    expect(reviewListQuerySchema.safeParse({ status: 'closed' }).success).toBe(false);
  });
});

describe('jobs list v2 query', () => {
  it('title search words: tokenised like titles, longest first', async () => {
    const { titleSearchWords } = await import('./jobs');
    expect(titleSearchWords('Head of Data & Data Engineering (C++)')).toEqual([
      'engineering',
      'head',
      'data',
      'c++',
      'of',
    ]);
    expect(titleSearchWords('IT')).toEqual(['it']);
  });

  it('minConfidence takes field:level pairs; minAnnual needs exactly one currency', async () => {
    expect(
      jobListQuerySchema.parse({ minConfidence: 'workModel:medium,sponsorship:high' }).minConfidence,
    ).toEqual(['workModel:medium', 'sponsorship:high']);
    expect(jobListQuerySchema.safeParse({ minConfidence: 'salary:high' }).success).toBe(false);
    expect(jobListQuerySchema.safeParse({ minConfidence: 'workModel:unknown' }).success).toBe(false);
    expect(jobListQuerySchema.safeParse({ minConfidence: 'workModel:certain' }).success).toBe(false);
    expect(jobListQuerySchema.safeParse({ minConfidence: 'constructor:high' }).success).toBe(false);
    const { MIN_CONFIDENCE_LEVELS } = await import('./jobs');
    const { CONFIDENCE_LEVELS } = await import('@aptamind/provenance');
    expect([...MIN_CONFIDENCE_LEVELS, 'unknown'].sort()).toEqual([...CONFIDENCE_LEVELS].sort());
    for (const level of MIN_CONFIDENCE_LEVELS)
      expect(jobListQuerySchema.safeParse({ minConfidence: `workModel:${level}` }).success).toBe(true);
    expect(jobListQuerySchema.safeParse({ minAnnual: '1000' }).success).toBe(false);
    expect(jobListQuerySchema.safeParse({ minAnnual: '1000', currency: 'usd,gbp' }).success).toBe(false);
    expect(jobListQuerySchema.parse({ minAnnual: '1000', currency: 'usd' })).toMatchObject({
      minAnnual: 1000,
      currency: ['USD'],
    });
  });
});

describe('review queue v2 helpers', () => {
  const base = {
    _id: 'rev_1',
    type: 'employment_conflict',
    severity: 'medium',
    priority: 200,
    status: 'open',
    dedupeKey: 'k',
    entity: { kind: 'job', id: 'job_1' },
    subject: 's',
    reason: 'r',
    evidence: [],
    candidates: [],
    observationIds: [],
    context: { flag: 'sponsorship_conflict' },
    allowedActions: ['confirm', 'correct', 'dismiss'],
    occurrences: 1,
    schemaVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as const;

  it('target fields come from the flag, the conflict fields or the type', async () => {
    const { reviewTargetFields } = await import('./review');
    expect(reviewTargetFields(base as never)).toEqual(['sponsorship']);
    expect(
      reviewTargetFields({ ...base, context: { flag: 'work_model_structured_conflict' } } as never),
    ).toEqual(['workModel']);
    expect(reviewTargetFields({ ...base, context: { flag: 'mystery' } } as never)).toEqual([]);
    expect(
      reviewTargetFields({
        ...base,
        type: 'field_conflict',
        context: { fields: ['immigration.sponsorship', 'identity.title'] },
      } as never),
    ).toEqual(['sponsorship']);
    expect(reviewTargetFields({ ...base, type: 'salary_suspicious', context: {} } as never)).toEqual([
      'compensation',
    ]);
  });

  it('queue state and correctable descriptors', async () => {
    const { reviewCorrectable, reviewQueueState } = await import('./review');
    expect(reviewQueueState(base as never)).toBe('open');
    expect(reviewQueueState({ ...base, lastFailure: {} } as never)).toBe('failed');
    expect(reviewQueueState({ ...base, lastFailure: {}, claim: {} } as never)).toBe('resolving');
    expect(reviewQueueState({ ...base, status: 'dismissed' } as never)).toBe('dismissed');
    const job = {
      immigration: {
        sponsorship: {
          value: { status: 'unclear' },
          status: 'conflicting',
          confidence: { level: 'low', reasons: ['sources of equal authority disagree'] },
          conflicts: [{ reason: 'x' }, { reason: 'y' }],
        },
      },
      geography: {
        workModel: {
          value: 'remote',
          status: 'known',
          confidence: { level: 'high', reasons: ['provider.workplaceType'] },
          conflicts: [{ reason: 'lower authority' }],
        },
      },
    };
    const fields = reviewCorrectable(base as never, job as never);
    expect(fields[0]).toMatchObject({
      field: 'sponsorship',
      targeted: true,
      current: { value: { status: 'unclear' }, status: 'conflicting', confidence: { level: 'low' } },
    });
    expect(fields.find((f) => f.field === 'workModel')?.current).toEqual({
      value: 'remote',
      status: 'known',
      confidence: { level: 'high' },
      basis: 'provider.workplaceType',
      alternates: 1,
    });
    // A fact the entity lacks is unknown, never a bare null.
    expect(fields.find((f) => f.field === 'relocation')?.current).toEqual({
      value: null,
      status: 'unknown',
      confidence: { level: 'unknown' },
      basis: null,
      alternates: 0,
    });
    expect(reviewCorrectable({ ...base, allowedActions: ['dismiss'] } as never, job as never)).toEqual([]);
    expect(reviewCorrectable({ ...base, type: 'parser_failure' } as never, job as never)).toEqual([]);
  });
});

describe('job override fields', () => {
  it('JOB_CORRECTABLE_FIELDS, JOB_OVERRIDABLE and applyOverrides agree on fields and paths', async () => {
    const { JOB_CORRECTABLE_FIELDS } = await import('./review');
    const { JOB_OVERRIDABLE } = await import('../review/review.service');
    const { JOB_OVERRIDE_PATHS, applyOverrides } = await import('../reconciliation/job-reconciler');
    const { valueAt } = await import('./list');
    const fields = Object.keys(JOB_OVERRIDE_PATHS).sort();
    expect(Object.keys(JOB_CORRECTABLE_FIELDS).sort()).toEqual(fields);
    expect([...JOB_OVERRIDABLE].sort()).toEqual(fields);
    for (const [field, spec] of Object.entries(JOB_CORRECTABLE_FIELDS))
      expect(spec.path).toBe(JOB_OVERRIDE_PATHS[field as keyof typeof JOB_OVERRIDE_PATHS]);
    // applyOverrides writes each overridable field at exactly that path, and nothing else.
    const blank = () => ({
      identity: {},
      geography: { workModel: { value: 'onsite' } },
      immigration: {},
      employment: {},
      compensation: null,
      overrides: {} as Record<string, unknown>,
    });
    const at = new Date('2026-09-29T00:00:00Z');
    for (const [field, path] of Object.entries(JOB_OVERRIDE_PATHS)) {
      const job = blank();
      job.overrides[field] = { value: `v:${field}`, reason: 'because', actorId: 'op', at };
      applyOverrides(job as never, at, 'src_operator');
      expect(valueAt(job, `${path}.value`), field).toBe(`v:${field}`);
      expect(valueAt(job, `${path}.evidence`)).toEqual([
        { sourceId: 'src_operator', locator: 'override by op', observedAt: at, authority: 'operator' },
      ]);
      const untouched = blank();
      for (const [other, otherPath] of Object.entries(JOB_OVERRIDE_PATHS))
        if (other !== field) expect(valueAt(job, otherPath)).toEqual(valueAt(untouched, otherPath));
    }
    // Unknown and prototype keys are ignored.
    const job = blank();
    job.overrides = { title: { value: 'x', reason: 'r', actorId: 'op', at }, constructor: {} };
    applyOverrides(job as never, at, 'src_operator');
    expect(job).toEqual({ ...blank(), overrides: job.overrides });
  });
});

describe('summaryFact', () => {
  it('PR #21 M4: an operator-override system reading is not counted in alternates', () => {
    const fact = {
      value: 'explicit_no',
      status: 'known' as const,
      confidence: { level: 'high' as const, reasons: ['operator override: checked with hiring manager'] },
      conflicts: [{ reason: OVERRIDDEN_BY_OPERATOR }, { reason: 'lower authority (third_party)' }],
    };
    expect(summaryFact(fact)).toMatchObject({
      alternates: 1,
      basis: 'operator override: checked with hiring manager',
    });
    expect(summaryFact({ ...fact, conflicts: [{ reason: OVERRIDDEN_BY_OPERATOR }] }).alternates).toBe(0);
  });
});

describe('factsHash', () => {
  const doc = () => ({
    a: { value: 'x', status: 'known', confidence: { level: 'high', score: 0.9, reasons: ['r'] } },
    nested: { b: { value: { k: 1 }, status: 'known', confidence: { level: 'medium' } } },
  });
  const paths = ['a', 'nested.b', 'missing'];

  it('is deterministic and ignores what the pin does not cover (reasons, key order)', async () => {
    const { factsHash } = await import('./summary');
    const base = factsHash(doc(), paths);
    expect(factsHash(doc(), paths)).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    const d = doc();
    d.a.confidence.reasons = ['other reason'];
    expect(factsHash(d, paths)).toBe(base);
    const reordered = {
      nested: doc().nested,
      a: { confidence: doc().a.confidence, status: 'known', value: 'x' },
    };
    expect(factsHash(reordered, paths)).toBe(base);
  });

  it.each([
    ['value only', (d: ReturnType<typeof doc>) => void (d.a.value = 'y')],
    ['status only', (d: ReturnType<typeof doc>) => void (d.a.status = 'conflicting')],
    ['confidence level only', (d: ReturnType<typeof doc>) => void (d.nested.b.confidence.level = 'low')],
    ['confidence score only', (d: ReturnType<typeof doc>) => void (d.a.confidence.score = 0.91)],
    [
      'a score appearing',
      (d: ReturnType<typeof doc>) => void ((d.nested.b.confidence as { score?: number }).score = 0.5),
    ],
    [
      'a missing fact appearing',
      (d: ReturnType<typeof doc>) =>
        void ((d as Record<string, unknown>).missing = {
          value: null,
          status: 'known',
          confidence: { level: 'low' },
        }),
    ],
  ])('moves when %s changes', async (_name, change) => {
    const { factsHash } = await import('./summary');
    const d = doc();
    change(d);
    expect(factsHash(d, paths)).not.toBe(factsHash(doc(), paths));
  });
});
