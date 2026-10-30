import { describe, expect, it } from 'vitest';
import { idsContradict, normalizeObservationExternalIds } from '../../companies/external-ids';
import { looseNameKey, strictNameKey } from '../../companies/normalize';
import {
  type CompanyLookup,
  type CompanySummary,
  resolveCompanyCandidate,
} from '../../resolution/company-resolver';
import { conflictingIdNamespaces } from '../../reconciliation/company-reconciler';
import {
  directoryConfigWarnings,
  fileIdKey,
  isPersonalDataColumn,
  mapDirectoryRow,
  NO_IDENTITY_COLUMN_WARNING,
  parseDirectoryConfig,
  planDirectoryImport,
} from './company-directory';
import { hasContactValue, urlHasContactValue } from './directory-values';

/** The row's problem: its error, else its first dropped-cell warning (re-verification #6). */
const problemOf = (r: ReturnType<typeof mapDirectoryRow>) => ('error' in r ? r.error : r.warnings[0]);

/** DECISION_LOG "Directory import privacy and concurrency, structural" (PR #27 re-verification #5). */

describe('1: header guard additions (defence in depth: every column must be mapped anyway)', () => {
  it.each([
    'CTO',
    'CFO',
    'COO',
    'CMO',
    'CHRO',
    'VP',
    'VP Sales',
    'Chief executive',
    'Legal representative',
    'Représentant légal',
    'Trustee',
    'Trustees',
    'Treasurer',
    'PSC',
    'PSC name',
    'POC',
    'Primary POC',
    'Sales rep',
    'Account exec',
    'Team lead',
    'Board member',
    'Nominee',
    'Registered agent',
    'National ID',
    'ID number',
    'BSN',
    'PESEL',
    'Codice fiscale',
    'NIF',
    'DNI',
    'CPF',
    'Aadhaar',
    'PAN',
    'SIN',
    'Tax file number',
    'Steuer-ID',
    'GSM',
    'Natel',
    'Celular',
    'Cellulare',
    'Mobil',
    'Mobilnummer',
    'Mobiel',
    'Telefoon',
    'Telefoonnummer',
    'Puhelin',
    'Sähköposti',
    'E-post',
    'Epost',
    'Mailadresse',
    'Date de naissance',
    'Fecha de nacimiento',
    'Geboortedatum',
    'Private address',
    'Wohnadresse',
    'Adresse personnelle',
    'Handle',
    'X handle',
    'GitHub',
    'Xing',
    'Discord',
    'Slack',
    'Directeur',
    'Directeur général',
    'Directrice',
    'PDG',
    'Eigentümer',
    'Propriétaire',
    'Bestuurder',
    'Vorstand',
    'Spouse',
    'Headhunter',
    'Applicant',
    'Candidate',
    'Attendee',
    'Interviewer',
  ])('%j is refused', (h) => {
    expect(isPersonalDataColumn(h)).toBe(true);
  });

  it.each([
    'Principal activity',
    'Principal activities',
    'Principal place of business',
    'Company age',
    'Age (years)',
    'Owner type',
    'Partner type',
    'Channel partner',
    'Contact us URL',
    'Personalisation',
    'Personalization',
    'Company ID number',
  ])('%j is allowed (over-refusal fixed)', (h) => {
    expect(isPersonalDataColumn(h)).toBe(false);
  });

  it('ignoreColumns is gone from the configuration', () => {
    expect(() => parseDirectoryConfig({ columns: { name: 'Company' }, ignoreColumns: [] })).toThrow();
  });
});

