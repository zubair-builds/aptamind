import { describe, expect, it } from 'vitest';
import {
  enumLabel,
  fmtBytes,
  fmtDateTime,
  fmtDuration,
  fmtMoneyCompact,
  fmtRelative,
  humanize,
} from './format';

describe('format helpers', () => {
  it('renders missing values as an em dash', () => {
    expect(fmtDateTime(null)).toBe('—');
    expect(fmtDuration(undefined)).toBe('—');
    expect(fmtRelative(null)).toBe('—');
    expect(humanize('')).toBe('—');
  });

  it('formats UTC timestamps without milliseconds', () => {
    expect(fmtDateTime('2026-09-12T14:03:07.123Z')).toBe('2026-09-12 14:03:07Z');
  });

  it('formats durations across units', () => {
    expect(fmtDuration(250)).toBe('250ms');
    expect(fmtDuration(4_500)).toBe('4.5s');
    expect(fmtDuration(125_000)).toBe('2m 5s');
    expect(fmtDuration(3 * 3_600_000)).toBe('3h 0m');
  });

  it('formats relative time in the past and future', () => {
    const now = Date.parse('2026-09-29T12:00:00Z');
    expect(fmtRelative('2026-09-29T11:55:00Z', now)).toBe('5m ago');
    expect(fmtRelative('2026-09-29T14:00:00Z', now)).toBe('in 2h');
  });

  it('humanises enum values and byte sizes', () => {
    expect(humanize('VERIFIED_LIVE')).toBe('VERIFIED LIVE');
    expect(fmtBytes(2048)).toBe('2.0 KB');
  });
});

describe('enumLabel', () => {
  it('turns enum values into sentence case', () => {
    expect(enumLabel('VERIFIED_LIVE')).toBe('Verified live');
    expect(enumLabel('company_capable')).toBe('Company capable');
    expect(enumLabel(null)).toBe('—');
  });
});

describe('fmtMoneyCompact', () => {
  it('compacts table amounts', () => {
    expect(fmtMoneyCompact(70000, 'GBP')).toBe('£70k');
    expect(fmtMoneyCompact(72500, 'GBP')).toBe('£72.5k');
    expect(fmtMoneyCompact(1_200_000, 'USD')).toBe('US$1.2m');
    expect(fmtMoneyCompact(null, 'GBP')).toBe('—');
  });
});
