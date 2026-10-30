import { createHash } from 'node:crypto';
import { newId } from '@aptamind/contracts';
import { isDuplicateKeyError, validateDocument } from '@aptamind/db';
import { unknownFact } from '@aptamind/provenance';
import type { CompanyPipeline } from '../companies/company-pipeline';
import type { CompanyService } from '../companies/company.service';
import type { JobObservationPayload } from '../contracts/observations';
import type { MarketContext } from '../context';
import type { ObservationService } from '../observations/observation.service';
import type { JobObservationDoc } from '../observations/schemas';
import { descriptionTextOf, type JobReconciler, materialHash } from '../reconciliation/job-reconciler';
import { JOB_RESOLVER_VERSION, type JobCandidate, resolveJobCandidate } from '../resolution/job-resolver';
import type { ReviewRepository } from '../review/review.repository';
import type { SourceDoc } from '../sources/source.schema';
import { authoritativeTierOf, boardSeenAt, sameBoard } from '../sources/source-standing';
import type { JobEvidenceService, NewJobEvidence } from './evidence.service';
import { locationKey, normalizeTitleKey, shingles, urlFingerprint } from './fingerprint';
import { DEFAULT_LIFECYCLE_POLICY, LIFECYCLE_POLICY_VERSION } from './lifecycle';
import {
  type CopyBoard,
  JOB_SCHEMA_VERSION,
  type JobDoc,
  type SourceRef,
  jobsCollection,
} from './job.schema';
import type { JobService } from './job.service';
import { titleTokens } from './title-tokens';

export type JobProcessOutcome =
  | {
      outcome: 'created' | 'updated' | 'syndicated' | 'reposted' | 'reopened';
      jobId: string;
      observationId: string;
      lifecycleState: string;
    }
  | { outcome: 'company_unresolved'; observationId: string; reviewItemId?: string };

export interface ProcessJobInput {
  source: SourceDoc;
  snapshotId?: string;
  artifactId?: string;
  locator?: string;
  payload: JobObservationPayload;
  parser: { name: string; version: string };
  ai?: { provider: string; model: string; promptVersion: string };
  runId?: string;
  /** Observation time (defaults to now); lets tests replay listings deterministically. */
  at?: Date;
  /**
   * The board the listing was read from, captured when its fetch STARTED and carried through the
   * fetch output (DECISION_LOG 6a01b36); `null` when unknown (the copy's evidence then does not
   * count until it is seen on a known board). Omitted by direct callers: the source's board as of
   * `at` (`boardSeenAt`).
   */
  board?: CopyBoard | null;
}

/** Key of a listing's statement about one copy (one per copy, fetch time and outcome). */
export function listingEvidenceKey(copyKey: string, at: Date, outcome: 'present' | 'absent'): string {
  return `listing:${copyKey}@${at.getTime()}:${outcome}`;
}

/**
 * Source job record → Observation → (company) → Job resolution → lifecycle → reconciliation.
 * Every step is idempotent; replaying a listing never duplicates jobs or observations.
 */
/** Copy keys per query of the OPS-2 presence checks. */
const PRESENCE_CHUNK = 500;

export class JobPipeline {
  constructor(
    private readonly ctx: MarketContext,
    private readonly observations: ObservationService,
    private readonly jobs: JobService,
    private readonly companies: CompanyService,
    private readonly companyPipeline: CompanyPipeline,
    private readonly reconciler: JobReconciler,
    private readonly reviews: ReviewRepository,
    private readonly evidence: JobEvidenceService,
  ) {}

