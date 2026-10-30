/**
 * FE-P6: the generic artifact routes refuse Professional-owned artifacts, indistinguishably from
 * an unknown id, while Market (and every other non-private) artifact is served exactly as
 * before: JSON metadata, and content as `text/plain` (or octet-stream) with `nosniff` and
 * `default-src 'none'`.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPlatform, type Platform } from '@aptamind/platform';
import { buildApp } from './app';

const suffix = randomBytes(4).toString('hex');
process.env.MONGODB_DB = `t_artifact_guard_${suffix}`;
process.env.QUEUE_PREFIX = `t-artifact-guard-${suffix}`;
process.env.S3_BUCKET = 'aptamind-test';

let platform: Platform;
let app: Awaited<ReturnType<typeof buildApp>>;
const now = new Date('2026-09-30T00:00:00Z');
const meta = { schemaVersion: 1, createdAt: now, updatedAt: now };

beforeAll(async () => {
  platform = await createPlatform('api');
  await platform.init();
  app = await buildApp(platform);
});
afterAll(async () => {
  await app?.close();
  await platform?.mongo.db.dropDatabase().catch(() => {});
  await platform?.close();
});

const get = (url: string) => app.inject({ method: 'GET', url });
const unique = (label: string) => `${label} ${randomBytes(8).toString('hex')}`;

/** A 404 with the id replaced, so refused and unknown responses can be compared byte for byte. */
async function notFoundShape(id: string, path = '') {
  const res = await get(`/api/artifacts/${id}${path}`);
  return {
    status: res.statusCode,
    contentType: res.headers['content-type'],
    body: res.body.split(id).join('<id>'),
  };
}

const REFUSAL_PATHS = ['', '/content', '/content?preview=10'];

/**
 * Asserts both routes (and a preview) answer for `id` exactly as for an unknown id, and that no
 * byte of the artifact is read while refusing it.
 */
async function expectRefusedLikeUnknown(id: string) {
  const unknown = `art_${randomBytes(16).toString('hex')}`;
  const readBytes = vi.spyOn(platform.artifacts, 'readBytes');
  try {
    for (const path of REFUSAL_PATHS) {
      const refused = await notFoundShape(id, path);
      expect(refused.status).toBe(404);
      expect(refused).toEqual(await notFoundShape(unknown, path));
    }
    expect(readBytes).not.toHaveBeenCalled();
  } finally {
    readBytes.mockRestore();
  }
}

describe('generic artifact routes (FE-P6)', () => {
  it('serve Market artifacts exactly as before', async () => {
    const html = `<html><script>alert(1)</script>${unique('market')}</html>`;
    const ref = await platform.artifacts.put(html, 'text/html', { labels: { sourceId: 'src_market' } });
    const metaRes = await get(`/api/artifacts/${ref.artifactId}`);
    expect(metaRes.statusCode).toBe(200);
    expect(metaRes.json()).toMatchObject({ _id: ref.artifactId, mimeType: 'text/html', sha256: ref.sha256 });

    const content = await get(`/api/artifacts/${ref.artifactId}/content`);
    expect(content.statusCode).toBe(200);
    expect(content.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    expect(content.headers['content-security-policy']).toBe("default-src 'none'");
    expect(content.headers['x-artifact-mime-type']).toBe('text/html');
    expect(content.body).toBe(html);
    expect((await get(`/api/artifacts/${ref.artifactId}/content?preview=6`)).body).toBe('<html>');

    const bin = await platform.artifacts.put(new Uint8Array([0, 1, 2, 255]), 'application/pdf');
    const binRes = await get(`/api/artifacts/${bin.artifactId}/content`);
    expect(binRes.headers['content-type']).toBe('application/octet-stream');
    expect(binRes.headers['x-content-type-options']).toBe('nosniff');
  });

  it('refuse an artifact stored with the Professional label on both routes, like an unknown id', async () => {
    const ref = await platform.artifacts.put(unique('professional cv'), 'text/plain', {
      labels: { domain: 'professional' },
    });
    await expectRefusedLikeUnknown(ref.artifactId);
  });

  it('refuse an unlabelled artifact the runtime wrote for a Professional workflow', async () => {
    // Node-output spills, record sets and generic http/browser/artifact nodes carry only the
    // run's context (workflowKey) and correlation labels.
    const ref = await platform.artifacts.put(unique('node output'), 'application/json', {
      runId: 'run_guard',
      nodeRunId: 'nrun_guard',
      workflowKey: 'professional.source.ingest',
      labels: { sourceId: 'psrc_guard' },
    });
    await expectRefusedLikeUnknown(ref.artifactId);
  });

  it('refuse an unlabelled artifact that a Professional snapshot or extraction references', async () => {
    const snapRef = await platform.artifacts.put(unique('uploaded document'), 'text/plain');
    const textRef = await platform.artifacts.put(unique('normalized text'), 'text/plain');
    // Before any Professional reference exists, the bytes are servable (they carry no label).
    expect((await get(`/api/artifacts/${snapRef.artifactId}`)).statusCode).toBe(200);

    const db = platform.mongo.db;
    const ids = { subjectId: 'psub_guard', sourceId: 'psrc_guard', snapshotId: 'psnap_guard' };
    await db.collection('professional_snapshots').insertOne({
      _id: ids.snapshotId as never,
      subjectId: ids.subjectId,
      sourceId: ids.sourceId,
      artifact: snapRef,
      contentHash: snapRef.sha256,
      mimeType: 'text/plain',
      via: 'upload',
      sourceAsOf: now,
      sourceAsOfKind: 'acquired',
      acquisitions: 1,
      firstAcquiredAt: now,
      lastAcquiredAt: now,
      ...meta,
    });
    await db.collection('professional_extractions').insertOne({
      _id: 'pext_guard' as never,
      subjectId: ids.subjectId,
      sourceId: ids.sourceId,
      snapshotId: ids.snapshotId,
      extractor: { name: 'text', version: 1, kind: 'text' },
      status: 'completed',
      current: true,
      textArtifact: textRef,
      sections: [],
      counts: { observations: 0, dropped: 0, protectedDropped: 0, unverifiedSpans: 0 },
      ...meta,
    });

    for (const ref of [snapRef, textRef]) await expectRefusedLikeUnknown(ref.artifactId);
  });

  it('fail closed: an ownership-check error serves neither metadata nor bytes', async () => {
    const text = unique('market text');
    const ref = await platform.artifacts.put(text, 'text/plain');
    const spy = vi.spyOn(platform.artifactAccess, 'isRestricted').mockRejectedValue(new Error('db down'));
    try {
      for (const path of ['', '/content']) {
        const res = await get(`/api/artifacts/${ref.artifactId}${path}`);
        expect(res.statusCode).toBe(500);
        expect(res.body).not.toContain(text);
        expect(res.body).not.toContain(ref.sha256);
      }
    } finally {
      spy.mockRestore();
    }
    expect((await get(`/api/artifacts/${ref.artifactId}/content`)).body).toBe(text);
  });

  it('unknown ids behave exactly as before (404 not_found)', async () => {
    const res = await get('/api/artifacts/art_missing');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: {
        code: 'not_found',
        message: 'Artifact art_missing not found',
        details: { entity: 'Artifact', id: 'art_missing' },
      },
    });
    expect((await get('/api/artifacts/art_missing/content')).statusCode).toBe(404);
  });
});

