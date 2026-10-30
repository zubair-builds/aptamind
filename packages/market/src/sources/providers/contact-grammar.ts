import { domainToASCII } from 'node:url';
import { parse } from 'tldts';

/**
 * The standard email notations as a grammar (DECISION_LOG b24e5dd, af1b342), matched over tokens
 * instead of by regular expressions:
 *
 *     ADDRESS  := LOCAL GAP AT-FORM GAP LABEL (GAP-WITH-A-DOT-FORM LABEL)+
 *     GAP      := any run of SEP and DOT-FORM tokens (`jane.at.acme.com`), possibly empty; between
 *                 labels it must hold at least one DOT-FORM (`acme.dot.com`, `acme (dot).com`)
 *     AT-FORM  := an `@`-like character | `at` | `arroba` (a whole word) | `(a)` in a bracket pair
 *                 (Unicode `Bidi_Paired_Bracket` pairs, `<>`, `﴾﴿`, or any two quotes)
 *     DOT-FORM := `.` | `·` | `‧` | `•` | `dot` / `punto` / `punkt` / `point` / `ponto` (whole words)
 *     SEP      := any run of characters that are neither letters nor digits (and no AT/DOT-FORM)
 *
 * Brackets are separators, so every bracketed form — `[at]`, `( AT )`, `{dot}`, `<.>`, `[ . ]` —
 * is the bare form between separators (`(a)` alone needs its brackets: a bare `a` is a word).
 *     LOCAL, LABEL := a word (letters, digits and marks of any script); a keyword spelled in
 *                 letters (`at`, `arroba`, `dot`) may also be a LOCAL or a LABEL (`jane at at dot
 *                 com` is jane@at.com) — every reading is tried, within a bounded search
 *
 * and the labels joined by `.` must form a registrable domain on an ICANN public suffix (tldts;
 * Unicode and punycode `xn--…` suffixes included). A hyphen is ambiguous — a separator
 * (`jane-at-acme-dot-com`) or part of a label (`smith-consult`, `xn--p1ai`) — so the text is
 * tokenised twice and matches if either tokenisation matches:
 *   - `separator`: a hyphen separates words (a punycode `xn--` prefix stays part of its label);
 *   - `label`: a hyphen joins words into one label, except around a whole hyphen-delimited
 *     `at` / `arroba` / `dot` (`smith-consult-dot-ae` → `smith-consult` DOT `ae`).
 * Any prefix of the label chain that is registrable matches, and so does a chain whose last label
 * is cut before one of its hyphen runs (`acme-corp.com-ref7` → `acme-corp.com`).
 *
 * The search fails CLOSED (DECISION_LOG 6bff30e): it has a cost budget (token visits and domain
 * parses); a text it cannot decide within it is `undecided`, which counts as a contact value. A
 * chain is pruned as soon as it holds a label no domain can have (over 63 characters).
 */

export type AddressTokenKind = 'word' | 'at' | 'dot' | 'sep';
export interface AddressToken {
  kind: AddressTokenKind;
  text: string;
}
export type HyphenMode = 'separator' | 'label';

export interface AddressGrammarOptions {
  /** `false`: only an `@`-like character is an at-form (URL hosts: `jobs-at-acme.com` is a real host). */
  atWords?: boolean;
}

// Sticky (`y`) patterns matched at the tokeniser's position: linear in the text length.
const AT_CHAR = /[@\uff20\ufe6b]/uy;
/**
 * `(a)` between an opener and a closer that pair: a Unicode `Bidi_Paired_Bracket` pair
 * (BidiBrackets.txt, embedded below: `⦍a⦐` pairs, `⦍a⦎` does not), `<a>`, `﴾a﴿`, or any two quotes
 * in either order (`"a"`, `'a'`, `»a«`, `„a“`, `〝a〟`, `⹂a“`).
 */
