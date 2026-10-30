import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { jobObservationPayloadSchema } from '../contracts/observations';
import { parseAggregatorFeed } from './aggregator';
import { greenhouseAdapter } from './greenhouse';

const fixture = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../fixtures/ats/${path}`, import.meta.url), 'utf8'));

describe('parseAggregatorFeed', () => {
  it('maps feed jobs as incomplete secondary evidence', () => {
    const listing = parseAggregatorFeed(fixture('aggregator/jobs-feed.json'));
    expect(listing.complete).toBe(false);
    expect(listing.jobs.map((j) => j.payload.externalId)).toEqual(['jh-881201', 'jh-881202', 'jh-881377']);
    expect(listing.warnings).toHaveLength(1);
    expect(listing.warnings[0]).toMatch(/^\/jobs\/3: skipped malformed job \(id jh-881399\)/);
    for (const job of listing.jobs) {
      expect(() => jobObservationPayloadSchema.parse(job.payload)).not.toThrow();
      expect(job.payload.provider).toEqual({ name: 'aggregator', boardToken: null });
    }
    const [first, second] = listing.jobs;
    expect(first!.payload).toMatchObject({
      companyName: 'Acme',
      workplaceType: 'remote',
      postingUrl: 'https://jobhub.example.com/jobs/jh-881201-senior-backend-engineer-acme',
      applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/4012345001',
      publishedAt: '2026-09-02T00:00:00.000Z',
      compensation: { min: 90000, max: 110000, currency: 'USD', period: 'year', text: '$90k - $110k' },
    });
    expect(second!.payload.descriptionHtml).toBe(
      '<p>Run Kubernetes infrastructure across AWS EU regions.</p>',
    );
    expect(second!.payload.locations).toEqual([{ text: 'Remote - EMEA', kind: 'job' }]);
  });

  it('references official postings but conflicts with them on location and salary', () => {
    const feed = parseAggregatorFeed(fixture('aggregator/jobs-feed.json')).jobs[0]!.payload;
    const official = greenhouseAdapter
      .parseListing(fixture('greenhouse/acme-listing-t1.json'), { boardToken: 'acme' })
      .jobs.find((j) => j.payload.postingUrl === feed.applyUrl)!.payload;
    expect(official.externalId).toBe('4012345001');
    expect(feed.locations[0]?.text).not.toBe(official.locations[0]?.text);
    expect(feed.compensation?.max).toBeLessThan(official.compensation?.min ?? 0);
  });

  it('throws on an unexpected top-level shape', () => {
    expect(() => parseAggregatorFeed([])).toThrow(/Aggregator feed/);
  });
});
