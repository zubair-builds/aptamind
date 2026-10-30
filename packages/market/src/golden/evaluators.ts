import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type AuthorityTier, selectFact } from '@aptamind/provenance';
import { strictNameKey, looseNameKey } from '../companies/normalize';
import { apiBaseOfListingUrl, boardSourceIdentity, getAdapter } from '../connectors';
import type { AtsProvider } from '../contracts/common';
import { detectAtsFromUrl } from '../discovery/ats-detect';
import { shingles } from '../jobs/fingerprint';
import { parseAggregatorFeed } from '../connectors/aggregator';
import { htmlToTextWithLayout } from '../enrichment/html';
import { interpretJob } from '../enrichment/interpret';
import { inputFromStoredCopy } from '../enrichment/golden';
import { interpretSponsorship } from '../enrichment/sponsorship';
import type { SourceStanding } from '../jobs/authority';
import type { CopyBoard } from '../jobs/job.schema';
import { deriveLifecycle, type EvidenceItem, isAuthoritativeForExistence } from '../jobs/lifecycle';
import { assessListing, boardDerivedNotFoundGate } from '../jobs/listing-policy';
import {
  type CompanyLookup,
  type CompanySummary,
  resolveCompanyCandidate,
} from '../resolution/company-resolver';
import { type JobLookup, type JobSummary, resolveJobCandidate } from '../resolution/job-resolver';

export interface GoldenResult {
  suite: string;
  cases: Array<{ id: string; passed: boolean; failures: string[] }>;
  passed: number;
  failed: number;
}

const load = <T>(dir: string, file: string): T => JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as T;