  async process(input: ProcessJobInput): Promise<JobProcessOutcome> {
    const { source, payload } = input;
    const { observation } = await this.observations.recordJobObservation({
      sourceId: source._id,
      snapshotId: input.snapshotId,
      artifactId: input.artifactId,
      locator: input.locator,
      externalId: payload.externalId,
      payload,
      parser: input.parser,
      ai: input.ai,
      runId: input.runId,
    });
    const companyId = await this.resolveCompany(source, observation);
    if (!companyId) {
      const refreshed = await this.observations.jobObservations.findOne({ _id: observation._id });
      return {
        outcome: 'company_unresolved',
        observationId: observation._id,
        reviewItemId: refreshed?.resolution.reviewItemId,
      };
    }
    const company = await this.companies.resolveActive(companyId);
    // The sighting time is the snapshot's fetch time (not processing time): a replay of the same
    // snapshot is then recognisably the same sighting, and a re-fetch is a newer one.
    const at =
      input.at ??
      (input.snapshotId
        ? ((await this.observations.snapshots.findOne({ _id: input.snapshotId }))?.lastFetchedAt ??
          this.ctx.clock.now())
        : this.ctx.clock.now());
    const description = descriptionTextOf(observation);
    const sourceKey = `${source._id}:${payload.externalId}`;
    // The tier this copy carries: a source whose provider is third-party by nature or outside the
    // closed job-source set is never authoritative (PR #11 re-verify #7 LOW-1).
    const tier = authoritativeTierOf(source);
    const board = input.board !== undefined ? input.board : boardSeenAt(source, at);
    const contentHash = materialHash(observation);
    // The sighting is evidence with its content hash: CHANGED and REPOSTED are derived from the
    // hashes in time order (DECISION_LOG 15c965b), never from the job's state when it arrived.
    const sighting = (jobId: string): NewJobEvidence => ({
      _id: listingEvidenceKey(sourceKey, at, 'present'),
      jobId,
      copyKey: sourceKey,
      sourceId: source._id,
      board,
      at,
      kind: 'listing',
      outcome: 'present',
      contentHash,
      ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
    });
    const candidate: JobCandidate = {
      sourceId: source._id,
      sourceKey,
      companyId: company._id,
      requisitionId: payload.requisitionId ?? null,
      titleKey: normalizeTitleKey(payload.title),
      locationKey: locationKey(payload.locations.map((l) => l.text)),
      urlFingerprints: [urlFingerprint(payload.postingUrl), urlFingerprint(payload.applyUrl)].filter(
        (x): x is string => !!x,
      ),
      shingles: shingles(description),
    };

    for (let attempt = 0; attempt < 8; attempt++) {
      const decision = await resolveJobCandidate(candidate, this.jobs);
      const ref: SourceRef = {
        key: sourceKey,
        sourceId: source._id,
        externalId: payload.externalId,
        provider: payload.provider.name,
        authority: tier,
        postingUrl: payload.postingUrl ?? null,
        applyUrl: payload.applyUrl ?? null,
        requisitionId: payload.requisitionId ?? null,
        firstSeenAt: at,
        lastSeenAt: at,
        present: true,
        // The board this listing was read from (MEDIUM-2, 6a01b36): its evidence counts only there.
        board,
        lastObservationId: observation._id,
        contentHash,
      };
      let job: JobDoc;
      let outcome: 'created' | 'updated' | 'syndicated' | 'reposted' | 'reopened';
      if (decision.kind === 'new') {
        const created = await this.createJob(
          company._id,
          ref,
          observation,
          at,
          decision.relatedJobIds,
          (id) => sighting(id),
        );
        if (!created) continue; // concurrent creation for the same source key; re-resolve
        job = created;
        outcome = 'created';
        if (decision.possibleDuplicate) {
          const other = await this.jobs.get(decision.possibleDuplicate.jobId);
          await this.reviews.raise({
            type: 'job_duplicate',
            severity: 'low',
            dedupeKey: `job_duplicate:${[job._id, other._id].sort().join(':')}`,
            entity: { kind: 'job', id: job._id },
            subject: `"${payload.title}" may duplicate an existing job`,
            reason: `Same company/title/location with description similarity ${decision.possibleDuplicate.similarity.toFixed(2)}`,
            candidates: [
              {
                kind: 'job',
                id: other._id,
                label: other.identity.title.value ?? other._id,
                score: decision.possibleDuplicate.similarity,
              },
            ],
            observationIds: [observation._id],
            context: { similarity: decision.possibleDuplicate.similarity },
            allowedActions: ['merge', 'keep_separate', 'dismiss'],
          });
        }
      } else {
        const existing = await this.jobs.resolveActive(decision.jobId);
        const prevRef = existing.sourceRefs.find((r) => r.key === sourceKey);
        if (prevRef && at.getTime() <= prevRef.lastSeenAt.getTime()) {
          // Not a newer sighting of this copy: a replay (retry, crash, redelivery, reprocessing)
          // or an older snapshot. Its evidence is recorded once (a replay records nothing new) and
          // the job re-derived; the copy's newer content is never overwritten with older.
          const replayed = sighting(existing._id);
          const inserted = await this.evidence.record([replayed]);
          const { after } = await this.evidence.recompute(existing._id, {
            recorded: { inserted: inserted > 0 },
          });
          await this.observations.setJobResolution([observation._id], {
            state: 'resolved',
            entityId: existing._id,
            method: 'replay:source_key',
            confidence: 'high',
            resolverVersion: JOB_RESOLVER_VERSION,
          });
          return {
            outcome: 'updated',
            jobId: existing._id,
            observationId: observation._id,
            lifecycleState: after.lifecycle.state,
          };
        }
        // A mapped (listed) sighting clears any provider state of the copy (B-M5).
        const { providerState: _unlisted, ...prevRest } = prevRef ?? ({} as Partial<SourceRef>);
        const newRef: SourceRef = prevRef
          ? {
              ...(prevRest as SourceRef),
              ...ref,
              firstSeenAt: prevRef.firstSeenAt,
              lastSeenAt: at > prevRef.lastSeenAt ? at : prevRef.lastSeenAt,
            }
          : ref;
        const refs = [...existing.sourceRefs.filter((r) => r.key !== sourceKey), newRef];
        const wasClosed = existing.lifecycle.state === 'CLOSED';
        const seenNow = sighting(existing._id);
        await this.evidence.record([seenNow]);
        const { $set, $unset, derivation } = await this.evidence.projectionUpdate(
          existing,
          refs,
          { kind: 'listing', at },
          { publishedAt: parseDate(payload.publishedAt) },
        );
        // A repost is what the derivation says (a first sighting of a copy while CLOSED, from the
        // evidence in time order — DECISION_LOG 15c965b), never how this sighting arrived.
        const repostedAt = newRepost(existing.lifecycle.history, derivation.lifecycle.history);
        $set.sourceRefs ??= refs;
        $set.updatedAt = this.ctx.clock.now();
        const update: Record<string, unknown> = { $set, ...(Object.keys($unset).length ? { $unset } : {}) };
        if (!prevRef) update.$addToSet = { sourceKeys: sourceKey };
        if (repostedAt)
          update.$push = {
            reposts: { at: repostedAt, sourceKey, previousState: existing.lifecycle.state },
          };
        try {
          // Revision CAS: a concurrent lifecycle/source-ref write makes us re-resolve and re-derive.
          if (!(await this.jobs.casUpdate(existing, update))) continue;
        } catch (err) {
          if (isDuplicateKeyError(err)) continue; // the source key was claimed concurrently
          throw err;
        }
        job = await this.jobs.get(existing._id);
        outcome = repostedAt
          ? 'reposted'
          : wasClosed && job.lifecycle.state !== 'CLOSED'
            ? 'reopened'
            : prevRef
              ? 'updated'
              : 'syndicated';
      }
      await this.observations.setJobResolution([observation._id], {
        state: 'resolved',
        entityId: job._id,
        method: decision.kind === 'new' ? 'created' : `${decision.relation}:${decision.method}`,
        confidence:
          decision.kind === 'existing' &&
          decision.relation === 'syndicated' &&
          decision.similarity !== undefined
            ? 'medium'
            : 'high',
        resolverVersion: JOB_RESOLVER_VERSION,
      });
      const { job: reconciled } = await this.reconciler.reconcile(job, company);
      return {
        outcome,
        jobId: reconciled._id,
        observationId: observation._id,
        lifecycleState: reconciled.lifecycle.state,
      };
    }
    throw new Error(`Job resolution for ${sourceKey} did not converge`);
  }

