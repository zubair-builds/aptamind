/**
 * P5.1 HTTP contract for career targets (`/api/professional/…/targets`): sensitive viability data
 * off by default (R-30), stale edits 409, atomic reorder, versions and diffs, and the PII canary:
 * no log line written while serving these requests contains the canary carried in a target's
 * viability part or rationale.
 */
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@aptamind/observability';
import { createPlatform, type Platform } from '@aptamind/platform';
import { createProfessionalDomain } from '@aptamind/professional';
import { buildApp } from './app';

const suffix = randomBytes(4).toString('hex');
process.env.MONGODB_DB = `t_prof_tgt_${suffix}`;
process.env.QUEUE_PREFIX = `t-prof-tgt-${suffix}`;
process.env.S3_BUCKET = 'aptamind-test';

const CANARY = `canary${randomBytes(5).toString('hex')}`;
const lines: string[] = [];
const logger = createLogger({
  service: 'prof-targets-test',
  level: 'trace',
  destination: new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  }),
});

let platform: Platform;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  platform = await createPlatform('api');
  await platform.init();
  const professional = createProfessionalDomain({ ...platform.professional.ctx, logger });
  app = await buildApp({ ...platform, logger, professional });
});
afterAll(async () => {
  await app?.close();
  await platform?.mongo.db.dropDatabase().catch(() => {});
  await platform?.close();
});

const inject = (
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
  headers?: Record<string, string>,
) => app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}), headers });

const fit = { roleFamilies: ['data_engineering'], seniority: { min: 'senior' } };
const viability = {
  geography: [{ scope: 'city', code: 'DE', city: CANARY, mode: 'live_in' }],
  workModels: { acceptable: ['hybrid'] },
  compensation: { currency: 'EUR', min: 90000, period: 'year', basis: 'base_salary' },
  constraints: [{ kind: 'other', value: `needs ${CANARY}`, strength: 'hard' }],
};

