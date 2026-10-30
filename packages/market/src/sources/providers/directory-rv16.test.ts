import { describe, expect, it } from 'vitest';
import { mapDirectoryRow, parseDirectoryConfig, planDirectoryImport } from './company-directory';
import { canonicalText, contactValueVerdict } from './directory-values';

/** PR #27 re-verification #16 (DECISION_LOG 64d97b4: one canonical form; skeletons). */

const config = parseDirectoryConfig({
  columns: {
    name: 'Company',
    legalName: 'Legal',
    domain: 'Domain',
    website: 'Website',
    town: 'Town',
    country: 'Country',
    careersUrl: 'Careers',
    id: 'Ref',
  },
});
const map = (over: Record<string, string>) =>
  mapDirectoryRow(
    config,
    {
      Company: 'Acme Widgets Ltd',
      Legal: '',
      Domain: '',
      Website: '',
      Town: '',
      Country: 'GB',
      Careers: '',
      Ref: '',
      ...over,
    },
    2,
  );
const kept = (over: Record<string, string>) => {
  const r = map(over);
  if ('error' in r) throw new Error(`row refused: ${r.error.code}`);
  return r;
};
/** Refused as a name, dropped as a legal name and a town. */
const refusedEverywhere = (v: string) => {
  const name = map({ Company: v });
  const legal = kept({ Legal: v });
  const town = kept({ Town: v });
  return (
    'error' in name &&
    name.error.code === 'contact_value' &&
    legal.candidate.payload.legalName === 'Acme Widgets Ltd' &&
    legal.warnings.some((w) => w.column === 'Legal' && w.code === 'contact_value') &&
    town.warnings.some((w) => w.column === 'Town' && w.code === 'contact_value')
  );
};

describe('HIGH-1: text cells are canonicalised; the canonical form is checked, stored and keyed', () => {
  it.each([
    'Acme Ltd jane&shy;at gmail dot com',
    'jane&zwsp;at gmail.com',
    'jane&zwnj;at acme dot co dot uk',
    'Acme jane at gmail dot&zwsp;com',
    'Acme jane&ZeroWidthSpace;at gmail dot com',
    'Acme jane a&#x200b;t gmail dot com',
    'Acme jane a%E2%80%8Bt gmail dot com',
    'Acme jane a⁠t gmail dot com',
  ])('%j is refused as a name and dropped as a legal name and town', (v) => {
    expect(refusedEverywhere(v)).toBe(true);
  });

  // Generated: every invisible entity or code point, glued into the at-word, before it, after it,
  // or inside the dot word — none is stored.
  const GLUES = ['&shy;', '&zwsp;', '&zwj;', '&zwnj;', '&NoBreak;', '&#173;', '&#x200B;', '%C2%AD', '%E2%81%A0', '­', '​', '‌', '‍', '⁠', '⁢', '﻿', '͏', '᠎', '\u{e0020}']; // prettier-ignore
  const PLACES = [
    (g: string) => `Acme jane a${g}t gmail dot com`,
    (g: string) => `Acme jane${g}at gmail dot com`,
    (g: string) => `Acme jane at${g}gmail dot com`,
    (g: string) => `Acme jane at gmail d${g}ot com`,
    (g: string) => `Acme jane at gmail dot${g}com`,
  ];
  const glued = GLUES.flatMap((g) => PLACES.map((place) => place(g)));
  it(`generated: ${glued.length} entity- or ignorable-glued addresses are refused everywhere`, () => {
    expect(glued.filter((v) => !refusedEverywhere(v))).toEqual([]);
  });

  it('the canonical form is what is stored, with a value_normalised warning naming only the column', () => {
    const r = kept({
      Company: 'Marks &amp; Spencer​ plc',
      Legal: 'Ｍａｒｋｓ ＆ Spencer plc',
      Town: 'Lon­don',
    });
    expect(r.candidate.payload.name).toBe('Marks & Spencer plc');
    expect(r.candidate.payload.legalName).toBe('Marks & Spencer plc');
    expect(r.candidate.payload.locations).toEqual([{ country: 'GB', city: 'Lon don', kind: 'hq' }]);
    expect(r.warnings.map((w) => [w.column, w.code]).sort()).toEqual([
      ['Company', 'value_normalised'],
      ['Legal', 'value_normalised'],
      ['Town', 'value_normalised'],
    ]);
    expect(JSON.stringify(r.warnings)).not.toMatch(/Marks|Spencer|Lon/);
  });

  it('a cell dropped after canonicalisation is reported as dropped, not normalised', () => {
    const r = kept({ Town: 'Leeds ２' });
    expect(r.warnings.map((w) => w.code)).toEqual(['invalid_town']);
  });

  it('record and name keys come from the canonical form: written forms of one name share a key', () => {
    const key = (name: string) => kept({ Company: name }).candidate.externalId;
    expect(key('Marks &amp; Spencer plc')).toBe(key('Marks & Spencer plc'));
    expect(key('Ｍａｒｋｓ ＆ Spencer plc')).toBe(key('Marks & Spencer plc'));
    // File ids too.
    const ref = (id: string) => kept({ Ref: id }).candidate.externalId;
    expect(ref('R&#45;1')).toBe(ref('R-1'));
  });

  it('the same file maps to the same keys every time (idempotent)', () => {
    const csv = [
      'Company,Legal,Domain,Website,Town,Country,Careers,Ref',
      'Marks &amp; Spencer plc,,,,Lon­don,GB,,',
      'Ｆｕｌｌ Ｗｉｄｔｈ Ltd,,acme.co.uk,,,GB,,R&#45;7',
      'Café Müller GmbH,,,,,DE,,',
    ].join('\n');
    const keys = () => planDirectoryImport(config, csv, 'src_rv16').candidates.map((c) => c.externalId);
    expect(keys()).toEqual(keys());
    expect(keys()).toHaveLength(3);
  });

  it('canonicalisation is idempotent (a fixed point, NFKC spelling a new entity included)', () => {
    const samples = [
      '＆#64;',
      '&amp;#64;',
      'Marks &amp;amp; Spencer',
      'a­b​c',
      'Ｆｕｌｌ　Ｗｉｄｔｈ',
      '%2526%2340%3B',
      '  a \t b  ',
      'ﬁnance ﬂow',
      'x&#x0000200b;y',
    ];
    for (const v of samples) expect([v, canonicalText(canonicalText(v)!)]).toEqual([v, canonicalText(v)]);
  });
});

