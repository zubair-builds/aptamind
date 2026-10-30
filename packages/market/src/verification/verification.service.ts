import { deterministicId } from '@aptamind/contracts';
import { getCollection } from '@aptamind/db';
import { HttpError, type SafeHttpClient } from '@aptamind/net';
import { ATS_PROVIDERS, type AtsProvider } from '../contracts/common';
import { apiBaseOfListingUrl, getAdapter } from '../connectors';
import type { MarketContext } from '../context';
import type { JobEvidenceService, NewJobEvidence } from '../jobs/evidence.service';
import { authoritativeEvidenceAt, isAuthoritativeCopy } from '../jobs/lifecycle';
import { boardDerivedNotFoundGate } from '../jobs/listing-policy';
import type { CopyBoard, JobDoc, SourceRef } from '../jobs/job.schema';
import type { JobService } from '../jobs/job.service';
import { type SourceDoc, sourcesCollection } from '../sources/source.schema';
import {
  boardOfSource,
  endpointChangedSince,
  hasUnrecognisedProvider,
  isAuthoritativeSource,
  sameBoard,
} from '../sources/source-standing';
import { DEFAULT_AUTHORITY_RANK } from '@aptamind/provenance';
import { type JobVerificationDoc, jobVerificationsCollection, VERIFICATION_SCHEMA_VERSION } from './schemas';

/**
 * The verification rules in force. Recorded on every operation (`logicVersion`); an operation
 * recorded under another version is applied as `inconclusive` (PR #11 re-verify #7 LOW-2).
 */
export const VERIFICATION_LOGIC_VERSION = 'job-verify/8';

function isAts(p: string): p is AtsProvider {
  return (ATS_PROVIDERS as readonly string[]).includes(p);
}

/**
 * Pick the reference to verify against: a PRESENT authoritative copy first (DECISION_LOG
 * a9af734: an absent higher-ranked copy never outranks a present authoritative one), then by
 * authority, then most recent.
 */
export function verificationRef(job: JobDoc): SourceRef | null {
  const presentAuthoritative = (r: SourceRef) => (r.present && isAuthoritativeCopy(r) ? 1 : 0);
  const authoritative = (r: SourceRef) => (isAuthoritativeCopy(r) ? 1 : 0);
  const refs = [...job.sourceRefs].sort(
    (a, b) =>
      presentAuthoritative(b) - presentAuthoritative(a) ||
      authoritative(b) - authoritative(a) ||
      (DEFAULT_AUTHORITY_RANK[b.authority] ?? 0) - (DEFAULT_AUTHORITY_RANK[a.authority] ?? 0) ||
      b.lastSeenAt.getTime() - a.lastSeenAt.getTime(),
  );
  return refs[0] ?? null;
}

/** A check result, persisted on the operation before it is applied. */
export type CheckResult = Pick<
  JobVerificationDoc,
  | 'method'
  | 'url'
  | 'httpStatus'
  | 'outcome'
  | 'detail'
  | 'sourceId'
  | 'artifactId'
  | 'boardDerived'
  | 'copyKey'
  | 'board'
>;

/** The source fields verification reads. */
type VerifySource = Pick<
  SourceDoc,
  '_id' | 'enabled' | 'category' | 'provider' | 'authority' | 'endpoint' | 'endpointChangedAt' | 'health'
>;

/**
 * The latest listing fetch of the source failed (MEDIUM-2, LOW-D): its latest REAL acquisition
 * (`health.latestFetch`: a fetch or an upload; reprocessing never moves it) failed. Sources without
 * it (fetched before it existed) fall back to the latest failure not being older than the latest
 * success. A failed or misconfigured fetch never changes job state (ADR-0010), so no copy of the
 * source is verified until a listing succeeds again.
 */
export function latestListingFailed(s: Pick<SourceDoc, 'health'>): boolean {
  if (s.health.latestFetch) return !s.health.latestFetch.ok;
  const failed = s.health.lastFailureAt;
  const ok = s.health.lastSuccessAt;
  return !!failed && (!ok || failed.getTime() >= ok.getTime());
}

