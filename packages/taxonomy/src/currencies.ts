/**
 * Currency vocabulary (ISO 4217) for salary parsing.
 *
 * Some symbols are ambiguous by design: `$` is used by a dozen currencies, `¥` by JPY and CNY,
 * `kr` by the Nordic krona/krone. Callers resolve those with location hints and must otherwise
 * report the amount as ambiguous rather than guessing.
 */

export interface CurrencyDef {
  code: string;
  name: string;
  /** Unambiguous symbols/prefixes (e.g. `£`, `C$`, `A$`). */
  symbols: readonly string[];
  /** Spelled-out words, lower-case (e.g. `pounds`, `euros`). */
  words: readonly string[];
}

export const CURRENCIES: readonly CurrencyDef[] = [
  { code: 'GBP', name: 'Pound sterling', symbols: ['£'], words: ['pound', 'pounds', 'sterling', 'quid'] },
  { code: 'USD', name: 'US dollar', symbols: ['US$', 'U$S'], words: ['us dollars', 'u.s. dollars', 'usd'] },
  { code: 'EUR', name: 'Euro', symbols: ['€'], words: ['euro', 'euros'] },
  { code: 'AED', name: 'UAE dirham', symbols: ['د.إ', 'Dhs', 'DHS'], words: ['dirham', 'dirhams'] },
  { code: 'CAD', name: 'Canadian dollar', symbols: ['C$', 'CA$', 'CAN$'], words: ['canadian dollars'] },
  { code: 'AUD', name: 'Australian dollar', symbols: ['A$', 'AU$'], words: ['australian dollars'] },
  { code: 'NZD', name: 'New Zealand dollar', symbols: ['NZ$'], words: ['new zealand dollars'] },
  { code: 'SGD', name: 'Singapore dollar', symbols: ['S$'], words: ['singapore dollars'] },
  { code: 'HKD', name: 'Hong Kong dollar', symbols: ['HK$'], words: ['hong kong dollars'] },
  { code: 'INR', name: 'Indian rupee', symbols: ['₹', 'Rs.', 'Rs'], words: ['indian rupees'] },
  { code: 'CHF', name: 'Swiss franc', symbols: ['Fr.', 'SFr.'], words: ['swiss francs', 'francs'] },
  { code: 'SEK', name: 'Swedish krona', symbols: [], words: ['swedish kronor', 'kronor'] },
  { code: 'NOK', name: 'Norwegian krone', symbols: [], words: ['norwegian kroner'] },
  { code: 'DKK', name: 'Danish krone', symbols: [], words: ['danish kroner'] },
  { code: 'ISK', name: 'Icelandic króna', symbols: [], words: [] },
  { code: 'PLN', name: 'Polish złoty', symbols: ['zł'], words: ['zloty', 'złoty', 'zlotys'] },
  { code: 'CZK', name: 'Czech koruna', symbols: ['Kč'], words: [] },
  { code: 'HUF', name: 'Hungarian forint', symbols: ['Ft'], words: ['forint'] },
  { code: 'RON', name: 'Romanian leu', symbols: ['lei'], words: [] },
  { code: 'BGN', name: 'Bulgarian lev', symbols: [], words: [] },
  { code: 'JPY', name: 'Japanese yen', symbols: [], words: ['yen'] },
  { code: 'CNY', name: 'Chinese yuan', symbols: ['RMB'], words: ['yuan', 'renminbi'] },
  { code: 'KRW', name: 'South Korean won', symbols: ['₩'], words: [] },
  { code: 'TWD', name: 'New Taiwan dollar', symbols: ['NT$'], words: [] },
  { code: 'BRL', name: 'Brazilian real', symbols: ['R$'], words: ['reais'] },
  { code: 'MXN', name: 'Mexican peso', symbols: ['MX$', 'Mex$'], words: ['mexican pesos'] },
  { code: 'ARS', name: 'Argentine peso', symbols: [], words: [] },
  { code: 'CLP', name: 'Chilean peso', symbols: [], words: [] },
  { code: 'COP', name: 'Colombian peso', symbols: [], words: [] },
  { code: 'ZAR', name: 'South African rand', symbols: [], words: ['rand'] },
  { code: 'SAR', name: 'Saudi riyal', symbols: ['SR'], words: ['saudi riyals'] },
  { code: 'QAR', name: 'Qatari riyal', symbols: ['QR'], words: ['qatari riyals'] },
  { code: 'ILS', name: 'Israeli shekel', symbols: ['₪'], words: ['shekels', 'nis'] },
  { code: 'TRY', name: 'Turkish lira', symbols: ['₺'], words: ['turkish lira'] },
  { code: 'UAH', name: 'Ukrainian hryvnia', symbols: ['₴'], words: ['hryvnia'] },
  { code: 'RSD', name: 'Serbian dinar', symbols: [], words: [] },
  { code: 'NGN', name: 'Nigerian naira', symbols: ['₦'], words: ['naira'] },
  { code: 'KES', name: 'Kenyan shilling', symbols: ['KSh'], words: [] },
  { code: 'EGP', name: 'Egyptian pound', symbols: ['E£'], words: ['egyptian pounds'] },
  { code: 'PKR', name: 'Pakistani rupee', symbols: [], words: [] },
  { code: 'PHP', name: 'Philippine peso', symbols: ['₱'], words: ['philippine pesos'] },
  { code: 'IDR', name: 'Indonesian rupiah', symbols: ['Rp'], words: ['rupiah'] },
  { code: 'MYR', name: 'Malaysian ringgit', symbols: ['RM'], words: ['ringgit'] },
  { code: 'THB', name: 'Thai baht', symbols: ['฿'], words: ['baht'] },
  { code: 'VND', name: 'Vietnamese dong', symbols: ['₫'], words: [] },
];

