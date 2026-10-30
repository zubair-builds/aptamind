import { type FastifyRequest, LogController } from 'fastify';

/** Private-domain route prefixes whose raw paths are never logged (Professional, R-32/R-37). */
const PRIVATE_PREFIXES = ['/api/professional'];

function isPrivatePath(path: string): boolean {
  return PRIVATE_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * The URL as request logs record it. Query strings are never logged (they carry filters such as
 * a subject reference). Private-domain paths are logged as their route template
 * (`/api/professional/subjects/:id`), or a fixed placeholder when no route matched, so a value
 * placed in a path segment never reaches a log line either. Other paths keep their path.
 */
export function loggableUrl(req: Pick<FastifyRequest, 'url'> & { routeOptions?: { url?: string } }): string {
  const raw = req.url ?? '';
  const q = raw.indexOf('?');
  const path = q === -1 ? raw : raw.slice(0, q);
  if (!isPrivatePath(path)) return path;
  return req.routeOptions?.url ?? `${PRIVATE_PREFIXES.find((p) => path.startsWith(p))}/[unmatched]`;
}

/**
 * Pino serializer for `req` in request logs: Fastify's default fields, with `url` from
 * `loggableUrl` and the matched route template as `route`.
 */
export function requestLogSerializer(req: FastifyRequest) {
  return {
    method: req.method,
    url: loggableUrl(req),
    route: req.routeOptions?.url,
    version: req.headers?.['accept-version'],
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}

/**
 * Fastify's log controller with the one line that bypasses the `req` serializer — "route not
 * found", which quotes the raw URL including its query string — logged through it instead.
 */
export class RequestLogController extends LogController {
  override routeNotFound(request: FastifyRequest): void {
    if (this.isLogDisabled(request)) return;
    request.log.info({ req: request }, 'route not found');
  }
}