/**
 * Job verification (WF6): re-check the authoritative source for one job, record the
 * evidence, and feed the outcome into the lifecycle policy. Network/5xx problems are
 * `inconclusive` — never evidence of closure.
 */
export class VerificationService {
  constructor(
    private readonly ctx: MarketContext,
    private readonly jobs: JobService,
    private readonly evidence: JobEvidenceService,
  ) {}

  get col() {
    return getCollection(this.ctx.db, jobVerificationsCollection);
  }

  /**
   * Check one job on its authoritative copy's own board. The result names the copy it read
   * (`copyKey`) and the board it read it on (`board`): applied, it becomes that copy's
   * verification evidence (DECISION_LOG 6a01b36).
   */
  async check(job: JobDoc, http: SafeHttpClient, signal?: AbortSignal): Promise<CheckResult> {
    const chosen: { ref?: SourceRef; board?: CopyBoard } = {};
    const result = await this.checkCopy(job, http, signal, chosen);
    return { ...result, ...(chosen.ref ? { copyKey: chosen.ref.key } : {}), board: chosen.board ?? null };
  }

  private async checkCopy(
    job: JobDoc,
    http: SafeHttpClient,
    signal: AbortSignal | undefined,
    chosen: { ref?: SourceRef; board?: CopyBoard },
  ): Promise<Omit<CheckResult, 'copyKey' | 'board'>> {
    // Only AUTHORITATIVE copies on enabled sources are verified (0bcc357, PR #11 re-verify #6
    // H-1). A third-party copy is evidence to show, never a verification that could close the
    // job; a copy whose source is disabled or missing is never verified on a guessed target. A
    // job with authoritative copies but none on an enabled source is inconclusive — no
    // third-party copy and no canonical-URL fallback stand in for it.
    const authoritative = job.sourceRefs.filter((r) => isAuthoritativeCopy(r));
    if (!authoritative.length)
      return {
        method: 'posting_url',
        outcome: 'inconclusive',
        detail: job.sourceRefs.length
          ? 'the job has no authoritative copy; third-party copies are not verified'
          : 'job has no source reference',
      };
    const sourceDocs = await getCollection(this.ctx.db, sourcesCollection)
      .find(
        { _id: { $in: [...new Set(authoritative.map((r) => r.sourceId))] } },
        {
          projection: {
            _id: 1,
            enabled: 1,
            category: 1,
            provider: 1,
            authority: 1,
            endpoint: 1,
            endpointChangedAt: 1,
            health: 1,
          },
        },
      )
      .toArray();
    const sources = new Map<string, VerifySource>(sourceDocs.map((d) => [d._id, d]));
    // A job source whose stored provider is outside the closed set is read tolerantly and never
    // authoritative (LOW-1); say so, since it is why its copies are not verified.
    const unrecognised = sourceDocs.filter((d) => hasUnrecognisedProvider(d));
    const note = unrecognised.length
      ? ` (source ${unrecognised.map((d) => `${d._id} has provider "${d.provider}", outside the job-source provider set`).join('; ')})`
      : '';
    const ref = verificationRef({
      ...job,
      sourceRefs: authoritative.filter((r) => {
        const src = sources.get(r.sourceId);
        return !!src && isAuthoritativeSource(src);
      }),
    });
    if (!ref)
      return {
        method: 'posting_url',
        outcome: 'inconclusive',
        detail: `no authoritative copy of this job is on an enabled source with an authoritative tier (a disabled or missing source is never verified)${note}`,
      };
    const source = sources.get(ref.sourceId) as VerifySource;
    chosen.ref = ref;
    // MEDIUM-2: a copy is verified only on the board where it was seen, and only while its source
    // still reads that board and its latest listing fetch succeeded.
    if (latestListingFailed(source))
      return {
        method: isAts(ref.provider) ? 'ats_api' : 'posting_url',
        outcome: 'inconclusive',
        detail: `the latest listing fetch of source ${source._id} failed; its copies are not verified until a listing succeeds`,
        sourceId: ref.sourceId,
      };
    const board = await this.boardOfCopy(ref, source);
    if ('board' in board) chosen.board = board.board;
    if ('inconclusive' in board)
      return {
        method: isAts(ref.provider) ? 'ats_api' : 'posting_url',
        outcome: 'inconclusive',
        detail: board.inconclusive,
        sourceId: ref.sourceId,
      };
    // The copy's OWN board, not the job's primary copy: a present third-party copy can be primary
    // while the ATS copy is the one to verify (a9af734).
    const fallbackToken =
      job.application.ats?.provider === ref.provider ? (job.application.ats.boardToken ?? null) : null;
    const target = isAts(ref.provider) ? this.atsTarget(ref, board.board, source, fallbackToken) : null;
    if (isAts(ref.provider) && target?.boardToken) {
      const adapter = getAdapter(ref.provider);
      if (!target.apiBase) {
        // Never guess a host: a board asked on the wrong regional host answers 404, which would
        // count as "not found" and could close a live job (M6.3).
        return {
          method: 'ats_api',
          outcome: 'inconclusive',
          detail: target.endpoint
            ? `source endpoint ${target.endpoint} does not identify the ${ref.provider} API base for board ${target.boardToken}`
            : `source ${ref.sourceId} of this copy is missing`,
          sourceId: ref.sourceId,
        };
      }
      const url = adapter.jobUrl(target.boardToken, ref.externalId, target.apiBase);
      try {
        const res = await http.request({
          url,
          timeoutMs: 20_000,
          signal,
          headers: { accept: 'application/json' },
        });
        let raw: unknown = null;
        const text = new TextDecoder().decode(res.body);
        try {
          raw = text ? JSON.parse(text) : null;
        } catch {
          raw = null;
        }
        const check = adapter.parseJobCheck(res.status, raw, {
          boardToken: target.boardToken,
          externalId: ref.externalId,
        });
        // A board-derived not_found is the same evidence as a listing read: it only corroborates
        // a job-level absence run (DECISION_LOG b7f1a76).
        let gated: string | null = null;
        if (check.outcome === 'not_found' && check.boardEntries !== undefined) {
          const gate = boardDerivedNotFoundGate({
            boardEntries: check.boardEntries,
            baselineCount: Math.max(
              target.listingBaseline?.count ?? 0,
              await this.jobs.countPresentOnSource(ref.sourceId),
            ),
            listingHeld: target.listingHeld,
            run: {
              consecutiveAbsences: job.lifecycle.consecutiveAbsences,
              absentSince: job.lifecycle.absentSince,
              lastAuthoritativeSeenAt: authoritativeEvidenceAt(job),
              lastVerifiedAt: job.lifecycle.lastVerifiedAt,
            },
            sourcePositiveAt:
              check.boardEntries === 0 ? await this.jobs.lastPositiveEvidenceOnSource(ref.sourceId) : null,
          });
          if (!gate.counts) gated = gate.reason;
        }
        const artifact = res.body.byteLength
          ? await this.ctx.artifacts.put(res.body, res.contentType.split(';')[0] ?? 'application/json', {
              labels: { kind: 'verification', jobId: job._id },
            })
          : undefined;
        return {
          method: 'ats_api',
          url,
          httpStatus: res.status,
          outcome: check.outcome === 'unknown' || gated ? 'inconclusive' : check.outcome,
          detail: gated
            ? `${ref.provider} API responded ${res.status}; not found on the board, but ${gated} (inconclusive)`
            : `${ref.provider} API responded ${res.status}`,
          sourceId: ref.sourceId,
          artifactId: artifact?.artifactId,
          // The run this read corroborates, re-checked when the result is applied (a9af734).
          ...(check.boardEntries !== undefined ? { boardDerived: true } : {}),
        };
      } catch (err) {
        return {
          method: 'ats_api',
          url,
          outcome: 'inconclusive',
          detail: `request failed: ${(err as Error).message}`,
          sourceId: ref.sourceId,
        };
      }
    }
    // The copy's OWN posting URL only: the canonical URL may belong to another copy.
    const url = ref.postingUrl;
    if (!url)
      return {
        method: 'posting_url',
        outcome: 'inconclusive',
        detail: 'no posting URL to verify',
        sourceId: ref.sourceId,
      };
    try {
      const res = await http.request({ url, timeoutMs: 20_000, signal, maxBytes: 5 * 1024 * 1024 });
      if (res.status === 404 || res.status === 410) {
        return {
          method: 'posting_url',
          url,
          httpStatus: res.status,
          outcome: 'not_found',
          detail: `posting returned ${res.status}`,
          sourceId: ref.sourceId,
        };
      }
      if (!res.ok) {
        return {
          method: 'posting_url',
          url,
          httpStatus: res.status,
          outcome: 'inconclusive',
          detail: `posting returned ${res.status}`,
          sourceId: ref.sourceId,
        };
      }
      const html = new TextDecoder().decode(res.body).toLowerCase();
      const title = (job.identity.title.value ?? '').toLowerCase();
      const live = title.length > 3 && html.includes(title);
      const artifact = await this.ctx.artifacts.put(res.body, 'text/html', {
        labels: { kind: 'verification', jobId: job._id },
      });
      return {
        method: 'posting_url',
        url: res.url,
        httpStatus: res.status,
        outcome: live ? 'live' : 'inconclusive',
        detail: live
          ? 'posting page contains the job title'
          : 'page loaded but the job title was not found (possible redirect to careers index)',
        sourceId: ref.sourceId,
        artifactId: artifact.artifactId,
      };
    } catch (err) {
      const detail = err instanceof HttpError ? err.message : (err as Error).message;
      return {
        method: 'posting_url',
        url,
        outcome: 'inconclusive',
        detail: `request failed: ${detail}`,
        sourceId: ref.sourceId,
      };
    }
  }

