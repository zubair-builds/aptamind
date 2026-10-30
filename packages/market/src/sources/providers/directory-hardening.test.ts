import { describe, expect, it } from 'vitest';
import { candidateOf } from '../../companies/company-pipeline';
import { normalizeExternalId } from '../../companies/external-ids';
import {
  checkDirectoryHeader,
  COMPANY_DIRECTORY_PARSER,
  isPersonalDataColumn,
  mapDirectoryRow,
  parseDirectoryConfig,
  planDirectoryImport,
} from './company-directory';
import {
  directoryDomain,
  hasContactValue,
  isPlaceholder,
  isPlaceholderId,
  isPlaceholderTown,
} from './directory-values';

/** The row's problem: its error, else its first dropped-cell warning (re-verification #6). */
const problemOf = (r: ReturnType<typeof mapDirectoryRow>) => ('error' in r ? r.error : r.warnings[0]);

/** DECISION_LOG "Company directory import hardening" (PR #27 re-verification #2). */

const config = parseDirectoryConfig({
  columns: {
    name: 'Company',
    legalName: 'Legal name',
    domain: 'Domain',
    website: 'Website',
    country: 'Country',
    town: 'Town',
    careersUrl: 'Careers',
    id: 'Ref',
    registerIds: { gb_companies_house: 'CRN', us_ein: 'EIN', duns: 'DUNS', nl_kvk: 'KvK', fr_siren: 'SIREN' },
  },
});
const row = (over: Record<string, string> = {}) => ({
  Company: 'Acme Ltd',
  'Legal name': '',
  Domain: '',
  Website: '',
  Country: 'GB',
  Town: '',
  Careers: '',
  Ref: '',
  CRN: '',
  EIN: '',
  DUNS: '',
  KvK: '',
  SIREN: '',
  ...over,
});
const map = (over: Record<string, string>) => mapDirectoryRow(config, row(over), 2);
const payload = (over: Record<string, string>) => {
  const r = map(over);
  if (!('candidate' in r)) throw new Error(`row error ${r.error.code}`);
  return r.candidate.payload;
};

