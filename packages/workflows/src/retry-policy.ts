import { CancelledError, isRetryable, type RetryPolicy } from '@aptamind/workflow-sdk';
import type { AttemptRecord } from './schemas';

/**
 * Retry policy (pure). Decides what happens after an attempt fails, independently of how
 * the decision is persisted or dispatched.
 *
 * Budget: a node may be attempted `maxAttempts` times per "life". Each operator retry grants
 * one more life (`manualRetries`); resuming a waiting node is not a retry and adds one
 * attempt (`resumeCount`). Attempts are therefore always bounded — there is no infinite retry.
 */

export interface AttemptBudget {
  maxAttempts: number;
  manualRetries: number;
  resumeCount: number;
  /** Extra attempts granted for lost acknowledgements (at most ACK_RETRY_ALLOWANCE). */
  ackRetries?: number;
}

export function allowedAttempts(b: AttemptBudget): number {
  return b.maxAttempts * (b.manualRetries + 1) + b.resumeCount + (b.ackRetries ?? 0);
}

/** Exponential backoff (`base · 2^(n-1)`, capped). Deterministic for testability. */
export function computeBackoffMs(attemptInLife: number, baseMs: number, maxMs: number): number {
  const exp = baseMs * 2 ** Math.max(0, attemptInLife - 1);
  return Math.min(maxMs, exp);
}

/** 1-based attempt number within the current life (operator retries restart backoff). */
export function attemptInCurrentLife(attemptNo: number, b: AttemptBudget): number {
  const consumedBefore = b.manualRetries * b.maxAttempts + b.resumeCount + (b.ackRetries ?? 0);
  return Math.max(1, attemptNo - consumedBefore);
}

/** Extra attempts granted for lost acknowledgements (bounded; see FailureContext). */
export const ACK_RETRY_ALLOWANCE = 2;
const ACK_RETRY_DELAY_MS = 500;

export type FailureDecision =
  | { kind: 'retry'; delayMs: number; attemptStatus: AttemptRecord['status']; acknowledgement?: boolean }
  | { kind: 'fail'; attemptStatus: AttemptRecord['status'] }
  | { kind: 'cancelled' }
  | { kind: 'lease_lost' };

export interface FailureContext {
  /** The attributed error (a timeout is already a `NodeTimeoutError`, retryable by default). */
  error: unknown;
  timedOut: boolean;
  /** The run was cancelled (observed by the execution guard). */
  cancelled: boolean;
  /** Another worker owns the lease now. */
  leaseLost: boolean;
  /** The capability's default classification for unclassified errors. */
  capabilityRetryable: boolean;
  /** False for `no_retry` capabilities: nothing is ever retried automatically. */
  reexecutionAllowed?: boolean;
  /**
   * The capability succeeded but its outcome could not be recorded (AcknowledgementError).
   * Re-executable capabilities get up to ACK_RETRY_ALLOWANCE extra attempts for this, beyond
   * their own budget (a pure or idempotent capability with maxAttempts 1 must not fail a run
   * because a database write failed once) — still bounded.
   */
  acknowledgementFailure?: boolean;
  attemptNo: number;
  budget: AttemptBudget;
  policy: Pick<RetryPolicy, 'backoffMs' | 'maxBackoffMs'>;
}

export function decideOnFailure(f: FailureContext): FailureDecision {
  if (f.cancelled) return { kind: 'cancelled' };
  if (f.leaseLost || (f.error instanceof CancelledError && !f.timedOut)) return { kind: 'lease_lost' };
  const attemptStatus: AttemptRecord['status'] = f.timedOut ? 'timed_out' : 'failed';
  const reexecutable = f.reexecutionAllowed !== false;
  if (reexecutable && f.acknowledgementFailure && (f.budget.ackRetries ?? 0) < ACK_RETRY_ALLOWANCE) {
    // Granted on top of the normal budget (the store records it in `ackRetries`).
    return {
      kind: 'retry',
      delayMs: Math.min(f.policy.backoffMs, ACK_RETRY_DELAY_MS),
      attemptStatus,
      acknowledgement: true,
    };
  }
  const retryable = reexecutable && isRetryable(f.error, f.capabilityRetryable);
  if (retryable && f.attemptNo < allowedAttempts(f.budget)) {
    const n = attemptInCurrentLife(f.attemptNo, f.budget);
    return {
      kind: 'retry',
      delayMs: computeBackoffMs(n, f.policy.backoffMs, f.policy.maxBackoffMs),
      attemptStatus,
    };
  }
  return { kind: 'fail', attemptStatus };
}

/** Default per-item policy inside a fan-out body (short, in-process backoff). */
export const MAX_ITEM_RETRY_WAIT_MS = 30_000;

export function itemRetryPolicy(
  override: Partial<RetryPolicy> | undefined,
  capabilityRetryable: boolean,
): RetryPolicy {
  return {
    maxAttempts: override?.maxAttempts ?? (capabilityRetryable ? 3 : 1),
    backoffMs: override?.backoffMs ?? 1_000,
    maxBackoffMs: override?.maxBackoffMs ?? MAX_ITEM_RETRY_WAIT_MS,
  };
}
