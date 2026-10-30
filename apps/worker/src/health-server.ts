import { createServer, type Server } from 'node:http';
import { metrics } from '@aptamind/observability';
import type { Platform } from '@aptamind/platform';

/** Minimal HTTP endpoint for worker liveness/readiness and Prometheus metrics. */
export function startHealthServer(platform: Platform, port: number, isRunning: () => boolean): Server {
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/health') {
        res.writeHead(isRunning() ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: isRunning() ? 'ok' : 'stopping', workerId: platform.workerId }));
        return;
      }
      if (req.url === '/ready') {
        const checks = await platform.checks();
        const ok = Object.values(checks).every(Boolean) && isRunning();
        res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: ok ? 'ready' : 'not_ready', checks }));
        return;
      }
      if (req.url === '/metrics') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        res.end(metrics.toPrometheus());
        return;
      }
      res.writeHead(404).end();
    } catch (err) {
      res
        .writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: (err as Error).message }));
    }
  });
  // Bound to localhost: the worker has no authentication.
  server.listen(port, '127.0.0.1');
  return server;
}