/** Symbols/words shared by several currencies → candidate codes. */
export const AMBIGUOUS_CURRENCY_TOKENS: Readonly<Record<string, readonly string[]>> = {
  $: ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'MXN'],
  dollar: ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD'],
  dollars: ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD'],
  '¥': ['JPY', 'CNY'],
  '￥': ['JPY', 'CNY'],
  kr: ['SEK', 'NOK', 'DKK', 'ISK'],
  'kr.': ['SEK', 'NOK', 'DKK', 'ISK'],
  kroner: ['NOK', 'DKK'],
  krone: ['NOK', 'DKK'],
  riyal: ['SAR', 'QAR', 'OMR'],
  riyals: ['SAR', 'QAR', 'OMR'],
  rupees: ['INR', 'PKR', 'LKR'],
  pesos: ['MXN', 'ARS', 'CLP', 'COP', 'PHP'],
};

const BY_CODE = new Map(CURRENCIES.map((cur) => [cur.code, cur]));
export const CURRENCY_CODES: readonly string[] = CURRENCIES.map((cur) => cur.code);

export function getCurrency(code: string): CurrencyDef | undefined {
  return BY_CODE.get(code.toUpperCase());
}

export interface CurrencyResolution {
  /** Resolved ISO code, or null when the token is ambiguous/unknown. */
  code: string | null;
  /** Candidate codes when ambiguous (empty when resolved or unknown). */
  candidates: readonly string[];
}

/**
 * Resolves a currency token as written in a posting: ISO code (`gbp`/`GBP`), symbol (`£`, `C$`),
 * or word (`euros`). `$` and other shared tokens return `code: null` with candidates.
 */
export function resolveCurrencyToken(token: string): CurrencyResolution {
  const t = token.trim();
  if (!t) return { code: null, candidates: [] };
  const ambiguous = AMBIGUOUS_CURRENCY_TOKENS[t] ?? AMBIGUOUS_CURRENCY_TOKENS[t.toLowerCase()];
  if (ambiguous) return { code: null, candidates: ambiguous };
  if (/^[A-Za-z]{3}$/.test(t) && BY_CODE.has(t.toUpperCase()))
    return { code: t.toUpperCase(), candidates: [] };
  for (const cur of CURRENCIES) {
    if (cur.symbols.includes(t)) return { code: cur.code, candidates: [] };
  }
  const lower = t.toLowerCase();
  for (const cur of CURRENCIES) {
    if (cur.words.includes(lower)) return { code: cur.code, candidates: [] };
  }
  return { code: null, candidates: [] };
}

/** All currency tokens usable as prefixes/suffixes, longest first (for building parsers). */
export function currencyTokens(): string[] {
  const tokens = new Set<string>();
  for (const cur of CURRENCIES) {
    tokens.add(cur.code);
    for (const s of cur.symbols) tokens.add(s);
  }
  for (const k of Object.keys(AMBIGUOUS_CURRENCY_TOKENS)) {
    if (!/^[a-z]+$/.test(k)) tokens.add(k);
  }
  tokens.add('kr');
  return [...tokens].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/** Spelled-out currency words (lower-case), longest first. */
export function currencyWords(): string[] {
  const words = new Set<string>();
  for (const cur of CURRENCIES) for (const w of cur.words) words.add(w);
  for (const k of Object.keys(AMBIGUOUS_CURRENCY_TOKENS)) if (/^[a-z]+$/.test(k)) words.add(k);
  return [...words].sort((a, b) => b.length - a.length || a.localeCompare(b));
}