function check(failures: string[], label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function finish(suite: string, cases: GoldenResult['cases']): GoldenResult {
  return {
    suite,
    cases,
    passed: cases.filter((c) => c.passed).length,
    failed: cases.filter((c) => !c.passed).length,
  };
}

interface CompanyGolden {
  existing: Array<{ id: string; name: string; domain?: string; registeredTowns?: string[]; keys?: string[] }>;
  cases: Array<{
    id: string;
    candidate: Parameters<typeof resolveCompanyCandidate>[0];
    expect: Record<string, string>;
  }>;
}

export async function evaluateCompanyResolutionGolden(dir: string): Promise<GoldenResult> {
  const g = load<CompanyGolden>(dir, 'companies.json');
  const companies = g.existing.map((e) => ({
    summary: {
      id: e.id,
      displayName: e.name,
      strictKeys: [strictNameKey(e.name)],
      looseKey: looseNameKey(e.name),
      domain: e.domain ?? null,
      hqCountry: null,
      registeredTowns: e.registeredTowns ?? [],
    } satisfies CompanySummary,
    keys: [`name:${strictNameKey(e.name)}`, ...(e.domain ? [`domain:${e.domain}`] : []), ...(e.keys ?? [])],
  }));
  const lookup: CompanyLookup = {
    byIdentityKey: async (k) => companies.find((c) => c.keys.includes(k))?.summary ?? null,
    byStrictName: async (k) =>
      companies.filter((c) => c.summary.strictKeys.includes(k)).map((c) => c.summary),
    byLooseKey: async (k) => companies.filter((c) => c.summary.looseKey === k).map((c) => c.summary),
    byFirstToken: async (t) =>
      companies.filter((c) => c.summary.looseKey.split(' ')[0] === t).map((c) => c.summary),
  };
  const cases = [];
  for (const c of g.cases) {
    const d = await resolveCompanyCandidate(c.candidate, lookup);
    const failures: string[] = [];
    for (const [k, v] of Object.entries(c.expect)) check(failures, k, (d as Record<string, unknown>)[k], v);
    cases.push({ id: c.id, passed: failures.length === 0, failures });
  }
  return finish('company-resolution', cases);
}

interface JobGolden {
  description_text: string;
  existing: Array<{
    id: string;
    sourceId: string;
    sourceKey: string;
    state: JobSummary['state'];
    titleKey: string;
    locationKey: string;
    urls?: string[];
    requisitionId?: string;
    present?: boolean;
  }>;
  cases: Array<{
    id: string;
    candidate: {
      sourceId: string;
      sourceKey: string;
      titleKey: string;
      locationKey: string;
      urls?: string[];
      requisitionId?: string;
      description?: string;
    };
    expect: Record<string, string>;
  }>;
}

export async function evaluateJobResolutionGolden(dir: string): Promise<GoldenResult> {
  const g = load<JobGolden>(dir, 'job-resolution.json');
  const sh = shingles(g.description_text);
  const jobs = g.existing.map((e) => ({
    summary: {
      id: e.id,
      companyId: 'cmp',
      state: e.state,
      requisitionId: e.requisitionId ?? null,
      titleKey: e.titleKey,
      locationKey: e.locationKey,
      shingles: sh,
      sourceIds: [e.sourceId],
      presentSourceIds: e.present === false ? [] : [e.sourceId],
      distinctFrom: [],
    } satisfies JobSummary,
    keys: [e.sourceKey],
    urls: e.urls ?? [],
  }));
  const lookup: JobLookup = {
    bySourceKey: async (k) => jobs.find((j) => j.keys.includes(k))?.summary ?? null,
    byUrlFingerprints: async (fps) =>
      jobs.filter((j) => j.urls.some((u) => fps.includes(u))).map((j) => j.summary),
    byRequisition: async (_c, r) => jobs.filter((j) => j.summary.requisitionId === r).map((j) => j.summary),
    byCompanyTitle: async (_c, t) => jobs.filter((j) => j.summary.titleKey === t).map((j) => j.summary),
  };
  const cases = [];
  for (const c of g.cases) {
    const d = await resolveJobCandidate(
      {
        sourceId: c.candidate.sourceId,
        sourceKey: c.candidate.sourceKey,
        companyId: 'cmp',
        requisitionId: c.candidate.requisitionId ?? null,
        titleKey: c.candidate.titleKey,
        locationKey: c.candidate.locationKey,
        urlFingerprints: c.candidate.urls ?? [],
        shingles: c.candidate.description ? shingles(c.candidate.description) : sh,
      },
      lookup,
    );
    const failures: string[] = [];
    for (const [k, v] of Object.entries(c.expect)) check(failures, k, (d as Record<string, unknown>)[k], v);
    cases.push({ id: c.id, passed: failures.length === 0, failures });
  }
  return finish('job-resolution', cases);
}

interface LifecycleGolden {
  cases: Array<{
    id: string;
    /** `externalId` + `provider`: the tracked job's record on an ATS board (for `listing` events). */
    start: {
      authority: AuthorityTier;
      provider?: AtsProvider;
      externalId?: string;
      /**
       * The tracked job has no copy on the board until a listing contains it (it is not present
       * at the start and listings before it cannot mark it absent).
       */
      unlistedAtStart?: boolean;
    };
    events: Array<{
      kind:
        | 'seen'
        | 'absent_from_listing'
        | 'source_fetch_failed'
        | 'verification'
        | 'stale_check'
        | 'repost_detected'
        | 'listing'
        | 'board_verification'
        | 'confirm_shrink';
      authority?: AuthorityTier;
      contentChanged?: boolean;
      outcome?: 'live' | 'not_found' | 'inconclusive';
      absentFromListing?: boolean;
      hoursLater?: number;
      /**
       * `listing`: the raw provider response (`{ jobs: [...] }`, or an array for Lever).
       * `board_verification`: the board a board-derived check (Ashby) read to verify the job.
       */
      raw?: unknown;
      /** `listing`: append this many valid filler entries to the raw response. */
      fillers?: number;
      /**
       * `listing`: the listing is not a complete snapshot (e.g. a provider-reported truncation):
       * held, but its entries are still ingested and marked present.
       */
      incomplete?: boolean;
    }>;
    expect: {
      state: string;
      consecutiveAbsences?: number;
      consecutiveNotFound?: number;
      historyTo?: string[];
    };
  }>;
}

/** `n` minimal valid entries in the provider's listing shape (ids never collide with a case's own). */
function fillerEntries(provider: AtsProvider, n: number): unknown[] {
  return Array.from({ length: n }, (_, i) =>
    provider === 'greenhouse'
      ? { id: 900_000 + i, title: `Filler ${i}` }
      : provider === 'lever'
        ? { id: `filler-${i}`, text: `Filler ${i}` }
        : { id: `filler-${i}`, title: `Filler ${i}` },
  );
}

function withFillers(provider: AtsProvider, raw: unknown, n: number): unknown {
  if (!n) return raw;
  if (Array.isArray(raw)) return [...raw, ...fillerEntries(provider, n)];
  const obj = raw as { jobs: unknown[]; meta?: { total?: number } };
  const jobs = [...obj.jobs, ...fillerEntries(provider, n)];
  return { ...obj, jobs, ...(obj.meta ? { meta: { ...obj.meta, total: jobs.length } } : {}) };
}

/**
 * Lifecycle goldens. Besides pure lifecycle events, a case can replay raw provider listings end
 * to end: adapter parse → listing absence policy (`assessListing`, what `finalize_job_listing`
 * applies) → the tracked job's lifecycle event (seen / absent / nothing).
 */
export function evaluateLifecycleGolden(dir: string): GoldenResult {
  const g = load<LifecycleGolden>(dir, 'lifecycle.json');
  const t0 = Date.UTC(2026, 0, 1);
  const TIERS: AuthorityTier[] = ['official_ats', 'official_site', 'operator', 'third_party'];
  // One complete, enabled source per authority tier; the tracked job has one copy on each. The
  // lifecycle is DERIVED from the evidence the events record (DECISION_LOG 6a01b36).
  const sources = new Map<string, SourceStanding>(
    TIERS.map((tier) => [
      `src-${tier}`,
      {
        enabled: true,
        category: 'job_source',
        provider: 'greenhouse',
        authority: { tier, listingIsComplete: true },
      },
    ]),
  );
  const board: CopyBoard = { endpointUrl: 'https://golden.test/board', boardToken: 'golden', apiBase: null };
  const copyOf = (tier: AuthorityTier) => `src-${tier}:tracked`;
  const cases = g.cases.map((c) => {
    const startSource = `src-${c.start.authority}`;
    const copies = [
      ...TIERS.map((tier) => ({ key: copyOf(tier), sourceId: `src-${tier}`, board })),
      { key: `${startSource}:repost`, sourceId: startSource, board },
    ];
    const evidence: EvidenceItem[] = [];
    const add = (e: Omit<EvidenceItem, '_id' | 'board'>) =>
      evidence.push({ _id: `e${String(evidence.length).padStart(4, '0')}`, board, ...e });
    const onStart = (at: Date, e: Pick<EvidenceItem, 'kind' | 'outcome'> & Partial<EvidenceItem>) =>
      add({ copyKey: copyOf(c.start.authority), sourceId: startSource, at, ...e });
    let now = new Date(t0);
    const derive = (at: Date) =>
      deriveLifecycle(evidence, sources, at, {
        copies,
        firstSeenAt: new Date(t0),
        lastSeenAt: new Date(t0),
      }).lifecycle;
    const authoritative = isAuthoritativeForExistence(c.start.authority);
    // Content hashes of the tracked posting: a `contentChanged` sighting carries a new one.
    let hashN = 0;
    const hash = () => `h${hashN}`;
    if (!c.start.unlistedAtStart) onStart(now, { kind: 'listing', outcome: 'present', contentHash: hash() });
    else if (authoritative)
      add({ copyKey: null, sourceId: null, at: now, kind: 'baseline', outcome: 'live' });
    let lastListingAppliedAt: Date | null = null;
    let baselineCount: number | null = null;
    let smallBoardHold: { at: Date } | null = null;
    let held = false;
    /** `confirm_shrink`: an operator confirmed the held shrink's size (for the current baseline). */
    let confirmedCount: number | null = null;
    let heldCount: number | null = null;
    // Presence as the pipeline records it: every ingested entry is present; an applied listing
    // marks the others absent. The effective baseline is max(baseline, present) (MEDIUM-1).
    const target = c.start.externalId;
    const present = new Set<string>(target && !c.start.unlistedAtStart ? [target] : []);
    let targetKnown = !!target && !c.start.unlistedAtStart;
    /** Latest positive evidence on the board: any entry ingested, or a live board read (b7f1a76). */
    let sourcePositiveAt: Date | null = null;
    const failures: string[] = [];
    c.events.forEach((e, i) => {
      const at = new Date(t0 + (e.hoursLater ?? i + 1) * 3600_000);
      now = at;
      if (e.kind === 'listing') {
        const provider = c.start.provider ?? 'greenhouse';
        const listing = getAdapter(provider).parseListing(withFillers(provider, e.raw, e.fillers ?? 0), {
          boardToken: 'golden',
        });
        const ids = listing.jobs.map((j) => j.payload.externalId);
        // Ingest runs before finalize: this listing's entries are present when it is assessed.
        const entries = [...ids, ...listing.skipped.flatMap((s) => (s.externalId ? [s.externalId] : []))];
        for (const id of entries) present.add(id);
        if (entries.length) sourcePositiveAt = at;
        if (target && present.has(target)) targetKnown = true;
        // Positive evidence after a small-board hold re-arms it (b7f1a76).
        if (smallBoardHold && sourcePositiveAt && sourcePositiveAt > smallBoardHold.at) smallBoardHold = null;
        const decision = assessListing({
          itemExternalIds: ids,
          skipped: listing.skipped,
          complete: listing.complete && !e.incomplete,
          fetchedAt: at,
          lastListingAppliedAt,
          fanout: { total: ids.length, failed: 0 },
          maxFailureRatio: 0.1,
          baselineCount: Math.max(baselineCount ?? 0, present.size),
          smallBoardHold,
          confirmedCount,
        });
        if (target && ids.includes(target))
          onStart(at, { kind: 'listing', outcome: 'present', contentHash: hash() });
        else if (target && targetKnown && decision.seen.has(target))
          // A skipped entry is on the board: a positive, but no verification (U1).
          onStart(at, { kind: 'listing', outcome: 'present', skipped: true });
        else if (target && targetKnown && decision.apply && !decision.seen.has(target))
          onStart(at, { kind: 'listing', outcome: 'absent' });
        if (decision.apply) {
          lastListingAppliedAt = at;
          baselineCount = decision.baselineAfter;
          for (const id of [...present]) if (!decision.seen.has(id)) present.delete(id);
          smallBoardHold = null;
          held = false;
          confirmedCount = null; // a confirmation belongs to the baseline it was given for
        } else if (decision.code === 'small_board_empty') {
          smallBoardHold = { at };
          held = true;
        } else if (decision.code === 'shrink') {
          held = true;
          heldCount = decision.shrink?.count ?? null;
        }
        return;
      }
      if (e.kind === 'confirm_shrink') {
        confirmedCount = heldCount;
        return;
      }
      if (e.kind === 'board_verification') {
        // A board-derived check (Ashby) as `verify_job` records it: the adapter's job check on
        // the board it read, then the trustworthy-board gate (ruling L1).
        const provider = c.start.provider ?? 'ashby';
        const check = getAdapter(provider).parseJobCheck(200, withFillers(provider, e.raw, e.fillers ?? 0), {
          boardToken: 'golden',
          externalId: c.start.externalId ?? '',
        });
        let outcome: 'live' | 'not_found' | 'inconclusive' =
          check.outcome === 'unknown' ? 'inconclusive' : check.outcome;
        const lc = derive(at);
        if (
          outcome === 'not_found' &&
          check.boardEntries !== undefined &&
          !boardDerivedNotFoundGate({
            boardEntries: check.boardEntries,
            baselineCount: Math.max(baselineCount ?? 0, present.size),
            listingHeld: held,
            run: {
              consecutiveAbsences: lc.consecutiveAbsences,
              absentSince: lc.absentSince,
              lastAuthoritativeSeenAt: authoritative ? latestPositive(evidence) : (lc.lastVerifiedAt ?? null),
              lastVerifiedAt: lc.lastVerifiedAt,
            },
            sourcePositiveAt,
          }).counts
        )
          outcome = 'inconclusive';
        if (outcome === 'live') sourcePositiveAt = at;
        onStart(at, {
          kind: 'verification',
          outcome,
          ...(check.boardEntries !== undefined ? { boardDerived: true } : {}),
        });
        return;
      }
      if (e.kind === 'seen') {
        const tier = e.authority ?? 'official_ats';
        add({
          copyKey: copyOf(tier),
          sourceId: `src-${tier}`,
          at,
          kind: 'listing',
          outcome: 'present',
          contentHash: e.contentChanged ? `h${++hashN}` : hash(),
        });
      } else if (e.kind === 'absent_from_listing') {
        const tier = e.authority ?? 'official_ats';
        add({ copyKey: copyOf(tier), sourceId: `src-${tier}`, at, kind: 'listing', outcome: 'absent' });
      } else if (e.kind === 'verification') {
        // `absentFromListing` is no longer an input: job-level absence is derived from the evidence.
        onStart(at, { kind: 'verification', outcome: e.outcome ?? 'inconclusive' });
      } else if (e.kind === 'repost_detected') {
        add({
          copyKey: `${startSource}:repost`,
          sourceId: startSource,
          at,
          kind: 'listing',
          outcome: 'present',
          contentHash: 'repost',
        });
      }
      // stale_check: derivation at `now`; source_fetch_failed: no evidence at all.
    });
    const lc = derive(now);
    check(failures, 'state', lc.state, c.expect.state);
    if (c.expect.consecutiveAbsences !== undefined)
      check(failures, 'consecutiveAbsences', lc.consecutiveAbsences, c.expect.consecutiveAbsences);
    if (c.expect.consecutiveNotFound !== undefined)
      check(failures, 'consecutiveNotFound', lc.consecutiveNotFound, c.expect.consecutiveNotFound);
    if (c.expect.historyTo)
      check(failures, 'history', lc.history.map((h) => h.to).join('>'), c.expect.historyTo.join('>'));
    return { id: c.id, passed: failures.length === 0, failures };
  });
  return finish('job-lifecycle', cases);
}

/** The latest positive listing evidence's time (the copy's authoritative sightings). */
function latestPositive(evidence: ReadonlyArray<EvidenceItem>): Date | null {
  let latest: Date | null = null;
  for (const e of evidence)
    if ((e.outcome === 'present' || e.outcome === 'live') && (!latest || e.at > latest)) latest = e.at;
  return latest;
}

interface ReconciliationGolden {
  cases: Array<{
    id: string;
    policy?: { sameAuthorityDisagreement?: 'recency' | 'conflict' };
    candidates: Array<{ value: string; authority: AuthorityTier; at: string }>;
    expect: { value: string | null; status: string; conflicts: number };
  }>;
}

export function evaluateReconciliationGolden(dir: string): GoldenResult {
  const g = load<ReconciliationGolden>(dir, 'reconciliation.json');
  const cases = g.cases.map((c) => {
    const f = selectFact(
      c.candidates.map((x) => ({
        value: x.value,
        authority: x.authority,
        confidence: 'high' as const,
        observedAt: new Date(x.at),
        evidence: { sourceId: x.authority, observedAt: new Date(x.at) },
      })),
      { policyVersion: 'golden', ...c.policy },
    );
    const failures: string[] = [];
    check(failures, 'value', f.value, c.expect.value);
    check(failures, 'status', f.status, c.expect.status);
    check(failures, 'conflicts', f.conflicts.length, c.expect.conflicts);
    return { id: c.id, passed: failures.length === 0, failures };
  });
  return finish('reconciliation', cases);
}

interface AtsRegionsGolden {
  cases: Array<{
    id: string;
    url: string;
    expect: { provider: string; boardToken: string; sourceKey: string; listingUrl: string; jobUrl: string };
  }>;
}

/**
 * ATS board regions end to end (M6.3): detection → job-source identity (what
 * `register_job_source` stores) → the verification URL `VerificationService` derives from the
 * stored endpoint. Every hop must stay on the board's own regional host.
 */
export function evaluateAtsRegionsGolden(dir: string): GoldenResult {
  const g = load<AtsRegionsGolden>(dir, 'ats-regions.json');
  const cases = g.cases.map((c) => {
    const failures: string[] = [];
    const detection = detectAtsFromUrl(c.url);
    if (!detection) {
      failures.push('not detected');
      return { id: c.id, passed: false, failures };
    }
    const adapter = getAdapter(detection.provider);
    const identity = boardSourceIdentity(adapter, detection.boardToken, detection.apiBase);
    const verifyBase = apiBaseOfListingUrl(identity.listingUrl, detection.boardToken, adapter);
    check(failures, 'provider', detection.provider, c.expect.provider);
    check(failures, 'boardToken', detection.boardToken, c.expect.boardToken);
    check(failures, 'sourceKey', identity.key, c.expect.sourceKey);
    check(failures, 'listingUrl', identity.listingUrl, c.expect.listingUrl);
    check(
      failures,
      'jobUrl',
      verifyBase ? adapter.jobUrl(detection.boardToken, '123', verifyBase) : null,
      c.expect.jobUrl,
    );
    return { id: c.id, passed: failures.length === 0, failures };
  });
  return finish('ats-regions', cases);
}

interface SponsorshipCorpus {
  sentences: Array<{
    /** The job description: one sentence, line or post (HTML is converted like a job description). */
    text: string;
    /** Optional job title and location texts (scanned for mentions). */
    title?: string;
    locations?: string[];
    /** What the post says: an offer, a refusal, or neither / not decidable. */
    statement: 'yes' | 'no' | 'none';
    /**
     * `structured`: the post has a structured line (key, separator and value on one line) whose
     * stated value is `statement`; `free`: no such line (unless `stated` lists one).
     */
    form: 'structured' | 'free';
    /**
     * The exact stated values the post's structured lines carry, when they differ from the
     * `form`/`statement` default (`[statement]` for a structured yes/no case, else none): e.g. a
     * `none` post whose structured "yes" is withheld by other content, or two lines that disagree.
     */
    stated?: Array<'yes' | 'no'>;
    /**
     * Realistic editor output (bc013e8): the editor that produced it. Its recall is reported
     * separately — over cases whose `statement` a reader sees, including documented recall
     * residuals (mentions by rule, `form: 'free'`).
     */
    editor?: string;
    /** The job's countries (ISO-2); default `['GB']` (a London job). `[]`: unknown. */
    jobCountries?: string[];
    /** Flags that must be present / absent (e.g. `sponsorship_conflict`, `sponsorship_mentioned`). */
    flags?: string[];
    noFlags?: string[];
    /** Flags a reviewer expected that only feed a coverage metric (advisory, not a gate). */
    advisoryFlags?: string[];
    group: string;
  }>;
}

export interface CorpusMetrics {
  /** Labelled stated values that were extracted (recall; a missed one also fails its case). */
  stated: { labelled: number; extracted: number; recall: number };
  /**
   * Posting-text verdicts (must be 0), stated values that are not labelled or contradict the
   * post's statement whatever the case's form (must be 0), and cases with a stated value.
   */
  verdicts: number;
  wrongStated: number;
  gatedStatedCases: number;
  /** The same gate on the production input path (connector text + HTML → interpretJob). */
  production: { verdicts: number; wrongStated: number };
  /** Recall on the realistic-editor subset (production path; residuals count as misses). */
  editors: { labelled: number; extracted: number; recall: number };
  /** Cases asserting `sponsorship_conflict`, and advisory-flag coverage. */
  conflictCases: number;
  advisory: { expected: number; present: number };
}

/**
 * Permanent sponsorship gating corpus (DECISION_LOG 012d041, v0.1 final). Each text is read as a
 * job posting (a London job unless `jobCountries` says otherwise), without company data. Posting
 * text never yields a verdict: ANY `explicit_yes` / `explicit_no` fails the case. A structured
 * line's stated value is extracted as `sponsorship_stated`; the extracted values must be exactly
 * the labelled ones (`stated`, default `[statement]` for a structured yes/no case, else none) —
 * an unlabelled value, a missed one, or one whose polarity contradicts the post's `statement`
 * fails the case whatever its `form` (DECISION_LOG 8d96663). Required flags must be present,
 * forbidden ones absent.
 */
/** A listed location for the corpus's job countries (the production path derives them from it). */
const COUNTRY_LOCATION: Record<string, string> = {
  GB: 'London, United Kingdom',
  US: 'New York, NY, United States',
  IE: 'Dublin, Ireland',
  NL: 'Amsterdam, Netherlands',
  CA: 'Toronto, ON, Canada',
  DE: 'Berlin, Germany',
  FR: 'Paris, France',
  ES: 'Madrid, Spain',
  AU: 'Sydney NSW, Australia',
  SG: 'Singapore',
  NZ: 'Auckland, New Zealand',
  DK: 'Copenhagen, Denmark',
};
function locationsFor(countries: string[]): string[] {
  if (!countries.length) return ['Remote'];
  return countries.map((c) => {
    const loc = COUNTRY_LOCATION[c];
    if (!loc) throw new Error(`corpus: no location for job country ${c}`);
    return loc;
  });
}

export function evaluateSponsorshipCorpus(dir: string): GoldenResult & { metrics: CorpusMetrics } {
  const g = load<SponsorshipCorpus>(dir, 'sponsorship-corpus.json');
  const metrics: CorpusMetrics = {
    stated: { labelled: 0, extracted: 0, recall: 1 },
    verdicts: 0,
    wrongStated: 0,
    gatedStatedCases: 0,
    production: { verdicts: 0, wrongStated: 0 },
    editors: { labelled: 0, extracted: 0, recall: 1 },
    conflictCases: 0,
    advisory: { expected: 0, present: 0 },
  };
  const cases = g.sentences.map((c, i) => {
    const isHtml = /<[a-z][^>]*>/i.test(c.text);
    const { text: description, layoutLineStarts } = isHtml
      ? htmlToTextWithLayout(c.text)
      : { text: c.text, layoutLineStarts: [] };
    const r = interpretSponsorship({
      description,
      layoutLineStarts,
      title: c.title,
      locationTexts: c.locations,
      company: null,
      jobCountries: c.jobCountries ?? ['GB'],
    });
    const codes = new Set(r.flags.map((f) => f.code));
    const statedOf = (flags: typeof r.flags) =>
      flags.flatMap((f) => (f.code === 'sponsorship_stated' && f.value ? [f.value] : []));
    const stated = statedOf(r.flags);
    const failures: string[] = [];
    const expected = new Set(
      c.stated ?? (c.form === 'structured' && c.statement !== 'none' ? [c.statement] : []),
    );
    const conflictLabelled = (c.flags ?? []).includes('sponsorship_conflict');
    /** Verdicts, missed, unlabelled and contradicting stated values of one path. */
    const gate = (path: string, status: string, got: Array<'yes' | 'no'>, count: boolean) => {
      const where = path ? `${path}: ` : '';
      if (status === 'explicit_yes' || status === 'explicit_no') {
        if (count) metrics.verdicts += 1;
        else metrics.production.verdicts += 1;
        failures.push(`${where}posting text gave a verdict (${status})`);
      }
      for (const v of expected) {
        if (got.includes(v)) {
          if (count) metrics.stated.extracted += 1;
        } else failures.push(`${where}missed stated value ${v}`);
      }
      for (const v of new Set(got)) {
        const contradicts = c.statement !== 'none' && v !== c.statement && !conflictLabelled;
        if (!expected.has(v) || contradicts) {
          if (count) metrics.wrongStated += 1;
          else metrics.production.wrongStated += 1;
          failures.push(
            contradicts
              ? `${where}stated value ${v} contradicts the post's statement (${c.statement})`
              : `${where}unlabelled stated value ${v}`,
          );
        }
      }
    };
    if (expected.size || stated.length) metrics.gatedStatedCases += 1;
    metrics.stated.labelled += expected.size;
    gate('', r.sponsorship.value.status, stated, true);
    // The production input path (a720377 (1), 5a13fed): the REAL aggregator connector — it
    // stores whatever description it gets (tagless text included) as descriptionHtml plus its
    // own rendering as descriptionText — then interpretationInput → interpretJob, as
    // reconciliation runs it.
    const listing = parseAggregatorFeed({
      jobs: [
        {
          id: `corpus-${i + 1}`,
          title: c.title ?? 'Software Engineer',
          location: c.locations ?? locationsFor(c.jobCountries ?? ['GB']),
          description: c.text,
        },
      ],
    });
    const connectorPayload = listing.jobs[0]?.payload;
    if (!connectorPayload) throw new Error(`corpus case ${i + 1}: the aggregator connector skipped it`);
    const input = inputFromStoredCopy({ payload: connectorPayload, company: null });
    const production = interpretJob(input);
    gate('production path', production.sponsorship.value.status, statedOf(production.flags), false);
    if (c.editor && c.statement !== 'none') {
      metrics.editors.labelled += 1;
      if (statedOf(production.flags).includes(c.statement)) metrics.editors.extracted += 1;
    }
    if ((c.flags ?? []).includes('sponsorship_conflict')) metrics.conflictCases += 1;
    for (const f of c.flags ?? []) if (!codes.has(f)) failures.push(`missing flag ${f}`);
    for (const f of c.noFlags ?? []) if (codes.has(f)) failures.push(`unexpected flag ${f}`);
    for (const f of c.advisoryFlags ?? []) {
      metrics.advisory.expected += 1;
      if (codes.has(f)) metrics.advisory.present += 1;
    }
    return {
      id: `${String(i + 1).padStart(3, '0')} ${c.text.replace(/\s+/g, ' ').slice(0, 70)}`,
      passed: failures.length === 0,
      failures,
    };
  });
  metrics.stated.recall = metrics.stated.labelled ? metrics.stated.extracted / metrics.stated.labelled : 1;
  metrics.editors.recall = metrics.editors.labelled
    ? metrics.editors.extracted / metrics.editors.labelled
    : 1;
  return { ...finish('sponsorship-corpus', cases), metrics };
}
