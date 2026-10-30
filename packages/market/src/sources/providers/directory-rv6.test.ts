import { describe, expect, it } from 'vitest';
import { candidateFromPayload } from '../../companies/company-pipeline';
import { externalIdsOf } from '../../companies/company.service';
import { looseNameKey, strictNameKey } from '../../companies/normalize';
import { conflictingIdNamespaces } from '../../reconciliation/company-reconciler';
import {
  type CompanyLookup,
  type CompanySummary,
  resolveCompanyCandidate,
} from '../../resolution/company-resolver';
import { isPersonalDataColumn, mapDirectoryRow, parseDirectoryConfig } from './company-directory';
import { decodeEscapes, hasContactValue } from './directory-values';

/** DECISION_LOG "Directory import: residual bar and drop-vs-refuse" (PR #27 re-verification #6). */

describe('1 (H-A): the standard email notations are caught', () => {
  it.each([
    'jane [at] acme dot com',
    'jane (at) acme dot com',
    'jane (at) acme dot co dot uk',
    'jane.smith (at) gmail dot com',
    'jane {at} acme dot com',
    'jane <at> acme <dot> com',
    'jane at acme[.]com',
    'jane at acme(.)com',
    'jane (at) acme . com',
    'jane (at) acme(dot)com',
    'jane.smith(at)gmail(dot)com',
    'Jane at acme . com',
    'jane at acme .com',
    'jane AT acme DOT com',
    'Contact jane AT acme DOT co DOT uk',
    'jane at bücher.de',
    'jane at xn--bcher-kva.de',
    'jane at acme.london',
    'jane at acme-mail.co.uk',
    'jane·at·acme.com',
    'jane.at.acme.com',
    'jane/at/acme.com',
    'jane+at+acme.com',
    'jane_at_acme_dot_com',
    'jane-at-gmail-dot-com',
    'jane arroba acme.com',
    'jane%40acme.com',
    'jane&#64;acme.com',
    'jane &#64; acme.com',
    'jane&#x40;acme.com',
    'jane&commat;acme.com',
    'jane%2540acme.com',
    'jane&amp;#64;acme.com',
    'qqleak [at] acme dot com',
    'jane @acme',
    'jane[@]acme',
    'Jane Smith, jane.smith@acme',
    'jane at wa.me',
    'wa.me/447700900123',
    'wa.me 447700900123',
    't.me jane_smith',
    'telegram: @jane',
    'Jane Smith linkedin.com/in/janesmith',
    'mailto jane at acme',
  ])('%j is a contact value', (v) => {
    expect(hasContactValue(v, { digitRuns: true })).toBe(true);
  });

  it.each([
    // Documented residuals (DECISION_LOG b24e5dd: deliberate obfuscation beyond the standard notations)
    'jane.smith gmail.com', // no at token
    'jane dot smith gmail', // no at token, no TLD
    'Jane Smith <jane.smith AT acme>', // no TLD
    'jane at gmail', // no TLD
    'jane ⓐ acme.com', // homoglyph
    'Jane O77OO 9OO 123', // letter-split digits
    'Jane 07700 nine 00123', // number words
  ])('documented residual %j is not detected', (v) => {
    expect(hasContactValue(v, { digitRuns: true })).toBe(false);
  });

  it.each(['Coffee (at) Home Ltd', 'Meet at Noon Ltd', 'Acme GmbH (acme.at)', 'Studio 54 Ltd'])(
    '%j is a name',
    (v) => {
      expect(hasContactValue(v, { digitRuns: true })).toBe(false);
    },
  );

  it('documented over-refusal: a name like "Eat at Joe.com" or "Tea at Polka dot Ltd" reads as an address', () => {
    expect(hasContactValue('Eat at Joe.com', { digitRuns: true })).toBe(true);
    expect(hasContactValue('Tea at Polka dot Ltd', { digitRuns: true })).toBe(true);
  });

  it('decodes HTML entities and percent-escapes until stable', () => {
    expect(decodeEscapes('jane&#64;acme.com')).toBe('jane@acme.com');
    expect(decodeEscapes('jane&#x40;acme.com')).toBe('jane@acme.com');
    expect(decodeEscapes('jane&commat;acme.com')).toBe('jane@acme.com');
    expect(decodeEscapes('jane&amp;commat;acme.com')).toBe('jane@acme.com');
    expect(decodeEscapes('jane%2540acme.com')).toBe('jane@acme.com');
    expect(decodeEscapes('Smith &amp; Sons')).toBe('Smith & Sons');
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
    domain: null,
    hqCountry: extra.hqCountry ?? null,
    registeredTowns: [],
    keys: [
      `name:${strictNameKey(name)}`,
      ...(extra.externalIds ?? []).map((e) => `ext:${e.namespace}:${e.id}`),
    ],
  };
}
const lookupOf = (companies: Row[], opts: { noStrict?: boolean } = {}): CompanyLookup => ({
  byIdentityKey: async (k) => companies.find((c) => c.keys.includes(k)) ?? null,
  byStrictName: async (k) => (opts.noStrict ? [] : companies.filter((c) => c.keys.includes(`name:${k}`))),
  byLooseKey: async (k) => companies.filter((c) => c.looseKey === k),
  byFirstToken: async () => [],
});
const ch = (id: string) => [{ namespace: 'gb_companies_house', id }];

describe('2 (H-B): a BR number beside any non-FC company number is a contradiction', () => {
  const zulu = company('cmp_zulu', 'Zulu Holdings Ltd', { externalIds: ch('BR001234'), hqCountry: 'GB' });
  it('Zulu Holdings BR001234 vs 04811111 → high review, never a match', async () => {
    expect(
      await resolveCompanyCandidate(
        { name: 'Zulu Holdings Ltd', country: 'GB', externalIds: ch('04811111'), directoryRow: true },
        lookupOf([zulu]),
      ),
    ).toMatchObject({ kind: 'review', severity: 'high' });
    // Another BR number, or the FC number, coexists.
    const fc = company('cmp_zulu_fc', 'Zulu Holdings Ltd', { externalIds: ch('FC023456'), hqCountry: 'GB' });
    expect(
      await resolveCompanyCandidate(
        { name: 'Zulu Holdings Ltd', country: 'GB', externalIds: ch('BR001235'), directoryRow: true },
        lookupOf([fc]),
      ),
    ).toMatchObject({ kind: 'match', companyId: 'cmp_zulu_fc' });
  });

  it('the reconciler records BR + company number as a conflict; BR + BR + FC is fine', () => {
    expect(conflictingIdNamespaces([...ch('BR001234'), ...ch('04811111')])).toEqual(
      new Map([['gb_companies_house', ['04811111', 'BR001234']]]),
    );
    expect(conflictingIdNamespaces([...ch('BR001234'), ...ch('BR001235'), ...ch('FC023456')])).toEqual(
      new Map(),
    );
    expect(
      conflictingIdNamespaces([
        { namespace: 'duns', id: '150483782' },
        { namespace: 'duns', id: '150483783' },
      ]),
    ).toEqual(new Map());
  });
});

const config = parseDirectoryConfig({
  columns: {
    name: 'Company',
    legalName: 'Legal',
    domain: 'Domain',
    website: 'Website',
    town: 'Town',
    country: 'Country',
    careersUrl: 'Careers',
    registerIds: { duns: 'DUNS', us_ein: 'EIN', gb_companies_house: 'CRN' },
  },
});
const row = (over: Record<string, string>) => ({
  Company: 'Acme Widgets Ltd',
  Legal: '',
  Domain: '',
  Website: '',
  Town: '',
  Country: 'GB',
  Careers: '',
  DUNS: '',
  EIN: '',
  CRN: '',
  ...over,
});
const kept = (over: Record<string, string>) => {
  const r = mapDirectoryRow(config, row(over), 2);
  if ('error' in r) throw new Error(`row refused: ${r.error.code}`);
  return r;
};

describe('3 (M-E): a problem in an optional cell drops the cell and keeps the row', () => {
  it.each(['Dublin 2', 'Paris 8e', 'London EC1'])('town %j is dropped, the row kept', (town) => {
    const r = kept({ Town: town });
    expect(r.candidate.payload.locations).toEqual([{ country: 'GB', kind: 'hq' }]);
    expect(r.warnings).toEqual([expect.objectContaining({ line: 2, code: 'invalid_town', column: 'Town' })]);
    expect(JSON.stringify(r)).not.toContain(town);
  });

  it.each([
    [{ Legal: 'J Smith 020 7946 0958 Ltd' }, 'Legal', 'contact_value', '7946'],
    [{ Domain: 'gmail.com' }, 'Domain', 'invalid_domain', 'gmail'],
    [{ Domain: 'jane@acme.co.uk' }, 'Domain', 'contact_value', 'jane'],
    [{ Website: 'https://acme.co.uk/team/jane-smith' }, 'Website', 'contact_value', 'jane'],
    [
      { Careers: 'https://boards.greenhouse.io/acme/jobs/4012345678' },
      'Careers',
      'contact_value',
      '4012345678',
    ],
    [{ Careers: 'ftp://acme.co.uk/jobs' }, 'Careers', 'invalid_careers_url', 'ftp'],
    [{ Country: 'Atlantis' }, 'Country', 'invalid_country', 'Atlantis'],
    [{ CRN: 'jane@acme.co.uk' }, 'CRN', 'contact_value', 'jane'],
    [{ CRN: 'ABC' }, 'CRN', 'invalid_external_id', 'ABC'],
  ])('%j → dropped (%s, %s), nothing stored', (over, column, code, marker) => {
    const r = kept(over as Record<string, string>);
    expect(r.warnings).toEqual([expect.objectContaining({ code, column })]);
    expect(JSON.stringify(r)).not.toContain(marker);
  });

  it('bare status uses only the kept cells: a dropped Domain is no identity', () => {
    expect(kept({ Domain: 'gmail.com' }).candidate.payload.domain).toBeNull();
  });

  it('a problem in the name cell still refuses the row', () => {
    expect(mapDirectoryRow(config, row({ Company: 'Acme 020 7946 0958' }), 2)).toMatchObject({
      error: { code: 'contact_value', column: 'Company' },
    });
  });

  it('register ids are normalised first: DUNS 01-234-5678 and EIN 01-2345678 are ids, not phones', () => {
    expect(kept({ DUNS: '01-234-5678' }).candidate.payload.externalIds).toEqual([
      { namespace: 'duns', id: '012345678' },
    ]);
    expect(kept({ EIN: '01-2345678' }).candidate.payload.externalIds).toEqual([
      { namespace: 'us_ein', id: '01-2345678' },
    ]);
  });

  it('numbered-company names (rv7 H2: no exemption): a phone-shaped digit run refuses the row', () => {
    for (const name of ['004 085 616 Pty Ltd', 'ACN 004 085 616 Pty Ltd', '123 456 789 Pty Ltd'])
      expect(mapDirectoryRow(config, row({ Company: name }), 2)).toMatchObject({
        error: { code: 'contact_value' },
      });
    // Eight digits are below the ruled bar (DECISION_LOG 621f14c): the Quebec name is kept.
    expect(kept({ Company: '9123-4567 Québec Inc.' }).warnings).toEqual([]);
  });

  it('careers URLs: a LinkedIn organisation page with a numeric id is kept', () => {
    expect(
      kept({ Careers: 'https://www.linkedin.com/company/104567890/jobs/' }).candidate.payload.careersUrl,
    ).toBe('https://www.linkedin.com/company/104567890/jobs/');
  });
});

describe('4 (M-D): careers URLs on social or profile hosts are dropped unless an organisation or jobs page', () => {
  it.each([
    'https://www.linkedin.com/in/jane-smith/',
    'https://uk.linkedin.com/pub/jane-smith/1/2/3',
    'https://www.facebook.com/acme/jobs',
    'https://twitter.com/acmejobs',
    'https://x.com/acmejobs',
    'https://www.instagram.com/acme',
    'https://github.com/jane-smith',
    'https://about.me/jane',
    'https://linktr.ee/acme',
    'https://jane.medium.com/hiring',
  ])('%s is dropped', (careers) => {
    const r = kept({ Careers: careers });
    expect(r.candidate.payload.careersUrl).toBeNull();
    expect(r.warnings).toEqual([
      expect.objectContaining({
        code: expect.stringMatching(/profile_url|contact_value/),
        column: 'Careers',
      }),
    ]);
  });

  it.each(['https://www.linkedin.com/company/acme/jobs/', 'https://www.linkedin.com/jobs/search/?f_C=123'])(
    '%s is kept',
    (careers) => {
      expect(kept({ Careers: careers }).candidate.payload.careersUrl).not.toBeNull();
    },
  );
});

describe('5 (M-A, rv7 H3): the ext-key backstop holds regardless of reconciliation', () => {
  it('reads ext: keys whether or not the company was reconciled', () => {
    const base = {
      identityKeys: ['ext:gb_companies_house:04711001'],
      identity: { externalIds: [{ namespace: 'gb_companies_house', id: '09711002' }] },
    } as unknown as Parameters<typeof externalIdsOf>[0];
    expect(
      externalIdsOf(base)
        .map((e) => e.id)
        .sort(),
    ).toEqual(['04711001', '09711002']);
    expect(
      externalIdsOf({ ...base, reconciliation: { contentHash: 'x' } } as never)
        .map((e) => e.id)
        .sort(),
    ).toEqual(['04711001', '09711002']);
  });
});

describe('8: Lows', () => {
  it.each(['Principal office city', 'Company LinkedIn URL', 'Owner company'])(
    '%j is an allowed header',
    (h) => {
      expect(isPersonalDataColumn(h)).toBe(false);
    },
  );
  it.each(['Partner name', 'Applicant name'])('%j stays refused', (h) => {
    expect(isPersonalDataColumn(h)).toBe(true);
  });

  it('the seeded HQ country is only an HQ or registered-office country', () => {
    const p = (locations: Array<{ country: string; kind: 'hq' | 'registered' | 'office' | 'job' }>) =>
      candidateFromPayload({
        name: 'Acme Ltd',
        aliases: [],
        externalIds: [],
        locations,
        industries: [],
        sponsorLicence: { register: 'uk', country: 'GB', route: 'Skilled Worker' },
      } as never);
    expect(p([{ country: 'DE', kind: 'office' }]).hqCountry).toBeNull();
    expect(p([]).hqCountry).toBeNull(); // never the licence country
    expect(p([{ country: 'IE', kind: 'registered' }]).hqCountry).toBe('IE');
    expect(
      p([
        { country: 'DE', kind: 'office' },
        { country: 'FR', kind: 'hq' },
      ]).hqCountry,
    ).toBe('FR');
  });

  it('identical names found only by the loose key say so (no "different legal form")', async () => {
    const acme = company('cmp_a', 'Acme Widgets Ltd');
    const d = await resolveCompanyCandidate(
      { name: 'Acme Widgets Ltd' },
      lookupOf([acme], { noStrict: true }),
    );
    expect(d).toMatchObject({
      kind: 'review',
      reason: expect.stringMatching(/^Same name as Acme Widgets Ltd/),
    });
  });
});
