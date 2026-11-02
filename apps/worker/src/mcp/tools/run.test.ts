import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NotFoundError } from '@aptamind/contracts';
import type { Platform } from '@aptamind/platform';
import { describe, expect, it } from 'vitest';
import { TokenBucketLimiter, createMcpLimiters, type McpLimiters } from '../rate-limit';
import { canonicalJson, registerRunTools } from './run';

const KEY = 'market.job.propose_requirements';

interface Run {
  _id: string;
  workflowKey: string;
  input: Record<string, unknown>;
  state: string;
  idempotencyKey: string;
}

function fake() {
  const runs: Run[] = [];
  const audits: Array<{ action: string; details: Record<string, unknown> }> = [];
  const started: Array<Record<string, unknown>> = [];
  const platform = {
    market: {
      audit: { record: async (e: { action: string; details: Record<string, unknown> }) => audits.push(e) },
      sources: {
        assertWorkflowRunAllowed: async () => undefined,
        get: async (id: string) => {
          if (id !== 'src_ok') throw new NotFoundError('Source', id);
          return { _id: id };
        },
      },
    },
    workflowAccess: { startableGenerically: (k: string) => !k.startsWith('professional.') },
    runtime: {
      catalog: {
        getVersion: async (k: string) => ({
          workflowKey: k,
          version: 2,
          inputSchema: {
            type: 'object',
            required: ['jobId'],
            properties: { jobId: { type: 'string', minLength: 1 } },
          },
        }),
      },
      engine: {
        runs: {
          findOne: async (f: { idempotencyKey: string }) =>
            runs.find((r) => r.idempotencyKey === f.idempotencyKey) ?? null,
        },
        startRun: async (req: {
          workflowKey: string;
          input: Record<string, unknown>;
          idempotencyKey: string;
        }) => {
          started.push(req as unknown as Record<string, unknown>);
          const run = {
            _id: `run_${runs.length + 1}`,
            state: 'PENDING',
            workflowVersion: 2,
            createdAt: new Date(),
            ...req,
          };
          runs.push(run);
          return run;
        },
      },
    },
  };
  return { platform: platform as unknown as Platform, runs, audits, started };
}

async function client(platform: Platform, allow: string[], limiters: McpLimiters = createMcpLimiters()) {
  const server = new McpServer({ name: 't', version: '0' });
  registerRunTools(
    server,
    { platform, limiters, runAllowlist: allow, logger: { error() {} }, clientIp: 'x' },
    new Map(),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: 'c', version: '0' });
  await c.connect(b);
  return async (args: Record<string, unknown>) => {
    const r = (await c.callTool({ name: 'start_workflow_run', arguments: args })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    return { isError: r.isError ?? false, text: r.content[0]?.text ?? '' };
  };
}

describe('start_workflow_run', () => {
  it('denies everything when the allowlist is empty', async () => {
    const f = fake();
    const call = await client(f.platform, []);
    const r = await call({ workflowKey: KEY, input: { jobId: 'job_1' }, idempotencyKey: 'abc12345' });
    expect(r).toEqual({ isError: true, text: 'workflow_not_allowed' });
    expect(f.started).toHaveLength(0);
    expect(f.audits[0]?.details).toMatchObject({ outcome: 'denied', errorCode: 'workflow_not_allowed' });
  });

  it('refuses a professional workflow even when allowlisted', async () => {
    const f = fake();
    const call = await client(f.platform, ['professional.x']);
    const r = await call({ workflowKey: 'professional.x', input: {}, idempotencyKey: 'abc12345' });
    expect(r.text).toBe('not_found');
    expect(f.started).toHaveLength(0);
  });

  it('validates input against the stored inputSchema (empty jobId rejected)', async () => {
    const f = fake();
    const call = await client(f.platform, [KEY]);
    const r = await call({ workflowKey: KEY, input: { jobId: '' }, idempotencyKey: 'abc12345' });
    expect(r.isError).toBe(true);
    expect(r.text).toBe('validation_failed');
    expect(f.started).toHaveLength(0);
  });

  it('requires an idempotency key', async () => {
    const f = fake();
    const call = await client(f.platform, [KEY]);
    const r = await call({ workflowKey: KEY, input: { jobId: 'job_1' } });
    expect(r.isError).toBe(true);
    expect(f.started).toHaveLength(0);
  });

  it('starts a run with a prefixed key and the mcp actor, and replays it once', async () => {
    const f = fake();
    const call = await client(f.platform, [KEY]);
    const first = await call({ workflowKey: KEY, input: { jobId: 'job_1' }, idempotencyKey: 'abc12345' });
    expect(JSON.parse(first.text)).toMatchObject({ runId: 'run_1', state: 'PENDING', replayed: false });
    expect(f.started[0]).toMatchObject({
      workflowKey: KEY,
      version: 2,
      idempotencyKey: `mcp:${KEY}:abc12345`,
      trigger: { kind: 'manual', actor: { kind: 'internal-operator', id: 'mcp' } },
    });
    const again = await call({ workflowKey: KEY, input: { jobId: 'job_1' }, idempotencyKey: 'abc12345' });
    expect(JSON.parse(again.text)).toMatchObject({ runId: 'run_1', replayed: true });
    expect(f.started).toHaveLength(1);
    expect(f.audits.map((a) => a.details.outcome)).toEqual(['ok', 'ok']);
  });

  it('refuses a replay with different input', async () => {
    const f = fake();
    const call = await client(f.platform, [KEY]);
    await call({ workflowKey: KEY, input: { jobId: 'job_1' }, idempotencyKey: 'abc12345' });
    const r = await call({ workflowKey: KEY, input: { jobId: 'job_2' }, idempotencyKey: 'abc12345' });
    expect(r).toEqual({ isError: true, text: 'idempotency_conflict' });
    expect(f.started).toHaveLength(1);
  });

  it('uses the write bucket (10/min)', async () => {
    const f = fake();
    const limiters = {
      read: new TokenBucketLimiter({ capacity: 60, refillPerMs: 1, now: () => 0 }),
      write: new TokenBucketLimiter({ capacity: 0, refillPerMs: 1 / 60_000, now: () => 0 }),
    };
    const call = await client(f.platform, [KEY], limiters);
    const r = await call({ workflowKey: KEY, input: { jobId: 'job_1' }, idempotencyKey: 'abc12345' });
    expect(r).toEqual({ isError: true, text: 'rate_limited' });
    expect(f.audits[0]?.details).toMatchObject({ outcome: 'rate_limited' });
  });

  it('fails closed on an unknown sourceId', async () => {
    const f = fake();
    const call = await client(f.platform, [KEY]);
    const r = await call({
      workflowKey: KEY,
      input: { jobId: 'j', sourceId: 'src_gone' },
      idempotencyKey: 'abc12345',
    });
    expect(r.text).toBe('not_found');
    expect(f.started).toHaveLength(0);
  });

  it('records runId and replayed in the audit', async () => {
    const f = fake();
    const call = await client(f.platform, [KEY]);
    await call({ workflowKey: KEY, input: { jobId: 'job_1' }, idempotencyKey: 'abc12345' });
    expect(f.audits[0]?.details).toMatchObject({ runId: 'run_1', replayed: false });
  });

  it('rejects ":" in keys so prefixed keys cannot collide', async () => {
    const f = fake();
    const call = await client(f.platform, [KEY]);
    const r = await call({ workflowKey: KEY, input: { jobId: 'j' }, idempotencyKey: 'a:b:c:d:e' });
    expect(r.isError).toBe(true);
  });

  it('canonical JSON ignores key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});
