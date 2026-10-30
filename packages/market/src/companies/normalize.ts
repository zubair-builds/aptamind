import { getDomain } from 'tldts';

/**
 * Company identity normalisation.
 *
 * Two keys are derived from a company name:
 *  - `strictKey`: punctuation/case/diacritics-insensitive, with legal-form words mapped to a
 *    canonical token ("Limited" → "ltd"). Two names with the same strict key are the same
 *    legal name.
 *  - `looseKey`: the strict key with legal forms removed ("acme ltd" and "acme inc" → "acme").
 *    Loose-only matches are *probable* matches and go to review — they are frequently
 *    different legal entities.
 */

export const NAME_NORMALIZATION_VERSION = 'name-norm/2';

const LEGAL_FORMS: Array<[RegExp, string]> = [
  [/\bpublic limited company\b/g, 'plc'],
  [/\blimited liability partnership\b/g, 'llp'],
  [/\blimited liability company\b/g, 'llc'],
  [/\bprivate limited\b/g, 'ltd'],
  [/\blimited\b/g, 'ltd'],
  [/\bltd\b/g, 'ltd'],
  [/\bincorporated\b/g, 'inc'],
  [/\binc\b/g, 'inc'],
  [/\bcorporation\b/g, 'corp'],
  [/\bcorp\b/g, 'corp'],
  [/\bcompany\b/g, 'co'],
  [/\bgesellschaft mit beschrankter haftung\b/g, 'gmbh'],
  [/\bsociete anonyme\b/g, 'sa'],
  [/\bpty\b/g, 'pty'],
];
const LEGAL_TOKENS = new Set([
  'ltd',
  'plc',
  'llp',
  'llc',
  'inc',
  'corp',
  'co',
  'gmbh',
  'sa',
  'sas',
  'sarl',
  'bv',
  'nv',
  'ag',
  'ab',
  'as',
  'oy',
  'spa',
  'srl',
  'pty',
  'lp',
  'cic',
  'uk',
]);

const LATIN = /\p{Script=Latin}/u;
/** A letter or digit of a script other than Latin, Common or Inherited (Cyrillic, Greek, Han, …). */
const OTHER_SCRIPT = /^(?![\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])[\p{L}\p{N}]$/u;
const MARK = /\p{M}/u;
const LATIN_DIACRITIC = /[\u0300-\u036f]/;

/**
 * Case- and punctuation-insensitive name text, Unicode-aware (name-norm/2): NFKC, lower case
 * (casefold), and
 *  - Latin text exactly as name-norm/1 did: diacritics U+0300–U+036F removed (`é` → `e`), a
 *    Latin letter with no ASCII base (`ø`, `ß`) and any other mark, symbol, modifier letter
 *    (`ʼ`, `ˈ`) or punctuation is a separator;
 *  - letters and digits of every other script are KEPT with their marks (Cyrillic, Greek, CJK,
 *    Arabic, …): "ООО Ромашка" and "東京電力" no longer collapse to an empty key;
 *  - `&` → " and ", apostrophes dropped.
 * Known v1 → v2 differences (documented in the market-sources contract): non-Latin letters are
 * kept, and a compatibility character that NFKC maps to a non-Latin letter becomes that letter
 * (`µ` micro sign → Greek `μ`, `Ω` ohm sign → `ω`) where v1 made it a separator.
 */