const NAME_VECTORS = [
  // the reviewer's H-1 table ("NAME not refused") and "also not detected"
  'Acme Ltd 020–7946–0958',
  'Acme Ltd 020_7946_0958',
  'Acme Ltd 020·7946·0958',
  'Acme Ltd 020,7946,0958',
  'Acme Ltd 020•7946•0958',
  'Acme Ltd 020 7946 0958',
  'Acme Ltd 020 7946 0958',
  'jane at acme.com',
  'Jane Smith (jane at acmewidgets.co.uk)',
  'jane(a)acme.com',
  'jane#acme.com',
  'jane_at_acme_dot_com',
  'jane @ acme',
  'jane@acme',
  'Acme +44 20 7946 0958',
  'Acme ☎ 07700900123',
  'Acme 07700 900123',
  'Acme ０７７００９００１２３',
  'Acme 7700 900123',
  'Acme Ltd - call 079460958',
  'Acme 0 7 7 0 0 9 0 0 1 2 3',
  'Acme 0-7-7-0-0-9-0-0-1-2-3',
  'Acme o77oo9oo123',
  'Acme ⁰⁷⁷⁰⁰⁹⁰⁰¹²³',
  'Acme 𝟎𝟕𝟕𝟎𝟎𝟗𝟎𝟎𝟏𝟐𝟑',
  'Acme ٠٧٧٠٠٩٠٠١٢٣',
  'Acme ۰۷۷۰۰۹۰۰۱۲۳',
  'Acme ०७७००९००१२३',
  'Acme jane．smith＠gmail．com',
  'Acme jane@gmail。com',
  'Acme jane﹫gmail.com',
  'Acme jane.smith@gmail,com',
  'Acme j a n e @ g m a i l . c o m',
  'Acme Ltd, jane dot smith at gmail dot com',
  'Acme skype jane.smith',
  'Acme wa.me/447700900123',
  'Acme t.me/janesmith',
  '@janesmith',
  'Acme Ltd @janesmith',
];

describe('2: contact detection is structural', () => {
  it.each(NAME_VECTORS)('name / legal name / town %j is a contact value', (v) => {
    expect(hasContactValue(v, { digitRuns: true, handles: true })).toBe(true);
  });

  it.each([
    'https://acme.com/call/02079460958',
    'https://acme.com/call/020–7946–0958',
    'https://acme.com/c/7700900123',
    'https://acme.com/c/447700900123',
    'https://acme.com/c/+447700900123',
    'https://acme.com/c/%2B447700900123',
    'https://acme.com/c/00447700900123',
    'https://acme.com/p/jane.smith@gmail.com',
    'https://acme.com/p/jane.smith%40gmail.com',
    'https://acme.com/p/jane.smith(at)gmail.com',
    'https://acme.com/p/jane.smith%28at%29gmail.com',
    'https://acme.com/p/jane-at-gmail-dot-com',
    'https://acme.com/?c=jane at gmail dot com',
    'https://acme.com/?c=jane+at+gmail+dot+com',
    'https://acme.com/#tel=07700900123',
    'https://acme.com/team/jane-smith',
    'https://wa.me/447700900123',
    'https://WA.ME/447700900123',
    'https://www.wa.me/447700900123',
    'https://wa.link/abc',
    'https://whatsapp.com/send?phone=447700900123',
    'https://web.whatsapp.com/send?phone=447700900123',
    'https://api.whatsapp.com/send?phone=447700900123',
    'https://telegram.dog/janesmith',
    'https://t.me/janesmith',
    'https://calendly.com/jane-smith',
    'https://zoom.us/j/1234567890',
    'https://acme.com/vcard/jane.vcf',
    'https://acme.com;jane@gmail.com',
    'https://jane@gmail.com',
    'https://acme.com\\@gmail.com',
    'https://acme.com/wa/447700900123',
    'https://acme.com/viber/447700900123',
    'https://acme.com/sms:07700900123',
    'https://acme.com/c/07700-900123',
    'https://acme.com/c/0770 0900 123',
    'https://acme.com/c/(0)7700900123',
    'https://acme.com/c/44-7700-900123',
    'https://acme.com/jobs/%25%32%30%37700900123',
  ])('URL %s is a contact value', (v) => {
    expect(urlHasContactValue(v)).toBe(true);
  });

  it.each([
    'Acme Ltd',
    'Acme 24-7 Ltd',
    '3M United Kingdom PLC',
    'Plumbers (2019) Ltd',
    'Coffee (at) Home Ltd',
    'Acme Ltd (tel 7946 0958)', // 8 digits: below the ruled bar (documented residual)
    'Route 66 Diner',
    'Unit 12, 34 High Street Ltd',
    'Meet at Noon Ltd',
    'Loose Ltd',
    'Oil & Gas Ltd',
    'Polo 1001 Ltd',
    'Studio 54',
    'Skype Technologies Ltd',
  ])('%j is no contact value', (v) => {
    expect(hasContactValue(v, { digitRuns: true })).toBe(false);
  });

  it.each([
    'https://acme.co.uk/jobs',
    'https://careers.acme.co.uk/uk/engineering',
    'https://acme.co.uk/jobs/12345678',
  ])('URL %s is no contact value', (v) => {
    expect(urlHasContactValue(v)).toBe(false);
  });

  const config = parseDirectoryConfig({ columns: { name: 'Company', town: 'Town', country: 'Country' } });
  it.each(['Leeds 2', 'LS1 4DT', 'Leeds ٢', 'Leeds ２'])('town %j holds digits → invalid_town', (town) => {
    expect(
      problemOf(mapDirectoryRow(config, { Company: 'Acme Ltd', Town: town, Country: 'GB' }, 2)),
    ).toMatchObject({ code: 'invalid_town', column: 'Town' });
  });
});

