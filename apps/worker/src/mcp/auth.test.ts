import { describe, expect, it } from 'vitest';
import { checkBearer } from './auth';

const TOKEN = 'mcp-token-value-0123456789abcdef';

describe('checkBearer', () => {
  it('accepts the matching bearer token', () => {
    expect(checkBearer(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('rejects a wrong token, a missing header, a length mismatch and a non-bearer scheme', () => {
    expect(checkBearer(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(checkBearer(undefined, TOKEN)).toBe(false);
    expect(checkBearer('', TOKEN)).toBe(false);
    expect(checkBearer('Bearer short', TOKEN)).toBe(false);
    expect(checkBearer(`Bearer ${'a'.repeat(8)}`, 'b'.repeat(64))).toBe(false);
    expect(checkBearer(`Token ${TOKEN}`, TOKEN)).toBe(false);
    expect(checkBearer(TOKEN, TOKEN)).toBe(false);
    expect(checkBearer(`bearer ${TOKEN}`, TOKEN)).toBe(false);
  });

  it('does not throw when the presented secret length differs', () => {
    expect(() => checkBearer('Bearer x', TOKEN)).not.toThrow();
    expect(() => checkBearer(`Bearer ${'z'.repeat(500)}`, 'y')).not.toThrow();
  });
});