describe('GET /api/runs/:id artifact refs (FE-P6)', () => {
  const trigger = {
    id: 'start',
    capability: { type: 'core.manual_trigger', version: 1 },
    input: { payload: { $ref: 'run.input' } },
  };
  async function startProbeRun(workflowKey: string) {
    await platform.runtime.catalog.register({
      key: workflowKey,
      title: 'FE-P6 probe',
      nodes: [trigger],
      edges: [],
    });
    return platform.runtime.engine.startRun({ workflowKey, input: {}, trigger: { kind: 'manual' } });
  }
  const runContext = (run: { _id: string; workflowKey: string }) => ({
    runId: run._id,
    nodeRunId: 'nrun_probe',
    workflowKey: run.workflowKey,
  });

  it('lists a Market run’s artifacts as before, except bytes a Professional document references', async () => {
    const run = await startProbeRun(`fe_p6.market_probe_${randomBytes(3).toString('hex')}`);
    const kept = await platform.artifacts.put(unique('market output'), 'text/plain', runContext(run));
    const shared = await platform.artifacts.put(unique('shared bytes'), 'text/plain', runContext(run));

    const before = await get(`/api/runs/${run._id}`);
    expect(before.statusCode).toBe(200);
    const direct = JSON.parse(JSON.stringify(await platform.runtime.queries.getRunDetail(run._id)));
    expect(before.json()).toEqual(direct);
    expect(
      before
        .json()
        .artifacts.map((a: { artifactId: string }) => a.artifactId)
        .sort(),
    ).toEqual([kept.artifactId, shared.artifactId].sort());

    await platform.mongo.db.collection('professional_snapshots').insertOne({
      _id: 'psnap_runguard' as never,
      subjectId: 'psub_runguard',
      sourceId: 'psrc_runguard',
      artifact: shared,
      contentHash: shared.sha256,
      mimeType: 'text/plain',
      via: 'upload',
      sourceAsOf: now,
      sourceAsOfKind: 'acquired',
      acquisitions: 1,
      firstAcquiredAt: now,
      lastAcquiredAt: now,
      ...meta,
    });
    const after = await get(`/api/runs/${run._id}`);
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual({
      ...direct,
      artifacts: direct.artifacts.filter((a: { artifactId: string }) => a.artifactId === kept.artifactId),
    });
    expect(after.body).not.toContain(shared.sha256);
  });

  it('lists no artifact refs for a Professional run', async () => {
    const run = await startProbeRun(`professional.fe_p6_probe_${randomBytes(3).toString('hex')}`);
    const ref = await platform.artifacts.put(
      unique('professional node output'),
      'application/json',
      runContext(run),
    );
    expect((await platform.runtime.queries.getRunDetail(run._id)).artifacts).toHaveLength(1);

    const res = await get(`/api/runs/${run._id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().run._id).toBe(run._id);
    expect(res.json().artifacts).toEqual([]);
    expect(res.body).not.toContain(ref.sha256);
    expect(res.body).not.toContain(ref.artifactId);
  });
});
