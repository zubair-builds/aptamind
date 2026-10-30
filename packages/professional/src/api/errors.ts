import { ZodError } from 'zod';

/**
 * Professional API errors (domain doc §12). Messages are fixed texts with ids at most — never
 * values from requests or documents — because the runtime and the API persist and log them.
 */
export const PROFESSIONAL_ERROR_STATUS = {
  bad_request: 400,
  validation_failed: 400,
  illegal_transition: 400,
  consent_required: 400,
  linkedin_import_only: 400,
  sensitive_not_included: 400,
  not_found: 404,
  conflict: 409,
  idempotency_key_reused: 409,
  subject_archived: 409,
  extraction_failed_final: 409,
  stale_subject_revision: 409,
  stale_target_revision: 409,
  target_order_mismatch: 409,
  target_limit_reached: 409,
  upload_too_large: 413,
  unsupported_media_type: 415,
  internal: 500,
} as const;
export type ProfessionalErrorCode = keyof typeof PROFESSIONAL_ERROR_STATUS;

export class ProfessionalError extends Error {
  constructor(
    readonly code: ProfessionalErrorCode,
    message: string,
    readonly details?: Record<string, string | number | boolean>,
  ) {
    super(message);
    this.name = 'ProfessionalError';
  }
}

export const notFound = (
  entity: 'subject' | 'source' | 'snapshot' | 'observation' | 'career_target' | 'career_target_version',
  id: string,
) => new ProfessionalError('not_found', `${entity} not found`, { entity, id });

export interface HttpError {
  status: number;
  body: {
    error: {
      code: string;
      message: string;
      details?: Record<string, unknown>;
      issues?: Array<{ path: Array<string | number>; code: string; message: string }>;
      requestId?: string;
    };
  };
  /** Set when the failure is unexpected and must be logged (as `safeError` only). */
  unexpected: boolean;
}

/**
 * Maps any error thrown by a Professional route to a response. Request bodies are never echoed:
 * Zod issues are reduced to path, code and message (Zod messages name expected types/options,
 * never the input), and parser errors (malformed JSON quotes the body) get a fixed message.
 */
export function toHttpError(err: unknown, requestId?: string): HttpError {
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: 'validation_failed',
          message: 'Invalid request',
          issues: err.issues.slice(0, 20).map((i) => ({
            path: i.path.map((p) => (typeof p === 'symbol' ? String(p.description) : p)),
            code: i.code,
            // Zod names the offending keys in this message; keys are request input, so fixed text.
            message: i.code === 'unrecognized_keys' ? 'Unrecognized key' : i.message,
          })),
        },
      },
      unexpected: false,
    };
  }
  if (err instanceof ProfessionalError) {
    return {
      status: PROFESSIONAL_ERROR_STATUS[err.code],
      body: {
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      },
      unexpected: err.code === 'internal',
    };
  }
  const e = err as { code?: unknown; statusCode?: unknown };
  if (e && e.code === 'validation_failed') {
    // A document failed its collection schema (SchemaValidationError): report, never quote.
    return {
      status: 400,
      body: { error: { code: 'validation_failed', message: 'Invalid document' } },
      unexpected: false,
    };
  }
  if (e && typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
    return {
      status: e.statusCode,
      body: { error: { code: 'bad_request', message: 'Malformed request' } },
      unexpected: false,
    };
  }
  return {
    status: 500,
    body: { error: { code: 'internal', message: 'Internal error', ...(requestId ? { requestId } : {}) } },
    unexpected: true,
  };
}

/**
 * The upload route's transport rejections, raised by Fastify before any handler code runs: a
 * body above the streaming limit (413) or no usable body parser (415). Mapped only in the upload
 * route's context, so other routes keep the generic `bad_request`.
 */
export function uploadTransportError(err: unknown): HttpError | undefined {
  if (err instanceof ProfessionalError || err instanceof ZodError) return undefined;
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  if (status === 413)
    return {
      status: 413,
      body: {
        error: { code: 'upload_too_large', message: 'Upload exceeds a limit', details: { limit: 'bytes' } },
      },
      unexpected: false,
    };
  if (status === 415)
    return {
      status: 415,
      body: {
        error: {
          code: 'unsupported_media_type',
          message: 'Unsupported media type',
          details: { reason: 'media_type' },
        },
      },
      unexpected: false,
    };
  return undefined;
}
