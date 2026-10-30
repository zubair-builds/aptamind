import { describe, expect, it } from 'vitest';
import { CancelledError, NodeTimeoutError } from '@aptamind/workflow-sdk';
import { ExecutionGuard } from './execution-guard';

const never = () => new Promise<never>(() => {});

describe('ExecutionGuard', () => {
  it('times out work that ignores its abort signal', async () => {
    const g = new ExecutionGuard({ timeoutMs: 20 });
    await expect(g.run(never())).rejects.toBeInstanceOf(NodeTimeoutError);
    expect(g.timedOut).toBe(true);
    expect(g.failureOf(new Error('other'))).toBeInstanceOf(NodeTimeoutError);
    g.dispose();
  });

  it('aborts on cancellation observed by the heartbeat', async () => {
    const g = new ExecutionGuard({ heartbeat: async () => 'cancelled', heartbeatEveryMs: 1_000 });
    const p = g.run(never());
    await g.beat();
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    expect(g.cancelled).toBe(true);
    g.dispose();
  });

  it('aborts when the lease is lost', async () => {
    const g = new ExecutionGuard({ heartbeat: async () => 'lease_lost' });
    const p = g.run(never());
    await g.beat();
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    expect(g.leaseLost).toBe(true);
    g.dispose();
  });

  it('propagates a parent abort and stops the clock on request', async () => {
    const parent = new AbortController();
    const g = new ExecutionGuard({ timeoutMs: 10, parent: parent.signal });
    g.stopTimeout();
    const p = g.run(never());
    parent.abort(new CancelledError('parent'));
    await expect(p).rejects.toThrow('parent');
    expect(g.timedOut).toBe(false);
    g.dispose();
  });

  it('returns results of work that finishes in time', async () => {
    const g = new ExecutionGuard({ timeoutMs: 1_000 });
    await expect(g.run(Promise.resolve(42))).resolves.toBe(42);
    g.dispose();
  });
});
