import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { jsonObjectSchema, NotFoundError, pageQuerySchema } from '@aptamind/contracts';
import type { Platform } from '@aptamind/platform';

export async function workflowRoutes(app: FastifyInstance, { platform }: { platform: Platform }) {
  const { runtime, artifactAccess, workflowAccess } = platform;

  /**
   * Generic mutations of a private domain's runs (Professional) are refused exactly like an
   * unknown id (P1.3 review ruling): the same NotFoundError the engine and queries raise.
   */
  async function mutableRun(runId: string): Promise<void> {
    const run = await runtime.engine.runs.findOne({ _id: runId }, { projection: { workflowKey: 1 } });
    if (!run || !workflowAccess.mutableGenerically(run.workflowKey))
      throw new NotFoundError('WorkflowRun', runId);
  }
  async function mutableNodeRun(nodeRunId: string): Promise<void> {
    const nr = await runtime.engine.nodeRuns.findOne({ _id: nodeRunId }, { projection: { workflowKey: 1 } });
    if (!nr || !workflowAccess.mutableGenerically(nr.workflowKey))
      throw new NotFoundError('NodeRun', nodeRunId);
  }

  app.get('/api/capabilities', async () => ({
    items: runtime.registry.list().map((c) => runtime.registry.describe(c)),
  }));

  app.get('/api/workflows', async () => {
    const defs = await runtime.catalog.listDefinitions();
    const schedules = await runtime.scheduler.list();
    return {
      items: defs.map((d) => ({ ...d, schedules: schedules.filter((s) => s.workflowKey === d._id) })),
    };
  });

  app.get('/api/workflows/:key', async (req) => {
    const { key } = z.object({ key: z.string() }).parse(req.params);
    const versions = await runtime.catalog.listVersions(key);
    const runs = await runtime.queries.listRuns({ workflowKey: key, limit: 20, offset: 0 });
    return { key, versions, runs: runs.items };
  });

  app.post('/api/workflows/:key/runs', async (req, reply) => {
    const { key } = z.object({ key: z.string() }).parse(req.params);
    // Private domains' workflows (Professional) start only through their own services.
    if (!workflowAccess.startableGenerically(key)) throw new NotFoundError('Workflow', key);
    const body = z
      .object({
        input: jsonObjectSchema.default({}),
        version: z.number().int().positive().optional(),
        idempotencyKey: z.string().optional(),
      })
      .parse(req.body ?? {});
    // A generic run route must not bypass a source's launch rules (upload-only providers: their
    // pinned workflow, on an uploaded snapshot).
    await platform.market.sources.assertWorkflowRunAllowed(key, body.input);
    const run = await runtime.engine.startRun({
      workflowKey: key,
      version: body.version,
      input: body.input,
      idempotencyKey: body.idempotencyKey,
      labels: typeof body.input.sourceId === 'string' ? { sourceId: body.input.sourceId } : {},
      trigger: { kind: 'manual', actor: { kind: req.ctx.actor.kind, id: req.ctx.actor.id } },
    });
    return reply.status(202).send({ runId: run._id, state: run.state });
  });

  app.get('/api/schedules', async () => ({ items: await runtime.scheduler.list() }));

  app.post('/api/schedules/:id/:action', async (req) => {
    const { id, action } = z
      .object({ id: z.string(), action: z.enum(['enable', 'disable']) })
      .parse(req.params);
    await runtime.scheduler.setEnabled(id, action === 'enable');
    return { ok: true };
  });

  app.get('/api/runs', async (req) => {
    const q = pageQuerySchema
      .extend({
        workflowKey: z.string().optional(),
        state: z.string().optional(),
        sourceId: z.string().optional(),
        parentRunId: z.string().optional(),
        all: z.enum(['true', 'false']).default('false'),
      })
      .parse(req.query);
    const { sourceId, ...rest } = q;
    return runtime.queries.listRuns({
      ...rest,
      labels: sourceId ? { sourceId } : undefined,
      topLevelOnly: q.all !== 'true',
    });
  });

  app.get('/api/runs/stats', async (req) => {
    const { hours } = z
      .object({
        hours: z.coerce
          .number()
          .min(1)
          .max(24 * 30)
          .default(24),
      })
      .parse(req.query);
    return runtime.queries.stats(new Date(Date.now() - hours * 3600_000));
  });

  app.get('/api/runs/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const detail = await runtime.queries.getRunDetail(id);
    // FE-P6: a private domain's artifact refs (size, sha256) are not listed here.
    return { ...detail, artifacts: await artifactAccess.listableRunArtifacts(detail.run, detail.artifacts) };
  });

  app.post('/api/runs/:id/cancel', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await mutableRun(id);
    return { run: await runtime.engine.cancelRun(id, req.ctx.actor) };
  });

  app.get('/api/node-runs/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return runtime.queries.getNodeRun(id);
  });

  app.get('/api/node-runs/:id/chunks', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const q = pageQuerySchema.parse(req.query);
    return runtime.queries.listChunks(id, q.limit, q.offset);
  });

  app.post('/api/node-runs/:id/retry', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await mutableNodeRun(id);
    return { nodeRun: await runtime.engine.retryNodeRun(id, req.ctx.actor) };
  });

  app.post('/api/node-runs/:id/resume', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await mutableNodeRun(id);
    const body = z.object({ payload: jsonObjectSchema.default({}) }).parse(req.body ?? {});
    return { nodeRun: await runtime.engine.resumeNodeRun(id, body.payload, req.ctx.actor) };
  });
}
