import { describe, expect, it } from 'vitest';
import { candidateOf, identityDomainOf } from '../../companies/company-pipeline';
import { looseNameKey, strictNameKey } from '../../companies/normalize';
import {
  type CompanyLookup,
  type CompanySummary,
  ownsName,
  resolveCompanyCandidate,
} from '../../resolution/company-resolver';
import {
  checkDirectoryHeader,
  COMPANY_DIRECTORY_PARSER,
  isPersonalDataColumn,
  mapDirectoryRow,
  parseDirectoryConfig,
  planDirectoryImport,
} from './company-directory';
import { decodeStable, hasContactValue, urlHasContactValue } from './directory-values';

/** The row's problem: its error, else its first dropped-cell warning (re-verification #6). */
const problemOf = (r: ReturnType<typeof mapDirectoryRow>) => ('error' in r ? r.error : r.warnings[0]);

/** DECISION_LOG "Company directory identity is structural" (PR #27 re-verification #3). */

const config = parseDirectoryConfig({
  columns: {
    name: 'Company',
    legalName: 'Legal name',
    domain: 'Domain',
    website: 'Website',
    country: 'Country',
    town: 'Town',
    careersUrl: 'Careers',
    registerIds: { gb_companies_house: 'CRN' },
  },
});
const HEADER = 'Company,Legal name,Domain,Website,Country,Town,Careers,CRN';
const row = (over: Record<string, string> = {}) => ({
  Company: 'Acme Ltd',
  'Legal name': '',
  Domain: '',
  Website: '',
  Country: 'GB',
  Town: '',
  Careers: '',
  CRN: '',
  ...over,
});
const map = (over: Record<string, string>) => mapDirectoryRow(config, row(over), 2);
const payload = (over: Record<string, string>) => {
  const r = map(over);
  if (!('candidate' in r)) throw new Error(`row error ${r.error.code}`);
  return r.candidate.payload;
};
const directory = (over: Record<string, string>) =>
  candidateOf({ payload: payload(over), parser: COMPANY_DIRECTORY_PARSER });

function company(id: string, names: string[], extra: Partial<CompanySummary> & { keys?: string[] } = {}) {
  return {
    id,
    displayName: names[0]!,
    names,
    strictKeys: extra.strictKeys ?? [strictNameKey(names[0]!)],
    looseKey: extra.looseKey ?? looseNameKey(names[0]!),
    domain: extra.domain ?? null,
    hqCountry: null,
    registeredTowns: [],
    keys: extra.keys ?? [
      `name:${strictNameKey(names[0]!)}`,
      ...(extra.domain ? [`domain:${extra.domain}`] : []),
    ],
  };
}
type Row = ReturnType<typeof company>;
const lookupOf = (companies: Row[]): CompanyLookup => ({
  byIdentityKey: async (k) => companies.find((c) => c.keys.includes(k)) ?? null,
  byStrictName: async (k) => companies.filter((c) => c.keys.includes(`name:${k}`)),
  byLooseKey: async (k) => companies.filter((c) => c.looseKey === k),
  byFirstToken: async () => [],
});

