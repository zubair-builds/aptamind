import { InvalidStateError } from '@aptamind/contracts';

/**
 * Errors raised by the runtime itself (as opposed to errors thrown by capabilities, which
 * are classified with the SDK's `RetryableError` / `TerminalError`).
 */

/** The workflow version no longer contains the node, or the capability is not registered here. */
export class DefinitionError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'DefinitionError';
  }
}

/** A node was claimed more times than its attempt budget allows (e.g. repeated lost leases). */
export class AttemptsExhaustedError extends Error {
  readonly retryable = false;
  constructor(allowed: number) {
    super(`Node exceeded ${allowed} attempts (lost leases)`);
    this.name = 'AttemptsExhausted';
  }
}

/** Another worker took over the node/chunk; this worker's result must be discarded. */
export class LeaseLostError extends Error {
  readonly retryable = false;
  constructor(message = 'Lease lost to another worker') {
    super(message);
    this.name = 'LeaseLostError';
  }
}

export class SubworkflowDepthError extends InvalidStateError {
  constructor(maxDepth: number) {
    super(`Subworkflow depth limit (${maxDepth}) exceeded`, { maxDepth });
    this.name = 'SubworkflowDepthError';
  }
}

/**
 * The capability finished, but persisting its outcome (output artifact or the completion
 * write) failed — the "acknowledgement" was lost. Retryable regardless of the capability's
 * default: execution is at-least-once and side effects must be idempotent under the node's
 * idempotency key, so re-executing is how the outcome becomes durable.
 */
export class AcknowledgementError extends Error {
  readonly retryable = true;
  constructor(cause: unknown) {
    super(`Failed to persist node outcome: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = 'AcknowledgementError';
  }
}

/**
 * A `no_retry` capability's previous attempt was interrupted (lease lost). Its outcome is
 * unknown and re-executing it is not safe, so the node fails for an operator to inspect.
 */
export class UnsafeReexecutionError extends Error {
  readonly retryable = false;
  constructor(capability: string) {
    super(
      `${capability} is not safe to re-execute and its previous attempt was interrupted; inspect before retrying`,
    );
    this.name = 'UnsafeReexecution';
  }
}
