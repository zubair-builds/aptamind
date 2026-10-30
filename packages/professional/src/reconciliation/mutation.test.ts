import { describe, expect, it } from 'vitest';
import { type RevivalInput, revivalGuard } from '../assertions/revival';
import { evaluateAllGolden } from '../golden/evaluators';
import { type CompatibilityRule, COMPATIBILITY_RULES } from './compatibility';
import { PROF_REC_1, type ReconciliationPolicy } from './policy';

/**
 * Mutation checks: each mutated policy must make the named golden cases fail. A mutation that
 * no golden case catches means a rule is untested (or dead).
 */
const withRevival = (f: (i: RevivalInput) => RevivalInput): ReconciliationPolicy => ({
  ...PROF_REC_1,
  revivalGuard: (i) => revivalGuard(f(i)),
});
const withoutRule = (rule: CompatibilityRule): ReconciliationPolicy => ({
  ...PROF_REC_1,
  compatibility: new Set(COMPATIBILITY_RULES.filter((r) => r !== rule)),
});

const MUTATIONS: [string, ReconciliationPolicy, string[]][] = [
  [
    'ladder: stated ↔ extracted',
    { ...PROF_REC_1, ladder: ['confirmed', 'extracted', 'stated', 'inferred'] },
    ['stated-beats-newer-extracted-current-state', 'set-member-stated-proficiency-outranks-listed-skill'],
  ],
  [
    'ladder: extracted ↔ inferred',
    { ...PROF_REC_1, ladder: ['confirmed', 'stated', 'inferred', 'extracted'] },
    [
      'extracted-beats-newer-inferred-no-request-when-immaterial',
      'lower-basis-historical-material-conflict-asks',
    ],
  ],
  [
    'ladder: confirmed below stated',
    { ...PROF_REC_1, ladder: ['stated', 'confirmed', 'extracted', 'inferred'] },
    ['confirmed-beats-newer-stated'],
  ],
  ['drop text_normalization', withoutRule('text_normalization'), ['headline-case-and-punctuation-trap']],
  ['drop optional_absent', withoutRule('optional_absent'), ['skill-proficiency-absent-vs-stated']],
  [
    'drop date_precision',
    withoutRule('date_precision'),
    ['date-year-vs-month-is-refinement', 'compatible-refinement-year-vs-month-and-present-vs-end'],
  ],
  [
    'drop present_vs_end',
    withoutRule('present_vs_end'),
    ['present-vs-later-end-compatible', 'compatible-refinement-year-vs-month-and-present-vs-end'],
  ],
  [
    'drop title_normalization',
    withoutRule('title_normalization'),
    ['title-sr-vs-senior-trap', 'historical-title-abbreviation-is-not-a-conflict'],
  ],
  ['drop organization_legal_form', withoutRule('organization_legal_form'), ['org-ltd-vs-limited-trap']],
  ['drop organization_alias', withoutRule('organization_alias'), ['org-recorded-alias-compatible']],
  ['drop place_partial', withoutRule('place_partial'), ['location-city-absent-trap']],
  ['drop tri_state_unknown', withoutRule('tri_state_unknown'), ['workauth-sponsorship-unknown-vs-yes-trap']],
  ['drop education_progress', withoutRule('education_progress'), ['education-in-progress-vs-completed-trap']],
  ['drop list_subset', withoutRule('list_subset'), ['project-technologies-subset-trap']],
  [
    'revival (a): ignore field class',
    withRevival((i) => ({ ...i, fieldClass: 'current_state' })),
    ['revival-a-historical-never-revives'],
  ],
  [
    'revival (a): ignore merge',
    withRevival((i) => ({
      ...i,
      supersessionCause: i.supersessionCause === 'merge' ? 'newer_state' : i.supersessionCause,
    })),
    ['revival-a-merge-superseded-never-revives'],
  ],
  [
    'revival (b): ignore chronology threshold',
    withRevival((i) => ({ ...i, supersededAtAsOf: new Date(0) })),
    ['revival-b-mark-outdated-then-older-cv-reprocessed', 'revival-b-support-dated-as-winner-never-revives'],
  ],
  [
    "revival (b'): accept undated documents after a subject supersession",
    withRevival((i) => ({ ...i, newDeclaredSupportAsOf: i.newSupportAsOf })),
    ['undated-cv-after-mark-outdated-does-not-revive'],
  ],
  [
    'revival (b*): never re-evaluate a stored supersession',
    withRevival((i) => ({ ...i, supersessionInvalid: false })),
    [
      'winner-quarantined-older-value-revives',
      'newer-support-quarantined-restores-previous-winner',
      'confirmed-value-evidence-quarantined-reevaluates-older-values',
      'confirmed-rival-revoked-older-values-revive',
      'confirm-change-rejected-older-value-revives',
    ],
  ],
  [
    'revival (b*): also after a subject supersession',
    withRevival((i) =>
      i.supersessionCause === 'subject' && i.supersessionInvalid
        ? { ...i, supersessionCause: 'newer_state' }
        : i,
    ),
    ['subject-superseded-value-with-winner-quarantined-does-not-revive'],
  ],
  [
    'revival: a value held by a subject decision never comes back',
    withRevival((i) =>
      i.supersessionCause === 'subject_decision' ? { ...i, supersessionInvalid: false } : i,
    ),
    ['unrejected-value-restores-compatible-value'],
  ],
  [
    'revival: never revive',
    { ...PROF_REC_1, revivalGuard: () => ({ revive: false, reason: 'not_newer' }) },
    [
      'current-state-a-b-a-revives',
      'revival-c-revived-under-confirmed-rival-conflicts',
      'revival-d-a-b-a-is-three-versions-with-recorded-revival',
      'dated-cv-after-mark-outdated-revives',
    ],
  ],
];

describe('mutation checks (policy prof-rec-1)', () => {
  it('the unmutated policy passes every golden case', () => {
    const failed = evaluateAllGolden().flatMap((r) => r.cases.filter((c) => !c.passed).map((c) => c.id));
    expect(failed).toEqual([]);
  });

  it('every compatibility rule has a mutation check', () => {
    const covered = MUTATIONS.map(([name]) => name);
    for (const rule of COMPATIBILITY_RULES) expect(covered).toContain(`drop ${rule}`);
  });

  it.each(MUTATIONS)('%s → named golden cases fail', (_name, policy, mustFail) => {
    const failed = evaluateAllGolden(undefined, policy).flatMap((r) =>
      r.cases.filter((c) => !c.passed).map((c) => c.id),
    );
    for (const id of mustFail) expect(failed).toContain(id);
  });
});
