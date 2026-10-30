import type { ClientSession, Filter } from 'mongodb';
import { type Actor, InvalidStateError, newId, NotFoundError, type Page } from '@aptamind/contracts';
import { getCollection, isDuplicateKeyError, validateDocument, withTransaction } from '@aptamind/db';
import { unknownFact } from '@aptamind/provenance';
import type { MarketContext } from '../context';
import { companyObservationsCollection } from '../observations/schemas';
import type { CompanyCandidate, CompanyLookup, CompanySummary } from '../resolution/company-resolver';
import { type HistoryLookup, subdivisionCode } from '../resolution/history-attachment';
import type { AuditLog } from '../review/audit';
import { sourcesCollection } from '../sources/source.schema';
import { escapeRegex } from '../sources/source.service';
import { COMPANY_SCHEMA_VERSION, type CompanyDoc, companiesCollection } from './company.schema';
import { normalizeObservationExternalIds } from './external-ids';
import { companyDomain, firstSignificantToken, identityKeys, looseNameKey, strictNameKey } from './normalize';
import { followMergeChain } from '../merge-chain';

export function summarize(c: CompanyDoc): CompanySummary {
  return {
    id: c._id,
    displayName: c.identity.displayName.value ?? c.identity.normalizedName,
    strictKeys: c.identityKeys
      .filter((k) => k.startsWith('name:'))
      .map((k) => k.slice(5).split('#')[0] as string),
    looseKey: c.identity.looseKey,
    domain: c.identity.domain.value,
    hqCountry: c.geography.headquarters.value?.country ?? null,
    registeredTowns: c.geography.registeredLocations.map((l) => l.city ?? '').filter(Boolean),
    names: [
      ...new Set([c.identity.displayName.value, c.identity.legalName.value].filter((n): n is string => !!n)),
    ],
    aliases: c.identity.aliases.map((a) => a.name),
    externalIds: externalIdsOf(c),
  };
}

/**
 * The company's external ids: `identity.externalIds`, plus — as a backstop, whether or not the
 * company was reconciled (DECISION_LOG c1a3500) — every `ext:` identity key (a key is written with
 * the company, before its observation links); de-duplicated. A corrected id leaves no stale id
 * behind because reconciliation releases the stale key in its fenced commit.
 */
export function externalIdsOf(
  c: Pick<CompanyDoc, 'identityKeys' | 'identity'>,
): Array<{ namespace: string; id: string }> {
  const out = new Map<string, { namespace: string; id: string }>();
  for (const e of c.identity.externalIds) out.set(`${e.namespace}:${e.id}`, e);
  for (const k of c.identityKeys) {
    if (!k.startsWith('ext:')) continue;
    const rest = k.slice(4);
    const at = rest.indexOf(':');
    if (at <= 0) continue;
    const e = { namespace: rest.slice(0, at), id: rest.slice(at + 1) };
    out.set(`${e.namespace}:${e.id}`, e);
  }
  return [...out.values()];
}

