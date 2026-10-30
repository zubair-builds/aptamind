import { describe, expect, it } from 'vitest';
import { cleanFileName } from './import.service';

describe('cleanFileName', () => {
  it('strips control and format characters (a right-to-left override cannot disguise a name)', () => {
    expect(cleanFileName('boards‮fdp.csv')).toBe('boardsfdp.csv');
    expect(cleanFileName('a\u0000b​c.csv')).toBe('abc.csv');
  });

  it('strips lone surrogates and line/paragraph separators', () => {
    expect(cleanFileName('a\uD800b\uDC00c.csv')).toBe('abc.csv');
    expect(cleanFileName('a\u2028b\u2029c.csv')).toBe('abc.csv');
    // A valid surrogate pair is one character and stays.
    expect(cleanFileName('😀.csv')).toBe('😀.csv');
  });

  it('truncates by code point, never splitting a character', () => {
    const name = cleanFileName('😀'.repeat(200));
    expect([...name].every((ch) => ch === '😀')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(255);
  });

  it('falls back to "upload" for an empty name', () => {
    expect(cleanFileName('  ‮ ')).toBe('upload');
    expect(cleanFileName(undefined)).toBe('upload');
  });
});