describe('1: only the mapped Domain column is domain identity; Website is an attribute', () => {
  it.each([
    'https://maps.google.com/?cid=123456',
    'https://www.google.co.uk/maps/place/Smith+Electrical',
    'https://bit.ly/3smith',
    'https://find-and-update.company-information.service.gov.uk/company/04821937',
    'https://smith-electrical.co.uk/',
  ])('Website %s never becomes identity (no domain, never lifts bare status)', (website) => {
    const c = directory({ Company: 'Smith Electrical', Website: website });
    expect(c).toMatchObject({ domain: null, directoryRow: true });
  });

  it('a Website on an accepted host is kept as a scheme + host attribute only', () => {
    expect(payload({ Website: 'https://smith-electrical.co.uk/about?x=1' })).toMatchObject({
      domain: null,
      website: 'https://smith-electrical.co.uk/',
    });
  });

  it('the Domain column is identity evidence', () => {
    expect(directory({ Domain: 'acme.co.uk', Website: 'https://other.co.uk/' }).domain).toBe('acme.co.uk');
  });

  it('the reconciler reads directory domains the same way (no fall-back to the website)', () => {
    const p = payload({ Website: 'https://smith-electrical.co.uk/' });
    expect(identityDomainOf({ payload: p, parser: COMPANY_DIRECTORY_PARSER })).toBeNull();
    // Legacy rows stored with a website-derived domain are still refused when the host is.
    expect(
      identityDomainOf({ payload: { ...p, domain: 'google.com' }, parser: COMPANY_DIRECTORY_PARSER }),
    ).toBe('google.com');
    expect(
      identityDomainOf({ payload: { ...p, domain: 'gmail.com' }, parser: COMPANY_DIRECTORY_PARSER }),
    ).toBeNull();
    // Other providers keep their fall-back.
    expect(identityDomainOf({ payload: p, parser: { name: 'ats', version: '1' } })).toBe(
      'https://smith-electrical.co.uk/',
    );
  });

  it('the record key never uses the Website', () => {
    const r = mapDirectoryRow(config, row({ Country: '', Website: 'https://acme.co.uk/' }), 2);
    expect('candidate' in r && r.candidate.externalId).toBe('name:acme ltd|');
  });
});

describe('2: a directory domain / external-id hit auto-matches only on the row’s own name key', () => {
  const acme = company('cmp_acme', ['Acme Ltd'], {
    domain: 'acme.co.uk',
    keys: ['name:acme ltd', 'domain:acme.co.uk', 'ext:gb_companies_house:04821937'],
  });
  const google = company('cmp_google', ['Google UK Ltd'], {
    domain: 'google.com',
    keys: ['name:google uk ltd', 'domain:google.com'],
  });
  // Holds a name key it does not own (its names are something else).
  const holder = company('cmp_holder', ['Zenith Holdings Ltd'], {
    keys: ['name:zenith holdings ltd', 'ext:gb_companies_house:00445790'],
  });
  const l = lookupOf([acme, google, holder]);
  const d = (c: Parameters<typeof resolveCompanyCandidate>[0]) => resolveCompanyCandidate(c, l);

  it('same strict or loose key → match', async () => {
    expect(await d({ name: 'Acme Limited', domain: 'acme.co.uk', directoryRow: true })).toMatchObject({
      kind: 'match',
      method: 'domain',
    });
    expect(await d({ name: 'Acme', domain: 'acme.co.uk', directoryRow: true })).toMatchObject({
      kind: 'match',
    });
    expect(
      await d({
        name: 'ACME LTD',
        externalIds: [{ namespace: 'gb_companies_house', id: '04821937' }],
        directoryRow: true,
      }),
    ).toMatchObject({ kind: 'match', method: 'external_id' });
  });

  it('a token overlap is not enough (namesPlausiblySame would match); any other hit → review', async () => {
    expect(await d({ name: 'Acme Coffee Ltd', domain: 'acme.co.uk', directoryRow: true })).toMatchObject({
      kind: 'review',
    });
    expect(await d({ name: 'Acme Coffee Ltd', domain: 'acme.co.uk' })).toMatchObject({ kind: 'match' }); // other providers
    expect(await d({ name: 'Smith Electrical', domain: 'google.com', directoryRow: true })).toMatchObject({
      kind: 'review',
    });
    expect(
      await d({
        name: 'Acme Coffee Ltd',
        externalIds: [{ namespace: 'gb_companies_house', id: '04821937' }],
        directoryRow: true,
      }),
    ).toMatchObject({ kind: 'review', candidates: [{ id: 'cmp_acme', method: 'external_id' }] });
  });

  it('own keys come from the company’s names, not from keys it holds', () => {
    const odd = { ...holder, strictKeys: ['acme ltd'] };
    expect(ownsName({ name: 'Acme Ltd' }, odd)).toBe(false);
    expect(ownsName({ name: 'Zenith Holdings' }, odd)).toBe(true);
    expect(ownsName({ name: 'Acme Coffee' }, { ...acme, names: ['Acme Ltd', 'Acme Coffee'] })).toBe(true);
  });
});

