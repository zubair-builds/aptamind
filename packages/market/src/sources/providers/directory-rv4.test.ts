import { describe, expect, it } from 'vitest';
import { looseNameKey, strictNameKey } from '../../companies/normalize';
import {
  type CompanyLookup,
  type CompanySummary,
  resolveCompanyCandidate,
} from '../../resolution/company-resolver';
import {
  isPersonalDataColumn,
  mapDirectoryRow,
  parseDirectoryConfig,
  planDirectoryImport,
} from './company-directory';
import { directoryDomain, hasContactValue } from './directory-values';

/** The row's problem: its error, else its first dropped-cell warning (re-verification #6). */
const problemOf = (r: ReturnType<typeof mapDirectoryRow>) => ('error' in r ? r.error : r.warnings[0]);

/** DECISION_LOG "Directory rows auto-match only without contradicting evidence" (PR #27 re-verification #4). */

type Row = CompanySummary & { keys: string[] };
function company(
  id: string,
  name: string,
  extra: Partial<CompanySummary> & { keys?: string[]; legal?: string } = {},
): Row {
  const names = [name, ...(extra.legal ? [extra.legal] : [])];
  return {
    id,
    displayName: name,
    names,
    aliases: extra.aliases ?? [],
    externalIds: extra.externalIds ?? [],
    strictKeys: names.map(strictNameKey),
    looseKey: looseNameKey(extra.legal ?? name),
    domain: extra.domain ?? null,
    hqCountry: extra.hqCountry ?? null,
    registeredTowns: extra.registeredTowns ?? [],
    keys: [
      ...names.map((n) => `name:${strictNameKey(n)}`),
      ...(extra.aliases ?? []).map((n) => `name:${strictNameKey(n)}`),
      ...(extra.domain ? [`domain:${extra.domain}`] : []),
      ...(extra.externalIds ?? []).map((e) => `ext:${e.namespace}:${e.id}`),
      ...(extra.keys ?? []),
    ],
  };
}
const lookupOf = (companies: Row[]): CompanyLookup => ({
  byIdentityKey: async (k) => companies.find((c) => c.keys.includes(k)) ?? null,
  byStrictName: async (k) => companies.filter((c) => c.keys.includes(`name:${k}`)),
  byLooseKey: async (k) => companies.filter((c) => c.looseKey === k),
  byFirstToken: async () => [],
});
const crn = (id: string) => [{ namespace: 'gb_companies_house', id }];

const kite = company('cmp_kite', 'Kite Ltd', { externalIds: crn('04821937'), hqCountry: 'GB' });
const heron = company('cmp_heron', 'Heron Tools Ltd', { externalIds: crn('03817265'), hqCountry: 'GB' });
const acmeRobotics = company('cmp_acme_inc', 'Acme Robotics Inc', {
  domain: 'acme-robotics.com',
  hqCountry: 'US',
});
const smith = company('cmp_smith', 'Smith Plumbing Ltd', {
  domain: 'smithplumbing.co.uk',
  registeredTowns: ['Leeds'],
  hqCountry: 'GB',
});
const tesco = company('cmp_tesco', 'Tesco', {
  legal: 'Tesco Stores Limited',
  externalIds: crn('00519500'),
  hqCountry: 'GB',
});
const aliased = company('cmp_zenith', 'Zenith Robotics Ltd', {
  aliases: ['ZR Automation'],
  domain: 'zenith-robotics.co.uk',
  externalIds: crn('05555123'),
});
const l = lookupOf([kite, heron, acmeRobotics, smith, tesco, aliased]);
const dir = (c: Parameters<typeof resolveCompanyCandidate>[0]) =>
  resolveCompanyCandidate({ ...c, directoryRow: true }, l);

