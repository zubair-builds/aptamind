import { describe, expect, it } from 'vitest';
import { mapDirectoryRow, parseDirectoryConfig } from './company-directory';
import { matchesAddressGrammar, tokenizeAddress } from './contact-grammar';
import { canonicalText, contactText, decodeEscapes, hasContactValue } from './directory-values';

/**
 * DECISION_LOG af1b342: the b24e5dd standard notations are a grammar, and the tests are GENERATED
 * from it — every member of at-forms × dot-forms × separators × suffixes, in every text cell, is
 * refused (name) or dropped (legal name, town, careers path); a generated set of legitimate names
 * and hosts stays kept.
 */

const config = parseDirectoryConfig({
  columns: {
    name: 'Company',
    legalName: 'Legal',
    domain: 'Domain',
    website: 'Website',
    town: 'Town',
    country: 'Country',
    careersUrl: 'Careers',
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
  ...over,
});
const map = (over: Record<string, string>) => mapDirectoryRow(config, row(over), 2);

const AT_FORMS = [
  'at',
  'AT',
  'At',
  'arroba',
  '[at]',
  '(at)',
  '{at}',
  '<at>',
  '[ at ]',
  '( AT )',
  '(a)',
  '«a»',
  '【a】',
  '〔a〕',
  '»a«',
  '„a“',
  '﴾a﴿',
  '@',
  '＠',
  '&#64;',
] as const;
const DOT_FORMS = [
  '.',
  'dot',
  'DOT',
  'Dot',
  '[dot]',
  '(dot)',
  '{dot}',
  '<dot>',
  '[.]',
  '(.)',
  '{.}',
  '<.>',
  '[ . ]',
  '( dot )',
] as const;
const SEPARATORS = [
  '\u200b',
  '.',
  ' ',
  '-',
  '_',
  '/',
  '–',
  '—',
  "'",
  '"',
  '*',
  '~',
  '|',
  ',',
  ':',
  '+',
  '·',
  '',
] as const;
const SUFFIXES = ['com', 'co.uk', 'io', 'london', 'xn--p1ai', 'рф', '中国'] as const;
/** The labels before the suffix: one plain, one hyphenated (`acme-corp`), two (`mail.acme`). */
const DOMAINS = [['acme'], ['acme-corp'], ['mail', 'acme']] as const;
/** Text after the address: none, or joined by a hyphen (`…com-ref7`: a job slug). */
const CONTEXTS = ['', '-ref7'] as const;

/** The generated positive set size, pinned (a shrinking generator fails loudly). */
const POSITIVE_COUNT = 207_312;
/** The generated URL set size, pinned. */
const URL_MEMBER_COUNT = 774;
/** The generated long-tail set size, pinned. */
const TAIL_MEMBER_COUNT = 14_808;
/** The generated keyword set size, pinned. */
const KEYWORD_MEMBER_COUNT = 118_464;

const isWord = (form: string) => /^[\p{L}]+$/u.test(form);

/** A grammar member, or null when the combination is outside the grammar (a bare word glued to its neighbours). */
function address(
  at: string,
  dot: string,
  sep: string,
  suffix: string,
  domain: readonly string[] = ['acme'],
  context = '',
  local = 'jane',
): string | null {
  if (sep === '' && (isWord(at) || isWord(dot))) return null; // `janeatacme`, `acmedotcom`: residual
  const join = `${sep}${dot}${sep}`;
  return `${local}${sep}${at}${sep}${[...domain, ...suffix.split('.')].join(join)}${context}`;
}

const positives: Array<{ at: string; dot: string; sep: string; v: string }> = [];
for (const at of AT_FORMS)
  for (const dot of DOT_FORMS)
    for (const sep of SEPARATORS)
      for (const suffix of SUFFIXES)
        for (const domain of DOMAINS)
          for (const context of CONTEXTS) {
            const v = address(at, dot, sep, suffix, domain, context);
            if (v) positives.push({ at, dot, sep, v });
          }

/** The cells a grammar member must never be kept in; each returns a problem description or null. */
const CELLS: Record<string, (v: string) => string | null> = {
  name: (v) => {
    const r = map({ Company: v });
    return 'error' in r && r.error.code === 'contact_value' ? null : 'name kept';
  },
  legal: (v) => {
    const r = map({ Legal: v });
    if ('error' in r) return `row refused (${r.error.code})`;
    return r.warnings.some((w) => w.column === 'Legal') ? null : 'legal name kept';
  },
  town: (v) => {
    const r = map({ Town: v });
    if ('error' in r) return `row refused (${r.error.code})`;
    return r.warnings.some((w) => w.column === 'Town') && hasContactValue(v, { town: true })
      ? null
      : 'town kept';
  },
  careers: (v) => {
    const r = map({ Careers: `https://careers.acmewidgets.co.uk/jobs/${v}` });
    if ('error' in r) return `row refused (${r.error.code})`;
    // Dropped, or reduced to its origin (DECISION_LOG 29b6592): the path is never stored.
    const stored = r.candidate.payload.careersUrl;
    return stored == null || new URL(stored).pathname === '/' ? null : 'careers URL kept with its path';
  },
};

describe('generated: every grammar member is refused or dropped in every cell', () => {
  it('the positive set is the full cross-product (size)', () => {
    // at-forms × dot-forms × separators × suffixes × labels × contexts, minus glued bare words.
    const perSep = SUFFIXES.length * DOMAINS.length * CONTEXTS.length;
    expect(positives.length).toBe(
      AT_FORMS.length * DOT_FORMS.length * SEPARATORS.length * perSep -
        perSep *
          (AT_FORMS.filter(isWord).length * DOT_FORMS.length +
            (AT_FORMS.length - AT_FORMS.filter(isWord).length) * DOT_FORMS.filter(isWord).length),
    );
    expect(positives.length).toBe(POSITIVE_COUNT);
  });

  for (const at of AT_FORMS)
    describe(`at-form ${JSON.stringify(at)}`, () => {
      const cases = DOT_FORMS.flatMap((dot) => SEPARATORS.map((sep) => [dot, sep] as const));
      it.each(cases)('dot-form %j, separator %j: all suffixes, all cells', (dot, sep) => {
        const misses: string[] = [];
        for (const p of positives.filter((x) => x.at === at && x.dot === dot && x.sep === sep)) {
          // The grammar itself (after the character-level normalisation every cell gets).
          if (!matchesAddressGrammar(contactText(decodeEscapes(p.v), 'space')))
            misses.push(`${JSON.stringify(p.v)}: not a grammar match`);
          if (!hasContactValue(p.v)) misses.push(`${p.v}: not detected`);
          for (const [cell, check] of Object.entries(CELLS)) {
            const problem = check(p.v);
            if (problem) misses.push(`${p.v} [${cell}]: ${problem}`);
          }
        }
        expect(misses).toEqual([]);
      });
    });
});

/**
 * Long hyphenated tails (re-verification #14, H-1): the address, then a hyphen and more than one
 * label's worth of text. A prune may only discard impossible readings, so the hyphen cut after the
 * suffix must still be found.
 */
const TAILS = [`-${'a'.repeat(70)}`, '-a1'.repeat(30), `-ref-${'x'.repeat(64)}`] as const;
const tailMembers: string[] = [];
for (const at of AT_FORMS)
  for (const dot of DOT_FORMS)
    for (const sep of SEPARATORS)
      for (const tail of TAILS) {
        const v = address(at, dot, sep, 'com', ['acme-corp'], tail);
        if (v) tailMembers.push(v);
      }

describe('generated: long hyphenated tails', () => {
  it('the long-tail set size', () => {
    expect(tailMembers.length).toBe(TAIL_MEMBER_COUNT);
  });

  it('every member is detected and refused as a name', () => {
    expect(tailMembers.filter((v) => !hasContactValue(v) || CELLS.name!(v) !== null)).toEqual([]);
  });
});

/** Keywords as the local part or a label (re-verification #12, H-1): `jane at at dot com`, `dot at acme dot com`. */
const KEYWORD_LOCALS = ['at', 'dot', 'arroba', 'Dot', 'jane'] as const;
const KEYWORD_DOMAINS = [['at'], ['dot'], ['arroba'], ['mail', 'at'], ['acme']] as const;
const keywordMembers: string[] = [];
for (const local of KEYWORD_LOCALS)
  for (const domain of KEYWORD_DOMAINS) {
    if (local === 'jane' && domain[0] === 'acme') continue; // the main cross-product
    for (const at of AT_FORMS)
      for (const dot of DOT_FORMS)
        for (const sep of SEPARATORS) {
          const v = address(at, dot, sep, 'com', domain, '', local);
          if (v) keywordMembers.push(v);
        }
  }

describe('generated: keywords as local parts and labels', () => {
  it('the keyword set size', () => {
    expect(keywordMembers.length).toBe(KEYWORD_MEMBER_COUNT);
  });

  for (const local of KEYWORD_LOCALS)
    it(`local ${JSON.stringify(local)}: every member is detected and refused as a name`, () => {
      const misses = keywordMembers
        .filter((v) => v.startsWith(local))
        .filter(
          (v) =>
            !matchesAddressGrammar(contactText(decodeEscapes(v), 'space')) ||
            !hasContactValue(v) ||
            CELLS.name!(v) !== null,
        );
      expect(misses).toEqual([]);
    });
});

/** URL cells (DECISION_LOG 6bff30e): every at-form in a Website / Careers path or host drops the cell. */
const urlMembers: string[] = [];
for (const at of AT_FORMS)
  for (const sep of SEPARATORS) {
    if (sep === '' && isWord(at)) continue;
    urlMembers.push(`https://careers.acme.co.uk/jobs/${encodeURIComponent(`jane${sep}${at}${sep}x`)}`);
    urlMembers.push(`https://careers.acme.co.uk/jobs/jane${sep}${at}${sep}x/apply`);
  }
for (const at of ['at', 'AT', 'arroba'])
  for (const host of [`jane-${at}-acme.co.uk`, `jane.${at}`, `jane.smith.${at}`, `www.jane-${at}-x.com`])
    urlMembers.push(`https://${host}/gmail.com`);
/** `.at` hosts (the ccTLD is an at-form) × domain-shaped paths: dropped (the amended ruling). */
const AT_HOSTS = ['jane.at', 'jane.smith.at', 'jane-smith.at', 'www.jane.at', 'karriere.jane.co.at'];
const DOMAIN_PATHS = [
  '/gmail.com',
  '/gmail/dot/com',
  '/gmail%2Ecom',
  '/gmail(dot)co.uk',
  '/gmail.com/careers',
];
for (const host of AT_HOSTS) for (const path of DOMAIN_PATHS) urlMembers.push(`https://${host}${path}`);
/** Encoded `#` paths (re-verification #14, H-2): not plain, so only the origin may be kept. */
const ENCODED_HASH_PATHS = [
  '/%23gmail.com',
  '/%23/gmail.com',
  '/%23gmail(dot)com',
  '/%2523gmail(dot)com',
  '/x&num;gmail(dot)com',
];
for (const host of AT_HOSTS) for (const path of ENCODED_HASH_PATHS) urlMembers.push(`https://${host}${path}`);
/** Austrian hosts × plain paths: kept. */
const AUSTRIAN_KEPT: string[] = [];
for (const host of ['acme.at', 'www.firma.at', 'karriere.firma.co.at', 'jobs.acme.or.at'])
  for (const path of [
    '/jobs',
    '/karriere/stellen?id=12',
    '/de/jobs/senior-engineer',
    '/stellen/index.html',
    '/',
  ])
    AUSTRIAN_KEPT.push(`https://${host}${path}`);

describe('generated: URL cells with an at-form', () => {
  it('the URL set sizes', () => {
    expect(urlMembers.length).toBe(URL_MEMBER_COUNT);
    expect(AUSTRIAN_KEPT).toHaveLength(20);
  });

  it('Austrian hosts with plain paths keep their careers URL', () => {
    const dropped = AUSTRIAN_KEPT.filter((u) => {
      const r = map({ Careers: u });
      return 'error' in r || r.candidate.payload.careersUrl === null;
    });
    expect(dropped).toEqual([]);
  });

  it('no member ever stores its path: dropped, or reduced to its origin (DECISION_LOG 29b6592)', () => {
    const stored = urlMembers.filter((u) => {
      const r = map({ Careers: u, Website: u });
      if ('error' in r) return true;
      const c = r.candidate.payload.careersUrl;
      const w = r.candidate.payload.website;
      return (c != null && new URL(c).pathname !== '/') || (w != null && new URL(w).pathname !== '/');
    });
    expect(stored).toEqual([]);
  });

  it('a host at-form, and an .at host before a plain domain-shaped path, drop the cell', () => {
    const hostMembers = urlMembers.filter((u) => !u.startsWith('https://careers.acme.co.uk/'));
    const kept = hostMembers.filter((u) => {
      const r = map({ Careers: u });
      // Not plain as written (`%2E`, `(dot)`, `?`): only the origin is kept.
      const plain = /^[A-Za-z0-9._~/-]*$/.test(new URL(u).pathname) && !u.includes('?') && !/%|\(/.test(u);
      return plain && ('error' in r || r.candidate.payload.careersUrl !== null);
    });
    expect(kept).toEqual([]);
  });
});

/**
 * Re-verification #16 (DECISION_LOG 64d97b4): glued, marked and filled at-forms, and bare-host
 * Domain cells. Every word at-form × every glue (an invisible entity, escape or code point, a
 * combining mark, a filler) inside the at-word or the dot word × dot-forms: refused as a name.
 */
const GLUES = [
  '&shy;', '&zwsp;', '&zwnj;', '&zwj;', '&NoBreak;', '&#x200b;', '%C2%AD', '\u00ad', '\u200b', '\u2060', '\ufeff',
  '\u034f', '\u0300', '\u0301', '\u0308', '\u{16fe4}', '\u{1d159}', '\u2800', '\u3164',
]; // prettier-ignore
const gluedMembers: string[] = [];
for (const at of ['at', 'AT', 'arroba'])
  for (const glue of GLUES)
    for (const dot of ['dot', 'punto', '.'])
      for (const place of ['at', 'dot'] as const) {
        const a = place === 'at' ? `${at[0]}${glue}${at.slice(1)}` : at;
        const d = place === 'dot' && dot.length > 1 ? `${dot[0]}${glue}${dot.slice(1)}` : dot;
        gluedMembers.push(`Acme jane ${a} acme ${d} com`);
      }
/** Bare-host Domain cells: anything after the host but a single `/` is `invalid_domain`. */
const DOMAIN_TAILS = [
  '/x',
  '//maps',
  '/%6Daps',
  '/&#x6d;aps',
  '?q=1',
  '#f',
  '/jobs/',
  '\\x',
  '/ x',
  ':443/x',
];
const domainMembers = ['', 'https://', 'http://', 'HTTPS://www.'].flatMap((scheme) =>
  DOMAIN_TAILS.map((tail) => `${scheme}acme.co.uk${tail}`),
);

describe('generated: glued, marked and filled at-forms; bare-host Domain cells (re-verification #16)', () => {
  it(`${gluedMembers.length} glued at-forms are refused as a name`, () => {
    expect(gluedMembers.filter((v) => CELLS.name!(v) !== null)).toEqual([]);
  });

  it(`${domainMembers.length} Domain cells with more than a host are invalid_domain`, () => {
    const keptCells = domainMembers.filter((d) => {
      const r = map({ Domain: d });
      return 'error' in r || r.candidate.payload.domain !== null || r.warnings[0]?.code !== 'invalid_domain';
    });
    expect(keptCells).toEqual([]);
  });
});

describe('generated: the canonical form is a fixed point over every generated member (re-verification #17)', () => {
  it('canonicalText(canonicalText(x)) === canonicalText(x)', () => {
    const all = [
      ...positives.map((p) => p.v),
      ...keywordMembers,
      ...tailMembers,
      ...gluedMembers,
      ...urlMembers,
    ];
    const bad = all.filter((v) => {
      const c = canonicalText(v);
      return c !== null && canonicalText(c) !== c;
    });
    expect(bad).toEqual([]);
  });
});

describe('the reviewer lists (re-verification #10)', () => {
  it.each([
    // H-1: a bracketed dot next to a non-space separator.
    'Zqja Smith at acme-[dot]-co-[dot]-uk',
    'zqx_at_acme_[dot]_com',
    'zqx at acme_(dot)_com',
    'zqx at acme/[dot]/com',
    'zqx at acme -{dot}- com',
    'zqx at acme -<dot>- com',
    'zqx (at) acme -[dot]- com',
    'zqx at acme [dot]-com',
    'zqx at acme—(dot)—co—(dot)—uk',
    'zqjd at acme_(dot)_com',
    // H-2: a punycode public suffix.
    'zqx at acme.xn--p1ai',
    'zqx-at-acme.xn--p1ai',
    'zqx(at)acme dot xn--p1ai',
    'zqx_at_acme_dot_xn--p1ai',
    'zqx-at-acme-dot-co-dot-xn--p1ai',
    'zqjb at acme.xn--p1ai',
    // L-1: zero-width characters (a space in the name key).
    'zqx at acme​dot​com',
    'zqx at acme⁠dot­com',
    // L-3 (formerly residual, members of the grammar): a plain dot with non-space separators.
    'zqx at acme-.-com',
    'zqx-at-acme-.com',
    // re-verification #11 HIGH-1: `.` in the separators around a dot-form.
    'jane at acme.dot.com',
    'jane at acme .dot. com',
    'jane at acme dot. com',
    'jane at acme .dot com',
    'jane at acme . dot . com',
    'jane at acme.[dot].com',
    'jane at acme(dot).com',
    'jane at acme [.]dot[.] com',
    'Jane at mail.acme.dot.co.dot.uk',
    // MEDIUM-1: `(a)` in Unicode brackets.
    'jane «a» acme.com',
    'jane 【a】 acme.com',
    'jane 〔a〕 acme.com',
    // Hyphenated labels with hyphen-separated keywords.
    'Jane Smith zqlaa at smith-consult-dot-ae',
  ])('name %j is refused', (v) => {
    expect(map({ Company: v })).toMatchObject({ error: { code: 'contact_value' } });
  });

  it.each([
    'https://acme.com/jobs/zqx-at-acme-[dot]-com',
    'https://careers.x.co.uk/jobs/jane(at)gmail(dot).com',
    'https://careers.acme.co.uk\\jobs\\jane\\at\\gmail\\.\\com',
  ])('careers %s keeps no path (reduced to its origin, DECISION_LOG 29b6592)', (careers) => {
    const r = map({ Careers: careers });
    if (!('candidate' in r)) throw new Error('row refused');
    const stored = r.candidate.payload.careersUrl;
    expect(stored == null || new URL(stored).pathname === '/').toBe(true);
  });

  it.each(['Jane 07700ß900123 Ltd', 'Jane 07700ʼ900123 Ltd'])(
    'letter-split digits %j (9+ in the name key) are refused',
    (v) => {
      expect(map({ Company: v })).toMatchObject({ error: { code: 'contact_value' } });
    },
  );
});

const NAME_BASES = [
  'Art at Work',
  'Made at Home',
  'Coffee (at) Home',
  'Acme [at] Home',
  'Polka Dot',
  'Dot Com Media',
  'Studio at Unit 4.2',
  'Salon at 5th. Ave',
  "Smith & Co at St. James's",
  '9123-4567 Québec',
  '9123 4567 Québec',
  '1234567 Ontario',
  'BC1234567',
  '365 Careers',
  '24-7 Plumbing',
  '3M United Kingdom',
  'Route 66 Diner',
  'Unit 12, 34 High Street',
  'Plumbers (2019)',
  'At Home Interiors',
  'Meet at Noon',
  'Oil & Gas',
  'Skype Technologies',
  'Arroba Consulting',
  'Dot Matrix Printing',
  'X.Y. Holdings',
  'A.B.C. Trading',
  'St. Mary Dental',
  'Acme GmbH (acme.at)',
];
const LEGAL_FORMS = ['Ltd', 'Limited', 'Inc.', 'inc.', 'LLC', 'PLC', 'GmbH', ''];
const negativeNames = NAME_BASES.flatMap((b) => LEGAL_FORMS.map((f) => (f ? `${b} ${f}` : b)));
const HOSTS = [
  '365careers.com',
  '24-7.co.uk',
  '3m.com',
  '1800flowers.com',
  '118118.com',
  '08004you.co.uk',
  '123-reg.co.uk',
  '7-eleven.com',
  'xn--bcher-kva.de',
  'acme-2019.co.uk',
  'dot-matrix.com',
];

describe('generated: legitimate names and hosts stay kept', () => {
  it('the negative set sizes', () => {
    expect(negativeNames.length).toBe(NAME_BASES.length * LEGAL_FORMS.length);
    expect(negativeNames.length).toBe(232);
    expect(HOSTS.length * 3).toBe(33);
  });

  it.each(negativeNames)('name %j is kept (as name, legal name)', (name) => {
    const r = map({ Company: name, Legal: name });
    expect('error' in r ? r.error : r.warnings).toEqual([]);
  });

  it.each(HOSTS)('host %s is kept as Domain, Website and Careers URL', (host) => {
    const r = map({ Domain: host, Website: `https://${host}/`, Careers: `https://${host}/careers` });
    if ('error' in r) throw new Error(r.error.code);
    expect(r.warnings.filter((w) => w.code === 'contact_value')).toEqual([]);
    expect(r.candidate.payload.careersUrl).toBe(`https://${host}/careers`);
  });

  it('documented over-refusal (check what you store, DECISION_LOG bd6ad44): jobs-at-acme.com reads as an address, so every cell is dropped', () => {
    const host = 'jobs-at-acme.com';
    const r = map({ Domain: host, Website: `https://${host}/`, Careers: `https://${host}/careers` });
    if ('error' in r) throw new Error(r.error.code);
    expect(r.candidate.payload.domain).toBeNull();
    expect(r.warnings.map((w) => [w.column, w.code]).sort()).toEqual([
      ['Careers', 'contact_value'],
      ['Domain', 'contact_value'],
      ['Website', 'contact_value'],
    ]);
  });

  it.each(['at-home.co.uk'])(
    'documented over-refusal (fails closed, DECISION_LOG 6bff30e): %s is kept as Domain, its Website and Careers URL dropped',
    (host) => {
      const r = map({ Domain: host, Website: `https://${host}/`, Careers: `https://${host}/careers` });
      if ('error' in r) throw new Error(r.error.code);
      expect(r.candidate.payload.domain).toBe(host);
      // The Website and Careers URL cells are dropped (the website then derives from the domain).
      expect(r.warnings.map((w) => w.column).sort()).toEqual(['Careers', 'Website']);
      expect(r.candidate.payload.careersUrl).toBeNull();
    },
  );
});

describe('the tokeniser', () => {
  it('keeps punycode labels whole under both hyphen modes, and splits hyphen-delimited keywords', () => {
    const words = (t: string, mode: 'separator' | 'label') =>
      tokenizeAddress(t, mode)
        .filter((x) => x.kind !== 'sep')
        .map((x) => `${x.kind}:${x.text}`);
    expect(words('jane-at-acme-dot-xn--p1ai', 'separator')).toEqual([
      'word:jane',
      'at:at',
      'word:acme',
      'dot:dot',
      'word:xn--p1ai',
    ]);
    expect(words('smith-consult-dot-ae', 'label')).toEqual(['word:smith-consult', 'dot:dot', 'word:ae']);
    expect(matchesAddressGrammar('jane-at-gmail-dot-com.acme.com', { atWords: false })).toBe(false);
  });
});