describe('3: one external id on rows with different names errors all of them', () => {
  it('different names → conflicting_external_id on every row, nothing imported, nothing echoed', () => {
    const text = [
      HEADER,
      'Smith Plumbing Ltd,,,,GB,,,04821937',
      'Acme Ltd,,,,GB,,,00445790',
      'Smith Electrical Ltd,,,,GB,,,04821937',
      'Jones Roofing Ltd,,,,GB,,,4821937', // the same id before normalisation
    ].join('\n');
    const plan = planDirectoryImport(config, text, 'src_test');
    expect(plan.candidates.map((c) => c.payload.name)).toEqual(['Acme Ltd']);
    expect(plan.errors).toEqual(
      [2, 4, 5].map((line) => ({
        line,
        code: 'conflicting_external_id',
        column: 'CRN',
        message:
          'the same register id is on rows with different company names in this file; none of them is imported',
      })),
    );
    expect(JSON.stringify(plan.errors)).not.toMatch(/Smith|Jones|4821937/);
  });

  it('the same name twice is a duplicate row (the first imported)', () => {
    const text = [
      HEADER,
      'Smith Plumbing Ltd,,,,GB,,,04821937',
      'SMITH PLUMBING LIMITED,,,,GB,Leeds,,04821937',
    ].join('\n');
    const plan = planDirectoryImport(config, text, 'src_test');
    expect(plan.candidates).toHaveLength(1);
    expect(plan.errors.map((e) => [e.line, e.code])).toEqual([[3, 'duplicate_row_key']]);
  });
});

describe('4: a name-key hit counts only when it is the company’s own v2 key', () => {
  // µTech Ltd was keyed under name-norm/1 (µ was a separator): it holds `name:tech ltd`.
  const mutech = company('cmp_mutech', ['µTech Ltd'], {
    strictKeys: ['tech ltd'],
    looseKey: 'tech',
    keys: ['name:tech ltd'],
  });
  const l = lookupOf([mutech]);

  it('"Tech Ltd" → review (legacy key), not name_exact', async () => {
    expect(await resolveCompanyCandidate({ name: 'Tech Ltd' }, l)).toMatchObject({
      kind: 'review',
      candidates: [{ id: 'cmp_mutech', method: 'name_legacy_key' }],
    });
  });

  it('"Tech" (loose) → review, not a brand match', async () => {
    expect(await resolveCompanyCandidate({ name: 'Tech' }, l)).toMatchObject({ kind: 'review' });
  });

  it('"µTech Ltd" itself still matches (its own key)', async () => {
    expect(await resolveCompanyCandidate({ name: 'µTech Ltd' }, l)).toMatchObject({
      kind: 'match',
      companyId: 'cmp_mutech',
    });
  });
});