describe('1 (H1): a different id in a single-valued register namespace refuses every match method', () => {
  it('Kite Ltd / KITE LIMITED with another company number → high review (name_exact refused)', async () => {
    expect(await dir({ name: 'KITE LIMITED', country: 'GB', externalIds: crn('09123456') })).toMatchObject({
      kind: 'review',
      severity: 'high',
      candidates: [{ id: 'cmp_kite', method: 'name_exact' }],
    });
    // The same number matches.
    expect(await dir({ name: 'KITE LIMITED', country: 'GB', externalIds: crn('04821937') })).toMatchObject({
      kind: 'match',
      companyId: 'cmp_kite',
    });
  });

  it('Heron Tools (brand) with another company number → high review (brand match refused)', async () => {
    expect(await dir({ name: 'Heron Tools', country: 'GB', externalIds: crn('07000123') })).toMatchObject({
      kind: 'review',
      severity: 'high',
    });
  });

  it('a domain hit with another company number → high review', async () => {
    expect(
      await dir({
        name: 'Zenith Robotics Ltd',
        domain: 'zenith-robotics.co.uk',
        externalIds: crn('06666321'),
      }),
    ).toMatchObject({ kind: 'review', severity: 'high' });
  });

  it('outside a directory the evidence chain is unchanged', async () => {
    expect(
      await resolveCompanyCandidate({ name: 'KITE LIMITED', country: 'GB', externalIds: crn('09123456') }, l),
    ).toMatchObject({ kind: 'match', companyId: 'cmp_kite' });
  });

  it('in one file, the same name and country with different ids → every such row goes to review', () => {
    const config = parseDirectoryConfig({
      columns: { name: 'Company', country: 'Country', registerIds: { gb_companies_house: 'CRN' } },
    });
    const plan = planDirectoryImport(
      config,
      'Company,Country,CRN\nAcme Widgets Ltd,GB,04821937\nACME WIDGETS LIMITED,GB,09123456\nAcme Widgets Ltd,DE,07000123\nOther Ltd,GB,03817265\n',
      'src_test',
    );
    expect(plan.errors).toEqual([]);
    expect(plan.candidates.map((c) => [c.payload.name, c.review ?? null])).toEqual([
      ['Acme Widgets Ltd', 'conflicting_ids_in_file'],
      ['ACME WIDGETS LIMITED', 'conflicting_ids_in_file'],
      ['Acme Widgets Ltd', null], // another country
      ['Other Ltd', null],
    ]);
  });

  it('a forced review is high severity and keeps the candidates the evidence found', async () => {
    expect(
      await dir({
        name: 'Kite Ltd',
        externalIds: crn('04821937'),
        forceReview: 'rows of this file disagree',
      }),
    ).toMatchObject({
      kind: 'review',
      severity: 'high',
      reason: 'rows of this file disagree',
      candidates: [{ id: 'cmp_kite' }],
    });
  });
});

describe('2 (M1): a town or country never lifts bare status', () => {
  it.each(['UK', 'Nationwide', 'Remote', 'Leeds'])('John Smith, town %s → review', async (town) => {
    expect(await dir({ name: 'John Smith', town, country: 'GB' })).toMatchObject({ kind: 'review' });
  });

  it('a legal form alone does not either; a register id or a domain does', async () => {
    expect(await dir({ name: 'Quantum Bakery Ltd', country: 'GB' })).toMatchObject({ kind: 'review' });
    expect(
      await dir({ name: 'Quantum Bakery Ltd', country: 'GB', externalIds: crn('08888123') }),
    ).toMatchObject({
      kind: 'create',
    });
    expect(await dir({ name: 'Quantum Bakery Ltd', domain: 'quantum-bakery.co.uk' })).toMatchObject({
      kind: 'create',
    });
  });
});

describe('3 (M2): countries must agree; a brand match must not contradict the town', () => {
  it('Acme Robotics Ltd GB vs Acme Robotics Inc US on a shared domain → review', async () => {
    expect(
      await dir({ name: 'Acme Robotics Ltd', country: 'GB', domain: 'acme-robotics.com' }),
    ).toMatchObject({
      kind: 'review',
      reason: expect.stringMatching(/country GB/),
    });
    expect(await dir({ name: 'Acme Robotics Inc', domain: 'acme-robotics.com' })).toMatchObject({
      kind: 'match',
    }); // unknown country
  });

  it('Smith Plumbing, Bristol vs Smith Plumbing Ltd, Leeds (loose key only) → review', async () => {
    expect(
      await dir({ name: 'Smith Plumbing', town: 'Bristol', domain: 'smithplumbing.co.uk' }),
    ).toMatchObject({
      kind: 'review',
      reason: expect.stringMatching(/town Bristol/),
    });
    expect(await dir({ name: 'Smith Plumbing', town: 'Leeds', domain: 'smithplumbing.co.uk' })).toMatchObject(
      { kind: 'match' },
    );
    // A strict (legal-name) match is not held back by the town.
    expect(
      await dir({ name: 'Smith Plumbing Ltd', town: 'Bristol', domain: 'smithplumbing.co.uk' }),
    ).toMatchObject({
      kind: 'match',
    });
  });
});

describe('4 (M3): ownership uses the row’s legal name as well as its name', () => {
  it('Tesco / Tesco Stores Limited + CRN → match', async () => {
    expect(
      await dir({
        name: 'Tesco',
        legalName: 'Tesco Stores Limited',
        country: 'GB',
        externalIds: crn('00519500'),
      }),
    ).toMatchObject({ kind: 'match', companyId: 'cmp_tesco', method: 'external_id' });
    // Neither name owned → review.
    expect(await dir({ name: 'Tesco Bank', country: 'GB', externalIds: crn('00519500') })).toMatchObject({
      kind: 'review',
    });
  });
});

describe('5 (L3): an alias-only hit is a review', () => {
  it('a row named like an alias of the company, on its domain → review', async () => {
    expect(await dir({ name: 'ZR Automation', domain: 'zenith-robotics.co.uk' })).toMatchObject({
      kind: 'review',
      reason: expect.stringMatching(/only an alias/),
    });
    expect(await dir({ name: 'ZR Automation', externalIds: crn('05555123') })).toMatchObject({
      kind: 'review',
    });
  });
});