describe('3: the file’s own id is never stored raw', () => {
  it('the record key is a 128-bit SHA-256 of source + normalised value', () => {
    expect(fileIdKey('src_a', 'R-1')).toMatch(/^id:[0-9a-f]{32}$/);
    expect(fileIdKey('src_a', ' R-1 ')).toBe(fileIdKey('src_a', 'R-1'));
    // Not case-folded (re-verification #6): R-1 and r-1 are different ids.
    expect(fileIdKey('src_a', 'r-1')).not.toBe(fileIdKey('src_a', 'R-1'));
    expect(fileIdKey('src_b', 'R-1')).not.toBe(fileIdKey('src_a', 'R-1'));
  });

  it('in-file duplicates are still detected on the hash, and the raw id appears nowhere in the plan', () => {
    const config = parseDirectoryConfig({ columns: { name: 'Company', id: 'Ref', country: 'Country' } });
    const plan = planDirectoryImport(
      config,
      'Company,Ref,Country\nAcme Ltd,ZQREF-02079460958,GB\nBeta Ltd,ZQREF-02079460958 ,GB\n',
      'src_a',
    );
    expect(plan.errors.map((e) => [e.line, e.code])).toEqual([[3, 'duplicate_row_key']]);
    expect(JSON.stringify(plan).toLowerCase()).not.toContain('zqref');
  });
});

type Row = CompanySummary & { keys: string[] };
function company(id: string, name: string, extra: Partial<CompanySummary> = {}): Row {
  return {
    id,
    displayName: name,
    names: [name],
    aliases: [],
    externalIds: extra.externalIds ?? [],
    strictKeys: [strictNameKey(name)],
    looseKey: looseNameKey(name),
    domain: extra.domain ?? null,
    hqCountry: extra.hqCountry ?? null,
    registeredTowns: [],
    keys: [
      `name:${strictNameKey(name)}`,
      ...(extra.externalIds ?? []).map((e) => `ext:${e.namespace}:${e.id}`),
    ],
  };
}
const lookupOf = (companies: Row[]): CompanyLookup => ({
  byIdentityKey: async (k) => companies.find((c) => c.keys.includes(k)) ?? null,
  byStrictName: async (k) => companies.filter((c) => c.keys.includes(`name:${k}`)),
  byLooseKey: async (k) => companies.filter((c) => c.looseKey === k),
  byFirstToken: async () => [],
});

describe('5: register ids that found nothing never attach by name to a company with ids only elsewhere', () => {
  const foxtrot = company('cmp_foxtrot', 'Foxtrot Widgets Ltd', {
    externalIds: [{ namespace: 'lei', id: '5493001KJTIIGC8Y1R12' }],
    hqCountry: 'GB',
  });
  it('Foxtrot Widgets with a CRN vs a LEI-only company → low review', async () => {
    expect(
      await resolveCompanyCandidate(
        {
          name: 'Foxtrot Widgets Ltd',
          country: 'GB',
          externalIds: [{ namespace: 'gb_companies_house', id: '04821937' }],
          directoryRow: true,
        },
        lookupOf([foxtrot]),
      ),
    ).toMatchObject({ kind: 'review', severity: 'low', candidates: [{ id: 'cmp_foxtrot' }] });
  });
});

describe('6: bare-row review dedupe keys include country and legal name', () => {
  it('India Tools GB and India Tools IE are two review items', async () => {
    const l = lookupOf([]);
    const gb = await resolveCompanyCandidate({ name: 'India Tools', country: 'GB', directoryRow: true }, l);
    const ie = await resolveCompanyCandidate({ name: 'India Tools', country: 'IE', directoryRow: true }, l);
    const legal = await resolveCompanyCandidate(
      { name: 'India Tools', legalName: 'India Tools Holdings Ltd', country: 'GB', directoryRow: true },
      l,
    );
    expect([gb.kind, ie.kind, legal.kind]).toEqual(['review', 'review', 'review']);
    const keys = [gb, ie, legal].map((d) => (d.kind === 'review' ? d.dedupeKey : ''));
    expect(new Set(keys).size).toBe(3);
  });
});

