import { contentHash, type JsonObject } from '@aptamind/contracts';
import { getCollection, validateDocument } from '@aptamind/db';
import {
  type AuthorityTier,
  type Confidence,
  DEFAULT_AUTHORITY_RANK,
  type EvidenceReference,
  type Fact,
  type FactCandidate,
  selectFact,
  unknownFact,
} from '@aptamind/provenance';
import { TAXONOMY_VERSION } from '@aptamind/taxonomy';
import type { CompanyDoc } from '../companies/company.schema';
import type { EvidenceSpan, JobInterpretation } from '../contracts/employment';
import type { MarketContext } from '../context';
import { interpretJob } from '../enrichment';
import { workCountriesOf } from '../enrichment/interpret';
import { scopesOverlap } from '../enrichment/sponsorship';
import { nextVerificationDue } from '../freshness/policies';
import { locationKey, normalizeTitleKey, shingles, urlFingerprint } from '../jobs/fingerprint';
import { type JobDoc, jobsCollection, type SourceRef } from '../jobs/job.schema';
import { titleTokens } from '../jobs/title-tokens';
import { revisionFilter } from '../jobs/job.service';
import { type JobObservationDoc, jobObservationsCollection } from '../observations/schemas';
import type { ReviewRepository } from '../review/review.repository';
import { descriptionTextOf, interpretationInput } from './interpretation-input';
import {
  applyOverrides,
  disagreementOf,
  isConflictField,
  JOB_OVERRIDE_PATHS,
  JOB_RECONCILIATION_POLICY_VERSION,
  type RejectedOverride,
} from './overrides';
import { type SourceDoc, sourcesCollection } from '../sources/source.schema';

export { descriptionTextOf, interpretationInput } from './interpretation-input';

export const JOB_RECONCILIATION_LOGIC_VERSION = 'job-reconcile/1';
export {
  applyOverrides,
  JOB_OVERRIDE_PATHS,
  JOB_RECONCILIATION_POLICY_VERSION,
  type JobOverrideField,
  sponsorshipCorrectionProblem,
} from './overrides';

const rank = (t: AuthorityTier) => DEFAULT_AUTHORITY_RANK[t] ?? 0;

/** Material content (title, description, locations, pay, employment type) — trivial edits don't count as changes. */
export function materialHash(o: JobObservationDoc): string {
  return contentHash({
    t: o.payload.title.trim().toLowerCase(),
    d: descriptionTextOf(o).replace(/\s+/g, ' ').trim().toLowerCase(),
    l: o.payload.locations.map((l) => l.text.trim().toLowerCase()).sort(),
    c: o.payload.compensation ?? null,
    e: o.payload.employmentTypeText ?? null,
  });
}

/** Choose the primary source copy: present first, then authority, then recency. */
export function primaryRef(refs: SourceRef[]): SourceRef {
  const sorted = [...refs].sort(
    (a, b) =>
      Number(b.present) - Number(a.present) ||
      rank(b.authority) - rank(a.authority) ||
      b.lastSeenAt.getTime() - a.lastSeenAt.getTime(),
  );
  return sorted[0] as SourceRef;
}

type Interpreted<T> = { value: T; confidence: Confidence['level']; evidence: EvidenceSpan[]; basis: string };

/**
 * Convert an interpreted field into a canonical Fact whose evidence points back to the
 * observation/artifact and the exact text span. Company-level evidence (e.g. sponsor licence)
 * is referenced from the company's own licence evidence.
 */
function toFact<T>(
  f: Interpreted<T>,
  o: JobObservationDoc,
  authority: AuthorityTier,
  extractorVersion: string,
  extraEvidence: EvidenceReference[] = [],
): Fact<T> {
  const evidence: EvidenceReference[] = f.evidence
    .filter((e) => e.field !== 'company')
    .map((e) => ({
      sourceId: o.sourceId,
      observationId: o._id,
      snapshotId: o.snapshotId,
      artifactId: o.artifactId,
      // A span into the canonical statement rendering names it (a720377 (1)).
      locator: `${o.locator ?? ''}#${e.field}${e.rendering === 'html_layout' ? '.html_layout' : ''}${e.start !== undefined ? `[${e.start}:${e.end}]` : ''}`,
      quote: e.quote.slice(0, 300),
      observedAt: o.lastObservedAt,
      authority,
      extractor: { name: 'job-interpreter', version: extractorVersion },
    }));
  if (f.evidence.some((e) => e.field === 'company')) evidence.push(...extraEvidence);
  if (f.confidence === 'unknown') {
    return {
      value: f.value,
      status: 'unknown',
      confidence: { level: 'unknown', reasons: [f.basis] },
      evidence,
      conflicts: [],
      policyVersion: JOB_RECONCILIATION_POLICY_VERSION,
    };
  }
  return {
    value: f.value,
    status: 'known',
    confidence: { level: f.confidence, reasons: [f.basis] },
    evidence,
    conflicts: [],
    policyVersion: JOB_RECONCILIATION_POLICY_VERSION,
  };
}

function addConflict<T>(
  fact: Fact<T>,
  other: Fact<T>,
  equals: (a: T, b: T) => boolean,
  reason: string,
): void {
  if (other.status !== 'known' || other.value === null) return;
  if (fact.value !== null && equals(fact.value, other.value)) return;
  fact.conflicts.push({ value: other.value, evidence: other.evidence, reason });
}

const eqJson = <T>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);

export interface ReconcileJobResult {
  job: JobDoc;
  interpretation: JobInterpretation;
  changed: boolean;
}

const RECONCILED_FIELDS = [
  'identity',
  'content',
  'employment',
  'geography',
  'immigration',
  'compensation',
  'requirements',
  'responsibilities',
  'application',
  'interpretation',
  'quality',
  'contentHash',
  'urlFingerprints',
  'requisitionId',
  'updatedAt',
] as const satisfies ReadonlyArray<keyof JobDoc>;

