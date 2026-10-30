import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findJobDetailLinks } from './job-links';

const html = (name: string) =>
  readFileSync(new URL(`../../fixtures/careers/${name}`, import.meta.url), 'utf8');

describe('findJobDetailLinks', () => {
  it('finds same-host job detail pages on a generic careers page', () => {
    expect(
      findJobDetailLinks(html('delta-careers-listing.html'), 'https://www.deltalogistics.co.uk/careers'),
    ).toEqual([
      'https://www.deltalogistics.co.uk/careers/senior-data-engineer-remote-uk',
      'https://www.deltalogistics.co.uk/careers/warehouse-supervisor-leeds?utm_source=careers',
      'https://www.deltalogistics.co.uk/careers/transport-planner-dublin',
    ]);
  });

  it('recognises common job path conventions', () => {
    const page = [
      '/job/123-backend-engineer',
      '/jobs/42',
      '/positions/frontend',
      '/openings/ops-lead',
      '/vacancies/driver-hgv',
      '/en/careers/data-analyst',
      '/jobs',
      '/jobs/search?q=x',
      '/about',
      'https://other.com/jobs/1',
    ]
      .map((href) => `<a href="${href}">x</a>`)
      .join('');
    expect(findJobDetailLinks(page, 'https://acme.com/careers')).toEqual([
      'https://acme.com/job/123-backend-engineer',
      'https://acme.com/jobs/42',
      'https://acme.com/positions/frontend',
      'https://acme.com/openings/ops-lead',
      'https://acme.com/vacancies/driver-hgv',
      'https://acme.com/en/careers/data-analyst',
    ]);
  });

  it('returns nothing for an invalid page URL', () => {
    expect(findJobDetailLinks('<a href="/jobs/1">x</a>', '::')).toEqual([]);
  });
});
