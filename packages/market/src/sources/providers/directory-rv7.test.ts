import { describe, expect, it } from 'vitest';
import { candidateFromPayload } from '../../companies/company-pipeline';
import { mapDirectoryRow, parseDirectoryConfig, planDirectoryImport } from './company-directory';
import { hasContactValue, isProfileUrl, urlHasContactValue } from './directory-values';

/** DECISION_LOG "Directory import: key release fenced; no numbered-company exemptions" (PR #27 rv7, c1a3500). */

const config = parseDirectoryConfig({
  columns: {
    name: 'Company',
    legalName: 'Legal',
    town: 'Town',
    country: 'Country',
    careersUrl: 'Careers',
    registerIds: { duns: 'DUNS', gb_companies_house: 'CRN' },
  },
  defaultCountry: 'GB',
});
const row = (over: Record<string, string>) => ({
  Company: 'Acme Widgets Ltd',
  Legal: '',
  Town: '',
  Country: 'GB',
  Careers: '',
  DUNS: '',
  CRN: '',
  ...over,
});
const kept = (over: Record<string, string>) => {
  const r = mapDirectoryRow(config, row(over), 2);
  if ('error' in r) throw new Error(`row refused: ${r.error.code}`);
  return r;
};
const refused = (over: Record<string, string>) => mapDirectoryRow(config, row(over), 2);

const TLDS = 'gr sa pk ng il ro hu tw ke qa gg je im london scot wales xyz tech cloud ae'.split(' ');

describe('H1 (a): a spelled dot accepts any public suffix', () => {
  it.each([
    'jane at acme dot ae',
    'jane (at) acme dot ae',
    'jane at acme dot com dot sg',
    'jane at acme dot com dot hk',
    'jane at acme dot co dot kr',
    'jane at acme dot com dot tr',
    'jane <at> acme <dot> ae',
    ...TLDS.map((t) => `jane at acme dot ${t}`),
    ...TLDS.map((t) => `jane (at) acme dot ${t}`),
    ...TLDS.map((t) => `jane <at> acme dot ${t}`),
  ])('%j is a contact value', (v) => {
    expect(hasContactValue(v)).toBe(true);
  });

  it.each(['Acme dot Ltd', 'Polka Dot Ltd', 'Coffee (at) Home Ltd', 'Made at Home Ltd'])(
    '%j (no at token and domain) stays a company name',
    (name) => {
      expect(kept({ Company: name }).warnings).toEqual([]);
    },
  );
});

describe('H1 (b): a bracketed at is atomic, with closing brackets before the domain', () => {
  it.each([
    'jane(at)acme(.)com',
    'jane[at]acme[.]com',
    'jane{at}acme{.}com',
    'jane(at)acme dot com',
    'jane(at)acme(.)co(.)uk',
    'jane<at>acme<dot>com',
    'jane[at] acme [.] com',
  ])('%j is a contact value', (v) => {
    expect(hasContactValue(v)).toBe(true);
  });
});

describe('H1 (c): bracketed dots with spaces inside', () => {
  it.each([
    'jane at acme [ . ] com',
    'jane at acme ( . ) com',
    'jane at acme { . } com',
    'jane at acme < . > com',
    'jane at acme <dot> com',
    'jane at acme [ dot ] co [ . ] uk',
  ])('%j is a contact value', (v) => {
    expect(hasContactValue(v)).toBe(true);
  });
});

describe('H1: the five reviewer rows (name, name, legal name, town, careers URL)', () => {
  it('refuses the name rows and drops the legal name, town and careers URL', () => {
    for (const name of ['Jane Smith zqlaa at smith-consult dot ae', 'zqlab[at]acme[.]com Trading'])
      expect(refused({ Company: name })).toMatchObject({ error: { code: 'contact_value' } });
    const legal = kept({ Legal: 'zqlac(at)acme(.)co(.)uk' });
    // The dropped legal name falls back to the row's name.
    expect(legal.candidate.payload.legalName).toBe('Acme Widgets Ltd');
    expect(legal.warnings).toEqual([expect.objectContaining({ code: 'contact_value', column: 'Legal' })]);
    const town = kept({ Town: 'zqlad at acme dot sg' });
    expect(JSON.stringify(town.candidate)).not.toContain('zqlad');
    expect(town.warnings[0]).toMatchObject({ column: 'Town' });
    expect(urlHasContactValue('https://acme.com/careers/zqlae-at-acme-dot-ae')).toBe(true);
    const careers = kept({ Careers: 'https://acme.com/careers/zqlae-at-acme-dot-ae' });
    // Reduced to its origin (DECISION_LOG 29b6592): the path is never stored.
    expect(careers.candidate.payload.careersUrl).toBe('https://acme.com/');
  });
});