  private async resolveCompany(source: SourceDoc, observation: JobObservationDoc): Promise<string | null> {
    if (source.companyId) return (await this.companies.resolveActive(source.companyId))._id;
    const name = observation.payload.companyName;
    if (!name) {
      await this.observations.setJobResolution([observation._id], {
        state: 'failed',
        error: 'no company for job (source has no company and payload has no companyName)',
      });
      return null;
    }
    const res = await this.companyPipeline.process({
      sourceId: source._id,
      snapshotId: observation.snapshotId,
      artifactId: observation.artifactId,
      locator: `${observation.locator ?? ''}#companyName`,
      externalId: `company:${name.trim().toLowerCase()}`,
      payload: { name, aliases: [], externalIds: [], locations: [], industries: [] },
      parser: { name: 'job-company-mention', version: '1' },
    });
    if (res.outcome === 'review') {
      await this.observations.setJobResolution([observation._id], {
        state: 'review',
        reviewItemId: res.reviewItemId,
        error: `company "${name}" unresolved`,
      });
      return null;
    }
    return res.companyId;
  }

  private async createJob(
    companyId: string,
    ref: SourceRef,
    o: JobObservationDoc,
    at: Date,
    related: string[],
    evidenceFor: (jobId: string) => NewJobEvidence,
  ): Promise<JobDoc | null> {
    const now = this.ctx.clock.now();
    const id = newId('job');
    // The creation sighting is the job's first evidence; its lifecycle is derived from it.
    const first = evidenceFor(id);
    await this.evidence.record([first]);
    const publishedAt = parseDate(o.payload.publishedAt);
    const placeholder = {
      state: 'DISCOVERED' as const,
      firstSeenAt: at,
      lastSeenAt: at,
      ...(publishedAt ? { publishedAt } : {}),
      consecutiveAbsences: 0,
      consecutiveNotFound: 0,
      history: [],
      derivedVersion: LIFECYCLE_POLICY_VERSION,
    };
    const u = unknownFact<never>();
    const doc: JobDoc = {
      _id: id,
      companyId,
      status: 'active',
      sourceKeys: [ref.key],
      sourceRefs: [ref],
      urlFingerprints: [],
      requisitionId: o.payload.requisitionId ?? null,
      identity: {
        title: {
          ...u,
          value: o.payload.title as never,
          status: 'known',
          confidence: { level: 'low', reasons: ['initial'] },
        },
        normalizedTitle: o.payload.title.toLowerCase(),
        // Searchable from insertion: a stub whose first reconciliation fails is still found by `q`.
        titleTokens: titleTokens(o.payload.title),
        titleKey: normalizeTitleKey(o.payload.title),
        roleFamily: u,
        specialization: u,
        department: u,
        seniority: u,
      },
      content: { primaryObservationId: o._id, descriptionText: '', descriptionHash: '', shingles: [] },
      employment: { employmentType: u },
      geography: {
        listedLocations: [],
        locationKey: '',
        normalizedLocations: [],
        workModel: u,
        remoteScope: u,
        officeAttendance: u,
      },
      immigration: { sponsorship: u, authorization: u, relocation: u },
      compensation: u,
      requirements: u,
      responsibilities: u,
      application: { canonicalPostingUrl: ref.postingUrl, applyUrl: ref.applyUrl, ats: null },
      lifecycle: placeholder,
      verification: {},
      interpretation: {
        logicVersion: '',
        policyVersion: '',
        taxonomyVersion: '',
        computedAt: now,
        basedOnObservationId: o._id,
        flags: [],
      },
      aiProposals: [],
      overrides: {},
      duplicateOf: [],
      distinctFrom: related,
      reposts: [],
      quality: { conflictFields: [], openReviewCount: 0, sourceCount: 1 },
      contentHash: '',
      schemaVersion: JOB_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    };
    const { $set } = await this.evidence.projectionUpdate(doc, [ref], { kind: 'listing', at });
    if ($set.lifecycle) doc.lifecycle = $set.lifecycle as JobDoc['lifecycle'];
    const due = $set['verification.nextVerificationDueAt'];
    if (due instanceof Date) doc.verification = { nextVerificationDueAt: due };
    try {
      await this.jobs.col.insertOne(validateDocument(jobsCollection, doc));
      return doc;
    } catch (err) {
      if (isDuplicateKeyError(err)) return null;
      throw err;
    }
  }

