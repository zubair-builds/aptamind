import { findSkills, HUMAN_LANGUAGES, REQUIREMENT_CATEGORY_RULES } from '@aptamind/taxonomy';
import type { Requirement } from '../contracts/employment';
import { detectSections } from './sections';
import type { Section, SectionKind } from './sections';
import { spanOf } from './text';
import type { Segment } from './text';

/**
 * Requirement extraction (FR-18). Each bullet/sentence in a requirements-type section becomes a
 * structured requirement with importance (critical / important / preferred / incidental),
 * explicitness, years of experience, category, a normalised concept from the skills taxonomy and an
 * evidence span. Outside such sections only sentences with explicit cue words ("must have",
 * "is a plus") are extracted.
 */

export type RequirementImportance = Requirement['importance'];
export type RequirementCategory = Requirement['category'];

const PREFERRED_CUE =
  /\b(?:nice[\s-]to[\s-]have|(?:is\s+|are\s+|would\s+be\s+)?an?\s+(?:big\s+|huge\s+|strong\s+)?(?:plus|bonus|advantage)|bonus\s+points?|preferred|preferably|ideally|desirable|would\s+be\s+(?:great|nice|beneficial|helpful)|advantageous|not\s+(?:strictly\s+)?required|optional|good\s+to\s+have)\b/i;
const CRITICAL_CUE =
  /\b(?:must|required|requirement|essential|mandatory|minimum\s+of|at\s+least|need\s+to\s+have|non[\s-]negotiable|you\s+will\s+need|necessary|proven)\b/i;
const INCIDENTAL_CUE =
  /\b(?:exposure\s+to|awareness\s+of|interest\s+in|curiosity\s+(?:about|for)|passion\s+for|enthusiasm\s+for|familiarity\s+with)\b/i;
const OUT_OF_SECTION_CUE =
  /\b(?:you\s+must\s+have|must\s+have|is\s+(?:a\s+)?(?:must|required|essential)|are\s+required|is\s+(?:a\s+)?(?:plus|bonus)|nice\s+to\s+have|would\s+be\s+a\s+plus|experience\s+(?:with|in)\s+[^.]{2,60}\s+is\s+(?:required|essential|a\s+plus))\b/i;

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twelve: 12,
  fifteen: 15,
};

/** Minimum years of experience stated in a requirement ("5+ years", "3-5 yrs", "at least five years"). */
export function parseYears(text: string): number | null {
  const digits = text.match(/\b(\d{1,2})\s*\+?\s*(?:(?:-|–|to)\s*\d{1,2}\s*\+?\s*)?(?:years?|yrs?)\b/i);
  if (digits?.[1]) {
    const n = Number(digits[1]);
    return n <= 40 ? n : null;
  }
  const words = text.match(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen)\s*\+?\s*(?:(?:-|–|to|or)\s*\w+\s*)?(?:\(\d+\)\s*)?years?\b/i,
  );
  if (words?.[1]) return WORD_NUMBERS[words[1].toLowerCase()] ?? null;
  return null;
}

/** Category of a requirement item (taxonomy keyword rules, then skills, then experience). */
export function categorize(text: string, years: number | null, skill: string | null): RequirementCategory {
  for (const rule of REQUIREMENT_CATEGORY_RULES) {
    if (rule.category === 'soft_skill') continue;
    if (rule.pattern.test(text)) return rule.category;
  }
  if (years !== null) return 'experience';
  if (skill) return 'skill';
  const soft = REQUIREMENT_CATEGORY_RULES.find((r) => r.category === 'soft_skill');
  if (soft?.pattern.test(text)) return 'soft_skill';
  if (/\bexperience\b/i.test(text)) return 'experience';
  return 'other';
}

function conceptOf(text: string, category: RequirementCategory, skill: string | null): string | null {
  if (category === 'language') {
    const lang = HUMAN_LANGUAGES.find((l) => new RegExp(`\\b${l}\\b`, 'i').test(text));
    return lang ?? null;
  }
  if (category === 'authorization') return 'work_authorization';
  if (category === 'education')
    return /\b(?:ph\.?d|doctorate)\b/i.test(text)
      ? 'doctorate'
      : /\bmaster/i.test(text)
        ? 'masters_degree'
        : 'degree';
  return skill;
}

interface ImportanceDecision {
  importance: RequirementImportance;
  explicit: boolean;
}

function importanceOf(text: string, section: SectionKind | null): ImportanceDecision {
  if (section === 'preferred') return { importance: 'preferred', explicit: true };
  if (PREFERRED_CUE.test(text)) return { importance: 'preferred', explicit: true };
  if (section === 'must_have') return { importance: 'critical', explicit: true };
  if (CRITICAL_CUE.test(text)) return { importance: 'critical', explicit: true };
  if (section === 'stack') return { importance: 'incidental', explicit: false };
  if (INCIDENTAL_CUE.test(text)) return { importance: 'incidental', explicit: false };
  return { importance: 'important', explicit: false };
}

const REQUIREMENT_SECTIONS: ReadonlySet<SectionKind> = new Set([
  'must_have',
  'requirements',
  'preferred',
  'stack',
]);
const MAX_REQUIREMENTS = 60;

function build(
  description: string,
  item: Segment,
  section: Section | null,
  outOfSection: boolean,
): Requirement | null {
  const text = item.text.replace(/[;,.]\s*$/, '').trim();
  if (text.length < 3 || /^[\p{P}\s]+$/u.test(text)) return null;
  const years = parseYears(text);
  const skill = findSkills(text)[0]?.concept ?? null;
  const category = categorize(text, years, skill);
  const { importance, explicit } = importanceOf(text, section?.kind ?? null);
  const confidence = outOfSection
    ? 'medium'
    : explicit
      ? 'high'
      : importance === 'incidental'
        ? 'low'
        : 'medium';
  return {
    text,
    normalizedConcept: conceptOf(text, category, skill),
    category,
    importance,
    explicitness: explicit ? 'explicit' : 'inferred',
    yearsMin: years,
    section: section?.heading ?? null,
    evidence: spanOf('description', description, item.start, item.start + text.length),
    confidence,
  };
}

export function extractRequirements(description: string): Requirement[] {
  const out: Requirement[] = [];
  for (const section of detectSections(description)) {
    const inSection = REQUIREMENT_SECTIONS.has(section.kind);
    for (const item of section.items) {
      if (out.length >= MAX_REQUIREMENTS) return out;
      if (inSection) {
        const r = build(description, item, section, false);
        if (r) out.push(r);
      } else if (section.kind !== 'responsibilities' && OUT_OF_SECTION_CUE.test(item.text)) {
        const r = build(description, item, null, true);
        if (r) out.push(r);
      }
    }
  }
  return out;
}
