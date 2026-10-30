import { describe, expect, it } from 'vitest';
import { ProfessionalError } from './errors';
import { cursorQuery, decodeCursor, encodeCursor, pageParamsSchema, toPage } from './pagination';

const doc = (i: number) => ({ _id: `psub_${i}`, createdAt: new Date(Date.UTC(2026, 8, 29, 0, 0, i)) });

describe('cursor pagination', () => {
  it('round-trips a cursor and builds the next-page filter per direction', () => {
    const c = encodeCursor(doc(3));
    expect(decodeCursor(c)).toEqual({ createdAt: doc(3).createdAt, id: 'psub_3' });
    const desc = cursorQuery({ limit: 2, sort: '-createdAt', cursor: c });
    expect(desc.sort).toEqual({ createdAt: -1, _id: -1 });
    expect(desc.after).toEqual({
      $or: [
        { createdAt: { $lt: doc(3).createdAt } },
        { createdAt: doc(3).createdAt, _id: { $lt: 'psub_3' } },
      ],
    });
    expect(cursorQuery({ limit: 2, sort: 'createdAt', cursor: c }).after).toMatchObject({
      $or: [{ createdAt: { $gt: doc(3).createdAt } }, expect.anything()],
    });
  });

  it('rejects forged or malformed cursors as validation_failed', () => {
    for (const bad of [
      'x',
      Buffer.from('{"t":"nope","id":"psub_1"}').toString('base64url'),
      Buffer.from('{"t":"2026-01-01T00:00:00Z","id":{"$ne":1}}').toString('base64url'),
    ]) {
      expect(() => decodeCursor(bad)).toThrow(ProfessionalError);
    }
  });

  it('limits pages to 100 and reports the next cursor only when more exist', () => {
    expect(pageParamsSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(pageParamsSchema.parse({})).toEqual({ limit: 25, sort: '-createdAt' });
    expect(pageParamsSchema.parse({ limit: '7' }).limit).toBe(7);
    expect(pageParamsSchema.parse({ limit: 7 }).limit).toBe(7);
    for (const limit of ['1e1', '0x10', ' 5', '5 ', '2.5', '-1', '0', '', '1000', 2.5])
      expect(pageParamsSchema.safeParse({ limit }).success, String(limit)).toBe(false);
    expect(pageParamsSchema.safeParse({ limit: '5', extra: '1' }).success).toBe(false);
    const three = [doc(3), doc(2), doc(1)];
    expect(toPage(three, 2)).toEqual({ items: [doc(3), doc(2)], nextCursor: encodeCursor(doc(2)), limit: 2 });
    expect(toPage(three, 3).nextCursor).toBeNull();
  });
});
