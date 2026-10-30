import { describe, expect, it } from 'vitest';
import { findTimezoneMentions, parseTimezoneConstraint, timezoneTokenOffset } from './timezones';

const window = (text: string) => {
  const tz = parseTimezoneConstraint(text);
  return tz ? [tz.minUtcOffset, tz.maxUtcOffset] : null;
};

describe('timezoneTokenOffset', () => {
  it.each([
    ['UTC', 0],
    ['GMT+2', 2],
    ['UTC-5', -5],
    ['UTC+5:30', 5.5],
    ['UTC −3', -3],
    ['CET', 1],
    ['CEST', 2],
    ['EST', -5],
    ['PT', -8],
    ['IST', 5.5],
    ['GST', 4],
    ['AEST', 10],
    ['Pacific Time', -8],
  ])('%s → %s', (token, offset) => {
    expect(timezoneTokenOffset(token)).toBe(offset);
  });

  it('rejects unknown tokens', () => {
    expect(timezoneTokenOffset('XYZ')).toBeNull();
    expect(timezoneTokenOffset('UTC+99')).toBeNull();
  });
});

describe('parseTimezoneConstraint', () => {
  it('parses explicit UTC ranges', () => {
    expect(window('Remote within UTC-5 to UTC+1')).toEqual([-5, 1]);
    expect(window('You must be within UTC−3 to UTC+3.')).toEqual([-3, 3]);
    expect(window('between GMT-1 and GMT+4')).toEqual([-1, 4]);
  });

  it('parses windows around an anchor zone', () => {
    expect(window('within 3 hours of CET')).toEqual([-2, 4]);
    expect(window('±2 hours of EST')).toEqual([-7, -3]);
    expect(window('+/- 2 hours of GMT')).toEqual([-2, 2]);
  });

  it('parses overlap requirements', () => {
    expect(window('must overlap 4 hours with CET')).toEqual([-3, 5]);
    expect(window('at least 5 hours of overlap with EST')).toEqual([-8, -2]);
    expect(window('overlap with CET business hours')).toEqual([-3, 5]);
  });

  it('parses zone lists and named groups', () => {
    expect(window('US time zones (PT–ET)')).toEqual([-8, -5]);
    expect(window('EST/PST')).toEqual([-8, -5]);
    expect(window('working in US time zones')).toEqual([-8, -5]);
  });

  it('parses a single zone only with a timezone context', () => {
    expect(window('GMT+2')).toEqual([2, 2]);
    expect(window('You will work CET hours')).toEqual([1, 1]);
    expect(window('We use UTC timestamps')).toBeNull();
  });

  it('returns null when there is no constraint', () => {
    expect(window('We are a fully remote company.')).toBeNull();
    expect(window('Great benefits and ET phone home jokes')).toBeNull();
  });

  it('reports the matched text', () => {
    expect(parseTimezoneConstraint('Remote within UTC-3 to UTC+3 only')?.text).toBe('UTC-3 to UTC+3');
  });
});

describe('findTimezoneMentions', () => {
  it('finds tokens with offsets', () => {
    expect(findTimezoneMentions('PST or EST').map((m) => m.offset)).toEqual([-8, -5]);
    expect(findTimezoneMentions('pst')).toEqual([]);
  });
});
