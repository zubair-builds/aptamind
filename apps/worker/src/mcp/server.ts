import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Platform } from '@aptamind/platform';
import { checkBearer } from './auth';
import { McpCallError, withAudit, type McpLogger } from './audit';
import type { McpConfig } from './config';
import type { McpLimiters } from './rate-limit';
import { registerReadTools } from './tools/read';
import { registerRunTools } from './tools/run';

const MAX_BODY_BYTES = 1024 * 1024;

export interface McpServerHandle {
  close(): Promise<void>;
  address(): AddressInfo | string | null;
}

type EnabledMcpConfig = Extract<McpConfig, { enabled: true }>;

/**
 * Stateless Streamable HTTP MCP listener. Bound to loopback only: the bearer token is the
 * only gate, and the worker is not a public API.
 */
export async function startMcpServer(opts: {
  platform: Platform;
  config: EnabledMcpConfig;
  logger: McpLogger;
  limiters: McpLimiters;
}): Promise<McpServerHandle> {
  const { platform, config, logger, limiters } = opts;

  const server = createServer((req, res) => {
    void handleMcpRequest(req, res, { platform, config, logger, limiters }).catch((err: unknown) => {
      logFailure(logger, err, 'mcp request failed');
      sendJson(res, 500, { error: 'internal' });
    });
  });

  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(config.port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  server.on('error', (err) => logFailure(logger, err, 'mcp http server error'));

  return {
    address: () => server.address(),
    async close() {
      if (!server.listening) return;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    platform: Platform;
    config: EnabledMcpConfig;
    logger: McpLogger;
    limiters: McpLimiters;
  },
): Promise<void> {
  const method = req.method ?? 'GET';
  if (requestPath(req) !== '/mcp') {
    reject(req, res, 404, 'not_found');
    return;
  }

  // Streamable HTTP safeguard against DNS rebinding.
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && origin !== 'http://127.0.0.1:' + opts.config.port && origin !== 'https://127.0.0.1:' + opts.config.port) {
    reject(req, res, 403, 'invalid_origin');
    return;
  }
  if (host && !host.startsWith('127.0.0.1')) {
    reject(req, res, 403, 'invalid_host');
    return;
  }

  const ip = clientIp(req);
  const deps = auditDeps(opts, ip);
  if (!checkBearer(authorizationHeader(req), opts.config.token)) {
    const decision = opts.limiters.unauth.take();
    if (decision.ok) {
      await auditOutcome(deps, 'http', new McpCallError('unauthorized', 'unauthorized'));
    }
    reject(req, res, 401, 'unauthorized');
    return;
  }

  // Stateless server: no SSE stream (GET) and no session to delete (DELETE).
  if (method !== 'POST') {
    res.setHeader('allow', 'POST');
    reject(req, res, 405, 'method_not_allowed');
    return;
  }

  const declared = contentLength(req);
  if (declared !== undefined && declared > MAX_BODY_BYTES) {
    await auditOutcome(deps, 'http', new McpCallError('denied', 'payload_too_large'));
    reject(req, res, 413, 'payload_too_large');
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (err) {
    const code = err instanceof McpCallError ? err.errorCode : 'invalid_json';
    await auditOutcome(deps, 'http', new McpCallError('denied', code));
    reject(req, res, code === 'payload_too_large' ? 413 : 400, code);
    return;
  }

  const messages = Array.isArray(body) ? body : [body];
  const toolCalls = messages.filter(isToolCall);
  // Protocol requests (initialize, tools/list, ping, notifications) share the read budget;
  // tool calls take their own token inside the tool so they are audited per tool.
  if (toolCalls.length < messages.length) {
    const decision = opts.limiters.read.take();
    if (!decision.ok) {
      await auditOutcome(deps, 'http', new McpCallError('rate_limited', 'rate_limited'));
      res.setHeader('retry-after', String(Math.ceil(decision.retryAfterMs / 1000)));
      reject(req, res, 429, 'rate_limited');
      return;
    }
  }

  const mcp = new McpServer({ name: 'aptamind-worker', version: '0.1.0' });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    maxRequestBodySize: MAX_BODY_BYTES,
  });
  let settled = false;
  const closeSession = () => {
    if (settled) return;
    settled = true;
    void transport.close().catch(() => undefined);
    void mcp.close().catch(() => undefined);
  };
  res.on('close', closeSession);
  try {
    const schemas = registerReadTools(mcp, { ...deps, platform: opts.platform, limiters: opts.limiters });
    registerRunTools(
      mcp,
      { ...deps, platform: opts.platform, limiters: opts.limiters, runAllowlist: opts.config.runAllowlist },
      schemas,
    );
    // The SDK rejects bad arguments before the tool runs; audit those calls here.
    for (const call of toolCalls) {
      const schema = schemas.get(call.params.name);
      if (!schema) {
        const decision = opts.limiters.read.take();
        if (decision.ok) {
          await auditOutcome(deps, call.params.name.slice(0, 64), new McpCallError('denied', 'unknown_tool'));
        }
      } else if (!schema.safeParse(call.params.arguments ?? {}).success) {
        const bucket = call.params.name === 'start_workflow_run' ? opts.limiters.write : opts.limiters.read;
        const decision = bucket.take();
        if (!decision.ok) {
          await auditOutcome(deps, call.params.name, new McpCallError('rate_limited', 'rate_limited'));
          res.setHeader('retry-after', String(Math.ceil(decision.retryAfterMs / 1000)));
          reject(req, res, 429, 'rate_limited');
          closeSession();
          return;
        }
        await auditOutcome(
          deps,
          call.params.name,
          new McpCallError('error', 'validation_failed'),
          call.params.arguments,
        );
      }
    }
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    logFailure(opts.logger, err, 'mcp transport failed');
    if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
    closeSession();
  }
}

