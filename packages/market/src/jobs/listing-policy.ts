import type { SkippedEntry } from '../connectors/types';

/**
 * Listing absence policy (pure): decides whether a fetched job listing may be used as evidence
 * of absence, which source records it saw, and what it does to the shrink-guard baseline.
 * `market.finalize_job_listing` applies the decision; the lifecycle golden suite runs raw
 * provider listings through the same function.
 */
export interface ListingAssessmentInput {
  /** External ids of the entries the adapter mapped to observations. */
  itemExternalIds: Iterable<string>;
  /**
   * Entries on the board the adapter did not map (malformed, unlisted). They are ON the board:
   * every one with an id is seen, never absent (M6.1). Completeness already accounts for the
   * ones without an id (`finishListing`).
   */
  skipped: ReadonlyArray<Pick<SkippedEntry, 'externalId'>>;
  /** Adapter completeness AND the source's `listingIsComplete`. */
  complete: boolean;
  /** Source time of this listing (its snapshot's fetch time). */
  fetchedAt: Date;
  /** Source time of the last listing whose absences were applied. */
  lastListingAppliedAt?: Date | null;
  fanout: { total: number; failed: number };
  maxFailureRatio: number;
  /**
   * Size of the last listing whose absences were applied (`health.listingBaseline.count`); the
   * shrink guard compares against it (M6.2).
   */
  baselineCount?: number | null;
  /**
   * Size an operator confirmed as genuine for a shrink from this baseline (a `confirm`ed
   * `source_anomaly` review). It becomes the effective baseline: the listing is applied unless it
   * shrinks again from the confirmed size.
   */
  confirmedCount?: number | null;
  /**
   * The source's automatic small-board hold (`health.listingHeld` with reason
   * `small_board_empty`, L2): the fetch time of the listing it held. A later empty listing
   * releases it; the same (replayed) or an older listing is held again.
   */
  smallBoardHold?: { at: Date } | null;
}

export type ListingHoldCode =
  'already_applied' | 'incomplete' | 'item_failures' | 'shrink' | 'small_board_empty';

export interface ListingAssessment {
  /** Whether absences may be applied for this listing. */
  apply: boolean;
  code: ListingHoldCode | null;
  reason: string | null;
  /** Source records the listing contained: mapped items plus identified skipped entries. */
  seen: Set<string>;
  /**
   * Set for code `shrink`, for an applied, operator-confirmed shrink, and for code
   * `small_board_empty` (`baselineCount` = the effective baseline).
   */
  shrink: { baselineCount: number; count: number; confirmed: boolean } | null;
  /** The listing's size becomes the new baseline iff its absences are applied. */
  baselineAfter: number | null;
}

/** A complete listing smaller than this share of the baseline (and ≥ {@link SHRINK_MIN_DROP} smaller) is held. */
export const SHRINK_MIN_RATIO = 0.5;
/** Ordinary churn on a small board is not an anomaly: the drop must be at least this many entries. */
export const SHRINK_MIN_DROP = 10;

/**
 * A listing collapsed against its baseline: below half the baseline with a drop of at least ten
 * entries, so an empty listing is a shrink only after a board of ≥ 10 (held with a review). A
 * smaller board that empties is held for one run without a review (`small_board_empty`, ruling
 * L2). Mirrors the sponsor-register guard (> 50 %).
 */
export function isListingShrink(baselineCount: number | null | undefined, count: number): boolean {
  if (!baselineCount || baselineCount <= 0) return false;
  return count < baselineCount * SHRINK_MIN_RATIO && baselineCount - count >= SHRINK_MIN_DROP;
}

export function assessListing(input: ListingAssessmentInput): ListingAssessment {
  const seen = new Set(input.itemExternalIds);
  for (const s of input.skipped) if (s.externalId !== null) seen.add(s.externalId);
  const failureRatio = input.fanout.total ? input.fanout.failed / input.fanout.total : 0;
  const hold = (
    code: ListingHoldCode,
    reason: string,
    shrink: ListingAssessment['shrink'] = null,
  ): ListingAssessment => ({ apply: false, code, reason, seen, shrink, baselineAfter: null });
  if (input.lastListingAppliedAt && input.fetchedAt <= input.lastListingAppliedAt)
    return hold(
      'already_applied',
      'listing already applied (reprocessing does not count as a new observation of absence)',
    );
  if (!input.complete) return hold('incomplete', 'listing is not a complete snapshot');
  if (failureRatio > input.maxFailureRatio)
    return hold('item_failures', `${input.fanout.failed}/${input.fanout.total} items failed to process`);
  const baselineCount = input.baselineCount ?? null;
  let shrink: ListingAssessment['shrink'] = null;
  if (baselineCount !== null && isListingShrink(baselineCount, seen.size)) {
    const confirmed = input.confirmedCount ?? null;
    if (confirmed === null || isListingShrink(confirmed, seen.size)) {
      return hold(
        'shrink',
        seen.size === 0
          ? `empty listing after a non-empty one (baseline ${baselineCount}); treated as a source anomaly`
          : `listing shrank from ${baselineCount} to ${seen.size} entries; treated as a source anomaly`,
        { baselineCount, count: seen.size, confirmed: false },
      );
    }
    shrink = { baselineCount, count: seen.size, confirmed: true };
  }
  // L2: a small board (effective baseline below SHRINK_MIN_DROP) that empties is held for ONE
  // run automatically (no review); the next consecutive empty listing is applied.
  const effective = shrink?.confirmed ? (input.confirmedCount ?? null) : baselineCount;
  if (effective !== null && effective > 0 && effective < SHRINK_MIN_DROP && seen.size === 0) {
    const held = input.smallBoardHold ?? null;
    if (!held || input.fetchedAt <= held.at)
      return hold(
        'small_board_empty',
        `empty listing after a small board (baseline ${effective}); held for one run`,
        { baselineCount: effective, count: 0, confirmed: false },
      );
  }
  return { apply: true, code: null, reason: null, seen, shrink, baselineAfter: seen.size };
}