describe('MEDIUM-2: fillers and accented at-forms (the skeleton)', () => {
  it.each([
    'Acme Ltd jane a\u{16fe4}t gmail dot com',
    'Acme Ltd jane a\u{1d159}t gmail dot com',
    'Acme Ltd jane àt gmail dot com',
    'Acme Ltd jane át gmail dot com',
    'Acme Ltd jane át gmail dot com',
    'Acme Ltd jane at gmail dòt com',
    // An accent and symbol separators: only the ruled skeleton (symbols as spaces) reads it.
    'Acme Ltd jane★àt★gmail dot com',
  ])('%j is refused everywhere', (v) => {
    expect(refusedEverywhere(v)).toBe(true);
  });

  it.each([
    'https://jane·a\u{16fe4}t·gmail·com.acme.com/',
    'https://jane-àt-gmail-dot-com.acme.com/',
    'https://jane-át-gmail-dot-com.acme.com/',
    'https://jane-a\u{1d159}t-gmail-dot-com.acme.com/',
  ])('%s is stored in no URL cell', (u) => {
    const r = kept({ Website: u, Careers: u });
    expect([r.candidate.payload.website, r.candidate.payload.careersUrl]).toEqual([null, null]);
  });

  // Generated: every combining mark of a sample and every filler, on or inside the at-word.
  const MARKS = ['̀', '́', '̂', '̃', '̈', '̊', '̧', 'ͅ', '⃐', '︠', '\u{16fe4}', '\u{1d167}'];
  const FILLERS = ['\u{1d159}', '⠀', 'ㅤ', 'ᅟ', 'ﾠ'];
  const members = [
    ...MARKS.flatMap((m) => [
      `Acme jane a${m}t gmail dot com`,
      `Acme jane at${m} gmail dot com`,
      `Acme jane at gmail d${m}ot com`,
    ]),
    ...FILLERS.flatMap((f) => [`Acme jane a${f}t gmail dot com`, `Acme jane at gmail d${f}ot com`]),
  ];
  it(`generated: ${members.length} marked or filled at-forms are refused everywhere`, () => {
    expect(members.filter((v) => !refusedEverywhere(v))).toEqual([]);
  });

  it('the detector itself reads the ruled skeleton (no name keys): an accent between symbol separators', () => {
    // Symbols become spaces (the glued skeleton would join `jane★at★gmail`).
    expect(contactValueVerdict('jane★àt★gmail dot com')).toBe('contact');
    expect(contactValueVerdict('jane✦a\u0301t✦acme dot co dot uk')).toBe('contact');
  });

  it('accented names stay kept (the skeleton adds readings, it stores nothing)', () => {
    for (const n of [
      'Café Müller GmbH',
      'Crème Brûlée à Paris SARL',
      'Ångström Åtvidaberg AB',
      'Łódź Ślusarz Sp. z o.o.',
    ])
      expect([n, kept({ Company: n }).candidate.payload.name]).toEqual([n, n]);
  });
});