/**
 * Job reconciliation: canonical identity/content from the primary (most authoritative
 * present) source copy; employment intelligence from deterministic interpretation of that
 * copy; lower-authority copies retained as conflicts (e.g. an aggregator disagreeing with the
 * official ATS); operator overrides applied last with `operator` authority.
 */
export class JobReconciler {
  /**
   * Closes open review items whose question no longer arises (wired by the domain to the review
   * service with a system actor; the reconciler cannot depend on the service, which depends on it).
   */
  closeStaleReviews?: (items: Array<{ id: string; reason: string }>) => Promise<void>;

  constructor(
    private readonly ctx: MarketContext,
    private readonly reviews: ReviewRepository,
  ) {}

  /**
   * Recompute the derived canonical fields of `job` and write them — only them, and only if the
   * job's revision is still the one they were derived from. If a lifecycle/source-ref writer got
   * in between, re-read and recompute, so derived fields never reflect a stale set of copies and
   * never overwrite state owned by another writer.
   */
  async reconcile(job: JobDoc, company: CompanyDoc | null): Promise<ReconcileJobResult> {
    const col = getCollection(this.ctx.db, jobsCollection);
    let current = job;
    for (let attempt = 0; attempt < 10; attempt++) {
      const {
        validated,
        interp,
        primaryObs,
        changed,
        rejectedOverrides,
        stating,
        copyReadings,
        flagCopies,
        statingEvidence,
      } = await this.derive(current, company);
      const derived: Record<string, unknown> = {};
      for (const k of RECONCILED_FIELDS) derived[k] = validated[k];
      const due = validated.verification.nextVerificationDueAt;
      const res = await col.updateOne(
        { _id: current._id, ...revisionFilter(current) },
        due
          ? { $set: { ...derived, 'verification.nextVerificationDueAt': due } }
          : { $set: derived, $unset: { 'verification.nextVerificationDueAt': '' } },
      );
      if (res.matchedCount > 0) {
        await this.raiseReviews(validated, interp, primaryObs, rejectedOverrides, {
          stating,
          copyReadings,
          flagCopies,
          statingEvidence,
        });
        return { job: validated, interpretation: interp, changed };
      }
      const fresh = await col.findOne({ _id: current._id });
      if (!fresh) throw new Error(`Job ${current._id} disappeared during reconciliation`);
      current = fresh;
    }
    throw new Error(`Job ${job._id}: reconciliation did not converge (persistent write contention)`);
  }

  /**
   * Interpret `job`'s primary copy as reconciliation does now — same primary copy (present, most
   * authoritative, most recent), same input — without writing anything (`market.interpret_job`).
   * This is the interpretation before cross-copy conflicts and operator overrides.
   */
  async interpret(
    job: JobDoc,
    company: CompanyDoc | null,
  ): Promise<{ interpretation: JobInterpretation; primaryObservationId: string }> {
    const { primaryObs } = await this.copies(job);
    return {
      interpretation: interpretJob(interpretationInput(primaryObs, company)),
      primaryObservationId: primaryObs._id,
    };
  }

  /** The job's current source copies: observations, sources, and the primary copy. */
  private async copies(job: JobDoc) {
    const obsCol = getCollection(this.ctx.db, jobObservationsCollection);
    const observations = new Map(
      (await obsCol.find({ _id: { $in: job.sourceRefs.map((r) => r.lastObservationId) } }).toArray()).map(
        (o) => [o._id, o],
      ),
    );
    const sourceIds = [...new Set(job.sourceRefs.map((r) => r.sourceId))];
    const sources = new Map(
      (
        await getCollection(this.ctx.db, sourcesCollection)
          // Operator overrides cite the operator source as their evidence (`applyOverrides`).
          .find(
            Object.keys(job.overrides ?? {}).length
              ? { $or: [{ _id: { $in: sourceIds } }, { key: OPERATOR_SOURCE_KEY }] }
              : { _id: { $in: sourceIds } },
          )
          .toArray()
      ).map((s) => [s._id, s] as [string, SourceDoc]),
    );
    const primary = primaryRef(job.sourceRefs);
    const primaryObs = observations.get(primary.lastObservationId);
    if (!primaryObs)
      throw new Error(`Primary observation ${primary.lastObservationId} for job ${job._id} not found`);
    return { observations, sources, primary, primaryObs };
  }

  private async derive(job: JobDoc, company: CompanyDoc | null) {
    const { observations, sources, primary, primaryObs } = await this.copies(job);
    const now = this.ctx.clock.now();
    const next = buildCanonicalJob(job, primaryObs, primary, observations, sources, company, now);

    const hash = contentHash({
      title: next.identity.title.value,
      desc: next.content.descriptionHash,
      loc: next.geography.listedLocations,
      wm: next.geography.workModel.value,
      scope: next.geography.remoteScope.value,
      sp: next.immigration.sponsorship.value,
      comp: next.compensation.value,
      req: next.requirements.value?.length ?? 0,
      conflicts: next.quality.conflictFields,
    });
    const changed = hash !== job.contentHash;
    next.contentHash = hash;
    next.quality.openReviewCount = await this.reviews.countOpenForEntity(job._id);
    const validated = validateDocument(jobsCollection, next);
    const interp = next.__interpretation as JobInterpretation;
    return {
      validated,
      interp,
      primaryObs,
      changed,
      rejectedOverrides: next.__rejectedOverrides ?? [],
      stating: next.__stating ?? [],
      copyReadings: next.__copyReadings ?? {},
      flagCopies: next.__flagCopies ?? {},
      statingEvidence: next.__statingEvidence ?? [],
    };
  }

