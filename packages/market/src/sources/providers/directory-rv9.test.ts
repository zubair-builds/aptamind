import { describe, expect, it } from 'vitest';
import { mapDirectoryRow, parseDirectoryConfig } from './company-directory';
import { hasContactValue, urlHasContactValue } from './directory-values';

/** PR #27 re-verification #9 (within the b24e5dd bar): URL hosts, any separator around `dot`, LinkedIn id shapes. */

const config = parseDirectoryConfig({
  columns: {
    name: 'Company',
    legalName: 'Legal',
    domain: 'Domain',
    website: 'Website',
    country: 'Country',
    careersUrl: 'Careers',
  },
});
const row = (over: Record<string, string>) => ({
  Company: 'Acme Widgets Ltd',
  Legal: '',
  Domain: '',
  Website: '',
  Country: 'GB',
  Careers: '',
  ...over,
});
const kept = (over: Record<string, string>) => {
  const r = mapDirectoryRow(config, row(over), 2);
  if ('error' in r) throw new Error(`row refused: ${r.error.code}`);
  return r;
};

describe('H-1: URL hosts are scanned (decoded until stable)', () => {
  it.each([
    'https://jane&commat;acme.com/careers',
    'https://jane%26commat%3Bacme.com/careers',
    'https://acme.com&commat;gmail.com/careers',
    'https://jane&#64;acme.com/careers',
    'https://07700900123.acme.com/careers',
    'https://call-07700-900123.acme.co.uk/',
    'https://07700900123.co.uk/',
    '07700900123.co.uk',
    // 9+ digits in the host that no phone shape covers (the host digit rule).
    'https://7700900123.acme.co.uk/',
    'https://447700900123.acme.com/careers',
    'https://7700-900-123.acme.com/',
    '7700900123.co.uk',
  ])('%s is a contact value', (v) => {
    expect(urlHasContactValue(v)).toBe(true);
  });

  it.each([
    'https://jane&commat;acme.com/careers',
    'https://jane%26commat%3Bacme.com/careers',
    'https://acme.com&commat;gmail.com/careers',
    'https://07700900123.acme.com/careers',
  ])('careers %s is dropped', (careers) => {
    const r = kept({ Careers: careers });
    expect(r.candidate.payload.careersUrl).toBeNull();
    expect(r.warnings[0]).toMatchObject({ column: 'Careers' });
  });

  it.each(['https://call-07700-900123.acme.co.uk/', 'https://07700900123.co.uk/'])(
    'website %s is dropped',
    (w) => {
      const r = kept({ Website: w });
      expect(r.candidate.payload.website).toBeNull();
      expect(r.warnings[0]).toMatchObject({ column: 'Website' });
    },
  );

  it('domain 07700900123.co.uk is dropped and never becomes identity', () => {
    const r = kept({ Domain: '07700900123.co.uk' });
    expect(r.candidate.payload.domain).toBeNull();
    expect(JSON.stringify(r.candidate)).not.toContain('07700900123');
  });

  it.each([
    'https://boards.greenhouse.io/acme',
    'https://jobs.lever.co/acme/1b2c3d4e-5f60-7182-93a4-b5c6d7e8f901',
    'https://acme.wd3.myworkdayjobs.com/en-US/External/job/London/Engineer_R-0123456',
    'https://acme.com/blog/2024/05/01/hiring',
    'https://careers.acme.com:8443/jobs',
    'https://www.acme-2019.co.uk/',
    'acme.co.uk',
  ])('%s is kept', (v) => {
    expect(urlHasContactValue(v)).toBe(false);
  });

  it.each(['https://jobs-at-acme.com/careers', 'https://jane-at-gmail-dot-com.acme.com/careers'])(
    'documented residual: the `at` notation inside a host (%s) is not read as an address',
    (v) => {
      expect(urlHasContactValue(v)).toBe(false);
    },
  );
});

describe('H-2: a spelled `dot` with any separator', () => {
  it.each([
    'jane at acme – dot – com',
    'jane at acme — dot — com',
    "jane at acme 'dot' com",
    'jane at acme "dot" com',
    'jane at acme ‘dot’ com',
    'jane at acme “dot” com',
    'jane at acme –dot– co –dot– uk',
    'jane(at)acme–dot–com',
    "jane[at]acme 'dot' com",
    "jane at 'acme.com'",
    'jane at “acme.com”',
    'jane (at) «acme» dot com',
    'zqd1 at acme – dot – com',
    'zqe1 at acme — dot — com',
  ])('%j is a contact value', (v) => {
    expect(hasContactValue(v, { digitRuns: true })).toBe(true);
  });

  it('a dashed-dot legal name is dropped', () => {
    const r = kept({ Legal: 'zqe1 at acme — dot — com' });
    expect(r.candidate.payload.legalName).toBe('Acme Widgets Ltd');
    expect(r.warnings[0]).toMatchObject({ code: 'contact_value', column: 'Legal' });
  });

  it.each(['Polka Dot Ltd', 'Dot Com Ltd', 'Art at Work Inc.', 'Studio at Unit 4.2 Ltd'])(
    '%j stays a name',
    (n) => {
      expect(hasContactValue(n, { digitRuns: true })).toBe(false);
    },
  );
});

describe('L-2: LinkedIn id shapes', () => {
  it.each([
    'https://www.linkedin.com/company/7700900123',
    'https://www.linkedin.com/company/77009001234',
    'https://www.linkedin.com/jobs/view/7700900123/',
    'https://www.linkedin.com/jobs/view/abc-447700900123',
  ])('%s is dropped', (careers) => {
    expect(urlHasContactValue(careers)).toBe(true);
  });

  it.each([
    'https://www.linkedin.com/company/104567890/jobs/',
    'https://www.linkedin.com/jobs/view/3912345678/',
    'https://www.linkedin.com/jobs/view/senior-engineer-at-acme-3912345678',
  ])('%s is kept', (careers) => {
    expect(urlHasContactValue(careers)).toBe(false);
  });
});
