import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '@aptamind/contracts';
import type { Logger } from '@aptamind/observability';
import type { Platform } from '@aptamind/platform';
import {
  countUpload,
  createSubjectInputSchema,
  type HttpError,
  idSchema,
  getObservationQuerySchema,
  includeSensitiveSchema,
  listObservationsQuerySchema,
  notFound,
  listSnapshotsQuerySchema,
  presentExtractions,
  presentObservation,
  presentObservations,
  presentSnapshot,
  presentSnapshots,
  listSourcesQuerySchema,
  listSubjectsQuerySchema,
  registerSourceInputSchema,
  professionalLogger,
  safeError,
  subjectView,
  toHttpError,
  updateSubjectInputSchema,
  type UploadOutcome,
  uploadQuerySchema,
  uploadOutcomeOf,
  uploadTransportError,
} from '@aptamind/professional';
import { idempotencyKey } from './professional-shared';
import { professionalTargetRoutes } from './professional-targets';

/**
 * Subject access seam (context doc §9). v0.1 has no authentication (ADR-0008): every request is
 * the internal operator and this is a no-op. It is the single place where subject-level
 * authorization will be enforced: every subject-scoped route resolves the owning subject and
 * calls it before reading or writing that subject's data.
 */
export function assertSubjectAccess(_actor: Actor, _subjectId: string): void {}

const subjectParams = z.object({ id: idSchema('subject') });
const sourceParams = z.object({ id: idSchema('source') });
const snapshotParams = z.object({ id: idSchema('snapshot') });
const observationParams = z.object({ id: idSchema('observation') });
/** `include=sensitive`: the explicit opt-in for routes that return private values. */
const sensitiveQuerySchema = z.strictObject({ include: includeSensitiveSchema });
const snapshotContentQuerySchema = sensitiveQuerySchema;

/**
 * Professional Intelligence routes (`/api/professional/*`, ADR-0020, domain doc §12). Contracts:
 * docs/programme/contracts/professional-subject-list.md and professional-subject-detail.md.
 * Registered once in `buildApp` as an encapsulated plugin, so the error handler below applies to
 * these routes only. It never logs or echoes request values or MongoDB error internals
 * ([A-NIT-5]: no `errInfo`, `keyValue` or messages — `safeError` / `toHttpError`).
 */
