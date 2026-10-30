import type { EvidenceSpan, JobInterpretation } from '../contracts/employment';
import { detectSections } from './sections';
import { spanOf } from './text';
import type { Segment } from './text';

/**
 * Responsibility scope signals (architecture, implementation, ownership, leadership, management,
 * product collaboration, operational responsibility) for future matching. Read from
 * responsibilities sections when present, otherwise from every non-boilerplate item (company
 * blurbs and benefits are skipped so "we build…" marketing copy does not count).
 */

export type Responsibilities = JobInterpretation['responsibilities'];
type Signal = keyof Responsibilities;

export const SCOPE_SIGNALS: Readonly<Record<Signal, RegExp>> = {
  architecture:
    /\b(?:architect(?:ure|ing|s)?|system\s+design|design\s+(?:and\s+build\s+)?(?:scalable|distributed|robust|resilient)|technical\s+(?:design|direction|strategy|vision)|design\s+(?:systems|services|apis))\b/i,
  implementation:
    /\b(?:build(?:ing)?|implement(?:ing|ation)?|develop(?:ing)?|writ(?:e|ing)\s+(?:[\w-]+\s+){0,3}(?:code|software|services|tests)|ship(?:ping)?|code|coding|deliver(?:ing)?\s+features|prototyp(?:e|ing))\b/i,
  ownership:
    /\b(?:own(?:ing|ership)?|end[\s-]to[\s-]end(?![\s-]+(?:tests?|testing|encrypt\w*))|accountab(?:le|ility)|drive\s+(?:projects|initiatives|the)|take\s+responsibility)\b/i,
  leadership:
    /\b(?:lead(?:ing)?\s+(?:the|a|technical|engineering|projects|initiatives|design|efforts)|mentor(?:ing|ship)?|coach(?:ing)?|technical\s+leadership|tech\s+lead|set\s+(?:the\s+)?(?:technical\s+)?direction|influence|guide\s+(?:the|other|junior))\b/i,
  management:
    /\b(?:manag(?:e|ing)\s+(?:a\s+team|the\s+team|people|engineers|direct\s+reports|a\s+group)|line\s+manage|direct\s+reports|hir(?:e|ing)\s+(?:and|engineers|talent|for)|grow(?:ing)?\s+(?:the|your|a)\s+team|performance\s+reviews|career\s+(?:development|growth)\s+of|people\s+management)\b/i,
  productCollaboration:
    /\b(?:product\s+(?:managers?|team|owners?|designers?)|designers|cross[\s-]functional|stakeholders?|work\s+closely\s+with|partner\s+with|collaborat(?:e|ing)\s+with|customers?)\b/i,
  operationalResponsibility:
    /\b(?:on[\s-]call|incidents?|production\s+(?:support|issues|systems)|monitoring|uptime|slas?|slos?|pager(?:duty)?|reliability|operat(?:e|ing)\s+(?:services|systems|infrastructure)|troubleshoot(?:ing)?|root\s+cause)\b/i,
};

const SIGNALS = Object.keys(SCOPE_SIGNALS) as Signal[];
const MAX_EVIDENCE = 3;

export function extractResponsibilities(description: string): Responsibilities {
  const sections = detectSections(description);
  const dedicated = sections.filter((s) => s.kind === 'responsibilities');
  const pool: Segment[] = (
    dedicated.length ? dedicated : sections.filter((s) => s.kind !== 'other' || s.heading === null)
  ).flatMap((s) => s.items);

  const result = {} as Record<Signal, { present: boolean; evidence: EvidenceSpan[] }>;
  for (const signal of SIGNALS) {
    const evidence = pool
      .filter((item) => SCOPE_SIGNALS[signal].test(item.text))
      .slice(0, MAX_EVIDENCE)
      .map((item) => spanOf('description', description, item.start, item.end));
    result[signal] = { present: evidence.length > 0, evidence };
  }
  return result;
}
