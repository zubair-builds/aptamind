import { createServer, type Server } from 'node:http';

/**
 * Public liveness endpoint for hosts that require an open port (e.g. a Render web service,
 * kept awake by an UptimeRobot ping). Static by design: it touches no dependency and returns
 * no worker id, checks, metrics or error text. Everything except GET/HEAD /healthz is 404.
 * `/ready` and `/metrics` stay on the loopback-only health server.
 */
export function startPublicHealthServer(port: number, isRunning: () => boolean, host = '0.0.0.0'): Server {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      const ok = isRunning();
      const body = JSON.stringify({ status: ok ? 'ok' : 'stopping' });
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, host);
  return server;
}

/** Parses `PORT` (set by the hosting platform). Returns null when unset or invalid. */
export function parsePublicPort(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}
