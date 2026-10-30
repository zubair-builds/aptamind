import type { JobInterpretation, NormalizedLocation } from '../contracts/employment';
import { locationFieldText, sentences, spanOf, syntheticSpan, unique } from './text';
import type { Confidence, Interpreted, InterpretationFlag, Segment } from './text';

/**
 * Work model (remote / hybrid / onsite / unclear) and office attendance.
 *
 * Authority (context doc §13.1): explicit description statements > provider workplaceType >
 * title decoration > location labels > weak company-level wording ("remote-first"). A work model
 * is never a boolean: remote scope is interpreted separately (`remote-scope.ts`).
 */

export type WorkModel = JobInterpretation['workModel']['value'];
export type OfficeAttendance = JobInterpretation['officeAttendance']['value'];

export interface WorkModelStatement {
  model: Exclude<WorkModel, 'unclear'>;
  /** 3 = role-specific statement, 2 = direct statement, 1 = weak/company-level wording. */
  strength: 1 | 2 | 3;
  rule: string;
  /** Offsets of the matched phrase in the description. */
  start: number;
  end: number;
  sentence: Segment;
  daysPerWeek?: number;
  /**
   * Whose work model the text is about (see `statementStance`):
   *  - `role`: the role (default);
   *  - `company`: the company ("we are remote-first", "Ashby operates remotely") — weak;
   *  - `preference`: the candidate's preference ("you prefer an in-person role") — not evidence
   *    about the role;
   *  - `anti_fit`: who should not apply ("candidates who want remote work should not apply") —
   *    evidence *against* this model for the role.
   */
  stance: 'role' | 'company' | 'preference' | 'anti_fit';
  /** The statement negates remote work ("this role is not remote") rather than naming a model. */
  negatesRemote?: boolean;
}

const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, once: 1, twice: 2 };
const DAYS = '(\\d|one|two|three|four|five)';

function toNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = /^\d$/.test(raw) ? Number(raw) : NUM_WORDS[raw.toLowerCase()];
  return n === undefined || !Number.isFinite(n) ? null : n;
}

interface Rule {
  model: WorkModelStatement['model'];
  strength: WorkModelStatement['strength'];
  rule: string;
  pattern: RegExp;
  /** Capture group holding days-per-week (first number of a range). */
  daysGroup?: number;
}

const OFFICE =
  '(?:the\\s+|our\\s+)?(?:[A-Z][\\w-]+\\s+){0,3}(?:office|offices|hq|headquarters|studio|site|workplace|hub)';

