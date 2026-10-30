/**
 * P1.2 HTTP contract for uploads and the Professional content route, the generic artifact
 * routes' refusal of uploaded bytes (FE-P6), and the PII canary on the upload path: document
 * bytes, declared dates and rejected uploads never reach a log line or a metric.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deterministicId } from '@aptamind/contracts';
import { createLogger, metrics } from '@aptamind/observability';
import { createPlatform, type Platform } from '@aptamind/platform';
import {
  createProfessionalDomain,
  DEFAULT_PROFESSIONAL_LIMITS,
  type ProfessionalDomain,
} from '@aptamind/professional';
import { buildApp } from './app';

const suffix = randomBytes(4).toString('hex');
process.env.MONGODB_DB = `t_prof_snap_${suffix}`;
process.env.QUEUE_PREFIX = `t-prof-snap-${suffix}`;
process.env.S3_BUCKET = 'aptamind-test';

const CANARY = `canary${randomBytes(5).toString('hex')}`;
const MAX_UPLOAD = 32 * 1024;
const lines: string[] = [];
const logger = createLogger({
  service: 'prof-snap-test',
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
let subjectId: string;
let cvSourceId: string;
const consent = { dataClass: 'synthetic', processingBasis: 'consent', aiProcessing: 'denied' };

beforeAll(async () => {
  platform = await createPlatform('api');
  await platform.init();
  const ctx = platform.professional.ctx;
  professional = createProfessionalDomain(
    {
      ...ctx,
      logger,
      config: { ...ctx.config, limits: { ...DEFAULT_PROFESSIONAL_LIMITS, maxUploadBytes: MAX_UPLOAD } },
    },
    { launcher: platform.professional.launcher },
  );
  app = await buildApp({ ...platform, logger, professional });
  subjectId = (
    await app.inject({
      method: 'POST',
      url: '/api/professional/subjects',
      payload: { reference: 'op-snap', consent },
    })
  ).json().subject._id;
  cvSourceId = (
    await app.inject({
      method: 'POST',
      url: `/api/professional/subjects/${subjectId}/sources`,
      payload: { kind: 'cv' },
    })
  ).json().source._id;
});
afterAll(async () => {
  await app?.close();
  await platform?.mongo.db.dropDatabase().catch(() => {});
  await platform?.close();
});

const upload = (
  sourceId: string,
  body: string | Buffer,
  contentType?: string,
  opts: { query?: string; headers?: Record<string, string> } = {},
) =>
  app.inject({
    method: 'POST',
    url: `/api/professional/sources/${sourceId}/uploads${opts.query ?? ''}`,
    payload: body,
    headers: { ...(contentType ? { 'content-type': contentType } : {}), ...opts.headers },
  });

describe('uploads and the content route', () => {
  it('POST uploads (201), replays identical bytes (200) and serves them safely, subject-checked', async () => {
    const html = `<html><script>alert(1)</script>cv ${randomBytes(6).toString('hex')}</html>`;
    const src = (
      await app.inject({
        method: 'POST',
        url: `/api/professional/subjects/${subjectId}/sources`,
        payload: { kind: 'case_study' },
      })
    ).json().source._id as string;
    const a = await upload(src, html, 'text/html; charset=utf-8', {
      query: '?declaredAsOf=2024-05-01&include=sensitive',
    });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({
      created: true,
      snapshot: {
        sourceId: src,
        subjectId,
        mimeType: 'text/html',
        sourceAsOfKind: 'declared',
        sourceAsOf: '2024-05-01T00:00:00.000Z',
        acquisitions: 1,
      },
    });
    const snapshot = a.json().snapshot as { _id: string; artifact: { artifactId: string } };
    // With include=sensitive: hash and artifact reference, never the shared-bucket storage key.
    expect(a.json().snapshot.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.json().snapshot.artifact).toMatchObject({ artifactId: expect.any(String), size: html.length });
    expect(a.json().snapshot.artifact.storageKey).toBeUndefined();
    const b = await upload(src, html, 'text/html');
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ created: false, snapshot: { _id: snapshot._id, acquisitions: 2 } });
    // One ingest run per snapshot: the re-acquisition returns it (P1.3).
    expect(a.json().runId).toMatch(/^run_/);
    expect(b.json().runId).toBe(a.json().runId);
    expect(a.json().snapshot.ingest).toMatchObject({ state: 'launched', runId: a.json().runId });

    const content = await app.inject({
      method: 'GET',
      url: `/api/professional/snapshots/${snapshot._id}/content?include=sensitive`,
    });
    expect(content.statusCode).toBe(200);
    expect(content.body).toBe(html);
    expect(content.headers).toMatchObject({
      'content-type': 'text/plain; charset=utf-8',
      'x-artifact-mime-type': 'text/html',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': 'private, no-store',
    });
    expect(content.headers['content-disposition']).toBeUndefined();
    // [RULING] Without include=sensitive the bytes of any snapshot are the unknown-snapshot 404.
    const unknownId = 'psnap_doesnotexist';
    for (const q of ['', '?include=other']) {
      const hidden = await app.inject({
        method: 'GET',
        url: `/api/professional/snapshots/${snapshot._id}/content${q}`,
      });
      const missing = await app.inject({
        method: 'GET',
        url: `/api/professional/snapshots/${unknownId}/content${q}`,
      });
      expect(hidden.statusCode).toBe(q ? 400 : 404);
      expect(hidden.body.split(snapshot._id).join('<id>')).toBe(missing.body.split(unknownId).join('<id>'));
      expect(hidden.body).not.toContain('alert(1)');
    }
    // Metadata reads are unchanged.
    expect((await app.inject({ method: 'GET', url: `/api/professional/sources/${src}` })).statusCode).toBe(
      200,
    );

    // The source detail lists the snapshot; the generic artifact routes refuse its bytes.
    const detail = (await app.inject({ method: 'GET', url: `/api/professional/sources/${src}` })).json();
    expect(detail.snapshots.map((s: { _id: string }) => s._id)).toEqual([snapshot._id]);
    const page = await app.inject({
      method: 'GET',
      url: `/api/professional/sources/${src}/snapshots?limit=1`,
    });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ items: [{ _id: snapshot._id }], nextCursor: null, limit: 1 });
    expect(
      (await app.inject({ method: 'GET', url: `/api/professional/sources/${src}/snapshots?kind=cv` }))
        .statusCode,
    ).toBe(400);
    const unknown = `art_${randomBytes(16).toString('hex')}`;
    for (const path of ['', '/content']) {
      const refused = await app.inject({
        method: 'GET',
        url: `/api/artifacts/${snapshot.artifact.artifactId}${path}`,
      });
      const missing = await app.inject({ method: 'GET', url: `/api/artifacts/${unknown}${path}` });
      expect(refused.statusCode).toBe(404);
      expect(refused.body.split(snapshot.artifact.artifactId).join('<id>')).toBe(
        missing.body.split(unknown).join('<id>'),
      );
    }
  });

  it('binary uploads are served as octet-stream', async () => {
    const pdf = Buffer.from(`%PDF-1.4\n<< /Type /Page >>\n${randomBytes(4).toString('hex')}\n%%EOF`);
    const res = await upload(cvSourceId, pdf, 'application/pdf');
    expect(res.statusCode).toBe(201);
    const content = await app.inject({
      method: 'GET',
      url: `/api/professional/snapshots/${res.json().snapshot._id}/content?include=sensitive`,
    });
    expect(content.headers['content-type']).toBe('application/octet-stream');
    expect(content.headers['content-disposition']).toBe('attachment');
    expect(content.rawPayload.equals(pdf)).toBe(true);
  });

  it('rejects with 413/415/400/404 before storing anything', async () => {
    const before = await platform.mongo.db.collection('artifacts').countDocuments({});
    const big = await upload(cvSourceId, Buffer.alloc(MAX_UPLOAD + 1, 0x61), 'text/plain');
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toMatchObject({ code: 'upload_too_large', details: { limit: 'bytes' } });
    const wrong = await upload(cvSourceId, 'x', 'application/json');
    expect(wrong.statusCode).toBe(415);
    expect(wrong.json().error.code).toBe('unsupported_media_type');
    expect((await upload(cvSourceId, 'not a pdf', 'application/pdf')).statusCode).toBe(415);
    expect((await upload(cvSourceId, 'x')).statusCode).toBe(415);
    expect((await upload(cvSourceId, '', 'text/plain')).statusCode).toBe(400);
    expect(
      (await upload(cvSourceId, 'x', 'text/plain', { query: '?declaredAsOf=2024-13-01' })).statusCode,
    ).toBe(400);
    expect((await upload(cvSourceId, 'x', 'text/plain', { query: '?name=cv.txt' })).statusCode).toBe(400);
    expect((await upload('psrc_missing', 'x', 'text/plain')).statusCode).toBe(404);
    expect((await upload('src_1', 'x', 'text/plain')).statusCode).toBe(400);
    expect(await platform.mongo.db.collection('artifacts').countDocuments({})).toBe(before);
    // Other Professional routes keep the generic mapping for oversized/unsupported bodies.
    const otherRoute = await app.inject({
      method: 'POST',
      url: `/api/professional/subjects/${subjectId}/sources`,
      payload: 'x',
      headers: { 'content-type': 'application/pdf' },
    });
    expect(otherRoute.json().error.code).toBe('bad_request');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/professional/snapshots/psnap_missing/content?include=sensitive',
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('streaming limit (A-M5)', () => {
  it('a chunked oversize body without content-length is 413 and never reaches the upload service', async () => {
    const spy = vi.spyOn(professional.snapshots, 'upload');
    try {
      const chunk = Buffer.alloc(8 * 1024, 0x61);
      let sent = 0;
      const body = new Readable({
        read() {
          if (sent > MAX_UPLOAD + chunk.length) return this.push(null);
          sent += chunk.length;
          this.push(chunk);
        },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/professional/sources/${cvSourceId}/uploads`,
        payload: body,
        headers: { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' },
      });
      expect(res.statusCode).toBe(413);
      expect(res.json().error).toMatchObject({ code: 'upload_too_large', details: { limit: 'bytes' } });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('PII canary on the upload path (R-32, R-37)', () => {
  it('no document byte, declared date or rejected value reaches a log line or metric', async () => {
    const before = lines.length;
    const doc = `Name: ${CANARY} Example\nEmail: ${CANARY}@example.org\nPhone: +44 ${CANARY}`;
    const outcomes: number[] = [];
    const record = async (r: Promise<{ statusCode: number }>) => outcomes.push((await r).statusCode);

    await record(
      upload(cvSourceId, doc, 'text/plain', { headers: { 'idempotency-key': 'canary-upload-01' } }),
    );
    await record(
      upload(cvSourceId, doc, 'text/plain', { headers: { 'idempotency-key': 'canary-upload-01' } }),
    );
    await record(
      upload(cvSourceId, `${doc}\nother`, 'text/plain', {
        headers: { 'idempotency-key': 'canary-upload-01' },
      }),
    );
    await record(upload(cvSourceId, doc, `text/${CANARY}`));
    await record(upload(cvSourceId, doc, 'application/pdf'));
    await record(upload(cvSourceId, `${doc}${'x'.repeat(MAX_UPLOAD)}`, 'text/plain'));
    await record(upload(cvSourceId, doc, 'text/plain', { query: `?declaredAsOf=${CANARY}` }));
    await record(upload(cvSourceId, doc, 'text/plain', { query: `?${CANARY}=1` }));
    const snapshotId = (await upload(cvSourceId, doc, 'text/plain')).json().snapshot._id;
    await record(
      app.inject({
        method: 'GET',
        url: `/api/professional/snapshots/${snapshotId}/content?include=sensitive`,
      }),
    );

    expect(outcomes).toEqual([201, 200, 409, 415, 415, 413, 400, 400, 200]);
    const written = lines.slice(before).join('\n');
    expect(written).toContain('/api/professional/sources/:id/uploads'); // request logs were captured
    expect(written).not.toContain(CANARY);
    const prom = metrics.toPrometheus();
    expect(prom).not.toContain(CANARY);
    // Upload outcomes are counted with enum labels only.
    // Route-level rejections (bad query/id, unknown source) are counted too (L4).
    for (const outcome of [
      'created',
      'replayed',
      'conflict',
      'unsupported_media_type',
      'upload_too_large',
      'validation_failed',
      'not_found',
    ])
      expect(prom).toMatch(new RegExp(`professional_uploads_total\\{[^}]*outcome="${outcome}"`));
  });
});

describe('statements, reprocess and observations (P1.3)', () => {
  it('POST statements stores a form snapshot and returns its ingest run; reprocess starts another', async () => {
    const form = (
      await app.inject({
        method: 'POST',
        url: `/api/professional/subjects/${subjectId}/sources`,
        payload: { kind: 'questionnaire' },
      })
    ).json().source._id as string;
    const body = {
      sourceId: form,
      form: {
        form: 'questionnaire',
        version: 1,
        answers: { headline: 'Staff designer', skills: [{ label: 'Figma' }] },
      },
    };
    const url = `/api/professional/subjects/${subjectId}/statements`;
    const a = await app.inject({
      method: 'POST',
      url,
      payload: body,
      headers: { 'idempotency-key': 'stmt-key-0001' },
    });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({
      created: true,
      snapshot: { via: 'form', mimeType: 'application/json' },
    });
    expect(a.json().runId).toMatch(/^run_/);
    const replay = await app.inject({
      method: 'POST',
      url,
      payload: body,
      headers: { 'idempotency-key': 'stmt-key-0001' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ created: false, runId: a.json().runId });

    const invalid = await app.inject({
      method: 'POST',
      url,
      payload: {
        sourceId: form,
        form: { form: 'questionnaire', version: 1, answers: { date_of_birth: 'x' } },
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain('date_of_birth');
    const wrongKind = await app.inject({ method: 'POST', url, payload: { ...body, sourceId: cvSourceId } });
    expect(wrongKind.json().error).toMatchObject({
      code: 'validation_failed',
      details: { field: 'sourceId' },
    });

    const snapshotId = a.json().snapshot._id as string;
    const re = await app.inject({
      method: 'POST',
      url: `/api/professional/snapshots/${snapshotId}/reprocess`,
    });
    expect(re.statusCode).toBe(202);
    expect(re.json().runId).toMatch(/^run_/);
    expect(re.json().runId).not.toBe(a.json().runId);

    // The API process runs no worker: extract directly, then read the evidence through the API.
    await professional.extractions.extractStructured(snapshotId);
    const list = await app.inject({
      method: 'GET',
      url: `/api/professional/subjects/${subjectId}/observations?sourceId=${form}&limit=10`,
    });
    expect(list.statusCode).toBe(200);
    const items = list.json().items as Array<{ _id: string; claimType: string; mode: string }>;
    expect(items.map((o) => o.claimType).sort()).toEqual(['positioning.headline', 'skill']);
    expect(items.every((o) => o.mode === 'stated')).toBe(true);
    const one = await app.inject({ method: 'GET', url: `/api/professional/observations/${items[0]!._id}` });
    expect(one.json().observation).toMatchObject({ _id: items[0]!._id, evidence: { spanVerified: true } });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/professional/subjects/${subjectId}/observations?text=x`,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/api/professional/observations/pobs_missing' })).statusCode,
    ).toBe(404);
    // Source detail shows the extraction; the overview counts unprocessed snapshots.
    const detail = (await app.inject({ method: 'GET', url: `/api/professional/sources/${form}` })).json();
    expect(detail.extractions[0]).toMatchObject({ status: 'completed', counts: { observations: 2 } });
    const overview = (
      await app.inject({ method: 'GET', url: `/api/professional/subjects/${subjectId}` })
    ).json();
    expect(overview.counts).toMatchObject({ unprocessedSnapshots: 0 });
  });

  it('no statement value reaches a log line or metric', async () => {
    const before = lines.length;
    const form = (
      await app.inject({
        method: 'POST',
        url: `/api/professional/subjects/${subjectId}/sources`,
        payload: { kind: 'manual_input' },
      })
    ).json().source._id as string;
    const url = `/api/professional/subjects/${subjectId}/statements`;
    const ok = await app.inject({
      method: 'POST',
      url,
      payload: {
        sourceId: form,
        form: {
          form: 'manual_input',
          version: 1,
          statements: [{ claimType: 'identity.name', value: { display: CANARY } }],
        },
      },
    });
    expect(ok.statusCode).toBe(201);
    const bad = await app.inject({
      method: 'POST',
      url,
      payload: {
        sourceId: form,
        form: {
          form: 'manual_input',
          version: 1,
          statements: [{ claimType: 'identity.name', value: { [CANARY]: CANARY } }],
        },
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain(CANARY);
    await professional.extractions.extractStructured(ok.json().snapshot._id);
    expect(lines.slice(before).join('\n')).not.toContain(CANARY);
    expect(metrics.toPrometheus()).not.toContain(CANARY);
  });
});

describe('sensitive by default, processing status, generic run start (P1.3 review)', () => {
  it('sensitive observations and forms need include=sensitive; otherwise they look unknown', async () => {
    const q = (
      await app.inject({
        method: 'POST',
        url: `/api/professional/subjects/${subjectId}/sources`,
        payload: { kind: 'questionnaire' },
      })
    ).json().source._id as string;
    const res = await app.inject({
      method: 'POST',
      url: `/api/professional/subjects/${subjectId}/statements`,
      payload: {
        sourceId: q,
        form: {
          form: 'questionnaire',
          version: 1,
          answers: {
            headline: 'Product designer',
            current_location: { city: 'Dubai', country: 'AE' },
            work_authorization: [
              { jurisdiction: 'AE', status: 'visa', visaType: 'Golden', sponsorshipRequired: 'no' },
            ],
          },
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const snapshotId = res.json().snapshot._id as string;
    await professional.extractions.extractStructured(snapshotId);
    const base = `/api/professional/subjects/${subjectId}/observations?sourceId=${q}`;
    const plain = (await app.inject({ method: 'GET', url: base })).json().items as Array<{
      _id: string;
      claimType: string;
    }>;
    expect(plain.map((o) => o.claimType)).toEqual(['positioning.headline']);
    expect(JSON.stringify(plain)).not.toContain('Dubai');
    const all = (await app.inject({ method: 'GET', url: `${base}&include=sensitive` })).json()
      .items as Array<{
      _id: string;
      claimType: string;
    }>;
    expect(all.map((o) => o.claimType).sort()).toEqual([
      'location.current',
      'positioning.headline',
      'work_authorization',
    ]);
    const filtered = await app.inject({ method: 'GET', url: `${base}&claimType=work_authorization` });
    expect(filtered.statusCode).toBe(400);
    expect(filtered.json().error.code).toBe('validation_failed');
    expect(
      (
        await app.inject({ method: 'GET', url: `${base}&claimType=work_authorization&include=sensitive` })
      ).json().items,
    ).toHaveLength(1);

    const sensitive = all.find((o) => o.claimType === 'location.current')!;
    const hidden = await app.inject({
      method: 'GET',
      url: `/api/professional/observations/${sensitive._id}`,
    });
    const unknown = await app.inject({
      method: 'GET',
      url: '/api/professional/observations/pobs_doesnotexist',
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body.split(sensitive._id).join('<id>')).toBe(
      unknown.body.split('pobs_doesnotexist').join('<id>'),
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/professional/observations/${sensitive._id}?include=sensitive`,
        })
      ).json().observation.claimType,
    ).toBe('location.current');

    // The form's bytes hold the sensitive answers: private by default too.
    const content = `/api/professional/snapshots/${snapshotId}/content`;
    const noInclude = await app.inject({ method: 'GET', url: content });
    expect(noInclude.statusCode).toBe(404);
    expect(noInclude.body).not.toContain('Dubai');
    const withInclude = await app.inject({ method: 'GET', url: `${content}?include=sensitive` });
    expect(withInclude.statusCode).toBe(200);
    expect(withInclude.body).toContain('Dubai');
    // Statement and extraction outcomes are counted with enum labels only.
    const prom = metrics.toPrometheus();
    expect(prom).toMatch(/professional_statements_total\{[^}]*outcome="created"/);
    expect(prom).toMatch(/professional_extractions_total\{[^}]*status="completed"/);
    expect(prom).not.toContain('Dubai');
  });

  it('snapshot rows and detail carry the derived processing status', async () => {
    const page = (
      await app.inject({ method: 'GET', url: `/api/professional/sources/${cvSourceId}/snapshots` })
    ).json();
    expect(page.items.length).toBeGreaterThan(0);
    for (const s of page.items)
      expect(['pending', 'launched', 'processed', 'skipped', 'failed']).toContain(s.processing.state);
    const one = await app.inject({ method: 'GET', url: `/api/professional/snapshots/${page.items[0]._id}` });
    expect(one.json().snapshot.processing).toEqual(page.items[0].processing);
    const detail = (
      await app.inject({ method: 'GET', url: `/api/professional/sources/${cvSourceId}` })
    ).json();
    expect(detail.snapshots[0].processing).toBeDefined();
  });

  it('statements for an unknown subject are 404; the generic run-start route refuses professional workflows', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/api/professional/subjects/psub_missing/statements',
      payload: {
        sourceId: 'psrc_x',
        form: { form: 'questionnaire', version: 1, answers: { headline: 'x' } },
      },
    });
    expect(missing.statusCode).toBe(404);
    const generic = await app.inject({
      method: 'POST',
      url: '/api/workflows/professional.source.ingest/runs',
      payload: { input: { subjectId: 'psub_x', sourceId: 'psrc_x', snapshotId: 'psnap_x' } },
    });
    expect(generic.statusCode).toBe(404);
  });
});

describe('content hashes are sensitive (P1.2 re-verify ruling)', () => {
  it('a low-entropy upload response carries no hash, artifact reference or content-derived id', async () => {
    const q = (
      await app.inject({
        method: 'POST',
        url: `/api/professional/subjects/${subjectId}/sources`,
        payload: { kind: 'uploaded_document' },
      })
    ).json().source._id as string;
    const body = 'GB visa: yes\n';
    const sha = createHash('sha256').update(body).digest('hex');
    const res = await upload(q, body, 'text/plain');
    expect(res.statusCode).toBe(201);
    const snap = res.json().snapshot as Record<string, unknown> & { _id: string };
    expect(snap.contentHash).toBeUndefined();
    expect(snap.artifact).toBeUndefined();
    expect(res.body).not.toContain(sha);
    expect(res.body).not.toContain(sha.slice(0, 32)); // the artifact id is art_<sha prefix>
    // The id is random: not recomputable from (source, content).
    expect(snap._id).not.toBe(deterministicId('psnap', q, sha));
    // Lists and the source detail follow the same rule.
    const list = await app.inject({ method: 'GET', url: `/api/professional/sources/${q}/snapshots` });
    const detail = await app.inject({ method: 'GET', url: `/api/professional/sources/${q}` });
    for (const r of [list, detail]) {
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain(sha.slice(0, 32));
    }
    const listSensitive = await app.inject({
      method: 'GET',
      url: `/api/professional/sources/${q}/snapshots?include=sensitive`,
    });
    expect(listSensitive.json().items[0].contentHash).toBe(sha);
    expect(listSensitive.body).not.toContain('storageKey');
    // Identical bytes are still one snapshot (the unique (sourceId, contentHash) index).
    const again = await upload(q, body, 'text/plain');
    expect(again.json()).toMatchObject({ created: false, snapshot: { _id: snap._id } });
  });

  it('content reads never look the snapshot up without include=sensitive', async () => {
    const spy = vi.spyOn(professional.snapshots, 'get');
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/professional/snapshots/psnap_anything/content',
      });
      expect(res.statusCode).toBe(404);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('a low-entropy form: statements, reprocess, snapshot and evidence responses carry no hash oracle', async () => {
    const q = (
      await app.inject({
        method: 'POST',
        url: `/api/professional/subjects/${subjectId}/sources`,
        payload: { kind: 'questionnaire' },
      })
    ).json().source._id as string;
    const payload = {
      sourceId: q,
      form: {
        form: 'questionnaire',
        version: 1,
        answers: {
          headline: 'Designer',
          work_authorization: [{ jurisdiction: 'GB', status: 'visa', sponsorshipRequired: 'yes' }],
        },
      },
    };
    const url = `/api/professional/subjects/${subjectId}/statements`;
    const res = await app.inject({ method: 'POST', url, payload });
    expect(res.statusCode).toBe(201);
    const snapshotId = res.json().snapshot._id as string;
    await professional.extractions.extractStructured(snapshotId);
    // The oracles, read with the explicit opt-in.
    const opted = await app.inject({
      method: 'GET',
      url: `/api/professional/snapshots/${snapshotId}?include=sensitive`,
    });
    const { contentHash, artifact } = opted.json().snapshot as {
      contentHash: string;
      artifact: { artifactId: string; sha256: string; storageKey?: string };
    };
    expect(contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.storageKey).toBeUndefined();
    const evidence = await app.inject({
      method: 'GET',
      url: `/api/professional/subjects/${subjectId}/observations?sourceId=${q}&include=sensitive`,
    });
    expect(evidence.json().items[0].evidence.artifactId).toBe(artifact.artifactId);

    const plain = [
      res,
      await app.inject({ method: 'POST', url, payload }), // re-acquisition
      await app.inject({ method: 'POST', url: `/api/professional/snapshots/${snapshotId}/reprocess` }),
      await app.inject({ method: 'GET', url: `/api/professional/snapshots/${snapshotId}` }),
      await app.inject({ method: 'GET', url: `/api/professional/sources/${q}` }),
      await app.inject({ method: 'GET', url: `/api/professional/sources/${q}/snapshots` }),
      await app.inject({
        method: 'GET',
        url: `/api/professional/subjects/${subjectId}/observations?sourceId=${q}`,
      }),
    ];
    for (const r of plain) {
      expect(r.statusCode).toBeLessThan(300);
      for (const oracle of [contentHash, artifact.sha256, artifact.artifactId, contentHash.slice(0, 24)])
        expect(r.body).not.toContain(oracle);
      expect(r.body).not.toContain('storageKey');
    }
    expect(plain[1]!.json().snapshot._id).toBe(snapshotId);
    const headline = plain[6]!.json().items as Array<{ claimType: string; evidence: object }>;
    expect(headline.map((o) => o.claimType)).toEqual(['positioning.headline']);
    expect(headline[0]!.evidence).not.toHaveProperty('artifactId');
    // The raw detail read follows the same rule (M-2).
    const obsId = (headline[0] as unknown as { _id: string })._id;
    const one = await app.inject({ method: 'GET', url: `/api/professional/observations/${obsId}` });
    expect(one.statusCode).toBe(200);
    expect(one.json().observation.evidence).not.toHaveProperty('artifactId');
    for (const oracle of [contentHash, artifact.artifactId, contentHash.slice(0, 24)])
      expect(one.body).not.toContain(oracle);
    const oneOpted = await app.inject({
      method: 'GET',
      url: `/api/professional/observations/${obsId}?include=sensitive`,
    });
    expect(oneOpted.json().observation.evidence.artifactId).toBe(artifact.artifactId);
  });

  it('extractions in the source detail carry no text artifact or section hashes without include=sensitive (M-3)', async () => {
    const uploaded = await upload(cvSourceId, `M-3 text document ${suffix}\n`, 'text/plain');
    expect(uploaded.statusCode).toBe(201);
    const snap = await professional.snapshots.col.findOne({ _id: uploaded.json().snapshot._id });
    expect(snap).not.toBeNull();
    const sectionHash = createHash('sha256').update(`section-${suffix}`).digest('hex');
    const now = new Date();
    // A text extraction as P2.1 will write it: normalized text artifact + section map.
    await professional.extractions.col.insertOne({
      _id: deterministicId('pext', snap!._id, 'cv_text', 1),
      subjectId,
      sourceId: cvSourceId,
      snapshotId: snap!._id,
      extractor: { name: 'cv_text', version: 1, kind: 'deterministic' },
      status: 'completed',
      current: true,
      textArtifact: snap!.artifact,
      sections: [{ id: 's1', class: 'experience', start: 0, end: 10, hash: sectionHash }],
      counts: { observations: 0, dropped: 0, protectedDropped: 0, unverifiedSpans: 0 },
      completedAt: now,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    const url = `/api/professional/sources/${cvSourceId}`;
    const plain = await app.inject({ method: 'GET', url });
    expect(plain.statusCode).toBe(200);
    const ext = (plain.json().extractions as Array<Record<string, unknown>>).find(
      (e) => (e.extractor as { name: string }).name === 'cv_text',
    )!;
    expect(ext).not.toHaveProperty('textArtifact');
    expect(ext.sections).toEqual([{ id: 's1', class: 'experience', start: 0, end: 10 }]);
    for (const oracle of [sectionHash, snap!.artifact.artifactId, snap!.artifact.sha256])
      expect(plain.body).not.toContain(oracle);
    expect(plain.body).not.toContain('storageKey');

    const opted = await app.inject({ method: 'GET', url: `${url}?include=sensitive` });
    const optedExt = (opted.json().extractions as Array<Record<string, unknown>>).find(
      (e) => (e.extractor as { name: string }).name === 'cv_text',
    )!;
    expect(optedExt.textArtifact).toMatchObject({ artifactId: snap!.artifact.artifactId });
    expect((optedExt.sections as Array<{ hash: string }>)[0]!.hash).toBe(sectionHash);
    expect(opted.body).not.toContain('storageKey');
  });
});

describe('generic run mutations of professional runs (P1.3 review ruling)', () => {
  it('cancel, node retry and node resume refuse professional.* runs exactly like unknown ids; Market is unaffected', async () => {
    const q = (
      await app.inject({
        method: 'POST',
        url: `/api/professional/subjects/${subjectId}/sources`,
        payload: { kind: 'questionnaire' },
      })
    ).json().source._id as string;
    const res = await app.inject({
      method: 'POST',
      url: `/api/professional/subjects/${subjectId}/statements`,
      payload: {
        sourceId: q,
        form: { form: 'questionnaire', version: 1, answers: { headline: 'Generic mutation probe' } },
      },
    });
    const runId = res.json().runId as string;
    expect(runId).toMatch(/^run_/);
    const node = await platform.runtime.engine.nodeRuns.findOne({ runId });
    expect(node?.workflowKey).toBe('professional.source.ingest');
    const same = async (url: string, id: string, unknownId: string, payload?: object) => {
      const refused = await app.inject({
        method: 'POST',
        url: url.replace(':id', id),
        payload: payload ?? {},
      });
      const unknown = await app.inject({
        method: 'POST',
        url: url.replace(':id', unknownId),
        payload: payload ?? {},
      });
      expect(refused.statusCode).toBe(404);
      expect(refused.body.split(id).join('<id>')).toBe(unknown.body.split(unknownId).join('<id>'));
    };
    await same('/api/runs/:id/cancel', runId, 'run_doesnotexist');
    await same('/api/node-runs/:id/retry', node!._id, 'nr_doesnotexist');
    await same('/api/node-runs/:id/resume', node!._id, 'nr_doesnotexist', { payload: {} });
    // Nothing changed: the run was not cancelled.
    expect((await platform.runtime.engine.getRun(runId)).state).not.toMatch(/CANCEL/);
    // Generic reads stay (FE-P7 decides them).
    expect((await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).statusCode).toBe(200);

    // A Market run still reaches the engine through the same routes.
    const market = await app.inject({
      method: 'POST',
      url: '/api/workflows/market.freshness.sweep/runs',
      payload: { input: {} },
    });
    expect(market.statusCode).toBeLessThan(300);
    const marketRun = { _id: market.json().runId as string };
    const marketNode = await platform.runtime.engine.nodeRuns.findOne({ runId: marketRun._id });
    expect(marketNode).not.toBeNull();
    // Not FAILED / not waiting: the engine's own 409, not the guard's 404.
    for (const action of ['retry', 'resume'])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/node-runs/${marketNode!._id}/${action}`,
            payload: { payload: {} },
          })
        ).statusCode,
      ).toBe(409);
    const cancelled = await app.inject({ method: 'POST', url: `/api/runs/${marketRun._id}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().run.state).toMatch(/CANCEL/);
  });
});
