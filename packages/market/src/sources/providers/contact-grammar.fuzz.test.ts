import { describe, expect, it } from 'vitest';
import { mapDirectoryRow, parseDirectoryConfig } from './company-directory';
import { canonicalText, hasContactValue, reduceUrlCell, urlHasContactValue } from './directory-values';

/**
 * Permanent seeded fuzz of the address grammar (DECISION_LOG af1b342, PR #27 re-verification #11):
 * random members — at-forms × dot-forms × random mixed separator runs of 1–3 characters (`.`,
 * Unicode brackets, NBSP, tab, zero-width included) × 1–4 labels (Unicode, digit and punycode) ×
 * local parts × public suffixes — must be detected as text, in a URL path and in a URL query.
 * A fixed seed keeps it reproducible; a miss prints the member.
 */

const SEED = 20260930;
const CASES = 6000;

function lcg(seed: number) {
  let s = seed;
  // 32-bit LCG (Math.imul keeps it exact; a float product would lose the low bits).
  return () => (s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x80000000;
}

// prettier-ignore
const SEPARATOR_CHARS = [
  ' ', '-', '_', '/', '–', '—', '*', '~', '|', ',', ':', '+', '·', '.',
  '(', ')', '[', ']', '{', '}', '<', '>', '«', '»', '【', '】', '〔', '〕', '⟨', '⟩',
  '"', "'", '\u200b', '\u00a0', '\t',
];
const AT_FORMS = [
  'at',
  'AT',
  'At',
  'arroba',
  '@',
  '＠',
  '(a)',
  '( A )',
  '[a]',
  '«a»',
  '【a】',
  '〔a〕',
  '»a«',
  '„a“',
  '﴾a﴿',
  '"a"',
  "'a'",
  '〝a〟',
  '⦍a⦐',
];
const DOT_FORMS = ['.', 'dot', 'DOT', 'Dot', 'punto', 'Punkt', 'point', 'ponto', '·', '‧', '•'];
const LOCALS = [
  'jane.smith',
  'jane+x',
  'jane',
  'j4ne',
  'jané',
  'Жанна',
  'o-neil',
  'j_s',
  'at',
  'dot',
  'arroba',
  'Dot',
];
const LABELS = [
  'acme',
  'mail',
  'a1',
  '123',
  'acme-corp',
  'bücher',
  'пример',
  'xn--bcher-kva',
  'ACME',
  'Mail2',
  'at',
  'dot',
  'arroba',
];
const SUFFIXES = [
  ['com'],
  ['co', 'uk'],
  ['io'],
  ['de'],
  ['рф'],
  ['xn--p1ai'],
  ['london'],
  ['com', 'au'],
  ['中国'],
];

function fuzzMembers(seed = SEED, n = CASES): string[] {
  const rnd = lcg(seed);
  const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
  const sep = (min: number) => {
    let s = '';
    const len = min + Math.floor(rnd() * (4 - min)); // 1–3 characters (0–3 next to a symbol form)
    for (let i = 0; i < len; i++) s += pick(SEPARATOR_CHARS);
    return s;
  };
  const isWord = (form: string) => /^[\p{L}\p{N}]/u.test(form);
  const out: string[] = [];
  for (let k = 0; k < n; k++) {
    const at = pick(AT_FORMS);
    const labels = [pick(LABELS)];
    const extra = Math.floor(rnd() * 3); // 1–3 labels before the suffix
    for (let i = 0; i < extra; i++) labels.push(pick(LABELS));
    labels.push(...pick(SUFFIXES));
    let domain = labels[0]!;
    for (let i = 1; i < labels.length; i++) {
      const dot = pick(DOT_FORMS);
      const min = isWord(dot) ? 1 : 0;
      domain += sep(min) + dot + sep(min) + labels[i];
    }
    const min = isWord(at) ? 1 : 0;
    out.push(pick(LOCALS) + sep(min) + at + sep(min) + domain);
  }
  return out;
}

describe('seeded fuzz: every generated grammar member is detected (text, URL path, URL query)', () => {
  const members = fuzzMembers();

  it(`generates ${CASES} members from seed ${SEED}`, () => {
    expect(members).toHaveLength(CASES);
    expect(new Set(members).size).toBeGreaterThan(CASES * 0.99);
  });

  it('text: 0 misses', () => {
    expect(members.filter((v) => !hasContactValue(v))).toEqual([]);
  });

  it('URL path: 0 misses', () => {
    expect(
      members.filter(
        (v) => !urlHasContactValue(`https://careers.acmewidgets.co.uk/jobs/${encodeURIComponent(v)}`),
      ),
    ).toEqual([]);
  });

  it('URL query: 0 misses', () => {
    expect(
      members.filter(
        (v) => !urlHasContactValue(`https://careers.acmewidgets.co.uk/jobs?q=${encodeURIComponent(v)}`),
      ),
    ).toEqual([]);
  });
});

/**
 * Re-verification #14 shapes (DECISION_LOG 29b6592): the same members with a long hyphenated tail
 * (`…com-aaaa…`, a hyphen cut must be tried before any length prune), and behind an encoded `#`
 * in a URL path (`/%23…`, `/%2523…`, `/x&num;…`: a URL cell never stores a path that is not plain).
 * A second seeded stream, so the members above are unchanged.
 */
function tailed(members: readonly string[], seed = SEED + 14): string[] {
  const rnd = lcg(seed);
  const TAIL = 'abcdefghijklmnopqrstuvwxyz0123456789-';
  return members.map((v) => {
    const n = 60 + Math.floor(rnd() * 150); // 60–209 characters: over one label, under the address bound
    let t = '-';
    for (let i = 0; i < n; i++) t += TAIL[Math.floor(rnd() * TAIL.length)];
    return v + t;
  });
}

describe('seeded fuzz: long hyphenated tails and encoded-# URL paths (re-verification #14)', () => {
  const members = fuzzMembers();
  const withTails = tailed(members);

  it('text with a long hyphenated tail: 0 misses', () => {
    expect(withTails.filter((v) => !hasContactValue(v))).toEqual([]);
  });

  it('a URL path behind an encoded # is never stored (dropped or reduced to the origin)', () => {
    const PREFIXES = ['%23', '%23/', '%2523', 'x&num;', 'jobs%23'];
    const stored: string[] = [];
    members.forEach((v, i) => {
      const u = `https://jane.at/${PREFIXES[i % PREFIXES.length]}${encodeURIComponent(v)}`;
      const r = reduceUrlCell(u);
      if (r.kind === 'url' && !(r.reduced && r.url === r.origin)) stored.push(u);
    });
    expect(stored).toEqual([]);
  });
});

/**
 * Re-verification #16 shapes (DECISION_LOG 64d97b4): the members with a glue — an invisible entity
 * or code point, a combining mark or a filler — inserted at a seeded position; each is still
 * refused as a company name (canonical form and the cell as written, skeletons included).
 */
const NAME_CONFIG = parseDirectoryConfig({ columns: { name: 'Company' } });
const INVISIBLE_GLUES = ['&shy;', '&zwsp;', '%C2%AD', '\u200b', '\u2060'];
const VISIBLE_GLUES = ['\u0301', '\u0308', '\u{16fe4}', '\u{1d159}', '\u2800'];

describe('seeded fuzz: glued, marked and filled members (re-verification #16)', () => {
  const rnd = lcg(SEED + 16);
  const members = fuzzMembers()
    .slice(0, 1500)
    .map((v) => {
      // An invisible glue only where the member has no zero-width separator of its own: with both,
      // no single reading of the invisibles (removed, as a reader sees them, or spaced) is an address.
      const glues = /\p{Default_Ignorable_Code_Point}/u.test(v)
        ? VISIBLE_GLUES
        : [...INVISIBLE_GLUES, ...VISIBLE_GLUES];
      const glue = glues[Math.floor(rnd() * glues.length)]!;
      const at = 1 + Math.floor(rnd() * (v.length - 1));
      return `${v.slice(0, at)}${glue}${v.slice(at)}`;
    });

  it('refused as a name: 0 misses', () => {
    const misses = members.filter((v) => {
      const r = mapDirectoryRow(NAME_CONFIG, { Company: v }, 2);
      return (
        !('error' in r) || (r.error.code !== 'contact_value' && r.error.code !== 'contact_value_undecidable')
      );
    });
    expect(misses).toEqual([]);
  });
});

describe('seeded fuzz: the canonical form is a fixed point (re-verification #17)', () => {
  it('canonicalText(canonicalText(x)) === canonicalText(x) for every member, glued or not', () => {
    const rnd = lcg(SEED + 17);
    const GLUES = ['&amp;', '&amp;amp;#64;', '&#xD800;', '\ud800', '&shy;', '%2526', '\ufdfa', '＆#64;'];
    const bad = fuzzMembers()
      .flatMap((v) => {
        const at = Math.floor(rnd() * v.length);
        return [v, `${v.slice(0, at)}${GLUES[Math.floor(rnd() * GLUES.length)]}${v.slice(at)}`];
      })
      .filter((v) => {
        const c = canonicalText(v);
        return c !== null && canonicalText(c) !== c;
      });
    expect(bad).toEqual([]);
  });
});