/** Ordered rules; all matches are collected, precedence is decided by strength. */
const RULES: readonly Rule[] = [
  // Days-per-week attendance (hybrid unless five days).
  {
    model: 'hybrid',
    strength: 3,
    rule: 'office_days',
    pattern: new RegExp(
      `\\b${DAYS}(?:\\s*(?:-|–|to|or)\\s*(?:\\d|one|two|three|four|five))?\\s*(?:days?|x|times)\\s*(?:a|per|each|every|/)\\s*week\\s*(?:in|at|from|on|onsite\\s+at|in-person\\s+at)\\s*${OFFICE}`,
      'i',
    ),
    daysGroup: 1,
  },
  {
    model: 'hybrid',
    strength: 3,
    rule: 'office_days',
    pattern: new RegExp(
      `\\b(?:in|at|from)\\s+${OFFICE}\\s+(?:for\\s+)?(?:at\\s+least\\s+|a\\s+minimum\\s+of\\s+)?${DAYS}(?:\\s*(?:-|–|to|or)\\s*(?:\\d|one|two|three|four|five))?\\s*(?:days?|x|times)\\s*(?:a|per|each|every|/)\\s*week`,
      'i',
    ),
    daysGroup: 1,
  },
  {
    model: 'hybrid',
    strength: 3,
    rule: 'office_days',
    pattern: new RegExp(
      `\\b(?:in[\\s-]office|on[\\s-]?site|onsite|in[\\s-]person)\\s+(?:for\\s+)?(?:at\\s+least\\s+)?${DAYS}(?:\\s*(?:-|–|to|or)\\s*(?:\\d|one|two|three|four|five))?\\s*(?:days?|x|times)\\s*(?:a|per|each|every|/)\\s*week`,
      'i',
    ),
    daysGroup: 1,
  },
  {
    model: 'hybrid',
    strength: 3,
    rule: 'office_days',
    pattern: new RegExp(
      `\\b${DAYS}(?:\\s*(?:-|–|to|or)\\s*(?:\\d|one|two|three|four|five))?\\s*(?:days?|x|times)\\s*(?:a|per|each|every|/)\\s*week\\s*(?:in[\\s-]office|on[\\s-]?site|onsite|in[\\s-]person)`,
      'i',
    ),
    daysGroup: 1,
  },
  // Partly remote ("work from home two days a week") is hybrid.
  {
    model: 'hybrid',
    strength: 3,
    rule: 'remote_days',
    pattern: new RegExp(
      `\\b(?:work(?:ing)?\\s+)?(?:from\\s+home|remotely)\\s+(?:for\\s+)?(?:up\\s+to\\s+)?${DAYS}(?:\\s*(?:-|–|to|or)\\s*(?:\\d|one|two|three|four|five))?\\s*days?\\s*(?:a|per|each|every)\\s*week`,
      'i',
    ),
  },
  // Negated remote.
  {
    model: 'onsite',
    strength: 3,
    rule: 'not_remote',
    pattern:
      /\b(?:(?:this|the)\s+(?:role|position|job)\s+is\s+not\s+(?:a\s+)?(?:fully\s+)?remote|not\s+(?:a\s+)?(?:fully\s+)?remote\s+(?:role|position|job)|no\s+remote\s+(?:work|option|working)|remote\s+work(?:ing)?\s+is\s+not\s+(?:available|possible|offered|an\s+option)|cannot\s+be\s+(?:done|performed)\s+remotely|(?:unable|not\s+able)\s+to\s+(?:offer|consider)\s+(?:fully\s+)?remote)\b/i,
  },
  // Hybrid, explicit.
  {
    model: 'hybrid',
    strength: 3,
    rule: 'hybrid_role',
    pattern:
      /\b(?:(?:(?:this|the)\s+)?(?:role|position|job)\s+is\s+(?:a\s+)?hybrid|this\s+is\s+a\s+hybrid|hybrid\s+(?:role|position|job|working\s+(?:model|arrangement|pattern|policy)|work(?:ing)?\s+model|model|arrangement|set-?up|schedule|basis))\b/i,
  },
  // Remote, explicit.
  {
    model: 'remote',
    strength: 3,
    rule: 'remote_role',
    pattern:
      /\b(?:(?:this|the)\s+(?:role|position|job|opportunity)\s+(?:is|can\s+be)\s+(?:a\s+)?(?:fully[\s-]|100%\s+|completely\s+|entirely\s+|permanently\s+)?remote|this\s+is\s+an?\s+(?:fully[\s-]|100%\s+|completely\s+|entirely\s+|permanently\s+)?remote)\b/i,
  },
  // Onsite, explicit.
  {
    model: 'onsite',
    strength: 3,
    rule: 'onsite_role',
    pattern:
      /\b(?:(?:this|the)\s+(?:role|position|job)\s+is\s+(?:a\s+)?(?:fully\s+|100%\s+)?(?:on[\s-]?site|in[\s-]office|office[\s-]based|in[\s-]person)|(?:on[\s-]?site|in[\s-]office|office[\s-]based|in[\s-]person)\s+(?:role|position|job)|(?:fully|100%|entirely)\s+(?:on[\s-]?site|in[\s-]office|office[\s-]based|in[\s-]person)|(?:five|5)\s+days\s+(?:a|per)\s+week\s+in\s+(?:the|our)\s+office)\b/i,
  },
  // Direct statements.
  {
    model: 'remote',
    strength: 2,
    rule: 'remote_direct',
    pattern:
      /\b(?:(?:fully|100%|completely|entirely|permanently)[\s-]remote|remote[\s-](?:role|position|job|opportunity|only)|work(?:ing)?\s+(?:fully\s+)?remotely|work\s+from\s+anywhere|work\s+from\s+home|remote\s+(?:within|in|from|across|throughout|anywhere)|open\s+to\s+(?:fully\s+)?remote|hiring\s+remotely)\b/i,
  },
  {
    model: 'remote',
    strength: 2,
    rule: 'remote_label_line',
    pattern:
      /^(?:location|workplace(?:\s+type)?|work\s+(?:model|location|type)|remote\s+status)\s*:\s*(?:fully\s+)?remote\b/im,
  },
  {
    model: 'hybrid',
    strength: 2,
    rule: 'hybrid_label_line',
    pattern:
      /^(?:location|workplace(?:\s+type)?|work\s+(?:model|location|type))\s*:\s*[^\n]{0,40}\bhybrid\b/im,
  },
  {
    model: 'onsite',
    strength: 2,
    rule: 'onsite_label_line',
    pattern:
      /^(?:location|workplace(?:\s+type)?|work\s+(?:model|location|type))\s*:\s*(?:on[\s-]?site|in[\s-]office|office[\s-]based)\b/im,
  },
  {
    model: 'onsite',
    strength: 2,
    rule: 'onsite_direct',
    pattern:
      /\b(?:must\s+(?:be\s+able\s+to\s+)?work\s+(?:from|in)\s+(?:the|our)\s+office|based\s+(?:full[\s-]time\s+)?(?:in|at|out\s+of)\s+our\s+(?:[A-Z][\w-]+\s+)?(?:office|hq|headquarters))\b/i,
  },
  // Weak (company-level) wording.
  {
    model: 'remote',
    strength: 1,
    rule: 'remote_company',
    pattern:
      /\b(?:remote[\s-]first|remote[\s-]friendly|distributed\s+(?:team|company|workforce)|fully\s+distributed)\b/i,
  },
  {
    model: 'remote',
    strength: 1,
    rule: 'remote_company_operates',
    // "Ashby operates remotely", "we work remotely", "our team is fully remote" — the company.
    pattern:
      /\b(?:we|our\s+(?:company|team|teams|organi[sz]ation)|the\s+(?:company|team)|(?!This\b|The\b|It\b|Role\b|Position\b|Job\b)[A-Z][\w&.-]+)\s+(?:operates?|works?|is|are)\s+(?:fully\s+|entirely\s+|100%\s+)?(?:remote(?:ly)?|distributed)\b/,
  },
  { model: 'hybrid', strength: 1, rule: 'hybrid_mention', pattern: /\bhybrid\b/i },
  {
    model: 'onsite',
    strength: 1,
    rule: 'onsite_mention',
    pattern: /\b(?:on[\s-]?site|in[\s-]office|office[\s-]based)\b/i,
  },
];

