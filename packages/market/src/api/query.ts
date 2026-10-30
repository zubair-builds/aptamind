import { z } from 'zod';

/**
 * Query-string schemas of the Market API. Every schema is strict: an unknown or misspelt
 * parameter is a 400 `validation_failed` (zod `unrecognized_keys`), never silently ignored,
 * and every enum filter is a `z.enum` (a misspelt value is a 400, not an empty page).
 */

// ------------------------------------------------------------------ shared parameters

export const limitParam = z.coerce.number().int().min(1).max(200).default(50);
export const offsetParam = z.coerce.number().int().min(0).max(100_000).default(0);
export const idParam = z.string().min(1).max(200);
/** Free-text search input (bounded). */
export const searchParam = z.string().trim().max(200);

/** `true` / `false`; absent is `undefined` (no filter). */
export const boolParam = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

/** ISO 3166-1 alpha-2 country code; case-insensitive on input, upper-case after parsing. */
export const countryParam = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Expected an ISO 3166-1 alpha-2 country code');

/** Path parameters `{ id }` of every Market record route. */
export const idParamsSchema = z.strictObject({ id: idParam });

/** Routes that take no query parameters (detail pages, actions). */
export const noQuerySchema = z.strictObject({});

// ------------------------------------------------------------------ list queries (M7.1; v2 lists in their modules)

export const REVIEW_STATUSES = ['open', 'resolved', 'dismissed'] as const;

/**
 * `status` defaults to `open`. `all` — and, for compatibility with v1 clients, an explicitly
 * empty `status=` — return every status.
 */
export const reviewStatusParam = z
  .enum([...REVIEW_STATUSES, 'all', ''])
  .default('open')
  .transform((s) => (s === 'all' || s === '' ? undefined : s));

export const AUDIT_ENTITY_KINDS = ['company', 'job', 'source', 'observation'] as const;

export const auditQuerySchema = z.strictObject({
  entityKind: z.enum(AUDIT_ENTITY_KINDS).optional(),
  entityId: idParam.optional(),
  limit: limitParam,
});

export const pageOnlyQuerySchema = z.strictObject({ limit: limitParam, offset: offsetParam });

export const snapshotUploadQuerySchema = z.strictObject({
  process: z.enum(['true', 'false']).default('true'),
});
