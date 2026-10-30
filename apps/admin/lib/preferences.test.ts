import { describe, expect, it } from 'vitest';
import { parseTheme } from './preferences';

describe('parseTheme', () => {
  it('accepts light/dark and defaults to system', () => {
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme(undefined)).toBe('system');
    expect(parseTheme('neon')).toBe('system');
  });
});