  /**
   * Raise `input` unless the question was already decided (DECISION_LOG 3dfe3c5 (3)): the last
   * item for the same dedupe key and entity was resolved or dismissed by an operator (a system
   * closure or a `retry` decides nothing) and its evidence is unchanged. "Evidence" is a per-kind
   * digest (`evidence`) stored on the item as `context.evidenceHash`. An item without one (closed
   * before 3dfe3c5) does not suppress: the question is asked once more (a720377 (2)).
   */
  private async raiseUnlessDecided(
    input: Parameters<ReviewRepository['raise']>[0],
    evidence: unknown,
  ): Promise<void> {
    const evidenceHash = contentHash(evidence);
    const open = await this.reviews.col.findOne(
      { dedupeKey: input.dedupeKey, status: 'open' },
      { projection: { _id: 1 } },
    );
    const decided = await this.reviews.col
      .find(
        {
          'entity.kind': input.entity.kind,
          'entity.id': input.entity.id,
          status: { $in: ['resolved', 'dismissed'] },
          dedupeKey: input.dedupeKey,
          'resolution.action': { $ne: 'retry' },
          'resolution.actor.kind': { $ne: 'system' },
        },
        { projection: { context: 1 } },
      )
      .sort({ 'resolution.at': -1, updatedAt: -1 })
      .toArray();
    const current = decided.filter((d) => d.context?.evidenceVersion === REVIEW_EVIDENCE_VERSION);
    // ANY earlier operator decision on the same evidence settles it — not only the latest, so
    // evidence flapping between decided states asks nothing (7f01fe5 M2).
    if (!open && current.some((d) => d.context?.evidenceHash === evidenceHash)) return;
    // A decision made before evidence tracking (no hash) or under an older digest version decided
    // an unknown question: it does not suppress — asked once more, saying why, for as long as the
    // latest decision for the key has no current-version digest (a720377 (2), 7f01fe5 L5,
    // bc013e8 L1: the suffix survives refreshes).
    const latest = decided[0];
    if (latest && latest.context?.evidenceVersion !== REVIEW_EVIDENCE_VERSION)
      input = { ...input, reason: `${input.reason} (${ASKED_AGAIN})` };
    // Refreshed while open, so the item always carries the digest of the evidence the operator
    // decides on (a later decision compares against exactly that).
    await this.reviews.raise({
      ...input,
      observationIds: input.observationIds ?? [
        ...new Set((input.evidence ?? []).flatMap((e) => (e.observationId ? [e.observationId] : []))),
      ],
      refresh: true,
      context: { ...(input.context ?? {}), evidenceHash, evidenceVersion: REVIEW_EVIDENCE_VERSION },
    });
  }

