import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { jobObservationPayloadSchema } from '../contracts/observations';
import { extractJsonLdJobPostings } from './jsonld';

const html = (name: string) =>
  readFileSync(new URL(`../../fixtures/careers/${name}`, import.meta.url), 'utf8');

const DETAIL_URL = 'https://www.deltalogistics.co.uk/careers/senior-data-engineer-remote-uk';

describe('extractJsonLdJobPostings', () => {
  it('maps a JobPosting inside an @graph', () => {
    const postings = extractJsonLdJobPostings(html('delta-job-detail.html'), DETAIL_URL);
    expect(postings).toHaveLength(1);
    const [p] = postings;
    expect(() => jobObservationPayloadSchema.parse(p)).not.toThrow();
    expect(p).toMatchObject({
      externalId: 'DL-2026-044',
      title: 'Senior Data Engineer',
      companyName: 'Delta Logistics',
      postingUrl: DETAIL_URL,
      publishedAt: '2026-09-14T00:00:00.000Z',
      employmentTypeText: 'FULL_TIME, PERMANENT',
      workplaceType: 'remote',
      locations: [
        { text: 'GB', country: 'GB', kind: 'job' },
        { text: 'Ireland', country: null, kind: 'job' },
      ],
      compensation: { min: 70000, max: 85000, currency: 'GBP', period: 'year' },
      provider: { name: 'careers_page', boardToken: null },
    });
    expect(p!.descriptionHtml).toContain('<li>Python, dbt, BigQuery</li>');
    expect(p!.descriptionText).toContain('We are unable to offer visa sponsorship.');
  });

  it('maps a standalone posting with jobLocation and hashes a missing identifier stably', () => {
    const page = `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org/',
      '@type': 'JobPosting',
      title: 'Warehouse Supervisor',
      hiringOrganization: 'Delta Logistics',
      employmentType: 'FULL_TIME',
      datePosted: '2026-09-01T09:00:00+01:00',
      jobLocation: {
        '@type': 'Place',
        address: {
          '@type': 'PostalAddress',
          addressLocality: 'Leeds',
          addressRegion: 'West Yorkshire',
          addressCountry: { '@type': 'Country', name: 'GB' },
        },
      },
      baseSalary: { '@type': 'MonetaryAmount', currency: 'gbp', value: { value: 16.5, unitText: 'HOUR' } },
      description: '&lt;p&gt;Lead a team of 12.&lt;/p&gt;',
    })}</script>`;
    const url = 'https://www.deltalogistics.co.uk/careers/warehouse-supervisor-leeds';
    const [a] = extractJsonLdJobPostings(page, url);
    const [b] = extractJsonLdJobPostings(page, url);
    expect(a!.externalId).toMatch(/^[0-9a-f]{32}$/);
    expect(a!.externalId).toBe(b!.externalId);
    expect(extractJsonLdJobPostings(page, `${url}-2`)[0]!.externalId).not.toBe(a!.externalId);
    expect(a).toMatchObject({
      companyName: 'Delta Logistics',
      postingUrl: url,
      workplaceType: null,
      employmentTypeText: 'FULL_TIME',
      publishedAt: '2026-09-01T08:00:00.000Z',
      locations: [
        {
          text: 'Leeds, West Yorkshire, GB',
          city: 'Leeds',
          region: 'West Yorkshire',
          country: 'GB',
          kind: 'job',
        },
      ],
      compensation: { min: 16.5, max: 16.5, currency: 'GBP', period: 'hour' },
      descriptionHtml: '<p>Lead a team of 12.</p>',
    });
  });

  it('handles top-level arrays, typed arrays and ignores invalid or untitled postings', () => {
    const page = `
      <script type="application/ld+json">[{"@type":["JobPosting"],"title":"A","identifier":42},{"@type":"JobPosting"}]</script>
      <script type="application/ld+json">{ broken</script>
      <script type="application/json">{"@type":"JobPosting","title":"Not JSON-LD"}</script>`;
    const postings = extractJsonLdJobPostings(page, 'https://x.com/jobs');
    expect(postings.map((p) => [p.externalId, p.title])).toEqual([['42', 'A']]);
  });

  it('returns nothing for pages without JobPosting data', () => {
    expect(
      extractJsonLdJobPostings(
        html('delta-careers-listing.html'),
        'https://www.deltalogistics.co.uk/careers',
      ),
    ).toEqual([]);
  });
});
