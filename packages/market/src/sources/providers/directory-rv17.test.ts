import { BSON } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { mapDirectoryRow, parseDirectoryConfig } from './company-directory';
import { CANONICAL_MAX_ROUNDS, canonicalText, contactValueVerdict, decodeEscapes } from './directory-values';

/** PR #27 re-verification #17 (DECISION_LOG d232db7: the canonical form is a true, bounded fixed point). */

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
    registerIds: { lei: 'LEI' },
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
      LEI: '',
      ...over,
    },
    2,
  );
const kept = (over: Record<string, string>) => {
  const r = map(over);
  if ('error' in r) throw new Error(`row refused: ${r.error.code}`);
  return r;
};
const refusedEverywhere = (v: string) => {
  const name = map({ Company: v });
  const legal = kept({ Legal: v });
  const town = kept({ Town: v });
  return (
    'error' in name &&
    name.error.code === 'contact_value' &&
    legal.candidate.payload.legalName === 'Acme Widgets Ltd' &&
    legal.warnings.some((w) => w.column === 'Legal') &&
    town.warnings.some((w) => w.column === 'Town')
  );
};
/** What BSON (the Mongo driver) stores for a string. */
const bsonStored = (v: string) => (BSON.deserialize(BSON.serialize({ v })) as { v: string }).v;
function lcg(seed: number) {
  let s = seed;
  return () => (s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x80000000;
}
const nest = (entity: string, depth: number) => {
  let v = entity;
  for (let k = 0; k < depth; k++) v = v.replace(/^&/, '&amp;');
  return v;
};

describe('HIGH-1: lone surrogates are made well-formed before any check (what is checked is what BSON stores)', () => {
  it.each([
    'Acme jane a&#xD800;t gmail dot com',
    'Acme jane a&#55296;t gmail dot com',
    'Acme jane a&#xDFFF;t gmail dot com',
    'Acme jane at gmail d&#xD800;ot com',
    'Acme jane a&#x0000DBFF;t gmail dot com',
    'Acme jane a\ud800t gmail dot com',
  ])('%j is refused everywhere', (v) => {
    expect(refusedEverywhere(v)).toBe(true);
  });

  it('a surrogate entity decodes to U+FFFD itself (never a lone surrogate)', () => {
    for (const e of ['&#xD800;', '&#55296;', '&#xDFFF;', '&#x0000dbff;'])
      expect([e, decodeEscapes(`a${e}b`)]).toEqual([e, 'a\ufffdb']);
  });

  // Generated: surrogate entities, escapes and code units across the range, in and around the
  // at-word and the dot word.
  const SURROGATES = [0xd800, 0xd801, 0xdabc, 0xdbff, 0xdc00, 0xdd00, 0xdfff];
  const forms = (cp: number) => [
    `&#x${cp.toString(16)};`,
    `&#${cp};`,
    `&#x000${cp.toString(16).toUpperCase()};`,
    String.fromCharCode(cp),
  ];
  const surrogateMembers = SURROGATES.flatMap((cp) =>
    forms(cp).flatMap((f) => [
      `Acme jane a${f}t gmail dot com`,
      `Acme jane at gmail d${f}ot com`,
      `Acme jane${f}at gmail dot com`,
    ]),
  );
  it(`generated: ${surrogateMembers.length} surrogate-glued addresses are refused everywhere`, () => {
    expect(surrogateMembers.filter((v) => !refusedEverywhere(v))).toEqual([]);
  });

  it('every stored text value is byte-for-byte what BSON stores, and is its own canonical form', () => {
    const rnd = lcg(20260930 + 17);
    const UNITS = [
      'a',
      'Z',
      ' ',
      '&#xD800;',
      '&#56320;',
      '\ud800',
      '\udfff',
      '&amp;',
      '&#64;',
      '&shy;',
      'é',
      '́',
      'ﬁ',
      '＆',
      '%41',
      '&#x1F600;',
      '😀',
      'ß',
      '.',
    ];
    const inputs = Array.from({ length: 400 }, () => {
      let v = 'Acme ';
      for (let n = 3 + Math.floor(rnd() * 12); n > 0; n--) v += UNITS[Math.floor(rnd() * UNITS.length)];
      return v;
    });
    const problems: string[] = [];
    for (const v of inputs) {
      const r = map({ Company: v, Legal: v, Town: v });
      if ('error' in r) continue;
      const p = r.candidate.payload;
      for (const stored of [p.name, p.legalName, ...p.locations.map((l) => l.city ?? '')].filter(Boolean)) {
        if (bsonStored(stored!) !== stored)
          problems.push(`${JSON.stringify(v)}: BSON changes ${JSON.stringify(stored)}`);
        if (canonicalText(stored!) !== stored) problems.push(`${JSON.stringify(v)}: not canonical`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('HIGH-2: the canonical form is a true fixed point, bounded', () => {
  it.each(['&#64;', '&commat;'])('a 30-deep &amp; nest of %s is decoded to the end and refused', (e) => {
    const v = `Acme jane${nest(e, 30)}gmail.com`;
    expect(map({ Company: v })).toMatchObject({ error: { code: 'contact_value' } });
    expect(kept({ Legal: v }).warnings[0]).toMatchObject({ column: 'Legal', code: 'contact_value' });
  });

  it.each(['&#64;', '&zwsp;', '&period;', '&commat;', '&percnt;', '&shy;'])(
    'whatever a deep nest of %s gives, the stored value is its own canonical form and no contact value',
    (e) => {
      for (const depth of [1, 5, 25, 30, 60, 100]) {
        for (const v of [
          `Acme jane${nest(e, depth)}gmail.com`,
          `Acme jane a${nest(e, depth)}t gmail dot com`,
        ]) {
          const r = map({ Company: v });
          if ('error' in r) continue;
          const stored = r.candidate.payload.name;
          expect([v, canonicalText(stored)]).toEqual([v, stored]);
          expect([v, contactValueVerdict(stored)]).toEqual([v, 'none']);
        }
      }
    },
  );

  it(`a value that does not converge within ${CANONICAL_MAX_ROUNDS} rounds is undecidable: a name is refused, a legal name dropped`, () => {
    const v = `Acme jane${nest('&#64;', 400)}gmail.com`;
    expect(v.length).toBeLessThan(2000);
    expect(canonicalText(v)).toBeNull();
    expect(map({ Company: v })).toMatchObject({ error: { code: 'contact_value_undecidable' } });
    expect(kept({ Legal: v }).warnings[0]).toMatchObject({ column: 'Legal', code: 'contact_value' });
  });

  it('idempotency: canonicalText(canonicalText(x)) === canonicalText(x) over seeded inputs', () => {
    const rnd = lcg(1717);
    const UNITS = [
      '&',
      'amp;',
      '#',
      'x',
      '4',
      '0',
      '6',
      ';',
      '%',
      '2',
      '5',
      'shy',
      'zwsp',
      'a',
      ' ',
      '＆',
      '％',
      '＃',
      '​',
      '\ud800',
      'ﬁ',
      'ﷺ',
      '　',
    ];
    const bad: string[] = [];
    for (let k = 0; k < 3000; k++) {
      let v = '';
      for (let n = 1 + Math.floor(rnd() * 40); n > 0; n--) v += UNITS[Math.floor(rnd() * UNITS.length)];
      const c = canonicalText(v);
      if (c !== null && canonicalText(c) !== c) bad.push(v);
    }
    expect(bad).toEqual([]);
  });
});

describe('HIGH-3: every token after a platform word is examined', () => {
  it.each([
    'Acme skype - jane.doe',
    'Acme skype=jane.doe',
    'Acme skype=TOM.LEE',
    'Acme skype ID jane.doe',
    'Acme skype id: jane.doe',
    'Acme skype name jane.doe',
    'Acme skype handle TOM.LEE',
    'Acme skype(jane.doe)',
    'Acme skype/jane.doe',
    'Acme skype.jane.doe',
    'Acme skype | jane.doe',
    'Acme skype jane·doe',
    'Acme skype jane•doe',
    'Acme skype TOM·LEE',
    'Acme skype J.DOE Ltd',
    'Acme skype TOM.L Ltd',
    'Acme skype A.TOM Inc',
    'Acme skype TOM.LEE.X Ltd',
    'Acme Slack E.ON SE',
    'Acme telegram contact me jane.doe',
  ])('%j is refused', (v) => {
    expect(map({ Company: v })).toMatchObject({ error: { code: 'contact_value' } });
  });

  // Generated: platform words × separators and label words × handle shapes.
  const PLATFORMS = [
    'skype',
    'Skype',
    'SKYPE',
    'telegram',
    'whatsapp',
    'signal',
    'viber',
    'discord',
    'wechat',
    'slack',
    'snapchat',
    'instagram',
  ];
  const GAPS = [
    ' ',
    ' - ',
    '-',
    '_',
    '.',
    '=',
    ' = ',
    ':',
    ': ',
    '(',
    '[',
    '/',
    ' | ',
    '·',
    ' ID ',
    ' id: ',
    ' name ',
    ' handle ',
    ' user ',
    ' username ',
    ' account ',
    ' Name: ',
    ' ID - ',
  ];
  const HANDLES = [
    'jane.doe',
    'TOM.LEE',
    'jane·doe',
    'jane•doe',
    'jane_doe',
    'jane#1234',
    'j.doe99',
    'TOM.LEE.X',
  ];
  const members = PLATFORMS.flatMap((p) => GAPS.flatMap((g) => HANDLES.map((h) => `Acme ${p}${g}${h}`)));
  it(`generated: ${members.length} platform × separator × handle cells are refused`, () => {
    expect(
      members.filter((v) => {
        const r = map({ Company: v });
        return !('error' in r);
      }),
    ).toEqual([]);
  });

  it.each([
    'Signal v2.0',
    'Signal No.1 Ltd',
    'Telegram St.Petersburg OOO',
    'Signal Co.Ltd',
    'Signal e.V.',
    'Viber S.à r.l.',
    'Signal 88 LLC',
    'Insta 360 Ltd',
    'Signal U.S.A. Inc.',
    'Discord Inc.',
    'Slack Technologies LLC',
    'Signal Hill Capital Group Ltd',
  ])('%j is kept', (v) => {
    expect(kept({ Company: v }).candidate.payload.name).toBe(v);
  });
});

describe('MEDIUM-1: the length limit holds for the canonical form (NFKC expands)', () => {
  const FDFA = 'ﷺ'.repeat(1990);
  it.each([
    ['Legal', 'invalid_name'],
    ['Town', 'invalid_town'],
    ['Country', 'invalid_country'],
    ['LEI', 'invalid_external_id'],
    ['Domain', 'invalid_domain'],
    ['Website', 'invalid_website'],
    ['Careers', 'invalid_careers_url'],
    ['Ref', 'value_too_long'],
  ])('%s of 1990 × U+FDFA is %s, cheaply', (column, code) => {
    const t = performance.now();
    const r = kept({ [column]: FDFA });
    expect(performance.now() - t).toBeLessThan(30);
    expect(r.warnings[0]).toMatchObject({ column, code });
  });

  it('a URL whose NFKC form is over the limit is dropped, not reduced to its origin', () => {
    const u = `https://acme.co.uk/${'\ufdfa'.repeat(120)}`; // 139 characters, 2 179 under NFKC
    const r = kept({ Website: u, Careers: u });
    expect([r.candidate.payload.website, r.candidate.payload.careersUrl]).toEqual([null, null]);
    expect(r.warnings.map((w) => w.code).sort()).toEqual(['invalid_careers_url', 'invalid_website']);
  });

  it('a name of 1990 × U+FDFA is refused invalid_name', () => {
    expect(map({ Company: FDFA })).toMatchObject({ error: { code: 'invalid_name' } });
  });
});

describe('Lows: the Website Google path is read decoded and //-collapsed; more shared hosts', () => {
  it.each([
    'https://www.google.com/%6Daps',
    'https://www.google.com/&#x6d;aps',
    'https://www.google.com//maps',
    'https://www.google.com/%73earch?q=acme',
    'https://www.google.com/%75rl?q=https://acme.co.uk',
    'https://www.google.com//url',
    'https://www.google.com/%2Furl',
    'https://www.google.co.uk/%2F%2Fmaps/place/x',
    'https://images.google.com/',
    'https://lens.google.com/',
    'https://news.google.co.uk/',
    'https://scholar.google.de/',
    'https://books.google.com/',
    'https://shopping.google.com/',
    'https://www.mapquest.com/us/acme',
  ])('Website %s is no website', (w) => {
    expect(kept({ Website: w }).candidate.payload.website).toBeNull();
  });

  it.each(['images.google.com', 'mapquest.com', 'www.mapquest.com'])('Domain %s is never identity', (d) => {
    expect(kept({ Domain: d }).candidate.payload.domain).toBeNull();
  });
});