  /**
   * The board to verify a copy on (MEDIUM-2), or why verification is inconclusive:
   *
   *  - a recorded board (`ref.board`) is used only while the source's endpoint still is that board
   *    (`sameBoard`); otherwise the endpoint changed after the copy was last seen;
   *  - `ref.board === null`: the listing that last showed the copy was fetched before an endpoint
   *    change, so its board is unknown;
   *  - no recorded board (a copy last seen before boards were recorded): the source's current board,
   *    but only if the endpoint did not change after the copy was last seen (`ref.lastSeenAt`).
   *    That is decided by `source.endpointChangedAt` — the time of the endpoint's LATEST change,
   *    written by every endpoint PATCH since it exists — or, when it is absent (no change since),
   *    by the audit log: any `source.updated` event carrying an endpoint patch after
   *    `ref.lastSeenAt` (every PATCH is audited), or a shrink baseline flagged
   *    `endpointChangedAt` after it, means it may have changed.
   */
  private async boardOfCopy(
    ref: SourceRef,
    source: VerifySource,
  ): Promise<{ board: CopyBoard } | { inconclusive: string }> {
    const current = boardOfSource(source);
    if (ref.board === null)
      return {
        inconclusive: `the board this copy was last seen on is unknown (source ${source._id}'s endpoint changed after that listing was fetched)`,
      };
    if (ref.board) {
      if (!sameBoard(ref.board, current))
        return {
          inconclusive: `source ${source._id}'s endpoint changed since this copy was last seen (seen on ${ref.board.endpointUrl ?? ref.board.boardToken ?? 'unknown'}, now ${current.endpointUrl ?? current.boardToken ?? 'unset'})`,
        };
      return { board: ref.board };
    }
    if (await endpointChangedSince(this.ctx.db, source, ref.lastSeenAt))
      return {
        inconclusive: `source ${source._id}'s endpoint may have changed since this copy was last seen (a copy without a recorded board is verified only on an unchanged endpoint)`,
      };
    return { board: current };
  }

