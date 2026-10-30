import { SUBDIVISIONS } from '@aptamind/taxonomy';
import { looseNameKey, strictNameKey } from '../companies/normalize';

/**
 * Attach-only resolution for history registers (M11.5, DECISION_LOG "Owner request: add the
 * Netherlands and US H-1B sponsor datasets"): a history row NEVER creates a company. It attaches
 * to an existing company only when, AT IMPORT TIME, exactly one active company has the row's
 * exact strict name key among its OWN names (legal, display or normalised — not an alias) AND a
 * known location in the row's state. The row's `us_h1b_employer` key is a row key, not an
 * identifier (DECISION_LOG "Sponsor register adapters" (2)): an earlier attachment, automatic or
 * by an operator, is never proof for a later row. Ambiguity (the own name matches but the state
 * is not known to agree, several companies match, only an alias matches) raises a review.
 * Anything else is skipped with a counted reason, never guessed: `legal_form_variant` (the name
 * matches only without its legal form, "ACME LLC" vs "Acme Inc"), `no_exact_name`, `no_name`,
 * `no_state` (an unknown state fails closed). Pure over a lookup port.
 */

export const HISTORY_ATTACHMENT_VERSION = 'history-attach/2';

export const HISTORY_UNMATCHED_REASONS = [
  'legal_form_variant',
  'no_exact_name',
  'no_name',
  'no_state',
] as const;
export type HistoryUnmatchedReason = (typeof HISTORY_UNMATCHED_REASONS)[number];

export interface HistoryCandidate {
  name: string;
  /** Two-letter state (country subdivision) the register places the employer in. */
  state: string | null;
  country: string;
}

export interface HistoryCompany {
  id: string;
  label: string;
  /** Strict keys of the company's own names (legal, display, normalised). */
  ownNameKeys: string[];
  /** Strict keys of its aliases. */
  aliasKeys: string[];
  /** Subdivision codes of its known locations in `country` (HQ, offices, registered). */
  states: string[];
}

export interface HistoryLookup {
  /** Active companies with the strict key among their own names or aliases. */
  byNameKey(strictKey: string, country: string): Promise<HistoryCompany[]>;
  /** Whether an active company has this legal-form-insensitive (loose) name key. */
  hasLooseKey(looseKey: string): Promise<boolean>;
}

export type HistoryAttachmentDecision =
  | { kind: 'match'; companyId: string; method: 'name_exact_state'; reasons: string[] }
  | {
      kind: 'review';
      reason: string;
      severity: 'low' | 'medium' | 'high';
      candidates: Array<{ id: string; label: string; score: number; method: string }>;
      dedupeKey: string;
    }
  | { kind: 'unmatched'; reason: HistoryUnmatchedReason };

export async function resolveHistoryAttachment(
  c: HistoryCandidate,
  lookup: HistoryLookup,
  register: string,
): Promise<HistoryAttachmentDecision> {
  const key = strictNameKey(c.name);
  const dedupeKey = `history_attachment:${register}:${key}|${c.state ?? ''}`;
  if (!key) return { kind: 'unmatched', reason: 'no_name' };
  if (!c.state) return { kind: 'unmatched', reason: 'no_state' };
  const found = await lookup.byNameKey(key, c.country);
  const own = found.filter((f) => f.ownNameKeys.includes(key));
  const inState = own.filter((f) => !!c.state && f.states.includes(c.state));
  const cand = (list: HistoryCompany[], method: string, score: number) =>
    list.slice(0, 10).map((f) => ({ id: f.id, label: f.label, score, method }));
  if (own.length === 1 && inState.length === 1)
    return {
      kind: 'match',
      companyId: inState[0]!.id,
      method: 'name_exact_state',
      reasons: ['exact own name', `known location in ${c.state}`],
    };
  if (inState.length > 1)
    return {
      kind: 'review',
      reason: `Several companies named "${c.name}" have a location in ${c.state}`,
      severity: 'high',
      candidates: cand(inState, 'name_exact_state', 1),
      dedupeKey,
    };
  if (own.length > 0)
    return {
      kind: 'review',
      reason:
        own.length === 1
          ? `Same name as ${own[0]!.label}, but it has no known location in ${c.state ?? 'the register state'}`
          : inState.length === 1
            ? `Several companies are named "${c.name}"; only ${inState[0]!.label} is known to be in ${c.state}`
            : `Several companies are named "${c.name}"; none is known to be in ${c.state ?? 'the register state'}`,
      severity: 'medium',
      candidates: cand(own, 'name_exact', 0.8),
      dedupeKey,
    };
  if (found.length > 0)
    return {
      kind: 'review',
      reason: `"${c.name}" matches only an alias of ${found.map((f) => f.label).join(', ')}`,
      severity: 'low',
      candidates: cand(found, 'alias_exact', 0.6),
      dedupeKey,
    };
  const loose = looseNameKey(c.name);
  if (loose && (await lookup.hasLooseKey(loose))) return { kind: 'unmatched', reason: 'legal_form_variant' };
  return { kind: 'unmatched', reason: 'no_exact_name' };
}

/**
 * The subdivision (state/province) code of a location region within `country`: a code or a name
 * the taxonomy knows ("TX", "Texas" → `TX`); an unknown two-letter code as given (upper-cased);
 * otherwise null (unknown stays unknown).
 */
export function subdivisionCode(country: string, region: string | null | undefined): string | null {
  const v = region?.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!v) return null;
  const known = SUBDIVISIONS.find(
    (s) => s.country === country && (s.code.toLowerCase() === v || s.name.toLowerCase() === v),
  );
  if (known) return known.code;
  return /^[a-z]{2}$/.test(v) ? v.toUpperCase() : null;
}
