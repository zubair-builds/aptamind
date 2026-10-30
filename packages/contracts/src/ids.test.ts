import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash, deterministicId, newId, ulid } from './ids';

describe('ids', () => {
  it('generates prefixed, ordered ids', () => {
    const a = newId('cmp');
    const b = newId('cmp');
    expect(a).toMatch(/^cmp_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
  });

  it('ulid is monotonic within the same millisecond', () => {
    const t = Date.now();
    const ids = Array.from({ length: 50 }, () => ulid(t));
    expect([...ids].sort()).toEqual(ids);
  });

  it('deterministic ids are stable and part-sensitive', () => {
    expect(deterministicId('obs', 'a', 'b')).toBe(deterministicId('obs', 'a', 'b'));
    expect(deterministicId('obs', 'ab', '')).not.toBe(deterministicId('obs', 'a', 'b'));
    expect(deterministicId('obs', undefined)).not.toBe(deterministicId('obs', ''));
  });

  it('canonical json ignores key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe(
      '{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}',
    );
    expect(contentHash({ a: 1, b: undefined })).toBe(contentHash({ a: 1 }));
  });
});