  /**
   * Entries a listing skipped but identified (malformed with an id, or `unlisted`) are ON the
   * board (M6.1): each is recorded as `present` listing evidence with `skipped: true` (read on
   * `board`, the board the listing was fetched from) and the job is re-derived. A skipped entry is
   * a positive that ends earlier negatives but, not having been read, is no verification (ruling
   * U1): `lastVerifiedAt` does not move and a job whose entry stays skipped decays honestly to
   * POSSIBLY_STALE. A newer sighting also moves the copy's `lastSeenAt` and board and marks it
   * present; an `unlisted` entry marks it `providerState: 'unlisted'` ("hidden by provider", B-M5).
   * Replaying a listing records nothing new.
   */
  async touchSkippedEntries(
    source: SourceDoc,
    skipped: ReadonlyArray<{ externalId: string | null; kind?: string }>,
    at: Date,
    board: CopyBoard | null = boardSeenAt(source, at),
  ): Promise<{ touched: number; unlisted: number }> {
    const counts = { touched: 0, unlisted: 0 };
    for (const entry of skipped) {
      if (entry.externalId === null) continue;
      const key = `${source._id}:${entry.externalId}`;
      const found = await this.jobs.col.findOne(
        { sourceKeys: key, status: 'active' },
        { projection: { _id: 1 } },
      );
      if (!found) continue;
      const skippedEvidence: NewJobEvidence = {
        _id: listingEvidenceKey(key, at, 'present'),
        jobId: found._id,
        copyKey: key,
        sourceId: source._id,
        board,
        at,
        kind: 'listing',
        outcome: 'present',
        skipped: true,
      };
      const inserted = await this.evidence.record([skippedEvidence]);
      let newer = false;
      let hidden = false;
      await this.evidence.recompute(found._id, {
        schedule: { kind: 'listing', at },
        recorded: { inserted: inserted > 0 },
        mutate: (job) => {
          const ref = job.sourceRefs.find((r) => r.key === key);
          newer = !!ref && ref.lastSeenAt.getTime() < at.getTime();
          if (!ref || !newer) return undefined;
          const next: SourceRef = { ...ref, lastSeenAt: at, present: true, board };
          if (entry.kind === 'unlisted') next.providerState = 'unlisted';
          hidden = next.providerState === 'unlisted';
          return job.sourceRefs.map((r) => (r.key === key ? next : r));
        },
      });
      if (newer) {
        counts.touched += 1;
        if (hidden) counts.unlisted += 1;
      }
    }
    return counts;
  }

