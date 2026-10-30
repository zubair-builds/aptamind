import { z } from 'zod';
import { ProfessionalError } from './errors';

/**
 * Cursor pagination for Professional lists (domain doc §12): `limit` ≤ 100 and an opaque
 * cursor over `(createdAt, _id)`, stable under concurrent inserts. The cursor carries a
 * timestamp and an opaque id only.
 */
export const MAX_PAGE_LIMIT = 100;

/**
 * `limit` from a query string is a plain decimal integer (no `1e1`, `0x10`, blanks or
 * fractions); numbers are accepted as-is for in-process callers.
 */
const limitSchema = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^[0-9]{1,3}$/, { message: 'limit must be an integer' })
      .transform(Number),
  ])
  .pipe(z.number().int().min(1).max(MAX_PAGE_LIMIT))
  .default(25);

/** Page parameters, spread into each list's strict query schema. */
export const pageParamsShape = {
  limit: limitSchema,
  cursor: z.string().max(200).optional(),
  sort: z.enum(['-createdAt', 'createdAt']).default('-createdAt'),
};

export const pageParamsSchema = z.strictObject(pageParamsShape);
export type PageParams = z.infer<typeof pageParamsSchema>;

export interface CursorPage<T> {
  items: T[];
  /** Pass as `cursor` to get the next page; `null` on the last page. */
  nextCursor: string | null;
  limit: number;
}

interface CursorValue {
  t: string;
  id: string;
}

export function encodeCursor(doc: { createdAt: Date; _id: string }): string {
  return Buffer.from(JSON.stringify({ t: doc.createdAt.toISOString(), id: doc._id })).toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorValue;
    const createdAt = new Date(v.t);
    if (typeof v.id !== 'string' || !/^[a-z]+_[A-Za-z0-9]+$/.test(v.id) || Number.isNaN(createdAt.getTime()))
      throw new Error('bad cursor');
    return { createdAt, id: v.id };
  } catch {
    throw new ProfessionalError('validation_failed', 'Invalid cursor');
  }
}

/** Mongo filter and sort for one page after `cursor` in the requested direction. */
export function cursorQuery(params: PageParams): {
  after: Record<string, unknown>;
  sort: Record<string, 1 | -1>;
} {
  const dir = params.sort === '-createdAt' ? -1 : 1;
  const sort = { createdAt: dir, _id: dir } as Record<string, 1 | -1>;
  if (!params.cursor) return { after: {}, sort };
  const c = decodeCursor(params.cursor);
  const op = dir === -1 ? '$lt' : '$gt';
  return {
    after: { $or: [{ createdAt: { [op]: c.createdAt } }, { createdAt: c.createdAt, _id: { [op]: c.id } }] },
    sort,
  };
}

/** Reads `limit + 1` documents to know whether a next page exists. */
export function toPage<T extends { createdAt: Date; _id: string }>(docs: T[], limit: number): CursorPage<T> {
  const items = docs.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: docs.length > limit && last ? encodeCursor(last) : null, limit };
}