const config = parseDirectoryConfig({
  columns: {
    name: 'Company',
    legalName: 'Legal name',
    domain: 'Domain',
    website: 'Website',
    town: 'Town',
    careersUrl: 'Careers',
  },
});
const map = (over: Record<string, string>) =>
  mapDirectoryRow(
    config,
    { Company: 'Acme Ltd', 'Legal name': '', Domain: '', Website: '', Town: '', Careers: '', ...over },
    2,
  );

describe('6 (M4): contact-link hosts, phone-shaped path segments, more link hosts', () => {
  it.each([
    ['Website', 'https://wa.me/447700900123'],
    ['Website', 'https://api.whatsapp.com/send?phone=447700900123'],
    ['Careers', 'https://t.me/acmejobs'],
    ['Careers', 'https://m.me/acme'],
    ['Website', 'https://signal.me/#p/+447700900123'],
    ['Domain', 'wa.me'],
    ['Careers', 'https://acme.co.uk/call/07700900123'],
    ['Careers', 'https://acme.co.uk/call/447700900123'],
    ['Careers', 'https://acme.co.uk/c/00447700900123'],
  ])('%s %s → contact_value', (column, value) => {
    expect(problemOf(map({ [column]: value }))).toMatchObject({ code: 'contact_value', column });
  });

  it.each(['https://acme.co.uk/jobs/12345678', 'https://acme.co.uk/jobs/2024'])(
    '%s is no contact value',
    (v) => {
      expect(map({ Careers: v })).toMatchObject({ candidate: {} });
    },
  );

  it.each([
    'https://www.google.com/search?q=acme',
    'https://www.google.co.uk/search?q=acme',
    'https://lnkd.in/abc',
    'https://youtu.be/xyz',
    'https://uk.trustpilot.com/review/acme.co.uk',
    'https://apply.workable.com/acme/',
  ])('%s is not a company domain', (v) => {
    expect(directoryDomain(v)).toEqual({ refused: 'shared_hosting' });
  });
});

describe('7 and 8 (M5, L1): header guard', () => {
  it.each([
    'Chair',
    'Chairman',
    'Chairperson',
    'Chairwoman',
    'President',
    'MD',
    'Recruiter',
    'Principal',
    'Decision maker',
    'DecisionMaker',
    'Head of HR',
    'Head of',
    'Hiring lead',
    'Hiring manager',
    'Talent lead',
    'Salutation',
    'Attn',
    'FAO',
    'Care of',
    'RegAddress.CareOf',
    'Sole trader name',
    'Ethnicity',
    'Religion',
    'Age',
    'Sex',
    'Gender',
    'Voornaam',
    'Achternaam',
    'Cognome',
    'Apellido',
    'Nazwisko',
    'Contatto',
    'TelNo',
    'Tel1',
    'Telnr',
    'Mobnumber',
    'Faxnummer',
    'Cellnumber',
    'Mailname',
    'DOB',
    'CEOname',
    'Contact person',
    'ContactPerson',
    'contact_name',
    'Key contact',
    'Contact',
  ])('%j is refused', (h) => {
    expect(isPersonalDataColumn(h)).toBe(true);
  });

  it.each([
    'Hotel',
    'Telecoms sector',
    'Television rights',
    'Cellular network',
    'Faxless',
    'Percentage',
    'Mortgage count',
    'Agency',
    'Mailing address',
    'Contact page',
    'Contact page URL',
    'Number of directors',
    'Director count',
    'Number of Founders',
    'No. of officers',
    'Number of Associated Contacts',
    'Headcount growth',
    'Employee headcount',
    'Employees (UK)',
    'Employee Range',
    'Number of employees (2023)',
    'Installation date',
    'Wheelchair supplier',
    'Mortgages.NumMortCharges',
  ])('%j is allowed', (h) => {
    expect(isPersonalDataColumn(h)).toBe(false);
  });
});

describe('9 (L2): contact values', () => {
  it.each([
    ['jane at smith dot co dot uk', {}],
    ['Jane AT Smith DOT com', {}],
    ['jane (at) smith . co . uk', {}],
    ['jane [at] smith [dot] co [dot] uk', {}],
    ['Leeds 123456', { town: true }],
    ['LS1 4DT 123456', { town: true }],
    // An address before a legal-form TLD is an address (no exemption, DECISION_LOG 621f14c).
    ['Tea at Polka dot Ltd', {}],
  ])('%j is a contact value', (v, opts) => {
    expect(hasContactValue(v, opts)).toBe(true);
  });

  it.each([
    ['Coffee at Home Ltd', {}],
    // Below the ruled 9-digit bar (DECISION_LOG 621f14c): documented residuals.
    ['Smith 020 7946', { digitRuns: true }],
    ['Smith 7946-0958', { digitRuns: true }],
    ['Smith 1 234 567 Ltd', { digitRuns: true }],
    ['Leeds 12345', { town: true }],
    ['Plumbers (2019) Ltd', { digitRuns: true }],
    ['Acme 24-7 Ltd', { digitRuns: true }],
    ['1234567 Ltd', { digitRuns: true }], // an unseparated 7-digit run (a company number in the name)
    ['Route 66 Diner', { digitRuns: true }],
  ])('%j is no contact value', (v, opts) => {
    expect(hasContactValue(v, opts)).toBe(false);
  });
});