describe('H1: one refusal list for every domain the importer uses', () => {
  it.each([
    // webmail, exact and by label on any public suffix
    ['gmail.com', 'personal_email'],
    ['https://gmail.com', 'personal_email'],
    ['hotmail.co.uk', 'personal_email'],
    ['outlook.de', 'personal_email'],
    ['live.co.uk', 'personal_email'],
    ['yahoo.fr', 'personal_email'],
    ['mail.yahoo.co.jp', 'personal_email'],
    ['gmx.at', 'personal_email'],
    ['web.de', 'personal_email'],
    ['aol.co.uk', 'personal_email'],
    ['icloud.com', 'personal_email'],
    ['protonmail.ch', 'personal_email'],
    ['btinternet.com', 'personal_email'],
    ['sky.com', 'personal_email'],
    ['ymail.com', 'personal_email'],
    ['mail.com', 'personal_email'],
    ['fastmail.com', 'personal_email'],
    ['t-online.de', 'personal_email'],
    ['orange.fr', 'personal_email'],
    // shared hosting, link-in-bio, social
    ['https://sites.google.com/view/smith-plumbing', 'shared_hosting'],
    ['smithplumbing.wixsite.com/home', 'shared_hosting'],
    ['smithplumbing.wordpress.com', 'shared_hosting'],
    ['smithplumbing.blogspot.com', 'shared_hosting'],
    ['smith.github.io', 'shared_hosting'],
    ['https://linktr.ee/smith', 'shared_hosting'],
    ['https://www.facebook.com/smithplumbing', 'shared_hosting'],
    ['https://uk.linkedin.com/company/acme', 'shared_hosting'],
    ['acme.myshopify.com', 'shared_hosting'],
    // reserved and junk
    ['example.com', 'reserved'],
    ['www.example.org', 'reserved'],
    ['example.net', 'reserved'],
    ['test.com', 'reserved'],
    ['acme.test', 'reserved'],
    ['acme.invalid', 'reserved'],
    ['acme.local', 'reserved'],
    ['localhost', 'reserved'],
    ['acme.example', 'reserved'],
    ['acme.internal', 'reserved'],
  ])('%s is refused (%s)', (value, reason) => {
    expect(directoryDomain(value)).toEqual({ refused: reason });
  });

  it.each([
    ['acme.com', 'acme.com'],
    ['https://www.acme.co.uk/about', 'acme.co.uk'],
    ['google.com', 'google.com'],
    ['livenation.com', 'livenation.com'],
    ['acme-mail.com', 'acme-mail.com'],
  ])('%s is a company domain', (value, domain) => {
    expect(directoryDomain(value)).toEqual({ domain });
  });

  it('a refused Domain cell is a row error that names the column, never the value', () => {
    const r = map({ Domain: 'gmail.com' });
    expect(problemOf(r)).toMatchObject({ code: 'invalid_domain', column: 'Domain' });
    expect(JSON.stringify(r)).not.toContain('gmail');
  });

  it('a refused Website or Careers host is no identity evidence: dropped, the row stays bare', () => {
    const p = payload({ Company: 'Smith Plumbing', Website: 'https://gmail.com' });
    expect(p).toMatchObject({ domain: null, website: null });
    const c = candidateOf({ payload: p, parser: COMPANY_DIRECTORY_PARSER });
    expect(c).toMatchObject({ domain: null, directoryRow: true });
    const sites = payload({ Company: 'Smith Electrical', Website: 'https://sites.google.com/view/smith' });
    expect(sites).toMatchObject({ domain: null, website: null });
    // The careers page keeps its path but is never a domain source.
    const careers = payload({
      Company: 'Smith Electrical',
      Careers: 'https://sites.google.com/view/smith/jobs',
    });
    expect(careers).toMatchObject({
      domain: null,
      website: null,
      careersUrl: 'https://sites.google.com/view/smith/jobs',
    });
  });

  it('a stored directory observation with a refused domain is no identity evidence either (pipeline defence)', () => {
    const p = { ...payload({ Company: 'Smith Plumbing' }), website: 'https://gmail.com/' };
    expect(candidateOf({ payload: p, parser: COMPANY_DIRECTORY_PARSER }).domain).toBeNull();
    // Other providers are untouched.
    expect(candidateOf({ payload: p, parser: { name: 'other', version: '1' } }).domain).toBe(
      'https://gmail.com/',
    );
  });
});