describe('HIGH-2: handle exemptions are 29b6592 (3), v-versions and an acronym before a legal form', () => {
  it.each([
    'Acme Ltd skype TOM.LEE',
    'Acme Ltd skype JOE.DOE',
    'ACME LTD SKYPE BOB.KIM',
    'Acme Telegram AL.B',
    'Acme skype Nr.Five',
    'Acme skype TOM.LEE Ltd',
    // The acronym exemption never applies after a platform word (DECISION_LOG d232db7).
    'Slack E.ON SE',
  ])('%j is refused', (v) => {
    expect(map({ Company: v })).toMatchObject({ error: { code: 'contact_value' } });
  });

  it.each(['Signal v2.0', 'Signal No.1 Ltd', 'Telegram St.Petersburg OOO', 'Signal Co.Ltd', 'Signal e.V.'])(
    '%j is kept',
    (v) => {
      expect(kept({ Company: v }).candidate.payload.name).toBe(v);
    },
  );
});

describe('MEDIUM-1: a Country cell is short', () => {
  it('more than 64 characters is invalid_country before any lookup, and costs almost nothing', () => {
    const shape = ` .${'́ͅ'.repeat(994)}`;
    const t = performance.now();
    const r = kept({ Country: shape });
    expect(performance.now() - t).toBeLessThan(20);
    expect(r.warnings).toEqual([expect.objectContaining({ column: 'Country', code: 'invalid_country' })]);
    expect(
      kept({ Country: 'The United Kingdom of Great Britain and Northern Ireland, Europe!!' }).warnings[0],
    ).toMatchObject({
      code: 'invalid_country',
    });
    expect(kept({ Country: 'United Kingdom' }).candidate.payload.locations[0]).toMatchObject({
      country: 'GB',
    });
  });
});

describe('MEDIUM-3: a Domain cell is a bare host; shared hosts are never identity', () => {
  it.each([
    'google.com//maps/place',
    'google.com/%6Daps',
    'google.com/&#x6d;aps',
    'https://www.google.com/maps/place/Acme+Ltd',
    'https://www.acme.co.uk/about',
    'acme.co.uk?x=1',
    'acme.co.uk#top',
    'acme.co.uk\\careers',
  ])('Domain %j is invalid_domain', (d) => {
    const r = kept({ Domain: d });
    expect(r.candidate.payload.domain).toBeNull();
    expect(r.warnings[0]).toMatchObject({ column: 'Domain', code: 'invalid_domain' });
  });

  it.each(['acme.co.uk', 'https://acme.co.uk/', 'HTTP://WWW.ACME.CO.UK', 'www.acme.co.uk/'])(
    'Domain %j is kept',
    (d) => {
      expect(kept({ Domain: d }).candidate.payload.domain).toBe('acme.co.uk');
    },
  );

  const SHARED = [
    'maps.google.com', 'translate.google.co.uk', 'business.google.com', 'maps.apple.com', 'bing.com', 'www.bing.com',
    'duckduckgo.com', 'openstreetmap.org', 'www.openstreetmap.org', 'web.archive.org', 'archive.org',
    'webcache.googleusercontent.com', 'googleusercontent.com', 'share.google', 'g.co', 'goo.gl', 'linkedin.com',
  ]; // prettier-ignore
  it.each(SHARED)('shared host %s is never domain identity (Domain, Website)', (h) => {
    const r = kept({ Domain: h, Website: `https://${h}/` });
    expect([r.candidate.payload.domain, r.candidate.payload.website]).toEqual([null, null]);
  });

  it.each([
    'https://www.google.com/url?q=https://acme.co.uk',
    'https://www.google.com/amp/s/acme.co.uk',
    'https://www.google.co.uk/search?q=acme',
    'https://web.archive.org/web/2020/https://acme.co.uk/',
  ])('Website %s is no website', (w) => {
    const r = kept({ Website: w });
    expect(r.candidate.payload.website).toBeNull();
  });
});

describe('LOW-2: the derived website passes the Website rules', () => {
  it('at-home.co.uk is kept as a Domain, with no website (as a Website cell of it is dropped)', () => {
    const r = kept({ Domain: 'at-home.co.uk' });
    expect(r.candidate.payload.domain).toBe('at-home.co.uk');
    expect(r.candidate.payload.website).toBeNull();
    expect(kept({ Website: 'https://at-home.co.uk/' }).candidate.payload.website).toBeNull();
  });

  it('a plain domain derives its website', () => {
    expect(kept({ Domain: 'acme.co.uk' }).candidate.payload.website).toBe('https://acme.co.uk/');
  });
});
