import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { candidateCareersPaths, findCareersLinks } from './careers-links';

const html = (name: string) =>
  readFileSync(new URL(`../../fixtures/careers/${name}`, import.meta.url), 'utf8');

describe('findCareersLinks', () => {
  it('finds and dedupes the careers link on a homepage', () => {
    const links = findCareersLinks(html('acme-home.html'), 'https://www.acme.com/');
    expect(links[0]).toMatchObject({ url: 'https://www.acme.com/careers', text: 'Careers' });
    expect(links[0]!.reasons).toEqual(expect.arrayContaining(['text_exact', 'url_path', 'same_site']));
    // "/careers", "/careers#open-roles" and "/careers/" are one page.
    expect(links).toHaveLength(1);
    const urls = links.map((l) => l.url).join(' ');
    expect(urls).not.toMatch(/mailto:|tel:|linkedin|twitter|#/);
  });

  it('strongly prefers links to known ATS boards', () => {
    const links = findCareersLinks(html('beta-careers-lever.html'), 'https://beta.co/careers');
    expect(links[0]).toMatchObject({ url: 'https://jobs.lever.co/beta-co', text: 'View open positions' });
    expect(links[0]!.reasons).toContain('ats_host:lever');
    expect(links.some((l) => l.url.includes('indeed'))).toBe(false);
  });

  it('excludes or down-ranks misleading links', () => {
    const links = findCareersLinks(html('epsilon-misleading.html'), 'https://www.epsilon-analytics.com/');
    expect(links[0]?.url).toBe('https://www.epsilon-analytics.com/company/careers');
    const urls = links.map((l) => l.url);
    expect(urls.some((u) => /linkedin|glassdoor|facebook|jobsboard\.example/.test(u))).toBe(false);
    expect(urls.some((u) => u.includes('monthly-jobs-report'))).toBe(false);
    expect(urls.some((u) => u.startsWith('javascript:') || u.startsWith('mailto:'))).toBe(false);
    const insights = links.find((l) => l.url.endsWith('/insights/jobs'));
    expect(insights?.score).toBeLessThan(links[0]!.score);
    expect(insights?.reasons).toContain('editorial_path');
  });

  it('scores careers subdomains as same-site', () => {
    const links = findCareersLinks(
      '<a href="https://careers.acme.com/">Work with us</a><a href="https://other.com/x">Jobs</a>',
      'https://acme.com/',
    );
    expect(links).toHaveLength(1);
    expect(links[0]!.reasons).toEqual(expect.arrayContaining(['careers_subdomain', 'same_site']));
  });

  it('returns nothing for an invalid page URL', () => {
    expect(findCareersLinks('<a href="/careers">Careers</a>', 'not a url')).toEqual([]);
  });
});

describe('candidateCareersPaths', () => {
  it('lists conventional careers URLs in probe order', () => {
    expect(candidateCareersPaths('www.Acme.com')).toEqual([
      'https://acme.com/careers',
      'https://acme.com/jobs',
      'https://acme.com/careers/',
      'https://acme.com/join-us',
      'https://acme.com/company/careers',
      'https://acme.com/about/careers',
      'https://acme.com/work-with-us',
      'https://careers.acme.com/',
      'https://jobs.acme.com/',
    ]);
  });

  it('returns nothing for non-company domains', () => {
    expect(candidateCareersPaths('linkedin.com')).toEqual([]);
  });
});

describe('findCareersLinks on an ATS-embedding careers page', () => {
  it('surfaces the <noscript> fallback board link and ignores the self-link', () => {
    const links = findCareersLinks(html('acme-careers-greenhouse.html'), 'https://www.acme.com/careers');
    expect(links.map((l) => l.url)).toEqual(['https://job-boards.greenhouse.io/acme']);
    expect(links[0]!.reasons).toContain('ats_host:greenhouse');
  });
});
