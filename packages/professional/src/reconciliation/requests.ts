import { CLAIM_TYPE_DEFS, type ClaimType } from '../contracts/claims';

/**
 * Confirmation request derivation primitives (domain doc §7.1/§7.2, R-18). Pure: no I/O.
 *
 * Requests are typed questions to the subject, deduplicated by a key built only from the type
 * and opaque ids (`type:itemIds:sortedAssertionIds`), so one open request exists per question
 * (unique partial index in P3.3). Parameters are enum codes, never text copied from documents.
 */
export const REQUEST_TYPES = [
  'confirm_new',
  'resolve_conflict',
  'reconfirm',
  'confirm_change',
  'same_item',
  'accept_target',
] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

/** Request types the item reconciler derives, keeps and closes as `superseded` when moot. */
export const RECONCILER_REQUEST_TYPES: readonly RequestType[] = Object.freeze([
  'confirm_new',
  'resolve_conflict',
  'reconfirm',
  'confirm_change',
]);

/** Why a request was opened (enum codes only). */
export const REQUEST_REASONS = [
  'unconfirmed_material',
  'rejected_restated',
  'outdated_restated',
  'superseder_withdrawn',
  'current_unknown',
  'held_by_decision',
  'same_basis_conflict',
  'lower_basis_conflict',
  'challenges_confirmed',
  'multiple_confirmed',
  'newer_state',
] as const;
export type RequestReason = (typeof REQUEST_REASONS)[number];

/** Materiality v1 (§7.2): material claim types weigh 3, the rest 1. */
export const MATERIALITY_WEIGHT = Object.freeze({ material: 3, standard: 1 });

/** Kind weight per request type. */
export const REQUEST_KIND_WEIGHT: Readonly<Record<RequestType, number>> = Object.freeze({
  reconfirm: 4,
  resolve_conflict: 3,
  confirm_change: 2,
  same_item: 2,
  confirm_new: 1,
  accept_target: 1,
});

export function isMaterial(claimType: ClaimType): boolean {
  return CLAIM_TYPE_DEFS[claimType].material;
}

/** `priority = materiality(claimType) × kind weight` (§7.1). */
export function requestPriority(claimType: ClaimType, type: RequestType): number {
  const m = isMaterial(claimType) ? MATERIALITY_WEIGHT.material : MATERIALITY_WEIGHT.standard;
  return m * REQUEST_KIND_WEIGHT[type];
}

/** `type:reason:itemIds:sortedAssertionIds` — codes and ids only, never values. */
export function requestDedupeKey(
  type: RequestType,
  reason: RequestReason,
  itemIds: readonly string[],
  assertionIds: readonly string[],
): string {
  return `${type}:${reason}:${[...itemIds].sort().join(',')}:${[...assertionIds].sort().join(',')}`;
}

/** What each named assertion is in the question (B-L5). */
export const REQUEST_ROLES = [
  'confirmed',
  'challenger',
  'from',
  'to',
  'candidate',
  'rival',
  'rejected',
  'outdated',
] as const;
export type RequestRole = (typeof REQUEST_ROLES)[number];

export interface RequestParams {
  reason: RequestReason;
  /** Conflicting attribute names (from the claim type's attribute specs), sorted. */
  attributes?: string[];
  /** The role of every named assertion, sorted by assertion id. */
  roles?: { assertionId: string; role: RequestRole }[];
}

/** A request the reconciler wants open. P3.2/P3.3 persist it (`itemRevAtOpen`, status, …). */
export interface RequestDraft {
  type: RequestType;
  dedupeKey: string;
  itemIds: string[];
  assertionIds: string[];
  priority: number;
  params: RequestParams;
}

/** An open request as the reconciler sees it (for keeping and closing). */
export interface OpenRequestRef {
  type: RequestType;
  dedupeKey: string;
  itemIds: readonly string[];
  assertionIds: readonly string[];
}

export function requestDraft(
  claimType: ClaimType,
  type: RequestType,
  itemId: string,
  assertionIds: readonly string[],
  params: RequestParams,
): RequestDraft {
  const ids = [...new Set(assertionIds)].sort();
  return {
    type,
    dedupeKey: requestDedupeKey(type, params.reason, [itemId], ids),
    itemIds: [itemId],
    assertionIds: ids,
    priority: requestPriority(claimType, type),
    params,
  };
}
