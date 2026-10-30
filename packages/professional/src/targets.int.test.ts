/**
 * P5.1 career targets on a real MongoDB replica set: idempotent creation, several active targets,
 * stale edits (409, nothing written), versions for every change (immutable, never deleted),
 * atomic reorders, concurrent edits / reorders / creations keeping priorities unique, archived
 * subjects refusing changes, and the subject's word outranking automation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, newId, SYSTEM_ACTOR, UNAUTHENTICATED_INTERNAL_OPERATOR } from '@aptamind/contracts';
import { validateDocument } from '@aptamind/db';
import { createTestInfra, type TestInfra } from '@aptamind/testing';
import { ProfessionalError } from './api/errors';
import { DEFAULT_PROFESSIONAL_LIMITS } from './context';
import { createProfessionalDomain, type ProfessionalDomain } from './professional-domain';
import { type CareerTargetDoc, careerTargetsCollection } from './targets/target.schema';
import type { CreateTargetInput } from './targets/target.service';

let infra: TestInfra;
let p: ProfessionalDomain;
const actor = UNAUTHENTICATED_INTERNAL_OPERATOR;
const clock = new FixedClock(new Date('2026-09-29T10:00:00Z'));
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'ok';
  } catch (err) {
    return err instanceof ProfessionalError
      ? err.code
      : `unexpected:${(err as Error).name}:${(err as Error).message}`;
  }
};
const target = (label: string, extra: Partial<CreateTargetInput> = {}): CreateTargetInput => ({
  label,
  fit: { roleFamilies: ['data_engineering'], seniority: { min: 'senior' } },
  ...extra,
});
let n = 0;
async function subject(): Promise<string> {
  n++;
  const { subject } = await p.subjects.create(
    {
      reference: `op-targets-${n}`,
      consent: { dataClass: 'synthetic', processingBasis: 'consent', aiProcessing: 'denied' },
    },
    actor,
  );
  return subject._id;
}
async function createMany(subjectId: string, labels: string[]): Promise<CareerTargetDoc[]> {
  const out: CareerTargetDoc[] = [];
  for (const l of labels) out.push((await p.targets.create(subjectId, target(l), actor)).target);
  return out;
}
async function priorities(subjectId: string) {
  const { items } = await p.targets.list(subjectId);
  return items.filter((t) => t.priority !== undefined).map((t) => [t.spec.label, t.priority]);
}

beforeAll(async () => {
  infra = await createTestInfra('professional_p51');
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

describe('creating targets', () => {
  it('several active targets per subject, each with a stable id, version 1 and the next priority', async () => {
    const s = await subject();
    const a = await p.targets.create(s, target('Data platform lead'), actor);
    const b = await p.targets.create(s, target('Analytics engineering', { status: 'paused' }), actor);
    const c = await p.targets.create(s, target('ML infrastructure'), actor);
    expect(a.target).toMatchObject({
      status: 'active',
      priority: 1,
      version: 1,
      rev: 0,
      origin: 'stated',
      basis: 'confirmed',
    });
    expect(b.target).toMatchObject({ status: 'paused', priority: 2 });
    expect(c.target).toMatchObject({ status: 'active', priority: 3 });
    expect((await p.targets.list(s, { status: 'active' })).items.length).toBe(2);
    expect(a.target.spec.viability).toEqual({ geography: [], constraints: [] });
    const { items: versions } = await p.targets.listVersions(a.target._id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version: 1,
      cause: { kind: 'created' },
      attestation: { mode: 'operator_relayed' },
    });
    const events = await p.events.list({ entity: { kind: 'career_target', id: a.target._id } });
    expect(events.map((e) => e.type)).toEqual(['target.created']);
  });

  it('Idempotency-Key: a replay returns the same target; concurrent creates converge; another body is 409', async () => {
    const s = await subject();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        p.targets.create(s, target('Staff data engineer'), actor, 'key-target-0001'),
      ),
    );
    expect(new Set(results.map((r) => r.target._id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await p.targets.versions.countDocuments({ targetId: results[0]!.target._id })).toBe(1);
    expect(await code(p.targets.create(s, target('Something else'), actor, 'key-target-0001'))).toBe(
      'idempotency_key_reused',
    );
  });

  it('concurrent creations of one subject never share a priority', async () => {
    const s = await subject();
    await Promise.all(Array.from({ length: 8 }, (_, i) => p.targets.create(s, target(`Target ${i}`), actor)));
    const prios = (await priorities(s)).map(([, pr]) => pr);
    expect(new Set(prios).size).toBe(8);
    expect([...prios].sort((x, y) => (x as number) - (y as number))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('an archived subject accepts no target changes; its targets stay readable', async () => {
    const s = await subject();
    const { target: t } = await p.targets.create(s, target('Kept'), actor);
    await p.subjects.archive(s, actor);
    expect(await code(p.targets.create(s, target('New'), actor))).toBe('subject_archived');
    expect(await code(p.targets.edit(t._id, { expectedRev: 0, label: 'Changed' }, actor))).toBe(
      'subject_archived',
    );
    expect(await code(p.targets.act(t._id, 'pause', { expectedRev: 0 }, actor))).toBe('subject_archived');
    expect((await p.targets.get(t._id)).spec.label).toBe('Kept');
  });
});

describe('editing and versions', () => {
  it('each edit is a new immutable version; an equal edit writes nothing; a stale edit is 409 with nothing written', async () => {
    const s = await subject();
    const { target: t } = await p.targets.create(s, target('Lead'), actor);
    const e1 = await p.targets.edit(
      t._id,
      { expectedRev: 0, fit: { roleFamilies: ['data_engineering'], seniority: { min: 'staff' } } },
      actor,
    );
    expect(e1).toMatchObject({ rev: 1, version: 2 });
    const same = await p.targets.edit(t._id, { expectedRev: 1, label: 'Lead' }, actor);
    expect(same).toMatchObject({ rev: 1, version: 2 });
    expect(await code(p.targets.edit(t._id, { expectedRev: 0, label: 'Stale' }, actor))).toBe(
      'stale_target_revision',
    );
    const { items: versions } = await p.targets.listVersions(t._id);
    expect(versions.map((v) => [v.version, v.cause.kind])).toEqual([
      [1, 'created'],
      [2, 'spec_edited'],
    ]);
    expect(versions[0]!.spec.fit.seniority).toEqual({ min: 'senior' });
    expect((await p.targets.get(t._id)).spec.label).toBe('Lead');
  });

  it('two concurrent edits from the same revision: exactly one wins', async () => {
    const s = await subject();
    const { target: t } = await p.targets.create(s, target('Race'), actor);
    const results = await Promise.all(
      ['A', 'B', 'C', 'D'].map((l) =>
        code(p.targets.edit(t._id, { expectedRev: 0, label: `Race ${l}` }, actor)),
      ),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'stale_target_revision')).toHaveLength(3);
    const after = await p.targets.get(t._id);
    expect(after).toMatchObject({ rev: 1, version: 2 });
    expect(await p.targets.versions.countDocuments({ targetId: t._id })).toBe(2);
  });

  it('status actions follow the lifecycle; archive drops the priority, activation takes the next one', async () => {
    const s = await subject();
    const { target: a } = await p.targets.create(s, target('A'), actor);
    const { target: b } = await p.targets.create(s, target('B'), actor);
    const paused = await p.targets.act(a._id, 'pause', { expectedRev: 0 }, actor);
    expect(paused).toMatchObject({ status: 'paused', priority: 1, version: 2 });
    const archived = await p.targets.act(a._id, 'archive', { expectedRev: 1 }, actor);
    expect(archived.status).toBe('archived');
    expect(archived.priority).toBeUndefined();
    expect(await code(p.targets.act(a._id, 'pause', { expectedRev: 2 }, actor))).toBe('illegal_transition');
    expect(await code(p.targets.act(b._id, 'accept', { expectedRev: 0 }, actor))).toBe('illegal_transition');
    const restored = await p.targets.act(a._id, 'activate', { expectedRev: 2 }, actor);
    expect(restored).toMatchObject({ status: 'active', priority: 3, version: 4 });
    const { items: history } = await p.targets.listVersions(a._id);
    expect(history.map((v) => v.status)).toEqual(['active', 'paused', 'archived', 'active']);
    const events = await p.events.list({ entity: { kind: 'career_target', id: a._id } });
    expect(
      events
        .filter((e) => e.type === 'target.status_changed')
        .map((e) => `${e.from}>${e.to}`)
        .sort(),
    ).toEqual(['active>paused', 'archived>active', 'paused>archived']);
  });
});

describe('reordering', () => {
  it('reorders atomically and versions only the targets whose priority changed', async () => {
    const s = await subject();
    const [one, two, three] = (await createMany(s, ['one', 'two', 'three'])) as [
      CareerTargetDoc,
      CareerTargetDoc,
      CareerTargetDoc,
    ];
    await p.targets.reorder(
      s,
      { order: [three, one, two].map((t) => ({ targetId: t._id, expectedRev: t.rev })) },
      actor,
    );
    expect(await priorities(s)).toEqual([
      ['three', 1],
      ['one', 2],
      ['two', 3],
    ]);
    for (const t of [one, two, three])
      expect(await p.targets.versions.countDocuments({ targetId: t._id })).toBe(2);
  });

  it('a stale revision or a missing target aborts the whole reorder: nothing is written', async () => {
    const s = await subject();
    const [a, b, c] = (await createMany(s, ['a', 'b', 'c'])) as [
      CareerTargetDoc,
      CareerTargetDoc,
      CareerTargetDoc,
    ];
    await p.targets.edit(c._id, { expectedRev: 0, label: 'c2' }, actor);
    expect(
      await code(
        p.targets.reorder(s, { order: [c, b, a].map((t) => ({ targetId: t._id, expectedRev: 0 })) }, actor),
      ),
    ).toBe('stale_target_revision');
    expect(
      await code(
        p.targets.reorder(s, { order: [b, a].map((t) => ({ targetId: t._id, expectedRev: 0 })) }, actor),
      ),
    ).toBe('target_order_mismatch');
    expect(await priorities(s)).toEqual([
      ['a', 1],
      ['b', 2],
      ['c2', 3],
    ]);
    expect(await p.targets.versions.countDocuments({ targetId: a._id })).toBe(1);
  });

  it('concurrent reorders and creations keep priorities unique and contiguous for the reordered set', async () => {
    const s = await subject();
    const ts = await createMany(s, ['p', 'q', 'r']);
    const orders = [
      [2, 1, 0],
      [1, 0, 2],
      [0, 2, 1],
    ].map((idx) => idx.map((i) => ({ targetId: ts[i]!._id, expectedRev: 0 })));
    const results = await Promise.all([
      ...orders.map((order) => code(p.targets.reorder(s, { order }, actor))),
      code(p.targets.create(s, target('s'), actor)),
    ]);
    expect(results.filter((r) => r === 'ok').length).toBeGreaterThanOrEqual(1);
    for (const r of results) expect(['ok', 'stale_target_revision', 'target_order_mismatch']).toContain(r);
    const prios = (await priorities(s)).map(([, pr]) => pr as number);
    expect(new Set(prios).size).toBe(prios.length);
  });
});

describe('the subject outranks automation', () => {
  it('automation cannot state, edit, transition or reorder targets the subject stated', async () => {
    const s = await subject();
    const { target: t } = await p.targets.create(s, target('Stated'), actor);
    expect(await code(p.targets.create(s, target('Robot'), SYSTEM_ACTOR))).toBe('illegal_transition');
    expect(await code(p.targets.edit(t._id, { expectedRev: 0, label: 'Robot edit' }, SYSTEM_ACTOR))).toBe(
      'illegal_transition',
    );
    for (const action of ['pause', 'archive', 'activate'] as const)
      expect(await code(p.targets.act(t._id, action, { expectedRev: 0 }, SYSTEM_ACTOR))).toBe(
        'illegal_transition',
      );
    expect(
      await code(
        p.targets.reorder(
          s,
          { order: [{ targetId: t._id, expectedRev: 0 }] },
          { kind: 'workflow', id: 'run_1' },
        ),
      ),
    ).toBe('illegal_transition');
    expect(await p.targets.get(t._id)).toMatchObject({ rev: 0, version: 1, spec: { label: 'Stated' } });
  });
});

describe('collections', () => {
  it('the server-side validator refuses an eligibility field in a target spec (R-28)', async () => {
    const s = await subject();
    const { target: t } = await p.targets.create(s, target('Guarded'), actor);
    await expect(
      p.targets.col.updateOne({ _id: t._id }, { $set: { 'spec.viability.workAuthorization': 'visa' } }),
    ).rejects.toThrow();
    await expect(
      p.targets.col.updateOne({ _id: t._id }, { $set: { 'spec.sponsorship': 'yes' } }),
    ).rejects.toThrow();
  });
});

// ------------------------------------------------------------------------------------------------
// PR #26 review fixes.

/** Inserts a target document directly (e.g. a P5.2 proposal, or history), validated first. */
async function seed(subjectId: string, over: Partial<CareerTargetDoc>): Promise<CareerTargetDoc> {
  const now = clock.now();
  const doc = validateDocument(careerTargetsCollection, {
    _id: newId('ptgt'),
    subjectId,
    status: 'proposed',
    spec: {
      label: 'Seeded',
      fit: { roleFamilies: ['data_engineering'], seniority: {} },
      viability: { geography: [], constraints: [] },
    },
    origin: 'proposal',
    basis: 'inferred',
    rev: 0,
    version: 1,
    createdBy: { kind: 'workflow', id: 'run_proposer' },
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    ...over,
  });
  await p.targets.col.insertOne(doc);
  return doc;
}
const proposer = { kind: 'workflow' as const, id: 'run_proposer' };

