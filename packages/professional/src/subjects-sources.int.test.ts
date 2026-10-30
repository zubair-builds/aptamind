/**
 * P1.1 service behaviour on a real MongoDB replica set: idempotent subject creation, consent and
 * reference changes as events, archive, source registration by kind policy (LinkedIn
 * import-only), idempotent/natural-key source registration under concurrency, and the
 * archive-vs-register race.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FixedClock, UNAUTHENTICATED_INTERNAL_OPERATOR } from '@aptamind/contracts';
import { createTestInfra, type TestInfra } from '@aptamind/testing';
import { ProfessionalError } from './api/errors';
import { DEFAULT_PROFESSIONAL_LIMITS } from './context';
import { createProfessionalDomain, type ProfessionalDomain } from './professional-domain';
import type { SubjectDoc } from './subjects/subject.schema';
import type { CreateSubjectInput } from './subjects/subject.service';

let infra: TestInfra;
let p: ProfessionalDomain;
const actor = UNAUTHENTICATED_INTERNAL_OPERATOR;
const clock = new FixedClock(new Date('2026-09-29T10:00:00Z'));
const input = (reference: string): CreateSubjectInput => ({
  reference,
  consent: { dataClass: 'synthetic', processingBasis: 'consent', aiProcessing: 'denied' },
});
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'ok';
  } catch (err) {
    return err instanceof ProfessionalError ? err.code : `unexpected:${(err as Error).name}`;
  }
};

beforeAll(async () => {
  infra = await createTestInfra('professional_p11');
  p = createProfessionalDomain({
    db: infra.db,
    clock,
    logger: infra.logger,
    artifacts: infra.artifacts,
    config: { aiModel: 'fixture', limits: { ...DEFAULT_PROFESSIONAL_LIMITS } },
  });
  await p.ensureReady();
});
afterAll(async () => {
  await infra?.cleanup();
});

describe('subjects', () => {
  it('creates with consent and a subject.created event; the same Idempotency-Key returns the same subject', async () => {
    const a = await p.subjects.create(input('op-001'), actor, 'key-subject-0001');
    expect(a.created).toBe(true);
    expect(a.subject).toMatchObject({ status: 'active', rev: 0, sourceCount: 0, reference: 'op-001' });
    expect(a.subject._id).toMatch(/^psub_/);
    expect(a.subject.consent).toMatchObject({
      dataClass: 'synthetic',
      aiProcessing: 'denied',
      recordedBy: { id: actor.id },
    });

    const b = await p.subjects.create(input('op-001'), actor, 'key-subject-0001');
    expect(b).toMatchObject({ created: false, subject: { _id: a.subject._id } });
    expect(await p.subjects.col.countDocuments({ _id: a.subject._id })).toBe(1);
    const events = await p.events.list({ subjectId: a.subject._id });
    expect(events.map((e) => e.type)).toEqual(['subject.created']);
  });

  it('concurrent creates with one key converge on one subject and one event', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => p.subjects.create(input('op-002'), actor, 'key-subject-0002')),
    );
    expect(new Set(results.map((r) => r.subject._id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await p.events.col.countDocuments({ subjectId: results[0]!.subject._id })).toBe(1);
  });

  it('refuses a reused Idempotency-Key with a different body', async () => {
    await p.subjects.create(input('op-003'), actor, 'key-subject-0003');
    expect(await code(p.subjects.create(input('op-003-other'), actor, 'key-subject-0003'))).toBe(
      'idempotency_key_reused',
    );
  });

  it('records reference and consent changes as events and fences stale edits', async () => {
    const { subject } = await p.subjects.create(input('op-004'), actor);
    const updated = await p.subjects.update(
      subject._id,
      { reference: 'op-004b', consent: { aiProcessing: 'allowed' }, expectedRev: 0 },
      actor,
    );
    expect(updated).toMatchObject({ rev: 1, reference: 'op-004b', consent: { aiProcessing: 'allowed' } });
    const events = await p.events.list({ subjectId: subject._id });
    expect(events.map((e) => [e.type, e.from, e.to])).toEqual(
      expect.arrayContaining([
        ['subject.reference_changed', undefined, undefined],
        ['subject.consent.ai_processing_changed', 'denied', 'allowed'],
      ]),
    );
    // Nothing changed: no event, no revision.
    expect((await p.subjects.update(subject._id, { reference: 'op-004b' }, actor)).rev).toBe(1);
    expect(await code(p.subjects.update(subject._id, { reference: 'op-004c', expectedRev: 0 }, actor))).toBe(
      'stale_subject_revision',
    );
  });

  it('archive is idempotent, recorded once, and makes the subject read-only', async () => {
    const { subject } = await p.subjects.create(input('op-005'), actor);
    const a = await p.subjects.archive(subject._id, actor);
    const b = await p.subjects.archive(subject._id, actor);
    expect(a.status).toBe('archived');
    expect(b.rev).toBe(a.rev);
    const types = (await p.events.list({ subjectId: subject._id })).map((e) => e.type);
    expect(types.filter((t) => t === 'subject.archived')).toHaveLength(1);
    expect(await code(p.subjects.update(subject._id, { reference: 'x-1' }, actor))).toBe('subject_archived');
    expect(await code(p.sources.register(subject._id, { kind: 'cv' }, actor))).toBe('subject_archived');
  });

  it('pages with a stable cursor', async () => {
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      clock.advance(1000);
      created.push((await p.subjects.create(input(`page-${i}`), actor)).subject._id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await p.subjects.list({ limit: 2, sort: '-createdAt', ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((s) => s._id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.filter((id) => created.includes(id))).toEqual([...created].reverse());
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe('sources', () => {
  let subjectId: string;
  beforeAll(async () => {
    subjectId = (await p.subjects.create(input('op-src'), actor)).subject._id;
  });

  it('applies the kind policy (authorship, acquisition, ownership, scope)', async () => {
    const cv = (await p.sources.register(subjectId, { kind: 'cv' }, actor)).source;
    expect(cv).toMatchObject({
      authorship: 'subject',
      acquisition: 'upload',
      ownership: { state: 'intrinsic' },
    });
    expect(cv.policy).toEqual({ hostScope: [], maxPages: DEFAULT_PROFESSIONAL_LIMITS.maxDocumentPages });
    const gh = (await p.sources.register(subjectId, { kind: 'github', handle: 'Persona-Alpha' }, actor))
      .source;
    expect(gh).toMatchObject({
      authorship: 'platform',
      acquisition: 'fetch',
      externalRefKey: 'github:persona-alpha',
      url: 'https://github.com/persona-alpha',
      policy: { hostScope: ['api.github.com'] },
      ownership: { state: 'claimed' },
    });
    const site = (
      await p.sources.register(
        subjectId,
        { kind: 'personal_website', url: 'https://Persona.Example/work/#top' },
        actor,
      )
    ).source;
    expect(site).toMatchObject({
      url: 'https://persona.example/work',
      policy: { hostScope: ['persona.example'] },
    });
    const events = await p.events.list({ entity: { kind: 'source', id: site._id } });
    expect(events.map((e) => e.type)).toEqual(['source.registered']);
  });

  it('LinkedIn is import-only: no fetch, no LinkedIn URL on any kind', async () => {
    expect(
      await code(p.sources.register(subjectId, { kind: 'linkedin_export', acquisition: 'fetch' }, actor)),
    ).toBe('linkedin_import_only');
    expect(
      await code(
        p.sources.register(
          subjectId,
          { kind: 'personal_website', url: 'https://www.linkedin.com/in/x' },
          actor,
        ),
      ),
    ).toBe('linkedin_import_only');
    expect(
      await code(
        p.sources.register(
          subjectId,
          { kind: 'portfolio', acquisition: 'fetch', url: 'https://lnkd.in/x' },
          actor,
        ),
      ),
    ).toBe('linkedin_import_only');
    const li = (await p.sources.register(subjectId, { kind: 'linkedin_export' }, actor)).source;
    expect(li).toMatchObject({ acquisition: 'upload', policy: { hostScope: [] } });
  });

  it('rejects inputs the kind does not take', async () => {
    expect(await code(p.sources.register(subjectId, { kind: 'cv', url: 'https://x.example' }, actor))).toBe(
      'validation_failed',
    );
    expect(await code(p.sources.register(subjectId, { kind: 'github' }, actor))).toBe('validation_failed');
    expect(await code(p.sources.register(subjectId, { kind: 'personal_website' }, actor))).toBe(
      'validation_failed',
    );
    expect(await code(p.sources.register(subjectId, { kind: 'cv', acquisition: 'fetch' }, actor))).toBe(
      'validation_failed',
    );
    expect(await code(p.sources.register(subjectId, { kind: 'cv', maxPages: 10_000 }, actor))).toBe(
      'validation_failed',
    );
    expect(await code(p.sources.register('psub_missing', { kind: 'cv' }, actor))).toBe('not_found');
  });

  it('the same external source registers once, also concurrently', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        p.sources.register(subjectId, { kind: 'github', handle: 'dup-handle' }, actor),
      ),
    );
    expect(new Set(results.map((r) => r.source._id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const again = await p.sources.register(subjectId, { kind: 'github', handle: 'DUP-handle' }, actor);
    expect(again).toMatchObject({ created: false, source: { _id: results[0]!.source._id } });
  });

  it('Idempotency-Key replays return the same source; another body is refused', async () => {
    const a = await p.sources.register(subjectId, { kind: 'case_study' }, actor, 'key-source-0001');
    const b = await p.sources.register(subjectId, { kind: 'case_study' }, actor, 'key-source-0001');
    expect(b).toMatchObject({ created: false, source: { _id: a.source._id } });
    expect(await code(p.sources.register(subjectId, { kind: 'certificate' }, actor, 'key-source-0001'))).toBe(
      'idempotency_key_reused',
    );
  });

  it('a key bound by a natural-key match replays that source; the hash covers the normalized input', async () => {
    const plain = await p.sources.register(subjectId, { kind: 'github', handle: 'bind-me' }, actor);
    const bound = await p.sources.register(
      subjectId,
      { kind: 'github', handle: 'Bind-Me' },
      actor,
      'key-bind-0001',
    );
    expect(bound).toMatchObject({ created: false, source: { _id: plain.source._id } });
    // Spelled differently, meaning the same: a replay, not a reuse.
    const replay = await p.sources.register(
      subjectId,
      { kind: 'github', handle: 'BIND-ME' },
      actor,
      'key-bind-0001',
    );
    expect(replay).toMatchObject({ created: false, source: { _id: plain.source._id } });
    const sourcesBefore = await p.sources.col.countDocuments({ subjectId });
    expect(
      await code(
        p.sources.register(subjectId, { kind: 'github', handle: 'other-handle' }, actor, 'key-bind-0001'),
      ),
    ).toBe('idempotency_key_reused');
    expect(await p.sources.col.countDocuments({ subjectId })).toBe(sourcesBefore);
    const stored = await p.sources.get(plain.source._id);
    expect(stored.idempotencyBindings).toHaveLength(1);

    const site = await p.sources.register(
      subjectId,
      { kind: 'personal_website', url: 'https://Norm.Example/a/' },
      actor,
      'key-bind-0002',
    );
    const again = await p.sources.register(
      subjectId,
      { kind: 'personal_website', url: 'https://norm.example/a#x' },
      actor,
      'key-bind-0002',
    );
    expect(again).toMatchObject({ created: false, source: { _id: site.source._id } });
  });

  it('sourceCount equals the registered sources; the overview counts by kind', async () => {
    const count = await p.sources.col.countDocuments({ subjectId });
    expect((await p.subjects.get(subjectId)).sourceCount).toBe(count);
    const o = await p.overview(subjectId);
    expect(o.counts.sources).toBe(count);
    expect(o.counts.sourcesByKind.github).toBe(3);
    expect(o.counts.snapshots).toBe(0);
    expect(o.events.length).toBeGreaterThan(0);
  });

  it('archive racing registration never leaves a source registered after the archive', async () => {
    for (let i = 0; i < 8; i++) {
      const { subject } = await p.subjects.create(input(`race-${i}`), actor);
      const [reg, arch] = await Promise.all([
        code(p.sources.register(subject._id, { kind: 'cv' }, actor)),
        code(p.subjects.archive(subject._id, actor)),
      ]);
      expect(arch).toBe('ok');
      expect(['ok', 'subject_archived']).toContain(reg);
      const after = await p.subjects.get(subject._id);
      const sources = await p.sources.col.countDocuments({ subjectId: subject._id });
      expect(after.sourceCount).toBe(sources);
      expect(sources).toBe(reg === 'ok' ? 1 : 0);
    }
  });

  it('an Idempotency-Key replay after an archive returns the original source (L1)', async () => {
    const { subject } = await p.subjects.create(input('replay-archived'), actor);
    const a = await p.sources.register(subject._id, { kind: 'cv' }, actor, 'key-archived-0001');
    await p.subjects.archive(subject._id, actor);
    const b = await p.sources.register(subject._id, { kind: 'cv' }, actor, 'key-archived-0001');
    expect(b).toMatchObject({ created: false, source: { _id: a.source._id } });
    expect(await code(p.sources.register(subject._id, { kind: 'cv' }, actor, 'key-archived-0002'))).toBe(
      'subject_archived',
    );
    expect(
      await code(p.sources.register(subject._id, { kind: 'case_study' }, actor, 'key-archived-0001')),
    ).toBe('idempotency_key_reused');
  });

  it('lists a subject sources by kind with cursor paging', async () => {
    const page = await p.sources.list(subjectId, { kind: 'github', limit: 1, sort: '-createdAt' });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const next = await p.sources.list(subjectId, {
      kind: 'github',
      limit: 1,
      sort: '-createdAt',
      cursor: page.nextCursor!,
    });
    expect(next.items[0]!._id).not.toBe(page.items[0]!._id);
  });
});

describe('fences and atomicity (P1.1 review)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('registration after an archive is refused by the transactional fence, even on a stale read', async () => {
    const { subject } = await p.subjects.create(input('fence-1'), actor);
    const stale: SubjectDoc = await p.subjects.get(subject._id);
    await p.subjects.archive(subject._id, actor);
    // The pre-transaction check reads the pre-archive (active) subject: only the fence decides.
    vi.spyOn(p.subjects, 'get').mockResolvedValue(stale);
    expect(await code(p.sources.register(subject._id, { kind: 'cv' }, actor))).toBe('subject_archived');
    vi.restoreAllMocks();
    expect(await p.sources.col.countDocuments({ subjectId: subject._id })).toBe(0);
    expect((await p.subjects.get(subject._id)).sourceCount).toBe(0);
    const types = (await p.events.list({ subjectId: subject._id })).map((e) => e.type);
    expect(types).not.toContain('source.registered');
  });

  it('concurrent PATCHes without expectedRev: exactly one applies, the other is stale', async () => {
    const { subject } = await p.subjects.create(input('race-patch'), actor);
    // Both updates read the same revision before either writes.
    const original = p.subjects.get.bind(p.subjects);
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((r) => (release = r));
    vi.spyOn(p.subjects, 'get').mockImplementation(async (id) => {
      const doc = await original(id);
      if (++arrived === 2) release();
      await bothRead;
      return doc;
    });
    const [a, b] = await Promise.all([
      code(p.subjects.update(subject._id, { reference: 'race-patch-a' }, actor)),
      code(p.subjects.update(subject._id, { consent: { aiProcessing: 'allowed' } }, actor)),
    ]);
    vi.restoreAllMocks();
    expect([a, b].sort()).toEqual(['ok', 'stale_subject_revision']);
    const after = await p.subjects.get(subject._id);
    expect(after.rev).toBe(1);
    const types = (await p.events.list({ subjectId: subject._id })).map((e) => e.type).sort();
    if (a === 'ok') {
      expect(after).toMatchObject({ reference: 'race-patch-a', consent: { aiProcessing: 'denied' } });
      expect(types).toEqual(['subject.created', 'subject.reference_changed']);
    } else {
      expect(after).toMatchObject({ reference: 'race-patch', consent: { aiProcessing: 'allowed' } });
      expect(types).toEqual(['subject.consent.ai_processing_changed', 'subject.created']);
    }
  });

  it('a reference-only edit leaves the consent record (recordedBy/recordedAt) unchanged', async () => {
    const { subject } = await p.subjects.create(input('consent-meta'), actor);
    clock.advance(60_000);
    const other = { ...actor, id: 'operator-2' };
    const refOnly = await p.subjects.update(
      subject._id,
      { reference: 'consent-meta-b', consent: { aiProcessing: 'denied' } },
      other,
    );
    expect(refOnly.consent).toEqual(subject.consent);
    clock.advance(60_000);
    const changed = await p.subjects.update(subject._id, { consent: { aiProcessing: 'allowed' } }, other);
    expect(changed.consent).toMatchObject({ aiProcessing: 'allowed', recordedBy: { id: 'operator-2' } });
    expect(changed.consent.recordedAt.getTime()).toBe(clock.now().getTime());
  });

  it('a failure after the event append rolls back the change and its events', async () => {
    const append = p.events.append.bind(p.events);
    const failAfterAppend = () =>
      vi.spyOn(p.events, 'append').mockImplementationOnce(async (...args) => {
        await append(...args);
        throw new Error('injected after append');
      });

    failAfterAppend();
    await expect(p.subjects.create(input('atomic-create'), actor, 'key-atomic-0001')).rejects.toThrow(
      'injected',
    );
    expect(await p.subjects.col.countDocuments({ reference: 'atomic-create' })).toBe(0);

    const { subject } = await p.subjects.create(input('atomic'), actor);
    const eventsBefore = await p.events.col.countDocuments({ subjectId: subject._id });

    failAfterAppend();
    await expect(p.subjects.update(subject._id, { reference: 'atomic-b' }, actor)).rejects.toThrow(
      'injected',
    );
    failAfterAppend();
    await expect(p.sources.register(subject._id, { kind: 'cv' }, actor)).rejects.toThrow('injected');
    failAfterAppend();
    await expect(p.subjects.archive(subject._id, actor)).rejects.toThrow('injected');

    expect(await p.events.col.countDocuments({ subjectId: subject._id })).toBe(eventsBefore);
    expect(await p.subjects.get(subject._id)).toMatchObject({
      status: 'active',
      rev: 0,
      reference: 'atomic',
      sourceCount: 0,
    });
    expect(await p.sources.col.countDocuments({ subjectId: subject._id })).toBe(0);
    const orphanCreate = await p.events.col.countDocuments({
      type: 'subject.created',
      'entity.id': { $exists: true },
    });
    expect(orphanCreate).toBe(await p.subjects.col.countDocuments({}));
  });
});
