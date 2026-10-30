import { describe, expect, it } from 'vitest';
import { AppError } from '@aptamind/contracts';
import { ServiceRegistry } from '@aptamind/workflow-sdk';
import { MARKET } from '../market-domain';
import { refreshImportedBoards } from './imports';

/**
 * OPS-5: a board refresh swallows only `invalid_state` (a disabled source). Any other `runNow`
 * failure fails the node so a retry uses the same `job_urls:<runId>:<sourceId>` key.
 */
const input = {
  enabled: true,
  fanout: {
    total: 1,
    outputs: [{ outcome: 'registered', sourceId: 'src_board', companyId: 'co_1' }],
  },
};

function ctxFor(runNow: (opts: { idempotencyKey?: string }) => Promise<{ runId: string }>) {
  const services = new ServiceRegistry();
  const keys: string[] = [];
  services.register(MARKET, {
    ctx: { logger: { warn() {}, info() {}, error() {}, debug() {} } },
    sources: {
      runNow: async (_id: string, _actor: unknown, _extra: unknown, opts: { idempotencyKey?: string }) => {
        keys.push(opts?.idempotencyKey ?? '');
        return runNow(opts ?? {});
      },
    },
  } as never);
  return { ctx: { services, runId: 'run_import' }, keys };
}

describe('refresh_imported_boards', () => {
  it('rethrows a non-invalid_state failure; the retry starts the same run', async () => {
    let calls = 0;
    const { ctx, keys } = ctxFor(async () => {
      calls += 1;
      if (calls === 1) throw new AppError('unavailable', 'launcher down');
      return { runId: 'run_refresh' };
    });
    await expect(refreshImportedBoards.execute(ctx as never, input as never, {})).rejects.toMatchObject({
      code: 'unavailable',
    });
    const ok = await refreshImportedBoards.execute(ctx as never, input as never, {});
    expect(ok).toMatchObject({
      enabled: true,
      boards: 1,
      started: 1,
      skipped: 0,
      runIds: ['run_refresh'],
    });
    expect(keys).toEqual(['job_urls:run_import:src_board', 'job_urls:run_import:src_board']);
  });

  it('skips a disabled source (invalid_state) and does not throw', async () => {
    const { ctx, keys } = ctxFor(async () => {
      throw new AppError('invalid_state', 'Source board is disabled');
    });
    const ok = await refreshImportedBoards.execute(ctx as never, input as never, {});
    expect(ok).toMatchObject({ enabled: true, boards: 1, started: 0, skipped: 1, runIds: [] });
    expect(keys).toEqual(['job_urls:run_import:src_board']);
  });
});
