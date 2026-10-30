/**
 * Profile sections, sensitivity and field classes (domain doc §3.1, PL-9).
 *
 * Every claim type belongs to exactly one section. Read models are exported per section so a
 * future fit computation can never read eligibility (Professional Fit ≠ Application Viability).
 */

export const SECTIONS = ['identity', 'capability', 'preferences', 'eligibility'] as const;
export type Section = (typeof SECTIONS)[number];

/** `sensitive` data is returned only on explicit `include=sensitive` (R-30). */
export const SENSITIVITIES = ['standard', 'personal', 'sensitive'] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

/**
 * How chronology is used during reconciliation:
 * - `current_state` — legitimately changes over time; a newer source may replace an older
 *   unconfirmed value;
 * - `historical` — a fact about the past; chronology never decides, disagreement is a conflict;
 * - `set_member` — membership of an open set; absence never removes a member (PL-6).
 */
export const FIELD_CLASSES = ['current_state', 'historical', 'set_member'] as const;
export type FieldClass = (typeof FIELD_CLASSES)[number];
