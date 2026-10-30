import { AppError } from '@aptamind/contracts';

/**
 * Error classification used by the runtime's retry policy.
 *
 * - `RetryableError`: transient (network blip, 5xx, throttling). Retried with backoff.
 * - `TerminalError`: will not succeed on retry (bad input, 4xx, invariant violation).
 * Unclassified errors fall back to the capability's `execution.retryable` flag.
 */
export class RetryableError extends Error {
  readonly retryable = true;
  constructor(
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}

export class TerminalError extends Error {
  readonly retryable = false;
  constructor(
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TerminalError';
  }
}

export class CapabilityValidationError extends AppError {
  readonly retryable = false;
  constructor(
    public readonly phase: 'config' | 'input' | 'output',
    public readonly capability: string,
    public readonly issues: string[],
  ) {
    super('validation_failed', `Invalid ${phase} for ${capability}: ${issues.join('; ')}`, {
      phase,
      capability,
      issues,
    });
    this.name = 'CapabilityValidationError';
  }
}

export class NodeTimeoutError extends Error {
  readonly retryable = true;
  constructor(timeoutMs: number) {
    super(`Node execution exceeded timeout of ${timeoutMs}ms`);
    this.name = 'NodeTimeoutError';
  }
}

export class CancelledError extends Error {
  readonly retryable = false;
  constructor(message = 'Execution cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

export function isRetryable(err: unknown, fallback: boolean): boolean {
  if (err && typeof err === 'object' && typeof (err as { retryable?: unknown }).retryable === 'boolean') {
    return (err as { retryable: boolean }).retryable;
  }
  return fallback;
}
