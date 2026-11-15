import { describe, expect, it } from 'vitest';
import { parseTheme } from './preferences';

describe('parseTheme', () => {
  it('accepts light/dark/system and defaults to light', () => {
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme(undefined)).toBe('light');
    expect(parseTheme('neon')).toBe('light');
  });
});
