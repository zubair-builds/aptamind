import type { Filter, UpdateFilter } from 'mongodb';
import { ConflictError, contentHash } from '@aptamind/contracts';
import { getCollection, validateDocument } from '@aptamind/db';
import { metrics } from '@aptamind/observability';
import {
  type AuthorityTier,
  type EvidenceReference,
  type Fact,
  type FactCandidate,
  knownFact,
  selectFact,
  unknownFact,
} from '@aptamind/provenance';
import type { AtsRef, Location } from '../contracts/common';
import type { CompanyDoc, Licence, SponsorshipHistory } from '../companies/company.schema';
import { companiesCollection } from '../companies/company.schema';
import { identityDomainOf } from '../companies/company-pipeline';
import type { CompanyService } from '../companies/company.service';
import {
  companyDomain,
  firstSignificantToken,
  looseNameKey,
  splitTradingName,
  strictNameKey,
} from '../companies/normalize';
import type { MarketContext } from '../context';
import {
  type CompanyObservationDoc,
  companyObservationsCollection,
  sourceTimeOf,
} from '../observations/schemas';
import { idsContradict } from '../companies/external-ids';
import type { ReviewRepository } from '../review/review.repository';
import { ATS_BOARD_DIRECTORY_PROVIDER } from '../sources/providers/ats-board-directory';
import { classifyRoute, registerAdapterById } from '../sources/providers/registers';
import { type SourceDoc, sourcesCollection } from '../sources/source.schema';
import { isConflictField } from './overrides';

export const COMPANY_RECONCILIATION_LOGIC_VERSION = 'company-reconcile/2';
/**
 * company-policy/3 (M8.4b): licences on a route the register taxonomy ignores are left out (never
 * no_longer_listed). company-policy/2: two different ids in one single-valued register namespace are a recorded
 * conflict (quality.conflictFields `identity.externalIds`, a field_conflict review, no identity key
 * for the second id), never a silent union.
 */
export const COMPANY_RECONCILIATION_POLICY_VERSION = 'company-policy/3';

/** A licence route its register's taxonomy classifies `ignored` (M8.4b). */
export function isIgnoredLicenceRoute(register: string, route: string): boolean {
  const adapter = registerAdapterById(register);
  return !!adapter && classifyRoute(adapter, route).meaning === 'ignored';
}

/**
 * Register namespaces in which a company holds contradicting ids (`idsContradict`: one company
 * number, one LEI, …; several D-U-N-S numbers or Companies House BR numbers beside an FC number
 * are fine), with every id of the namespace.
 */
export function conflictingIdNamespaces(
  ids: Array<{ namespace: string; id: string }>,
): Map<string, string[]> {
  const byNs = new Map<string, Set<string>>();
  for (const e of ids) byNs.set(e.namespace, (byNs.get(e.namespace) ?? new Set()).add(e.id));
  const out = new Map<string, string[]>();
  for (const [namespace, set] of byNs) {
    const list = [...set].sort();
    const clash = list.some((a, k) =>
      list.slice(k + 1).some((b) => idsContradict({ namespace, id: a }, { namespace, id: b })),
    );
    if (clash) out.set(namespace, list);
  }
  return out;
}

/**
 * Field authority for company facts. Registries are authoritative for legal existence and
 * licences, but the company's own website/ATS is better for its display name and domain.
 */
const DISPLAY_NAME_RANK: Partial<Record<AuthorityTier, number>> = {
  operator: 100,
  official_site: 90,
  official_ats: 85,
  official_registry: 60,
  third_party: 40,
};
const LEGAL_NAME_RANK: Partial<Record<AuthorityTier, number>> = {
  operator: 100,
  official_registry: 95,
  official_site: 60,
  official_ats: 50,
};

type Obs = CompanyObservationDoc;

/**
 * The fields the reconciler derives, and the only ones it writes. Everything else on a company
 * is owned by another writer and never touched here: `status`/`mergedInto` (merge),
 * `identityKeys` (added uniqueness-guarded after the commit; only stale `ext:` keys are pulled,
 * inside the fenced commit), `identity.distinctFrom` (operator decisions),
 * `freshness.careers*` (careers discovery), and the not-yet-derived seams.
 */
export const COMPANY_RECONCILED_FIELDS = [
  'identity.displayName',
  'identity.legalName',
  'identity.normalizedName',
  'identity.looseKey',
  'identity.firstToken',
  'identity.aliases',
  'identity.domain',
  'identity.website',
  'identity.externalIds',
  'classification.industries',
  'firmographics.foundedYear',
  'firmographics.employeeEstimate',
  'firmographics.employeeRange',
  'firmographics.fundingStage',
  'geography.headquarters',
  'geography.offices',
  'geography.registeredLocations',
  'employment.careersUrls',
  'employment.ats',
  'employment.remotePolicy',
  'employment.relocationSupport',
  'employment.sponsorship',
  'quality',
  'reconciliation',
  'freshness.lastReconciledAt',
  'freshness.lastChangedAt',
  'updatedAt',
] as const;