describe('6: contact values', () => {
  it.each([
    // digit runs in name / legal name / town (9–15 digits, separators optional)
    ['Company', 'Smith Plumbing 447700900123'],
    ['Company', 'Smith Plumbing 7700 900 123'],
    ['Company', 'Smith 020-7946-0958 Ltd'],
    ['Legal name', 'J Smith 123456789'],
    ['Town', 'Leeds 01132 496 000'],
    ['Town', '７７００９００１２３'], // full-width digits, NFKC
    // obfuscated emails
    ['Company', 'Smith Plumbing jane [at] smith-plumbing.co.uk'],
    ['Company', 'Smith Plumbing jane(at)smith-plumbing.co.uk'],
    ['Company', 'Smith Plumbing jane @ smith-plumbing.co.uk'],
    ['Company', 'Smith Plumbing jane＠smith-plumbing.co.uk'],
    ['Legal name', 'jane {at} smith [dot] co [dot] uk'],
    ['Town', 'jane\u200b@smith.co.uk'],
    // URLs: credentials (the path, query and fragment are reduced away: see below)
    ['Website', 'https://jane@smith.co.uk/'],
    ['Domain', 'jane [at] smith.co.uk'],
  ])('%s %j → contact_value, nothing echoed', (column, value) => {
    const r = map({ [column]: value });
    expect(problemOf(r)).toMatchObject({ code: 'contact_value', column });
    expect(JSON.stringify(r)).not.toMatch(/jane|7700|7946|smith|0113/i);
  });

  it.each([
    ['Careers', 'https://smith.co.uk/jobs/jane%2540smith.co.uk', 'https://smith.co.uk/'],
    ['Careers', 'https://smith.co.uk/jobs/jane%252540smith.co.uk', 'https://smith.co.uk/'],
    ['Careers', 'https://smith.co.uk/call/%2B44%207700%20900123', 'https://smith.co.uk/'],
    ['Careers', 'https://smith.co.uk/jobs?apply=jane@smith.co.uk', 'https://smith.co.uk/jobs'],
    ['Careers', 'https://smith.co.uk/jobs#jane@smith.co.uk', 'https://smith.co.uk/jobs'],
    ['Website', 'https://smith.co.uk/contact/jane(at)smith.co.uk', 'https://smith.co.uk/'],
  ])(
    '%s %j is reduced, not parsed: stored as %s, nothing echoed (DECISION_LOG 29b6592)',
    (column, value, stored) => {
      const r = map({ [column]: value });
      if (!('candidate' in r)) throw new Error('row refused');
      expect(column === 'Website' ? r.candidate.payload.website : r.candidate.payload.careersUrl).toBe(
        stored,
      );
      expect(JSON.stringify(r)).not.toMatch(/jane|7700|7946|0113/i);
    },
  );

  it.each([
    'Acme 24-7 Ltd',
    '3M United Kingdom PLC',
    'Plumbers (2019) Ltd',
    'Coffee (at) Home Ltd',
    'Unit 12345678',
  ])('name %j is no contact value', (v) => {
    expect(hasContactValue(v, { digitRuns: true })).toBe(false);
  });

  it('an id or register-id cell is not read with the digit-run rule (long numeric ids are ids)', () => {
    expect(hasContactValue('123456789012')).toBe(false);
    expect(hasContactValue('123456789012', { digitRuns: true })).toBe(true);
  });

  it('careers URLs keep scheme + host + path; query and fragment are dropped entirely', () => {
    expect(
      payload({ Careers: 'https://careers.acme.co.uk/uk/jobs?utm_source=x&ref=y#apply' }).careersUrl,
    ).toBe('https://careers.acme.co.uk/uk/jobs');
  });

  it('decodes until stable', () => {
    expect(decodeStable('a%252540b')).toBe('a@b');
    expect(decodeStable('%E0%A4%A')).toBe('%E0%A4%A');
    // An invalid escape does not shield a valid one.
    expect(decodeStable('%E0%A4jane%2540smith')).toBe('%E0%A4jane@smith');
    expect(urlHasContactValue('https://acme.co.uk/jobs/12345678')).toBe(false);
  });
});