  private async raiseReviews(
    job: JobDoc,
    interp: JobInterpretation,
    o: JobObservationDoc,
    rejectedOverrides: RejectedOverride[] = [],
    readings: {
      stating: StatingEntry[];
      copyReadings: CopyReadings;
      flagCopies: FlagCopies;
      statingEvidence: EvidenceReference[];
    } = { stating: [], copyReadings: {}, flagCopies: {}, statingEvidence: [] },
  ): Promise<void> {
    const { stating, copyReadings, flagCopies, statingEvidence } = readings;
    const title = job.identity.title.value ?? job._id;
    // The sponsorship conflict is canonical (all copies); any other high flag is asked while ANY
    // present copy raises it, whichever copy is primary (bc013e8 M3).
    const high = [
      ...interp.flags.filter((f) => f.severity === 'high' && f.code === SPONSORSHIP_CONFLICT),
      ...Object.values(flagCopies).map((c) => c.flag),
    ];
    // A CLOSED job raises no new questions (3dfe3c5 (3)); its stale items are still closed below.
    const raising = job.lifecycle.state !== 'CLOSED';
    for (const r of raising ? rejectedOverrides : []) {
      // One open item per job and field: the stored decision must be taken again.
      await this.raiseUnlessDecided(
        {
          type: 'field_conflict',
          severity: 'medium',
          dedupeKey: `field_conflict:job:${job._id}:override:${r.field}`,
          entity: { kind: 'job', id: job._id },
          subject: `${title}: stored ${r.field} override was not applied`,
          reason: `${r.reason}. A job-level sponsorship correction decides only the role (explicit_yes, explicit_no or unclear): correct it, or dismiss to remove the stored override.`,
          evidence: job.immigration.sponsorship.evidence.slice(0, 10),
          context: {
            fields: [JOB_OVERRIDE_PATHS[r.field]],
            override: r.field,
            overrideValue: r.value as never,
          },
          // `confirm` would leave the stale override in place (the review would re-raise); `dismiss`
          // removes it, `correct` replaces it with a role-axis decision (PR #21 re-verify M3).
          allowedActions: ['correct', 'dismiss'],
        },
        { field: r.field, value: r.value ?? null },
      );
    }
    for (const flag of raising ? high : []) {
      const isSponsorship = flag.code === SPONSORSHIP_CONFLICT;
      // What the operator is shown is what the digest covers (bc013e8 M2): the stated lines of
      // every copy for a sponsorship conflict; the raising copies' work-model lines otherwise.
      // For a sponsorship conflict: every stating entry's own line, never truncated, plus the
      // licence evidence capped on its own (bc013e8 L1).
      const evidence = isSponsorship
        ? [
            ...statingEvidence,
            ...job.immigration.sponsorship.evidence.filter((e) => !e.observationId).slice(0, 3),
          ]
        : (flagCopies[flag.code]?.evidence ?? job.geography.workModel.evidence).slice(0, 10);
      const observationIds = isSponsorship
        ? [...new Set(stating.map((x) => x.observationId))]
        : (flagCopies[flag.code]?.observationIds ?? [o._id]);
      await this.raiseUnlessDecided(
        {
          type: 'employment_conflict',
          severity: 'medium',
          dedupeKey: `employment_conflict:${job._id}:${flag.code}`,
          entity: { kind: 'job', id: job._id },
          subject: `${title}: ${flag.message}`,
          reason: flag.message,
          evidence,
          observationIds,
          // The stating set the operator decides on (3dfe3c5 (2)); kept current while open.
          context: isSponsorship
            ? { flag: flag.code, observationId: o._id, stating: stating as never }
            : { flag: flag.code, observationId: o._id },
          allowedActions: ['confirm', 'correct', 'retry', 'dismiss'],
          refresh: isSponsorship,
        },
        // The stating set by copy and value (bc013e8 L2): observation ids are display only.
        isSponsorship
          ? {
              flag: flag.code,
              stating: stating.map((e) => [e.copy ?? e.observationId, e.value, e.scope ?? '*', e.line ?? '']),
            }
          : // Each flag's own evidence (a720377 L2, 5a13fed, 7f01fe5 H3): per copy that raises
            // it, [observationId, hash of its own work-model reading, lines and flag line] —
            // interpretations only (never the fact after an override), independent of which copy
            // is primary.
            { flag: flag.code, readings: copyReadings[`flag:${flag.code}`] ?? [] },
      );
    }
    // Open employment_conflict items whose flag is no longer present are closed by the system
    // (8d96663 (4)): the question they asked no longer arises. Only the items reconciliation
    // raised (its dedupe key); one being resolved (claimed) is left to its resolver.
    const current = new Set(high.map((f) => f.code));
    const ownKey = `employment_conflict:${job._id}:`;
    const stale = (
      await this.reviews.col
        .find(
          {
            'entity.kind': 'job',
            'entity.id': job._id,
            status: 'open',
            type: 'employment_conflict',
            claim: { $exists: false },
          },
          { projection: { _id: 1, context: 1, dedupeKey: 1 } },
        )
        .toArray()
    ).filter(
      (i) =>
        typeof i.context?.flag === 'string' &&
        i.dedupeKey === `${ownKey}${i.context.flag}` &&
        !current.has(i.context.flag),
    );
    if (stale.length && this.closeStaleReviews) {
      await this.closeStaleReviews(
        stale.map((i) => ({
          id: i._id,
          reason: `The ${String(i.context.flag)} flag is no longer present on the job's interpretation (${interp.policyVersion}, observation ${o._id}); closed automatically.`,
        })),
      );
    }
    if (!raising) return;
    const comp = interp.compensation.value;
    if (comp.status === 'ambiguous' || comp.status === 'malformed') {
      await this.raiseUnlessDecided(
        {
          type: 'salary_suspicious',
          severity: 'low',
          dedupeKey: `salary_suspicious:${job._id}:${contentHash(comp.originalText ?? '')}`,
          entity: { kind: 'job', id: job._id },
          subject: `${title}: salary could not be normalised safely`,
          reason: `${comp.status}: ${comp.warnings.join('; ') || comp.originalText || ''}`.slice(0, 500),
          evidence: job.compensation.evidence,
          context: { originalText: comp.originalText, status: comp.status },
          allowedActions: ['confirm', 'correct', 'dismiss'],
        },
        { status: comp.status, originalText: comp.originalText ?? null, warnings: comp.warnings },
      );
    }
    // Material fields whose sources disagree or whose other copies' values were kept. A
    // sponsorship conflict an operator decided is not asked again here (3dfe3c5 (2)).
    const decided = interp.flags.some((f) => f.code === SPONSORSHIP_CONFLICT_DECIDED);
    const reviewed = (
      [
        ['compensation', job.compensation],
        ['geography.remoteScope', job.geography.remoteScope],
        ...(decided ? [] : [['immigration.sponsorship', job.immigration.sponsorship]]),
      ] as Array<[string, Fact<unknown>]>
    )
      .map(([name, f]) => [name, disagreementOf(f), f] as const)
      .filter(([, kind]) => kind !== null);
    if (reviewed.length) {
      const fields = reviewed.map(([name]) => name).sort();
      const disagree = reviewed.some(([, kind]) => kind !== 'alternates');
      await this.raiseUnlessDecided(
        {
          type: 'field_conflict',
          severity: 'low',
          dedupeKey: `field_conflict:job:${job._id}:${fields.join(',')}`,
          entity: { kind: 'job', id: job._id },
          // "Sources disagree" only for a genuine disagreement (conflicting / same authority);
          // otherwise the canonical value won by authority and the others were kept.
          subject: `${title}: ${disagree ? 'sources disagree' : 'other values kept'} (${fields.join(', ')})`,
          reason: disagree
            ? 'Sources of equal authority disagree, or the policy could not pick a value'
            : 'Lower-authority source copies differ from the canonical (official) values; they are kept as alternates',
          // With sponsorship among the fields, the stating set a `correct` of it decides
          // (a720377 (3)); kept current while the item is open. The key names the fields asked:
          // when a decided sponsorship leaves them, the rest is a different question (new key).
          context: fieldConflictContext(fields, reviewed, stating),
          allowedActions: ['confirm', 'correct', 'dismiss'],
          refresh: true,
        },
        // Per field, every present copy's own reading (primary included), so which copy is
        // primary — which alternates relative to it — does not change the digest (5a13fed).
        reviewed.map(([name]) => ({ name, readings: copyReadings[name] ?? [] })),
      );
    }
  }
}

function fieldConflictContext(
  fields: string[],
  reviewed: ReadonlyArray<readonly [string, unknown, unknown]>,
  stating: StatingEntry[],
): JsonObject {
  const context: JsonObject = {
    fields,
    kinds: Object.fromEntries(reviewed.map(([n, k]) => [n, k])) as JsonObject,
  };
  if (fields.includes('immigration.sponsorship')) context.stating = stating as never;
  return context;
}