describe('M1 / re-verification #3 item 5: placeholders count as absent', () => {
  it.each([
    '-',
    '–',
    '—',
    'n/a',
    'N/A',
    'na',
    'n/k',
    'none',
    'Unknown',
    'TBC',
    'tba',
    '?',
    '.',
    '...',
    '- -',
    '***',
    '#N/A',
    '#VALUE!',
    '#REF!',
    '#DIV/0!',
    '#NAME?',
    '#NULL!',
    '#NUM!',
    'nan',
    'NaN',
    'null',
    'NULL',
    'undefined',
    'xx',
    'XXX',
    '0',
    '000',
    'not provided',
    'Not specified',
    'unspecified',
  ])('%j is a placeholder', (v) => {
    expect(isPlaceholder(v)).toBe(true);
  });

  it.each(['Leeds', 'St. Ives', 'Hay-on-Wye', 'X Corp', '3M', 'X'])('%j is a value', (v) => {
    expect(isPlaceholder(v)).toBe(false);
  });

  it.each(['x', 'X', 'various', 'Various', 'other', 'Other', 'L', '1', 'A1', '#N/A', 'nan', '000'])(
    'town %j is a placeholder (needs at least 2 letters)',
    (t) => {
      expect(isPlaceholderTown(t)).toBe(true);
    },
  );

  it.each(['Leeds', 'Ely', 'Hull', 'St Ives', 'Llanfair PG', 'Å'.repeat(2)])('town %j is a value', (t) => {
    expect(isPlaceholderTown(t)).toBe(false);
  });

  it('a placeholder town, domain or country is absent (not an error, not identity)', () => {
    for (const t of [
      '-',
      'n/a',
      'unknown',
      'tbc',
      '?',
      '.',
      '#N/A',
      'nan',
      'xxx',
      '0',
      'various',
      'other',
      'n/k',
    ])
      expect(payload({ Company: 'Smith Plumbing', Town: t }).locations).toEqual([
        { country: 'GB', kind: 'hq' },
      ]);
    expect(payload({ Domain: '-' })).toMatchObject({ domain: null });
    expect(payload({ Country: 'n/a' }).locations).toEqual([]);
  });

  it.each([
    // All zeros only, in any namespace.
    ['00000000', true],
    ['SC000000', true],
    ['00-0000000', true],
    ['000000000', true],
    ['R0000000', true],
    // Repeated or sequential digits can be real issued numbers (ruling d819f87): kept.
    ['11111111', false],
    ['99-9999999', false],
    ['12345678', false],
    ['87654321', false],
    ['123456789', false],
    ['00077777', false],
    ['00012345', false],
    ['01234567', false],
    ['SC012345', false],
    ['SC123456', false],
    ['00445790', false],
    ['552100554', false],
    ['Q95', false],
  ])('register id %s is a placeholder: %s', (id, placeholder) => {
    expect(isPlaceholderId(id)).toBe(placeholder);
  });

  it.each([
    ['CRN', '00000000'],
    ['CRN', 'SC000000'],
    ['EIN', '00-0000000'],
    ['DUNS', '000000000'],
    ['KvK', '00000000'],
  ])('an all-zero %s %s is absent, never identity', (column, id) => {
    const r = map({ [column]: id });
    expect('candidate' in r && r.candidate.payload.externalIds).toEqual([]);
    expect('candidate' in r && r.candidate.externalId).toBe('name:acme ltd|gb');
  });

  it.each([
    ['CRN', '12345678', 'gb_companies_house'],
    ['CRN', '11111111', 'gb_companies_house'],
    ['CRN', '00012345', 'gb_companies_house'],
    ['CRN', '01234567', 'gb_companies_house'],
    ['CRN', 'SC012345', 'gb_companies_house'],
    ['EIN', '12-3456789', 'us_ein'],
    ['DUNS', '123456789', 'duns'],
    ['KvK', '12345678', 'nl_kvk'],
  ])('a real-looking %s %s is kept as identity', (column, id, namespace) => {
    const r = map({ [column]: id });
    expect('candidate' in r && r.candidate.payload.externalIds).toEqual([{ namespace, id }]);
  });
});

describe('M3 (as reduced, DECISION_LOG 29b6592): a contact value only in a URL path, query or fragment is never stored', () => {
  it.each([
    [
      'Website',
      'https://smith-plumbing.co.uk/contact?email=jane%40smith-plumbing.co.uk',
      'https://smith-plumbing.co.uk/',
    ],
    ['Website', 'https://smith-plumbing.co.uk/#tel:+447700900123', 'https://smith-plumbing.co.uk/'],
    ['Website', 'https://smith-plumbing.co.uk/call/+44-7700-900123', 'https://smith-plumbing.co.uk/'],
    [
      'Careers',
      'https://smith-plumbing.co.uk/jobs?contact=jane.smith@gmail.com',
      'https://smith-plumbing.co.uk/jobs',
    ],
  ])('%s %j is stored as %s, nothing echoed', (column, value, stored) => {
    const r = map({ [column]: value });
    if (!('candidate' in r)) throw new Error('row refused');
    expect(column === 'Website' ? r.candidate.payload.website : r.candidate.payload.careersUrl).toBe(stored);
    const text = JSON.stringify(r);
    for (const fragment of ['jane', '7700', '7946', 'secret', 'gmail']) expect(text).not.toContain(fragment);
  });
});