/** Bound on recomputations when other writers keep advancing the revision. */
const MAX_RECONCILE_ATTEMPTS = 10;

/** Matches the revision a computation was based on (absent = 0). */
export function companyRevisionFilter(company: Pick<CompanyDoc, 'rev'>): Filter<CompanyDoc> {
  return (company.rev ? { rev: company.rev } : { rev: { $in: [0, null] } }) as Filter<CompanyDoc>;
}

/** A computed reconciliation: the company as read (its revision) and its derived next state. */
interface CompanyReconcilePlan {
  company: CompanyDoc;
  next: CompanyDoc;
  observations: Obs[];
  changed: boolean;
  /** Stale `ext:` identity keys the fenced commit pulls (`staleExternalIdKeys`). */
  releaseKeys: string[];
}

const extKey = (e: { namespace: string; id: string }) => `ext:${e.namespace}:${e.id}`;

/**
 * Deterministic company reconciliation: recompute canonical facts from all resolved
 * observations. Idempotent — reconciling twice with the same observations yields the same
 * document (only `computedAt` differs), and contradictory evidence is kept as conflicts.
 *
 * Revision-fenced: the company (and its revision R) is read BEFORE its evidence, the derived
 * fields are computed, and the write commits only `WHERE rev = R` (advancing it). If anything
 * advanced the revision in between — another reconciliation (e.g. one triggered by a newer
 * review decision) or a merge — the computed state is discarded and recomputed from a fresh
 * read; a stale computation never lands. Because the revision is read before the evidence, a
 * computation that missed newer evidence also read an older revision than the reconciliation
 * that follows that evidence, so at most one of them can commit on that revision and the later
 * one always recomputes.
 */
export class CompanyReconciler {
  constructor(
    private readonly ctx: MarketContext,
    private readonly companies: CompanyService,
    private readonly reviews: ReviewRepository,
  ) {}

