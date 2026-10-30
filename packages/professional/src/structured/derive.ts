import { getSkill, HUMAN_LANGUAGES, normalizeSkill } from '@aptamind/taxonomy';
import type { ClaimType } from '../contracts/claims';

/**
 * Fields the structured extractor derives itself — never taken from the operator (P1.3 review):
 * taxonomy concepts and categories, language codes, normalized keys, and the skill `context`.
 * Manual statements may omit them; a supplied value that disagrees with the derived one is
 * rejected (400 `derived_field_mismatch`), so the same value always gets the same keys and ids
 * whichever form it arrived through.
 */

/** A normalized key: lower-case letters and digits, other runs → `_` (diacritics removed). */
export function domainKey(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 200);
}

/** Exact (case-insensitive) language match; anything else keeps its label with `language: null`. */
export function languageCode(label: string): (typeof HUMAN_LANGUAGES)[number] | null {
  const key = label.trim().toLowerCase();
  return (HUMAN_LANGUAGES as readonly string[]).includes(key)
    ? (key as (typeof HUMAN_LANGUAGES)[number])
    : null;
}

/** Taxonomy fields of a skill label: `concept` (or null) and its `category` when known. */
export function skillTaxonomy(label: string): { concept: string | null; category?: string } {
  const concept = normalizeSkill(label.trim());
  const category = concept ? getSkill(concept)?.category : undefined;
  return { concept, ...(category ? { category } : {}) };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);

/** A derived field: its path inside the value and the value the extractor assigns. */
interface Derived {
  path: string[];
  value: unknown;
}

function derivedFields(claimType: ClaimType, v: Obj): Derived[] {
  switch (claimType) {
    case 'skill': {
      const label = str(v.label);
      if (label === undefined) return [];
      const t = skillTaxonomy(label);
      return [
        { path: ['concept'], value: t.concept },
        { path: ['category'], value: t.category },
        { path: ['context'], value: 'listed' },
      ];
    }
    case 'language': {
      const label = str(v.label);
      return label === undefined ? [] : [{ path: ['language'], value: languageCode(label) }];
    }
    case 'experience.role': {
      const out: Derived[] = [];
      const title = str(v.title);
      if (title !== undefined) out.push({ path: ['titleKey'], value: domainKey(title) });
      const org = isObj(v.organization) ? str(v.organization.name) : undefined;
      if (org !== undefined) out.push({ path: ['organization', 'key'], value: domainKey(org) });
      return out;
    }
    case 'education': {
      const name = isObj(v.institution) ? str(v.institution.name) : undefined;
      return name === undefined ? [] : [{ path: ['institution', 'key'], value: domainKey(name) }];
    }
    default:
      return [];
  }
}

const get = (o: Obj, path: string[]): unknown =>
  path.reduce<unknown>((cur, k) => (isObj(cur) ? cur[k] : undefined), o);

function withField(o: Obj, path: string[], value: unknown): Obj {
  const [head, ...rest] = path as [string, ...string[]];
  if (!rest.length) {
    const { [head]: _drop, ...others } = o;
    void _drop;
    return value === undefined ? others : { ...others, [head]: value };
  }
  return { ...o, [head]: withField(isObj(o[head]) ? (o[head] as Obj) : {}, rest, value) };
}

/**
 * The value with its derived fields set by the extractor, and the paths where the operator
 * supplied a different value (those make the statement invalid).
 */
export function deriveStatementValue(
  claimType: ClaimType,
  value: unknown,
): { value: unknown; mismatches: string[][] } {
  if (!isObj(value)) return { value, mismatches: [] };
  let out = value;
  const mismatches: string[][] = [];
  for (const d of derivedFields(claimType, value)) {
    const supplied = get(value, d.path);
    if (supplied !== undefined && supplied !== d.value) mismatches.push(d.path);
    out = withField(out, d.path, d.value);
  }
  return { value: out, mismatches };
}