/** A canonical job as built, with what reconciliation reports besides it. */
export type CanonicalJob = JobDoc & {
  __interpretation?: JobInterpretation;
  /** Stored overrides that could not be applied as recorded (raised as `field_conflict`). */
  __rejectedOverrides?: RejectedOverride[];
  /** The present copies' stated sponsorship values (context of the conflict review). */
  __stating?: StatingEntry[];
  /** Every stating entry's own line (the conflict review's evidence). */
  __statingEvidence?: EvidenceReference[];
  /** Per reviewed field: every present copy's reading, `[copy key, value hash]`, sorted. */
  __copyReadings?: CopyReadings;
  /** Per (non-sponsorship) high flag: the present copies raising it (bc013e8 M3). */
  __flagCopies?: FlagCopies;
};

/** Per flag code: the first copy's flag and every raising copy's shown lines and observation. */
export type FlagCopies = Record<
  string,
  { flag: JobInterpretation['flags'][number]; evidence: EvidenceReference[]; observationIds: string[] }
>;

/** Per field: `[copy key (source + record), hash of that copy's own reading]` over all present copies. */
export type CopyReadings = Record<string, Array<[string, string]>>;

export function buildCanonicalJob(
  job: JobDoc,
  primaryObs: JobObservationDoc,
  primary: SourceRef,
  observations: Map<string, JobObservationDoc>,
  sources: Map<string, SourceDoc>,
  company: CompanyDoc | null,
  now: Date,
): CanonicalJob {
  const P = JOB_RECONCILIATION_POLICY_VERSION;
  const next: CanonicalJob = structuredClone(job);
  const authorityOf = (o: JobObservationDoc): AuthorityTier =>
    sources.get(o.sourceId)?.authority.tier ?? 'third_party';
  const presentRefs = job.sourceRefs.filter((r) => r.present);
  const refObs = (presentRefs.length ? presentRefs : [primary])
    .map((r) => observations.get(r.lastObservationId))
    .filter((o): o is JobObservationDoc => !!o);

  const ev = (o: JobObservationDoc, locator: string, quote?: string): EvidenceReference => ({
    sourceId: o.sourceId,
    observationId: o._id,
    snapshotId: o.snapshotId,
    artifactId: o.artifactId,
    locator: `${o.locator ?? ''}#${locator}`,
    quote: quote?.slice(0, 300),
    observedAt: o.lastObservedAt,
    authority: authorityOf(o),
    extractor: o.parser,
  });
  const cands = <T>(
    pick: (o: JobObservationDoc) => T | null | undefined,
    locator: string,
  ): Array<FactCandidate<T>> =>
    refObs.flatMap((o) => {
      const v = pick(o);
      return v === null || v === undefined || v === ''
        ? []
        : [
            {
              value: v,
              authority: authorityOf(o),
              confidence: 'high' as const,
              evidence: ev(o, locator, typeof v === 'string' ? v : undefined),
              observedAt: o.lastObservedAt,
            },
          ];
    });

  // Identity & content from the primary copy.
  next.identity.title = selectFact(
    cands((o) => o.payload.title.trim(), 'title'),
    { policyVersion: P },
  );
  const description = descriptionTextOf(primaryObs);
  const interp = interpretJob(interpretationInput(primaryObs, company));
  next.__interpretation = interp;
  const primaryAuthority = authorityOf(primaryObs);
  const v = interp.logicVersion;
  const licenceEvidence = company?.employment.sponsorship.capability.evidence.slice(0, 5) ?? [];

  next.identity.normalizedTitle = interp.title.value.normalized;
  next.identity.titleTokens = titleTokens(next.identity.title.value ?? next.identity.normalizedTitle);
  next.identity.titleKey = normalizeTitleKey(primaryObs.payload.title);
  next.identity.roleFamily = toFact(
    { ...interp.title, value: interp.title.value.roleFamily },
    primaryObs,
    primaryAuthority,
    v,
  ) as Fact<string>;
  next.identity.specialization = toFact(
    { ...interp.title, value: interp.title.value.specialization },
    primaryObs,
    primaryAuthority,
    v,
  ) as Fact<string>;
  next.identity.department = toFact(
    { ...interp.title, value: interp.title.value.department },
    primaryObs,
    primaryAuthority,
    v,
  ) as Fact<string>;
  next.identity.seniority = toFact(
    { ...interp.title, value: interp.title.value.seniority },
    primaryObs,
    primaryAuthority,
    v,
  );
  next.requisitionId = primaryObs.payload.requisitionId ?? job.requisitionId ?? null;

  next.content = {
    primaryObservationId: primaryObs._id,
    descriptionArtifactId: primaryObs.artifactId,
    descriptionText: description,
    descriptionHash: contentHash(description),
    shingles: shingles(description),
  };
  next.employment.employmentType = toFact(interp.employmentType, primaryObs, primaryAuthority, v);
  next.geography.listedLocations = primaryObs.payload.locations.map((l) => l.text);
  next.geography.locationKey = locationKey(next.geography.listedLocations);
  next.geography.normalizedLocations = interp.locations;
  next.geography.workModel = toFact(interp.workModel, primaryObs, primaryAuthority, v);
  next.geography.remoteScope = toFact(interp.remoteScope, primaryObs, primaryAuthority, v);
  next.geography.officeAttendance = toFact(interp.officeAttendance, primaryObs, primaryAuthority, v);
  next.immigration.sponsorship = toFact(interp.sponsorship, primaryObs, primaryAuthority, v, licenceEvidence);
  next.immigration.authorization = toFact(interp.authorization, primaryObs, primaryAuthority, v);
  next.immigration.relocation = toFact(interp.relocation, primaryObs, primaryAuthority, v);
  next.compensation = toFact(interp.compensation, primaryObs, primaryAuthority, v);
  next.requirements = interp.requirements.length
    ? {
        value: interp.requirements,
        status: 'known',
        confidence: { level: 'medium', reasons: ['deterministic section extraction'] },
        evidence: [ev(primaryObs, 'description')],
        conflicts: [],
        policyVersion: P,
      }
    : { ...unknownFact(), policyVersion: P };
  next.responsibilities = {
    value: interp.responsibilities,
    status: 'known',
    confidence: { level: 'low', reasons: ['keyword scope signals'] },
    evidence: [],
    conflicts: [],
    policyVersion: P,
  };

  // Stated sponsorship values of every present copy (DECISION_LOG 8d96663 (2)).
  const statedCopies: StatedCopy[] = [
    { o: primaryObs, reason: null, values: statedValuesOf(interp.flags), sponsorship: null },
  ];
  // Each present copy's own reading of the reviewed fields (primary included), for review
  // evidence digests that do not depend on which copy is primary (DECISION_LOG 5a13fed).
  const copyReadings: CopyReadings = {};
  const flagCopies: FlagCopies = {};
  const addReadings = (o: JobObservationDoc, r: JobInterpretation) => {
    // Keyed by COPY (source + record), not observation: a metadata-only re-observation with the
    // same reading changes nothing (bc013e8 L2); the reading hash captures text changes.
    const copy = copyKeyOf(o);
    const put = (field: string, value: unknown) =>
      (copyReadings[field] ??= []).push([copy, contentHash(value ?? null)]);
    put('compensation', r.compensation.value);
    put('geography.remoteScope', {
      scope: r.remoteScope.value,
      locations: locationKey(o.payload.locations.map((l) => l.text)),
    });
    put('immigration.sponsorship', r.sponsorship.value);
    // Every copy that raises a (non-sponsorship) high flag: its own work-model reading, lines and
    // flag line — the flag's digest over all copies (7f01fe5 H3).
    for (const f of r.flags)
      if (f.severity === 'high' && f.code !== SPONSORSHIP_CONFLICT) {
        put(`flag:${f.code}`, {
          value: r.workModel.value ?? null,
          lines: r.workModel.evidence.map((e) => e.quote).sort(),
          flagLine: f.evidence?.quote ?? null,
        });
        // The copies raising it, with the lines the operator is shown (bc013e8 M2, M3).
        const entry = (flagCopies[f.code] ??= { flag: f, evidence: [], observationIds: [] });
        entry.evidence.push(...toFact(r.workModel, o, authorityOf(o), v).evidence);
        entry.observationIds.push(o._id);
      }
  };
  addReadings(primaryObs, interp);
  // Other present copies: interpret and keep disagreements as conflicts (never overwrite).
  for (const o of refObs) {
    if (o._id === primaryObs._id) continue;
    const other = interpretJob(interpretationInput(o, company));
    const a = authorityOf(o);
    const reason = rank(a) < rank(primaryAuthority) ? 'lower authority' : 'same authority disagreement';
    statedCopies.push({
      o,
      reason,
      values: statedValuesOf(other.flags),
      sponsorship: other.sponsorship.value,
    });
    addReadings(o, other);
    addConflict(next.geography.workModel, toFact(other.workModel, o, a, v), (x, y) => x === y, reason);
    addConflict(
      next.geography.remoteScope,
      toFact(other.remoteScope, o, a, v),
      (x, y) => x.type === y.type && eqJson(x.countries, y.countries) && eqJson(x.regions, y.regions),
      reason,
    );
    addConflict(
      next.compensation,
      toFact(other.compensation, o, a, v),
      (x, y) =>
        x.status === y.status &&
        x.min === y.min &&
        x.max === y.max &&
        x.currency === y.currency &&
        x.period === y.period,
      reason,
    );
    addConflict(
      next.immigration.sponsorship,
      toFact(other.sponsorship, o, a, v),
      (x, y) => x.status === y.status,
      reason,
    );
    const loc = locationKey(o.payload.locations.map((l) => l.text));
    if (loc && loc !== next.geography.locationKey) {
      next.geography.remoteScope.conflicts.push({
        value: null,
        evidence: [ev(o, 'locations', o.payload.locations.map((l) => l.text).join('; '))],
        reason: `${reason}: listed locations differ`,
      });
    }
  }

  const { flags, stating, statingEvidence } = crossCopySponsorship(next, job, interp, statedCopies, ev);
  next.__interpretation = { ...interp, flags };
  next.__stating = stating;
  next.__statingEvidence = statingEvidence;
  for (const entries of Object.values(copyReadings)) entries.sort((x, y) => x[0].localeCompare(y[0]));
  next.__copyReadings = copyReadings;
  next.__flagCopies = flagCopies;

  // Operator overrides win (authority: operator).
  next.__rejectedOverrides = applyOverrides(next, now, operatorSourceId(sources));

  const conflictFields: string[] = [];
  // Listed when sources genuinely disagree (`isConflictField`: conflicting, or a same-authority
  // disagreement). Lower-authority alternates stay on the fact (`conflicts[]`), not listed here.
  const track = (name: string, f: Fact<unknown>) => {
    if (isConflictField(f)) conflictFields.push(name);
  };
  track('identity.title', next.identity.title);
  track('geography.workModel', next.geography.workModel);
  track('geography.remoteScope', next.geography.remoteScope);
  track('compensation', next.compensation);
  // A sponsorship conflict an operator decided is not a listed disagreement (3dfe3c5 (2)).
  if (!flags.some((f) => f.code === SPONSORSHIP_CONFLICT_DECIDED))
    track('immigration.sponsorship', next.immigration.sponsorship);
  next.quality = {
    ...next.quality,
    conflictFields,
    sourceCount: new Set(job.sourceRefs.map((r) => r.sourceId)).size,
  };

  next.urlFingerprints = [
    ...new Set(
      job.sourceRefs
        .flatMap((r) => [urlFingerprint(r.postingUrl), urlFingerprint(r.applyUrl)])
        .filter((x): x is string => !!x),
    ),
  ].sort();
  next.application = {
    canonicalPostingUrl: primary.postingUrl ?? primaryObs.payload.postingUrl ?? null,
    applyUrl: primary.applyUrl ?? primaryObs.payload.applyUrl ?? primary.postingUrl ?? null,
    ats: ['greenhouse', 'ashby', 'lever'].includes(primary.provider)
      ? { provider: primary.provider, boardToken: primaryObs.payload.provider.boardToken ?? null }
      : null,
  };
  next.interpretation = {
    logicVersion: interp.logicVersion,
    policyVersion: interp.policyVersion,
    taxonomyVersion: interp.taxonomyVersion ?? TAXONOMY_VERSION,
    computedAt: now,
    basedOnObservationId: primaryObs._id,
    flags,
  };
  const confirmed = next.lifecycle.lastVerifiedAt ?? next.lifecycle.lastSeenAt;
  if (next.lifecycle.state !== 'CLOSED')
    next.verification.nextVerificationDueAt = nextVerificationDue(confirmed);
  else next.verification.nextVerificationDueAt = undefined;
  next.updatedAt = now;
  return next;
}