  /**
   * Where to verify an ATS copy (M6.3, MEDIUM-2): the board and API host the copy was seen on
   * (`boardOfCopy`), exactly as `fetch_job_board` fetched it. `apiBase` is null — the caller then
   * reports inconclusive — when it cannot be recovered from the board's endpoint URL.
   */
  private atsTarget(
    ref: SourceRef,
    board: CopyBoard,
    source: VerifySource,
    fallbackToken: string | null,
  ): {
    boardToken: string | null;
    apiBase: string | null;
    endpoint: string | null;
    listingBaseline: { count: number; at: Date } | null;
    listingHeld: boolean;
  } {
    const adapter = getAdapter(ref.provider as AtsProvider);
    const boardToken = board.boardToken ?? fallbackToken;
    const endpoint = board.endpointUrl;
    const apiBase = !boardToken
      ? null
      : board.boardToken
        ? board.apiBase
        : endpoint
          ? apiBaseOfListingUrl(endpoint, boardToken, adapter)
          : adapter.apiBases.default;
    return {
      boardToken,
      apiBase,
      endpoint,
      listingBaseline: source.health?.listingBaseline
        ? { count: source.health.listingBaseline.count, at: source.health.listingBaseline.at }
        : null,
      listingHeld: !!source.health?.listingHeld,
    };
  }

