import { describe, expect, it } from 'vitest';
import { isRemoteLabel, normalizeLocation, normalizeLocations, splitLocationText } from './locations';

const loc = (text: string) => {
  const { city, region, country, isRemoteLabel: remote } = normalizeLocation(text);
  return { city, region, country, remote };
};

describe('normalizeLocation', () => {
  it.each([
    ['Remote', { city: null, region: null, country: null, remote: true }],
    ['Remote - US', { city: null, region: null, country: 'US', remote: true }],
    ['Remote (Europe)', { city: null, region: null, country: null, remote: true }],
    ['Anywhere', { city: null, region: null, country: null, remote: true }],
    ['London, UK', { city: 'London', region: null, country: 'GB', remote: false }],
    ['Hybrid - Berlin', { city: 'Berlin', region: null, country: 'DE', remote: false }],
    ['San Francisco, CA', { city: 'San Francisco', region: 'California', country: 'US', remote: false }],
    ['New York, NY, United States', { city: 'New York', region: 'New York', country: 'US', remote: false }],
    ['Toronto, ON, Canada', { city: 'Toronto', region: 'Ontario', country: 'CA', remote: false }],
    ['Toronto, CA', { city: 'Toronto', region: 'Ontario', country: 'CA', remote: false }],
    ['Lyon, FR', { city: 'Lyon', region: null, country: 'FR', remote: false }],
    ['Tel Aviv, IL', { city: 'Tel Aviv', region: null, country: 'IL', remote: false }],
    ['Springfield, IL', { city: 'Springfield', region: 'Illinois', country: 'US', remote: false }],
    ['Bengaluru, India', { city: 'Bangalore', region: null, country: 'IN', remote: false }],
    ['Dubai, UAE', { city: 'Dubai', region: null, country: 'AE', remote: false }],
    ['Remote-UK', { city: null, region: null, country: 'GB', remote: true }],
    ['Germany', { city: null, region: null, country: 'DE', remote: false }],
    ['Madrid, Spain (On-site)', { city: 'Madrid', region: null, country: 'ES', remote: false }],
  ])('%s', (text, expected) => {
    expect(loc(text)).toEqual(expected);
  });

  it('keeps the original text', () => {
    expect(normalizeLocation('London, UK').text).toBe('London, UK');
  });
});

describe('multi-location strings', () => {
  it('splits on separators', () => {
    expect(splitLocationText('London; Berlin | Paris')).toEqual(['London', 'Berlin', 'Paris']);
    expect(splitLocationText('New York or Remote')).toEqual(['New York', 'Remote']);
    expect(normalizeLocations(['London, UK; Dublin, Ireland']).map((l) => l.country)).toEqual(['GB', 'IE']);
  });

  it('detects remote labels', () => {
    expect(isRemoteLabel('Work from home')).toBe(true);
    expect(isRemoteLabel('Remote, EMEA')).toBe(true);
    expect(isRemoteLabel('Remington, VA')).toBe(false);
  });
});