describe('8: multi-valued namespaces are declared', () => {
  it('duns never contradicts; Companies House BR numbers coexist only with BR and FC numbers (re-verification #6)', () => {
    const ch = (id: string) => ({ namespace: 'gb_companies_house', id });
    expect(
      idsContradict({ namespace: 'duns', id: '150483782' }, { namespace: 'duns', id: '150483783' }),
    ).toBe(false);
    expect(idsContradict(ch('BR012345'), ch('BR012346'))).toBe(false);
    expect(idsContradict(ch('BR012345'), ch('FC023456'))).toBe(false);
    expect(idsContradict(ch('BR001234'), ch('04811111'))).toBe(true);
    expect(idsContradict(ch('BR001234'), ch('SC204567'))).toBe(true);
    expect(idsContradict(ch('FC023456'), ch('FC023457'))).toBe(true);
    expect(idsContradict(ch('FC023456'), ch('04811111'))).toBe(true);
    expect(idsContradict(ch('04811111'), ch('04811112'))).toBe(true);
    expect(idsContradict(ch('04811111'), ch('04811111'))).toBe(false);
    expect(
      idsContradict(
        { namespace: 'lei', id: '5493001KJTIIGC8Y1R12' },
        { namespace: 'lei', id: '5299FOXTROTWIDGET082' },
      ),
    ).toBe(true);
    expect(
      idsContradict(
        { namespace: 'uk_sponsor_register', id: 'a|x' },
        { namespace: 'uk_sponsor_register', id: 'b|y' },
      ),
    ).toBe(false);
  });

  it('the reconciler and the gate only contradict single-valued ids', async () => {
    expect(
      conflictingIdNamespaces([
        { namespace: 'duns', id: '150483782' },
        { namespace: 'duns', id: '150483783' },
        { namespace: 'gb_companies_house', id: 'BR012345' },
        { namespace: 'gb_companies_house', id: 'BR012346' },
        { namespace: 'gb_companies_house', id: 'FC023456' },
      ]),
    ).toEqual(new Map());
    expect(
      conflictingIdNamespaces([
        { namespace: 'gb_companies_house', id: 'FC023456' },
        { namespace: 'gb_companies_house', id: 'FC023457' },
      ]),
    ).toEqual(new Map([['gb_companies_house', ['FC023456', 'FC023457']]]));
    const withDuns = company('cmp_d', 'Delta Ltd', {
      externalIds: [
        { namespace: 'duns', id: '150483782' },
        { namespace: 'gb_companies_house', id: '04821937' },
      ],
    });
    expect(
      await resolveCompanyCandidate(
        {
          name: 'Delta Ltd',
          externalIds: [
            { namespace: 'duns', id: '150483783' },
            { namespace: 'gb_companies_house', id: '04821937' },
          ],
          directoryRow: true,
        },
        lookupOf([withDuns]),
      ),
    ).toMatchObject({ kind: 'match', companyId: 'cmp_d' });
  });
});

describe('9: a file with neither Domain nor a register id warns that every row goes to review', () => {
  it('plan and upload warnings', () => {
    const bare = parseDirectoryConfig({ columns: { name: 'Company', country: 'Country' } });
    expect(directoryConfigWarnings(bare)).toContain(NO_IDENTITY_COLUMN_WARNING);
    expect(planDirectoryImport(bare, 'Company,Country\nAcme Ltd,GB\n', 'src_a').warnings).toContain(
      NO_IDENTITY_COLUMN_WARNING,
    );
    const withId = parseDirectoryConfig({ columns: { name: 'Company', registerIds: { lei: 'LEI' } } });
    expect(directoryConfigWarnings(withId)).not.toContain(NO_IDENTITY_COLUMN_WARNING);
  });
});

describe('10: known registry namespaces are normalised for every provider', () => {
  it('445790 and 00445790 are one Companies House number; unknown or invalid ids are kept as given', () => {
    expect(
      normalizeObservationExternalIds([
        { namespace: 'gb_companies_house', id: '445790' },
        { namespace: 'uk_sponsor_register', id: 'Acme Ltd|London' },
        { namespace: 'lei', id: 'not-an-lei' },
      ]),
    ).toEqual([
      { namespace: 'gb_companies_house', id: '00445790' },
      { namespace: 'uk_sponsor_register', id: 'Acme Ltd|London' },
      { namespace: 'lei', id: 'not-an-lei' },
    ]);
  });
});