  /**
   * Verify one job and apply the outcome to its lifecycle — at most once per logical operation.
   *
   * `operationKey` identifies the logical verification (the workflow passes the node/item
   * idempotency key). The sequence is replay-safe at every boundary:
   *
   *  1. identify  — id = hash(job, operationKey)
   *  2. claim     — insert the operation (`claimed`); an existing one is resumed, never redone
   *  3. check     — only if no result is persisted yet; the result is persisted (`checked`)
   *                 before it can affect anything, and a persisted result is never re-checked
   *  4. apply     — record the result as the copy's verification evidence, keyed by the
   *                 operation (`ver:<id>`: recorded once, whatever the replays), then re-derive the
   *                 job's lifecycle from its whole evidence set under its revision fence
   *                 (DECISION_LOG 6a01b36), then set `lifecycleApplied`
   *  5. complete  — mark the operation `applied`
   *
   * A crash anywhere replays into the same operation: one `not_found` result is one piece of
   * evidence, so it can never satisfy a two-verification closure rule on its own; and since the
   * lifecycle is a function of the evidence SET ordered by time, the order in which operations are
   * applied never matters.
   */
  async verify(
    jobId: string,
    http: SafeHttpClient,
    opts: { operationKey: string; runId?: string; signal?: AbortSignal },
  ): Promise<JobVerificationDoc> {
    const job = await this.jobs.resolveActive(jobId);
    const id = deterministicId('ver', job._id, opts.operationKey);
    let op = await this.claim(id, job._id, opts);
    if (op.status === 'applied' || op.status === undefined) return op;
    if (op.status === 'claimed') {
      const result = await this.check(await this.jobs.get(op.jobId), http, opts.signal);
      op = await this.recordResult(id, result);
    }
    const applied = await this.applyToJob(op);
    return this.complete(id, applied);
  }

  /** Step 2: create the operation, or return the existing one (whatever its progress). */
  async claim(
    id: string,
    jobId: string,
    opts: { operationKey: string; runId?: string },
  ): Promise<JobVerificationDoc> {
    const now = this.ctx.clock.now();
    const claim: JobVerificationDoc = {
      _id: id,
      jobId,
      status: 'claimed',
      operationKey: opts.operationKey,
      runId: opts.runId,
      at: now,
      schemaVersion: VERIFICATION_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    };
    const doc = await this.col.findOneAndUpdate(
      { _id: id },
      { $setOnInsert: claim },
      { upsert: true, returnDocument: 'after' },
    );
    return doc as JobVerificationDoc;
  }

  /** Step 3: persist the check result. First writer wins; a later result is discarded. */
  async recordResult(
    id: string,
    result: Awaited<ReturnType<VerificationService['check']>>,
  ): Promise<JobVerificationDoc> {
    const now = this.ctx.clock.now();
    await this.col.updateOne(
      { _id: id, status: 'claimed' },
      {
        $set: {
          ...result,
          logicVersion: VERIFICATION_LOGIC_VERSION,
          status: 'checked',
          at: now,
          updatedAt: now,
        },
      },
    );
    return (await this.col.findOne({ _id: id })) as JobVerificationDoc;
  }

