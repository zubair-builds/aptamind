import type { Logger } from '@aptamind/observability';

/**
 * Professional logging (R-32, PL-10). Professional code logs ids, enums, counts and error codes
 * only. As defence in depth the Professional child logger redacts value-bearing keys, including
 * MongoDB error internals that echo document values ([A-NIT-5]): `errInfo` (server validation
 * details), `keyValue` (duplicate-key values, e.g. a source URL), `errmsg` / `errorResponse`.
 */
export const PROFESSIONAL_REDACT_PATHS = [
  'text',
  '*.text',
  'quote',
  '*.quote',
  'value',
  '*.value',
  'payload',
  '*.payload',
  'email',
  '*.email',
  'phone',
  '*.phone',
  'name',
  '*.name',
  'url',
  '*.url',
  'reference',
  '*.reference',
  'errInfo',
  '*.errInfo',
  'keyValue',
  '*.keyValue',
  'errmsg',
  '*.errmsg',
  'errorResponse',
  '*.errorResponse',
  'err.message',
  'err.stack',
] as const;

export function professionalLogger(base: Logger): Logger {
  return base.child(
    { domain: 'professional' },
    { redact: { paths: [...PROFESSIONAL_REDACT_PATHS], censor: '[redacted]' } },
  );
}

export interface SafeError {
  type: string;
  code?: string | number;
  codeName?: string;
}

/**
 * The only shape in which Professional code logs an error: its class name and codes. Never the
 * message (MongoDB messages quote duplicate keys and validation failures quote documents), never
 * `errInfo`, `keyValue` or the stack.
 */
export function safeError(err: unknown): SafeError {
  if (!err || typeof err !== 'object') return { type: typeof err };
  const e = err as { name?: unknown; code?: unknown; codeName?: unknown; constructor?: { name?: string } };
  const out: SafeError = { type: typeof e.name === 'string' ? e.name : (e.constructor?.name ?? 'Error') };
  if (typeof e.code === 'string' || typeof e.code === 'number') out.code = e.code;
  if (typeof e.codeName === 'string') out.codeName = e.codeName;
  return out;
}