export async function professionalRoutes(app: FastifyInstance, { platform }: { platform: Platform }) {
  const { professional } = platform;

  // Request-path logging for these routes goes through the redacting Professional logger
  // (`domain: professional`, value-bearing keys and MongoDB error internals redacted).
  app.addHook('onRequest', async (req, reply) => {
    const log = professionalLogger(req.log as unknown as Logger) as unknown as FastifyBaseLogger;
    req.log = log;
    reply.log = log;
  });

  const sendError = (res: HttpError, err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    if (res.unexpected) req.log.error({ err: safeError(err) }, 'professional request failed');
    else req.log.info({ code: res.body.error.code, status: res.status }, 'professional request rejected');
    return reply.status(res.status).send(res.body);
  };
  app.setErrorHandler((err, req, reply) => sendError(toHttpError(err, req.ctx?.requestId), err, req, reply));

  // ------------------------------------------------------------------ subjects
  app.post('/api/professional/subjects', async (req, reply) => {
    const input = createSubjectInputSchema.parse(req.body);
    const key = idempotencyKey(req);
    const { subject, created } = await professional.subjects.create(input, req.ctx.actor, key);
    return reply.status(created ? 201 : 200).send({ subject: subjectView(subject), created });
  });

  app.get('/api/professional/subjects', async (req) => {
    const page = await professional.subjects.list(listSubjectsQuerySchema.parse(req.query));
    return { ...page, items: page.items.map(subjectView) };
  });

  app.get('/api/professional/subjects/:id', async (req) => {
    const { id } = subjectParams.parse(req.params);
    assertSubjectAccess(req.ctx.actor, id);
    const overview = await professional.overview(id);
    return { ...overview, subject: subjectView(overview.subject) };
  });

  app.patch('/api/professional/subjects/:id', async (req) => {
    const { id } = subjectParams.parse(req.params);
    assertSubjectAccess(req.ctx.actor, id);
    const input = updateSubjectInputSchema.parse(req.body);
    return { subject: subjectView(await professional.subjects.update(id, input, req.ctx.actor)) };
  });

  app.post('/api/professional/subjects/:id/archive', async (req) => {
    const { id } = subjectParams.parse(req.params);
    assertSubjectAccess(req.ctx.actor, id);
    return { subject: subjectView(await professional.subjects.archive(id, req.ctx.actor)) };
  });

  // ------------------------------------------------------------------ sources
  app.post('/api/professional/subjects/:id/sources', async (req, reply) => {
    const { id } = subjectParams.parse(req.params);
    assertSubjectAccess(req.ctx.actor, id);
    const input = registerSourceInputSchema.parse(req.body);
    const key = idempotencyKey(req);
    const { source, created } = await professional.sources.register(id, input, req.ctx.actor, key);
    return reply.status(created ? 201 : 200).send({ source, created });
  });

  app.get('/api/professional/subjects/:id/sources', async (req) => {
    const { id } = subjectParams.parse(req.params);
    assertSubjectAccess(req.ctx.actor, id);
    return professional.sources.list(id, listSourcesQuerySchema.parse(req.query));
  });

  app.get('/api/professional/sources/:id', async (req) => {
    const { id } = sourceParams.parse(req.params);
    const source = await professional.sources.get(id);
    assertSubjectAccess(req.ctx.actor, source.subjectId);
    const { include } = sensitiveQuerySchema.parse(req.query);
    const detail = await professional.sources.detail(id);
    const snapshots = await professional.ingest.withProcessing(detail.snapshots);
    const sensitive = include === 'sensitive';
    return {
      ...detail,
      snapshots: presentSnapshots(snapshots, sensitive),
      extractions: presentExtractions(detail.extractions, sensitive),
    };
  });

  // ------------------------------------------------------------------ snapshots
  // Uploads take raw bytes of any declared type (the service checks type, signature and
  // limits); the nested context replaces the inherited body parsers for this route only, and
  // bodies above the upload limit are refused while streaming (413) — nothing is buffered.
  const maxUploadBytes = professional.ctx.config.limits.maxUploadBytes;
  await app.register(async (uploads) => {
    uploads.removeAllContentTypeParsers();
    // Fastify's own 413/415 (before the handler) map to the upload codes here only.
    uploads.setErrorHandler((err, req, reply) => {
      const transport = uploadTransportError(err);
      if (transport) countUpload(transport.body.error.code as UploadOutcome, 'unknown');
      return sendError(transport ?? toHttpError(err, req.ctx?.requestId), err, req, reply);
    });
    uploads.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: maxUploadBytes }, (_req, body, done) =>
      done(null, body),
    );
    uploads.post(
      '/api/professional/sources/:id/uploads',
      { bodyLimit: maxUploadBytes },
      async (req, reply) => {
        // Rejections before the upload service runs (bad id, query or key; unknown source) are
        // counted here; the service counts its own outcomes.
        let parsed: { id: string; declaredAsOf?: string; key?: string; include?: string };
        try {
          const { id } = sourceParams.parse(req.params);
          const { declaredAsOf, include } = uploadQuerySchema.parse(req.query);
          const key = idempotencyKey(req);
          const source = await professional.sources.get(id);
          assertSubjectAccess(req.ctx.actor, source.subjectId);
          parsed = { id, declaredAsOf, key, include };
        } catch (err) {
          countUpload(uploadOutcomeOf(err), 'unknown');
          throw err;
        }
        const { id, declaredAsOf } = parsed;
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const { snapshot, created, runId } = await professional.ingest.upload(
          id,
          {
            bytes: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
            contentType: req.headers['content-type'],
            ...(declaredAsOf ? { declaredAsOf: new Date(`${declaredAsOf}T00:00:00Z`) } : {}),
          },
          req.ctx.actor,
          parsed.key,
        );
        return reply
          .status(created ? 201 : 200)
          .send({ snapshot: presentSnapshot(snapshot, parsed.include === 'sensitive'), created, runId });
      },
    );
  });

  /** Structured input: a manual-input or questionnaire form → form snapshot → ingest run. */
  app.post('/api/professional/subjects/:id/statements', async (req, reply) => {
    const { id } = subjectParams.parse(req.params);
    assertSubjectAccess(req.ctx.actor, id);
    const { include } = sensitiveQuerySchema.parse(req.query);
    const key = idempotencyKey(req);
    const { snapshot, created, runId } = await professional.ingest.submitStatements(
      id,
      req.body,
      req.ctx.actor,
      key,
    );
    return reply
      .status(created ? 201 : 200)
      .send({ snapshot: presentSnapshot(snapshot, include === 'sensitive'), created, runId });
  });

  /** Starts a new ingest run for a stored snapshot (e.g. one left unprocessed). */
  app.post('/api/professional/snapshots/:id/reprocess', async (req, reply) => {
    const { id } = snapshotParams.parse(req.params);
    const { include } = sensitiveQuerySchema.parse(req.query);
    const current = await professional.snapshots.get(id);
    assertSubjectAccess(req.ctx.actor, current.subjectId);
    const { snapshot, runId } = await professional.ingest.reprocess(id, req.ctx.actor, idempotencyKey(req));
    return reply.status(202).send({ snapshot: presentSnapshot(snapshot, include === 'sensitive'), runId });
  });

  // ------------------------------------------------------------------ observations
  app.get('/api/professional/subjects/:id/observations', async (req) => {
    const { id } = subjectParams.parse(req.params);
    assertSubjectAccess(req.ctx.actor, id);
    const query = listObservationsQuerySchema.parse(req.query);
    const page = await professional.observations.list(id, query);
    return { ...page, items: presentObservations(page.items, query.include === 'sensitive') };
  });

  app.get('/api/professional/observations/:id', async (req) => {
    const { id } = observationParams.parse(req.params);
    const { include } = getObservationQuerySchema.parse(req.query);
    // Sensitive observations without include=sensitive answer exactly like unknown ids.
    const observation = await professional.observations.get(id, {
      includeSensitive: include === 'sensitive',
    });
    assertSubjectAccess(req.ctx.actor, observation.subjectId);
    return { observation: presentObservation(observation, include === 'sensitive') };
  });

  app.get('/api/professional/sources/:id/snapshots', async (req) => {
    const { id } = sourceParams.parse(req.params);
    const source = await professional.sources.get(id);
    assertSubjectAccess(req.ctx.actor, source.subjectId);
    const query = listSnapshotsQuerySchema.parse(req.query);
    const page = await professional.snapshots.list(id, query);
    const items = await professional.ingest.withProcessing(page.items);
    return { ...page, items: presentSnapshots(items, query.include === 'sensitive') };
  });

  app.get('/api/professional/snapshots/:id', async (req) => {
    const { id } = snapshotParams.parse(req.params);
    const { include } = sensitiveQuerySchema.parse(req.query);
    const snapshot = await professional.snapshots.get(id);
    assertSubjectAccess(req.ctx.actor, snapshot.subjectId);
    return { snapshot: presentSnapshot(await professional.ingest.detail(id), include === 'sensitive') };
  });

  /** A snapshot's private bytes, subject-checked, never rendered by a browser (R-4). */
  app.get('/api/professional/snapshots/:id/content', async (req, reply) => {
    const { id } = snapshotParams.parse(req.params);
    const { include } = snapshotContentQuerySchema.parse(req.query);
    // [RULING] Raw bytes (documents and forms) can hold any sensitive section: served only with
    // include=sensitive; without it the answer is exactly the unknown-snapshot 404.
    if (include !== 'sensitive') throw notFound('snapshot', id);
    const snapshot = await professional.snapshots.get(id);
    assertSubjectAccess(req.ctx.actor, snapshot.subjectId);
    const bytes = await professional.snapshots.content(snapshot);
    const textual = /^(text\/|application\/(json|x-ndjson|xml))/.test(snapshot.mimeType);
    if (!textual) reply.header('content-disposition', 'attachment');
    return reply
      .header('content-type', textual ? 'text/plain; charset=utf-8' : 'application/octet-stream')
      .header('x-artifact-mime-type', snapshot.mimeType)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
      .header('cross-origin-resource-policy', 'same-origin')
      .header('cache-control', 'private, no-store')
      .send(Buffer.from(bytes));
  });

  // ------------------------------------------------------------------ career targets (P5.1)
  professionalTargetRoutes(app, professional, assertSubjectAccess);
}
