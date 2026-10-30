import { isAuthoritativeCopy, isAuthoritativeSourceAt, type SourceStanding } from './authority';
import { sameBoard } from './board';
import type { JobEvidenceDoc } from './evidence';
import type { CopyBoard, JobLifecycle, JobState, SourceRef } from './job.schema';

export { isAuthoritativeCopy, isAuthoritativeForExistence } from './authority';

/**
 * Job lifecycle policy (pure), DERIVED from the job's evidence set (DECISION_LOG 6a01b36).
 *
 * State is never built by applying events as they arrive. Every verification result and every
 * listing presence/absence of a copy is recorded once as evidence (`market_job_evidence`), and
 * `deriveLifecycle` recomputes the whole lifecycle from that set: the evidence is put in one
 * canonical order (time, then positives before negatives, then key) and folded. The result is
 * therefore identical for any arrival order of the same evidence. The rules (FR-15, FR-19, ruling
 * L1, a9af734, 0bcc357, a01f993, b7f1a76) are unchanged:
 *
 *  - Evidence counts only when its source exists and — AS OF THE EVIDENCE'S OWN TIME (DECISION_LOG
 *    15c965b) — was enabled with an authoritative tier (not an aggregator, not a provider outside
 *    the closed set), and its board equals the board of the copy's latest sighting at or before it
 *    (canonical identity). A listing of another board is no evidence about the copy. A later
 *    enable/disable or board change therefore never rewrites the past; a disabled interval ends a
 *    not_found streak or an absence run, as a positive would.
 *  - A positive (a mapped authoritative sighting or a live verification) ends every negative
 *    before it; a negative counts only strictly after the latest positive (a skipped entry, which
 *    is on the board, is a positive for this purpose but not a verification — U1).
 *  - A failed fetch is a source problem and records no evidence.
 *  - Absence from a complete authoritative listing — with no other counting copy present, i.e.
 *    `present` with a positive within `staleAfterMs` — makes a job POSSIBLY_STALE. Absence alone never closes (L1): an absence-driven close needs
 *    ≥ `closeAfterAbsences` consecutive absences AND a `not_found` since the first of them.
 *  - Every close path (absence- or not_found-driven) also needs that no OTHER counting copy's
 *    latest evidence is a positive within `staleAfterMs` (DECISION_LOG 9b0cb03); else the job is
 *    POSSIBLY_STALE.
 *  - Verification alone closes after `closeAfterNotFound` consecutive `not_found`s, or at once
 *    when the job is absent from its listings. A board-derived `not_found` (Ashby reads the whole
 *    board) only corroborates a job-level absence run of ≥ 2 (b7f1a76).
 *  - Missing confirmation for `staleAfterMs` makes a job POSSIBLY_STALE; staleness never closes.
 *  - A closed job with a later positive is REOPENED; re-listed under a new posting (the copy's
 *    earliest sighting, counted or not), REPOSTED.
 */

export const LIFECYCLE_POLICY_VERSION = 'job-lifecycle/8';

export interface LifecyclePolicy {
  /**
   * Consecutive complete authoritative listings without the job before it may be closed — and
   * only with a `not_found` verification since the first of them (L1).
   */
  closeAfterAbsences: number;
  /** Consecutive not-found verifications before closing (when not also absent from listing). */
  closeAfterNotFound: number;
  /** Time without confirmation after which a live job becomes POSSIBLY_STALE. */
  staleAfterMs: number;
  maxHistory: number;
}

export const DEFAULT_LIFECYCLE_POLICY: LifecyclePolicy = {
  closeAfterAbsences: 2,
  closeAfterNotFound: 2,
  staleAfterMs: 72 * 3600_000,
  maxHistory: 50,
};

/**
 * The job's latest AUTHORITATIVE positive evidence (DECISION_LOG a9af734): a sighting of an
 * official-ATS / official-site / operator copy (skipped entries included: they are on the board)
 * or a live verification (`lastVerifiedAt`). Read by the board-derived check gate.
 */