/** One present copy's stated sponsorship values (`sponsorship_stated` flags). */
interface StatedCopy {
  o: JobObservationDoc;
  /** Null for the primary copy; else why its values are alternates (authority relation). */
  reason: string | null;
  values: Array<{ value: 'yes' | 'no'; evidence?: EvidenceSpan; scope?: string[] }>;
  sponsorship: JobInterpretation['sponsorship']['value'] | null;
}

function statedValuesOf(flags: JobInterpretation['flags']): StatedCopy['values'] {
  return flags.flatMap((f) =>
    f.code === 'sponsorship_stated' && f.value
      ? [{ value: f.value, evidence: f.evidence, ...(f.scope ? { scope: f.scope } : {}) }]
      : [],
  );
}

export const SPONSORSHIP_CONFLICT = 'sponsorship_conflict';
/**
 * Version of the review evidence digests (7f01fe5 L5): 2 = per-copy readings over all present
 * copies (5a13fed / 7f01fe5). A decision recorded under another version re-asks once.
 */
export const REVIEW_EVIDENCE_VERSION = 2;
/** Reason suffix of a question re-raised because its earlier decision has no current digest. */
export const ASKED_AGAIN = 'asked again: the earlier decision predates evidence tracking';
export const SPONSORSHIP_CONFLICT_DECIDED = 'sponsorship_conflict_decided';