const BRACKET_A = /([\p{Ps}\p{Pi}\p{Pf}<"'﴾＂＇])\s*a\s*([\p{Pe}\p{Pf}\p{Pi}>"'﴿〞〟＂＇])/iuy;
/** Unicode 15 BidiBrackets.txt: opening → closing bracket (`Bidi_Paired_Bracket`). */
// prettier-ignore
const BIDI_PAIRS: ReadonlyArray<[number, number]> = [
  [0x0028, 0x0029], [0x005b, 0x005d], [0x007b, 0x007d], [0x0f3a, 0x0f3b], [0x0f3c, 0x0f3d],
  [0x169b, 0x169c], [0x2045, 0x2046], [0x207d, 0x207e], [0x208d, 0x208e], [0x2308, 0x2309],
  [0x230a, 0x230b], [0x2329, 0x232a], [0x2768, 0x2769], [0x276a, 0x276b], [0x276c, 0x276d],
  [0x276e, 0x276f], [0x2770, 0x2771], [0x2772, 0x2773], [0x2774, 0x2775], [0x27c5, 0x27c6],
  [0x27e6, 0x27e7], [0x27e8, 0x27e9], [0x27ea, 0x27eb], [0x27ec, 0x27ed], [0x27ee, 0x27ef],
  [0x2983, 0x2984], [0x2985, 0x2986], [0x2987, 0x2988], [0x2989, 0x298a], [0x298b, 0x298c],
  [0x298d, 0x2990], [0x298f, 0x298e], [0x2991, 0x2992], [0x2993, 0x2994], [0x2995, 0x2996],
  [0x2997, 0x2998], [0x29d8, 0x29d9], [0x29da, 0x29db], [0x29fc, 0x29fd], [0x2e22, 0x2e23],
  [0x2e24, 0x2e25], [0x2e26, 0x2e27], [0x2e28, 0x2e29], [0x2e55, 0x2e56], [0x2e57, 0x2e58],
  [0x2e59, 0x2e5a], [0x2e5b, 0x2e5c], [0x3008, 0x3009], [0x300a, 0x300b], [0x300c, 0x300d],
  [0x300e, 0x300f], [0x3010, 0x3011], [0x3014, 0x3015], [0x3016, 0x3017], [0x3018, 0x3019],
  [0x301a, 0x301b], [0xfe59, 0xfe5a], [0xfe5b, 0xfe5c], [0xfe5d, 0xfe5e], [0xff08, 0xff09],
  [0xff3b, 0xff3d], [0xff5b, 0xff5d], [0xff5f, 0xff60], [0xff62, 0xff63],
];
const CLOSER_OF = new Map<number, number>([...BIDI_PAIRS, [0x3c, 0x3e], [0xfd3e, 0xfd3f]]);
const QUOTE = /^[\p{Pi}\p{Pf}"'‚„⹂〝〞〟＂＇]$/u;
/** Whether `close` closes `open`: a `Bidi_Paired_Bracket` pair, `<>`, `﴾﴿`, or any two quotes. */
export function bracketsPair(open: string, close: string): boolean {
  if (QUOTE.test(open) && QUOTE.test(close)) return true;
  return CLOSER_OF.get(open.codePointAt(0)!) === close.codePointAt(0);
}
const WORD_SEPARATOR_MODE = /(?:xn--)?[\p{L}\p{N}\p{M}]+/iuy;
const WORD_LABEL_MODE = /[\p{L}\p{N}\p{M}]+(?:-+[\p{L}\p{N}\p{M}]+)*/uy;
const ANY_CHAR = /[\s\S]/uy;
const WORD_START = /^[\p{L}\p{N}\p{M}]$/u;
/** No hostname is longer (RFC 1035): a label chain past these bounds cannot be a domain. */
const MAX_DOMAIN_CHARS = 253;
const MAX_DOMAIN_LABELS = 127;
const AT_WORDS = new Set(['at', 'arroba']);
/** Dot words (English, Spanish/Italian, German, French, Portuguese). */
const DOT_WORDS = new Set(['dot', 'punto', 'punkt', 'point', 'ponto']);
/** Dot characters: the full stop and its middle-dot look-alikes. */
const DOT_CHARS = new Set(['.', '\u00b7', '\u2027', '\u2022']);

function wordKind(word: string, atWords: boolean): AddressTokenKind {
  const w = word.toLowerCase();
  if (DOT_WORDS.has(w)) return 'dot';
  if (atWords && AT_WORDS.has(w)) return 'at';
  return 'word';
}

/** Tokenise `text` for the address grammar (see the module comment). */
export function tokenizeAddress(
  text: string,
  hyphen: HyphenMode,
  opts: AddressGrammarOptions = {},
): AddressToken[] {
  const atWords = opts.atWords !== false;
  const tokens: AddressToken[] = [];
  const push = (kind: AddressTokenKind, t: string) => {
    const last = tokens[tokens.length - 1];
    if (kind === 'sep' && last?.kind === 'sep') last.text += t;
    else tokens.push({ kind, text: t });
  };
  const at = (re: RegExp, i: number) => {
    re.lastIndex = i;
    return re.exec(text);
  };
  const wordRe = hyphen === 'separator' ? WORD_SEPARATOR_MODE : WORD_LABEL_MODE;
  let i = 0;
  while (i < text.length) {
    let m: RegExpExecArray | null;
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    // A word character starts a word: skip the symbol patterns (the tokeniser's hot path).
    const wordStart = WORD_START.test(ch);
    if (!wordStart && (m = at(AT_CHAR, i))) {
      push('at', m[0]);
    } else if (!wordStart && atWords && (m = at(BRACKET_A, i)) && bracketsPair(m[1]!, m[2]!)) {
      push('at', m[0]);
    } else if (DOT_CHARS.has(ch)) {
      m = at(ANY_CHAR, i)!;
      push('dot', m[0]);
    } else if (wordStart && (m = at(wordRe, i))) {
      if (hyphen === 'label' && m[0].includes('-')) {
        // Split out whole hyphen-delimited keywords: `smith-consult-dot-ae`, `jane-at-acme`.
        const parts = m[0].split(/(-+)/);
        let label = '';
        const flush = () => {
          if (label) push('word', label);
          label = '';
        };
        for (let k = 0; k < parts.length; k += 2) {
          const part = parts[k]!;
          const kind = wordKind(part, atWords);
          if (kind === 'word') {
            label += (label ? parts[k - 1] : '') + part;
          } else {
            flush();
            if (k > 0) push('sep', parts[k - 1]!);
            push(kind, part);
            if (k + 1 < parts.length) push('sep', parts[k + 1]!);
          }
        }
        flush();
      } else push(wordKind(m[0], atWords), m[0]);
    } else {
      m = at(ANY_CHAR, i)!;
      push('sep', m[0]);
    }
    i += m[0].length;
  }
  return tokens;
}

/** Whether labels joined by `.` are a registrable domain on an ICANN public suffix. */
export function isRegistrableLabels(labels: string[]): boolean {
  if (labels.length < 2) return false;
  const t = labels.join('.').toLowerCase();
  return memo(REGISTRABLE_MEMO, t, () => {
    const p = parse(t, { allowPrivateDomains: false });
    return !!p.domain && !!p.domainWithoutSuffix && p.isIcann === true && p.hostname === t;
  });
}

/**
 * Memoised expensive primitives (DECISION_LOG bd6ad44): the PSL parse of a label chain and the
 * punycode length of a label, per process and bounded (cleared when full). Memoisation only makes
 * a repeat cheaper: the search charges every call to its budget whether or not it was cached, so
 * a verdict never depends on what was mapped before.
 */
const MEMO_LIMIT = 20_000;
const REGISTRABLE_MEMO = new Map<string, boolean>();
const ASCII_LENGTH_MEMO = new Map<string, number>();
/**
 * The work budget of the row being mapped (DECISION_LOG 47c0f5c): one fixed, deterministic budget
 * shared by every detector call while a row is mapped, charged in grammar units (a token visited,
 * `PARSE_COST` per domain parse, a tokenised character, a scanned reading). Exhausting it throws
 * `RowBudgetExhausted`, which every detector entry point turns into an undecided verdict, so the
 * rest of the row fails closed. Outside a row (`beginRow` not called) nothing is charged.
 */
export class RowBudgetExhausted extends Error {}
let rowBudget: { left: number; units: number } | null = null;
let rowGeneration = 0;
let lastRowUsed = 0;
/** Tokenisations of the row being mapped, per distinct text (a row repeats its texts). */
const ROW_TOKENS = new Map<string, AddressToken[]>();
export function beginRow(units: number): void {
  rowBudget = { left: units, units };
  rowGeneration++;
  ROW_TOKENS.clear();
}
export function endRow(): void {
  lastRowUsed = rowBudget ? Math.min(rowBudget.units, rowBudget.units - rowBudget.left) : 0;
  rowBudget = null;
  rowGeneration++;
  ROW_TOKENS.clear();
}
/** The current row (a new number per row: callers key per-row memos on it). */
export function currentRow(): number {
  return rowGeneration;
}
/** The units the last mapped row used (at most its budget). */
export function lastRowUnits(): number {
  return lastRowUsed;
}
/** The units left in the row's budget (null outside a row). */
export function rowBudgetLeft(): number | null {
  return rowBudget ? rowBudget.left : null;
}
/** Charges the row's budget; throws `RowBudgetExhausted` once it is spent (and on every later charge). */
export function chargeRow(units: number): void {
  if (rowBudget && (rowBudget.left -= units) < 0) throw new RowBudgetExhausted();
}
/** `tokenizeAddress`, memoised per row and charged one unit per character on a miss. */
export function tokenizeForRow(
  text: string,
  hyphen: HyphenMode,
  opts: AddressGrammarOptions = {},
): AddressToken[] {
  if (!rowBudget) return tokenizeAddress(text, hyphen, opts);
  const key = `${hyphen}|${opts.atWords === false ? 0 : 1}|${text}`;
  let tokens = ROW_TOKENS.get(key);
  if (!tokens) {
    chargeRow(text.length);
    tokens = tokenizeAddress(text, hyphen, opts);
    ROW_TOKENS.set(key, tokens);
  }
  return tokens;
}

/** Clears the memoised primitives (tests measure per-row cost cold-cache: DECISION_LOG 64d97b4). */
export function clearDetectorCaches(): void {
  REGISTRABLE_MEMO.clear();
  ASCII_LENGTH_MEMO.clear();
}
function memo<V>(m: Map<string, V>, key: string, compute: () => V): V {
  const hit = m.get(key);
  if (hit !== undefined) return hit;
  const v = compute();
  if (m.size >= MEMO_LIMIT) m.clear();
  m.set(key, v);
  return v;
}

/** The grammar's verdict on a text: an address, none, or undecided within the cost budget. */
export type AddressVerdict = 'match' | 'none' | 'undecided';

/** Cost budget per text: one unit per token visited, `PARSE_COST` per domain parse. */
const SEARCH_BUDGET = 4000;
const PARSE_COST = 20;
/** No DNS label is longer: a chain holding a longer label is pruned. */
const MAX_LABEL_CHARS = 63;

class BudgetExhausted extends Error {}

/** Whether a token list contains an ADDRESS of the grammar (see `AddressVerdict`). */
export function tokensMatchAddress(
  tokens: AddressToken[],
  budget = { left: SEARCH_BUDGET },
  domainOnly = false,
): AddressVerdict {
  const spend = (n: number) => {
    budget.left -= n;
    if (budget.left < 0) throw new BudgetExhausted();
    chargeRow(n);
  };
  const registrable = (labels: string[]) => {
    spend(PARSE_COST);
    return isRegistrableLabels(labels);
  };
  /** A bracketed `(a)` or a keyword spelled in letters may also be a local part or a label. */
  const letterKeyword = (t: AddressToken | undefined) =>
    !!t && (t.kind === 'at' || t.kind === 'dot') && (/^\p{L}+$/u.test(t.text) || isBracketA(t.text));
  const wordLike = (t: AddressToken | undefined) => !!t && (t.kind === 'word' || letterKeyword(t));
  const symbolDot = (t: AddressToken | undefined) => !!t && t.kind === 'dot' && !letterKeyword(t);
  const labelOf = (t: AddressToken) => (isBracketA(t.text) ? 'a' : t.text);
  /**
   * A label length as DNS counts it: the punycode (ASCII) form (`bücher` → `xn--bcher-kva`). A
   * non-ASCII label costs a domain parse (`domainToASCII`), charged to the budget on every call.
   */
  const validLabel = (label: string) => {
    if (label.length === 0) return false;
    if (!/[^ -~]/.test(label)) return label.length <= MAX_LABEL_CHARS; // printable ASCII
    spend(PARSE_COST);
    return asciiLength(label) <= MAX_LABEL_CHARS;
  };

  /**
   * Label candidates after `pos`: word-like tokens reachable over separators and dot-forms (a
   * letter keyword is both a candidate and a dot-form to step over); with `needDot`, only those
   * with at least one dot-form before them. A word, or an at-form, ends the gap.
   */
  const candidates = (pos: number, needDot: boolean): number[] => {
    const out: number[] = [];
    let dots = 0;
    for (let k = pos; k < tokens.length; k++) {
      spend(1);
      const t = tokens[k]!;
      if (t.kind === 'sep') continue;
      if (symbolDot(t)) {
        dots++;
        continue;
      }
      if (wordLike(t) && (!needDot || dots > 0)) out.push(k);
      if (t.kind === 'dot') {
        dots++;
        continue;
      }
      break; // a word or an at-form ends the gap
    }
    return out;
  };

  const extend = (pos: number, labels: string[], chars: number): boolean => {
    for (const q of candidates(pos, true)) {
      const label = labelOf(tokens[q]!);
      const base = chars + 1;
      // Bounded: no hostname exceeds 253 characters or 127 labels (linear, not quadratic).
      if (base > MAX_DOMAIN_CHARS || labels.length >= MAX_DOMAIN_LABELS) return false;
      const next = [...labels, label];
      const total = base + label.length;
      const valid = validLabel(label);
      if (valid && total <= MAX_DOMAIN_CHARS && registrable(next)) return true;
      // The address may run into more text joined by a hyphen (`acme-corp.com-ref7`, a job slug):
      // the last label cut before each hyphen run, sliced from the label itself so a punycode
      // `xn--` is kept (`xn--p1ai-ref7` → `xn`, `xn--p1ai`); only cuts that fit a hostname. The
      // cuts come BEFORE any length prune (DECISION_LOG 29b6592): `com-aaaa…` (70 characters) is
      // no label, but its cut `com` is (`smith-consult.com-aaaa…`).
      for (const run of label.matchAll(/-+/g)) {
        if (base + run.index > MAX_DOMAIN_CHARS) break;
        const cut = label.slice(0, run.index);
        if (validLabel(cut) && registrable([...labels, cut])) return true;
      }
      // Pruned only where no reading survives: a chain cannot continue past a label no domain can
      // have (its cuts were tried above).
      if (valid && extend(q + 1, next, total)) return true;
    }
    return false;
  };

  try {
    // `domainOnly`: any registrable domain chain, starting at any word-like token (no at-form).
    if (domainOnly) {
      for (let j = 0; j < tokens.length; j++) {
        spend(1);
        if (!wordLike(tokens[j]) || !validLabel(labelOf(tokens[j]!))) continue;
        const label = labelOf(tokens[j]!);
        if (extend(j + 1, [label], label.length)) return 'match';
      }
      return 'none';
    }
    for (let i = 0; i < tokens.length; i++) {
      spend(1);
      if (tokens[i]!.kind !== 'at') continue;
      // LOCAL: the nearest word-like token before the at-form, over separators and symbol dots
      // (`jane.at.acme.com`, `dot at acme dot com`, `arroba at acme.com`).
      let p = i - 1;
      while (p >= 0 && (tokens[p]!.kind === 'sep' || symbolDot(tokens[p]))) {
        spend(1);
        p--;
      }
      if (p < 0 || !wordLike(tokens[p])) continue;
      // The first label: any word-like token reachable over separators and dot-forms
      // (`jane at at dot com` → at.com, `jane dot at dot acme dot com` → acme.com).
      for (const j of candidates(i + 1, false)) {
        const label = labelOf(tokens[j]!);
        // A first label no domain can have starts no chain (it is never the cut last label).
        if (validLabel(label) && extend(j + 1, [label], label.length)) return 'match';
      }
    }
    return 'none';
  } catch (err) {
    if (err instanceof BudgetExhausted) return 'undecided';
    throw err;
  }
}

/**
 * A label's length in its punycode (ASCII) form, as DNS limits it. Memoised. A label of more than
 * `3 × 63` code points that IDNA does not delete can never encode to 63 characters (NFC composes
 * at most three code points into one, a Hangul L+V+T syllable, and punycode spends at least one
 * character per code point), so it is too long without being encoded: `domainToASCII` never runs
 * on long text.
 */
function asciiLength(label: string): number {
  if (!/[^ -~]/.test(label)) return label.length; // printable ASCII
  return memo(ASCII_LENGTH_MEMO, label, () => {
    let kept = 0;
    for (const ch of label)
      if (!/\p{Default_Ignorable_Code_Point}/u.test(ch) && ++kept > 3 * MAX_LABEL_CHARS) break;
    if (kept > 3 * MAX_LABEL_CHARS) return MAX_LABEL_CHARS + 1;
    const ascii = domainToASCII(label);
    return ascii ? ascii.length : label.length;
  });
}

/** Whether a token's text is a bracketed `(a)`. */
function isBracketA(text: string): boolean {
  return text.length > 1 && /^\P{L}\s*a\s*\P{L}$/iu.test(text);
}

/** Necessary conditions of an ADDRESS (a cheap pre-check): some at-form and some dot-form. */
const AT_HINT = /[@\uff20\ufe6b]|at|arroba|[\p{Ps}\p{Pi}\p{Pf}<"'\ufd3e\uff02\uff07]\s*a/iu;
const AT_CHAR_HINT = /[@\uff20\ufe6b]/u;
// Derived from the dot-form sets, so the pre-check can never drift from the grammar.
const DOT_HINT = new RegExp(
  `[${[...DOT_CHARS].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}]|${[...DOT_WORDS].join('|')}`,
  'iu',
);

export function addressGrammarVerdict(text: string, opts: AddressGrammarOptions = {}): AddressVerdict {
  if (!DOT_HINT.test(text) || !(opts.atWords === false ? AT_CHAR_HINT : AT_HINT).test(text)) return 'none';
  // One budget for both tokenisations of the text; the row's budget as well (DECISION_LOG 47c0f5c).
  const budget = { left: SEARCH_BUDGET };
  let undecided = false;
  try {
    for (const mode of ['separator', 'label'] as const) {
      const v = tokensMatchAddress(tokenizeForRow(text, mode, opts), budget);
      if (v === 'match') return 'match';
      if (v === 'undecided') undecided = true;
    }
  } catch (err) {
    if (err instanceof RowBudgetExhausted) return 'undecided';
    throw err;
  }
  return undecided ? 'undecided' : 'none';
}

/**
 * Whether `text` holds a domain-shaped sequence — labels joined by any dot-form or dot word into a
 * registrable domain (`gmail.com`, `gmail/dot/com`, `gmail(dot)co.uk`) — anywhere; `undecided`
 * when the bounded search cannot tell (callers fail closed).
 */
export function domainShapedVerdict(text: string): AddressVerdict {
  if (!DOT_HINT.test(text)) return 'none';
  const budget = { left: SEARCH_BUDGET };
  let undecided = false;
  try {
    for (const mode of ['separator', 'label'] as const) {
      const v = tokensMatchAddress(tokenizeForRow(text, mode), budget, true);
      if (v === 'match') return 'match';
      if (v === 'undecided') undecided = true;
    }
  } catch (err) {
    if (err instanceof RowBudgetExhausted) return 'undecided';
    throw err;
  }
  return undecided ? 'undecided' : 'none';
}

/** Whether `text` contains an address of the grammar — or cannot be decided (fails closed). */
export function matchesAddressGrammar(text: string, opts: AddressGrammarOptions = {}): boolean {
  return addressGrammarVerdict(text, opts) !== 'none';
}
