import {
  currencyOfCountry,
  currencyTokens,
  currencyWords,
  escapeRegExp,
  resolveCurrencyToken,
} from '@aptamind/taxonomy';
import type { Compensation, EvidenceSpan } from '../contracts/employment';
import { sentences, spanOf, syntheticSpan } from './text';
import type { Confidence, Interpreted, InterpretationFlag } from './text';

/**
 * Salary normalisation (FR-17). Parses amounts, ranges, currencies and pay periods from salary
 * text, annualises with explicit assumptions, and never turns missing or vague pay into zero.
 *
 * Status semantics: `parsed` (amount + currency + period known), `ambiguous` (amount known but
 * currency or period not determinable), `malformed` (contradictory numbers), `unknown` (no
 * numeric pay, e.g. "Competitive salary", "TBD").
 */

export type PayPeriod = NonNullable<Compensation['period']>;

export interface SalaryHints {
  /** Countries the job is located in (used only to resolve shared symbols such as `$`). */
  countries?: readonly string[];
  /** Employment type, used to classify day/hour rates as contract rates. */
  employmentType?: string | null;
}

export const ANNUALIZATION: Readonly<Record<PayPeriod, { factor: number; assumption: string | null }>> = {
  hour: { factor: 2080, assumption: '2080 working hours per year (40 h/week × 52 weeks)' },
  day: { factor: 260, assumption: '260 working days per year (5 days/week × 52 weeks)' },
  week: { factor: 52, assumption: '52 weeks per year' },
  month: { factor: 12, assumption: '12 months per year' },
  year: { factor: 1, assumption: null },
};

