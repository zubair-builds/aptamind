import type { FastifyInstance } from 'fastify';
import { metrics } from '@aptamind/observability';
import type { Platform } from '@aptamind/platform';

export async function healthRoutes(app: FastifyInstance, { platform }: { platform: Platform }) {
  app.get('/health', async () => ({ status: 'ok', service: 'api', auth: 'none (internal only)' }));
  app.get('/ready', async (_req, reply) => {
    const checks = await platform.checks();
    const ok = Object.values(checks).every(Boolean);
    return reply.status(ok ? 200 : 503).send({ status: ok ? 'ready' : 'not_ready', checks });
  });
  app.get('/metrics', async (_req, reply) =>
    reply.type('text/plain; version=0.0.4').send(metrics.toPrometheus()),
  );
}
