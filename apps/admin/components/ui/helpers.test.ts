import { describe, expect, it } from 'vitest';
import { place } from './floating';
import { absoluteLabel, relativeLabel } from './time-format';

const now = new Date('2026-09-29T12:00:00Z');
const at = (iso: string) => new Date(iso);

describe('relativeLabel', () => {
  it.each([
    ['2026-09-29T11:59:30Z', 'just now'],
    ['2026-09-29T11:57:00Z', '3m ago'],
    ['2026-09-29T07:00:00Z', '5h ago'],
    ['2026-09-29T15:00:00Z', 'in 3h'],
    ['2026-09-29T12:10:00Z', 'in 10m'],
    ['2026-10-01T12:00:00Z', 'in 2d'],
    ['2026-09-26T09:00:00Z', 'Sat'],
    ['2026-09-12T14:03:00Z', '12 Sep'],
    ['2025-09-12T14:03:00Z', '12 Sep 2025'],
  ])('%s → %s', (iso, label) => {
    expect(relativeLabel(at(iso), now)).toBe(label);
  });
});

describe('absoluteLabel', () => {
  it('renders UTC with the zone spelled out', () => {
    expect(absoluteLabel(at('2026-09-12T14:03:00Z'))).toBe('12 Sep 2026, 14:03 UTC');
  });
});

describe('place (floating layers)', () => {
  const viewport = { width: 400, height: 300 };
  const size = { width: 100, height: 50 };
  const anchor = (top: number, left: number) => ({
    top,
    bottom: top + 20,
    left,
    right: left + 40,
    width: 40,
  });

  it('opens below and aligned to the start', () => {
    expect(place(anchor(10, 50), size, 'bottom-start', viewport)).toEqual({
      top: 36,
      left: 50,
      side: 'bottom',
    });
  });

  it('flips above when there is no room below', () => {
    expect(place(anchor(260, 50), size, 'bottom-start', viewport).side).toBe('top');
  });

  it('clamps into the viewport horizontally', () => {
    expect(place(anchor(10, 380), size, 'bottom-start', viewport).left).toBe(292);
    expect(place(anchor(10, 0), size, 'top', viewport).left).toBe(8);
    // Fits on neither side: clamped inside the viewport (the panel scrolls inside itself).
    const tall = { width: 100, height: 700 };
    const p = place(anchor(300, 50), tall, 'bottom-start', { width: 390, height: 800 });
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + tall.height).toBeLessThanOrEqual(800 - 8);
  });
});
