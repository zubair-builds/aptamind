import { describe, expect, it } from 'vitest';
import {
  lines,
  locationFieldText,
  MAX_QUOTE_LENGTH,
  sentences,
  spanOf,
  stripBullet,
  syntheticSpan,
} from './text';

describe('segmentation', () => {
  it('splits lines with offsets', () => {
    const text = '  first\n\nsecond  ';
    const out = lines(text);
    expect(out.map((l) => l.text)).toEqual(['first', 'second']);
    for (const l of out) expect(text.slice(l.start, l.end)).toBe(l.text);
  });

  it('splits sentences without breaking on abbreviations', () => {
    const text = 'Remote in the U.S. only. We use e.g. Go and Rust! Salary is £50k p.a. Apply now.';
    const out = sentences(text);
    expect(out.map((s) => s.text)).toEqual([
      'Remote in the U.S. only.',
      'We use e.g. Go and Rust!',
      'Salary is £50k p.a. Apply now.',
    ]);
    for (const s of out) expect(text.slice(s.start, s.end)).toBe(s.text);
  });

  it('strips bullets and keeps offsets', () => {
    const text = '- Python\n• Go\n1. Rust';
    const items = lines(text).map(stripBullet);
    expect(items.map((i) => [i.text, i.bullet])).toEqual([
      ['Python', true],
      ['Go', true],
      ['Rust', true],
    ]);
    for (const i of items) expect(text.slice(i.start, i.end)).toBe(i.text);
  });
});

describe('evidence spans', () => {
  it('trims and keeps quote equal to the sliced text', () => {
    const text = 'abc   hello world   xyz';
    const span = spanOf('description', text, 3, 20);
    expect(span.quote).toBe('hello world');
    expect(text.slice(span.start ?? 0, span.end)).toBe(span.quote);
  });

  it('caps quotes at the maximum length', () => {
    const text = 'x'.repeat(1000);
    const span = spanOf('description', text, 0, 1000);
    expect(span.quote).toHaveLength(MAX_QUOTE_LENGTH);
    expect(span.end).toBe(MAX_QUOTE_LENGTH);
  });

  it('builds synthetic spans without offsets', () => {
    expect(syntheticSpan('provider', 'workplaceType: remote')).toEqual({
      field: 'provider',
      quote: 'workplaceType: remote',
    });
    expect(locationFieldText(['London', 'Remote'])).toBe('London\nRemote');
  });
});
