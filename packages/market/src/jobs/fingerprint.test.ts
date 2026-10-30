import { describe, expect, it } from 'vitest';
import { jaccard, locationKey, normalizeTitleKey, shingles, urlFingerprint } from './fingerprint';

describe('job fingerprints', () => {
  it('normalises posting URLs', () => {
    expect(
      urlFingerprint('https://www.Boards.greenhouse.io/acme/jobs/123/?gh_src=abc&utm_source=li#apply'),
    ).toBe('boards.greenhouse.io/acme/jobs/123');
    expect(urlFingerprint('https://jobs.lever.co/acme/abc?lever-source=Indeed')).toBe(
      'jobs.lever.co/acme/abc',
    );
    expect(urlFingerprint('not a url')).toBeNull();
  });

  it('normalises titles and locations', () => {
    expect(normalizeTitleKey('Senior Backend Engineer (Remote, m/f/d)')).toBe('senior backend engineer');
    expect(locationKey(['London, UK', 'london uk', 'Berlin'])).toBe('berlin|london uk');
  });

  it('measures description similarity', () => {
    const base =
      'We are looking for a senior backend engineer to build our payments platform using Go and Postgres. You will own services end to end and work with product.';
    expect(jaccard(shingles(base), shingles(base))).toBe(1);
    expect(jaccard(shingles(base), shingles(`${base} Apply now!`))).toBeGreaterThan(0.8);
    expect(
      jaccard(
        shingles(base),
        shingles(
          'Marketing manager to run campaigns across EMEA with a strong brand focus and budget ownership.',
        ),
      ),
    ).toBe(0);
  });
});
