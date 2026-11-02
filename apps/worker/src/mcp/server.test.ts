import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NotFoundError } from '@aptamind/contracts';
import type { Platform } from '@aptamind/platform';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpLogger } from './audit';
import type { McpLimiters } from './rate-limit';
import { TokenBucketLimiter, createMcpLimiters } from './rate-limit';
import { startMcpServer, type McpServerHandle } from './server';
import { sourceRow } from './tools/read';

const TOKEN = 'mcp-token-value-0123456789abcdef';
const SECRET = 'super-secret-run-payload';
const STACK = 'STACKTRACE_SHOULD_NOT_LEAK';

interface AuditEvent {
  actor: { kind: string; id: string };
  action: string;
  entity: { kind: string; id: string };
  details: {
    tool: string;
    outcome: string;
    clientIp: string;
    errorCode?: string;
    args?: Record<string, unknown>;
  };
}

interface RunQuery {
  workflowKey?: string;
  state?: string;
  labels?: Record<string, string>;
  topLevelOnly?: boolean;
  limit: number;
  offset: number;
}

const RUNS = [
  {
    _id: 'run_ok',
    workflowKey: 'market.jobs.verify_due',
    workflowVersion: 3,
    state: 'SUCCEEDED',
    depth: 0,
    error: { name: 'Error', message: SECRET, stack: STACK },
    idempotencyKey: SECRET,
  },
  { _id: 'run_pro', workflowKey: 'professional.hidden', workflowVersion: 1, state: 'SUCCEEDED', depth: 0 },
];

function matches(run: (typeof RUNS)[number], filter: Record<string, unknown>): boolean {
  const wk = filter.workflowKey;
  if (typeof wk === 'string') return run.workflowKey === wk;
  if (wk && typeof wk === 'object' && '$not' in wk) return !(wk.$not as RegExp).test(run.workflowKey);
  return true;
}

