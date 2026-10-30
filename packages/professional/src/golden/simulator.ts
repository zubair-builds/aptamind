import { canonicalJson } from '@aptamind/contracts';
import type { ObservationMode } from '../contracts/basis';
import { type ClaimType, parseClaimValue } from '../contracts/claims';
import { type AssertionState, assertTransition, confirmationTransition } from '../assertions/transitions';
import {
  type AssertionSnapshot,
  type CanonicalDecision,
  type EventDraft,
  PROF_REC_1,
  type ReconcileResult,
  type ReconciliationPolicy,
  reconcileItem,
  type SupersessionRecord,
} from '../reconciliation/policy';
import type { RequestDraft } from '../reconciliation/requests';

/**
 * An in-memory, single-item test double of the evidence → assertion → reconciliation loop, used
 * by the golden suites. It models observations (support), minimal subject decisions and the
 * application of `reconcileItem` results (guarded transitions, canonical, requests). Decision
 * semantics are simplified stand-ins for P4.1: they only use the subject rows of the transition
 * table. Every applied transition is checked against the current state (the write guard), and
 * after every step the result must be a fixed point (reconciling again changes nothing).
 */

export interface ObserveStep {
  value: string;
  source: string;
  asOf: string;
  mode?: ObservationMode;
  /** The document date is declared (else `asOf` is the acquisition time). */
  declared?: boolean;
  /** Source authorship: `subject` (CV, form) by default. */
  authorship?: 'subject' | 'other';
  unverified?: boolean;
}

export type Step =
  | { observe: ObserveStep }
  | { reprocess: { source: string; extractor?: number; drop?: string[] } }
  | { quarantine: string }
  | { unquarantine: string }
  | { sourceWithout: { source: string; asOf: string } }
  | { confirm: { value: string; at: string; rejectRivals?: string[] } }
  | { reject: { value: string; at: string } }
  | { mark_outdated: { value: string; validTo: string; at: string } }
  /** "Keep" a confirmed value (answer to a reconfirm), optionally rejecting named rivals. */
  | { reaffirm: { value: string; at: string; rejectRivals?: string[] } }
  /** "Still rejected" (answer to rejected_restated). */
  | { still_rejected: { value: string; at: string } }
  /** "Still outdated" (answer to outdated_restated): the value was not true after `validTo`. */
  | { still_outdated: { value: string; validTo: string } }
  | {
      seed: {
        value: string;
        state: AssertionState;
        at?: string;
        supersession?: {
          cause: SupersessionRecord['cause'];
          supersededAtAsOf?: string;
          supersededBy?: string;
        };
      };
    }
  | { deactivate: true }
  | { reconcile: true };

interface Obs {
  id: string;
  label: string;
  source: string;
  extractor: number;
  mode: ObservationMode;
  asOf: Date;
  declared: boolean;
  subjectAuthored: boolean;
  unverified: boolean;
  status: 'current' | 'superseded' | 'quarantined';
}

interface Rec {
  id: string;
  label: string;
  value: unknown;
  state: AssertionState;
  stateChangedAt?: Date;
  confirmedAt?: Date;
  reaffirmedAt?: Date;
  rejectionReaffirmedAt?: Date;
  supersession?: SupersessionRecord;
}

/** Evaluates a write guard the way MongoDB would: `{ state: S }` or `{ state: { $eq, $nin } }`. */
function matchesGuard(
  state: AssertionState,
  guard: { state: AssertionState | { $eq: AssertionState; $nin: AssertionState[] } },
): boolean {
  if (typeof guard.state === 'string') return state === guard.state;
  return state === guard.state.$eq && !guard.state.$nin.includes(state);
}

export const assertionIdOf = (label: string) => `pasr_${label}`;
export const labelOf = (id: string) => id.replace(/^pasr_/, '');
const date = (s: string) => new Date(s.length <= 10 ? `${s}T00:00:00Z` : s);

export interface StepOutcome {
  result: ReconcileResult;
  /** Problems found while applying (guard misses, non-fixed-point results). */
  problems: string[];
}