/**
 * One stated value of one present copy: the unit an operator decision covers (3dfe3c5 (2)). Keyed
 * by the COPY (source + record), the value, the key's SCOPE (`*` for a generic key) and the
 * normalised stated LINE (re-verify #14 L2, final check M-2): a metadata-only re-observation is
 * the same entry, an edit of the stated line ("H-1B sponsorship: No" → "Visa sponsorship: No") is
 * not. `observationId` is kept for display (and matches decisions recorded before copies were keyed).
 */
export interface StatingEntry {
  copy?: string;
  observationId: string;
  value: 'yes' | 'no';
  /** The key's scope: sorted ISO-2 codes joined by `,`, or `*` for a generic key. */
  scope?: string;
  /** Hash of the normalised stated line. */
  line?: string;
}

/** The copy key of an observation: its source and source record. */
export function copyKeyOf(o: Pick<JobObservationDoc, '_id' | 'sourceId' | 'externalId' | 'locator'>): string {
  return `${o.sourceId}\u0000${o.externalId ?? o.locator ?? o._id}`;
}

/** A stated line, normalised: lower case, single spaces, no trailing period. */
function lineHash(quote: string | undefined): string {
  return contentHash((quote ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/\.$/, ''));
}

const sep = '\u0000';
/** The keys an entry matches under: full (copy, value, scope, line), and older-decision forms. */
const entryKeys = (e: StatingEntry): string[] => [
  ...(e.copy && e.scope && e.line ? [['f', e.copy, e.value, e.scope, e.line].join(sep)] : []),
  ...(e.copy ? [['c', e.copy, e.value].join(sep)] : []),
  ['o', e.observationId, e.value].join(sep),
];
/** The one key a decided entry is matched by: its most specific form. */
const decidedKey = (e: StatingEntry): string => entryKeys(e)[0]!;

/** The stating set of `copies`: every (copy, value, scope, line), sorted, without duplicates. */
export function statingSetOf(copies: Array<Pick<StatedCopy, 'o' | 'values'>>): StatingEntry[] {
  const seen = new Map<string, StatingEntry>();
  for (const c of copies)
    for (const v of c.values) {
      const copy = copyKeyOf(c.o);
      const scope = v.scope?.length ? [...v.scope].sort().join(',') : '*';
      const line = lineHash(v.evidence?.quote);
      seen.set([copy, v.value, scope, line].join(sep), {
        copy,
        observationId: c.o._id,
        value: v.value,
        scope,
        line,
      });
    }
  return [...seen.values()].sort((x, y) =>
    [x.copy, x.value, x.scope, x.line].join(sep).localeCompare([y.copy, y.value, y.scope, y.line].join(sep)),
  );
}

/**
 * Whether every entry of `current` is in `decided`: each decided entry by its most specific form —
 * (copy, value, scope, line); (copy, value) for a decision recorded before scopes and lines; or
 * (observation, value) before copies were keyed.
 */
export function isDecided(current: StatingEntry[], decided: StatingEntry[] | undefined): boolean {
  if (!decided) return false;
  const keys = new Set(decided.map(decidedKey));
  return current.every((c) => entryKeys(c).some((k) => keys.has(k)));
}