describe('career targets API', () => {
  let subjectId: string;
  let a: { _id: string; rev: number };
  let b: { _id: string; rev: number };

  beforeAll(async () => {
    const res = await inject('POST', '/api/professional/subjects', {
      reference: `op-tgt-${suffix}`,
      consent: { dataClass: 'synthetic', processingBasis: 'consent', aiProcessing: 'denied' },
    });
    subjectId = res.json().subject._id;
  });

  it('creates targets; viability and rationale need include=sensitive to be written and read', async () => {
    const refused = await inject('POST', `/api/professional/subjects/${subjectId}/targets`, {
      label: 'Data platform lead',
      fit,
      viability,
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('sensitive_not_included');

    const created = await inject(
      'POST',
      `/api/professional/subjects/${subjectId}/targets?include=sensitive`,
      { label: 'Data platform lead', fit, viability, rationale: `move to ${CANARY}` },
      { 'idempotency-key': `tgt-key-${suffix}` },
    );
    expect(created.statusCode).toBe(201);
    expect(created.json().target).toMatchObject({
      status: 'active',
      priority: 1,
      version: 1,
      sensitive: 'included',
    });
    expect(created.json().target.spec.viability.geography[0].city).toBe(CANARY);
    a = created.json().target;

    const replay = await inject(
      'POST',
      `/api/professional/subjects/${subjectId}/targets?include=sensitive`,
      { label: 'Data platform lead', fit, viability, rationale: `move to ${CANARY}` },
      { 'idempotency-key': `tgt-key-${suffix}` },
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ created: false, target: { _id: a._id } });

    const second = await inject('POST', `/api/professional/subjects/${subjectId}/targets`, {
      label: 'Analytics engineering',
      fit: { roleFamilies: ['data_analytics'], seniority: {} },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().target).toMatchObject({ priority: 2, sensitive: 'omitted' });
    b = second.json().target;
  });

  it('refuses sensitive input without include=sensitive before validating it', async () => {
    const res = await inject('POST', `/api/professional/subjects/${subjectId}/targets`, {
      label: 'Malformed',
      fit,
      viability: { geography: 'nowhere' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('sensitive_not_included');
  });

  it('keeps the ranking fence internal and counts open targets on the subject overview', async () => {
    const reference = `op-overview-${suffix}`;
    const created = await inject('POST', '/api/professional/subjects', {
      reference,
      consent: { dataClass: 'synthetic', processingBasis: 'consent', aiProcessing: 'denied' },
    });
    const sid = created.json().subject._id;
    for (const label of ['One', 'Two', 'Three'])
      await inject('POST', `/api/professional/subjects/${sid}/targets`, { label, fit });
    const third = (await inject('GET', `/api/professional/subjects/${sid}/targets`)).json().items[2];
    await inject('POST', `/api/professional/targets/${third._id}/archive`, { expectedRev: third.rev });
    const overview = await inject('GET', `/api/professional/subjects/${sid}`);
    expect(overview.json().subject).not.toHaveProperty('targetsRev');
    expect(overview.json().counts.targets).toBe(2);
    const list = await inject('GET', `/api/professional/subjects?reference=${reference}`);
    expect(list.json().items[0]).not.toHaveProperty('targetsRev');
  });

  it('activating an archived target at 100 open targets is 409 target_limit_reached', async () => {
    const created = await inject('POST', '/api/professional/subjects', {
      reference: `op-cap-${suffix}`,
      consent: { dataClass: 'synthetic', processingBasis: 'consent', aiProcessing: 'denied' },
    });
    const sid = created.json().subject._id;
    const first = (
      await inject('POST', `/api/professional/subjects/${sid}/targets`, { label: 'T0', fit })
    ).json().target;
    for (let i = 1; i < 100; i++) {
      const res = await inject('POST', `/api/professional/subjects/${sid}/targets`, { label: `T${i}`, fit });
      expect(res.statusCode).toBe(201);
    }
    const full = await inject('POST', `/api/professional/subjects/${sid}/targets`, { label: 'Over', fit });
    expect(full.statusCode).toBe(409);
    expect(full.json().error.code).toBe('target_limit_reached');
    const archived = (
      await inject('POST', `/api/professional/targets/${first._id}/archive`, { expectedRev: first.rev })
    ).json().target;
    expect(
      (await inject('POST', `/api/professional/subjects/${sid}/targets`, { label: 'Refill', fit }))
        .statusCode,
    ).toBe(201);
    const reopen = await inject('POST', `/api/professional/targets/${archived._id}/activate`, {
      expectedRev: archived.rev,
    });
    expect(reopen.statusCode).toBe(409);
    expect(reopen.json().error).toMatchObject({
      code: 'target_limit_reached',
      message: full.json().error.message,
    });
  });

  it('omits sensitive parts by default on every read', async () => {
    const reads = [
      `/api/professional/subjects/${subjectId}/targets`,
      `/api/professional/targets/${a._id}`,
      `/api/professional/targets/${a._id}/versions`,
      `/api/professional/targets/${a._id}/versions/1`,
    ];
    for (const url of reads) {
      const res = await inject('GET', url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain(CANARY);
      expect(res.body, url).not.toContain('"viability"');
      expect(res.body, url).not.toContain('"compensation"');
    }
    const list = (await inject('GET', `/api/professional/subjects/${subjectId}/targets`)).json();
    expect(list.items.map((t: { spec: { label: string } }) => t.spec.label)).toEqual([
      'Data platform lead',
      'Analytics engineering',
    ]);
    const full = await inject('GET', `/api/professional/targets/${a._id}?include=sensitive`);
    expect(full.json().target.spec.viability.compensation.min).toBe(90000);
    expect(full.json().target.sensitive).toBe('included');
    expect((await inject('GET', `/api/professional/targets/${a._id}?include=everything`)).statusCode).toBe(
      400,
    );
  });

  it('edits with expectedRev; a stale edit is 409 and writes nothing; diffs hide sensitive values by default', async () => {
    const edited = await inject('PATCH', `/api/professional/targets/${a._id}?include=sensitive`, {
      expectedRev: 0,
      fit: { roleFamilies: ['data_engineering'], seniority: { min: 'staff' } },
      viability: { ...viability, workModels: { acceptable: ['remote'] } },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().target).toMatchObject({ rev: 1, version: 2 });

    const stale = await inject('PATCH', `/api/professional/targets/${a._id}`, {
      expectedRev: 0,
      label: 'Stale',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('stale_target_revision');

    const diff = await inject('GET', `/api/professional/targets/${a._id}/diff?from=1&to=2`);
    expect(diff.statusCode).toBe(200);
    expect(diff.json().changes).toEqual([
      { path: 'spec.fit.seniority', from: { min: 'senior' }, to: { min: 'staff' } },
      { path: 'spec.viability.workModels', sensitive: true },
    ]);
    const versions = (await inject('GET', `/api/professional/targets/${a._id}/versions`)).json().items;
    expect(versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    a = edited.json().target;
  });

  it('reorders atomically and moves targets through their lifecycle', async () => {
    const bad = await inject('POST', `/api/professional/subjects/${subjectId}/targets/reorder`, {
      order: [{ targetId: b._id, expectedRev: b.rev }],
    });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error.code).toBe('target_order_mismatch');

    const ok = await inject('POST', `/api/professional/subjects/${subjectId}/targets/reorder`, {
      order: [
        { targetId: b._id, expectedRev: b.rev },
        { targetId: a._id, expectedRev: a.rev },
      ],
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().items.map((t: { _id: string; priority: number }) => [t._id, t.priority])).toEqual([
      [b._id, 1],
      [a._id, 2],
    ]);
    const current = ok.json().items[1];
    const paused = await inject('POST', `/api/professional/targets/${a._id}/pause`, {
      expectedRev: current.rev,
    });
    expect(paused.json().target.status).toBe('paused');
    const illegal = await inject('POST', `/api/professional/targets/${a._id}/accept`, {
      expectedRev: paused.json().target.rev,
    });
    expect(illegal.statusCode).toBe(400);
    expect(illegal.json().error.code).toBe('illegal_transition');
    const detail = (await inject('GET', `/api/professional/targets/${a._id}`)).json();
    expect(detail.events.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining([
        'target.created',
        'target.spec_edited',
        'target.reordered',
        'target.status_changed',
      ]),
    );
  });

  it('404s for an unknown target and 400s for a malformed id', async () => {
    expect((await inject('GET', '/api/professional/targets/ptgt_unknown')).statusCode).toBe(404);
    expect((await inject('GET', '/api/professional/targets/psub_wrongkind')).statusCode).toBe(400);
    expect((await inject('GET', `/api/professional/targets/${a._id}/versions/99`)).statusCode).toBe(404);
  });

  it('never returns the ranking fence on create replay, PATCH or archive of a subject', async () => {
    const body = {
      reference: `op-fence-${suffix}`,
      consent: { dataClass: 'synthetic', processingBasis: 'consent', aiProcessing: 'denied' },
    };
    const headers = { 'idempotency-key': `subj-fence-${suffix}` };
    const created = await inject('POST', '/api/professional/subjects', body, headers);
    const sid = created.json().subject._id;
    await inject('POST', `/api/professional/subjects/${sid}/targets`, { label: 'Fenced', fit });
    const stored = await platform.mongo.db.collection('professional_subjects').findOne({ _id: sid });
    expect(stored?.targetsRev).toBeGreaterThan(0);
    const replay = await inject('POST', '/api/professional/subjects', body, headers);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().subject).not.toHaveProperty('targetsRev');
    const patched = await inject('PATCH', `/api/professional/subjects/${sid}`, {
      reference: `op-fence2-${suffix}`,
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().subject).not.toHaveProperty('targetsRev');
    const archived = await inject('POST', `/api/professional/subjects/${sid}/archive`);
    expect(archived.statusCode).toBe(200);
    expect(archived.json().subject).not.toHaveProperty('targetsRev');
  });

  it('no log line contains the canary', () => {
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(CANARY);
  });
});