export class ItemSimulator {
  readonly itemId = 'pitm_golden';
  private readonly values = new Map<string, unknown>();
  private readonly recs = new Map<string, Rec>();
  private readonly observations: Obs[] = [];
  private readonly openRequests = new Map<string, RequestDraft>();
  private active = true;
  canonical: CanonicalDecision | null = null;
  canonicalChanges = 0;
  readonly events: EventDraft[] = [];

  constructor(
    readonly claimType: ClaimType,
    values: Record<string, unknown>,
    private readonly policy: ReconciliationPolicy = PROF_REC_1,
    private readonly organizationAliases: string[][] = [],
  ) {
    for (const [label, raw] of Object.entries(values))
      this.values.set(label, parseClaimValue(claimType, raw));
  }

  /** The normalized value of a label (for expectations). */
  valueOf(label: string): unknown {
    if (!this.values.has(label)) throw new Error(`unknown value label ${label}`);
    return this.values.get(label);
  }

  state(label: string): AssertionState | undefined {
    return this.recs.get(label)?.state;
  }

  assertionLabels(): string[] {
    return [...this.recs.keys()].sort();
  }

  requests(): RequestDraft[] {
    return [...this.openRequests.values()];
  }

  /** The assertion holding a label's normalized value, if any. */
  private byValue(label: string): Rec | undefined {
    const key = canonicalJson(this.valueOf(label));
    return [...this.recs.values()].find((x) => canonicalJson(x.value) === key);
  }

  /** The assertion for a label (created as `PROPOSED` on first support, like resolution does). */
  private rec(label: string, create: AssertionState | null): Rec | undefined {
    // Identical normalized values share one assertion (`det(itemId, valueKey)`), whatever the label.
    let r = this.recs.get(label) ?? this.byValue(label);
    if (!r && create) {
      r = { id: assertionIdOf(label), label, value: this.valueOf(label), state: create };
      this.recs.set(label, r);
    }
    return r;
  }

  apply(step: Step): StepOutcome {
    if ('observe' in step) this.observe(step.observe);
    else if ('reprocess' in step) this.reprocess(step.reprocess);
    else if ('quarantine' in step) this.setStatus(step.quarantine, 'current', 'quarantined');
    else if ('unquarantine' in step) this.setStatus(step.unquarantine, 'quarantined', 'current');
    else if ('sourceWithout' in step) {
      /* A newer source that does not mention this item: absence is not negation (PL-6). */
    } else if ('confirm' in step) this.confirm(step.confirm);
    else if ('reject' in step) this.subject(step.reject.value, 'REJECTED', date(step.reject.at));
    else if ('mark_outdated' in step) {
      const r = this.rec(step.mark_outdated.value, null);
      if (!r) throw new Error('mark_outdated of an unknown value');
      this.subject(r.label, 'SUPERSEDED', date(step.mark_outdated.at), {
        cause: 'subject',
        supersededAtAsOf: date(step.mark_outdated.validTo),
      });
    } else if ('reaffirm' in step) {
      const r = this.byValue(step.reaffirm.value);
      if (r?.state !== 'CONFIRMED') throw new Error('reaffirm of a value that is not confirmed');
      r.reaffirmedAt = date(step.reaffirm.at);
      this.closeRequestsNaming(r.id);
      for (const label of step.reaffirm.rejectRivals ?? [])
        this.subject(label, 'REJECTED', date(step.reaffirm.at));
    } else if ('still_rejected' in step) {
      const r = this.byValue(step.still_rejected.value);
      if (r?.state !== 'REJECTED') throw new Error('still_rejected of a value that is not rejected');
      r.rejectionReaffirmedAt = date(step.still_rejected.at);
      this.closeRequestsNaming(r.id);
    } else if ('still_outdated' in step) {
      const r = this.byValue(step.still_outdated.value);
      if (r?.state !== 'SUPERSEDED' || r.supersession?.cause !== 'subject')
        throw new Error('still_outdated of a value the subject did not mark outdated');
      r.supersession = { ...r.supersession, supersededAtAsOf: date(step.still_outdated.validTo) };
      this.closeRequestsNaming(r.id);
    } else if ('seed' in step) {
      const r = this.rec(step.seed.value, step.seed.state) as Rec;
      r.state = step.seed.state;
      if (step.seed.at) r.stateChangedAt = r.confirmedAt = date(step.seed.at);
      if (step.seed.supersession)
        r.supersession = {
          cause: step.seed.supersession.cause,
          ...(step.seed.supersession.supersededBy
            ? { supersededBy: assertionIdOf(step.seed.supersession.supersededBy) }
            : {}),
          ...(step.seed.supersession.supersededAtAsOf
            ? { supersededAtAsOf: date(step.seed.supersession.supersededAtAsOf) }
            : {}),
        };
    } else if ('deactivate' in step) this.active = false;
    return this.reconcile();
  }