/** The job-level absence run a board-derived read may corroborate (DECISION_LOG b7f1a76). */
export interface JobAbsenceRun {
  /** Job-level `lifecycle.consecutiveAbsences` (not incremented while another authoritative copy is present). */
  consecutiveAbsences: number;
  /** Source time of the first absence of the run. */
  absentSince?: Date | null;
  /**
   * Job-level AUTHORITATIVE positive evidence (`authoritativeEvidenceAt`, DECISION_LOG a9af734):
   * the latest sighting of an authoritative copy (skipped entries included) or live verification.
   * Third-party sightings are not run evidence.
   */
  lastAuthoritativeSeenAt: Date | null;
  lastVerifiedAt?: Date | null;
}

/**
 * Board-derived verification (Ashby reads the whole board to check one job) — ruling
 * DECISION_LOG b7f1a76: its `not_found` is the SAME evidence as a listing read, never independent
 * verification. It may only corroborate a JOB-LEVEL absence run, i.e. all of:
 *  - the job was absent from ≥ 2 consecutive applied listings, counted at the job level (so no
 *    other authoritative copy was present);
 *  - no AUTHORITATIVE positive evidence for the job since the first absence (an authoritative
 *    sighting — mapped or skipped, in a held listing too — or a live verification; a third-party
 *    sighting is not run evidence, a9af734). Such evidence also restarts the run at the next
 *    absence (a9af734 M1), so the gate is never blocked forever;
 *  - no hold in force on the source;
 *  - an EMPTY board: no positive evidence on the source (any of its jobs) since the job's first
 *    absence; a non-empty board: not a shrink against the effective listing baseline
 *    (`max(listingBaseline.count, open jobs present on the source)`, A N-M3).
 * Otherwise it is `inconclusive`. Direct single-job 404s (Greenhouse, Lever) are not gated.
 */
export function boardDerivedNotFoundGate(input: {
  boardEntries: number;
  /** The effective baseline: `max(listingBaseline.count, open jobs present on the source)`. */
  baselineCount: number | null | undefined;
  listingHeld: boolean;
  run: JobAbsenceRun;
  /**
   * Latest positive evidence on the source itself (`lastPositiveEvidenceOnSource`): its own
   * copies' sightings and live verifications against it (a9af734 M2).
   */
  sourcePositiveAt: Date | null;
}): { counts: true } | { counts: false; reason: string } {
  const { run } = input;
  if (input.listingHeld) return { counts: false, reason: "the source's listings are held" };
  if (run.consecutiveAbsences < 2 || !run.absentSince)
    return {
      counts: false,
      reason: `the job is absent from ${run.consecutiveAbsences} consecutive applied listing(s) at the job level; a board read only corroborates a run of 2`,
    };
  const since = run.absentSince.getTime();
  if (
    (run.lastAuthoritativeSeenAt && run.lastAuthoritativeSeenAt.getTime() >= since) ||
    (run.lastVerifiedAt && run.lastVerifiedAt.getTime() >= since)
  )
    return {
      counts: false,
      reason: 'the job has been seen on an authoritative source or verified live since its first absence',
    };
  if (input.boardEntries === 0) {
    if (input.sourcePositiveAt && input.sourcePositiveAt.getTime() >= since)
      return {
        counts: false,
        reason: 'the board returned no entries, but the source showed a job since this one went absent',
      };
    return { counts: true };
  }
  if (isListingShrink(input.baselineCount, input.boardEntries))
    return {
      counts: false,
      reason: `the board returned ${input.boardEntries} entries against a baseline of ${input.baselineCount}`,
    };
  return { counts: true };
}
