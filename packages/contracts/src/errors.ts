/**
 * Application error taxonomy shared by API, worker and domain modules.
 * `code` is stable and machine-readable; `message` is for humans.
 */
export type AppErrorCode =
  | 'not_found'
  | 'conflict'
  | 'validation_failed'
  | 'invalid_state'
  | 'unsafe_url'
  | 'limit_exceeded'
  | 'unavailable'
  | 'internal';

export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id: string) {
    super('not_found', `${entity} ${id} not found`, { entity, id });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('conflict', message, details);
    this.name = 'ConflictError';
  }
}

export class InvalidStateError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('invalid_state', message, details);
    this.name = 'InvalidStateError';
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
  stack?: string;
}

export function serializeError(err: unknown, includeStack = true): SerializedError {
  if (err instanceof Error) {
    const out: SerializedError = { name: err.name, message: err.message };
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') out.code = code;
    const retryable = (err as { retryable?: unknown }).retryable;
    if (typeof retryable === 'boolean') out.retryable = retryable;
    const details = (err as { details?: unknown }).details;
    if (details && typeof details === 'object') out.details = details as Record<string, unknown>;
    if (includeStack && err.stack) out.stack = err.stack.split('\n').slice(0, 12).join('\n');
    return out;
  }
  return { name: 'NonError', message: String(err) };
}
