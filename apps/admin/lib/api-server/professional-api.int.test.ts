/**
 * P1.1 HTTP contract (`/api/professional/*`) and the PII canary on request logs: every log line
 * the API and the Professional domain write while serving these requests — including failures,
 * rejected payloads, malformed JSON, duplicate-key conflicts and an unexpected MongoDB error
 * whose message/errInfo/keyValue quote a canary — must be free of canary tokens.
 */
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, metrics } from '@aptamind/observability';
import { createPlatform, type Platform } from '@aptamind/platform';
import { createProfessionalDomain, type ProfessionalDomain } from '@aptamind/professional';
import { buildApp } from './app';

const suffix = randomBytes(4).toString('hex');
process.env.MONGODB_DB = `t_prof_api_${suffix}`;
process.env.QUEUE_PREFIX = `t-prof-api-${suffix}`;
process.env.S3_BUCKET = 'aptamind-test';

const CANARY = `canary${randomBytes(5).toString('hex')}`;
const lines: string[] = [];
const logger = createLogger({
  service: 'prof-api-test',
  level: 'trace',
  destination: new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  }),
});

let platform: Platform;
let professional: ProfessionalDomain;
let app: Awaited<ReturnType<typeof buildApp>>;
const consent = { dataClass: 'synthetic', processingBasis: 'consent', aiProcessing: 'denied' };

