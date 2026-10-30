/**
 * Text-matching primitives shared by every taxonomy lookup.
 *
 * All matching is Unicode-aware with explicit word boundaries (letters/digits on either side
 * block a match), so "India" never matches inside "Indiana" and "go" never matches "google".
 */

export interface TextMatch {
  matchedText: string;
  /** Offset of the match in the searched text (UTF-16 code units, i.e. JS string index). */
  index: number;
}

/** Boundary guards: a term must not be glued to letters/digits (or `+`/`#` for C++/C#-style terms). */
export const BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}_])';
export const BOUNDARY_AFTER = '(?![\\p{L}\\p{N}_])';

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Lower-cases, strips diacritics-insensitive whitespace differences and trims, for dictionary keys. */
export function normalizeKey(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Escaped regex source for a term where any whitespace run matches flexibly. */
function termSource(term: string): string {
  return term
    .trim()
    .split(/\s+/)
    .map((part) => escapeRegExp(part))
    .join('\\s+');
}

export interface TermEntry<V> {
  term: string;
  value: V;
  /** Case-sensitive terms only match with the given casing (e.g. `US`, adjectives like `Polish`). */
  caseSensitive?: boolean;
}

export interface TermMatch<V> extends TextMatch {
  value: V;
}

/**
 * Dictionary matcher: finds every non-overlapping occurrence of any term (longest match wins at
 * a position). Terms may carry an optional `reject` predicate for context-dependent false positives.
 */
export class TermMatcher<V> {
  private readonly ci: RegExp | null;
  private readonly cs: RegExp | null;
  private readonly ciMap = new Map<string, V>();
  private readonly csMap = new Map<string, V>();

  constructor(
    entries: ReadonlyArray<TermEntry<V>>,
    private readonly reject?: (text: string, match: TermMatch<V>) => boolean,
  ) {
    const ciTerms: string[] = [];
    const csTerms: string[] = [];
    for (const e of entries) {
      const term = e.term.trim();
      if (!term) continue;
      if (e.caseSensitive) {
        const key = term.replace(/\s+/g, ' ');
        if (!this.csMap.has(key)) {
          this.csMap.set(key, e.value);
          csTerms.push(term);
        }
      } else {
        const key = normalizeKey(term);
        if (!this.ciMap.has(key)) {
          this.ciMap.set(key, e.value);
          ciTerms.push(term);
        }
      }
    }
    this.ci = ciTerms.length ? buildRegex(ciTerms, 'giu') : null;
    this.cs = csTerms.length ? buildRegex(csTerms, 'gu') : null;
  }

  find(text: string): Array<TermMatch<V>> {
    const found: Array<TermMatch<V>> = [];
    if (this.ci) {
      for (const m of text.matchAll(this.ci)) {
        const value = this.ciMap.get(normalizeKey(m[0]));
        if (value !== undefined) found.push({ value, matchedText: m[0], index: m.index });
      }
    }
    if (this.cs) {
      for (const m of text.matchAll(this.cs)) {
        const value = this.csMap.get(m[0].replace(/\s+/g, ' '));
        if (value !== undefined) found.push({ value, matchedText: m[0], index: m.index });
      }
    }
    const kept = selectNonOverlapping(found);
    return this.reject ? kept.filter((m) => !this.reject?.(text, m)) : kept;
  }

  /** Exact (whole-string) lookup: case-sensitive terms first, then case-insensitive. */
  lookup(term: string): V | undefined {
    const trimmed = term.trim().replace(/\s+/g, ' ');
    return this.csMap.get(trimmed) ?? this.ciMap.get(normalizeKey(trimmed));
  }
}

function buildRegex(terms: string[], flags: string): RegExp {
  const sorted = [...terms].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const alternation = sorted.map(termSource).join('|');
  // Terms ending in punctuation (e.g. "U.S.") must not require a letter boundary after the dot.
  return new RegExp(`${BOUNDARY_BEFORE}(?:${alternation})${BOUNDARY_AFTER}`, flags);
}

/** Greedy non-overlapping selection: earliest first, longest wins on ties. Output sorted by index. */
export function selectNonOverlapping<T extends TextMatch>(matches: T[]): T[] {
  const sorted = [...matches].sort(
    (a, b) => a.index - b.index || b.matchedText.length - a.matchedText.length,
  );
  const out: T[] = [];
  let end = -1;
  for (const m of sorted) {
    if (m.index >= end) {
      out.push(m);
      end = m.index + m.matchedText.length;
    }
  }
  return out;
}

/** True when `[start, end)` overlaps any of the given matches. */
export function overlapsAny(start: number, end: number, others: ReadonlyArray<TextMatch>): boolean {
  return others.some((o) => start < o.index + o.matchedText.length && o.index < end);
}

/**
 * Detects "shouting" headings such as "JOIN US" or "ABOUT US": the match sits after an all-caps
 * word on the same line and is followed by nothing or another all-caps word.
 */
export function isInAllCapsRun(text: string, index: number, length: number): boolean {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const lineEndRaw = text.indexOf('\n', index + length);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  const before = text.slice(lineStart, index).match(/([\p{L}]+)[^\p{L}\n]*$/u);
  const after = text.slice(index + length, lineEnd).match(/^[^\p{L}\n]*([\p{L}]+)/u);
  const isCapsWord = (w: string | undefined) =>
    !!w && w.length >= 2 && w === w.toUpperCase() && /\p{Lu}/u.test(w);
  const prev = before?.[1];
  const next = after?.[1];
  if (!isCapsWord(prev) || (prev?.length ?? 0) < 3) return false;
  return next === undefined || isCapsWord(next);
}