/** Empty canonical company: every fact unknown until reconciliation attaches evidence. */
export function emptyCompany(
  id: string,
  name: string,
  keys: string[],
  now: Date,
  seed: { externalIds?: Array<{ namespace: string; id: string }>; country?: string | null } = {},
): CompanyDoc {
  const u = <T>() => unknownFact<T>();
  return {
    _id: id,
    status: 'active',
    identityKeys: keys,
    identity: {
      displayName: {
        ...u<string>(),
        value: name,
        status: 'known',
        confidence: { level: 'low', reasons: ['initial candidate name'] },
      },
      legalName: u(),
      normalizedName: strictNameKey(name),
      looseKey: looseNameKey(name),
      firstToken: firstSignificantToken(name),
      aliases: [],
      domain: u(),
      website: u(),
      externalIds: seed.externalIds ?? [],
      distinctFrom: [],
    },
    classification: { industries: u(), stage: u(), businessModel: u(), schemes: [] },
    firmographics: { foundedYear: u(), employeeEstimate: u(), employeeRange: u(), fundingStage: u() },
    // The candidate's HQ country is held from the creating write (a concurrent import sees it);
    // reconciliation replaces it with the evidence-backed fact.
    geography: {
      headquarters: seed.country
        ? {
            ...u<{ country: string; kind: 'hq' }>(),
            value: { country: seed.country, kind: 'hq' },
            status: 'known',
            confidence: { level: 'low', reasons: ['initial candidate country'] },
          }
        : u(),
      offices: [],
      registeredLocations: [],
      hiringCountries: u(),
    },
    employment: {
      careersUrls: u(),
      ats: u(),
      remotePolicy: u(),
      sponsorship: { capability: u(), licenceCountries: [], licences: [], history: [], historyCountries: [] },
      relocationSupport: u(),
      eorIndicators: u(),
    },
    organization: { founders: [], leadership: [] },
    quality: { observationCount: 0, sourceIds: [], conflictFields: [], openReviewCount: 0 },
    freshness: { careersDiscoveryStatus: 'not_attempted' },
    schemaVersion: COMPANY_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Company persistence: lookup port for the resolver, idempotent creation guarded by the
 * unique identity-key index, audited merges, and read models.
 */
export class CompanyService implements CompanyLookup {
  constructor(
    private readonly ctx: MarketContext,
    private readonly audit: AuditLog,
  ) {}

  get col() {
    return getCollection(this.ctx.db, companiesCollection);
  }

  async get(id: string): Promise<CompanyDoc> {
    const c = await this.col.findOne({ _id: id });
    if (!c) throw new NotFoundError('Company', id);
    return c;
  }

  /**
   * The active survivor of `id` for API reads: follows `mergedInto` (≤ `MERGE_CHAIN_MAX` hops) and
   * throws `MergeChainError` (409) on a cycle, an over-long or a broken chain — never returns a
   * merged record. 404 for an unknown id.
   */
  async resolveSurvivor(id: string): Promise<CompanyDoc> {
    return followMergeChain('company', await this.get(id), (next) => this.col.findOne({ _id: next }));
  }

  /**
   * Follow merge pointers to the surviving company (domain paths; stops after `MERGE_CHAIN_MAX`
   * hops and may then return a merged record — API reads use `resolveSurvivor`), within `session`
   * when given.
   */
  async resolveActive(id: string, session?: ClientSession): Promise<CompanyDoc> {
    const get = async (x: string) => {
      const c = await this.col.findOne({ _id: x }, session ? { session } : {});
      if (!c) throw new NotFoundError('Company', x);
      return c;
    };
    let c = await get(id);
    for (let i = 0; i < 10 && c.status === 'merged' && c.mergedInto; i++) c = await get(c.mergedInto);
    return c;
  }

  // --- CompanyLookup ----------------------------------------------------------------------

  async byIdentityKey(key: string): Promise<CompanySummary | null> {
    const c = await this.col.findOne({ identityKeys: key, status: 'active' });
    if (!c) return null;
    return summarize(c.status === 'merged' ? await this.resolveActive(c._id) : c);
  }

  /** The lookup port of attach-only history resolution (`resolveHistoryAttachment`, M11.5). */
  historyLookup(): HistoryLookup {
    return {
      hasLooseKey: async (loose) =>
        !!(await this.col.findOne(
          { status: 'active', 'identity.looseKey': loose },
          { projection: { _id: 1 } },
        )),
      byNameKey: async (key, country) => {
        const docs = await this.col
          .find({
            status: 'active',
            $or: [
              { identityKeys: `name:${key}` },
              { 'identity.normalizedName': key },
              { 'identity.aliases.strictKey': key },
            ],
          })
          .limit(20)
          .toArray();
        return docs.map((d) => {
          const places = [
            d.geography.headquarters.value,
            ...d.geography.offices,
            ...d.geography.registeredLocations,
          ].filter((l): l is NonNullable<typeof l> => !!l && l.country === country);
          return {
            id: d._id,
            label: d.identity.displayName.value ?? d._id,
            ownNameKeys: [
              ...new Set(
                [d.identity.normalizedName, d.identity.displayName.value, d.identity.legalName.value]
                  .filter((n): n is string => !!n)
                  .map((n) => (n === d.identity.normalizedName ? n : strictNameKey(n))),
              ),
            ],
            aliasKeys: d.identity.aliases.map((a) => a.strictKey),
            states: [
              ...new Set(
                places.map((l) => subdivisionCode(country, l.region)).filter((c): c is string => !!c),
              ),
            ],
          };
        });
      },
    };
  }

  async byStrictName(strictKey: string): Promise<CompanySummary[]> {
    const docs = await this.col
      .find({
        status: 'active',
        $or: [{ identityKeys: `name:${strictKey}` }, { 'identity.aliases.strictKey': strictKey }],
      })
      .limit(20)
      .toArray();
    return docs.map(summarize);
  }

  async byLooseKey(looseKey: string): Promise<CompanySummary[]> {
    return (await this.col.find({ status: 'active', 'identity.looseKey': looseKey }).limit(20).toArray()).map(
      summarize,
    );
  }

  async byFirstToken(token: string, limit: number): Promise<CompanySummary[]> {
    return (
      await this.col.find({ status: 'active', 'identity.firstToken': token }).limit(limit).toArray()
    ).map(summarize);
  }

  // --- Creation / identity keys -------------------------------------------------------------

  /**
   * Create a company for an unmatched candidate. Returns `null` if another process created
   * a company holding one of the identity keys first (caller re-resolves).
   * `nameQualifier` is used when an operator declares a same-named entity distinct.
   */
  async createFromCandidate(
    c: CompanyCandidate,
    opts: { nameQualifier?: string; id?: string; session?: ClientSession } = {},
  ): Promise<CompanyDoc | null> {
    const keys = this.identityKeysFor(c, opts.nameQualifier);
    // The candidate's register ids and HQ country are part of the creating write, so a concurrent
    // import (and a lost-race retry) sees them immediately (DECISION_LOG re-verification #5).
    const doc = emptyCompany(opts.id ?? newId('cmp'), c.name, keys, this.ctx.clock.now(), {
      externalIds: normalizeObservationExternalIds(c.externalIds ?? []),
      // Only an HQ or registered-office country (never locations[0] or a licence country).
      country: c.hqCountry ? c.hqCountry.toUpperCase() : null,
    });
    if (opts.session) {
      // Inside the caller's transaction a duplicate-key error aborts it, so a replay looks the
      // caller-chosen id up first, and an identity clash is a domain error (nothing commits).
      const session = opts.session;
      if (opts.id) {
        const existing = await this.col.findOne({ _id: opts.id }, { session });
        if (existing) return existing;
      }
      try {
        await this.col.insertOne(validateDocument(companiesCollection, doc), { session });
        return doc;
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        throw new InvalidStateError(
          'Could not create a distinct company: another company holds its identity',
          {
            identityKeys: keys,
          },
        );
      }
    }
    try {
      await this.col.insertOne(validateDocument(companiesCollection, doc));
      return doc;
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      // A caller-chosen id makes creation replay-safe: the earlier insert is the result.
      if (opts.id) return this.col.findOne({ _id: opts.id });
      return null;
    }
  }

  /** The identity keys `createFromCandidate` gives a company for this candidate. */
  identityKeysFor(c: CompanyCandidate, nameQualifier?: string): string[] {
    const strict = strictNameKey(c.name);
    return identityKeys({
      strictNames: [nameQualifier ? `${strict}#${nameQualifier}` : strict],
      domain: companyDomain(c.domain ?? null),
      externalIds: c.externalIds ?? [],
    });
  }

  /**
   * Add identity keys. A key already held by another company is not stolen: it is reported
   * back so the caller can raise a duplicate-company review.
   */
  async addIdentityKeys(companyId: string, keys: string[]): Promise<Array<{ key: string; heldBy: string }>> {
    const clashes: Array<{ key: string; heldBy: string }> = [];
    const current = await this.get(companyId);
    for (const key of keys) {
      if (current.identityKeys.includes(key)) continue;
      try {
        await this.col.updateOne({ _id: companyId }, { $addToSet: { identityKeys: key } });
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        const holder = await this.col.findOne(
          { identityKeys: key, status: 'active' },
          { projection: { _id: 1 } },
        );
        if (holder && holder._id !== companyId) clashes.push({ key, heldBy: holder._id });
      }
    }
    return clashes;
  }

  // --- Merge ----------------------------------------------------------------------------------

  /**
   * Merge `fromId` into `intoId`: identity keys, observations, jobs and sources move to the
   * survivor; the merged company remains as a tombstone pointing at it. Audited with enough
   * detail to reverse manually. With `session` the merge (and its audit event) joins the
   * caller's transaction instead of running its own.
   */
  async merge(
    intoId: string,
    fromId: string,
    actor: Actor,
    reason: string,
    reviewItemId?: string,
    opts: { session?: ClientSession } = {},
  ): Promise<void> {
    if (intoId === fromId) throw new InvalidStateError('Cannot merge a company into itself');
    const into = await this.resolveActive(intoId);
    const from = await this.get(fromId);
    if (from.status === 'merged') {
      if (from.mergedInto === into._id) return; // replay of the same merge
      throw new InvalidStateError(`Company ${fromId} is already merged`);
    }
    const movedKeys = from.identityKeys;
    const now = this.ctx.clock.now();
    const body = async (session: ClientSession) => {
      // Guarded on `active`: of two concurrent merges of the same company only one applies.
      const claimed = await this.col.updateOne(
        { _id: from._id, status: 'active' },
        {
          $set: { status: 'merged', mergedInto: into._id, identityKeys: [], updatedAt: now },
          $inc: { rev: 1 },
        },
        { session },
      );
      if (claimed.modifiedCount === 0) return null;
      await this.col.updateOne(
        { _id: into._id },
        {
          $addToSet: { identityKeys: { $each: movedKeys } },
          // The absorbed company's accumulated names become aliases of the survivor (the
          // reconciler de-duplicates by strict key).
          $push: {
            'identity.aliases': {
              $each: [
                ...from.identity.aliases,
                {
                  name: from.identity.displayName.value ?? from.identity.normalizedName,
                  strictKey: from.identity.normalizedName,
                  sourceIds: [],
                },
              ],
            },
          },
          $set: { updatedAt: now },
          // The survivor's evidence and aliases changed: a reconciliation computed before the
          // merge must not commit over it (it re-reads and recomputes).
          $inc: { rev: 1 },
        },
        { session },
      );
      const obs = await getCollection(this.ctx.db, companyObservationsCollection).updateMany(
        { 'resolution.entityId': from._id },
        { $set: { 'resolution.entityId': into._id, 'resolution.method': 'merge', updatedAt: now } },
        { session },
      );
      const jobs = await this.ctx.db
        .collection('market_jobs')
        .updateMany({ companyId: from._id }, { $set: { companyId: into._id, updatedAt: now } }, { session });
      const sources = await getCollection(this.ctx.db, sourcesCollection).updateMany(
        { companyId: from._id },
        { $set: { companyId: into._id, updatedAt: now } },
        { session },
      );
      return { observations: obs.modifiedCount, jobs: jobs.modifiedCount, sources: sources.modifiedCount };
    };
    const moved = opts.session ? await body(opts.session) : await withTransaction(this.ctx.db.client, body);
    if (!moved) {
      // Merged concurrently: fine if into the same survivor, an error otherwise.
      const current = opts.session
        ? await this.col.findOne({ _id: fromId }, { session: opts.session })
        : await this.get(fromId);
      if (current?.mergedInto === into._id) return;
      throw new InvalidStateError(`Company ${fromId} was merged into ${current?.mergedInto} concurrently`);
    }
    await this.audit.record(
      {
        actor,
        action: 'company.merged',
        entity: { kind: 'company', id: into._id },
        reviewItemId,
        details: { mergedCompanyId: from._id, movedIdentityKeys: movedKeys, moved, reason },
      },
      opts,
    );
  }

  async markDistinct(
    aId: string,
    bId: string,
    actor: Actor,
    reviewItemId?: string,
    opts: { session?: ClientSession } = {},
  ): Promise<void> {
    const s = opts.session ? { session: opts.session } : {};
    await this.col.updateOne({ _id: aId }, { $addToSet: { 'identity.distinctFrom': bId } }, s);
    await this.col.updateOne({ _id: bId }, { $addToSet: { 'identity.distinctFrom': aId } }, s);
    await this.audit.record(
      {
        actor,
        action: 'company.marked_distinct',
        entity: { kind: 'company', id: aId },
        reviewItemId,
        details: { otherCompanyId: bId },
      },
      opts,
    );
  }

  // --- Read models ------------------------------------------------------------------------------

  async list(q: {
    q?: string;
    sponsorCountry?: string;
    careersStatus?: string;
    hasConflicts?: boolean;
    limit: number;
    offset: number;
  }): Promise<Page<CompanyDoc>> {
    const filter: Filter<CompanyDoc> = { status: 'active' };
    if (q.q) filter['identity.normalizedName'] = { $regex: escapeRegex(strictNameKey(q.q)) };
    if (q.sponsorCountry) filter['employment.sponsorship.licenceCountries'] = q.sponsorCountry;
    if (q.careersStatus)
      filter['freshness.careersDiscoveryStatus'] =
        q.careersStatus as CompanyDoc['freshness']['careersDiscoveryStatus'];
    if (q.hasConflicts) filter['quality.conflictFields.0'] = { $exists: true };
    const [items, total] = await Promise.all([
      this.col.find(filter).sort({ 'identity.normalizedName': 1 }).skip(q.offset).limit(q.limit).toArray(),
      this.col.countDocuments(filter),
    ]);
    return { items, total, limit: q.limit, offset: q.offset };
  }
}
