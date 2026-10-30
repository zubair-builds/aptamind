/**
 * P1.2 snapshots on a real MongoDB replica set and object storage: limits before storage,
 * content addressing (also concurrently), private artifact labels, chronology (ADR-0019),
 * Idempotency-Key replays, and the archive fence.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FixedClock, UNAUTHENTICATED_INTERNAL_OPERATOR } from '@aptamind/contracts';
import { createTestInfra, type TestInfra } from '@aptamind/testing';
import { ProfessionalError } from './api/errors';
import { DEFAULT_PROFESSIONAL_LIMITS } from './context';
import { PROFESSIONAL_ARTIFACT_LABELS } from './privacy/artifacts';
import { createProfessionalDomain, type ProfessionalDomain } from './professional-domain';
import type { UploadInput } from './sources/snapshot.service';
import { backfillSubjectAcquisitionCount } from './subjects/subject.service';

let infra: TestInfra;
let p: ProfessionalDomain;
const actor = UNAUTHENTICATED_INTERNAL_OPERATOR;
const clock = new FixedClock(new Date('2026-09-29T10:00:00Z'));
const consent = { dataClass: 'synthetic', processingBasis: 'consent', aiProcessing: 'denied' } as const;
const text = (label: string) => new TextEncoder().encode(`${label} ${randomBytes(8).toString('hex')}\n`);
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'ok';
  } catch (err) {
    return err instanceof ProfessionalError ? err.code : `unexpected:${(err as Error).name}`;
  }
};

beforeAll(async () => {
  infra = await createTestInfra('professional_p12');
  p = createProfessionalDomain({
    db: infra.db,
    clock,
    logger: infra.logger,
    artifacts: infra.artifacts,
    config: { aiModel: 'fixture', limits: { ...DEFAULT_PROFESSIONAL_LIMITS, maxUploadBytes: 64 * 1024 } },
  });
  await p.ensureReady();
});
afterAll(async () => {
  await infra?.cleanup();
});
afterEach(() => vi.restoreAllMocks());

async function cvSource(reference: string) {
  const { subject } = await p.subjects.create({ reference, consent }, actor);
  const { source } = await p.sources.register(subject._id, { kind: 'cv' }, actor);
  return { subject, source };
}
const artifactCount = () => infra.db.collection('artifacts').countDocuments({});

describe('snapshot upload', () => {
  it('stores private bytes once per source and content; re-uploads are re-acquisitions', async () => {
    const { subject, source } = await cvSource('snap-1');
    const bytes = text('cv v1');
    const a = await p.snapshots.upload(source._id, { bytes, contentType: 'text/plain' }, actor);
    expect(a.created).toBe(true);
    expect(a.snapshot).toMatchObject({
      subjectId: subject._id,
      sourceId: source._id,
      mimeType: 'text/plain',
      via: 'upload',
      sourceAsOfKind: 'acquired',
      acquisitions: 1,
    });
    expect(a.snapshot._id).toMatch(/^psnap_/);
    expect(a.snapshot.sourceAsOf).toEqual(clock.now());
    const artifact = await infra.artifacts.get(a.snapshot.artifact.artifactId);
    expect(artifact.context).toEqual({ labels: { ...PROFESSIONAL_ARTIFACT_LABELS } });
    expect(await p.ownsArtifact(artifact)).toBe(true);
    expect(new TextDecoder().decode(await p.snapshots.content(a.snapshot))).toBe(
      new TextDecoder().decode(bytes),
    );

    clock.advance(60_000);
    const b = await p.snapshots.upload(source._id, { bytes, contentType: 'text/plain' }, actor);
    expect(b).toMatchObject({ created: false, snapshot: { _id: a.snapshot._id, acquisitions: 2 } });
    expect(b.snapshot.sourceAsOf).toEqual(clock.now());
    expect(b.snapshot.firstAcquiredAt).toEqual(a.snapshot.firstAcquiredAt);
    expect(await p.snapshots.col.countDocuments({ sourceId: source._id })).toBe(1);
    expect((await p.sources.get(source._id)).stats).toMatchObject({
      snapshots: 1,
      lastAcquiredAt: clock.now(),
    });
    expect((await p.subjects.get(subject._id)).acquisitionCount).toBe(2);
    const types = (await p.events.list({ entity: { kind: 'snapshot', id: a.snapshot._id } })).map(
      (e) => e.type,
    );
    expect(types.sort()).toEqual(['snapshot.created', 'snapshot.reacquired']);
  });

  it('concurrent identical uploads converge on one snapshot, counting every acquisition', async () => {
    const { source } = await cvSource('snap-concurrent');
    const bytes = text('same cv');
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        p.snapshots.upload(source._id, { bytes, contentType: 'text/plain' }, actor),
      ),
    );
    expect(new Set(results.map((r) => r.snapshot._id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const snap = await p.snapshots.get(results[0]!.snapshot._id);
    expect(snap.acquisitions).toBe(6);
    expect(await p.snapshots.acquisitions.countDocuments({ snapshotId: snap._id })).toBe(6);
    expect((await p.sources.get(source._id)).stats.snapshots).toBe(1);
  });

  it('a first upload that loses the insert race (duplicate key) is recorded as a re-acquisition', async () => {
    const { source } = await cvSource('snap-race-lost');
    const bytes = text('raced');
    const first = await p.snapshots.upload(source._id, { bytes, contentType: 'text/plain' }, actor);
    // The loser read "no snapshot yet" before the winner committed.
    vi.spyOn(p.snapshots.col, 'findOne').mockResolvedValueOnce(null);
    const second = await p.snapshots.upload(source._id, { bytes, contentType: 'text/plain' }, actor);
    expect(second).toMatchObject({ created: false, snapshot: { _id: first.snapshot._id, acquisitions: 2 } });
  });

  it('rejects oversize, wrong type and mismatched bytes before anything is stored', async () => {
    const { source } = await cvSource('snap-limits');
    const before = await artifactCount();
    const big = new Uint8Array(64 * 1024 + 1).fill(0x61);
    expect(await code(p.snapshots.upload(source._id, { bytes: big, contentType: 'text/plain' }, actor))).toBe(
      'upload_too_large',
    );
    expect(
      await code(p.snapshots.upload(source._id, { bytes: text('x'), contentType: 'image/png' }, actor)),
    ).toBe('unsupported_media_type');
    expect(
      await code(
        p.snapshots.upload(source._id, { bytes: text('not a pdf'), contentType: 'application/pdf' }, actor),
      ),
    ).toBe('unsupported_media_type');
    const pageObjects = Array.from({ length: 51 }, (_, i) => `${i + 2} 0 obj << /Type /Page >> endobj\n`);
    const manyPages = new TextEncoder().encode(`%PDF-1.4\n${pageObjects.join('')}`);
    expect(
      await code(p.snapshots.upload(source._id, { bytes: manyPages, contentType: 'application/pdf' }, actor)),
    ).toBe('upload_too_large');
    expect(await artifactCount()).toBe(before);
    expect(await p.snapshots.col.countDocuments({ sourceId: source._id })).toBe(0);
  });

  it('refuses sources that do not take uploads', async () => {
    const { subject } = await cvSource('snap-fetch');
    const { source } = await p.sources.register(subject._id, { kind: 'github', handle: 'snap-fetch' }, actor);
    expect(
      await code(p.snapshots.upload(source._id, { bytes: text('x'), contentType: 'text/plain' }, actor)),
    ).toBe('validation_failed');
    expect(
      await code(p.snapshots.upload('psrc_missing', { bytes: text('x'), contentType: 'text/plain' }, actor)),
    ).toBe('not_found');
  });
});

describe('snapshot chronology (ADR-0019)', () => {
  const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

  it('an older document uploaded later keeps its older sourceAsOf', async () => {
    const { subject, source } = await cvSource('snap-chrono');
    const newer = await p.snapshots.upload(
      source._id,
      { bytes: text('cv 2025'), contentType: 'text/plain', declaredAsOf: d('2025-06-01') },
      actor,
    );
    clock.advance(60_000);
    const older = await p.snapshots.upload(
      source._id,
      { bytes: text('cv 2021'), contentType: 'text/plain', declaredAsOf: d('2021-03-01') },
      actor,
    );
    expect(older.snapshot).toMatchObject({ sourceAsOfKind: 'declared', sourceAsOf: d('2021-03-01') });
    const latest = await p.snapshots.col
      .find({ subjectId: subject._id })
      .sort({ sourceAsOf: -1 })
      .limit(1)
      .next();
    expect(latest?._id).toBe(newer.snapshot._id);

    // Re-uploading the older bytes (undated, or with the same date) is a re-acquisition only.
    clock.advance(60_000);
    const olderBytes = await p.snapshots.content(older.snapshot);
    const again = await p.snapshots.upload(
      source._id,
      { bytes: olderBytes, contentType: 'text/plain' },
      actor,
    );
    expect(again.snapshot).toMatchObject({ sourceAsOf: d('2021-03-01'), acquisitions: 2 });
    expect(again.snapshot.lastAcquiredAt).toEqual(clock.now());
    const same = await p.snapshots.upload(
      source._id,
      { bytes: olderBytes, contentType: 'text/plain', declaredAsOf: d('2021-03-01') },
      actor,
    );
    expect(same.snapshot).toMatchObject({ sourceAsOf: d('2021-03-01'), acquisitions: 3 });
    // A different declared date is a conflict (no silent re-dating), and nothing counts.
    for (const other of ['2022-01-01', '2020-01-01']) {
      const res = p.snapshots.upload(
        source._id,
        { bytes: olderBytes, contentType: 'text/plain', declaredAsOf: d(other) },
        actor,
      );
      await expect(res).rejects.toMatchObject({
        code: 'conflict',
        details: { reason: 'declared_date_mismatch' },
      });
    }
    expect(await p.snapshots.get(older.snapshot._id)).toMatchObject({
      sourceAsOf: d('2021-03-01'),
      acquisitions: 3,
    });
  });

  it('a declared date converts an acquired snapshot, even to an earlier date, and records what it replaced', async () => {
    const { source } = await cvSource('snap-dated');
    const bytes = text('undated then dated');
    const first = await p.snapshots.upload(source._id, { bytes, contentType: 'text/plain' }, actor);
    const acquiredAt = first.snapshot.sourceAsOf;
    clock.advance(60_000);
    const dated = await p.snapshots.upload(
      source._id,
      { bytes, contentType: 'text/plain', declaredAsOf: d('2019-02-01') },
      actor,
    );
    expect(dated.snapshot).toMatchObject({
      sourceAsOfKind: 'declared',
      sourceAsOf: d('2019-02-01'),
      declaredAsOf: d('2019-02-01'),
      previousSourceAsOf: { kind: 'acquired', value: acquiredAt, replacedAt: clock.now() },
      acquisitions: 2,
    });
    const events = await p.events.list({ entity: { kind: 'snapshot', id: first.snapshot._id } });
    expect(events.find((e) => e.type === 'snapshot.dated')).toMatchObject({
      from: 'acquired',
      to: 'declared',
      reason: 'declared_date',
    });
  });

  it('A → B → A re-acquisition makes A current again (acquired chronology)', async () => {
    const { subject, source } = await cvSource('snap-aba');
    const bytesA = text('A');
    const a = await p.snapshots.upload(source._id, { bytes: bytesA, contentType: 'text/plain' }, actor);
    clock.advance(60_000);
    const b = await p.snapshots.upload(source._id, { bytes: text('B'), contentType: 'text/plain' }, actor);
    clock.advance(60_000);
    await p.snapshots.upload(source._id, { bytes: bytesA, contentType: 'text/plain' }, actor);
    const latest = await p.snapshots.col
      .find({ subjectId: subject._id })
      .sort({ sourceAsOf: -1 })
      .limit(1)
      .next();
    expect(latest?._id).toBe(a.snapshot._id);
    expect(b.snapshot._id).not.toBe(a.snapshot._id);
  });

  it('accepts a declared date up to UTC tomorrow; rejects later dates and dates before 1950', async () => {
    const { source } = await cvSource('snap-dates');
    const today = clock.now().toISOString().slice(0, 10);
    const tomorrow = new Date(new Date(`${today}T00:00:00Z`).getTime() + 86_400_000);
    expect(
      await code(
        p.snapshots.upload(
          source._id,
          { bytes: text('t'), contentType: 'text/plain', declaredAsOf: tomorrow },
          actor,
        ),
      ),
    ).toBe('ok');
    const dayAfter = new Date(tomorrow.getTime() + 86_400_000);
    for (const declaredAsOf of [dayAfter, d('1900-01-01')])
      expect(
        await code(
          p.snapshots.upload(
            source._id,
            { bytes: text('x'), contentType: 'text/plain', declaredAsOf },
            actor,
          ),
        ),
      ).toBe('validation_failed');
  });
});

describe('snapshot idempotency and fences', () => {
  it('an Idempotency-Key replay counts once, also after an archive; any other upload is a conflict', async () => {
    const { subject, source } = await cvSource('snap-key');
    const bytes = text('keyed');
    const key = 'key-upload-0001';
    const a = await p.snapshots.upload(source._id, { bytes, contentType: 'text/plain' }, actor, key);
    const b = await p.snapshots.upload(source._id, { bytes, contentType: 'text/plain' }, actor, key);
    expect(b).toMatchObject({ created: false, snapshot: { _id: a.snapshot._id, acquisitions: 1 } });
    const conflicts: UploadInput[] = [
      { bytes: text('other'), contentType: 'text/plain' },
      { bytes, contentType: 'text/markdown' },
      { bytes, contentType: 'text/plain', declaredAsOf: new Date('2024-01-01T00:00:00Z') },
    ];
    for (const input of conflicts)
      await expect(p.snapshots.upload(source._id, input, actor, key)).rejects.toMatchObject({
        code: 'conflict',
        details: { reason: 'idempotency_key_reused' },
      });
    await p.subjects.archive(subject._id, actor);
    const c = await p.snapshots.upload(source._id, { bytes, contentType: 'text/plain' }, actor, key);
    expect(c.snapshot._id).toBe(a.snapshot._id);
    expect(await code(p.snapshots.upload(source._id, { bytes, contentType: 'text/plain' }, actor))).toBe(
      'subject_archived',
    );
    expect((await p.snapshots.get(a.snapshot._id)).acquisitions).toBe(1);
    expect(await p.snapshots.acquisitions.countDocuments({ sourceId: source._id })).toBe(1);
  });

  it('the same key with different bytes, concurrently: exactly one upload wins, the other is a conflict', async () => {
    const { source } = await cvSource('snap-key-race');
    const key = 'key-upload-race1';
    const results = await Promise.allSettled([
      p.snapshots.upload(source._id, { bytes: text('first'), contentType: 'text/plain' }, actor, key),
      p.snapshots.upload(source._id, { bytes: text('second'), contentType: 'text/plain' }, actor, key),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toMatchObject({ code: 'conflict' });
    expect(await p.snapshots.col.countDocuments({ sourceId: source._id })).toBe(1);
    expect(await p.snapshots.acquisitions.countDocuments({ sourceId: source._id })).toBe(1);
  });

  it('the same key with the same bytes, concurrently: one acquisition', async () => {
    const { subject, source } = await cvSource('snap-key-same');
    const bytes = text('same keyed');
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        p.snapshots.upload(source._id, { bytes, contentType: 'text/plain' }, actor, 'key-upload-same1'),
      ),
    );
    expect(new Set(results.map((r) => r.snapshot._id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect((await p.snapshots.get(results[0]!.snapshot._id)).acquisitions).toBe(1);
    expect(await p.snapshots.acquisitions.countDocuments({ sourceId: source._id })).toBe(1);
    expect((await p.subjects.get(subject._id)).acquisitionCount).toBe(1);
  });

  it('an upload after an archive is refused by the transactional fence, even on a stale read', async () => {
    const { subject, source } = await cvSource('snap-fence');
    const stale = await p.subjects.get(subject._id);
    await p.subjects.archive(subject._id, actor);
    vi.spyOn(p.subjects, 'get').mockResolvedValue(stale);
    expect(
      await code(p.snapshots.upload(source._id, { bytes: text('late'), contentType: 'text/plain' }, actor)),
    ).toBe('subject_archived');
    vi.restoreAllMocks();
    expect(await p.snapshots.col.countDocuments({ sourceId: source._id })).toBe(0);
    expect((await p.subjects.get(subject._id)).acquisitionCount).toBe(0);
  });

  it('a failure after the event append rolls back the snapshot and its event', async () => {
    const { subject, source } = await cvSource('snap-atomic');
    const append = p.events.append.bind(p.events);
    vi.spyOn(p.events, 'append').mockImplementationOnce(async (...args) => {
      await append(...args);
      throw new Error('injected after append');
    });
    await expect(
      p.snapshots.upload(source._id, { bytes: text('atomic'), contentType: 'text/plain' }, actor),
    ).rejects.toThrow('injected');
    expect(await p.snapshots.col.countDocuments({ sourceId: source._id })).toBe(0);
    expect(await p.events.col.countDocuments({ subjectId: subject._id, 'entity.kind': 'snapshot' })).toBe(0);
    expect((await p.subjects.get(subject._id)).acquisitionCount).toBe(0);
    expect((await p.sources.get(source._id)).stats.snapshots).toBe(0);
    expect(await p.snapshots.acquisitions.countDocuments({ sourceId: source._id })).toBe(0);
  });

  it('a failed keyed upload leaves no ledger row, so retrying the same key works', async () => {
    const { subject, source } = await cvSource('snap-atomic-key');
    const append = p.events.append.bind(p.events);
    vi.spyOn(p.events, 'append').mockImplementationOnce(async (...args) => {
      await append(...args);
      throw new Error('injected after append');
    });
    const bytes = text('atomic keyed');
    const key = 'key-atomic-up-01';
    await expect(
      p.snapshots.upload(source._id, { bytes, contentType: 'text/plain' }, actor, key),
    ).rejects.toThrow('injected');
    expect(await p.snapshots.acquisitions.countDocuments({ sourceId: source._id })).toBe(0);
    const retry = await p.snapshots.upload(source._id, { bytes, contentType: 'text/plain' }, actor, key);
    expect(retry).toMatchObject({ created: true, snapshot: { acquisitions: 1 } });
    expect(await p.snapshots.acquisitions.countDocuments({ sourceId: source._id })).toBe(1);
    expect((await p.subjects.get(subject._id)).acquisitionCount).toBe(1);
  });
});

describe('legacy subjects (widen → backfill → tighten)', () => {
  it('a subject written before P1.2 (no acquisitionCount) reads as 0, can be edited and upload', async () => {
    const { subject, source } = await cvSource('snap-legacy');
    await p.subjects.col.updateOne({ _id: subject._id }, { $unset: { acquisitionCount: '' } });
    expect((await p.subjects.get(subject._id)).acquisitionCount).toBe(0);
    const updated = await p.subjects.update(subject._id, { reference: 'snap-legacy-b' }, actor);
    expect(updated).toMatchObject({ reference: 'snap-legacy-b', acquisitionCount: 0 });
    await p.snapshots.upload(source._id, { bytes: text('legacy'), contentType: 'text/plain' }, actor);
    expect((await p.subjects.get(subject._id)).acquisitionCount).toBe(1);
  });

  it('the server validator accepts a subject without acquisitionCount (old writers mid-rollout)', async () => {
    const { subject } = await p.subjects.create({ reference: 'snap-legacy-raw', consent }, actor);
    const { _id, acquisitionCount: _drop, ...rest } = await p.subjects.get(subject._id);
    void _drop;
    await expect(
      infra.db.collection('professional_subjects').insertOne({ ...rest, _id: `${_id}x` as never }),
    ).resolves.toBeTruthy();
  });

  it('the backfill migration is idempotent', async () => {
    const { subject } = await cvSource('snap-backfill');
    await p.subjects.col.updateOne({ _id: subject._id }, { $unset: { acquisitionCount: '' } });
    expect(await backfillSubjectAcquisitionCount(infra.db)).toBeGreaterThanOrEqual(1);
    expect(await p.subjects.col.countDocuments({ acquisitionCount: { $exists: false } })).toBe(0);
    expect(await backfillSubjectAcquisitionCount(infra.db)).toBe(0);
    expect((await p.subjects.col.findOne({ _id: subject._id }))?.acquisitionCount).toBe(0);
  });
});
