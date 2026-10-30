import { describe, expect, it } from 'vitest';
import { NON_COMPANY_DOMAINS, isNonCompanyDomain, normalizeDomain } from './domain';

describe('normalizeDomain', () => {
  it.each([
    ['https://www.Acme.com/about?x=1', 'acme.com'],
    ['acme.com', 'acme.com'],
    ['WWW.ACME.CO.UK', 'acme.co.uk'],
    ['careers.acme.io', 'acme.io'],
    ['http://shop.deltalogistics.co.uk:8080/', 'deltalogistics.co.uk'],
    ['jobs@beta.co', 'beta.co'],
    ['  gamma.ai  ', 'gamma.ai'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each([
    '192.168.1.1',
    'https://10.0.0.1/careers',
    'http://[::1]/',
    'localhost',
    'intranet.corp',
    'not a domain',
    '',
    'https://uk.linkedin.com/company/acme',
    'facebook.com',
    'x.com',
    'twitter.com',
    'instagram.com',
    'www.glassdoor.co.uk',
    'de.indeed.com',
    'indeed.de',
    'www.gov.uk',
    'find-and-update.company-information.service.gov.uk',
    'https://en.wikipedia.org/wiki/Acme',
    'boards.greenhouse.io',
  ])('rejects %s', (input) => {
    expect(normalizeDomain(input)).toBeNull();
  });

  it('exports the blocklist', () => {
    expect(NON_COMPANY_DOMAINS.has('linkedin.com')).toBe(true);
    expect(isNonCompanyDomain('companieshouse.gov.uk')).toBe(true);
    expect(isNonCompanyDomain('acme.com')).toBe(false);
  });
});