// ---- statement context --------------------------------------------------------------------

/** The candidate is the subject and states a preference/wish. */
const PREFERENCE_CUE =
  /\b(?:you|you'?d|you'?re|candidates?|applicants?|someone|people|anyone|those)\b[^;]{0,50}?\b(?:prefer(?:s|red)?|would\s+rather|rather\s+(?:work|be)|want(?:s|ing)?|wish(?:es)?|looking\s+for|seek(?:s|ing)?|enjoy(?:s)?|need(?:s)?\s+(?:a|an|to\s+work))\b/i;
/** Who should not apply / who will not fit. */
const ANTI_FIT_CUE =
  /\b(?:(?:might|may|will|would)\s+not\s+be\s+(?:a\s+)?(?:good\s+|great\s+|right\s+|strong\s+)?fit|not\s+(?:a\s+)?(?:good\s+|great\s+|right\s+)?fit|should(?:\s+not|n'?t)\s+apply|(?:please\s+)?do(?:\s+not|n'?t)\s+apply|(?:is\s+not|isn'?t|may\s+not\s+be)\s+(?:the\s+right\s+(?:role|job)\s+)?for\s+you|won'?t\s+(?:be\s+(?:a\s+)?(?:good\s+)?fit|enjoy)|not\s+(?:the\s+)?right\s+(?:role|fit|place))\b/i;
/** The company/team (not the role) is the subject. */
const COMPANY_SUBJECT =
  /^\s*(?:(?:although|while|whereas|though|as)\s+)?(?:we(?:'re)?|our\s+(?:company|team|teams|organi[sz]ation|business|culture)|the\s+(?:company|team|organi[sz]ation|business)|(?!This\b|The\b|It\b|Role\b|Position\b|Job\b|You\b|Candidates?\b)[A-Z][\w&.-]+)\s+(?:is|are|operates?|works?|has\s+been|have\s+been|remains?|was)\b/;

/** Clause of `text` containing [from, to): split at ";", parentheses and contrast connectives. */
function clauseAround(text: string, from: number, to: number): string {
  const boundary =
    /;|\(|\)|,\s*(?:but|however|whereas|while|although|though)\b|\s(?:but|however|whereas)\s/gi;
  let start = 0;
  let end = text.length;
  for (const m of text.matchAll(boundary)) {
    const idx = m.index ?? 0;
    if (idx + m[0].length <= from) start = idx + m[0].length;
    else if (idx >= to) {
      end = idx;
      break;
    }
  }
  return text.slice(start, end);
}

/** Lead-in line (heading / "…if:" line) governing the list or paragraph a sentence belongs to. */
function leadIn(description: string, sentenceStart: number): string | null {
  const before = description.slice(0, sentenceStart);
  const lines = before.split('\n');
  // Walk back over the current list/paragraph to the nearest heading-like line.
  for (let i = lines.length - 2; i >= 0 && i >= lines.length - 25; i--) {
    const line = (lines[i] ?? '').trim();
    if (!line) break;
    if (/:$/.test(line) || /^#{1,6}\s/.test(line) || /^\*\*.+\*\*:?$/.test(line)) return line;
    if (!/^(?:[-•*·▪◦‣–—]|\d{1,2}[.)])\s/.test(line)) break; // left the list
  }
  return null;
}

/** Whose work model a matched phrase is about (see WorkModelStatement.stance). */
export function statementStance(
  description: string,
  sentence: Segment,
  matchStart: number,
  matchEnd: number,
): WorkModelStatement['stance'] {
  const clause = clauseAround(sentence.text, matchStart, matchEnd);
  const heading = leadIn(description, sentence.start);
  // A clause whose subject is the company ("(Ashby operates remotely)") is company-level wording,
  // whatever list or heading it appears under.
  if (COMPANY_SUBJECT.test(clause) && !/\b(?:this|the)\s+(?:role|position|job)\b/i.test(clause))
    return 'company';
  const antiFit = ANTI_FIT_CUE.test(sentence.text) || (!!heading && ANTI_FIT_CUE.test(heading));
  const preference = PREFERENCE_CUE.test(clause);
  if (antiFit && (preference || !!heading)) return 'anti_fit';
  if (preference) return 'preference';
  return 'role';
}

/** All work-model statements in a description, with offsets. */
export function findWorkModelStatements(description: string): WorkModelStatement[] {
  // Company-level wording is also detected where a role pattern matched ("the company is remote").
  const out: WorkModelStatement[] = [];
  for (const sentence of sentences(description)) {
    const claimed: Array<[number, number]> = [];
    for (const rule of RULES) {
      const m = sentence.text.match(rule.pattern);
      if (!m || m.index === undefined) continue;
      const start = sentence.start + m.index;
      const end = start + m[0].length;
      // A weaker rule inside a phrase already matched by a stronger one adds nothing ("hybrid role").
      if (claimed.some(([s, e]) => start < e && s < end)) continue;
      claimed.push([start, end]);
      const stance = statementStance(description, sentence, m.index, m.index + m[0].length);
      const statement: WorkModelStatement = {
        model: rule.model,
        // Company-level wording is weak evidence about a role, whatever pattern matched it.
        strength: stance === 'company' ? 1 : rule.strength,
        rule: rule.rule,
        start,
        end,
        sentence,
        stance,
        negatesRemote: rule.rule === 'not_remote' || undefined,
      };
      if (rule.daysGroup !== undefined) {
        const days = toNumber(m[rule.daysGroup]);
        if (days !== null) {
          statement.daysPerWeek = days;
          if (days >= 5) statement.model = 'onsite';
        }
      }
      out.push(statement);
    }
  }
  return out;
}

export interface WorkModelInput {
  title: string;
  description: string;
  locationTexts: readonly string[];
  locations: readonly NormalizedLocation[];
  providerWorkplaceType?: 'remote' | 'hybrid' | 'onsite' | null;
}

export interface WorkModelResult {
  workModel: Interpreted<WorkModel>;
  officeAttendance: Interpreted<OfficeAttendance>;
  statements: WorkModelStatement[];
  flags: InterpretationFlag[];
}

const TITLE_REMOTE = /\bremote\b/i;
const TITLE_HYBRID = /\bhybrid\b/i;
const TITLE_ONSITE = /\b(?:on[\s-]?site|in[\s-]office)\b/i;

/** Work-model label implied by a location string, or null. */
export function workModelFromLabel(text: string): Exclude<WorkModel, 'unclear'> | null {
  if (/\bhybrid\b/i.test(text)) return 'hybrid';
  if (/\b(?:on[\s-]?site|in[\s-]office|office[\s-]based)\b/i.test(text)) return 'onsite';
  if (/\b(?:remote|anywhere|work\s+from\s+home|wfh|distributed|worldwide)\b/i.test(text)) return 'remote';
  return null;
}

export function interpretWorkModel(input: WorkModelInput): WorkModelResult {
  const { title, description, locationTexts } = input;
  const flags: InterpretationFlag[] = [];
  const allStatements = findWorkModelStatements(description);
  // Statements about the role (and weak company-level wording). A candidate's preference says
  // nothing about the role; "who should not apply" statements count *against* their model.
  const statements = allStatements.filter((s) => s.stance === 'role' || s.stance === 'company');
  const antiSignals = unique(allStatements.filter((s) => s.stance === 'anti_fit').map((s) => s.model));
  const locText = locationFieldText(locationTexts);

  // Secondary sources.
  const labelSpans: Array<{ model: Exclude<WorkModel, 'unclear'>; start: number; end: number }> = [];
  let offset = 0;
  for (const text of locationTexts) {
    const model = workModelFromLabel(text);
    if (model) labelSpans.push({ model, start: offset, end: offset + text.length });
    offset += text.length + 1;
  }
  const titleModel = TITLE_HYBRID.test(title)
    ? 'hybrid'
    : TITLE_REMOTE.test(title)
      ? 'remote'
      : TITLE_ONSITE.test(title)
        ? 'onsite'
        : null;
  const provider = input.providerWorkplaceType ?? null;

  const strong = statements.filter((s) => s.strength >= 2);
  let decided: {
    model: WorkModel;
    confidence: Confidence;
    basis: string;
    evidence: Interpreted<WorkModel>['evidence'];
  } | null = null;

  if (strong.length) {
    const top = Math.max(...strong.map((s) => s.strength));
    const topStatements = strong.filter((s) => s.strength === top);
    const models = unique(topStatements.map((s) => s.model));
    const evidence = sentenceEvidence(description, topStatements);
    if (models.length === 1 && topStatements.every((st) => st.negatesRemote)) {
      // "This role is not remote": remote is excluded, but hybrid vs on-site is not stated.
      const hinted = unique([
        ...statements.filter((st) => !st.negatesRemote && st.model !== 'remote').map((st) => st.model),
        ...(input.providerWorkplaceType && input.providerWorkplaceType !== 'remote'
          ? [input.providerWorkplaceType]
          : []),
      ]);
      decided = {
        model: hinted.length === 1 && hinted[0] ? hinted[0] : 'onsite',
        confidence: 'medium',
        basis: 'description.not_remote',
        evidence,
      };
    } else if (models.length === 1) {
      decided = {
        model: models[0] ?? 'unclear',
        confidence: 'high',
        basis: 'description.explicit',
        evidence,
      };
    } else {
      flags.push({
        code: 'work_model_conflict',
        message: `Description makes conflicting work-model statements (${models.join(', ')}).`,
        severity: 'high',
      });
      decided = { model: 'unclear', confidence: 'low', basis: 'description.conflict', evidence };
    }
  }

  const secondary: Array<{ model: Exclude<WorkModel, 'unclear'>; basis: string }> = [];
  if (provider) secondary.push({ model: provider, basis: 'provider.workplaceType' });
  if (titleModel) secondary.push({ model: titleModel, basis: 'title.label' });
  for (const l of labelSpans) secondary.push({ model: l.model, basis: 'location.label' });

  // Structured signals (provider field + location labels) that all agree with each other.
  const structuredModels = unique([...(provider ? [provider] : []), ...labelSpans.map((l) => l.model)]);
  const structuredAgreeing =
    provider && labelSpans.length > 0 && structuredModels.length === 1 ? structuredModels[0] : null;
  if (decided && decided.model !== 'unclear' && structuredAgreeing && structuredAgreeing !== decided.model) {
    // Free text against two agreeing structured sources: a role-specific statement is kept but
    // not trusted fully (review); a less specific one does not override them.
    const top = Math.max(...strong.map((st) => st.strength));
    flags.push({
      code: 'work_model_structured_conflict',
      message: `Description (${decided.model}) contradicts provider and location labels (${structuredAgreeing}).`,
      severity: top >= 3 ? 'high' : 'warning',
    });
    if (top >= 3) decided = { ...decided, confidence: 'medium' };
    else decided = null; // fall through to the structured decision below
  }

  if (decided && decided.model !== 'unclear') {
    const chosen = decided.model;
    const disagreeing = unique(
      secondary.filter((s) => s.model !== chosen).map((s) => `${s.basis}=${s.model}`),
    );
    if (disagreeing.length) {
      flags.push({
        code: 'work_model_overridden',
        message: `Explicit description statement (${chosen}) overrides ${disagreeing.join(', ')}.`,
        severity: 'warning',
      });
    }
  }

  if (!decided) {
    const secondaryEvidence = () => {
      const ev: Interpreted<WorkModel>['evidence'] = [];
      if (provider) ev.push(syntheticSpan('provider', `workplaceType: ${provider}`));
      if (titleModel) ev.push(spanOf('title', title, 0, title.length));
      for (const l of labelSpans.slice(0, 3)) ev.push(spanOf('location', locText, l.start, l.end));
      return ev;
    };
    const models = unique(secondary.map((s) => s.model));
    if (provider) {
      const agrees = secondary.every((s) => s.model === provider);
      if (!agrees) {
        flags.push({
          code: 'work_model_source_disagreement',
          message: `Provider workplaceType (${provider}) disagrees with title/location labels (${models.join(', ')}).`,
          severity: 'warning',
        });
      }
      decided = {
        model: provider,
        confidence: agrees ? 'high' : 'medium',
        basis: 'provider.workplaceType',
        evidence: secondaryEvidence(),
      };
    } else if (models.length === 1 && models[0]) {
      const basis = titleModel ? 'title.label' : 'location.label';
      decided = { model: models[0], confidence: 'medium', basis, evidence: secondaryEvidence() };
    } else if (models.length > 1) {
      flags.push({
        code: 'work_model_conflict',
        message: `Title/location labels disagree on work model (${models.join(', ')}).`,
        severity: 'warning',
      });
      decided = {
        model: 'unclear',
        confidence: 'low',
        basis: 'labels.conflict',
        evidence: secondaryEvidence(),
      };
    }
  }

  if (!decided) {
    const weak = statements.filter((s) => s.strength === 1);
    const models = unique(weak.map((s) => s.model));
    if (models.length === 1 && models[0]) {
      decided = {
        model: models[0],
        confidence: 'low',
        basis: 'description.weak',
        evidence: sentenceEvidence(description, weak),
      };
    }
  }

  if (decided && decided.model !== 'unclear' && antiSignals.includes(decided.model)) {
    const model = decided.model;
    const anti = allStatements.find((s) => s.stance === 'anti_fit' && s.model === model);
    flags.push({
      code: 'work_model_anti_signal',
      message: `The description tells candidates wanting ${decided.model} work not to apply, yet ${decided.basis} says ${decided.model}.`,
      severity: 'high',
      // The anti-signal line itself (its review evidence digest, 5a13fed L-e).
      ...(anti
        ? { evidence: spanOf('description', description, anti.sentence.start, anti.sentence.end) }
        : {}),
    });
    decided = { ...decided, confidence: 'low' };
  }

  const workModel: Interpreted<WorkModel> = decided
    ? {
        value: decided.model,
        confidence: decided.confidence,
        evidence: decided.evidence,
        basis: decided.basis,
      }
    : { value: 'unclear', confidence: 'unknown', evidence: [], basis: 'none' };

  return {
    workModel,
    officeAttendance: interpretOfficeAttendance(workModel, statements, input),
    statements,
    flags,
  };
}

/** One evidence span per distinct sentence (max 3). */
function sentenceEvidence(
  description: string,
  statements: readonly WorkModelStatement[],
): Interpreted<WorkModel>['evidence'] {
  const seen = new Set<number>();
  const out: Interpreted<WorkModel>['evidence'] = [];
  for (const s of statements) {
    if (seen.has(s.sentence.start) || out.length >= 3) continue;
    seen.add(s.sentence.start);
    out.push(spanOf('description', description, s.sentence.start, s.sentence.end));
  }
  return out;
}

function interpretOfficeAttendance(
  workModel: Interpreted<WorkModel>,
  statements: readonly WorkModelStatement[],
  input: WorkModelInput,
): Interpreted<OfficeAttendance> {
  const { description } = input;
  const officeLocations = unique(
    input.locations.filter((l) => !l.isRemoteLabel && l.city).map((l) => l.city as string),
  );
  const dayStatement = statements.find((s) => s.daysPerWeek !== undefined && s.model === workModel.value);

  switch (workModel.value) {
    case 'hybrid':
    case 'onsite': {
      const days = dayStatement?.daysPerWeek ?? null;
      const evidence = dayStatement
        ? [spanOf('description', description, dayStatement.sentence.start, dayStatement.sentence.end)]
        : workModel.evidence;
      return {
        value: { required: true, daysPerWeek: days, officeLocations },
        confidence: dayStatement ? 'high' : workModel.confidence,
        evidence,
        basis: dayStatement ? 'description.explicit' : `derived.workModel`,
      };
    }
    case 'remote':
      return {
        value: { required: false, daysPerWeek: null, officeLocations: [] },
        confidence: workModel.confidence,
        evidence: workModel.evidence,
        basis: 'derived.workModel',
      };
    default:
      return {
        value: { required: null, daysPerWeek: null, officeLocations: [] },
        confidence: 'unknown',
        evidence: [],
        basis: 'none',
      };
  }
}
