import { describe, expect, it } from 'vitest';
import { CancelledError, NodeTimeoutError, RetryableError, TerminalError } from '@aptamind/workflow-sdk';
import { allowedAttempts, computeBackoffMs, decideOnFailure, type FailureContext } from './retry-policy';

const base: FailureContext = {
  error: new Error('boom'),
  timedOut: false,
  cancelled: false,
  leaseLost: false,
  capabilityRetryable: true,
  attemptNo: 1,
  budget: { maxAttempts: 3, manualRetries: 0, resumeCount: 0 },
  policy: { backoffMs: 1000, maxBackoffMs: 5000 },
};

describe('retry policy', () => {
  it('retries retryable errors with exponential, capped backoff', () => {
    expect(decideOnFailure({ ...base, error: new RetryableError('x') })).toEqual({
      kind: 'retry',
      delayMs: 1000,
      attemptStatus: 'failed',
    });
    expect(decideOnFailure({ ...base, attemptNo: 2 })).toMatchObject({ kind: 'retry', delayMs: 2000 });
    expect(computeBackoffMs(10, 1000, 5000)).toBe(5000);
  });

  it('never retries terminal errors, whatever the budget', () => {
    expect(decideOnFailure({ ...base, error: new TerminalError('no') })).toEqual({
      kind: 'fail',
      attemptStatus: 'failed',
    });
  });

  it('uses the capability default for unclassified errors', () => {
    expect(decideOnFailure({ ...base, capabilityRetryable: false }).kind).toBe('fail');
  });

  it('bounds attempts: the last allowed attempt fails permanently', () => {
    expect(decideOnFailure({ ...base, attemptNo: 3 }).kind).toBe('fail');
    expect(decideOnFailure({ ...base, attemptNo: 99 }).kind).toBe('fail');
  });

  it('treats timeouts as retryable failures recorded as timed_out', () => {
    expect(decideOnFailure({ ...base, error: new NodeTimeoutError(10), timedOut: true })).toMatchObject({
      kind: 'retry',
      attemptStatus: 'timed_out',
    });
    expect(
      decideOnFailure({ ...base, error: new NodeTimeoutError(10), timedOut: true, attemptNo: 3 }),
    ).toEqual({ kind: 'fail', attemptStatus: 'timed_out' });
  });

  it('distinguishes cancellation and lost leases from failures', () => {
    expect(decideOnFailure({ ...base, cancelled: true }).kind).toBe('cancelled');
    expect(decideOnFailure({ ...base, leaseLost: true }).kind).toBe('lease_lost');
    expect(decideOnFailure({ ...base, error: new CancelledError() }).kind).toBe('lease_lost');
  });

  it('extends the budget per operator retry and per resume, and restarts backoff per life', () => {
    const budget = { maxAttempts: 3, manualRetries: 1, resumeCount: 1 };
    expect(allowedAttempts(budget)).toBe(7);
    // Attempt 5 is the 1st attempt of the second life (3 + 1 resume consumed before it).
    expect(decideOnFailure({ ...base, budget, attemptNo: 5 })).toMatchObject({
      kind: 'retry',
      delayMs: 1000,
    });
    expect(decideOnFailure({ ...base, budget, attemptNo: 7 }).kind).toBe('fail');
  });
});

describe('acknowledgement failures', () => {
  const ack = {
    ...base,
    capabilityRetryable: false,
    acknowledgementFailure: true,
    budget: { maxAttempts: 1, manualRetries: 0, resumeCount: 0 },
  };
  it('retries a re-executable capability beyond its own budget, bounded', () => {
    expect(decideOnFailure({ ...ack, attemptNo: 1 })).toMatchObject({
      kind: 'retry',
      delayMs: 500,
      acknowledgement: true,
    });
    expect(decideOnFailure({ ...ack, attemptNo: 2, budget: { ...ack.budget, ackRetries: 1 } })).toMatchObject(
      { kind: 'retry' },
    );
    expect(decideOnFailure({ ...ack, attemptNo: 3, budget: { ...ack.budget, ackRetries: 2 } }).kind).toBe(
      'fail',
    );
    expect(allowedAttempts({ ...ack.budget, ackRetries: 2 })).toBe(3);
  });
  it('never re-executes a no_retry capability', () => {
    expect(decideOnFailure({ ...ack, reexecutionAllowed: false, attemptNo: 1 }).kind).toBe('fail');
    expect(decideOnFailure({ ...base, error: new RetryableError('x'), reexecutionAllowed: false }).kind).toBe(
      'fail',
    );
  });
});
