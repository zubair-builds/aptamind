import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  companyNames,
  createSourceInputSchema,
  idParamsSchema,
  listSourceSnapshots,
  listSources,
  noQuerySchema,
  type ScheduleCollection,
  snapshotUploadQuerySchema,
  sourceListQuerySchema,
  sourceRunsQuerySchema,
  sourceScheduleState,
  sourceSnapshotsQuerySchema,
  updateSourceInputSchema,
  uploadSnapshot,
  withFreshness,
  withoutExpiredAssignment,
} from '@aptamind/market';
import type { Platform } from '@aptamind/platform';
import { uploadedFile, uploadPreParsing } from './upload';

export async function sourceRoutes(app: FastifyInstance, { platform }: { platform: Platform }) {
  const { market, runtime } = platform;
  const schedules = runtime.engine.db.collection('workflow_schedules') as unknown as ScheduleCollection;

  app.get('/api/sources', async (req) => {
    const q = sourceListQuerySchema.parse(req.query);
    return listSources(market.ctx.db, q, market.ctx.clock.now(), schedules);
  });

  app.post('/api/sources', async (req, reply) => {
    noQuerySchema.parse(req.query);
    const input = createSourceInputSchema.parse(req.body);
    const { source, created } = await market.sources.register(input, req.ctx.actor);
    return reply.status(created ? 201 : 200).send({ source, created });
  });

  app.get('/api/sources/:id', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    noQuerySchema.parse(req.query);
    const source = await market.sources.get(id);
    const [runs, snapshots, schedule, openReviews, audit] = await Promise.all([
      runtime.queries.listRuns({ labels: { sourceId: id }, topLevelOnly: true, limit: 20, offset: 0 }),
      market.observations.snapshots.find({ sourceId: id }).sort({ lastFetchedAt: -1 }).limit(10).toArray(),
      schedules.findOne({ 'owner.kind': 'source', 'owner.id': id }),
      market.reviews.list({ status: 'open', entityId: id, limit: 20, offset: 0 }),
      market.audit.list({ entityKind: 'source', entityId: id }, 20),
    ]);
    const companyName = source.companyId
      ? ((await companyNames(market.ctx.db, [source.companyId])).get(source.companyId) ?? null)
      : null;
    return {
      // The list row's additions (M7.4, OPS-1): server-computed freshness, the company's name
      // and the schedule state.
      source: {
        ...withFreshness(source, market.ctx.clock.now()),
        companyName,
        schedule: sourceScheduleState(source, schedule),
      },
      runs: runs.items,
      snapshots,
      schedule,
      openReviews: openReviews.items.map((r) => withoutExpiredAssignment(r, market.ctx.clock.now())),
      audit,
    };
  });

  /** Paginated run history of a source (top-level runs labelled with it), newest first. */
  app.get('/api/sources/:id/runs', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const q = sourceRunsQuerySchema.parse(req.query);
    await market.sources.get(id); // 404 for an unknown source
    return runtime.queries.listRuns({
      labels: { sourceId: id },
      topLevelOnly: true,
      state: q.state,
      workflowKey: q.workflowKey,
      limit: q.limit,
      offset: q.offset,
    });
  });

  /** Paginated snapshots of a source, newest fetch first (keyset `after` or `offset`). */
  app.get('/api/sources/:id/snapshots', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const q = sourceSnapshotsQuerySchema.parse(req.query);
    await market.sources.get(id); // 404 for an unknown source
    return listSourceSnapshots(market.ctx.db, id, q);
  });

  app.patch('/api/sources/:id', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    noQuerySchema.parse(req.query);
    return {
      source: await market.sources.update(id, updateSourceInputSchema.parse(req.body), req.ctx.actor),
    };
  });

  app.post('/api/sources/:id/enable', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    noQuerySchema.parse(req.query);
    return { source: await market.sources.setEnabled(id, true, req.ctx.actor) };
  });

  app.post('/api/sources/:id/disable', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    noQuerySchema.parse(req.query);
    return { source: await market.sources.setEnabled(id, false, req.ctx.actor) };
  });

  app.post('/api/sources/:id/run', async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    noQuerySchema.parse(req.query);
    const body = z
      .object({ snapshotId: z.string().optional(), force: z.boolean().optional() })
      .default({})
      .parse(req.body ?? {});
    // `force` (dataset imports): import an unchanged file in full, e.g. to re-check register rows
    // that matched no known company before the universe grew (PR #6 review).
    const res = await market.sources.runNow(id, req.ctx.actor, {
      ...(body.snapshotId ? { snapshotId: body.snapshotId } : {}),
      ...(body.force ? { force: true } : {}),
    });
    return reply.status(202).send(res);
  });

  /** Upload a dataset/listing file as a snapshot (e.g. offline import), optionally processing it. */
  app.post(
    '/api/sources/:id/snapshots',
    {
      bodyLimit: 200 * 1024 * 1024,
      preParsing: uploadPreParsing(market, (req) => idParamsSchema.parse(req.params).id),
    },
    async (req, reply) => {
      const { id } = idParamsSchema.parse(req.params);
      const q = snapshotUploadQuerySchema.parse(req.query);
      const { body, contentType } = uploadedFile(req);
      const snap = await uploadSnapshot(market, id, body, contentType, req.ctx.actor);
      const run =
        q.process === 'true'
          ? await market.sources.runNow(id, req.ctx.actor, { snapshotId: snap.snapshotId })
          : null;
      return reply.status(201).send({
        snapshotId: snap.snapshotId,
        artifactId: snap.artifactId,
        unchanged: snap.unchanged,
        warnings: snap.warnings,
        runId: run?.runId ?? null,
      });
    },
  );

  app.get('/api/snapshots/:id', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    noQuerySchema.parse(req.query);
    return market.observations.getSnapshot(id);
  });

  app.post('/api/snapshots/:id/reprocess', async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    noQuerySchema.parse(req.query);
    const snap = await market.observations.getSnapshot(id);
    return reply
      .status(202)
      .send(await market.sources.runNow(snap.sourceId, req.ctx.actor, { snapshotId: snap._id }));
  });
}