/**
 * Stated sponsorship values compared across ALL present copies (DECISION_LOG 8d96663 (2),
 * 3dfe3c5 (2), bc013e8); returns the canonical interpretation flags, the current stating set and
 * every stating entry's own line (the conflict review's evidence).
 *
 *  - a "yes" and a "no" whose key scopes overlap (a generic key overlaps every scope) — in one
 *    copy or across copies — are `sponsorship_conflict` (high → employment_conflict review), each
 *    other copy's differing value and its line kept on the sponsorship fact as an alternate;
 *  - an operator decision on the conflict (`job.sponsorshipDecision`: override, dismiss or
 *    confirm) suppresses it only while the current stating set is a SUBSET of the decided one
 *    — then it is the info flag `sponsorship_conflict_decided`. Any other (copy, value) re-raises it;
 *  - a stated "no" of ANY copy counts like the primary copy's where its scope ∩ the licence ∩ the
 *    job's countries is not empty: it lowers `company_capable` to low confidence and, when no copy
 *    states "yes", sets `sponsorship_role_overrides_company`.
 */
function crossCopySponsorship(
  next: CanonicalJob,
  job: JobDoc,
  interp: JobInterpretation,
  copies: StatedCopy[],
  ev: (o: JobObservationDoc, locator: string, quote?: string) => EvidenceReference,
): { flags: JobInterpretation['flags']; stating: StatingEntry[]; statingEvidence: EvidenceReference[] } {
  const stating = statingSetOf(copies);
  let flags = interp.flags;
  const fact = next.immigration.sponsorship;
  const lineOf = (c: StatedCopy, v: StatedCopy['values'][number]) => {
    const span = v.evidence;
    return ev(
      c.o,
      span?.start !== undefined
        ? `${span.field}${span.rendering === 'html_layout' ? '.html_layout' : ''}[${span.start}:${span.end}]`
        : 'description',
      span?.quote,
    );
  };
  // Every stating entry's own line, deduplicated (bc013e8 L1).
  const seenLines = new Set<string>();
  const statingEvidence = copies.flatMap((c) =>
    c.values.flatMap((v) => {
      const e = lineOf(c, v);
      const k = `${e.observationId}\u0000${e.locator}`;
      if (seenLines.has(k)) return [];
      seenLines.add(k);
      return [e];
    }),
  );
  const all = copies.flatMap((c) => c.values);
  const licence = fact.value?.capabilityCountries ?? [];
  const jobCountries = workCountriesOf(interp);
  const noAgainstLicence = all.some(
    (v) =>
      v.value === 'no' &&
      (v.scope ?? jobCountries).some((c) => licence.includes(c) && jobCountries.includes(c)),
  );
  if (noAgainstLicence && fact.value?.status === 'company_capable') {
    if (fact.confidence.level !== 'low' && fact.confidence.level !== 'unknown') {
      fact.confidence = {
        level: 'low',
        reasons: [...fact.confidence.reasons, 'a source copy states no sponsorship'],
      };
    }
    if (
      !all.some((v) => v.value === 'yes') &&
      !flags.some((f) => f.code === 'sponsorship_role_overrides_company')
    )
      flags = [
        ...flags,
        {
          code: 'sponsorship_role_overrides_company',
          message:
            'Company holds a sponsor licence but a source copy states that this role does not offer sponsorship.',
          severity: 'info',
        },
      ];
  }
  // Polarities conflict only where the keys' scopes overlap (bc013e8 L3).
  const contradicts = all.some(
    (a) => a.value === 'yes' && all.some((b) => b.value === 'no' && scopesOverlap(a.scope, b.scope)),
  );
  if (!contradicts) return { flags, stating, statingEvidence };
  const primaryValues = new Set(copies[0]!.values.map((v) => v.value));
  for (const c of copies.slice(1)) {
    for (const v of c.values) {
      if (primaryValues.has(v.value)) continue;
      fact.conflicts.push({
        value: c.sponsorship,
        evidence: [lineOf(c, v)],
        reason: `${c.reason}: the copy states visa sponsorship ${v.value}`,
      });
    }
  }
  if (!flags.some((f) => f.code === SPONSORSHIP_CONFLICT))
    flags = [
      ...flags,
      {
        code: SPONSORSHIP_CONFLICT,
        message:
          'Source copies of this job state contradictory visa sponsorship values; human review needed.',
        severity: 'high' as const,
      },
    ];
  const decision = job.sponsorshipDecision;
  if (decision && isDecided(stating, decision.stating)) {
    flags = flags.map((f) =>
      f.code === SPONSORSHIP_CONFLICT
        ? {
            code: SPONSORSHIP_CONFLICT_DECIDED,
            message: `Contradictory stated sponsorship values were decided by an operator (${decision.action}, ${decision.at.toISOString()}); not re-raised while no other copy states a value.`,
            severity: 'info' as const,
          }
        : f,
    );
  }
  return { flags, stating, statingEvidence };
}

/** Key of the built-in source that operator decisions are attributed to (`system-sources.ts`). */
const OPERATOR_SOURCE_KEY = 'system:operator';
/** Legacy evidence source id of operator overrides; used only if the operator source is missing. */
const LEGACY_OPERATOR_SOURCE_ID = 'operator';

function operatorSourceId(sources: Map<string, SourceDoc>): string {
  for (const s of sources.values()) if (s.key === OPERATOR_SOURCE_KEY) return s._id;
  return LEGACY_OPERATOR_SOURCE_ID;
}

/**
 * Why an operator override of `field` with `value` would not yield a valid canonical job, or
 * `null` if it would. Checked before a review correction is accepted, so a decision that
 * reconciliation could never apply is rejected up front instead of being persisted.
 */
export function overrideProblem(job: JobDoc, field: string, value: unknown): string | null {
  const at = new Date(0);
  const next = structuredClone(job);
  next.overrides = { ...next.overrides, [field]: { value, reason: 'validation', actorId: 'validation', at } };
  applyOverrides(next, at, LEGACY_OPERATOR_SOURCE_ID);
  const parsed = jobsCollection.schema.safeParse(next);
  if (parsed.success) return null;
  return parsed.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
}
