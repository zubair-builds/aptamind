import type { EvidenceSpan, JobInterpretation } from '../contracts/employment';

/**
 * Shared text utilities for deterministic job interpretation: offset-preserving segmentation,
 * evidence-span construction and the small `Interpreted<T>` shape used by every module.
 */

export type Confidence = JobInterpretation['workModel']['confidence'];
export type EvidenceField = EvidenceSpan['field'];

export interface Interpreted<T> {
  value: T;
  confidence: Confidence;
  evidence: EvidenceSpan[];
  basis: string;
}

export interface Segment {
  text: string;
  /** Inclusive start offset into the source text. */
  start: number;
  /** Exclusive end offset into the source text. */
  end: number;
}

export interface InterpretationFlag {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'high';
  /**
   * The value a flag reports: only `sponsorship_stated` carries one, the stated `yes` / `no`
   * (012d041; narrowed in 8d96663 L3).
   */
  value?: 'yes' | 'no';
  /** `sponsorship_stated` of a country-specific key: the countries it applies to (bc013e8). */
  scope?: string[];
  /** The text the flag is about (e.g. the structured line of `sponsorship_stated`). */
  evidence?: EvidenceSpan;
}

/** Evidence quotes are capped so reviewers see a readable excerpt; offsets always match the quote. */
export const MAX_QUOTE_LENGTH = 300;

/** Text fields evidence can point into. Location evidence points into `locationTexts.join('\n')`. */
export interface SourceTexts {
  title: string;
  description: string;
  location: string;
}

/** Joins listed locations into the single text that `location` evidence offsets refer to. */
export function locationFieldText(locationTexts: readonly string[]): string {
  return locationTexts.join('\n');
}

/**
 * Evidence span over `[start, end)` of a field text. Whitespace at the edges is trimmed and the
 * span is capped at {@link MAX_QUOTE_LENGTH}; `quote` is always exactly `text.slice(start, end)`.
 */
export function spanOf(field: EvidenceField, text: string, start: number, end: number): EvidenceSpan {
  let s = Math.max(0, Math.min(start, text.length));
  let e = Math.max(s, Math.min(end, text.length));
  while (s < e && /\s/.test(text[s] ?? '')) s++;
  while (e > s && /\s/.test(text[e - 1] ?? '')) e--;
  if (e - s > MAX_QUOTE_LENGTH) e = s + MAX_QUOTE_LENGTH;
  return { field, start: s, end: e, quote: text.slice(s, e) };
}

export function spanOfSegment(field: EvidenceField, text: string, seg: Segment): EvidenceSpan {
  return spanOf(field, text, seg.start, seg.end);
}

/** Evidence without a source text (provider structured fields, company registry facts). */
export function syntheticSpan(field: EvidenceField, quote: string): EvidenceSpan {
  return { field, quote: quote.slice(0, MAX_QUOTE_LENGTH) };
}

/** Lines of text with offsets (blank lines skipped, edges trimmed). */
export function lines(text: string): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  for (const raw of text.split('\n')) {
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) out.push({ text: trimmed, start: pos + lead, end: pos + lead + trimmed.length });
    pos += raw.length + 1;
  }
  return out;
}

const ABBREVIATIONS =
  /(?:\b(?:e\.g|i\.e|etc|vs|approx|incl|inc|ltd|co|dept|min|max|no|jr|sr|mr|ms|dr|st|p\.a|u\.s|u\.k)\.|\b[A-Z]\.)$/i;

/**
 * Sentences with offsets: splits each line at sentence punctuation followed by whitespace and an
 * upper-case/quote/bullet character, skipping common abbreviations ("e.g.", "U.S.", "p.a.").
 */
export function sentences(text: string): Segment[] {
  const out: Segment[] = [];
  for (const line of lines(text)) {
    let segStart = 0;
    const re = /[.!?;](?=\s+["'“(\p{Lu}\d•-])/gu;
    for (const m of line.text.matchAll(re)) {
      const endInLine = m.index + 1;
      const candidate = line.text.slice(segStart, endInLine);
      if (ABBREVIATIONS.test(candidate)) continue;
      pushTrimmed(out, line, segStart, endInLine);
      segStart = endInLine;
    }
    pushTrimmed(out, line, segStart, line.text.length);
  }
  return out;
}

/** Sentences of one segment, with offsets into the segment's source text. */
export function sentencesOf(seg: Segment): Segment[] {
  return sentences(seg.text).map((s) => ({
    text: s.text,
    start: s.start + seg.start,
    end: s.end + seg.start,
  }));
}

function pushTrimmed(out: Segment[], line: Segment, from: number, to: number): void {
  const slice = line.text.slice(from, to);
  const lead = slice.length - slice.trimStart().length;
  const trimmed = slice.trim();
  if (!trimmed) return;
  const start = line.start + from + lead;
  out.push({ text: trimmed, start, end: start + trimmed.length });
}

/** Strips a leading bullet marker ("- ", "• ", "* ", "1. ") and returns the item with its offset. */
export function stripBullet(seg: Segment): Segment & { bullet: boolean } {
  const m = seg.text.match(/^(?:[-•*·▪◦‣–—]|\d{1,2}[.)])\s+/);
  if (!m) return { ...seg, bullet: false };
  return { text: seg.text.slice(m[0].length), start: seg.start + m[0].length, end: seg.end, bullet: true };
}

const CONF_RANK: Record<Confidence, number> = { unknown: 0, low: 1, medium: 2, high: 3 };

export function maxConfidence(a: Confidence, b: Confidence): Confidence {
  return CONF_RANK[a] >= CONF_RANK[b] ? a : b;
}

export function minConfidence(a: Confidence, b: Confidence): Confidence {
  return CONF_RANK[a] <= CONF_RANK[b] ? a : b;
}

/** Stable de-duplication preserving first-seen order. */
export function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/** An `unknown` interpretation with neutral value and no evidence. */
export function unknown<T>(value: T, basis = 'none'): Interpreted<T> {
  return { value, confidence: 'unknown', evidence: [], basis };
}
