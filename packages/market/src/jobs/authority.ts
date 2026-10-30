import type { AuthorityTier } from '@aptamind/provenance';
import { isJobSourceProvider, isThirdPartyProvider } from '../contracts/common';
import type { SourceRef } from './job.schema';

/**
 * The authority tiers whose copies are evidence of a job's existence. `operator` is one of them:
 * operator assertions are first-party input (PR #11 re-verify #7 LOW-4).
 */
const AUTHORITATIVE: AuthorityTier[] = ['official_ats', 'official_site', 'operator'];
export function isAuthoritativeForExistence(tier: AuthorityTier): boolean {
  return AUTHORITATIVE.includes(tier);
}

/**
 * An authoritative COPY: an authoritative tier, and not a provider that is third-party by nature
 * (`aggregator`, compared trimmed and lower-cased) — an aggregator copy stored with an
 * authoritative tier (a source registered before providers were a closed set) is still
 * third-party evidence (PR #11 re-verify #7 LOW-1).
 */
export function isAuthoritativeCopy(ref: Pick<SourceRef, 'authority' | 'provider'>): boolean {
  return isAuthoritativeForExistence(ref.authority) && !isThirdPartyProvider(ref.provider);
}

/** The source fields that decide whether its evidence counts. */
export interface SourceStanding {
  enabled: boolean;
  category: string;
  provider: string;
  authority: { tier: AuthorityTier; listingIsComplete?: boolean };
  /**
   * The source's enable/disable history (`sources.standingHistory`, DECISION_LOG 15c965b): from each
   * entry's `at` on, the source is `enabled`. Absent: the source never changed since this was
   * recorded, so it has had its current `enabled` all along (see `enabledAt`).
   */
  standingHistory?: ReadonlyArray<{ at: Date; enabled: boolean }>;
}

/**
 * Whether the source was enabled AT `at` (DECISION_LOG 15c965b: standing is evaluated as of the
 * evidence's own time, so a later enable/disable never rewrites the past). The latest history entry
 * at or before `at` decides; before the first entry (the source's creation), the first entry's
 * value. Without a history, the current `enabled`: every enable/disable since this release appends
 * an entry, seeded with the state before it, so a source without one has never changed while
 * evidence has been recorded. Tier and provider are immutable (not patchable), so they need no
 * history.
 */
export function enabledAt(s: Pick<SourceStanding, 'enabled' | 'standingHistory'>, at: Date): boolean {
  const h = s.standingHistory;
  if (!h?.length) return s.enabled;
  let value = h[0]!.enabled;
  for (const e of h) if (e.at.getTime() <= at.getTime()) value = e.enabled;
  return value;
}

/** `isAuthoritativeSource` as of `at`: enabled then, with an authoritative tier and provider. */
export function isAuthoritativeSourceAt(s: SourceStanding, at: Date): boolean {
  return enabledAt(s, at) && authoritativeTierOf(s) !== 'third_party';
}

/**
 * The tier a source's copies carry: its own, unless its provider is third-party by nature or (a
 * job source) outside the closed provider set — then `third_party`. Enabled or not.
 */
export function authoritativeTierOf(s: Omit<SourceStanding, 'enabled'>): AuthorityTier {
  if (!isAuthoritativeForExistence(s.authority.tier)) return s.authority.tier;
  if (isThirdPartyProvider(s.provider)) return 'third_party';
  if (s.category === 'job_source' && !isJobSourceProvider(s.provider)) return 'third_party';
  return s.authority.tier;
}

/**
 * Whether a source's evidence counts NOW (DECISION_LOG 6a01b36; PR #11 re-verify #7 MEDIUM-1,
 * LOW-1, LOW-2): the source is enabled, has an authoritative tier, its provider is not
 * third-party by nature, and — for a job source — its provider is one of the closed set
 * `JOB_SOURCE_PROVIDERS` (a stored provider outside it is read tolerantly but never
 * authoritative).
 */
export function isAuthoritativeSource(s: SourceStanding): boolean {
  return s.enabled && authoritativeTierOf(s) !== 'third_party';
}

/** A job source whose stored provider is outside the closed set (reported, never authoritative). */
export function hasUnrecognisedProvider(s: Pick<SourceStanding, 'category' | 'provider'>): boolean {
  return s.category === 'job_source' && !isJobSourceProvider(s.provider);
}