function fakePlatform(audits: AuditEvent[]): {
  platform: Platform;
  summaryWindows: number[];
  runQueries: RunQuery[];
  runFilters: Array<Record<string, unknown>>;
  dueLimits: number[];
} {
  const summaryWindows: number[] = [];
  const runQueries: RunQuery[] = [];
  const runFilters: Array<Record<string, unknown>> = [];
  const dueLimits: number[] = [];
  const platform = {
    market: {
      audit: {
        async record(event: AuditEvent) {
          audits.push(event);
          return {};
        },
      },
      dashboard: {
        async summary(windowMs: number) {
          summaryWindows.push(windowMs);
          return {
            jobs: 4,
            sources: { failing: [{ key: 'src', health: { status: 'failing', lastError: SECRET } }] },
          };
        },
      },
      freshness: {
        async overdueSources() {
          return [{ sourceId: 'src_overdue' }];
        },
        async jobsDueForVerification(limit: number) {
          dueLimits.push(limit);
          return ['job_a', 'job_b'];
        },
      },
      ctx: { db: {}, clock: { now: () => new Date('2026-01-01T00:00:00.000Z') } },
      jobs: {
        get: async () => {
          throw new Error('jobs.get is not used in this test');
        },
      },
      companies: {
        get: async () => {
          throw new Error('companies.get is not used in this test');
        },
      },
    },
    runtime: {
      queries: {
        async stats(since: Date) {
          return { since: since.toISOString(), activeRuns: 1 };
        },
        async listRuns(query: RunQuery) {
          runQueries.push(query);
          return {
            items: [
              { _id: 'run_ok', workflowKey: 'market.jobs.verify_due', state: 'SUCCEEDED' },
              {
                _id: 'run_pro',
                workflowKey: 'professional.hidden',
                state: 'SUCCEEDED',
                input: { password: SECRET },
              },
            ],
            total: 2,
            limit: query.limit,
            offset: query.offset,
          };
        },
        async getRunDetail(id: string) {
          if (id === 'missing') throw new NotFoundError('WorkflowRun', id);
          const professional = id === 'run_pro';
          return {
            run: {
              _id: id,
              workflowKey: professional ? 'professional.hidden' : 'market.jobs.verify_due',
              workflowVersion: 3,
              state: 'FAILED',
              input: { password: SECRET },
              output: { leaked: SECRET },
              error: { name: 'Error', message: 'boom', code: 'invalid_state', stack: STACK },
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
              updatedAt: new Date('2026-01-01T00:00:01.000Z'),
              startedAt: new Date('2026-01-01T00:00:00.000Z'),
              finishedAt: new Date('2026-01-01T00:00:01.000Z'),
              durationMs: 1000,
            },
            version: { id: 'market.jobs.verify_due@3', version: 3, title: 'Verify', edges: [] },
            nodes: [
              {
                nodeId: 'fetch',
                title: 'Fetch',
                config: { token: SECRET },
                nodeRun: {
                  id: 'nr_1',
                  state: 'FAILED',
                  input: { password: SECRET },
                  output: { leaked: SECRET },
                  error: { name: 'Error', message: 'node boom', stack: STACK },
                  startedAt: new Date('2026-01-01T00:00:00.000Z'),
                  finishedAt: new Date('2026-01-01T00:00:01.000Z'),
                  durationMs: 10,
                },
              },
            ],
            artifacts: [{ artifactId: 'art_1', note: SECRET }],
            children: { FAILED: 1 },
          };
        },
      },
      catalog: {
        async listDefinitions() {
          return [
            {
              _id: 'market.jobs.verify_due',
              title: 'Verify due jobs',
              description: 'Checks jobs that are due',
              latestVersion: 4,
            },
            {
              _id: 'professional.hidden',
              title: 'Hidden',
              description: 'Private',
              latestVersion: 1,
            },
          ];
        },
      },
      engine: {
        db: {
          collection: () => ({
            find: () => ({ toArray: async () => [] }),
          }),
        },
        runs: {
          find(filter: Record<string, unknown>) {
            runFilters.push(filter);
            const rows = RUNS.filter((r) => matches(r, filter));
            const cursor = {
              sort: () => cursor,
              skip: () => cursor,
              limit: () => cursor,
              toArray: async () => rows,
            };
            return cursor;
          },
          async countDocuments(filter: Record<string, unknown>) {
            return RUNS.filter((r) => matches(r, filter)).length;
          },
          async findOne(filter: { _id: string }) {
            return RUNS.find((r) => r._id === filter._id) ?? null;
          },
          aggregate(pipeline: Array<{ $match?: Record<string, unknown> }>) {
            const rows = RUNS.filter((r) => matches(r, { workflowKey: pipeline[0]?.$match?.workflowKey }));
            const by = new Map<string, number>();
            for (const r of rows) by.set(r.state, (by.get(r.state) ?? 0) + 1);
            return { toArray: async () => [...by].map(([_id, n]) => ({ _id, n })) };
          },
        },
      },
    },
    transport: {
      async counts() {
        return {
          waiting: 1,
          active: 0,
          delayed: 0,
          failed: 0,
          completed: 2,
          paused: 0,
          oldestWaitingAgeMs: null,
        };
      },
    },
    workflowAccess: {
      startableGenerically: (key: string) => key !== 'professional.hidden',
    },
  };
  return { platform: platform as unknown as Platform, summaryWindows, runQueries, runFilters, dueLimits };
}

const handles: McpServerHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

async function listen(
  platform: Platform,
  limiters: McpLimiters = createMcpLimiters(),
  logger: McpLogger = { error() {} },
): Promise<McpServerHandle> {
  const handle = await startMcpServer({
    platform,
    config: { enabled: true, port: 0, token: TOKEN, runAllowlist: [] },
    logger,
    limiters,
  });
  handles.push(handle);
  return handle;
}

function encodedNoMessages(body: unknown): boolean {
  const text = JSON.stringify(body);
  return !text.includes('node boom') && !text.includes('"message"');
}