  private observe(o: ObserveStep): void {
    const r = this.rec(o.value, 'PROPOSED') as Rec;
    const id = `${o.source}@1:${r.label}`;
    if (this.observations.some((x) => x.id === id)) return; // replay: deterministic id, insert-if-absent
    this.observations.push({
      id,
      label: r.label,
      source: o.source,
      extractor: 1,
      mode: o.mode ?? 'extracted',
      asOf: date(o.asOf),
      declared: o.declared ?? false,
      subjectAuthored: (o.authorship ?? 'subject') === 'subject',
      unverified: o.unverified ?? false,
      status: 'current',
    });
  }

  /** Re-run extraction of a source: same snapshot, same `sourceAsOf`; a new extractor version supersedes. */
  private reprocess(p: { source: string; extractor?: number; drop?: string[] }): void {
    if (p.extractor === undefined) return; // same extractor version: deterministic ids, nothing new
    const version = p.extractor;
    const old = this.observations.filter(
      (o) => o.source === p.source && o.extractor < version && o.status === 'current',
    );
    for (const o of old) {
      o.status = 'superseded';
      if (p.drop?.includes(o.label)) continue;
      const id = `${o.source}@${version}:${o.label}`;
      if (!this.observations.some((x) => x.id === id))
        this.observations.push({ ...o, id, extractor: version, status: 'current' });
    }
  }

  private setStatus(source: string, from: Obs['status'], to: Obs['status']): void {
    for (const o of this.observations) if (o.source === source && o.status === from) o.status = to;
  }

  private confirm(c: { value: string; at: string; rejectRivals?: string[] }): void {
    const at = date(c.at);
    const existing = this.rec(c.value, null);
    const t = confirmationTransition(existing?.state ?? null);
    if ('noop' in t) return;
    const r = existing ?? (this.rec(c.value, 'CONFIRMED') as Rec);
    for (const other of this.recs.values())
      if (other !== r && other.state === 'CONFIRMED')
        this.subject(other.label, 'SUPERSEDED', at, {
          cause: 'subject',
          supersededBy: r.id,
          supersededAtAsOf: at,
        });
    r.state = 'CONFIRMED';
    r.stateChangedAt = r.confirmedAt = at;
    this.closeRequestsNaming(r.id);
    for (const label of c.rejectRivals ?? []) this.subject(label, 'REJECTED', at);
  }

  private subject(label: string, to: AssertionState, at: Date, supersession?: SupersessionRecord): void {
    const r = this.rec(label, null);
    if (!r) throw new Error(`decision on unknown value ${label}`);
    assertTransition(r.state, to, 'subject');
    r.state = to;
    r.stateChangedAt = at;
    if (supersession) r.supersession = supersession;
    this.closeRequestsNaming(r.id);
  }

  /** A decision resolves the requests it answers. */
  private closeRequestsNaming(id: string): void {
    for (const [k, q] of this.openRequests) if (q.assertionIds.includes(id)) this.openRequests.delete(k);
  }

