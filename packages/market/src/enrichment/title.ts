import {
  classifyRoleFamily,
  classifySeniority,
  classifySpecialization,
  FAMILY_DEPARTMENTS,
} from '@aptamind/taxonomy';
import type { JobInterpretation } from '../contracts/employment';
import { spanOf, syntheticSpan } from './text';
import type { Interpreted } from './text';

/**
 * Title interpretation: a cleaned display title plus role family, specialisation, seniority and
 * department. Location/work-model decorations ("(Remote - US)", "| London") are removed from the
 * normalised title because they are interpreted separately.
 */

export type TitleInterpretation = JobInterpretation['title']['value'];

const ABBREVIATIONS: ReadonlyArray<[RegExp, string]> = [
  [/\bSr\.?(?=\s|$)/gi, 'Senior'],
  [/\bSnr\.?(?=\s|$)/gi, 'Senior'],
  [/\bJr\.?(?=\s|$)/gi, 'Junior'],
  [/\bEng\.?(?=\s|$|,)/g, 'Engineer'],
  [/\bMgr\.?(?=\s|$|,)/gi, 'Manager'],
  [/\bDev\b(?!\s*ops)/g, 'Developer'],
  [/\bSWE\b/g, 'Software Engineer'],
  [/\bVP\b/g, 'VP'],
];

const DECORATION =
  /\b(?:remote|hybrid|on-?site|in-?office|anywhere|wfh|work from home|relocation|visa|sponsorship|contract|full[\s-]?time|part[\s-]?time|m\/f\/d|f\/m\/d|w\/m\/d|m\/w\/d)\b/i;

/** Cleans a raw title for display and matching. */
export function normalizeTitle(title: string): string {
  let t = title.replace(/[\s\u00a0]+/g, ' ').trim();
  // Drop bracketed decorations: "(Remote, US)", "[Hybrid]", "(m/f/d)".
  t = t.replace(/\s*[([]([^)\]]*)[)\]]/g, (whole, inner: string) =>
    DECORATION.test(inner) || looksLikePlace(inner) ? '' : whole,
  );
  // Drop trailing " - Remote", " | London", " – Berlin (Hybrid)" segments.
  const parts = t.split(/\s+[|–—]\s+|\s+-\s+/);
  if (parts.length > 1) {
    const kept = [parts[0] ?? ''];
    for (const part of parts.slice(1)) {
      if (!(DECORATION.test(part) || looksLikePlace(part))) kept.push(part);
    }
    t = kept.join(' - ');
  }
  for (const [re, replacement] of ABBREVIATIONS) t = t.replace(re, replacement);
  return t
    .replace(/\s+,/g, ',')
    .replace(/[\s,\-–|]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Heuristic: a decoration segment that is only a place list ("London", "NYC / SF", "US or Canada"). */
function looksLikePlace(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned || cleaned.length > 40) return false;
  return (
    /^(?:[A-Z][\p{L}.'-]*(?:\s+[A-Z][\p{L}.'-]*)*)(?:\s*(?:,|\/|or|&|and)\s*[A-Z][\p{L}.'-]*(?:\s+[A-Z][\p{L}.'-]*)*)*$/u.test(
      cleaned,
    ) &&
    /\b(?:UK|US|USA|EU|EMEA|APAC|LATAM|London|Berlin|New York|NYC|SF|San Francisco|Dublin|Paris|Amsterdam|Toronto|Remote|Europe|Canada|Germany|India|Singapore|Dubai|Lisbon|Madrid|Barcelona|Warsaw|Sydney)\b/.test(
      cleaned,
    )
  );
}

export function interpretTitle(
  title: string,
  providerDepartment?: string | null,
): Interpreted<TitleInterpretation> {
  const normalized = normalizeTitle(title);
  const family = classifyRoleFamily(normalized);
  const specialization = classifySpecialization(normalized);
  const seniority = classifySeniority(normalized);
  const department = providerDepartment?.trim() || (family ? FAMILY_DEPARTMENTS[family.family] : null);

  const evidence = [];
  if (title.trim()) evidence.push(spanOf('title', title, 0, title.length));
  if (providerDepartment?.trim())
    evidence.push(syntheticSpan('provider', `department: ${providerDepartment.trim()}`));

  const value: TitleInterpretation = {
    original: title,
    normalized,
    roleFamily: family?.family ?? (normalized ? 'other' : null),
    specialization: specialization?.specialization ?? null,
    seniority: seniority?.level ?? 'unclear',
    department,
  };
  if (!normalized) return { value, confidence: 'unknown', evidence: [], basis: 'none' };
  const confidence = family && seniority ? 'high' : family ? 'medium' : 'low';
  return { value, confidence, evidence, basis: 'title.rules' };
}
