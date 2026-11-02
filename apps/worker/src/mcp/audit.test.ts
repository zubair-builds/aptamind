import { AppError } from '@aptamind/contracts';
import { describe, expect, it, vi } from 'vitest';
import { withAudit, type McpAuditDeps } from './audit';

interface Recorded {
  actor: { kind: string; id: string };
  action: string;
  entity: { kind: string; id: string };
  details: {
    tool: string;
    outcome: string;
    durationMs: number;
    resultCount?: number;
    args: Record<string, unknown>;
    clientIp: string;
    errorCode?: string;
  };
}

function deps(record: (event: Recorded) => Promise<unknown>, logger = { error: vi.fn() }): McpAuditDeps {
  return {
    platform: { market: { audit: { record: (e) => record(e as unknown as Recorded) } } },
    logger,
    clientIp: '203.0.113.4',
  };
}

describe('withAudit', () => {
  it('records the call shape, a redacted arg summary and the result count', async () => {
    const events: Recorded[] = [];
    const nested = { secret: 'do-not-leak-nested' };
    const result = await withAudit(
      deps(async (event) => {
        events.push(event);
        return {};
      }),
      'list_jobs',
      {
        q: 'engineer',
        note: 'n'.repeat(250),
        nested,
        tags: ['do-not-leak-array'],
        ok: true,
        n: 3,
        empty: null,
      },
      async () => ({ items: [{ id: 'a' }, { id: 'b' }], total: 2 }),
    );
    expect(result).toEqual({ items: [{ id: 'a' }, { id: 'b' }], total: 2 });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.actor).toEqual({ kind: 'internal-operator', id: 'mcp' });
    expect(event.action).toBe('mcp.list_jobs');
    expect(event.entity.kind).toBe('mcp_call');
    expect(event.entity.id).toMatch(/^mcp_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(event.details.tool).toBe('list_jobs');
    expect(event.details.outcome).toBe('ok');
    expect(event.details.clientIp).toBe('203.0.113.4');
    expect(event.details.durationMs).toBeGreaterThanOrEqual(0);
    expect(event.details.resultCount).toBe(2);
    expect(event.details.args.q).toBe('engineer');
    expect(event.details.args.note).toBe('n'.repeat(200));
    expect(event.details.args.ok).toBe(true);
    expect(event.details.args.n).toBe(3);
    expect(event.details.args.empty).toBeNull();
    expect(event.details.args.nested).toBe('[redacted]');
    expect(event.details.args.tags).toBe('[redacted]');
    const encoded = JSON.stringify(event);
    expect(encoded).not.toContain('do-not-leak-nested');
    expect(encoded).not.toContain('do-not-leak-array');
  });

  it('records an AppError and rethrows it', async () => {
    const events: Recorded[] = [];
    const run = withAudit(
      deps(async (event) => {
        events.push(event);
        return {};
      }),
      'get_job',
      { id: 'job_1' },
      async () => {
        throw new AppError('not_found', 'Job job_1 not found');
      },
    );
    await expect(run).rejects.toBeInstanceOf(AppError);
    expect(events[0]?.details.outcome).toBe('error');
    expect(events[0]?.details.errorCode).toBe('not_found');
    expect(events[0]?.details.resultCount).toBeUndefined();
  });

  it('swallows an audit failure and still returns the tool result', async () => {
    const logger = { error: vi.fn() };
    const result = await withAudit(
      deps(async () => {
        throw new Error('mongo down');
      }, logger),
      'get_dashboard',
      { hours: 24 },
      async () => ({ ok: true }),
    );
    expect(result).toEqual({ ok: true });
    expect(logger.error).toHaveBeenCalledOnce();
    const [payload, msg] = logger.error.mock.calls[0] ?? [];
    expect(msg).toBe('mcp audit failed');
    expect(JSON.stringify(payload)).not.toContain('mongo');
    expect(JSON.stringify(payload)).toContain('get_dashboard');
  });
});