  /**
   * OPS-2: a digest of the listed copies' content, or null when the listing cannot be confirmed
   * without ingesting it. Every id must be one present copy, without a provider state, of an open
   * job that is not CLOSED; anything else (a new, absent, hidden or closed copy) needs the full
   * path. The digest covers the sorted (copy key, content hash, last observation) triples: it
   * changes whenever any run writes another payload to a listed copy, even one the content hash
   * ignores (title case, apply URL). Observation ids hash the full payload, so it is stable while
   * only confirm runs touch the copies.
   */
  async presenceDigest(sourceId: string, externalIds: readonly string[]): Promise<string | null> {
    const keys = [...new Set(externalIds.map((id) => `${sourceId}:${id}`))];
    if (keys.length !== externalIds.length) return null;
    const pairs: string[] = [];
    for (let i = 0; i < keys.length; i += PRESENCE_CHUNK) {
      const chunk = keys.slice(i, i + PRESENCE_CHUNK);
      const rows = await this.jobs.col
        .aggregate<{ key: string; hash: string; obs: string }>([
          { $match: { sourceKeys: { $in: chunk }, status: 'active', 'lifecycle.state': { $ne: 'CLOSED' } } },
          { $unwind: '$sourceRefs' },
          {
            $match: {
              'sourceRefs.key': { $in: chunk },
              'sourceRefs.present': true,
              'sourceRefs.providerState': { $exists: false },
            },
          },
          {
            $project: {
              _id: 0,
              key: '$sourceRefs.key',
              hash: '$sourceRefs.contentHash',
              obs: '$sourceRefs.lastObservationId',
            },
          },
        ])
        .toArray();
      for (const r of rows) pairs.push(`${r.key}\u0000${r.hash}\u0000${r.obs}`);
    }
    if (pairs.length !== keys.length) return null;
    pairs.sort();
    const digest = createHash('sha256');
    for (const pair of pairs) digest.update(pair).update('\n');
    return digest.digest('hex');
  }

  /**
   * OPS-2: whether a listing of `externalIds` can be confirmed without ingesting it: every listed
   * copy is confirmable (see `presenceDigest`) and still holds the content `digest` was taken of.
   */
  async presenceConfirmable(
    sourceId: string,
    externalIds: readonly string[],
    digest: string,
  ): Promise<boolean> {
    return (await this.presenceDigest(sourceId, externalIds)) === digest;
  }