describe('M3: contact values in any kept cell refuse the row; websites keep scheme + host', () => {
  it.each([
    ['Company', 'Smith Plumbing jane.smith@smith-plumbing.co.uk'],
    ['Company', 'Smith Plumbing 07700 900123'],
    ['Company', 'Smith Plumbing +44 7700 900123'],
    ['Legal name', 'J Smith (tel 020 7946 0958)'],
    ['Town', '07700900123'],
    ['Ref', 'jane@smith.co.uk'],
    ['Ref', '+44 20 7946 0958'],
    ['Careers', 'https://jane:secret@smith-plumbing.co.uk/jobs'],
    ['Domain', 'jane@smith-plumbing.co.uk'],
    ['Domain', 'mailto:jane@smith-plumbing.co.uk'],
    ['Careers', 'tel:+447700900123'],
  ])('%s %j → contact_value, nothing echoed', (column, value) => {
    const r = map({ [column]: value });
    expect(problemOf(r)).toMatchObject({ code: 'contact_value', column, line: 2 });
    const text = JSON.stringify(r);
    for (const fragment of ['jane', 'smith', '7700', '7946', 'secret', 'gmail'])
      expect(text).not.toContain(fragment);
  });

  it.each([
    'Acme 24-7 Ltd',
    '3M United Kingdom PLC',
    'Plumbers (2019) Ltd',
    'Unit 12, 34 High Street',
    'https://acme.com/jobs/1234567',
  ])('%j is no contact value', (v) => {
    expect(hasContactValue(v)).toBe(false);
  });

  it('the canonical website keeps scheme + host only; the careers URL keeps scheme + host + path', () => {
    expect(
      payload({
        Website: 'https://www.acme.co.uk/about/team?ref=newsletter#top',
        Careers: 'acme.co.uk/careers?x=1',
      }),
    ).toMatchObject({
      website: 'https://www.acme.co.uk/',
      careersUrl: 'https://acme.co.uk/careers', // query and fragment dropped
    });
  });
});

describe('M2: row errors carry codes, column names and row numbers only', () => {
  const CANARY = 'Zq7canary';
  it.each([
    [{ Company: '' }, 'missing_name'],
    [{ Company: 'ʹʹ' }, 'invalid_name'],
    [{ Domain: `${CANARY}.gmail.com` }, 'invalid_domain'],
    [{ Domain: `not a domain ${CANARY}` }, 'invalid_domain'],
    [{ Website: `ftp://${CANARY}.com/` }, 'invalid_website'],
    [{ Careers: `ftp://${CANARY}.com/jobs` }, 'invalid_careers_url'],
    [{ Country: `Atlantis${CANARY}` }, 'invalid_country'],
    [{ CRN: `${CANARY}` }, 'invalid_external_id'],
    [{ SIREN: '552100555' }, 'invalid_external_id'],
    [{ Company: `${CANARY} ${'x'.repeat(2100)}` }, 'value_too_long'],
    [{ Town: `${CANARY} jane@${CANARY}.com` }, 'contact_value'],
  ])('%j → %s with no cell text', (over, code) => {
    const r = map(over as Record<string, string>);
    expect(problemOf(r)).toMatchObject({ code, line: 2 });
    const text = JSON.stringify(r);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain('552100555');
    expect(text).not.toContain('Atlantis');
  });

  it('duplicate_row_key names the first row, not the key', () => {
    const header = Object.keys(row()).join(',');
    const line = (n: string) => Object.values(row({ Company: n, Ref: `${CANARY}-1` })).join(',');
    const plan = planDirectoryImport(
      config,
      `${header}\n${line('Acme Ltd')}\n${line('Acme Two Ltd')}\n`,
      'src_test',
    );
    expect(plan.errors).toEqual([
      {
        line: 3,
        code: 'duplicate_row_key',
        message: 'the same record as row 2 (the first occurrence is imported)',
      },
    ]);
  });

  it('malformed rows report the reader problem, never the row text', () => {
    const header = Object.keys(row()).join(',');
    const plan = planDirectoryImport(config, `${header}\n${CANARY}"x,1\nshort,${CANARY}\n`, 'src_test');
    expect(plan.errors.map((e) => e.code)).toEqual(['malformed_row', 'malformed_row']);
    expect(JSON.stringify(plan.errors)).not.toContain(CANARY);
  });
});