export function authoritativeEvidenceAt(job: {
  lifecycle: Pick<JobLifecycle, 'lastVerifiedAt'>;
  sourceRefs: ReadonlyArray<Pick<SourceRef, 'authority' | 'provider' | 'lastSeenAt'>>;
}): Date | null {
  let latest = job.lifecycle.lastVerifiedAt ?? null;
  for (const r of job.sourceRefs)
    if (isAuthoritativeCopy(r) && (!latest || r.lastSeenAt > latest)) latest = r.lastSeenAt;
  return latest;
}

export type EvidenceItem = Pick<
  JobEvidenceDoc,
  | '_id'
  | 'copyKey'
  | 'sourceId'
  | 'board'
  | 'at'
  | 'kind'
  | 'outcome'
  | 'boardDerived'
  | 'skipped'
  | 'contentHash'
  | 'reason'
  | 'history'
  | 'lastChangedAt'
>;

/** What derivation needs to know about the job itself: its copies and when it was seen. */
export interface DeriveJob {
  copies: ReadonlyArray<
    Pick<SourceRef, 'key' | 'sourceId' | 'board'> & Partial<Pick<SourceRef, 'authority' | 'provider'>>
  >;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/** The evidence-derived part of `JobLifecycle` (first/last seen and published are copy data). */
export type DerivedLifecycle = Omit<
  JobLifecycle,
  'firstSeenAt' | 'lastSeenAt' | 'publishedAt' | 'listingMarks' | 'appliedVerifications'
>;

export type LatestVerification = { at: Date; outcome: 'live' | 'not_found' | 'inconclusive'; id: string };

export interface Derivation {
  lifecycle: DerivedLifecycle;
  /** The latest verification (any outcome, any source), for the job's `verification` summary. */
  latestVerification: LatestVerification | null;
}

/**
 * The fold's state after some prefix (in canonical order) of the evidence — everything but the
 * `now`-dependent final decay. Serializable: it is the recompute checkpoint (DECISION_LOG
 * 15c965b), a derived cache that is always rebuildable from the evidence and never authoritative.
 */
export interface FoldState {
  state: JobState | null;
  history: JobLifecycle['history'];
  lastVerifiedAt: Date | null;
  lastPositiveAt: Date | null;
  lastChangedAt: Date | null;
  consecutiveAbsences: number;
  absentSince: Date | null;
  consecutiveNotFound: number;
  lastNotFoundAt: Date | null;
  closedAt: Date | null;
  closeReason: string | null;
  /** Listing status of each copy from counted evidence (a copy without one is unknown). */
  status: Record<string, { value: 'present' | 'absent'; at: Date }>;
  /** Polarity and time of each copy's latest counted evidence (listing or verification). */
  latest: Record<string, { value: 'positive' | 'negative'; at: Date }>;
  /** The board of each copy's latest sighting so far (counted or not). */
  sightingBoard: Record<string, CopyBoard>;
  /** Each copy's latest counted content hash (its first counted sighting has one). */
  contentHash: Record<string, string>;
  /**
   * The evidence id of each copy's EARLIEST sighting — counted or not (a sighting while its source
   * was disabled, on another board, a skipped entry), or a legacy "seen" baseline. A counted
   * mapped sighting while the job is CLOSED is a repost only if it is that earliest sighting. From
   * the evidence only, never from the copy's `firstSeenAt`.
   */
  firstSighting: Record<string, string>;
  latestVerification: LatestVerification | null;
  /** The latest time folded (evidence or standing event); null before any. */
  watermark: Date | null;
  /** Evidence documents folded (standing events excluded). */
  count: number;
}

export function initialFoldState(): FoldState {
  return {
    state: null,
    history: [],
    lastVerifiedAt: null,
    lastPositiveAt: null,
    lastChangedAt: null,
    consecutiveAbsences: 0,
    absentSince: null,
    consecutiveNotFound: 0,
    lastNotFoundAt: null,
    closedAt: null,
    closeReason: null,
    status: {},
    latest: {},
    sightingBoard: {},
    contentHash: {},
    firstSighting: {},
    latestVerification: null,
    watermark: null,
    count: 0,
  };
}

/** A standing event: the source was disabled at `at` (from its `standingHistory`). */
interface StandingEvent {
  _id: string;
  kind: 'standing';
  sourceId: string;
  at: Date;
}
type FoldItem = EvidenceItem | StandingEvent;

type Polarity = 'positive' | 'negative' | 'none';
function polarityOf(e: FoldItem): Polarity {
  if (e.kind === 'standing') return 'positive'; // a disabled interval ends negatives, as a positive would
  if (e.outcome === 'live' || e.outcome === 'present') return 'positive';
  if (e.outcome === 'not_found' || e.outcome === 'absent' || e.outcome === 'closed') return 'negative';
  return 'none';
}
const RANK: Record<Polarity, number> = { positive: 0, negative: 1, none: 2 };

/** The canonical order: time, then positives before negatives (a tie never closes), then key. */
export function canonicalOrder(a: FoldItem, b: FoldItem): number {
  return (
    a.at.getTime() - b.at.getTime() ||
    RANK[polarityOf(a)] - RANK[polarityOf(b)] ||
    (a._id < b._id ? -1 : a._id > b._id ? 1 : 0)
  );
}

const LIVEISH: JobState[] = ['DISCOVERED', 'VERIFIED_LIVE', 'CHANGED', 'REOPENED', 'REPOSTED'];

/** The disable events of the job's sources in (`after`, `until`] (`after` null: from the start). */
function standingEvents(
  sources: ReadonlyMap<string, SourceStanding>,
  job: Pick<DeriveJob, 'copies'>,
  after: Date | null,
  until: Date | null,
): StandingEvent[] {
  const out: StandingEvent[] = [];
  if (!until) return out;
  for (const sourceId of new Set(job.copies.map((c) => c.sourceId))) {
    const history = sources.get(sourceId)?.standingHistory ?? [];
    for (const h of history)
      if (!h.enabled && (!after || h.at.getTime() > after.getTime()) && h.at.getTime() <= until.getTime())
        out.push({ _id: `standing:${sourceId}@${h.at.getTime()}`, kind: 'standing', sourceId, at: h.at });
  }
  return out;
}

/**
 * Whether `e` counts (DECISION_LOG 6a01b36, amended by 15c965b): job-level baseline evidence
 * always does; copy evidence only for a copy the job still has, from a source that exists and was
 * enabled and authoritative AS OF `e.at` (tier and provider are immutable), read on the board of
 * the copy's latest sighting at or before it (`boardAt`, canonical identity) — and an absence only
 * from a source whose listings are complete.
 */
function counts(
  e: EvidenceItem,
  sources: ReadonlyMap<string, SourceStanding>,
  job: Pick<DeriveJob, 'copies'>,
  boardAt: CopyBoard | null | undefined,
): boolean {
  if (e.kind === 'baseline' && e.copyKey === null) return true;
  if (!e.copyKey || !e.sourceId) return false;
  const copy = job.copies.find((c) => c.key === e.copyKey);
  if (!copy || copy.sourceId !== e.sourceId) return false;
  const source = sources.get(e.sourceId);
  if (!source || !isAuthoritativeSourceAt(source, e.at)) return false;
  if (e.outcome === 'absent' && !source.authority.listingIsComplete) return false;
  return sameBoard(e.board, boardAt);
}

/**
 * Fold `evidence` — all of it later than `from.watermark` — into `from`, with the job's sources'
 * disable events in (`from.watermark`, `until`]; `until` defaults to the latest evidence time, and
 * becomes the new watermark. Pure. The items are put in canonical order first, so the result
 * depends on the SET only, and folding a set in two parts split at a time (`from` = the fold of
 * everything up to its watermark) equals folding it at once. `deriveLifecycle` folds the tail of
 * disable events up to `now` (without evidence) just before finalizing.
 */
export function foldEvidence(
  from: FoldState,
  evidence: ReadonlyArray<EvidenceItem>,
  sources: ReadonlyMap<string, SourceStanding>,
  job: DeriveJob,
  policy: LifecyclePolicy = DEFAULT_LIFECYCLE_POLICY,
  until?: Date,
): FoldState {
  const f: FoldState = structuredClone(from);
  let upTo: Date | null = until ?? from.watermark;
  if (!until) for (const e of evidence) if (!upTo || e.at > upTo) upTo = e.at;
  const items: FoldItem[] = [...evidence, ...standingEvents(sources, job, from.watermark, upTo)].sort(
    canonicalOrder,
  );
  const copySource = new Map(job.copies.map((c) => [c.key, c.sourceId]));
  // Absences of one listing (source + fetch time), grouped once: linear, not quadratic.
  const groups = new Map<string, EvidenceItem[]>();

  const transition = (to: JobState, at: Date, reason: string, sourceId?: string | null) => {
    if (f.state === to) return;
    // History never gains an entry dated before the ones it has (a legacy history, a decay).
    const last = f.history[f.history.length - 1]?.at;
    const when = last && last.getTime() > at.getTime() ? last : at;
    f.history.push({ at: when, from: f.state, to, reason, ...(sourceId ? { sourceId } : {}) });
    if (f.history.length > policy.maxHistory) f.history = f.history.slice(-policy.maxHistory);
    f.state = to;
    if (to === 'CLOSED') {
      f.closedAt = when;
      f.closeReason = reason;
    }
  };
  const ensureState = () => {
    if (f.state === null) transition('DISCOVERED', job.firstSeenAt, 'first seen on third-party source');
  };
  const resetNegatives = () => {
    f.consecutiveAbsences = 0;
    f.absentSince = null;
    f.consecutiveNotFound = 0;
  };
  const decay = (t: Date) => {
    if (!f.state || !LIVEISH.includes(f.state) || !f.lastVerifiedAt) return;
    const due = f.lastVerifiedAt.getTime() + policy.staleAfterMs;
    if (t.getTime() > due)
      transition('POSSIBLY_STALE', new Date(due), 'not confirmed within freshness window');
  };
  /**
   * Whether a counted copy is still listed at `at`: its status is `present` and its latest
   * positive is within the stale window (DECISION_LOG 9b0cb03). A `present` older than that — a
   * copy on a source whose listings are incomplete and so never record its absence — no longer
   * keeps the job listed.
   */
  const anyPresent = (at: Date) =>
    Object.entries(f.status).some(([key, v]) => {
      if (v.value !== 'present') return false;
      const l = f.latest[key];
      const positive = l?.value === 'positive' && l.at > v.at ? l.at : v.at;
      return at.getTime() - positive.getTime() <= policy.staleAfterMs;
    });
  /** Job-level absence at `at`: no copy still listed, and an absence after the latest positive. */
  const absentFromListings = (at: Date) =>
    !anyPresent(at) &&
    Object.values(f.status).some(
      (v) => v.value === 'absent' && (!f.lastPositiveAt || v.at.getTime() > f.lastPositiveAt.getTime()),
    );
  const afterPositive = (at: Date) => !f.lastPositiveAt || at.getTime() > f.lastPositiveAt.getTime();
  const positiveAt = (at: Date) => {
    if (!f.lastPositiveAt || at > f.lastPositiveAt) f.lastPositiveAt = at;
  };
  /**
   * Whether a counting copy other than `except` shows the job live at `at`: its latest evidence is
   * a positive within the stale window (DECISION_LOG 9b0cb03). Every close path requires that
   * none does; an older positive (e.g. a copy whose board changed, so that nothing counts for it
   * any more) no longer blocks a closure.
   */
  const otherRecentPositive = (except: ReadonlySet<string>, at: Date) =>
    Object.entries(f.latest).some(
      ([key, v]) =>
        !except.has(key) && v.value === 'positive' && at.getTime() - v.at.getTime() <= policy.staleAfterMs,
    );

  // Which evidence counts, decided in canonical order (the copy's board is the one of its latest
  // sighting at or before the evidence).
  const counted: FoldItem[] = [];
  for (const item of items) {
    if (item.kind === 'standing') {
      counted.push(item);
      continue;
    }
    if (item.outcome === 'present' && item.copyKey && item.board) f.sightingBoard[item.copyKey] = item.board;
    // The copy's earliest sighting, counted or not (canonical order: the first one met).
    if (
      item.copyKey &&
      !f.firstSighting[item.copyKey] &&
      (item.outcome === 'present' || (item.kind === 'baseline' && item.outcome === 'inconclusive'))
    )
      f.firstSighting[item.copyKey] = item._id;
    const boardAt = item.copyKey
      ? (f.sightingBoard[item.copyKey] ?? job.copies.find((c) => c.key === item.copyKey)?.board)
      : null;
    if (counts(item, sources, job, boardAt)) {
      counted.push(item);
      if (item.kind === 'listing' && item.outcome === 'absent') {
        const key = `${item.sourceId}@${item.at.getTime()}`;
        const g = groups.get(key);
        if (g) g.push(item);
        else groups.set(key, [item]);
      }
    }
  }
  for (const item of items) {
    if (item.kind === 'standing') continue;
    f.count += 1;
    if (item.kind === 'verification')
      f.latestVerification = {
        at: item.at,
        outcome: item.outcome as LatestVerification['outcome'],
        id: item._id,
      };
    if (!f.watermark || item.at > f.watermark) f.watermark = item.at;
  }
  if (upTo && (!f.watermark || upTo > f.watermark)) f.watermark = upTo;

  const handledAbsences = new Set<string>();
  for (const e of counted) {
    decay(e.at);
    if (e.kind === 'standing') {
      // The source was disabled: its copies become unknown, always (a CLOSED job included), and
      // the job's negatives end (a streak never spans a disabled interval). A closure stands: while
      // CLOSED there are no negatives to end and no positive to note.
      for (const [key, sourceId] of copySource)
        if (sourceId === e.sourceId) {
          delete f.status[key];
          delete f.latest[key];
        }
      if (f.state === 'CLOSED') continue;
      resetNegatives();
      positiveAt(e.at);
      continue;
    }
    if (e.kind === 'baseline') {
      // The conservative start of a job written before derivation: its last positive, its present
      // copies and its closure — never its negatives, and never a transition before its history
      // (a non-live legacy state such as POSSIBLY_STALE stays until newer evidence).
      if (!e.copyKey && (e.outcome === 'live' || e.outcome === 'inconclusive')) {
        // The job-level baseline carries the legacy history and state.
        if (e.history?.length && f.history.length === 0) {
          f.history = [...e.history];
          f.state = e.history[e.history.length - 1]!.to;
          if (f.state === 'CLOSED') {
            const closure = [...e.history].reverse().find((h) => h.to === 'CLOSED');
            f.closedAt = closure?.at ?? null;
            f.closeReason = closure?.reason ?? null;
          }
        }
        if (e.lastChangedAt && (!f.lastChangedAt || e.lastChangedAt > f.lastChangedAt))
          f.lastChangedAt = e.lastChangedAt;
        if (e.outcome === 'live') {
          if (!f.lastVerifiedAt || e.at > f.lastVerifiedAt) f.lastVerifiedAt = e.at;
          positiveAt(e.at);
          if (f.state === null) transition('VERIFIED_LIVE', e.at, 'first seen on authoritative source');
        }
      } else if (e.outcome === 'present' && e.copyKey) {
        f.status[e.copyKey] = { value: 'present', at: e.at };
        f.latest[e.copyKey] = { value: 'positive', at: e.at };
        if (e.contentHash) f.contentHash[e.copyKey] = e.contentHash;
        positiveAt(e.at);
      } else if (e.outcome === 'closed') {
        ensureState();
        if (f.state !== 'CLOSED')
          transition('CLOSED', e.at, e.reason ?? 'closed before the derived lifecycle');
        f.closedAt ??= e.at;
        f.closeReason ??= e.reason ?? 'closed before the derived lifecycle';
      }
      continue;
    }
    const copy = e.copyKey!;
    const polarity = polarityOf(e);
    if (polarity === 'positive') {
      const listing = e.kind === 'listing';
      if (listing) f.status[copy] = { value: 'present', at: e.at };
      f.latest[copy] = { value: 'positive', at: e.at };
      positiveAt(e.at);
      resetNegatives();
      // A skipped entry is on the board but was not read (U1): it ends the negatives before it,
      // and moves neither the verification time nor the state.
      if (e.skipped) continue;
      if (!f.lastVerifiedAt || e.at > f.lastVerifiedAt) f.lastVerifiedAt = e.at;
      // CHANGED / REPOSTED from the recorded content hashes and sightings, in time order. A first
      // sighting: the copy's earliest sighting in the evidence, counted or not (nor a legacy
      // "seen" baseline) — from the evidence only, whatever order it arrived in.
      const firstSighting = listing && f.firstSighting[copy] === e._id;
      const previousHash = f.contentHash[copy];
      const changed = listing && !!e.contentHash && !!previousHash && previousHash !== e.contentHash;
      if (listing && e.contentHash) f.contentHash[copy] = e.contentHash;
      if (f.state === null)
        transition(
          'VERIFIED_LIVE',
          e.at,
          listing ? 'first seen on authoritative source' : 'verified live',
          e.sourceId,
        );
      else if (f.state === 'CLOSED') {
        if (firstSighting)
          transition('REPOSTED', e.at, 'closed job re-listed under a new posting', e.sourceId);
        else
          transition(
            'REOPENED',
            e.at,
            listing ? 'seen again after closure' : 'verified live after closure',
            e.sourceId,
          );
        f.closedAt = null;
        f.closeReason = null;
      } else if (changed) {
        f.lastChangedAt = e.at;
        transition('CHANGED', e.at, 'material content change', e.sourceId);
      } else if (f.state !== 'VERIFIED_LIVE')
        transition(
          'VERIFIED_LIVE',
          e.at,
          listing ? 'confirmed on authoritative source' : 'verified live',
          e.sourceId,
        );
      continue;
    }
    if (polarity !== 'negative') continue; // inconclusive: evidence of nothing
    if (e.kind === 'listing') {
      // One listing is ONE absence for the job, however many of its copies it lacked.
      const group = `${e.sourceId}@${e.at.getTime()}`;
      if (handledAbsences.has(group)) continue;
      handledAbsences.add(group);
      const members = groups.get(group) ?? [];
      for (const x of members) {
        f.status[x.copyKey!] = { value: 'absent', at: x.at };
        f.latest[x.copyKey!] = { value: 'negative', at: x.at };
      }
      if (!afterPositive(e.at)) continue;
      ensureState();
      if (f.state === 'CLOSED') continue;
      // Another counting copy is present: the job is still listed (a9af734).
      if (anyPresent(e.at)) continue;
      if (f.consecutiveAbsences === 0 || !f.absentSince) {
        f.absentSince = e.at;
        f.consecutiveAbsences = 1;
      } else f.consecutiveAbsences += 1;
      const corroborated = !!f.lastNotFoundAt && f.lastNotFoundAt.getTime() >= f.absentSince.getTime();
      const listedElsewhere = otherRecentPositive(new Set(members.map((x) => x.copyKey!)), e.at);
      if (f.consecutiveAbsences >= policy.closeAfterAbsences && corroborated && !listedElsewhere)
        transition(
          'CLOSED',
          e.at,
          `absent from ${f.consecutiveAbsences} consecutive complete authoritative listings and verified not found`,
          e.sourceId,
        );
      else
        transition('POSSIBLY_STALE', e.at, 'absent from latest complete authoritative listing', e.sourceId);
      continue;
    }
    // A not_found verification.
    if (!afterPositive(e.at)) continue;
    ensureState();
    if (f.state === 'CLOSED') continue;
    // A board read is the same evidence as a listing: it only corroborates a job-level absence
    // run of two (b7f1a76).
    if (e.boardDerived && f.consecutiveAbsences < policy.closeAfterAbsences) continue;
    f.latest[copy] = { value: 'negative', at: e.at };
    f.consecutiveNotFound += 1;
    f.lastNotFoundAt = e.at;
    // A not_found about one copy closes the job only when no OTHER counting copy's latest
    // evidence is a positive within the stale window (DECISION_LOG 15c965b, 9b0cb03).
    const otherPositive = otherRecentPositive(new Set([copy]), e.at);
    const absent = absentFromListings(e.at);
    if (!otherPositive && (absent || f.consecutiveNotFound >= policy.closeAfterNotFound))
      transition(
        'CLOSED',
        e.at,
        absent
          ? 'verified not found and absent from listing'
          : `not found in ${f.consecutiveNotFound} consecutive verifications`,
        e.sourceId,
      );
    else transition('POSSIBLY_STALE', e.at, 'verification did not find the posting', e.sourceId);
  }
  return f;
}

/** The lifecycle at `now` from a fold state: the final stale decay and the no-evidence rules. */
export function finalizeFold(
  from: FoldState,
  now: Date,
  job: DeriveJob,
  policy: LifecyclePolicy = DEFAULT_LIFECYCLE_POLICY,
): Derivation {
  const f: FoldState = structuredClone(from);
  const transition = (to: JobState, at: Date, reason: string) => {
    if (f.state === to) return;
    const last = f.history[f.history.length - 1]?.at;
    const when = last && last.getTime() > at.getTime() ? last : at;
    f.history.push({ at: when, from: f.state, to, reason });
    f.history = f.history.slice(-policy.maxHistory);
    f.state = to;
  };
  if (f.state && LIVEISH.includes(f.state) && f.lastVerifiedAt) {
    const due = f.lastVerifiedAt.getTime() + policy.staleAfterMs;
    if (now.getTime() > due)
      transition('POSSIBLY_STALE', new Date(due), 'not confirmed within freshness window');
  }
  if (f.state === null) {
    // No counting evidence at all. A job known only from third-party copies is DISCOVERED; one
    // with authoritative copies whose evidence never counted is unconfirmed — POSSIBLY_STALE.
    const unconfirmed = job.copies.some(
      (c) =>
        c.authority !== undefined &&
        c.provider !== undefined &&
        isAuthoritativeCopy({ authority: c.authority, provider: c.provider }),
    );
    if (unconfirmed)
      transition('POSSIBLY_STALE', job.lastSeenAt, 'no enabled authoritative source confirms the job');
    else transition('DISCOVERED', job.firstSeenAt, 'first seen on third-party source');
  }
  // A job never confirmed by counting evidence decays on its last sighting (third-party copies).
  if (
    f.state === 'DISCOVERED' &&
    !f.lastVerifiedAt &&
    now.getTime() - job.lastSeenAt.getTime() > policy.staleAfterMs
  )
    transition(
      'POSSIBLY_STALE',
      new Date(job.lastSeenAt.getTime() + policy.staleAfterMs),
      'not confirmed within freshness window',
    );
  const state = f.state as unknown as JobState;
  const lifecycle: DerivedLifecycle = {
    state,
    consecutiveAbsences: f.consecutiveAbsences,
    consecutiveNotFound: f.consecutiveNotFound,
    history: f.history,
    derivedVersion: LIFECYCLE_POLICY_VERSION,
  };
  if (f.lastVerifiedAt) lifecycle.lastVerifiedAt = f.lastVerifiedAt;
  if (f.lastChangedAt) lifecycle.lastChangedAt = f.lastChangedAt;
  if (state === 'CLOSED' && f.closedAt) lifecycle.closedAt = f.closedAt;
  if (state === 'CLOSED' && f.closeReason) lifecycle.closeReason = f.closeReason;
  if (f.absentSince) lifecycle.absentSince = f.absentSince;
  if (f.lastNotFoundAt) lifecycle.lastNotFoundAt = f.lastNotFoundAt;
  return { lifecycle, latestVerification: f.latestVerification };
}

/**
 * Derive the lifecycle from the evidence set (6a01b36, 15c965b): a pure function of the evidence
 * SET and the sources' standing history. Any permutation gives the same result; `now` only drives
 * the final stale decay.
 */
export function deriveLifecycle(
  evidence: ReadonlyArray<EvidenceItem>,
  sources: ReadonlyMap<string, SourceStanding>,
  now: Date,
  job: DeriveJob,
  policy: LifecyclePolicy = DEFAULT_LIFECYCLE_POLICY,
): Derivation {
  const folded = foldEvidence(initialFoldState(), evidence, sources, job, policy);
  return finalizeFold(foldEvidence(folded, [], sources, job, policy, now), now, job, policy);
}
