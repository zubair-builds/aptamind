import cors from '@fastify/cors';
import Fastify from 'fastify';
import { newId } from '@aptamind/contracts';
import { withCorrelation } from '@aptamind/observability';
import { metrics } from '@aptamind/observability';
import type { Platform } from '@aptamind/platform';
import { errorHandler } from './errors';
import { resolveActor } from './request-context';
import { RequestLogController, requestLogSerializer } from './request-log';
import { entityRoutes } from './routes/entities';
import { healthRoutes } from './routes/health';
import { metaRoutes } from './routes/meta';
import { opsRoutes } from './routes/ops';
import { professionalRoutes } from './routes/professional';
import { importRoutes } from './routes/imports';
import { sourceRoutes } from './routes/sources';
import { workflowRoutes } from './routes/workflows';

/**
 * Internal Market API. Stateless: all state lives in MongoDB (and bytes in object storage),
 * so the API can restart at any time without affecting running workflows.
 */
export async function buildApp(platform: Platform) {
  const app = Fastify({
    // Request logs record the path (never the query string) and the route template; private
    // domains' paths only as their template (request-log.ts).
    loggerInstance: platform.logger.child({}, { serializers: { req: requestLogSerializer } }),
    logController: new RequestLogController(),
    genReqId: (req) =>
      typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : newId('req'),
    bodyLimit: 5 * 1024 * 1024,
  });
  await app.register(cors, {
    origin: platform.config.api.corsOrigins.length ? platform.config.api.corsOrigins : false,
  });
  app.addContentTypeParser(
    [
      'text/csv',
      'text/plain',
      'text/tab-separated-values',
      'application/vnd.ms-excel',
      'application/x-ndjson',
      'application/octet-stream',
    ],
    { parseAs: 'buffer', bodyLimit: 200 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );

  app.decorateRequest('ctx', undefined as never);
  app.addHook('onRequest', (req, reply, done) => {
    req.ctx = { requestId: String(req.id), actor: resolveActor(req) };
    reply.header('x-request-id', String(req.id));
    withCorrelation({ requestId: String(req.id) }, () => done());
  });
  app.addHook('onResponse', (req, reply, done) => {
    const route = req.routeOptions?.url ?? 'unknown';
    metrics.inc('api_requests_total', { route, method: req.method, status: String(reply.statusCode) });
    metrics.observe('api_request_duration_ms', reply.elapsedTime, { route, method: req.method });
    done();
  });
  app.setErrorHandler(errorHandler);

  await app.register(healthRoutes, { platform });
  await app.register(sourceRoutes, { platform });
  await app.register(importRoutes, { platform });
  await app.register(workflowRoutes, { platform });
  await app.register(entityRoutes, { platform });
  await app.register(opsRoutes, { platform });
  await app.register(metaRoutes, { platform });
  await app.register(professionalRoutes, { platform });
  return app;
}