interface ToolCallMessage {
  method: 'tools/call';
  params: { name: string; arguments?: unknown };
}

function isToolCall(m: unknown): m is ToolCallMessage {
  if (!m || typeof m !== 'object') return false;
  const msg = m as { method?: unknown; params?: { name?: unknown } };
  return msg.method === 'tools/call' && typeof msg.params?.name === 'string';
}

async function auditOutcome(
  deps: { platform: Platform; logger: McpLogger; clientIp: string },
  tool: string,
  err: McpCallError,
  args: unknown = {},
): Promise<void> {
  await withAudit(deps, tool, args, async () => {
    throw err;
  }).catch((e: unknown) => {
    if (!(e instanceof McpCallError)) throw e;
  });
}

/** Reject and drop the connection so an unread (possibly endless) body cannot hold the socket. */
function reject(req: IncomingMessage, res: ServerResponse, status: number, error: string): void {
  res.setHeader('connection', 'close');
  sendJson(res, status, { error });
  res.once('finish', () => req.destroy());
}

function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        rejectBody(new McpCallError('denied', 'payload_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        rejectBody(new McpCallError('denied', 'invalid_json'));
      }
    });
    req.on('error', () => {
      if (done) return;
      done = true;
      rejectBody(new McpCallError('denied', 'invalid_json'));
    });
  });
}

function auditDeps(
  opts: { platform: Platform; logger: McpLogger },
  clientIpAddress: string,
): { platform: Platform; logger: McpLogger; clientIp: string } {
  return { platform: opts.platform, logger: opts.logger, clientIp: clientIpAddress };
}

function requestPath(req: IncomingMessage): string {
  const raw = req.url ?? '/';
  try {
    return new URL(raw, 'http://127.0.0.1').pathname;
  } catch {
    return raw.split('?')[0] ?? raw;
  }
}

function authorizationHeader(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  return Array.isArray(header) ? header[0] : header;
}

function clientIp(req: IncomingMessage): string {
  const header = req.headers['cf-connecting-ip'];
  const value = Array.isArray(header) ? header[0] : header;
  // Set by Cloudflare at the tunnel edge; unverified on loopback, so it is only an audit hint.
  if (typeof value === 'string' && value.trim() !== '') return `cf:${value.trim().slice(0, 64)}`;
  return req.socket.remoteAddress ?? '';
}

function contentLength(req: IncomingMessage): number | undefined {
  const raw = req.headers['content-length'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function logFailure(logger: McpLogger, err: unknown, msg: string): void {
  try {
    logger.error({ errName: err instanceof Error ? err.name : typeof err }, msg);
  } catch {
    // Logging must not crash the listener.
  }
}