function portOf(handle: McpServerHandle): number {
  const addr = handle.address();
  if (!addr || typeof addr === 'string') throw new Error('expected a bound address');
  return (addr as AddressInfo).port;
}

function rpcMessages(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice('data: '.length).trim();
    if (!payload) continue;
    out.push(JSON.parse(payload) as Record<string, unknown>);
  }
  if (out.length > 0) return out;
  try {
    return [JSON.parse(text) as Record<string, unknown>];
  } catch {
    return [];
  }
}

async function post(
  port: number,
  token: string | undefined,
  body: unknown,
  path = '/mcp',
  extra: Record<string, string> = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extra,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  return { status: res.status, text, messages: rpcMessages(text) };
}

function call(id: number, name: string, args: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

function toolResult(message: Record<string, unknown> | undefined): {
  isError?: boolean;
  text: string;
} {
  const result = message?.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
  return { isError: result?.isError, text: result?.content?.[0]?.text ?? '' };
}

describe('mcp server', () => {
  it('binds to 127.0.0.1', async () => {
    const { platform } = fakePlatform([]);
    const handle = await listen(platform);
    expect(handle.address()).toMatchObject({ address: '127.0.0.1' });
    expect(portOf(handle)).toBeGreaterThan(0);
  });

  it('returns 401 without a token and audits the rejection', async () => {
    const audits: AuditEvent[] = [];
    const { platform } = fakePlatform(audits);
    const port = portOf(await listen(platform));
    const res = await post(
      port,
      undefined,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      '/mcp',
      {
        'cf-connecting-ip': '203.0.113.9',
      },
    );
    expect(res.status).toBe(401);
    expect(JSON.parse(res.text)).toEqual({ error: 'unauthorized' });
    expect(audits).toHaveLength(1);
    const event = audits[0]!;
    expect(event.actor).toEqual({ kind: 'internal-operator', id: 'mcp' });
    expect(event.action).toBe('mcp.http');
    expect(event.entity.kind).toBe('mcp_call');
    expect(event.entity.id).toMatch(/^mcp_/);
    expect(event.details).toMatchObject({
      tool: 'http',
      outcome: 'unauthorized',
      errorCode: 'unauthorized',
      clientIp: 'cf:203.0.113.9',
    });
    expect(JSON.stringify(event)).not.toContain(TOKEN);
  });

  it('returns 404 for any other path', async () => {
    const { platform } = fakePlatform([]);
    const port = portOf(await listen(platform));
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    expect(res.status).toBe(404);
    const other = await post(port, TOKEN, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, '/api/mcp');
    expect(other.status).toBe(404);
  });

  it('lists read tools over HTTP when the token matches', async () => {
    const { platform } = fakePlatform([]);
    const port = portOf(await listen(platform));
    const res = await post(port, TOKEN, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(200);
    const message = res.messages[0];
    const tools = (message?.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? [];
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        'get_company',
        'get_dashboard',
        'get_job',
        'get_run',
        'list_companies',
        'list_jobs',
        'list_runs',
        'list_sources',
        'list_workflows',
      ].sort(),
    );
  });

  it('serves the dashboard from the same services as the admin route', async () => {
    const { platform, summaryWindows, dueLimits } = fakePlatform([]);
    const port = portOf(await listen(platform));
    const res = await post(port, TOKEN, call(2, 'get_dashboard'));
    expect(res.status).toBe(200);
    const { isError, text } = toolResult(res.messages[0]);
    expect(isError).toBeUndefined();
    const body = JSON.parse(text) as {
      jobs: number;
      runs: { byState: Record<string, number> };
      queues: Array<{ queue: string; waiting: number }>;
      freshness: { overdueSources: Array<{ sourceId: string }>; jobsDueForVerification: number };
    };
    expect(summaryWindows).toEqual([24 * 3_600_000]);
    expect(dueLimits).toEqual([1000]);
    expect(body.jobs).toBe(4);
    expect(body.runs.byState).toEqual({ SUCCEEDED: 1 });
    expect(body.queues.map((queue) => queue.queue)).toEqual([
      'wf-node-default',
      'wf-node-io',
      'wf-node-browser',
      'wf-node-ai',
      'wf-fanout',
    ]);
    expect(body.freshness.overdueSources).toEqual([{ sourceId: 'src_overdue' }]);
    expect(body.freshness.jobsDueForVerification).toBe(2);
    expect(text).not.toContain(SECRET);
  });

  it('filters professional runs out of list_runs in the query, so totals match', async () => {
    const { platform, runFilters } = fakePlatform([]);
    const port = portOf(await listen(platform));
    const res = await post(port, TOKEN, call(3, 'list_runs', { limit: 20, offset: 0 }));
    const { text } = toolResult(res.messages[0]);
    const page = JSON.parse(text) as { total: number; items: Array<{ id: string }> };
    expect(runFilters[0]).toMatchObject({ depth: 0 });
    expect(page.items.map((item) => item.id)).toEqual(['run_ok']);
    expect(page.total).toBe(1);
    const encoded = JSON.stringify(page);
    expect(encoded).not.toContain(SECRET);
    expect(encoded).not.toContain(STACK);
    expect(encoded).not.toContain('professional.hidden');

    const pro = await post(port, TOKEN, call(31, 'list_runs', { workflowKey: 'professional.hidden' }));
    expect(JSON.parse(toolResult(pro.messages[0]).text)).toMatchObject({ items: [], total: 0 });
  });

  it('strips input, output and artifacts from get_run and hides professional runs', async () => {
    const { platform } = fakePlatform([]);
    const port = portOf(await listen(platform));
    const ok = await post(port, TOKEN, call(4, 'get_run', { id: 'run_ok' }));
    const shown = toolResult(ok.messages[0]);
    expect(shown.isError).toBeUndefined();
    const body = JSON.parse(shown.text) as {
      id: string;
      workflowKey: string;
      version: number;
      state: string;
      error?: { message: string; code?: string };
      nodes: Array<{ nodeId: string; state: string; error?: { message: string } }>;
    };
    expect(body).toMatchObject({
      id: 'run_ok',
      workflowKey: 'market.jobs.verify_due',
      version: 3,
      state: 'FAILED',
      error: { name: 'Error', code: 'invalid_state' },
    });
    expect(body.error).not.toHaveProperty('message');
    expect(body.nodes[0]).toMatchObject({ nodeId: 'fetch', state: 'FAILED', error: { name: 'Error' } });
    expect(encodedNoMessages(body)).toBe(true);
    expect(body).not.toHaveProperty('input');
    expect(body).not.toHaveProperty('output');
    expect(body).not.toHaveProperty('artifacts');
    expect(body.nodes[0]).not.toHaveProperty('config');
    expect(body.nodes[0]).not.toHaveProperty('input');
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain(SECRET);
    expect(encoded).not.toContain(STACK);

    const hidden = await post(port, TOKEN, call(5, 'get_run', { id: 'run_pro' }));
    const denied = toolResult(hidden.messages[0]);
    expect(denied.isError).toBe(true);
    expect(denied.text).toBe('not_found');
    expect(denied.text).not.toContain(SECRET);
  });

  it('returns a rate-limited tool error and audits it', async () => {
    const audits: AuditEvent[] = [];
    const { platform, summaryWindows } = fakePlatform(audits);
    const limiters: McpLimiters = {
      read: new TokenBucketLimiter({ capacity: 0, refillPerMs: 1 / 60_000, now: () => 0 }),
      write: new TokenBucketLimiter({ capacity: 10, refillPerMs: 10 / 60_000, now: () => 0 }),
    };
    const port = portOf(await listen(platform, limiters));
    const res = await post(port, TOKEN, call(6, 'get_dashboard', { hours: 1 }));
    const result = toolResult(res.messages[0]);
    expect(res.status).toBe(200);
    expect(result.isError).toBe(true);
    expect(result.text).toBe('rate_limited');
    expect(summaryWindows).toEqual([]);
    expect(audits[0]?.details).toMatchObject({
      tool: 'get_dashboard',
      outcome: 'rate_limited',
      errorCode: 'rate_limited',
    });
  });

  it('rejects a body over 1 MiB', async () => {
    const { platform } = fakePlatform([]);
    const port = portOf(await listen(platform));
    const body = Buffer.alloc(1024 * 1024 + 1, 0x61);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'content-length': body.length,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(body);
    });
    expect(status).toBe(413);
  });
});