describe('H2: no numbered-company exemption', () => {
  it.each([
    'Jane Smith 0412 345 674 Pty Ltd',
    'Jane Smith +61 412 345 674 Pty Ltd',
    'Smith Plumbing 0412345674 Pty Ltd',
    'Jane 0412-345-674 Limited',
    '004 085 616 Pty Ltd',
    'ACN 004 085 616 Pty Ltd',
    '1000123456 Ontario Inc.',
  ])('name %j is refused', (name) => {
    expect(refused({ Company: name })).toMatchObject({ error: { code: 'contact_value' } });
  });

  it.each([
    'Jane Smith 0412 345 674 Pty Ltd',
    'Jane Smith +61 412 345 674 Pty Ltd',
    'Jane 0412-345-674 Limited',
  ])('legal name %j is dropped', (legal) => {
    const r = kept({ Legal: legal });
    expect(r.candidate.payload.legalName).toBe('Acme Widgets Ltd');
    expect(r.warnings[0]).toMatchObject({ code: 'contact_value', column: 'Legal' });
  });

  it.each(['BC1234567 Ltd', 'Acme 1234567 Alberta Ltd', '9123 4567 Québec inc.', '9123-4567 Québec Inc.'])(
    '%j (fewer than 9 digits: below the ruled bar) is kept',
    (name) => {
      expect(kept({ Company: name }).warnings).toEqual([]);
    },
  );
});

describe('M1: defaultCountry fills only an empty or absent country cell', () => {
  it.each(['Germnay', 'America', 'Global', 'jane at acme dot com'])(
    'a dropped country %j stays unknown (no HQ seed, no country in the record key)',
    (country) => {
      const r = kept({ Country: country });
      expect(r.candidate.payload.locations).toEqual([]);
      expect(r.warnings[0]).toMatchObject({ column: 'Country' });
      expect(r.candidate.externalId).not.toMatch(/\|gb$/);
      expect(candidateFromPayload(r.candidate.payload).hqCountry ?? null).toBeNull();
    },
  );

  it('an empty cell takes the default', () => {
    expect(kept({ Country: '' }).candidate.payload.locations).toEqual([{ country: 'GB', kind: 'hq' }]);
  });
});

describe('L2/L3: careers URLs on profile hosts', () => {
  it.each([
    'https://www.linkedin.com/jobs/view/3912345678/',
    'https://www.linkedin.com/jobs/search/?currentJobId=3912345678&f_C=104567890%2C12345678&geoId=101165590',
    'https://www.linkedin.com/company/104567890/jobs/',
    'https://wellfound.com/company/acme/jobs',
    'https://dribbble.com/jobs',
  ])('%s is kept', (careers) => {
    expect(kept({ Careers: careers }).candidate.payload.careersUrl).not.toBeNull();
  });

  it.each([
    'https://www.linkedin.com/company//in/jane',
    'https://www.linkedin.com//in/jane',
    'https://wellfound.com/u/jane-smith',
    'https://angel.co/u/jane',
    'https://www.behance.net/janesmith',
    'https://dribbble.com/janesmith',
  ])('%s is dropped as a profile page', (careers) => {
    expect(isProfileUrl(new URL(careers))).toBe(true);
    const r = kept({ Careers: careers });
    expect(r.candidate.payload.careersUrl).toBeNull();
    expect(r.warnings[0]).toMatchObject({ code: 'profile_url', column: 'Careers' });
  });
});

describe('L5: the in-file check uses idsContradict', () => {
  const HEADER = 'Company,Country,CRN,DUNS';
  const plan = (rows: string[]) =>
    planDirectoryImport(config, [HEADER, ...rows].join('\n'), 'src_test').candidates.map((c) => c.review);

  it('several BR numbers beside an FC number, and several D-U-N-S numbers, are one company', () => {
    expect(plan(['Zulu Ltd,GB,BR001234,', 'Zulu Ltd,GB,BR005678,', 'Zulu Ltd,GB,FC012345,'])).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(plan(['Duns Ltd,GB,,150483782', 'Duns Ltd,GB,,150483790'])).toEqual([undefined, undefined]);
  });

  it('two ordinary company numbers still split the name into review', () => {
    expect(plan(['Kilo Ltd,GB,04700001,', 'Kilo Ltd,GB,09700002,'])).toEqual([
      'conflicting_ids_in_file',
      'conflicting_ids_in_file',
    ]);
  });
});