describe('7: header guard (reviewer L-1 list and exemptions)', () => {
  it.each([
    'telno',
    'TelNo',
    'mobno',
    'contactno',
    'contactnumber',
    'contactperson',
    'Contact No.',
    'ownername',
    'directorname',
    'keycontact',
    'Key contact',
    'Ph',
    'Ph No',
    'Ph. no.',
    'Tlf',
    'Tlf.',
    'Handy',
    'Handynummer',
    'Portable',
    'Móvil',
    'Movil',
    'Correo',
    'Correo electrónico',
    'Kontakt',
    'Kontaktperson',
    'Ansprechpartner',
    'Geschäftsführer',
    'Geschaeftsfuehrer'.replace('ae', 'a').replace('ue', 'u'),
    'Inhaber',
    'Gérant',
    'Dirigeant',
    'Residential address',
    'UTR',
    'Insta',
    'Insta handle',
    'WeChat',
    'Snapchat',
    'E\u200bmail',
    'Ph\u200bone',
    'Con\u200btact',
    'OwnerName',
    'DirectorName1',
  ])('%j is refused', (h) => {
    expect(isPersonalDataColumn(h)).toBe(true);
  });

  const BASIC_COMPANY_DATA_HEADER = [
    'CompanyName',
    ' CompanyNumber',
    'RegAddress.CareOf',
    'RegAddress.POBox',
    'RegAddress.AddressLine1',
    ' RegAddress.AddressLine2',
    'RegAddress.PostTown',
    'RegAddress.County',
    'RegAddress.Country',
    'RegAddress.PostCode',
    'CompanyCategory',
    'CompanyStatus',
    'CountryOfOrigin',
    'DissolutionDate',
    'IncorporationDate',
    'Accounts.AccountRefDay',
    'Accounts.AccountRefMonth',
    'Accounts.NextDueDate',
    'Accounts.LastMadeUpDate',
    'Accounts.AccountCategory',
    'Returns.NextDueDate',
    'Returns.LastMadeUpDate',
    'Mortgages.NumMortCharges',
    'Mortgages.NumMortOutstanding',
    'Mortgages.NumMortPartSatisfied',
    'Mortgages.NumMortSatisfied',
    'SICCode.SicText_1',
    'SICCode.SicText_2',
    'SICCode.SicText_3',
    'SICCode.SicText_4',
    'LimitedPartnerships.NumGenPartners',
    'LimitedPartnerships.NumLimPartners',
    'URI',
    ...Array.from({ length: 10 }, (_, k) => [
      `PreviousName_${k + 1}.CONDATE`,
      ` PreviousName_${k + 1}.CompanyName`,
    ]).flat(),
    'ConfStmtNextDueDate',
    ' ConfStmtLastMadeUpDate',
  ];

  it('the full Companies House BasicCompanyData header row passes, except RegAddress.CareOf (a person, re-verification #4)', () => {
    expect(BASIC_COMPANY_DATA_HEADER.filter(isPersonalDataColumn)).toEqual(['RegAddress.CareOf']);
  });

  it.each([
    'Employees (UK)',
    'Employee Range',
    'Number of employees (2023)',
    'NI Company Number',
    'Email domain',
    'Mobile app',
    'Automobile sector',
    'Employees',
    'Headcount',
    'Postcode',
    'Company',
    'Legal name',
    'Website',
    'Careers URL',
    'Domain',
    'Country',
    'Town',
    'Registered number',
    'Sector',
    'Industry',
    'Founded',
    'Ownership',
    'Partnership',
  ])('%j is an allowed company header', (h) => {
    expect(isPersonalDataColumn(h)).toBe(false);
  });
});

describe('8: the 400 body never echoes header text that is not a configured column name', () => {
  it('unmapped and personal columns are named by position only', () => {
    const problems = checkDirectoryHeader(config, [
      'Company',
      'Jane Doe',
      'Smith Plumbing Ltd',
      'Domain',
      'Domain',
      'Jane Doe',
      'Mobile',
    ]);
    const text = JSON.stringify(problems);
    expect(text).not.toMatch(/Jane|Smith|Mobile/);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'unmapped_column', column: 'column 2' }),
        expect.objectContaining({ code: 'unmapped_column', column: 'column 3' }),
        expect.objectContaining({ code: 'duplicate_column', column: 'Domain' }), // a configured name
        expect.objectContaining({ code: 'duplicate_column', column: 'column 6' }),
        expect.objectContaining({ code: 'personal_data_column', column: 'column 7' }),
        expect.objectContaining({ code: 'missing_column', column: 'Legal name' }), // configured
      ]),
    );
  });
});