  async reconcile(companyId: string): Promise<{ company: CompanyDoc; changed: boolean }> {
    for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt++) {
      // Every attempt recomputes from a fresh read: a stale plan is never re-submitted.
      const plan = await this.compute(companyId);
      if (await this.commit(plan)) return this.afterCommit(plan);
      metrics.inc('company_reconcile_revision_conflicts_total');
    }
    throw new ConflictError(
      `Company ${companyId}: reconciliation did not converge (persistent write contention)`,
    );
  }

  /** Read the company (revision first), then its evidence, and derive the next state. */
  private async compute(companyId: string): Promise<CompanyReconcilePlan> {
    const company = await this.companies.resolveActive(companyId);
    // Bounded by the number of source records, not by history: only the current observation of
    // each record is read (older versions are superseded but kept as evidence). No truncation.
    const observations = await getCollection(this.ctx.db, companyObservationsCollection)
      .find({ 'resolution.entityId': company._id, 'resolution.state': 'resolved', superseded: { $ne: true } })
      .sort({ sourceObservedAt: -1, lastObservedAt: -1 })
      .toArray();
    const sourceIds = [...new Set(observations.map((o) => o.sourceId))];
    const sources = new Map(
      (
        await getCollection(this.ctx.db, sourcesCollection)
          .find({ _id: { $in: sourceIds } })
          .toArray()
      ).map((s) => [s._id, s]),
    );
    // Names only ever accumulate as aliases. Superseded versions are not read in full; their
    // distinct names are collected server-side (output bounded by distinct names, not history).
    const historical = await getCollection(this.ctx.db, companyObservationsCollection)
      .aggregate<{ _id: { sourceId: string; name: string } }>([
        {
          $match: {
            'resolution.entityId': company._id,
            'resolution.state': 'resolved',
            superseded: true,
            // History rows never contribute names (M11.5).
            'payload.sponsorshipHistory': null,
          },
        },
        { $project: { sourceId: 1, names: { $concatArrays: [['$payload.name'], '$payload.aliases'] } } },
        { $unwind: '$names' },
        { $group: { _id: { sourceId: '$sourceId', name: '$names' } } },
      ])
      .toArray();
    const withHistory: CompanyDoc = {
      ...company,
      identity: {
        ...company.identity,
        aliases: [
          ...company.identity.aliases,
          ...historical.map(({ _id }) => ({
            name: _id.name,
            strictKey: strictNameKey(_id.name),
            sourceIds: [_id.sourceId],
          })),
        ],
      },
    };
    const now = this.ctx.clock.now();
    const next = buildCanonicalCompany(withHistory, observations, sources, now);
    next.quality.openReviewCount = await this.reviews.countOpenForEntity(company._id);

    const hash = contentHash(canonicalContent(next));
    const changed = hash !== company.reconciliation?.contentHash;
    next.reconciliation = {
      logicVersion: COMPANY_RECONCILIATION_LOGIC_VERSION,
      policyVersion: COMPANY_RECONCILIATION_POLICY_VERSION,
      computedAt: now,
      contentHash: hash,
    };
    next.freshness.lastReconciledAt = now;
    if (changed) next.freshness.lastChangedAt = now;
    next.updatedAt = now;
    const releaseKeys = await this.staleExternalIdKeys(company, observations);
    return { company, next: validateDocument(companiesCollection, next), observations, changed, releaseKeys };
  }

  /**
   * `ext:` identity keys the company may release (DECISION_LOG c1a3500, 621f14c): a key some
   * superseded observation OF THIS COMPANY carried (an older version of a source record), that no
   * current observation of the company carries, and that the current version of that same source
   * record (an observation recorded but not yet resolved, or resolved here) does not carry either.
   * A key written at creation whose creating observation has not linked yet is carried by no past
   * observation, so it is never released; so is any key no observation of this company ever
   * carried. (A rejected observation keeps no company link, so it never counts.) The release is
   * part of the revision-fenced commit, never a separate write, and linking or superseding an
   * observation advances the company's revision (ObservationService), so a plan computed before
   * such a change fails its revision check and recomputes. A stale key is released only when this
   * company is next reconciled.
   */
  private async staleExternalIdKeys(company: CompanyDoc, current: Obs[]): Promise<string[]> {
    const carried = new Set(current.flatMap((o) => o.payload.externalIds.map(extKey)));
    const candidates = company.identityKeys.filter((k) => k.startsWith('ext:') && !carried.has(k));
    if (!candidates.length) return [];
    const ids = candidates.flatMap((k) => {
      const rest = k.slice(4);
      const at = rest.indexOf(':');
      return at > 0 ? [{ namespace: rest.slice(0, at), id: rest.slice(at + 1) }] : [];
    });
    if (!ids.length) return [];
    const col = getCollection(this.ctx.db, companyObservationsCollection);
    const past = await col
      .find(
        {
          'resolution.entityId': company._id,
          'resolution.state': 'resolved',
          superseded: true,
          'payload.externalIds': { $elemMatch: { $or: ids } },
        },
        { projection: { sourceId: 1, externalId: 1, locator: 1, 'payload.externalIds': 1 } },
      )
      .toArray();
    const release = new Set<string>();
    for (const o of past) for (const e of o.payload.externalIds) release.add(extKey(e));
    for (const k of [...release]) if (!candidates.includes(k)) release.delete(k);
    if (!release.size) return [];
    // The current version of each such record: a newer version still in flight (pending, in
    // review, failed) or resolved to this company keeps its keys.
    const records = new Map<string, Filter<Obs>>();
    for (const o of past) {
      const key = o.externalId ? { externalId: o.externalId } : o.locator ? { locator: o.locator } : null;
      if (key)
        records.set(JSON.stringify([o.sourceId, key]), { sourceId: o.sourceId, ...key } as Filter<Obs>);
    }
    if (records.size) {
      const newer = await col
        .find(
          {
            $or: [...records.values()],
            superseded: { $ne: true },
            'resolution.state': { $ne: 'rejected' },
          } as Filter<Obs>,
          { projection: { resolution: 1, 'payload.externalIds': 1 } },
        )
        .toArray();
      for (const o of newer) {
        if (o.resolution.state === 'resolved' && o.resolution.entityId !== company._id) continue;
        for (const e of o.payload.externalIds) release.delete(extKey(e));
      }
    }
    return [...release].sort();
  }

  /**
   * Compare-and-set on the revision the plan was computed from: writes only the derived fields
   * and advances the revision. `false` if the company changed (or was merged) since the read.
   */
  private async commit(plan: CompanyReconcilePlan): Promise<boolean> {
    const $set: Record<string, unknown> = {};
    for (const path of COMPANY_RECONCILED_FIELDS) {
      if (path === 'freshness.lastChangedAt' && !plan.changed) continue;
      const value = path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], plan.next);
      if (value !== undefined) $set[path] = value;
    }
    // Stale `ext:` keys are pulled in the same revision-guarded write: a release computed from a
    // stale observation set never lands (DECISION_LOG c1a3500).
    const update: UpdateFilter<CompanyDoc> = { $set, $inc: { rev: 1 } } as UpdateFilter<CompanyDoc>;
    if (plan.releaseKeys.length)
      (update as Record<string, unknown>).$pull = { identityKeys: { $in: plan.releaseKeys } };
    const res = await getCollection(this.ctx.db, companiesCollection).updateOne(
      { _id: plan.company._id, status: 'active', ...companyRevisionFilter(plan.company) },
      update,
    );
    return res.matchedCount > 0;
  }

  /**
   * Effects derived from the COMMITTED state only (never from a discarded computation):
   * identity keys (additive, uniqueness-guarded — clashes surface as duplicate reviews) and
   * the domain-conflict review.
   */
  private async afterCommit(plan: CompanyReconcilePlan): Promise<{ company: CompanyDoc; changed: boolean }> {
    const { company, next, observations } = plan;
    const wantedKeys = new Set<string>();
    // A conflicting single-valued namespace adds no identity key (the ids already held stay).
    const idConflicts = conflictingIdNamespaces(next.identity.externalIds);
    for (const o of observations) {
      // A history row's key is a row key, not an identifier (DECISION_LOG "Sponsor register
      // adapters" (2)): it never becomes an identity key, so it can never clash between companies.
      if (o.payload.sponsorshipHistory) continue;
      for (const e of o.payload.externalIds)
        if (!idConflicts.has(e.namespace)) wantedKeys.add(`ext:${e.namespace}:${e.id}`);
    }
    if (
      next.identity.domain.value &&
      next.identity.domain.confidence.level !== 'low' &&
      next.identity.domain.status === 'known'
    ) {
      wantedKeys.add(`domain:${next.identity.domain.value}`);
    }
    const clashes = await this.companies.addIdentityKeys(company._id, [...wantedKeys]);
    for (const clash of clashes) {
      if (company.identity.distinctFrom.includes(clash.heldBy)) continue;
      const pair = [company._id, clash.heldBy].sort();
      const other = await this.companies.get(clash.heldBy);
      await this.reviews.raise({
        type: 'company_duplicate',
        severity: 'high',
        dedupeKey: `company_duplicate:${pair.join(':')}`,
        entity: { kind: 'company', id: company._id },
        subject: `${next.identity.displayName.value} may be the same company as ${other.identity.displayName.value}`,
        reason: `Both companies claim identity key ${clash.key}`,
        candidates: [
          {
            kind: 'company',
            id: clash.heldBy,
            label: other.identity.displayName.value ?? clash.heldBy,
            score: 1,
          },
        ],
        context: { key: clash.key },
        allowedActions: ['merge', 'keep_separate', 'dismiss'],
      });
    }

    if (next.identity.domain.status === 'conflicting') {
      await this.reviews.raise({
        type: 'field_conflict',
        severity: 'medium',
        dedupeKey: `field_conflict:company:${company._id}:domain`,
        entity: { kind: 'company', id: company._id },
        subject: `Conflicting official domain for ${next.identity.displayName.value}`,
        reason: 'Sources of equal authority disagree on the official domain',
        evidence: [
          ...next.identity.domain.evidence,
          ...next.identity.domain.conflicts.flatMap((c) => c.evidence),
        ],
        context: { field: 'identity.domain', values: next.identity.domain.conflicts.map((c) => c.value) },
        allowedActions: ['correct', 'dismiss'],
      });
    }
    await this.syncIdConflictReviews(company._id, next, observations, idConflicts);
    return { company: await this.companies.get(company._id), changed: plan.changed };
  }

  /**
   * One high-severity `field_conflict` review per single-valued register namespace holding more
   * than one id (DECISION_LOG re-verification #5 item 7): raised with `refresh` (the values and
   * evidence follow the latest reconciliation), resolved automatically once the conflict is gone,
   * and a dismissal holds for the same set of ids (a new id re-raises it).
   */
  private async syncIdConflictReviews(
    companyId: string,
    next: CompanyDoc,
    observations: Obs[],
    idConflicts: Map<string, string[]>,
  ): Promise<void> {
    const prefix = `field_conflict:company:${companyId}:externalIds:`;
    for (const [namespace, ids] of idConflicts) {
      const dedupeKey = `${prefix}${namespace}`;
      // A dismissal holds for its set of ids and every subset of it (DECISION_LOG c1a3500): when
      // the current set is within ANY dismissed set, the question was answered — close an open
      // item (a later set change re-opened it) and raise nothing.
      const dismissed = await this.reviews.col
        .find({ dedupeKey, status: 'dismissed' }, { projection: { context: 1 } })
        .toArray();
      if (
        dismissed.some((d) => {
          const values = (d.context as { values?: unknown } | undefined)?.values;
          if (!Array.isArray(values)) return false;
          const answered = new Set(values.map(String));
          return ids.every((id) => answered.has(id));
        })
      ) {
        await this.reviews.resolveObsolete(
          dedupeKey,
          `An operator already dismissed this set of ${namespace} ids (or a larger set holding it).`,
          {
            companyId,
            namespace,
            values: ids,
          },
        );
        continue;
      }
      const holding = observations.filter((o) =>
        o.payload.externalIds.some((e) => e.namespace === namespace && ids.includes(e.id)),
      );
      await this.reviews.raise({
        type: 'field_conflict',
        severity: 'high',
        dedupeKey,
        entity: { kind: 'company', id: companyId },
        subject: `Conflicting ${namespace} ids for ${next.identity.displayName.value}`,
        reason: `Observations give ${ids.length} different ${namespace} ids (${ids.join(', ')}); one company has one id per register. Dismiss if every id belongs to this company; otherwise dismiss, or re-import with an id column (the corrected row replaces the old record). Register ids cannot be corrected or split in the app in v0.1.`,
        evidence: holding.slice(0, 20).map((o) => ({
          sourceId: o.sourceId,
          observationId: o._id,
          snapshotId: o.snapshotId,
          artifactId: o.artifactId,
          locator: o.locator,
          observedAt: sourceTimeOf(o),
        })),
        observationIds: holding.slice(0, 100).map((o) => o._id),
        context: { field: 'identity.externalIds', namespace, values: ids },
        allowedActions: ['dismiss'],
        refresh: true,
      });
    }
    // Conflicts that are gone: close their open reviews.
    const open = await this.reviews.col
      .find(
        { dedupeKey: { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` }, status: 'open' },
        { projection: { dedupeKey: 1 } },
      )
      .toArray();
    for (const item of open) {
      const namespace = item.dedupeKey.slice(prefix.length);
      if (idConflicts.has(namespace)) continue;
      await this.reviews.resolveObsolete(
        item.dedupeKey,
        `The company no longer holds more than one ${namespace} id.`,
        { companyId, namespace },
      );
    }
  }
}

function canonicalContent(c: CompanyDoc): unknown {
  const strip = (f: Fact<unknown>) => ({ v: f.value, s: f.status, c: f.conflicts.map((x) => x.value) });
  return {
    name: strip(c.identity.displayName),
    legal: strip(c.identity.legalName),
    aliases: c.identity.aliases.map((a) => a.strictKey),
    domain: strip(c.identity.domain),
    website: strip(c.identity.website),
    industries: strip(c.classification.industries),
    hq: strip(c.geography.headquarters),
    registered: c.geography.registeredLocations,
    offices: c.geography.offices,
    careers: strip(c.employment.careersUrls),
    ats: strip(c.employment.ats),
    sponsor: strip(c.employment.sponsorship.capability),
    licences: c.employment.sponsorship.licences.map((l) => [l.register, l.route, l.status, l.typeRating]),
    // Only when present, so companies without history keep their content hash (no churn).
    ...(c.employment.sponsorship.history?.length
      ? {
          history: c.employment.sponsorship.history.map((h) => [
            h.register,
            h.route,
            h.fiscalYear,
            h.initialApprovals,
            h.initialDenials,
            h.continuingApprovals,
            h.continuingDenials,
          ]),
        }
      : {}),
    employees: strip(c.firmographics.employeeEstimate),
    founded: strip(c.firmographics.foundedYear),
    funding: strip(c.firmographics.fundingStage),
    remote: strip(c.employment.remotePolicy),
    relocation: strip(c.employment.relocationSupport),
  };
}

function authorityOf(o: Obs, sources: Map<string, SourceDoc>): AuthorityTier {
  const source = sources.get(o.sourceId);
  // A board file is never official evidence, whatever tier an older source was stored with (OPS-1b).
  if (!source || source.provider === ATS_BOARD_DIRECTORY_PROVIDER) return 'third_party';
  return source.authority.tier;
}

function evidenceOf(
  o: Obs,
  sources: Map<string, SourceDoc>,
  locator?: string,
  quote?: string,
): EvidenceReference {
  return {
    sourceId: o.sourceId,
    observationId: o._id,
    snapshotId: o.snapshotId,
    artifactId: o.artifactId,
    locator: locator ? `${o.locator ?? ''}${o.locator ? '#' : ''}${locator}` : o.locator,
    quote: quote?.slice(0, 300),
    observedAt: sourceTimeOf(o),
    authority: authorityOf(o, sources),
    extractor: o.parser,
  };
}

function candidates<T>(
  obs: Obs[],
  sources: Map<string, SourceDoc>,
  pick: (o: Obs) => T | null | undefined,
  field: string,
  conf: FactCandidate<T>['confidence'] = 'high',
): Array<FactCandidate<T>> {
  const out: Array<FactCandidate<T>> = [];
  for (const o of obs) {
    const v = pick(o);
    if (v === null || v === undefined || (Array.isArray(v) && v.length === 0) || v === '') continue;
    out.push({
      value: v,
      authority: authorityOf(o, sources),
      confidence: conf,
      evidence: evidenceOf(o, sources, field, typeof v === 'string' ? v : undefined),
      observedAt: sourceTimeOf(o),
    });
  }
  return out;
}

/** Union of array-valued evidence (e.g. industries, careers URLs), keeping every supporting observation. */
function unionFact<T>(
  cands: Array<FactCandidate<T[]>>,
  key: (t: T) => string,
  policyVersion: string,
): Fact<T[]> {
  if (!cands.length) return { ...unknownFact<T[]>(), policyVersion };
  const map = new Map<string, T>();
  for (const c of cands) for (const v of c.value) map.set(key(v), v);
  const best = cands.some((c) => c.confidence === 'high') ? 'high' : 'medium';
  return knownFact(
    [...map.values()],
    { level: best, reasons: [`${cands.length} observation(s)`] },
    cands.map((c) => c.evidence),
    policyVersion,
  );
}

export function buildCanonicalCompany(
  company: CompanyDoc,
  allObs: Obs[],
  sources: Map<string, SourceDoc>,
  now: Date,
): CompanyDoc {
  const P = COMPANY_RECONCILIATION_POLICY_VERSION;
  const next: CompanyDoc = structuredClone(company);
  // Sponsorship history rows (M11.5) are history evidence only: they attach to a company by an
  // exact match and never contribute names, aliases, locations or other identity facts.
  const obs = allObs.filter((o) => !o.payload.sponsorshipHistory);

  // Registers often shout ("ACME LIMITED"); prefer mixed-case spellings of the same name.
  const nameCands = candidates(
    obs,
    sources,
    (o) => splitTradingName(o.payload.name).tradingAs ?? o.payload.name,
    'name',
  ).map((c) => (isShouting(c.value) ? { ...c, confidence: 'medium' as const } : c));
  const displayName = selectFact(nameCands, {
    policyVersion: P,
    authorityRank: DISPLAY_NAME_RANK,
    equals: (a, b) => strictNameKey(a) === strictNameKey(b) && a === b,
  });
  const legalName = selectFact(
    candidates(
      obs,
      sources,
      (o) =>
        o.payload.legalName ??
        (authorityOf(o, sources) === 'official_registry' ? splitTradingName(o.payload.name).legal : null),
      'legalName',
    ),
    { policyVersion: P, authorityRank: LEGAL_NAME_RANK },
  );
  if (displayName.status === 'known') next.identity.displayName = displayName;
  next.identity.legalName = legalName;
  const primaryName =
    legalName.value ??
    displayName.value ??
    company.identity.displayName.value ??
    company.identity.normalizedName;
  next.identity.normalizedName = strictNameKey(primaryName);
  next.identity.looseKey = looseNameKey(primaryName);
  next.identity.firstToken = firstSignificantToken(primaryName);

  const aliasMap = new Map<string, { name: string; strictKey: string; sourceIds: Set<string> }>();
  // Aliases accumulate over the whole history (names only ever add up): start from the stored
  // set, so names that appear only in superseded observations are kept.
  for (const a of company.identity.aliases) {
    if (!a.strictKey || a.strictKey === next.identity.normalizedName) continue;
    const existing = aliasMap.get(a.strictKey);
    if (existing) for (const id of a.sourceIds) existing.sourceIds.add(id);
    else aliasMap.set(a.strictKey, { name: a.name, strictKey: a.strictKey, sourceIds: new Set(a.sourceIds) });
  }
  for (const o of obs) {
    const names = [o.payload.name, ...o.payload.aliases];
    const trading = splitTradingName(o.payload.name).tradingAs;
    if (trading) names.push(trading, splitTradingName(o.payload.name).legal);
    for (const n of names) {
      const k = strictNameKey(n);
      if (!k || k === next.identity.normalizedName) continue;
      const a = aliasMap.get(k) ?? { name: n, strictKey: k, sourceIds: new Set<string>() };
      a.sourceIds.add(o.sourceId);
      aliasMap.set(k, a);
    }
  }
  next.identity.aliases = [...aliasMap.values()]
    .map((a) => ({ name: a.name, strictKey: a.strictKey, sourceIds: [...a.sourceIds].sort() }))
    .sort((a, b) => a.strictKey.localeCompare(b.strictKey));

  next.identity.domain = selectFact(
    // A directory row's Website is an attribute, never domain identity (identityDomainOf).
    candidates(obs, sources, (o) => companyDomain(identityDomainOf(o)), 'domain'),
    {
      policyVersion: P,
      sameAuthorityDisagreement: 'conflict',
    },
  );
  next.identity.website = selectFact(
    candidates(obs, sources, (o) => o.payload.website ?? null, 'website'),
    { policyVersion: P },
  );
  const ext = new Map<string, { namespace: string; id: string }>();
  for (const o of allObs) for (const e of o.payload.externalIds) ext.set(`${e.namespace}:${e.id}`, e);
  next.identity.externalIds = [...ext.values()].sort((a, b) =>
    `${a.namespace}:${a.id}`.localeCompare(`${b.namespace}:${b.id}`),
  );

  next.classification.industries = unionFact(
    candidates(obs, sources, (o) => o.payload.industries, 'industries'),
    (s) => s.toLowerCase(),
    P,
  );
  next.firmographics.foundedYear = selectFact(
    candidates(obs, sources, (o) => o.payload.foundedYear ?? null, 'foundedYear'),
    { policyVersion: P },
  );
  next.firmographics.employeeEstimate = selectFact(
    candidates(
      obs,
      sources,
      (o) => o.payload.employeeCount?.estimate ?? null,
      'employeeCount.estimate',
      'medium',
    ),
    { policyVersion: P },
  );
  next.firmographics.employeeRange = selectFact(
    candidates(
      obs,
      sources,
      (o) =>
        o.payload.employeeCount &&
        (o.payload.employeeCount.min != null || o.payload.employeeCount.max != null)
          ? { min: o.payload.employeeCount.min ?? null, max: o.payload.employeeCount.max ?? null }
          : null,
      'employeeCount.range',
      'medium',
    ),
    { policyVersion: P },
  );
  next.firmographics.fundingStage = selectFact(
    candidates(obs, sources, (o) => o.payload.fundingStage ?? null, 'fundingStage', 'medium'),
    { policyVersion: P },
  );

  const locs = (kind: Location['kind']) =>
    obs.flatMap((o) => o.payload.locations.filter((l) => l.kind === kind));
  next.geography.headquarters = selectFact(
    candidates(
      obs,
      sources,
      (o) => o.payload.locations.find((l) => l.kind === 'hq') ?? null,
      'locations[hq]',
    ),
    { policyVersion: P },
  );
  next.geography.offices = dedupeLocations(locs('office'));
  next.geography.registeredLocations = dedupeLocations([
    ...locs('registered'),
    ...obs
      .filter((o) => o.payload.sponsorLicence?.town)
      .map((o) => ({
        city: o.payload.sponsorLicence?.town ?? null,
        region: o.payload.sponsorLicence?.county ?? null,
        country: o.payload.sponsorLicence?.country ?? null,
        kind: 'registered' as const,
      })),
  ]);

  next.employment.careersUrls = unionFact(
    candidates(obs, sources, (o) => (o.payload.careersUrl ? [o.payload.careersUrl] : null), 'careersUrl'),
    (s) => s,
    P,
  );
  next.employment.ats = unionFact<AtsRef>(
    candidates(
      obs,
      sources,
      (o) =>
        o.payload.ats ? [{ provider: o.payload.ats.provider, boardToken: o.payload.ats.boardToken }] : null,
      'ats',
    ),
    (a) => `${a.provider}:${a.boardToken}`,
    P,
  );
  next.employment.remotePolicy = selectFact(
    candidates(obs, sources, (o) => o.payload.remotePolicyText ?? null, 'remotePolicyText', 'medium'),
    { policyVersion: P },
  );
  next.employment.relocationSupport = selectFact(
    candidates(
      obs,
      sources,
      (o) => o.payload.relocationSupportText ?? null,
      'relocationSupportText',
      'medium',
    ),
    { policyVersion: P },
  );

  // Sponsor licences: company capability evidence only (never role-level sponsorship).
  const licences = new Map<string, Licence>();
  for (const o of obs) {
    const l = o.payload.sponsorLicence;
    if (!l) continue;
    // M8.4b never-delist: a licence on a route its register's taxonomy now ignores is not
    // capability evidence. It is left out, never marked no_longer_listed (the route changed
    // meaning; the register did not delist it). Its observations stay as history.
    if (isIgnoredLicenceRoute(l.register, l.route)) continue;
    const src = sources.get(o.sourceId);
    const cutoff = src?.health.lastCompleteImportStartedAt;
    const listed = !cutoff || sourceTimeOf(o) >= cutoff;
    const key = `${l.register}|${l.route}`;
    const ev = evidenceOf(
      o,
      sources,
      'sponsorLicence',
      `${o.payload.name} — ${l.route}${l.typeRating ? ` (${l.typeRating})` : ''}`,
    );
    const existing = licences.get(key);
    if (!existing) {
      licences.set(key, {
        register: l.register,
        country: l.country,
        route: l.route,
        typeRating: l.typeRating ?? null,
        status: listed ? 'listed' : 'no_longer_listed',
        firstSeenAt: o.firstObservedAt,
        lastSeenAt: sourceTimeOf(o),
        evidence: [ev],
      });
    } else {
      if (listed) existing.status = 'listed';
      if (o.firstObservedAt < existing.firstSeenAt) existing.firstSeenAt = o.firstObservedAt;
      if (sourceTimeOf(o) > existing.lastSeenAt) {
        existing.lastSeenAt = sourceTimeOf(o);
        existing.typeRating = l.typeRating ?? existing.typeRating;
      }
      if (existing.evidence.length < 5) existing.evidence.push(ev);
    }
  }
  const licenceList = [...licences.values()].sort((a, b) =>
    `${a.register}|${a.route}`.localeCompare(`${b.register}|${b.route}`),
  );
  const listed = licenceList.filter((l) => l.status === 'listed');
  next.employment.sponsorship.licences = licenceList;
  next.employment.sponsorship.licenceCountries = [...new Set(listed.map((l) => l.country))].sort();
  next.employment.sponsorship.capability = listed.length
    ? knownFact(
        'licensed',
        { level: 'high', reasons: ['listed on official sponsor register'] },
        listed.flatMap((l) => l.evidence),
        P,
      )
    : licenceList.length
      ? knownFact(
          'previously_licensed',
          { level: 'medium', reasons: ['no longer listed in the latest complete register import'] },
          licenceList.flatMap((l) => l.evidence),
          P,
        )
      : { ...unknownFact(), policyVersion: P };

  // Sponsorship hiring history (M11.5): per register, route and fiscal year, summed over the
  // register's current rows (each row once). History only: capability and licenceCountries are untouched.
  const history = new Map<string, SponsorshipHistory>();
  // One register row counts once, however many sources carry the same register data (the
  // record key identifies the row within its register; observations are newest first).
  const seenRows = new Set<string>();
  for (const o of allObs) {
    const h = o.payload.sponsorshipHistory;
    if (!h) continue;
    const rowKey = `${h.register}|${o.externalId ?? o._id}`;
    if (seenRows.has(rowKey)) continue;
    // The latest complete import of this fiscal year replaced the source's earlier rows of it
    // (DECISION_LOG "Sponsor register adapters" (3)).
    const cutoff = sources
      .get(o.sourceId)
      ?.health.historyPeriods?.find((p) => p.period === h.fiscalYear)?.completeAt;
    if (cutoff && sourceTimeOf(o) < cutoff) continue;
    seenRows.add(rowKey);
    const key = `${h.register}|${h.route}|${h.fiscalYear}`;
    const ev = evidenceOf(
      o,
      sources,
      'sponsorshipHistory',
      `${o.payload.name} — ${h.route} FY${h.fiscalYear}: ${h.initialApprovals + h.continuingApprovals} approved, ${h.initialDenials + h.continuingDenials} denied`,
    );
    const e = history.get(key);
    if (!e) {
      history.set(key, {
        register: h.register,
        country: h.country,
        route: h.route,
        fiscalYear: h.fiscalYear,
        initialApprovals: h.initialApprovals,
        initialDenials: h.initialDenials,
        continuingApprovals: h.continuingApprovals,
        continuingDenials: h.continuingDenials,
        rows: 1,
        evidence: [ev],
      });
    } else {
      e.initialApprovals += h.initialApprovals;
      e.initialDenials += h.initialDenials;
      e.continuingApprovals += h.continuingApprovals;
      e.continuingDenials += h.continuingDenials;
      e.rows += 1;
      if (e.evidence.length < 5) e.evidence.push(ev);
    }
  }
  const historyList = [...history.values()].sort(
    (a, b) =>
      `${a.register}|${a.route}`.localeCompare(`${b.register}|${b.route}`) || a.fiscalYear - b.fiscalYear,
  );
  for (const h of historyList)
    h.evidence.sort((a, b) => (a.observationId ?? '').localeCompare(b.observationId ?? ''));
  next.employment.sponsorship.history = historyList;
  // A country has hiring history when at least one petition there was approved (denials alone
  // are not sponsorship history).
  next.employment.sponsorship.historyCountries = [
    ...new Set(
      historyList.filter((h) => h.initialApprovals + h.continuingApprovals > 0).map((h) => h.country),
    ),
  ].sort();

  const conflictFields: string[] = [];
  // The one definition companies and jobs share (`isConflictField`): conflicting, or a
  // same-authority disagreement; lower-authority alternates stay on the fact only.
  const check = (name: string, f: Fact<unknown>) => {
    if (isConflictField(f)) conflictFields.push(name);
  };
  check('identity.domain', next.identity.domain);
  check('identity.displayName', next.identity.displayName);
  check('firmographics.employeeEstimate', next.firmographics.employeeEstimate);
  check('geography.headquarters', next.geography.headquarters);
  if (conflictingIdNamespaces(next.identity.externalIds).size) conflictFields.push('identity.externalIds');
  next.quality = {
    ...next.quality,
    // History rows never refresh the company's own freshness (DECISION_LOG "Sponsor register
    // adapters" (4)): quality counts identity evidence only.
    observationCount: obs.length,
    sourceIds: [...new Set(obs.map((o) => o.sourceId))].sort(),
    conflictFields,
    lastObservedAt: obs.reduce<Date | undefined>(
      (m, o) => (!m || sourceTimeOf(o) > m ? sourceTimeOf(o) : m),
      undefined,
    ),
  };
  next.updatedAt = now;
  return next;
}

function isShouting(name: string): boolean {
  const letters = name.replace(/[^A-Za-z]/g, '');
  return letters.length > 3 && letters === letters.toUpperCase();
}

function dedupeLocations(list: Location[]): Location[] {
  const map = new Map<string, Location>();
  for (const l of list) {
    const key = [l.city, l.region, l.country, l.text].map((x) => (x ?? '').toLowerCase().trim()).join('|');
    if (key.replace(/\|/g, '')) map.set(key, l);
  }
  return [...map.values()];
}