describe('mcp server hardening', () => {
  it('refuses GET (no SSE stream on a stateless server)', async () => {
    const { platform } = fakePlatform([]);
    const port = portOf(await listen(platform));
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(2000),
    });
    expect(res.status).toBe(405);
  });

  it('rejects a chunked body over 1 MiB without a content-length', async () => {
    const audits: AuditEvent[] = [];
    const { platform } = fakePlatform(audits);
    const port = portOf(await listen(platform));
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
            'transfer-encoding': 'chunked',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', (err) =>
        String(err).includes('EPIPE') || String(err).includes('ECONNRESET') ? undefined : reject(err),
      );
      for (let i = 0; i < 17; i++) req.write(Buffer.alloc(64 * 1024, 0x61));
      req.end();
    });
    expect(status).toBe(413);
    expect(audits.at(-1)?.details).toMatchObject({ tool: 'http', errorCode: 'payload_too_large' });
  });

  it('audits a tool call the SDK rejects for invalid arguments', async () => {
    const audits: AuditEvent[] = [];
    const { platform } = fakePlatform(audits);
    const port = portOf(await listen(platform));
    await post(port, TOKEN, call(7, 'get_dashboard', { hours: 'lots' }));
    expect(audits.at(-1)?.details).toMatchObject({
      tool: 'get_dashboard',
      outcome: 'error',
      errorCode: 'validation_failed',
    });
  });

  it('rate-limits protocol requests with 429', async () => {
    const audits: AuditEvent[] = [];
    const { platform } = fakePlatform(audits);
    const limiters: McpLimiters = {
      read: new TokenBucketLimiter({ capacity: 0, refillPerMs: 1 / 60_000, now: () => 0 }),
      write: new TokenBucketLimiter({ capacity: 10, refillPerMs: 10 / 60_000, now: () => 0 }),
    };
    const port = portOf(await listen(platform, limiters));
    const res = await post(port, TOKEN, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(429);
    expect(audits.at(-1)?.details).toMatchObject({ tool: 'http', outcome: 'rate_limited' });
  });

  it('returns only safe source fields (no tokens, config or lastError)', async () => {
    const { platform } = fakePlatform([]);
    const p = platform as unknown as { market: { ctx: { db: unknown } } };
    p.market.ctx.db = {
      collection: () => ({
        find: () => {
          const c = {
            sort: () => c,
            skip: () => c,
            limit: () => c,
            project: () => c,
            toArray: async () => [],
          };
          return c;
        },
        countDocuments: async () => 0,
        aggregate: () => ({ toArray: async () => [] }),
      }),
    };
    const port = portOf(await listen(platform));
    const res = await post(port, TOKEN, call(8, 'list_sources', {}));
    const result = toolResult(res.messages[0]);
    expect(result.isError).toBeUndefined();
    const row = sourceRow({
      _id: 'src_1',
      key: 'k',
      name: 'n',
      enabled: true,
      endpoint: { boardToken: SECRET },
      acquisition: { config: { secret: SECRET }, credentialRefs: [{ kind: 'env', name: SECRET }] },
      health: { status: 'failing', lastError: SECRET },
    });
    expect(row.health.status).toBe('failing');
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });
});