describe('M4: personal-data header guard', () => {
  it.each([
    // reviewer spellings and contract claims, any case and run together
    'Email',
    'E-mail',
    'e_mail',
    'EMAIL_ADDRESS',
    'emailaddress',
    'contactemail',
    'ContactEmail',
    'contact_email',
    'personal_email',
    'hr_email',
    'Emails',
    'Courriel',
    'Phone',
    'PhoneNumber',
    'phonenumber',
    'PHONENUMBER',
    'phone_number',
    'Phones',
    'Company phone',
    'Company Telephone',
    'Téléphone',
    'Telefon',
    'Telefonnummer',
    'Tel',
    'Tel.',
    'Tel1',
    'tel_no',
    'Mob',
    'Mobile',
    'mobile_phone',
    'MobileNo',
    'Cell',
    'Cell phone',
    'Fax',
    'WhatsApp',
    'Skype',
    'Instagram',
    'Facebook',
    'Twitter handle',
    'LinkedIn',
    'linkedin_url',
    'Linked In',
    'Contact',
    'Contacts',
    'ContactName',
    'Contact name',
    'Contact person',
    'director_name',
    'Directors',
    'Director',
    'Owner',
    'Owner name',
    'Proprietor',
    'Founder',
    'Co-founder',
    'CEO',
    'Managing Director',
    'Manager',
    'Partner',
    'Company secretary',
    'First name',
    'FirstName',
    'firstname',
    'Last name',
    'Surname',
    'Forename',
    'Full name',
    'Vorname',
    'Nachname',
    'Prénom',
    'date_of_birth',
    'DateOfBirth',
    'Birthday',
    'Geburtsdatum',
    'DOB',
    'D.O.B',
    'd/o/b',
    'Passport',
    'Passport no',
    'National Insurance',
    'NationalInsuranceNumber',
    'NI',
    'NI number',
    'NINO',
    'SSN',
    'Social security number',
    'Username',
    'IBAN',
    'Bank account',
    'Sort code',
    'Home address',
    'Gender',
    'Nationality',
    'Employee name',
  ])('%j is refused', (header) => {
    expect(isPersonalDataColumn(header)).toBe(true);
  });

  it.each([
    'Company',
    'Company name',
    'Name',
    'Legal name',
    'Trading name',
    'Website',
    'Web site',
    'Careers URL',
    'Careers page',
    'Domain',
    'Country',
    'Town',
    'City',
    'County',
    'Region',
    'Postcode',
    'Post code',
    'Zip',
    'Registered number',
    'Company number',
    'Registration number',
    'CRN',
    'LEI',
    'DUNS',
    'VAT number',
    'Sector',
    'Industry',
    'SIC code',
    'Employees',
    'Employee count',
    'Number of employees',
    'No. of employees',
    'Headcount',
    'Staff',
    'Founded',
    'Year founded',
    'Incorporation date',
    'Status',
    'Revenue',
    'Turnover',
    'Description',
    'Registered address',
    'Parent company',
    'Legal form',
    'Ref',
    'ID',
  ])('%j is an allowed company header', (header) => {
    expect(isPersonalDataColumn(header)).toBe(false);
  });
});

describe('L2: a header cell that holds a contact value is named by position', () => {
  it('a file without a header row does not echo its first row in the refusal', () => {
    const problems = checkDirectoryHeader(config, ['Jane Doe', 'jane.doe@smith.co.uk', '+44 7700 900123']);
    const text = JSON.stringify(problems);
    expect(text).not.toContain('jane.doe');
    expect(text).not.toContain('7700');
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'personal_data_column', column: 'column 2' }),
        expect.objectContaining({ code: 'personal_data_column', column: 'column 3' }),
      ]),
    );
  });
});

describe('L3: Companies House prefixed numbers', () => {
  it.each([
    ['SC204567', 'SC204567'],
    ['sc 204567', 'SC204567'],
    ['NI604215', 'NI604215'],
    ['OC301234', 'OC301234'],
    ['SO305678', 'SO305678'],
    ['NC000456', 'NC000456'],
    ['LP012345', 'LP012345'],
    ['SL004321', 'SL004321'],
    ['SE000012', 'SE000012'],
    ['FC023456', 'FC023456'],
    ['GE000123', 'GE000123'],
    ['R0604215', 'R0604215'],
    ['OC1234', 'OC001234'],
    ['445790', '00445790'],
  ])('%s → %s', (raw, id) => {
    expect(normalizeExternalId('gb_companies_house', raw)).toEqual({ id });
  });

  it.each(['ZZ123456', 'R1604215', 'SC1234567', 'S1234567'])('%s is not a company number', (raw) => {
    expect(normalizeExternalId('gb_companies_house', raw)).toEqual({ error: 'invalid_format' });
  });
});
