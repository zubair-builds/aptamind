import { z } from 'zod';
import { CURRENCY_CODES, isCountryCode, REGION_CODES } from '@aptamind/taxonomy';

/**
 * Value types shared by claim value schemas (domain doc §3.2). Values are strict objects: an
 * assertion's identity is a hash of its normalized value, so unknown keys are never accepted.
 */

const text = (max: number) => z.string().trim().min(1).max(max);

/** A calendar date with explicit precision: `{ year }` or `{ year, month }`. */
export const partialDateSchema = z.strictObject({
  year: z.number().int().min(1900).max(2100),
  month: z.number().int().min(1).max(12).optional(),
});
export type PartialDate = z.infer<typeof partialDateSchema>;

/**
 * A point in time: a valid `Date`, or an ISO-8601 date-time string with an explicit offset
 * (normalized to a `Date`). Nothing else is coerced — `null`, booleans, numbers and bare dates
 * are rejected (a coercing schema would turn `0` or `true` into 1970).
 */
export const dateTimeSchema = z.union([
  z.date(),
  z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
]);

/**
 * "Present" as written in a source: still true **when the source was written** (`asOf` =
 * the snapshot's `sourceAsOf`), never "still true today".
 */
export const presentSchema = z.strictObject({
  open: z.literal(true),
  asOf: dateTimeSchema,
});
export type Present = z.infer<typeof presentSchema>;

export const dateOrPresentSchema = z.union([partialDateSchema, presentSchema]);
export type DateOrPresent = z.infer<typeof dateOrPresentSchema>;

export function isPresent(v: DateOrPresent): v is Present {
  return 'open' in v;
}

/** ISO 3166-1 alpha-2 country code from `@aptamind/taxonomy`. */
export const countryCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, { message: 'country code must be upper-case alpha-2' })
  .refine(isCountryCode, { message: 'unknown country code' });

/** A country code or a taxonomy region code (e.g. `EU`, `EEA`). */
export const jurisdictionSchema = z
  .string()
  .regex(/^[A-Z_]{2,}$/, { message: 'jurisdiction must be an upper-case code' })
  .refine((c) => isCountryCode(c) || REGION_CODES.includes(c), { message: 'unknown jurisdiction' });

export const currencyCodeSchema = z
  .string()
  .refine((c) => CURRENCY_CODES.includes(c), { message: 'unknown currency code' });

/**
 * A normalized key (lower-case, deterministic) computed by domain code from a raw label. The
 * raw label is always kept beside it.
 */
export const normalizedKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\p{Ll}\p{Lo}\p{N}_:.-]+$/u, { message: 'not a normalized key' });

/** An absolute `http:` or `https:` URL (no `javascript:`, `data:`, `file:` … schemes). */
export const urlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(
    (u) => {
      try {
        const { protocol } = new URL(u);
        return protocol === 'http:' || protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'not an http(s) URL' },
  );

export const organizationSchema = z.strictObject({
  name: text(200),
  key: normalizedKeySchema,
  url: urlSchema.optional(),
});
export type Organization = z.infer<typeof organizationSchema>;

/** Where something happened (a role's workplace); every part optional. */
export const placeSchema = z.strictObject({
  city: text(120).optional(),
  region: text(120).optional(),
  country: countryCodeSchema.optional(),
});
export type Place = z.infer<typeof placeSchema>;

/** Work models a professional can accept (the taxonomy's `unclear` is not a preference). */
export const PREFERRED_WORK_MODELS = ['remote', 'hybrid', 'onsite'] as const;
export type PreferredWorkModel = (typeof PREFERRED_WORK_MODELS)[number];

export const timezoneWindowSchema = z
  .strictObject({
    minUtcOffset: z.number().min(-12).max(14),
    maxUtcOffset: z.number().min(-12).max(14),
  })
  .refine((w) => w.minUtcOffset <= w.maxUtcOffset, { message: 'minUtcOffset > maxUtcOffset' });

export const COMPENSATION_PERIODS = ['year', 'month', 'day', 'hour'] as const;
export const COMPENSATION_BASES = ['base_salary', 'total_compensation', 'day_rate', 'hourly_rate'] as const;

/** Fields of a compensation expectation (shared by the claim value and target specs). */
export const compensationFields = {
  currency: currencyCodeSchema,
  min: z.number().nonnegative().optional(),
  target: z.number().nonnegative().optional(),
  period: z.enum(COMPENSATION_PERIODS),
  basis: z.enum(COMPENSATION_BASES),
};

/** At least one amount, and `min <= target` when both are given. */
export function withCompensationRules<T extends z.ZodType<{ min?: number; target?: number }>>(schema: T): T {
  return schema
    .refine((c) => c.min !== undefined || c.target !== undefined, { message: 'min or target required' })
    .refine((c) => c.min === undefined || c.target === undefined || c.min <= c.target, {
      message: 'min > target',
    }) as unknown as T;
}

/** A compensation expectation; never inferred (only stated or confirmed). */
export const compensationSchema = withCompensationRules(z.strictObject(compensationFields));
export type Compensation = z.infer<typeof compensationSchema>;
