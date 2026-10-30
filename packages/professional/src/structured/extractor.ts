import { canonicalJson } from '@aptamind/contracts';
import type { ClaimType } from '../contracts/claims';
import { normalizeClaimPayload } from '../observations/payload';
import { deriveStatementValue, languageCode, skillTaxonomy } from './derive';
import { structuredFormSchema } from './forms';

/** The deterministic structured extractor (P1.3): form fields → `stated` observations. */
export const STRUCTURED_EXTRACTOR = { name: 'structured_form', version: 1, kind: 'deterministic' } as const;

/** Longest verbatim evidence quote an observation carries (observation schema). */
export const MAX_QUOTE_LENGTH = 300;

export interface StructuredStatement {
  claimType: ClaimType;
  /** The claim type's normalized value. */
  payload: Record<string, unknown>;
  /** JSON pointer of the form field in the stored snapshot. */
  locator: string;
  /** The field as stored (a string field verbatim, otherwise its canonical JSON), ≤ 300 chars. */
  quote?: string;
}

/** Evidence text of a stored form field: strings verbatim, anything else as canonical JSON. */
export function fieldQuote(value: unknown): string | undefined {
  const q = typeof value === 'string' ? value : canonicalJson(value);
  return q.length <= MAX_QUOTE_LENGTH ? q : undefined;
}

/** Reads the value at a JSON pointer (`/a/0/b`) of a parsed JSON document. */
export function atPointer(doc: unknown, pointer: string): unknown {
  let cur = doc;
  for (const part of pointer.split('/').slice(1)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return cur;
}

/**
 * The statements of a stored form, in field order. Pure and deterministic: the same stored
 * bytes always give the same statements (ids, payloads, locators), so re-extraction writes
 * nothing new. Throws `ZodError` if the stored form is not a valid form.
 */
export function extractStatements(stored: unknown): StructuredStatement[] {
  const form = structuredFormSchema.parse(stored);
  const out: StructuredStatement[] = [];
  const add = (claimType: ClaimType, value: unknown, locator: string) => {
    const quote = fieldQuote(atPointer(stored, locator));
    out.push({
      claimType,
      payload: normalizeClaimPayload(claimType, value) as Record<string, unknown>,
      locator,
      ...(quote !== undefined ? { quote } : {}),
    });
  };
  if (form.form === 'manual_input') {
    form.statements.forEach((s, i) =>
      add(s.claimType, deriveStatementValue(s.claimType, s.value).value, `/statements/${i}/value`),
    );
    return out;
  }
  const a = form.answers;
  if (a.headline !== undefined) add('positioning.headline', { text: a.headline }, '/answers/headline');
  if (a.current_location) add('location.current', a.current_location, '/answers/current_location');
  if (a.remote) add('preference.remote', a.remote, '/answers/remote');
  if (a.relocation) add('mobility.relocation', a.relocation, '/answers/relocation');
  a.work_authorization?.forEach((w, i) => add('work_authorization', w, `/answers/work_authorization/${i}`));
  a.languages?.forEach((l, i) =>
    add(
      'language',
      { label: l.label, language: languageCode(l.label), proficiency: l.proficiency },
      `/answers/languages/${i}`,
    ),
  );
  a.skills?.forEach((s, i) =>
    add(
      'skill',
      {
        label: s.label,
        ...skillTaxonomy(s.label),
        kind: s.kind,
        ...(s.proficiency ? { proficiency: s.proficiency } : {}),
        context: 'listed',
      },
      `/answers/skills/${i}`,
    ),
  );
  a.links?.forEach((l, i) => add('identity.link', l, `/answers/links/${i}`));
  return out;
}
