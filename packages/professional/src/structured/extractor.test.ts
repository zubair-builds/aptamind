import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@aptamind/contracts';
import { atPointer, extractStatements, fieldQuote } from './extractor';
import { statementsRequestSchema } from '../sources/ingest.service';
import { structuredFormSchema } from './forms';

describe('structured forms', () => {
  it('validates manual statements against their claim types, reporting paths and codes only', () => {
    const bad = structuredFormSchema.safeParse({
      form: 'manual_input',
      version: 1,
      statements: [
        { claimType: 'language', value: { label: 'German', language: 'german', proficiency: 'fluent' } },
        { claimType: 'location.current', value: { country: 'Atlantis', secret: 'CANARY' } },
      ],
    });
    expect(bad.success).toBe(false);
    const paths = bad.error!.issues.map((i) => i.path.join('.'));
    expect(paths.every((p) => p.startsWith('statements.1.value'))).toBe(true);
    expect(JSON.stringify(bad.error!.issues)).not.toContain('CANARY');
  });

  it('refuses claim types not open to direct statements, unknown questions and empty forms', () => {
    const cases = [
      { form: 'manual_input', version: 1, statements: [{ claimType: 'preference.compensation', value: {} }] },
      { form: 'manual_input', version: 1, statements: [] },
      { form: 'questionnaire', version: 1, answers: {} },
      { form: 'questionnaire', version: 1, answers: { date_of_birth: '1990-01-01' } },
      { form: 'questionnaire', version: 2, answers: { headline: 'x' } },
      { form: 'essay', version: 1 },
    ];
    for (const c of cases) expect(structuredFormSchema.safeParse(c).success, JSON.stringify(c)).toBe(false);
    expect(statementsRequestSchema.safeParse({ sourceId: 'psrc_1', form: cases[0], note: 'x' }).success).toBe(
      false,
    );
  });

  it('quotes a stored field verbatim (strings) or as canonical JSON, and only up to 300 chars', () => {
    const stored = {
      form: 'questionnaire',
      version: 1,
      answers: { headline: ' Staff engineer ', remote: { acceptable: ['remote'] } },
    };
    const [headline, remote] = extractStatements(stored);
    expect(headline!.quote).toBe(' Staff engineer ');
    expect(headline!.payload).toEqual({ text: 'Staff engineer' });
    expect(remote!.quote).toBe(canonicalJson(atPointer(stored, remote!.locator)));
    expect(fieldQuote('x'.repeat(301))).toBeUndefined();
  });

  it('is deterministic: the same stored form gives identical statements', () => {
    const stored = {
      form: 'questionnaire',
      version: 1,
      answers: { skills: [{ label: 'TypeScript' }, { label: 'Kubernetes', proficiency: 'advanced' }] },
    };
    expect(extractStatements(stored)).toEqual(extractStatements(JSON.parse(JSON.stringify(stored))));
  });

  it('derives taxonomy and keys for manual statements; a disagreeing supplied value is refused', () => {
    const manual = (value: unknown, claimType = 'skill') => ({
      form: 'manual_input',
      version: 1,
      statements: [{ claimType, value }],
    });
    const issues = (form: unknown) =>
      structuredFormSchema.safeParse(form).error?.issues.map((i) => [i.path.join('.'), i.message]) ?? [];
    // Probe 1: a skill with a made-up concept, category and context.
    expect(
      issues(
        manual({ label: 'TypeScript', concept: 'cobol', category: 'design', kind: 'skill', context: 'repo' }),
      ),
    ).toEqual([
      ['statements.0.value.concept', 'derived_field_mismatch'],
      ['statements.0.value.category', 'derived_field_mismatch'],
      ['statements.0.value.context', 'derived_field_mismatch'],
    ]);
    // Probe 2: a language with a code that is not the label's.
    expect(
      issues(manual({ label: 'German', language: 'french', proficiency: 'fluent' }, 'language')),
    ).toEqual([['statements.0.value.language', 'derived_field_mismatch']]);
    // Probe 3: a role whose keys do not follow its title and organization.
    expect(
      issues(
        manual(
          {
            organization: { name: 'Acme Ltd', key: 'globex' },
            title: 'Lead Designer',
            titleKey: 'ceo',
            start: { year: 2020 },
            end: { year: 2021 },
          },
          'experience.role',
        ),
      ),
    ).toEqual([
      ['statements.0.value.titleKey', 'derived_field_mismatch'],
      ['statements.0.value.organization.key', 'derived_field_mismatch'],
    ]);
    // Supplying the derived values (or omitting them) is fine; the extractor sets them either way.
    const ok = manual({ label: 'TypeScript', concept: 'typescript', kind: 'skill' });
    expect(issues(ok)).toEqual([]);
    expect(extractStatements(ok)[0]!.payload).toMatchObject({ concept: 'typescript', context: 'listed' });
  });
});
