import { z } from 'zod';
import {
  CLAIM_TYPE_DEFS,
  CLAIM_TYPES,
  CLAIM_VALUE_SCHEMAS,
  type ClaimType,
  LANGUAGE_PROFICIENCIES,
  SKILL_KINDS,
  SKILL_PROFICIENCIES,
} from '../contracts/claims';
import { deriveStatementValue } from './derive';

/**
 * Structured input (R-2, P1.3): operator-entered statements (`manual_input`) and questionnaire v1
 * answers (`questionnaire`), both on the subject's behalf. A submitted form is validated, stored
 * as a private JSON snapshot (`via: form`) and turned into `stated` observations by the
 * deterministic structured extractor (`structured/extractor.ts`). Values are the claim types'
 * normalized values; nothing is inferred.
 */

const text = (max: number) => z.string().trim().min(1).max(max);

/** Claim types an operator may state directly (the P2 claim types; others arrive later). */
export const MANUAL_INPUT_CLAIM_TYPES = CLAIM_TYPES.filter((t) => CLAIM_TYPE_DEFS[t].milestone === 'P2') as [
  ClaimType,
  ...ClaimType[],
];
export const MAX_FORM_STATEMENTS = 200;

/**
 * `manual_input` v1: `{ statements: [{ claimType, value }] }`, each value validated against its
 * claim type's schema after the extractor's derived fields are set (`structured/derive.ts`:
 * taxonomy concept/category, language code, title/organization/institution keys, skill context
 * `listed` — omit them; a disagreeing value is `derived_field_mismatch`). Issues carry paths and
 * codes only. The form is stored as submitted, so evidence quotes are verbatim.
 */
export const manualInputFormSchema = z
  .strictObject({
    form: z.literal('manual_input'),
    version: z.literal(1),
    statements: z
      .array(z.strictObject({ claimType: z.enum(MANUAL_INPUT_CLAIM_TYPES), value: z.unknown() }))
      .min(1)
      .max(MAX_FORM_STATEMENTS),
  })
  .superRefine((form, ctx) => {
    form.statements.forEach((s, i) => {
      // Derived fields (taxonomy, keys, skill context) are the extractor's; a supplied value
      // that disagrees is refused rather than silently replaced.
      const derived = deriveStatementValue(s.claimType, s.value);
      for (const path of derived.mismatches)
        ctx.addIssue({
          code: 'custom',
          path: ['statements', i, 'value', ...path],
          message: 'derived_field_mismatch',
        });
      const parsed = CLAIM_VALUE_SCHEMAS[s.claimType].safeParse(derived.value);
      if (parsed.success) return;
      for (const issue of parsed.error.issues.slice(0, 5))
        ctx.addIssue({
          code: 'custom',
          path: ['statements', i, 'value', ...issue.path],
          message: issue.code,
        });
    });
  });

/** Questionnaire v1 questions (ids are stable; answers map to claim types in the extractor). */
export const questionnaireV1AnswersSchema = z
  .strictObject({
    /** → `positioning.headline` */
    headline: text(300).optional(),
    /** → `location.current` */
    current_location: CLAIM_VALUE_SCHEMAS['location.current'].optional(),
    /** → `preference.remote` */
    remote: CLAIM_VALUE_SCHEMAS['preference.remote'].optional(),
    /** → `mobility.relocation` */
    relocation: CLAIM_VALUE_SCHEMAS['mobility.relocation'].optional(),
    /** → one `work_authorization` per jurisdiction */
    work_authorization: z.array(CLAIM_VALUE_SCHEMAS.work_authorization).min(1).max(20).optional(),
    /** → one `language` each (taxonomy language when the label matches one exactly) */
    languages: z
      .array(z.strictObject({ label: text(80), proficiency: z.enum(LANGUAGE_PROFICIENCIES) }))
      .min(1)
      .max(30)
      .optional(),
    /** → one `skill` each (`context: listed`; taxonomy concept when the label matches) */
    skills: z
      .array(
        z.strictObject({
          label: text(120),
          kind: z.enum(SKILL_KINDS).default('skill'),
          proficiency: z.enum(SKILL_PROFICIENCIES).optional(),
        }),
      )
      .min(1)
      .max(MAX_FORM_STATEMENTS)
      .optional(),
    /** → one `identity.link` each */
    links: z.array(CLAIM_VALUE_SCHEMAS['identity.link']).min(1).max(20).optional(),
  })
  .refine((a) => Object.values(a).some((v) => v !== undefined), { message: 'no answers' });
export type QuestionnaireV1Answers = z.infer<typeof questionnaireV1AnswersSchema>;

export const questionnaireFormSchema = z.strictObject({
  form: z.literal('questionnaire'),
  version: z.literal(1),
  answers: questionnaireV1AnswersSchema,
});

/** A structured form (stored as submitted, canonical JSON, in a `form` snapshot). */
export const structuredFormSchema = z.discriminatedUnion('form', [
  manualInputFormSchema,
  questionnaireFormSchema,
]);
export type StructuredForm = z.infer<typeof structuredFormSchema>;

/** The source kind each form is submitted to (sources with `acquisition: structured_input`). */
export const FORM_SOURCE_KIND = { manual_input: 'manual_input', questionnaire: 'questionnaire' } as const;

export { languageCode } from './derive';
