import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { jobObservationPayloadSchema } from '../contracts/observations';
import { leverAdapter } from './lever';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../fixtures/ats/lever/${name}`, import.meta.url), 'utf8'));

const ctx = { boardToken: 'beta-co' };
const PAYMENTS_ID = '6f1c2a3b-4d5e-4f60-8a71-b2c3d4e5f601';

describe('leverAdapter', () => {
  it('builds provider API URLs', () => {
    expect(leverAdapter.listingUrl('beta-co')).toBe('https://api.lever.co/v0/postings/beta-co?mode=json');
    expect(leverAdapter.jobUrl('beta-co', PAYMENTS_ID)).toBe(
      `https://api.lever.co/v0/postings/beta-co/${PAYMENTS_ID}`,
    );
  });

  it('maps postings and skips the malformed one', () => {
    const listing = leverAdapter.parseListing(fixture('beta-co-postings.json'), ctx);
    expect(listing.complete).toBe(false); // 1 of 5 malformed (> 10 %)
    expect(listing.jobs).toHaveLength(4);
    expect(listing.jobs.map((j) => j.locator)).toEqual(['/0', '/1', '/2', '/3']);
    expect(listing.skipped).toEqual([
      expect.objectContaining({
        externalId: `${PAYMENTS_ID.slice(0, -3)}699`,
        kind: 'malformed',
        locator: '/4',
      }),
    ]);
    expect(listing.warnings).toHaveLength(2);
    expect(listing.warnings[0]).toMatch(/^\/4: skipped malformed posting \(id 6f1c2a3b-.*f699\): text/);
    for (const job of listing.jobs)
      expect(() => jobObservationPayloadSchema.parse(job.payload)).not.toThrow();
  });

  it('combines description, lists and closing text; maps compensation and workplace', () => {
    const [payments] = leverAdapter.parseListing(fixture('beta-co-postings.json'), ctx).jobs;
    const p = payments!.payload;
    expect(p).toMatchObject({
      externalId: PAYMENTS_ID,
      title: 'Senior Software Engineer, Payments',
      locations: [{ text: 'Remote', kind: 'job', country: 'US' }],
      workplaceType: 'remote',
      employmentTypeText: 'Full-time',
      department: 'Engineering',
      team: 'Payments',
      postingUrl: `https://jobs.lever.co/beta-co/${PAYMENTS_ID}`,
      applyUrl: `https://jobs.lever.co/beta-co/${PAYMENTS_ID}/apply`,
      publishedAt: new Date(1756130400000).toISOString(),
      compensation: {
        min: 165000,
        max: 205000,
        currency: 'USD',
        period: 'year',
        text: 'The US base salary range for this full-time position is $165,000 - $205,000 + equity + benefits.',
      },
      provider: { name: 'lever', boardToken: 'beta-co' },
    });
    expect(p.descriptionHtml).toContain("<h3>What you'll do</h3><ul><li>Build our ACH");
    expect(p.descriptionHtml).toContain('equal opportunity workplace');
    expect(p.descriptionText).toContain('you must reside in the United States');
    expect(p.descriptionText).toContain('- Experience with PCI-DSS environments');
  });

  it('keeps one location per location string and normalises on-site / hourly pay', () => {
    const jobs = leverAdapter.parseListing(fixture('beta-co-postings.json'), ctx).jobs.map((j) => j.payload);
    const sre = jobs.find((j) => j.title.startsWith('Site Reliability'))!;
    expect(sre.locations).toEqual([
      { text: 'Remote - EMEA', kind: 'job' },
      { text: 'Amsterdam, Netherlands', kind: 'job' },
    ]);
    expect(sre.compensation).toBeNull();
    const pm = jobs.find((j) => j.title.startsWith('Product Manager'))!;
    expect(pm.workplaceType).toBe('hybrid');
    expect(pm.descriptionText).toContain('we are unable to sponsor visas for this role');
    expect(pm.compensation).toMatchObject({ currency: 'GBP', period: 'year', text: null });
    const support = jobs.find((j) => j.title.startsWith('Support'))!;
    expect(support.workplaceType).toBe('onsite');
    expect(support.compensation).toMatchObject({ min: 28, max: 34, currency: 'CAD', period: 'hour' });
  });

  it('throws when the response is not an array', () => {
    expect(() => leverAdapter.parseListing(fixture('posting-not-found.json'), ctx)).toThrow(
      /not a JSON array/,
    );
  });

  it('interprets single-posting checks', () => {
    const check = { boardToken: 'beta-co', externalId: PAYMENTS_ID };
    const live = leverAdapter.parseJobCheck(200, fixture(`beta-co-posting-${PAYMENTS_ID}.json`), check);
    expect(live.outcome).toBe('live');
    expect(live.payload?.externalId).toBe(PAYMENTS_ID);
    expect(leverAdapter.parseJobCheck(404, fixture('posting-not-found.json'), check).outcome).toBe(
      'not_found',
    );
    expect(leverAdapter.parseJobCheck(429, null, check).outcome).toBe('unknown');
    expect(leverAdapter.parseJobCheck(200, 'garbage', check).outcome).toBe('unknown');
  });

  describe('PR #11 A-H1 audit: only a 404/410 from the job endpoint is not_found', () => {
    const check = (status: number, raw: unknown) =>
      leverAdapter.parseJobCheck(status, raw, { boardToken: 'acme', externalId: 'p7' }).outcome;
    it.each([
      [200, null],
      [200, 'not json'],
      [200, {}],
      [200, { id: 'other', title: 'x', text: 'x' }],
      [301, null],
      [403, null],
      [429, null],
      [500, null],
      [503, null],
    ])('HTTP %s with %j → unknown', (status, raw) => {
      expect(check(status, raw)).toBe('unknown');
    });
    it('404 and 410 → not_found; the job itself → live', () => {
      expect(check(404, null)).toBe('not_found');
      expect(check(410, null)).toBe('not_found');
      expect(check(200, { id: 'p7', text: 'Engineer' })).toBe('live');
    });
  });
});