  private snapshots(): AssertionSnapshot[] {
    return [...this.recs.values()].map((r) => {
      const support = this.observations.filter((o) => o.label === r.label && o.status === 'current');
      const max = (xs: Obs[]) => (xs.length ? new Date(Math.max(...xs.map((o) => o.asOf.getTime()))) : null);
      const base = {
        assertionId: r.id,
        value: r.value,
        support: {
          count: support.length,
          modes: [...new Set(support.map((o) => o.mode))],
          sourceIds: [...new Set(support.map((o) => o.source))].sort(),
          latestAsOf: max(support),
          latestDeclaredAsOf: max(support.filter((o) => o.declared)),
          latestSubjectAuthoredAsOf: max(support.filter((o) => o.subjectAuthored)),
          unverifiedSpans: support.filter((o) => o.unverified).length,
          withdrawnSupport: this.observations.filter((o) => o.label === r.label && o.status !== 'current')
            .length,
        },
      };
      const snap: AssertionSnapshot =
        r.state === 'CONFIRMED'
          ? { ...base, state: 'CONFIRMED', confirmedAt: r.confirmedAt ?? new Date(0) }
          : { ...base, state: r.state };
      if (r.stateChangedAt) snap.stateChangedAt = r.stateChangedAt;
      if (r.confirmedAt && r.state !== 'CONFIRMED') snap.wasConfirmed = true;
      if (r.reaffirmedAt && r.state === 'CONFIRMED') snap.reaffirmedAt = r.reaffirmedAt;
      if (r.rejectionReaffirmedAt && r.state === 'REJECTED')
        snap.rejectionReaffirmedAt = r.rejectionReaffirmedAt;
      if (r.supersession && r.state === 'SUPERSEDED') snap.supersession = r.supersession;
      return snap;
    });
  }

  private run(): ReconcileResult {
    return reconcileItem(
      {
        item: {
          itemId: this.itemId,
          claimType: this.claimType,
          active: this.active,
          canonical: this.canonical,
        },
        assertions: this.snapshots(),
        openRequests: this.requests(),
        organizationAliases: this.organizationAliases,
      },
      this.policy,
    );
  }

  reconcile(): StepOutcome {
    const problems: string[] = [];
    const result = this.run();
    const byId = new Map([...this.recs.values()].map((r) => [r.id, r]));
    for (const t of result.transitions) {
      const r = byId.get(t.assertionId);
      if (!r) {
        problems.push(`transition for unknown assertion ${t.assertionId}`);
        continue;
      }
      if (r.state !== t.from || !matchesGuard(r.state, t.guard)) {
        problems.push(`guard miss on ${r.label}: stored ${r.state}, transition from ${t.from}`);
        continue;
      }
      r.state = t.to;
      if (t.to === 'SUPERSEDED' && t.supersession) r.supersession = t.supersession;
      if (t.reason === 'revived') delete r.supersession;
    }
    for (const u of result.supersessionUpdates) {
      const r = byId.get(u.assertionId);
      if (!r || !matchesGuard(r.state, u.guard))
        problems.push(`supersession update guard miss on ${u.assertionId}`);
      else r.supersession = u.supersession;
    }
    if (result.changed) this.canonicalChanges++;
    this.canonical = result.canonical;
    for (const c of result.requests.close) this.openRequests.delete(c.dedupeKey);
    for (const o of result.requests.open) this.openRequests.set(o.dedupeKey, o);
    for (const k of result.requests.keep)
      if (!this.openRequests.has(k)) problems.push(`kept request ${k} is not open`);
    this.events.push(...result.events);

    // Fixed point: reconciling the applied result again changes nothing.
    const again = this.run();
    if (
      again.transitions.length ||
      again.supersessionUpdates.length ||
      again.changed ||
      again.derivedChanged ||
      again.requests.open.length ||
      again.requests.close.length
    )
      problems.push(
        `not a fixed point: ${again.transitions.length} transitions, changed=${again.changed}, ` +
          `open=${again.requests.open.length}, close=${again.requests.close.length}`,
      );
    return { result, problems };
  }
}