describe('automation never overwrites the subject (B-M1)', () => {
  it('automation edits only its own untouched proposal; a subject edit makes it subject-owned', async () => {
    const s = await subject();
    const prop = await seed(s, {});
    const own = await p.targets.edit(prop._id, { expectedRev: 0, label: 'Proposal v2' }, proposer);
    expect(own).toMatchObject({ status: 'proposed', rev: 1 });
    expect(
      await code(
        p.targets.edit(
          prop._id,
          { expectedRev: 1, label: 'Other robot' },
          { kind: 'workflow', id: 'run_other' },
        ),
      ),
    ).toBe('illegal_transition');
    const byOperator = await p.targets.edit(prop._id, { expectedRev: 1, label: 'Subject wording' }, actor);
    expect(byOperator).toMatchObject({ status: 'proposed', subjectEdited: true, basis: 'inferred', rev: 2 });
    expect(await code(p.targets.edit(prop._id, { expectedRev: 2, label: 'Robot again' }, proposer))).toBe(
      'illegal_transition',
    );
    expect((await p.targets.get(prop._id)).spec.label).toBe('Subject wording');
    const { items: versions } = await p.targets.listVersions(prop._id);
    expect(versions.at(-1)).toMatchObject({ subjectEdited: true, attestation: { mode: 'operator_relayed' } });
  });

  it('a stale client gets 409 before any legality verdict', async () => {
    const s = await subject();
    const { target: t } = await p.targets.create(s, target('Stale first'), actor);
    await p.targets.edit(t._id, { expectedRev: 0, label: 'Moved on' }, actor);
    expect(await code(p.targets.act(t._id, 'accept', { expectedRev: 0 }, actor))).toBe(
      'stale_target_revision',
    );
    expect(await code(p.targets.edit(t._id, { expectedRev: 0, label: 'x' }, SYSTEM_ACTOR))).toBe(
      'stale_target_revision',
    );
  });
});