/** Numbers: Indian lakh grouping (25,00,000), thousands-grouped (50,000 / 45.000 / 45 000), plain. */
const NUM = String.raw`\d{1,2}(?:,\d{2})+,\d{3}|\d{1,3}(?:[,.\u00a0\u202f ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const CURRENCY_PREFIX = currencyTokens().map(escapeRegExp).join('|');
const CURRENCY_WORDS = currencyWords()
  .map((w) => escapeRegExp(w).replace(/ /g, '\\s+'))
  .join('|');

/**
 * One money token: optional currency prefix, number, optional `k`, optional big-number unit
 * (millions → not a salary), optional currency suffix (code, symbol or word).
 */
const MONEY = new RegExp(
  String.raw`(?:(?<![\p{L}\p{N}])(?<pre>${CURRENCY_PREFIX})\s?|(?<![\p{L}\p{N}.,]))(?<num>${NUM})(?![\d])(?:\s?(?<k>[kK])(?![\p{L}]))?(?:\s?(?<big>m|M|mn|MM|bn|million|billion)(?![\p{L}]))?(?:\s?(?<post>${CURRENCY_PREFIX}|${CURRENCY_WORDS})(?![\p{L}]))?`,
  'gu',
);

const RANGE_SEPARATOR = /^\s*(?:-|–|—|~|to|and|until|bis|à|a)\s*$/i;

const PERIOD_PATTERNS: ReadonlyArray<{ period: PayPeriod; pattern: RegExp }> = [
  {
    period: 'year',
    pattern:
      /(?:per\s+(?:annum|year)|p\.\s?a\.?|\bpa\b|\/\s?(?:year|yr|annum|jahr|an|a)\b|\ba\s+year\b|\bannual(?:ly)?\b|\byearly\b|per\s+yr\b|brutto\s*\/?\s*(?:pro\s+|im\s+)?jahr|pro\s+jahr|im\s+jahr|jährlich|par\s+an\b|\bannum\b|\bOTE\b)/i,
  },
  {
    period: 'month',
    pattern:
      /(?:per\s+month|\/\s?(?:month|mo|mth|monat)\b|\ba\s+month\b|\bmonthly\b|\bp\.\s?m\.?(?![a-z])|pro\s+monat|monatlich|par\s+mois)/i,
  },
  {
    period: 'week',
    pattern: /(?:per\s+week|\/\s?(?:week|wk)\b|\ba\s+week\b|\bweekly\b|\bp\.\s?w\.?(?![a-z]))/i,
  },
  {
    period: 'day',
    pattern:
      /(?:per\s+day|\/\s?(?:day|d)\b|\ba\s+day\b|\bdaily\b|\bday\s+rate\b|\bp\.\s?d\.?(?![a-z])|per\s+diem|pro\s+tag|par\s+jour)/i,
  },
  {
    period: 'hour',
    pattern:
      /(?:per\s+hour|\/\s?(?:hour|hr|h)\b|\ban\s+hour\b|\bhourly\b|\bp\.\s?h\.?(?![a-z])|pro\s+stunde|par\s+heure|\/\s?std\b)/i,
  },
];

const VAGUE =
  /\b(?:competitive|tbd|tbc|to\s+be\s+(?:determined|confirmed|discussed)|doe|depending\s+on\s+experience|dependent\s+on\s+experience|negotiable|market\s+rate|attractive|excellent|commensurate)\b/i;
const SALARY_KEYWORD =
  /\b(?:salary|salaries|compensation|pay|paid|base|OTE|on[\s-]target|rate|range|per\s+annum|remuneration|package|earn(?:ing)?s?|wage|brutto|gehalt|stipend|TC|total\s+comp)\b/i;
const FUNDING =
  /\b(?:raised|funding|series\s+[a-f]|revenue|ARR|valuation|investors?|customers|users|backed|round)\b/i;
const BENEFIT =
  /\b(?:budget|allowance|pension|401\(?k\)?|learning|wellness|gym|equipment|referral|home\s+office|stipend|bonus|equity|insurance)\b/i;

const BENEFIT_NOUN =
  /\b(?:budget|allowance|stipend|bonus|pension|401\(?k\)?|credit|voucher|reimbursement|grant|insurance|leave|holiday|referral|funding|raise[ds]?)\b/i;

interface MoneyToken {
  value: number;
  currencyToken: string | null;
  /** All currency tokens written around the amount ("$150k USD" → ['$', 'USD']). */
  currencyTokens: string[];
  hasK: boolean;
  start: number;
  end: number;
  raw: string;
}

/** Parses "50,000", "45.000", "45 000", "1.234,56", "45.5" into a number (null if not numeric). */
export function parseAmount(raw: string): number | null {
  const s = raw.replace(/[\u00a0\u202f ]/g, (m, offset: number, str: string) =>
    /\d/.test(str[offset - 1] ?? '') && /^\d{3}(?!\d)/.test(str.slice(offset + 1)) ? '' : m,
  );
  if (/^\d+$/.test(s)) return Number(s);
  if (/^\d{1,2}(?:,\d{2})+,\d{3}$/.test(s)) return Number(s.replace(/,/g, ''));
  const grouped = s.match(/^\d{1,3}([.,])\d{3}(?:\1\d{3})*$/);
  if (grouped) return Number(s.replace(/[.,]/g, ''));
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    const decimalSep = lastComma > lastDot ? ',' : '.';
    const thousandsSep = decimalSep === ',' ? '.' : ',';
    const n = Number(s.split(thousandsSep).join('').replace(decimalSep, '.'));
    return Number.isFinite(n) ? n : null;
  }
  if (/^\d+[.,]\d{1,2}$/.test(s)) return Number(s.replace(',', '.'));
  return null;
}

function tokenize(text: string): MoneyToken[] {
  const out: MoneyToken[] = [];
  for (const m of text.matchAll(MONEY)) {
    const g = m.groups ?? {};
    if (g.big) continue; // "$10M Series A" is funding, not pay
    const value = parseAmount(g.num ?? '');
    if (value === null) continue;
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 12);
    if (/^\s*(?:%|percent|\+?\s*years?|yrs?|employees|people|staff|hours?\s+(?:per|a)\s+week)/i.test(after))
      continue;
    // Amounts that qualify a benefit ("£1,000 learning budget", "$5k signing bonus") are not pay;
    // "£50k + bonus" is, so the check stops at connectors.
    const tail =
      text
        .slice(m.index + m[0].length, m.index + m[0].length + 35)
        .split(/[,;.+&(]|\bplus\b|\band\b|\bwith\b/i)[0] ?? '';
    if (BENEFIT_NOUN.test(tail)) continue;
    // Years such as "2025" without currency are not pay.
    if (!g.pre && !g.post && !g.k && /^(?:19|20)\d{2}$/.test(g.num ?? '')) continue;
    out.push({
      value: g.k ? value * 1000 : value,
      currencyToken: (g.pre ?? g.post ?? null)?.trim() ?? null,
      currencyTokens: [g.pre, g.post].filter((x): x is string => !!x).map((x) => x.trim()),
      hasK: !!g.k,
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
    });
  }
  return out;
}

function detectPeriod(
  text: string,
  start: number,
  end: number,
): { period: PayPeriod; explicit: boolean } | null {
  const lineEnd = text.indexOf('\n', end);
  const after = text.slice(end, Math.min(lineEnd === -1 ? text.length : lineEnd, end + 45));
  let best: { period: PayPeriod; index: number } | null = null;
  for (const { period, pattern } of PERIOD_PATTERNS) {
    const m = after.match(pattern);
    if (m && m.index !== undefined && (!best || m.index < best.index)) best = { period, index: m.index };
  }
  if (best) return { period: best.period, explicit: true };
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const before = text.slice(Math.max(lineStart, start - 45), start);
  let closest: { period: PayPeriod; index: number } | null = null;
  for (const { period, pattern } of PERIOD_PATTERNS) {
    const re = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
    for (const m of before.matchAll(re)) {
      if (!closest || m.index > closest.index) closest = { period, index: m.index };
    }
  }
  return closest ? { period: closest.period, explicit: true } : null;
}

function basisOf(text: string, period: PayPeriod | null, hints: SalaryHints): Compensation['basis'] {
  if (/\bOTE\b|on[\s-]target\s+earnings/i.test(text)) return 'ote';
  if (/\btotal\s+(?:comp(?:ensation)?|rewards?|package)\b|\bTC\b/i.test(text)) return 'total_compensation';
  if (
    period === 'day' ||
    /\b(?:day\s+rate|contract\s+rate|daily\s+rate|(?:inside|outside)\s+ir35)\b/i.test(text) ||
    ((period === 'hour' || period === 'week') &&
      /contract|freelance|temporary/.test(hints.employmentType ?? ''))
  ) {
    return 'contract_rate';
  }
  if (/\b(?:base|salary|per\s+annum|p\.\s?a\.?|brutto)\b/i.test(text)) return 'base_salary';
  return 'unknown';
}

const MAJOR_ANNUAL_CURRENCIES = new Set([
  'GBP',
  'USD',
  'EUR',
  'CAD',
  'AUD',
  'NZD',
  'CHF',
  'SGD',
  'HKD',
  'ILS',
]);

function emptyCompensation(originalText: string | null, warnings: string[] = []): Compensation {
  return {
    status: 'unknown',
    min: null,
    max: null,
    currency: null,
    period: null,
    basis: 'unknown',
    annualized: null,
    equityText: null,
    bonusText: null,
    originalText,
    warnings,
  };
}

function resolveCurrency(
  token: string | null,
  hints: SalaryHints,
  warnings: string[],
): { code: string | null; ambiguous: boolean } {
  if (!token) return { code: null, ambiguous: false };
  const res = resolveCurrencyToken(token);
  if (res.code) return { code: res.code, ambiguous: false };
  if (!res.candidates.length) return { code: null, ambiguous: false };
  const countryCurrencies = new Set(
    (hints.countries ?? []).map((c) => currencyOfCountry(c)).filter((c): c is string => !!c),
  );
  const matching = res.candidates.filter((c) => countryCurrencies.has(c));
  if (matching.length === 1 && matching[0]) {
    warnings.push(`Currency symbol "${token}" resolved to ${matching[0]} from the job location.`);
    return { code: matching[0], ambiguous: false };
  }
  warnings.push(
    `Currency symbol "${token}" is ambiguous (${res.candidates.join('/')}) and the job location does not resolve it.`,
  );
  return { code: null, ambiguous: true };
}

/** Annualised equivalents, or null when the period is unknown. */
export function annualize(
  min: number | null,
  max: number | null,
  period: PayPeriod | null,
): Compensation['annualized'] {
  if (!period || (min === null && max === null)) return null;
  const { factor, assumption } = ANNUALIZATION[period];
  const round = (n: number | null) => (n === null ? null : Math.round(n * factor * 100) / 100);
  return { min: round(min), max: round(max), assumptions: assumption ? [assumption] : [] };
}

/**
 * Normalises a salary text such as "£50,000 - £60,000 per annum", "$120k–$150k", "USD 45/hr",
 * "€45.000 - €55.000 brutto/Jahr", "AED 25,000 per month", "up to £70k" or "Competitive".
 * `hints.countries` resolves shared symbols (`$` → USD only for US jobs).
 */
export function normalizeSalary(text: string, hints: SalaryHints = {}): Compensation {
  const original = text.trim();
  if (!original) return emptyCompensation(null);
  const warnings: string[] = [];
  const tokens = tokenize(original);
  const hasCurrencyContext = tokens.some((t) => t.currencyToken) || SALARY_KEYWORD.test(original);
  const qualifies = (t: MoneyToken) => !!t.currencyToken || t.hasK || (hasCurrencyContext && t.value >= 100);

  // Primary amount: the first qualifying token or range ("50-60k GBP" qualifies through its upper bound).
  let low: MoneyToken | null = null;
  let high: MoneyToken | null = null;
  for (let i = 0; i < tokens.length && !low; i++) {
    const t = tokens[i] as MoneyToken;
    const next = tokens[i + 1];
    if (
      next &&
      RANGE_SEPARATOR.test(original.slice(t.end, next.start)) &&
      (qualifies(t) || qualifies(next))
    ) {
      low = t;
      high = next;
    } else if (qualifies(t)) {
      low = t;
    }
  }

  if (!low) {
    if (VAGUE.test(original) || SALARY_KEYWORD.test(original)) warnings.push('No numeric salary stated.');
    return emptyCompensation(original, warnings);
  }

  let minValue: number | null = low.value;
  let maxValue: number | null = high ? high.value : low.value;
  // Shared "k" suffix: "50-60k" → 50k–60k.
  if (high && high.hasK && !low.hasK && low.value < 1000) minValue = low.value * 1000;
  if (high && low.hasK && !high.hasK && high.value < 1000) maxValue = high.value * 1000;

  const prefixWindow = original.slice(Math.max(0, low.start - 20), low.start);
  // "£80k+" / "£80,000+ per year": an open-ended minimum. "£80k + bonus" is base plus extras.
  const suffix = original.slice(low.end, low.end + 24);
  const openEnded =
    !high &&
    /^\s?\+(?!\s*(?:\d|bonus|equity|commission|benefits|stock|shares|options|OTE|RSUs?|super|pension|allowance)\b)/i.test(
      suffix,
    );
  if (openEnded) {
    maxValue = null;
    warnings.push('Open-ended amount ("+"): minimum only.');
  } else if (!high) {
    if (/\b(?:up\s+to|max(?:imum)?|to|as\s+much\s+as|no\s+more\s+than|capped\s+at)\s*$/i.test(prefixWindow))
      minValue = null;
    else if (
      /\b(?:from|starting\s+(?:at|from)|min(?:imum)?|at\s+least|upwards\s+of|in\s+excess\s+of|over)\s*$/i.test(
        prefixWindow,
      )
    ) {
      maxValue = null;
    }
  }

  // An explicit, unambiguous currency anywhere around the amount wins over a shared symbol:
  // "$150k USD" and "$120k - $150k USD" are USD whatever the job's country.
  const written = [...low.currencyTokens, ...(high?.currencyTokens ?? [])];
  const explicit = written.find((t) => resolveCurrencyToken(t).code);
  const currencyToken = explicit ?? low.currencyToken ?? high?.currencyToken ?? null;
  const currency = resolveCurrency(currencyToken, hints, warnings);
  if (!currencyToken) warnings.push('No currency stated.');

  const periodInfo = detectPeriod(original, low.start, (high ?? low).end);
  let period: PayPeriod | null = periodInfo?.period ?? null;
  let inferredPeriod = false;
  const reference = maxValue ?? minValue ?? 0;
  if (!period) {
    const code = currency.code ?? (currencyToken === '$' ? 'USD' : null);
    if ((low.hasK || high?.hasK || reference >= 20000) && (!code || MAJOR_ANNUAL_CURRENCIES.has(code))) {
      period = 'year';
      inferredPeriod = true;
      warnings.push('Pay period not stated; inferred yearly from the amount.');
    } else {
      warnings.push('Pay period not stated.');
    }
  }

  const base = basisOf(original, period, hints);
  const compensation: Compensation = {
    ...emptyCompensation(original, warnings),
    currency: currency.code,
    period,
    basis: base,
  };

  // Malformed: zero amounts or inverted ranges.
  if ((minValue !== null && minValue <= 0) || (maxValue !== null && maxValue <= 0)) {
    warnings.push('Salary amount is zero.');
    return { ...compensation, status: 'malformed', period: null, basis: 'unknown' };
  }
  if (minValue !== null && maxValue !== null && maxValue < minValue) {
    warnings.push(`Salary range is inverted (${low.raw.trim()} > ${high?.raw.trim() ?? ''}).`);
    return { ...compensation, status: 'malformed', period: null, basis: 'unknown' };
  }
  if (minValue !== null && maxValue !== null && maxValue / minValue > 5) {
    warnings.push('Salary range spans more than 5×; check the source.');
  }
  if (period && !inferredPeriod) {
    const annual = (maxValue ?? minValue ?? 0) * ANNUALIZATION[period].factor;
    if (annual > 5_000_000 && MAJOR_ANNUAL_CURRENCIES.has(currency.code ?? ''))
      warnings.push('Annualised pay is implausibly high.');
  }

  const status: Compensation['status'] = currency.code && period ? 'parsed' : 'ambiguous';
  return {
    ...compensation,
    status,
    min: minValue,
    max: maxValue,
    annualized: annualize(minValue, maxValue, period),
  };
}

export interface SalaryTextMatch {
  text: string;
  start: number;
  end: number;
}

/** Picks the sentence of a description most likely to state pay (null when none does). */
export function findSalaryText(description: string): SalaryTextMatch | null {
  let best: { score: number; seg: SalaryTextMatch } | null = null;
  let vague: SalaryTextMatch | null = null;
  for (const seg of sentences(description)) {
    const tokens = tokenize(seg.text);
    const keyword = SALARY_KEYWORD.test(seg.text);
    const withCurrency = tokens.some((t) => t.currencyToken);
    const withNumber = tokens.some((t) => t.hasK || t.value >= 100);
    const period = PERIOD_PATTERNS.some((p) => p.pattern.test(seg.text));
    let score =
      (withCurrency ? 3 : keyword && withNumber ? 1 : 0) +
      (keyword ? 2 : 0) +
      (period && (withCurrency || withNumber) ? 1 : 0);
    if (BENEFIT.test(seg.text) && !keyword) score -= 3;
    if (FUNDING.test(seg.text)) score -= 4;
    if (!withCurrency && !withNumber) score = 0;
    if (score >= 3 && (!best || score > best.score)) best = { score, seg };
    if (
      !vague &&
      keyword &&
      VAGUE.test(seg.text) &&
      /\b(?:salary|compensation|pay|rate|remuneration|package)\b/i.test(seg.text)
    ) {
      vague = seg;
    }
  }
  if (best) return { text: best.seg.text, start: best.seg.start, end: best.seg.end };
  return vague ? { text: vague.text, start: vague.start, end: vague.end } : null;
}

/**
 * "Bonus" as pay, not as an idiom. "As a bonus, you have …", "Preferred qualifications are a
 * bonus", "Bonus points if …" say nothing about compensation; "annual bonus", "eligible for a
 * bonus", "salary plus bonus", "bonus of 10%" do.
 */
const BONUS_IDIOM =
  /\b(?:as\s+an?\s+(?:added\s+|big\s+|huge\s+|nice\s+|extra\s+)?bonus|(?:is|are|be|would\s+be|will\s+be|considered|counts?\s+as)\s+(?:an?\s+)?(?:added\s+|big\s+|huge\s+|nice\s+|definite\s+|real\s+|major\s+)?bonus\b(?!\s+(?:of|scheme|plan|program))|bonus\s+points?|(?:a|an)\s+bonus\s+if|bonus\s+(?:if|skills?|qualifications?|experience))/i;
const BONUS_PAY =
  /\b(?:(?:annual|yearly|quarterly|monthly|performance|performance-based|discretionary|signing|sign-on|joining|retention|referral|target|cash|company|team|year-end|holiday)[\s-]+bonus(?:es)?|bonus(?:es)?\s+(?:scheme|plan|program(?:me)?|structure|eligibility|potential|pool|of|up\s+to|target)|eligib(?:le|ility)\s+for\s+(?:an?\s+)?(?:\w+\s+)?bonus|(?:salary|pay|base|compensation|package|remuneration|OTE)\b[^.;]{0,60}\bbonus|\bbonus(?:es)?\b[^.;]{0,30}(?:%|£|\$|€|\d))/i;

function bonusSentence(description: string): string | null {
  for (const seg of sentences(description)) {
    if (!/\bbonus(?:es)?\b/i.test(seg.text)) continue;
    if (BONUS_PAY.test(seg.text) && !BONUS_IDIOM.test(seg.text)) return seg.text.slice(0, 300);
  }
  return null;
}

function extraText(description: string, pattern: RegExp): string | null {
  for (const seg of sentences(description)) if (pattern.test(seg.text)) return seg.text.slice(0, 300);
  return null;
}

export interface CompensationInput {
  description: string;
  provider?: {
    text?: string | null;
    min?: number | null;
    max?: number | null;
    currency?: string | null;
    period?: PayPeriod | null;
  } | null;
  hints: SalaryHints;
}

export interface CompensationResult {
  compensation: Interpreted<Compensation>;
  flags: InterpretationFlag[];
}

function confidenceOf(c: Compensation, explicitPeriod: boolean): Confidence {
  switch (c.status) {
    case 'parsed':
      return explicitPeriod && !c.warnings.some((w) => /resolved to/.test(w)) ? 'high' : 'medium';
    case 'ambiguous':
    case 'malformed':
      return 'low';
    default:
      return 'unknown';
  }
}

const differs = (a: number | null, b: number | null) =>
  a !== null && b !== null && Math.abs(a - b) > Math.max(1, Math.abs(b) * 0.01);

/**
 * Compensation for a job. Structured provider values take precedence over text when present;
 * disagreements with the text are kept as warnings rather than silently resolved.
 */
export function interpretCompensation(input: CompensationInput): CompensationResult {
  const { description, hints } = input;
  const provider = input.provider ?? null;
  const flags: InterpretationFlag[] = [];
  const equityText = extraText(description, /\b(?:equity|stock\s+options?|RSUs?|share\s+options?|ESOP)\b/i);
  const bonusText = bonusSentence(description);

  const providerText = provider?.text?.trim() || null;
  const descMatch = findSalaryText(description);
  const textSource: { comp: Compensation; evidence: EvidenceSpan[] } | null = providerText
    ? { comp: normalizeSalary(providerText, hints), evidence: [syntheticSpan('provider', providerText)] }
    : descMatch
      ? {
          comp: normalizeSalary(descMatch.text, hints),
          evidence: [spanOf('description', description, descMatch.start, descMatch.end)],
        }
      : null;

  const toNumber = (n: number | null | undefined) =>
    typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
  const pMin = toNumber(provider?.min);
  const pMax = toNumber(provider?.max);

  let comp: Compensation;
  let evidence: EvidenceSpan[];
  let basis: string;
  let explicitPeriod = true;

  if (pMin !== null || pMax !== null) {
    const warnings: string[] = [];
    if ((provider?.min === 0 || provider?.max === 0) && (pMin === null || pMax === null)) {
      warnings.push('Provider reported a zero amount; treated as missing.');
    }
    const providerCurrency =
      provider?.currency && /^[A-Za-z]{3}$/.test(provider.currency) ? provider.currency.toUpperCase() : null;
    const text = textSource?.comp;
    const currency = providerCurrency ?? text?.currency ?? null;
    let period: PayPeriod | null = provider?.period ?? text?.period ?? null;
    if (!provider?.period) explicitPeriod = false;
    if (!period && (pMax ?? pMin ?? 0) >= 20000) {
      period = 'year';
      warnings.push('Pay period not stated; inferred yearly from the amount.');
    }
    if (text && (text.status === 'parsed' || text.status === 'ambiguous')) {
      const mismatches: string[] = [];
      if (text.currency && providerCurrency && text.currency !== providerCurrency)
        mismatches.push(`currency ${text.currency}`);
      if (differs(text.min, pMin) || differs(text.max, pMax))
        mismatches.push(`range ${text.min ?? '?'}–${text.max ?? '?'}`);
      if (text.period && provider?.period && text.period !== provider.period)
        mismatches.push(`period ${text.period}`);
      if (mismatches.length) {
        warnings.push(
          `Provider structured compensation differs from the salary text (${mismatches.join(', ')}); using provider values.`,
        );
        flags.push({
          code: 'compensation_source_conflict',
          message: warnings[warnings.length - 1] ?? '',
          severity: 'warning',
        });
      }
    }
    if (pMin !== null && pMax !== null && pMax < pMin) {
      warnings.push('Provider salary range is inverted.');
      comp = {
        ...emptyCompensation(providerText ?? text?.originalText ?? null, warnings),
        status: 'malformed',
      };
    } else {
      comp = {
        status: currency && period ? 'parsed' : 'ambiguous',
        min: pMin,
        max: pMax,
        currency,
        period,
        basis: text?.basis ?? basisOf(providerText ?? '', period, hints),
        annualized: annualize(pMin, pMax, period),
        equityText: null,
        bonusText: null,
        originalText: providerText ?? text?.originalText ?? null,
        warnings,
      };
    }
    const structuredQuote =
      `compensation: ${pMin ?? '?'}–${pMax ?? '?'} ${providerCurrency ?? ''} ${provider?.period ?? ''}`.trim();
    evidence = [syntheticSpan('provider', structuredQuote), ...(textSource?.evidence ?? [])];
    basis = 'provider.compensation';
  } else if (textSource) {
    comp = textSource.comp;
    evidence = textSource.evidence;
    basis = providerText ? 'provider.compensationText' : 'description.explicit';
    explicitPeriod = !comp.warnings.some((w) => /inferred yearly/.test(w));
  } else {
    comp = emptyCompensation(null);
    evidence = [];
    basis = 'none';
  }

  comp = { ...comp, equityText: comp.equityText ?? equityText, bonusText: comp.bonusText ?? bonusText };
  if (comp.status === 'malformed' || comp.status === 'ambiguous') {
    flags.push({
      code: `compensation_${comp.status}`,
      message: comp.warnings.join(' ') || `Compensation is ${comp.status}.`,
      severity: comp.status === 'malformed' ? 'warning' : 'info',
    });
  }
  const confidence = confidenceOf(comp, explicitPeriod);
  return {
    compensation: {
      value: comp,
      confidence,
      evidence: confidence === 'unknown' && !comp.originalText ? [] : evidence,
      basis,
    },
    flags,
  };
}
