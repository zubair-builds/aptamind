import { contentHash, deterministicId } from '@aptamind/contracts';
import { type ClaimType, type ClaimValue, parseClaimValue } from '../contracts/claims';

/**
 * Observation payloads are stored **normalized**: the claim type's schema output (trimmed
 * strings, `Date`s, no unknown keys), never the raw extractor output. Hashes and ids are
 * computed from the normalized value, so two spellings of the same value are one observation
 * and one assertion.
 */
export function normalizeClaimPayload<T extends ClaimType>(claimType: T, raw: unknown): ClaimValue<T> {
  return parseClaimValue(claimType, raw);
}

export function observationPayloadHash(claimType: ClaimType, payload: unknown): string {
  return contentHash(normalizeClaimPayload(claimType, payload));
}

/**
 * `det(snapshotId, extractor@version, claimType, locator, payloadHash)` (domain doc §2).
 *
 * PRIVACY: the id is payload-derived — with the (visible) snapshot id, a guessed value can be
 * tested against it. Never expose the id of a hidden (sensitive) observation on any surface
 * (API, events, review items, run outputs, logs) without `include=sensitive` (supervisor
 * ruling, domain doc §13).
 */
export function observationId(input: {
  snapshotId: string;
  extractor: { name: string; version: number };
  claimType: ClaimType;
  locator: string;
  payload: unknown;
}): string {
  return deterministicId(
    'pobs',
    input.snapshotId,
    `${input.extractor.name}@${input.extractor.version}`,
    input.claimType,
    input.locator,
    observationPayloadHash(input.claimType, input.payload),
  );
}