  /**
   * OPS-2: a listing whose bytes match the last clean one is a fresh sighting of every listed
   * copy. Each gets `present` listing evidence keyed by (copy, fetch time), as an ingest would
   * record, without a content hash (the content did not change, so it is no CHANGED signal),
   * and its job is re-derived: verification time moves and the state stays live. A newer
   * sighting also moves the copy's `lastSeenAt` and board. Replaying records nothing new.
   */
  async confirmListingPresence(
    source: SourceDoc,
    externalIds: readonly string[],
    at: Date,
    board: CopyBoard | null,
    refs: { snapshotId?: string; runId?: string } = {},
  ): Promise<{ confirmed: number }> {
    const keys = externalIds.map((id) => `${source._id}:${id}`);
    let confirmed = 0;
    for (let i = 0; i < keys.length; i += PRESENCE_CHUNK) {
      const chunk = new Set(keys.slice(i, i + PRESENCE_CHUNK));
      const jobs = await this.jobs.col
        .find(
          { sourceKeys: { $in: [...chunk] }, status: 'active' },
          { projection: { _id: 1, sourceKeys: 1 } },
        )
        .toArray();
      for (const job of jobs) {
        const mine = job.sourceKeys.filter((k) => chunk.has(k));
        const inserted = await this.evidence.record(
          mine.map((key): NewJobEvidence => ({
            _id: listingEvidenceKey(key, at, 'present'),
            jobId: job._id,
            copyKey: key,
            sourceId: source._id,
            board,
            at,
            kind: 'listing',
            outcome: 'present',
            ...(refs.snapshotId ? { snapshotId: refs.snapshotId } : {}),
            ...(refs.runId ? { runId: refs.runId } : {}),
          })),
        );
        await this.evidence.recompute(job._id, {
          schedule: { kind: 'listing', at },
          recorded: { inserted: inserted > 0 },
          mutate: (current) => {
            let moved = false;
            const next = current.sourceRefs.map((r) => {
              if (!mine.includes(r.key) || r.lastSeenAt.getTime() >= at.getTime()) return r;
              moved = true;
              return { ...r, lastSeenAt: at, present: true, board };
            });
            return moved ? next : undefined;
          },
        });
        confirmed += mine.length;
      }
    }
    return { confirmed };
  }

  /** Open jobs with a present copy on `sourceId` (effective listing baseline, A-M1 / MEDIUM-1). */
  countPresentJobs(sourceId: string): Promise<number> {
    return this.jobs.countPresentOnSource(sourceId);
  }

  /**
   * After a *complete* listing, every copy on this source that the listing did not contain is
   * recorded as `absent` listing evidence — read on `board`, the board the listing was fetched
   * from — and its job is re-derived (DECISION_LOG 6a01b36). Absence is only recorded when the
   * fetch succeeded; a failed fetch never reaches this method.
   *
   * A listing of another board than a copy's recorded board is no evidence about that copy: the
   * evidence is kept (it is what happened) but never counts, and the copy is left as it was —
   * neither present nor absent ("unknown"), decaying through the stale sweep. Only a copy on the
   * listing's board, not seen since the listing, is marked `present: false`.
   *
   * Replay safety: evidence is keyed by (copy, listing fetch time), so re-running this for the
   * same listing — after a crash midway, a retry or a redelivery — records nothing new, and an
   * older listing replayed after a newer one is just older evidence (the derivation orders by time).
   */
  async applyListingAbsences(
    source: SourceDoc,
    seenExternalIds: Set<string>,
    at: Date,
    snapshotId: string,
    board: CopyBoard | null = boardSeenAt(source, at),
  ): Promise<{ absent: number; closed: number; possiblyStale: number; alreadyApplied: number }> {
    const counts = { absent: 0, closed: 0, possiblyStale: 0, alreadyApplied: 0 };
    // Recently CLOSED jobs too (closed within the stale window of this listing): their absence is
    // evidence like any other, so the evidence set never depends on a projection that may be
    // stale (a late positive may reopen the job in the derivation — re-verify #11 M-A, L-1).
    const recent = new Date(at.getTime() - DEFAULT_LIFECYCLE_POLICY.staleAfterMs);
    const ids = await this.jobs.col
      .find(
        {
          status: 'active',
          'sourceRefs.sourceId': source._id,
          $or: [{ 'lifecycle.state': { $ne: 'CLOSED' } }, { 'lifecycle.closedAt': { $gte: recent } }],
        },
        { projection: { _id: 1 } },
      )
      .map((j) => j._id)
      .toArray();
    // `absent` / `alreadyApplied` count the open jobs whose absence evidence this call recorded /
    // found recorded — jobs already CLOSED (whose absence is recorded only as evidence) are not
    // counted (re-verify #12 LOW-4); `closed` / `possiblyStale` count the transitions this call's
    // own writes made. So a replay after a crash between recording and re-deriving reports the
    // transitions it writes (its evidence being "already applied"), and concurrent duplicates
    // never count one twice.
    for (const id of ids) {
      const r = await this.applyAbsenceToJob(id, source, seenExternalIds, at, snapshotId, board);
      if (r === 'not_absent') continue;
      if (!r.wasClosed) {
        if (r.inserted) counts.absent += 1;
        else counts.alreadyApplied += 1;
      }
      if (r.transition === 'closed') counts.closed += 1;
      if (r.transition === 'possibly_stale') counts.possiblyStale += 1;
    }
    return counts;
  }

