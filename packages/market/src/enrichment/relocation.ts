import type { JobInterpretation } from '../contracts/employment';
import { sentences, spanOf } from './text';
import type { Interpreted, Segment } from './text';

/**
 * Relocation support. Checked per sentence in the order no → possible → yes, so hedged offers
 * ("relocation may be considered", "for exceptional candidates") are not reported as explicit.
 * A requirement that the candidate relocates ("must be willing to relocate") is not support.
 */

export type RelocationStatus = JobInterpretation['relocation']['value'];

const NO: readonly RegExp[] = [
  /\brelocation\s+(?:assistance\s+|support\s+|package\s+|help\s+)?(?:is\s+|will\s+)?not\s+(?:be\s+)?(?:offered|available|provided|supported|possible|included|covered)\b/i,
  /\bno\s+relocation\b/i,
  /\b(?:unable|not\s+able|cannot|can\s*not|can't|won't|will\s+not|do\s+not|don't|does\s+not|doesn't|are\s+not\s+able)\s+(?:to\s+)?(?:currently\s+)?(?:offer|provide|support|cover|pay\s+for|assist\s+with|help\s+with)\s+(?:any\s+)?relocation\b/i,
  /\brelocation\s*:\s*(?:no|none|not\s+available|n\/a|not\s+offered)\b/i,
  /\bnot\s+(?:currently\s+)?(?:offering|providing)\s+relocation\b/i,
];

const POSSIBLE: readonly RegExp[] = [
  /\brelocation\s+(?:assistance\s+|support\s+|package\s+)?(?:may|might|could|can)\s+be\s+(?:considered|available|possible|offered|discussed|negotiated|provided)\b/i,
  /\bopen\s+to\s+(?:providing\s+|offering\s+|discussing\s+)?relocation\b/i,
  /\brelocation\b[^.;]{0,60}\b(?:for\s+(?:exceptional|the\s+right|outstanding|strong)\s+candidates?|case[\s-]by[\s-]case|negotiable|in\s+some\s+cases|where\s+(?:possible|appropriate))\b/i,
  /\b(?:possible|potential|optional)\s+relocation\s+(?:support|assistance|package)\b/i,
  /\brelocation\s+(?:support\s+|assistance\s+)?(?:is\s+)?(?:negotiable|to\s+be\s+discussed|tbd)\b/i,
];

const YES: readonly RegExp[] = [
  /\brelocation\s+(?:assistance|support|package|bonus|allowance|budget|stipend|help|costs?)\s+(?:is\s+|are\s+|will\s+be\s+)?(?:provided|available|offered|included|covered|on\s+offer)\b/i,
  /\b(?:we|we'll|we\s+will|we\s+can|we\s+do)\s+(?:provide|offer|cover|pay\s+for|support|help\s+with|assist\s+with|help\s+you)\s+(?:a\s+|your\s+|full\s+|generous\s+)?(?:relocation|relocate)\b/i,
  /\b(?:offer|offers|offering|provide|provides|providing|including|includes|with|plus)\s+(?:an?\s+)?(?:full\s+|generous\s+|comprehensive\s+|competitive\s+)?relocation\s*(?:assistance|support|package|bonus|allowance)?\b/i,
  /\brelocation\s*:\s*(?:yes|available|provided|offered)\b/i,
  /\bhelp\s+(?:you\s+)?relocate\b/i,
  /\b(?:visa|sponsorship)\s+(?:and|&)\s+relocation\s+(?:support|assistance|package)?\s*(?:is\s+|are\s+)?(?:available|offered|provided|included)\b/i,
];

function firstMatch(s: Segment, rules: readonly RegExp[]): boolean {
  return rules.some((re) => re.test(s.text));
}

export function interpretRelocation(description: string): Interpreted<RelocationStatus> {
  const found: Array<{ status: Exclude<RelocationStatus, 'unclear'>; sentence: Segment }> = [];
  for (const s of sentences(description)) {
    if (!/\breloca/i.test(s.text)) continue;
    if (firstMatch(s, NO)) found.push({ status: 'explicit_no', sentence: s });
    else if (firstMatch(s, POSSIBLE)) found.push({ status: 'possible', sentence: s });
    else if (firstMatch(s, YES)) found.push({ status: 'explicit_yes', sentence: s });
  }
  if (!found.length) return { value: 'unclear', confidence: 'unknown', evidence: [], basis: 'none' };

  const statuses = new Set(found.map((f) => f.status));
  // Explicit "no" wins over offers; a hedged statement tempers an unconditional one.
  const status: Exclude<RelocationStatus, 'unclear'> = statuses.has('explicit_no')
    ? 'explicit_no'
    : statuses.has('possible')
      ? 'possible'
      : 'explicit_yes';
  const chosen = found.filter((f) => f.status === status);
  return {
    value: status,
    confidence: statuses.size > 1 ? 'medium' : status === 'possible' ? 'medium' : 'high',
    evidence: chosen
      .slice(0, 3)
      .map((f) => spanOf('description', description, f.sentence.start, f.sentence.end)),
    basis: 'description.explicit',
  };
}