  /**
   * Step 4: apply the persisted outcome. It becomes the copy's verification evidence exactly once
   * (key `ver:<operation id>`, at the check time, on the board the check read), and the job is
   * re-derived from its whole evidence set. Nothing here depends on what was applied before: an
   * old result applied late is simply evidence at its own (earlier) time, counted by its source's
   * standing and its copy's board AS OF that time (DECISION_LOG 15c965b). A result recorded under another verification
   * logic version is recorded as `inconclusive` (its rules are not the ones in force): an in-flight
   * operation from before a deploy therefore changes no job state, and the job is simply verified
   * again at its next due time. Returns the states before/after.
   */
  async applyToJob(op: JobVerificationDoc): Promise<{ stateBefore: string; stateAfter: string }> {
    const current = (await this.col.findOne({ _id: op._id })) ?? op;
    if (isLifecycleApplied(current)) return appliedStates(current);
    const recorded = current.outcome ?? 'inconclusive';
    const versionOk = current.logicVersion === VERIFICATION_LOGIC_VERSION;
    const outcome = versionOk ? recorded : 'inconclusive';
    const job = await this.jobs.resolveActive(current.jobId);
    const evidenceId = `ver:${current._id}`;
    const result: NewJobEvidence = {
      _id: evidenceId,
      jobId: job._id,
      copyKey: current.copyKey ?? null,
      sourceId: current.sourceId ?? null,
      board: current.board ?? null,
      at: current.at,
      kind: 'verification',
      outcome,
      ...(current.boardDerived ? { boardDerived: true } : {}),
      verificationId: current._id,
      ...(current.runId ? { runId: current.runId } : {}),
    };
    const inserted = await this.evidence.record([result]);
    const { before, after } = await this.evidence.recompute(job._id, {
      schedule: { kind: 'verification', evidenceId },
      recorded: { inserted: inserted > 0 },
    });
    const states = { stateBefore: before.lifecycle.state, stateAfter: after.lifecycle.state };
    await this.col.updateOne(
      { _id: op._id, lifecycleApplied: { $ne: true }, status: { $ne: 'applied' } },
      {
        $set: {
          lifecycleApplied: true,
          ...(after.rev !== undefined ? { appliedJobRevision: after.rev } : {}),
          ...states,
          ...(versionOk
            ? {}
            : {
                appliedOutcome: 'inconclusive',
                appliedNote: `${recorded} applied as inconclusive: it was recorded under verification logic ${current.logicVersion ?? 'before versioning'}, not ${VERIFICATION_LOGIC_VERSION}`,
              }),
          updatedAt: this.ctx.clock.now(),
        },
      },
    );
    return appliedStates((await this.col.findOne({ _id: op._id })) ?? { ...current, ...states });
  }

  /** Step 5: record completion. Idempotent. */
  async complete(
    id: string,
    states: { stateBefore: string; stateAfter: string },
  ): Promise<JobVerificationDoc> {
    await this.col.updateOne(
      { _id: id, status: { $ne: 'applied' } },
      { $set: { ...states, lifecycleApplied: true, status: 'applied', updatedAt: this.ctx.clock.now() } },
    );
    return (await this.col.findOne({ _id: id })) as JobVerificationDoc;
  }

  /** Completed verifications (in-flight operations are not evidence yet). */
  history(jobId: string, limit = 50) {
    return this.col
      .find({ jobId, status: { $nin: ['claimed', 'checked'] } })
      .sort({ at: -1 })
      .limit(limit)
      .toArray();
  }
}

/** Operations completed before `lifecycleApplied` existed are `applied`, hence applied. */
function isLifecycleApplied(op: JobVerificationDoc): boolean {
  return op.lifecycleApplied === true || op.status === 'applied';
}

function appliedStates(op: JobVerificationDoc): { stateBefore: string; stateAfter: string } {
  return { stateBefore: op.stateBefore ?? 'unknown', stateAfter: op.stateAfter ?? 'unknown' };
}