export function basicNormalize(input: string): string {
  let out = '';
  // Whether the previous character was a kept non-Latin letter or digit (or one of its marks).
  let afterOther = false;
  for (const ch of input.normalize('NFKC').toLowerCase()) {
    if (MARK.test(ch)) {
      // A mark belongs to the letter before it: kept on a non-Latin letter (dakuten, …); a Latin
      // diacritic is dropped and any other mark is a separator, as in name-norm/1.
      if (afterOther) out += ch;
      else if (!LATIN_DIACRITIC.test(ch)) out += ' ';
      continue;
    }
    afterOther = false;
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) out += ch;
    else if (LATIN.test(ch)) {
      const base = ch.normalize('NFKD').replace(/\p{M}+/gu, '');
      out += /^[a-z0-9]+$/.test(base) ? base : ' ';
    } else if (OTHER_SCRIPT.test(ch)) {
      out += ch;
      afterOther = true;
    } else if (ch === '&') out += ' and ';
    else if (ch !== "'" && ch !== '’' && ch !== '`') out += ' ';
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** name-norm/1, kept for matching companies keyed before name-norm/2 (never for new keys). */
export function basicNormalizeV1(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split "X Ltd t/a Y" / "X trading as Y" into legal name and trading alias. */
export function splitTradingName(name: string): { legal: string; tradingAs: string | null } {
  const m = /^(.*?)\s+(?:t\/a|T\/A|trading as|Trading As|TRADING AS)\s+(.+)$/.exec(name.trim());
  if (!m || !m[1] || !m[2]) return { legal: name.trim(), tradingAs: null };
  return { legal: m[1].trim(), tradingAs: m[2].trim() };
}

function strictFrom(normalized: string): string {
  let s = normalized.replace(/^the /, '');
  for (const [re, token] of LEGAL_FORMS) s = s.replace(re, token);
  return s.replace(/\s+/g, ' ').trim();
}

function looseFrom(strict: string): string {
  const tokens = strict.split(' ').filter(Boolean);
  // Strip trailing legal-form tokens only (keeps e.g. "co" inside "co op bank").
  while (tokens.length > 1 && LEGAL_TOKENS.has(tokens[tokens.length - 1] as string)) tokens.pop();
  return tokens.join(' ');
}

export function strictNameKey(name: string): string {
  return strictFrom(basicNormalize(splitTradingName(name).legal));
}

/** The name-norm/1 strict key (companies keyed before name-norm/2 carry it). */
export function strictNameKeyV1(name: string): string {
  return strictFrom(basicNormalizeV1(splitTradingName(name).legal));
}

export function looseNameKey(name: string): string {
  return looseFrom(strictNameKey(name));
}

/**
 * The strict keys a lookup tries: name-norm/2, then name-norm/1 when it differs and is not
 * empty. Stored keys are never replaced (DECISION_LOG "Company directory import hardening"), so
 * a company keyed under v1 is still found until the backfill adds its v2 key.
 */
export function strictNameKeysForLookup(name: string): string[] {
  return [...new Set([strictNameKey(name), strictNameKeyV1(name)].filter(Boolean))];
}

/** The loose keys a lookup tries (v2, then v1 when it differs). */
export function looseNameKeysForLookup(name: string): string[] {
  return [...new Set([looseNameKey(name), looseFrom(strictNameKeyV1(name))].filter(Boolean))];
}

export function firstSignificantToken(name: string): string {
  const stop = new Set(['the', 'and', 'of', 'a']);
  return (
    looseNameKey(name)
      .split(' ')
      .find((t) => !stop.has(t)) ?? ''
  );
}

/** Registrable domain (eTLD+1), lower-case, or null for IPs/invalid input. */
export function registrableDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let host = input.trim().toLowerCase();
  if (!host) return null;
  try {
    if (/^[a-z]+:\/\//.test(host)) host = new URL(host).hostname;
    else host = new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return null;
  // Private suffixes (e.g. herokuapp.com, github.io) are honoured: `acme.herokuapp.com` is Acme's
  // domain, not Heroku's.
  const d = getDomain(host, { allowPrivateDomains: true });
  return d ? d.toLowerCase() : null;
}

/** Hosts that identify platforms, not employers; never used as a company's official domain. */
export const NON_COMPANY_DOMAINS = new Set([
  'linkedin.com',
  'facebook.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'youtube.com',
  'glassdoor.com',
  'glassdoor.co.uk',
  'indeed.com',
  'indeed.co.uk',
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'gov.uk',
  'wikipedia.org',
  'crunchbase.com',
  'github.com',
  'medium.com',
]);

export function companyDomain(input: string | null | undefined): string | null {
  const d = registrableDomain(input);
  return d && !NON_COMPANY_DOMAINS.has(d) ? d : null;
}

/** Jaro-Winkler similarity (0..1) for fuzzy fallback matching. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatch = new Array<boolean>(a.length).fill(false);
  const bMatch = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(i + range + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = true;
      bMatch[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

export function identityKeys(input: {
  strictNames: string[];
  domain: string | null;
  externalIds: Array<{ namespace: string; id: string }>;
}): string[] {
  const keys = new Set<string>();
  for (const n of input.strictNames) if (n) keys.add(`name:${n}`);
  if (input.domain) keys.add(`domain:${input.domain}`);
  for (const e of input.externalIds) keys.add(`ext:${e.namespace}:${e.id}`);
  return [...keys].sort();
}
