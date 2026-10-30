import { describe, expect, it } from 'vitest';
import { serverPattern } from './validators';

describe('serverPattern (Zod regex → MongoDB PCRE pattern)', () => {
  it('anchors a final $ at the true end (PCRE $ also matches before a trailing newline)', () => {
    expect(serverPattern('^[a-z]+$')).toBe('^[a-z]+(?!\\n)$');
    expect(new RegExp(serverPattern('^[a-z_]+$')).test('operator_created')).toBe(true);
  });

  it('leaves an escaped final $ and unanchored patterns alone', () => {
    expect(serverPattern('^a\\$')).toBe('^a\\$');
    expect(serverPattern('^a\\\\$')).toBe('^a\\\\(?!\\n)$');
    expect(serverPattern('^abc')).toBe('^abc');
  });
});