beforeAll(async () => {
  platform = await createPlatform('api');
  await platform.init();
  // The same domain wiring as the platform, logging into the capture stream.
  professional = createProfessionalDomain({ ...platform.professional.ctx, logger });
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

describe('subjects API', () => {
  let subjectId: string;

  it('POST creates (201) and an Idempotency-Key replay returns the same subject (200)', async () => {
    const body = { reference: 'op-api-1', consent };
    const a = await inject('POST', '/api/professional/subjects', body, {
      'idempotency-key': 'api-subject-0001',
    });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({
      created: true,
      subject: { status: 'active', reference: 'op-api-1', rev: 0 },
    });
    subjectId = a.json().subject._id;
    const b = await inject('POST', '/api/professional/subjects', body, {
      'idempotency-key': 'api-subject-0001',
    });
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ created: false, subject: { _id: subjectId } });
    const c = await inject(
      'POST',
      '/api/professional/subjects',
      { ...body, reference: 'op-api-other' },
      { 'idempotency-key': 'api-subject-0001' },
    );
    expect(c.statusCode).toBe(409);
    expect(c.json().error.code).toBe('idempotency_key_reused');
  });

  it('validates bodies, ids and keys (400) and unknown ids (404)', async () => {
    expect((await inject('POST', '/api/professional/subjects', { reference: 'x' })).statusCode).toBe(400);
    expect(
      (
        await inject('POST', '/api/professional/subjects', {
          reference: 'op',
          consent: { ...consent, dataClass: 'real' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await inject(
          'POST',
          '/api/professional/subjects',
          { reference: 'op-x', consent },
          { 'idempotency-key': 'bad key!' },
        )
      ).statusCode,
    ).toBe(400);
    expect((await inject('GET', '/api/professional/subjects/src_1')).statusCode).toBe(400);
    const missing = await inject('GET', '/api/professional/subjects/psub_missing');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toMatchObject({
      code: 'not_found',
      details: { entity: 'subject', id: 'psub_missing' },
    });
  });

  it('GET list pages with limit + cursor and filters by status', async () => {
    for (let i = 0; i < 3; i++)
      await inject('POST', '/api/professional/subjects', { reference: `op-list-${i}`, consent });
    const first = (await inject('GET', '/api/professional/subjects?limit=2')).json();
    expect(first.items).toHaveLength(2);
    expect(first.limit).toBe(2);
    expect(typeof first.nextCursor).toBe('string');
    const second = (
      await inject('GET', `/api/professional/subjects?limit=2&cursor=${first.nextCursor}`)
    ).json();
    expect(second.items[0]._id).not.toBe(first.items[1]._id);
    expect((await inject('GET', '/api/professional/subjects?limit=500')).statusCode).toBe(400);
    expect((await inject('GET', '/api/professional/subjects?cursor=zzz')).statusCode).toBe(400);
    const unknownParam = await inject('GET', '/api/professional/subjects?statuz=active');
    expect(unknownParam.statusCode).toBe(400);
    expect(unknownParam.body).not.toContain('statuz');
    expect((await inject('GET', `/api/professional/subjects/${subjectId}/sources?kinds=cv`)).statusCode).toBe(
      400,
    );
    const archivedOnly = (await inject('GET', '/api/professional/subjects?status=archived')).json();
    expect(archivedOnly.items.every((s: { status: string }) => s.status === 'archived')).toBe(true);
  });

  it('PATCH records consent changes; stale expectedRev → 409; GET overview shows counts and events', async () => {
    const res = await inject('PATCH', `/api/professional/subjects/${subjectId}`, {
      consent: { aiProcessing: 'allowed' },
      expectedRev: 0,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().subject).toMatchObject({ rev: 1, consent: { aiProcessing: 'allowed' } });
    const stale = await inject('PATCH', `/api/professional/subjects/${subjectId}`, {
      reference: 'op-z',
      expectedRev: 0,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('stale_subject_revision');
    const overview = (await inject('GET', `/api/professional/subjects/${subjectId}`)).json();
    expect(overview.subject._id).toBe(subjectId);
    expect(overview.counts).toMatchObject({ sources: 0, snapshots: 0, observations: 0, openReviewItems: 0 });
    expect(overview.events.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining(['subject.created', 'subject.consent.ai_processing_changed']),
    );
  });

  it('sources: register by kind, natural-key idempotency, LinkedIn import-only, detail and list', async () => {
    const url = `/api/professional/subjects/${subjectId}/sources`;
    const gh = await inject('POST', url, { kind: 'github', handle: 'persona-api' });
    expect(gh.statusCode).toBe(201);
    expect(gh.json().source).toMatchObject({
      kind: 'github',
      acquisition: 'fetch',
      ownership: { state: 'claimed' },
    });
    const again = await inject('POST', url, { kind: 'github', handle: 'Persona-API' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ created: false, source: { _id: gh.json().source._id } });

    const li = await inject('POST', url, { kind: 'linkedin_export', acquisition: 'fetch' });
    expect(li.statusCode).toBe(400);
    expect(li.json().error.code).toBe('linkedin_import_only');
    expect((await inject('POST', url, { kind: 'cv', bogus: 1 })).statusCode).toBe(400);

    const cv = await inject('POST', url, { kind: 'cv' }, { 'idempotency-key': 'api-source-0001' });
    expect(cv.statusCode).toBe(201);
    const detail = await inject('GET', `/api/professional/sources/${cv.json().source._id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      source: { kind: 'cv' },
      snapshots: [],
      extractions: [],
      openReviewItems: [],
    });

    const list = (await inject('GET', `${url}?kind=github`)).json();
    expect(list.items.map((s: { kind: string }) => s.kind)).toEqual(['github']);
    expect((await inject('GET', '/api/professional/sources/psrc_missing')).statusCode).toBe(404);
  });

  it('an archived subject rejects new sources (409 subject_archived) and edits', async () => {
    const archived = await inject('POST', `/api/professional/subjects/${subjectId}/archive`);
    expect(archived.json().subject.status).toBe('archived');
    const res = await inject('POST', `/api/professional/subjects/${subjectId}/sources`, { kind: 'cv' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('subject_archived');
    expect(
      (await inject('PATCH', `/api/professional/subjects/${subjectId}`, { reference: 'op-q' })).statusCode,
    ).toBe(409);
  });
});

describe('PII canary on request logs (R-37, A-NIT-5)', () => {
  it('no canary reaches any log line or metric, whatever the outcome', async () => {
    const before = lines.length;
    const subject = (
      await inject('POST', '/api/professional/subjects', { reference: 'op-canary', consent })
    ).json().subject._id as string;
    const sources = `/api/professional/subjects/${subject}/sources`;
    const outcomes: number[] = [];
    const record = async (p: Promise<{ statusCode: number; body: string }>, echoAllowed = false) => {
      const r = await p;
      outcomes.push(r.statusCode);
      if (!echoAllowed) expect(r.body, `response ${r.statusCode}`).not.toContain(CANARY);
      return r;
    };

    // Accepted personal data (the operator's own input may be echoed in the response, not logged).
    await record(
      inject('POST', sources, { kind: 'personal_website', url: `https://${CANARY}.example/work` }),
      true,
    );
    await record(
      inject('POST', sources, { kind: 'personal_website', url: `https://${CANARY}.example/work/` }),
      true,
    );
    await record(inject('POST', sources, { kind: 'github', handle: CANARY }), true);
    await record(
      inject(
        'POST',
        sources,
        { kind: 'portfolio', acquisition: 'fetch', url: `https://${CANARY}.example/p` },
        {
          'idempotency-key': 'canary-source-01',
        },
      ),
      true,
    );
    // Rejections that carry the canary in the request.
    await record(
      inject(
        'POST',
        sources,
        { kind: 'portfolio', acquisition: 'fetch', url: `https://${CANARY}.example/q` },
        { 'idempotency-key': 'canary-source-01' },
      ),
    );
    await record(
      inject('POST', '/api/professional/subjects', { reference: `${CANARY}@example.org`, consent }),
    );
    await record(
      inject('POST', '/api/professional/subjects', {
        reference: 'op-c2',
        consent: { ...consent, processingBasis: `${CANARY} said yes` },
      }),
    );
    await record(
      inject('POST', sources, { kind: 'personal_website', url: `https://www.linkedin.com/in/${CANARY}` }),
    );
    await record(inject('POST', sources, { kind: 'cv', url: `https://${CANARY}.example/cv` }));
    await record(inject('POST', sources, { kind: 'github', handle: `${CANARY}_not_a_handle` }));
    await record(inject('POST', sources, { kind: 'personal_website', url: `https://[::1]/${CANARY}` }));
    await record(
      app.inject({
        method: 'POST',
        url: sources,
        headers: { 'content-type': 'application/json' },
        payload: `{"kind":"cv","note":"${CANARY}"`,
      }),
    );

    // Query-string and path canaries (request logs record route templates, never queries).
    await record(inject('GET', `/api/professional/subjects?reference=${CANARY}`));
    await record(inject('GET', `/api/professional/subjects?reference=${CANARY}%40example.org`));
    await record(inject('GET', `/api/professional/subjects?${CANARY}=1`));
    await record(inject('GET', `/api/professional/subjects?limit=1e1&note=${CANARY}`));
    await record(inject('GET', `${sources}?kind=${CANARY}`));
    await record(inject('GET', `/api/professional/subjects/${CANARY}`));
    await record(inject('GET', `/api/professional/sources/psrc_${CANARY}`), true);
    await record(inject('GET', `/api/professional/${CANARY}/x?q=${CANARY}`), true);

    // An unexpected MongoDB failure whose message, errInfo and keyValue quote the canary.
    const original = professional.subjects.get.bind(professional.subjects);
    professional.subjects.get = async () => {
      throw Object.assign(new Error(`E11000 dup key: { url: "${CANARY}" }`), {
        name: 'MongoServerError',
        code: 121,
        codeName: 'DocumentValidationFailure',
        errInfo: { details: { reason: CANARY } },
        keyValue: { url: CANARY },
      });
    };
    try {
      const boom = await record(inject('GET', `/api/professional/subjects/${subject}`));
      expect(boom.statusCode).toBe(500);
      expect(JSON.parse(boom.body).error).toMatchObject({ code: 'internal' });
    } finally {
      professional.subjects.get = original;
    }

    expect(outcomes).toEqual([
      201, 200, 201, 201, 409, 400, 400, 400, 400, 400, 400, 400, 200, 400, 400, 400, 400, 400, 404, 404, 500,
    ]);
    const written = lines.slice(before).join('\n');
    expect(written).toContain('professional request failed'); // the 500 was logged…
    expect(written).toContain('DocumentValidationFailure'); // …by class and code only
    expect(written).toContain('/api/professional/subjects'); // request logs were captured
    expect(written).toContain('"route":"/api/professional/subjects/:id"'); // …by route template
    expect(written).toContain('/api/professional/[unmatched]'); // …or a placeholder
    expect(written).toContain('"domain":"professional"'); // …through the Professional logger
    expect(written).not.toContain(CANARY);
    expect(metrics.toPrometheus()).not.toContain(CANARY);
  });
});

describe('request logs outside Professional (M1)', () => {
  it('keep the path and route template, never the query string', async () => {
    const before = lines.length;
    const res = await inject('GET', `/api/runs/run_missing?note=${CANARY}`);
    expect(res.statusCode).toBe(404);
    const entries = lines
      .slice(before)
      .map((l) => JSON.parse(l) as { msg?: string; req?: { url?: string; route?: string } });
    expect(entries.find((e) => e.msg === 'incoming request')?.req).toMatchObject({
      url: '/api/runs/run_missing',
      route: '/api/runs/:id',
    });
    expect(lines.slice(before).join('\n')).not.toContain(CANARY);
  });
});