  private async applyAbsenceToJob(
    jobId: string,
    source: SourceDoc,
    seenExternalIds: Set<string>,
    at: Date,
    snapshotId: string,
    board: CopyBoard | null,
  ): Promise<
    'not_absent' | { inserted: boolean; wasClosed: boolean; transition: 'closed' | 'possibly_stale' | null }
  > {
    const job = await this.jobs.col.findOne({ _id: jobId });
    if (!job || job.status !== 'active') return 'not_absent';
    const mine = job.sourceRefs.filter((r) => r.sourceId === source._id);
    if (!mine.length || mine.some((r) => seenExternalIds.has(r.externalId))) return 'not_absent';
    const absences: NewJobEvidence[] = mine.map((r) => ({
      _id: listingEvidenceKey(r.key, at, 'absent'),
      jobId,
      copyKey: r.key,
      sourceId: source._id,
      board,
      at,
      kind: 'listing' as const,
      outcome: 'absent' as const,
      snapshotId,
    }));
    const added = await this.evidence.record(absences);
    const { before, after, written } = await this.evidence.recompute(jobId, {
      schedule: { kind: 'listing', at },
      recorded: { inserted: added > 0 },
      mutate: (current) =>
        current.sourceRefs.map((r) => {
          // Only a copy read on this board, and not seen since this listing, is now absent.
          if (
            r.sourceId !== source._id ||
            !sameBoard(r.board, board) ||
            r.lastSeenAt.getTime() >= at.getTime()
          )
            return r;
          const { providerState: _hidden, ...rest } = r;
          return { ...rest, present: false };
        }),
    });
    // The listing's effect is its evidence: a call that recorded nothing new (a replay, or a
    // concurrent duplicate) is "already applied" — but a transition its recompute wrote is its own.
    const moved = written && after.lifecycle.state !== before.lifecycle.state;
    const transition = !moved
      ? null
      : after.lifecycle.state === 'CLOSED'
        ? ('closed' as const)
        : after.lifecycle.state === 'POSSIBLY_STALE'
          ? ('possibly_stale' as const)
          : null;
    return { inserted: added > 0, wasClosed: before.lifecycle.state === 'CLOSED', transition };
  }
}

/** The time of a REPOSTED transition the derived history has and the stored one does not (else null). */
function newRepost(
  stored: JobDoc['lifecycle']['history'],
  derived: JobDoc['lifecycle']['history'],
): Date | null {
  const known = new Set(
    stored.filter((h) => h.to === 'REPOSTED').map((h) => `${h.at.getTime()}:${h.sourceId ?? ''}`),
  );
  const fresh = derived.filter(
    (h) => h.to === 'REPOSTED' && !known.has(`${h.at.getTime()}:${h.sourceId ?? ''}`),
  );
  return fresh.length ? fresh[fresh.length - 1]!.at : null;
}

function parseDate(s: string | null | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
