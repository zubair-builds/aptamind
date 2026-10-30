import { describe, expect, it } from 'vitest';
import { deriveProcessing, needsRun, type SnapshotProcessing } from './ingest.service';

const launched = { ingest: { state: 'launched' as const, runId: 'run_1', requestedAt: new Date() } };
const ext = (status: 'completed' | 'skipped' | 'failed', version = 2, extra: object = {}) => ({
  status,
  extractor: { name: 'structured_form', version, kind: 'deterministic' as const },
  ...extra,
});

describe('deriveProcessing (P1.3 review L2/L3)', () => {
  it.each<[string, Parameters<typeof deriveProcessing>, SnapshotProcessing]>([
    ['never started', [{}, undefined, {}, 2], { state: 'pending' }],
    ['in flight', [launched, undefined, { run_1: 'RUNNING' }, 2], { state: 'launched', runId: 'run_1' }],
    [
      'run failed',
      [launched, undefined, { run_1: 'FAILED' }, 2],
      { state: 'failed', reason: 'run_failed', runId: 'run_1' },
    ],
    [
      'run cancelled',
      [launched, undefined, { run_1: 'CANCELLED' }, 2],
      { state: 'failed', reason: 'run_failed', runId: 'run_1' },
    ],
    [
      'run document missing',
      [launched, undefined, {}, 2],
      { state: 'failed', reason: 'run_missing', runId: 'run_1' },
    ],
    [
      'run completed without an extraction',
      [launched, undefined, { run_1: 'COMPLETED' }, 2],
      { state: 'failed', reason: 'run_ended_without_extraction', runId: 'run_1' },
    ],
    ['no run-state reader', [launched, undefined, undefined, 2], { state: 'launched', runId: 'run_1' }],
    ['processed', [launched, ext('completed'), {}, 2], { state: 'processed', runId: 'run_1' }],
    [
      'skipped',
      [launched, ext('skipped', 2, { skipReason: 'unsupported_format' }), {}, 2],
      { state: 'skipped', reason: 'unsupported_format', runId: 'run_1' },
    ],
    [
      'failed extraction of the current extractor is final',
      [launched, ext('failed', 2, { error: { code: 'invalid_stored_form' } }), { run_1: 'COMPLETED' }, 2],
      { state: 'failed', reason: 'invalid_stored_form', final: true, runId: 'run_1' },
    ],
    [
      'processed by an older extractor',
      [launched, ext('completed', 1), { run_1: 'COMPLETED' }, 2],
      { state: 'processed', olderExtractorVersion: 1, runId: 'run_1' },
    ],
    [
      'failed under an older extractor: not final (the current one may read it)',
      [launched, ext('failed', 1, { error: { code: 'invalid_stored_form' } }), {}, 2],
      { state: 'failed', reason: 'invalid_stored_form', olderExtractorVersion: 1, runId: 'run_1' },
    ],
  ])('%s', (_name, args, expected) => {
    expect(deriveProcessing(...args)).toEqual(expected);
  });
});

describe('needsRun: only never-started snapshots and run failures are (re)launched', () => {
  it.each<[SnapshotProcessing, boolean]>([
    [{ state: 'pending' }, true],
    [{ state: 'failed', reason: 'run_failed' }, true],
    [{ state: 'failed', reason: 'run_missing' }, true],
    [{ state: 'failed', reason: 'run_ended_without_extraction' }, true],
    [{ state: 'failed', reason: 'invalid_stored_form', final: true }, false],
    [{ state: 'failed', reason: 'invalid_stored_form', olderExtractorVersion: 1 }, false],
    [{ state: 'processed', olderExtractorVersion: 1 }, false],
    [{ state: 'processed' }, false],
    [{ state: 'skipped', reason: 'unsupported_format' }, false],
    [{ state: 'launched', runId: 'run_1' }, false],
  ])('%j → %s', (p, expected) => {
    expect(needsRun(p)).toBe(expected);
  });
});