describe('the cap counts open targets only; history is paged (B-M2)', () => {
  it('archived and declined targets do not count towards the 100 cap', async () => {
    const s = await subject();
    for (let i = 0; i < 100; i++)
      await seed(s, { status: i % 2 ? 'archived' : 'declined', origin: 'stated', basis: 'confirmed' });
    expect((await p.targets.create(s, target('Still allowed'), actor)).created).toBe(true);
    for (let i = 0; i < 98; i++) await seed(s, {});
    expect((await p.targets.create(s, target('The 100th open'), actor)).created).toBe(true);
    expect(await code(p.targets.create(s, target('One too many'), actor))).toBe('target_limit_reached');
  });

  it('lists open targets by default and pages archived / declined / all history with a cursor', async () => {
    const s = await subject();
    await createMany(s, ['open-1', 'open-2']);
    for (let i = 0; i < 5; i++) {
      clock.advance(1000);
      await seed(s, {
        status: 'archived',
        origin: 'stated',
        basis: 'confirmed',
        spec: {
          label: `old-${i}`,
          fit: { roleFamilies: ['design'], seniority: {} },
          viability: { geography: [], constraints: [] },
        },
      });
    }
    const open = await p.targets.list(s);
    expect(open.items.map((t) => t.spec.label)).toEqual(['open-1', 'open-2']);
    expect(open.nextCursor).toBeNull();
    const first = await p.targets.list(s, { status: 'archived', limit: 2 });
    expect(first.items.map((t) => t.spec.label)).toEqual(['old-4', 'old-3']);
    const second = await p.targets.list(s, { status: 'archived', limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((t) => t.spec.label)).toEqual(['old-2', 'old-1']);
    expect((await p.targets.list(s, { status: 'all', limit: 100 })).items).toHaveLength(7);
    await expect(p.targets.list(s, { limit: 2 })).rejects.toThrow(/status=archived\|declined\|all/);
  });
});

describe('fences under concurrency (A-L1, A-L2)', () => {
  it('reorder on an archived subject is refused; two successive reorders record two sets of events', async () => {
    const s = await subject();
    const [x, y] = (await createMany(s, ['x', 'y'])) as [CareerTargetDoc, CareerTargetDoc];
    await p.targets.reorder(
      s,
      { order: [y, x].map((t) => ({ targetId: t._id, expectedRev: t.rev })) },
      actor,
    );
    const after = (await p.targets.list(s)).items;
    await p.targets.reorder(
      s,
      {
        order: after
          .slice()
          .reverse()
          .map((t) => ({ targetId: t._id, expectedRev: t.rev })),
      },
      actor,
    );
    const reordered = await p.events.col.countDocuments({ subjectId: s, type: 'target.reordered' });
    expect(reordered).toBe(4);
    await p.subjects.archive(s, actor);
    const now = (await p.targets.list(s)).items;
    expect(
      await code(
        p.targets.reorder(s, { order: now.map((t) => ({ targetId: t._id, expectedRev: t.rev })) }, actor),
      ),
    ).toBe('subject_archived');
  });

  it('an empty reorder of a subject without ranked targets is a no-op', async () => {
    const s = await subject();
    expect(await p.targets.reorder(s, { order: [] }, actor)).toEqual([]);
    await createMany(s, ['ranked']);
    expect(await code(p.targets.reorder(s, { order: [] }, actor))).toBe('target_order_mismatch');
  });

  it('six concurrent activations of archived targets take six distinct priorities', async () => {
    const s = await subject();
    const ts = await createMany(s, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
    const archived = [];
    for (const t of ts) archived.push(await p.targets.act(t._id, 'archive', { expectedRev: t.rev }, actor));
    const results = await Promise.all(
      archived.map((t) => code(p.targets.act(t._id, 'activate', { expectedRev: t.rev }, actor))),
    );
    expect(results).toEqual(Array(6).fill('ok'));
    const prios = (await priorities(s)).map(([, pr]) => pr as number);
    expect(new Set(prios).size).toBe(6);
  });

  it('versions are paged with a cursor (default 50)', async () => {
    const s = await subject();
    let { target: t } = await p.targets.create(s, target('v'), actor);
    for (let i = 0; i < 4; i++)
      t = await p.targets.edit(t._id, { expectedRev: t.rev, label: `v${i}` }, actor);
    const first = await p.targets.listVersions(t._id, { limit: 2 });
    expect(first.items.map((v) => v.version)).toEqual([1, 2]);
    const rest = await p.targets.listVersions(t._id, { limit: 2, cursor: first.nextCursor! });
    expect(rest.items.map((v) => v.version)).toEqual([3, 4]);
    expect((await p.targets.listVersions(t._id)).items).toHaveLength(5);
    expect((await p.targets.listVersions(t._id)).limit).toBe(50);
  });
});

describe('re-opening respects the open cap (PR #26 re-verify High)', () => {
  const openCount = (s: string) =>
    p.targets.col.countDocuments({ subjectId: s, status: { $in: ['proposed', 'active', 'paused'] } });

  /** `n` open targets in a status mix: active and paused (ranked, unique priorities) and proposed. */
  async function seedOpenMix(s: string, n: number): Promise<void> {
    for (let i = 1; i <= n; i++) {
      const status = i % 3 === 0 ? 'proposed' : i % 3 === 1 ? 'active' : 'paused';
      await seed(
        s,
        status === 'proposed' ? {} : { status, priority: i, origin: 'stated', basis: 'confirmed' },
      );
    }
  }

  it('activating an archived target is refused at 100 open targets (active, paused and proposed count)', async () => {
    const s = await subject();
    await seedOpenMix(s, 100);
    const archived = await seed(s, { status: 'archived', origin: 'stated', basis: 'confirmed' });
    expect(await code(p.targets.create(s, target('101st'), actor))).toBe('target_limit_reached');
    expect(await code(p.targets.act(archived._id, 'activate', { expectedRev: 0 }, actor))).toBe(
      'target_limit_reached',
    );
    expect(await openCount(s)).toBe(100);
    expect((await p.targets.get(archived._id)).status).toBe('archived');
  });

  it('six concurrent activations at 99 open targets: exactly one succeeds, never more than 100 open', async () => {
    const s = await subject();
    await seedOpenMix(s, 99);
    const archived = [];
    for (let i = 0; i < 6; i++)
      archived.push(await seed(s, { status: 'archived', origin: 'stated', basis: 'confirmed' }));
    const results = await Promise.all(
      archived.map((t) => code(p.targets.act(t._id, 'activate', { expectedRev: 0 }, actor))),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'target_limit_reached')).toHaveLength(5);
    expect(await openCount(s)).toBe(100);
    const { items } = await p.targets.list(s);
    expect(items).toHaveLength(100);
    const ranked = items.filter((t) => t.priority !== undefined).map((t) => t.priority);
    expect(new Set(ranked).size).toBe(ranked.length);
  });

  it('the open list is sorted in the database before any limit and never exceeds the cap', async () => {
    const s = await subject();
    // 110 open targets written around the service (e.g. legacy data): the list stays bounded and
    // deterministic — active by priority, then paused by priority, then proposed newest first. The
    // proposed ones are inserted oldest first, so a limit applied before the sort would keep the
    // oldest and drop the newest.
    for (let i = 1; i <= 60; i++)
      await seed(s, { status: 'active', priority: i, origin: 'stated', basis: 'confirmed' });
    for (let i = 61; i <= 70; i++)
      await seed(s, { status: 'paused', priority: i, origin: 'stated', basis: 'confirmed' });
    const proposedIds: string[] = [];
    for (let i = 0; i < 40; i++) {
      clock.advance(1000);
      proposedIds.push((await seed(s, {}))._id);
    }
    const items = await p.targets.open(s);
    expect(items).toHaveLength(100);
    expect(items.slice(0, 60).map((t) => t.priority)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(items.slice(60, 70).every((t) => t.status === 'paused')).toBe(true);
    const proposed = items.slice(70);
    expect(proposed.every((t) => t.status === 'proposed')).toBe(true);
    // The 30 newest proposals are kept, newest first; the 10 oldest are the ones dropped.
    expect(proposed.map((t) => t._id)).toEqual(proposedIds.slice(10).reverse());
    expect(items.every((t) => !('_order' in t))).toBe(true);
  });
});
