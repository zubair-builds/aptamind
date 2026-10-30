import type { ClientSession, Filter, UpdateFilter } from 'mongodb';
import { z } from 'zod';
import {
  type Actor,
  AppError,
  type JsonObject,
  jsonObjectSchema,
  newId,
  NotFoundError,
  type Page,
} from '@aptamind/contracts';
import { getCollection, isDuplicateKeyError, validateDocument, withTransaction } from '@aptamind/db';
import { AUTHORITY_TIERS, type AuthorityTier } from '@aptamind/provenance';
import { isAuthoritativeForExistence } from '../jobs/lifecycle';
import { apiBaseOfListingUrl, getAdapter } from '../connectors';
import {
  ATS_PROVIDERS,
  type AtsProvider,
  isJobSourceProvider,
  isThirdPartyProvider,
  JOB_SOURCE_PROVIDERS,
  normalizeProviderKey,
  SOURCE_CATEGORIES,
} from '../contracts/common';
import type { MarketContext, RunLauncher, ScheduleSync } from '../context';
import type { AuditLog } from '../review/audit';
import {
  assertDirectoryAuthority,
  COMPANY_DIRECTORY_PROVIDER,
  COMPANY_DIRECTORY_WORKFLOW,
  DIRECTORY_DEFAULT_AUTHORITY,
  parseDirectoryConfig,
} from './providers/company-directory';
import {
  assertBoardFileAuthority,
  ATS_BOARD_DIRECTORY_PROVIDER,
  ATS_BOARD_DIRECTORY_WORKFLOW,
  BOARD_FILE_AUTHORITY,
  parseBoardDirectoryConfig,
} from './providers/ats-board-directory';
import { spreadCron } from './schedule-spread';
import { assertLaunchable, isUploadOnly } from './upload-only';
import {
  KEY_CASE_INSENSITIVE,
  SOURCE_SCHEMA_VERSION,
  type SourceDoc,
  sourceGovernanceSchema,
  type SourceRunOutcomeDoc,
  sourceRunOutcomesCollection,
  sourceNameKey,
  sourceNameTokens,
  sourcesCollection,
} from './source.schema';

export const createSourceInputSchema = z
  .object({
    key: z.string().min(2).max(200),
    name: z.string().min(1),
    category: z.enum(SOURCE_CATEGORIES),
    /** Trimmed and lower-cased; a `job_source` provider must be one of `JOB_SOURCE_PROVIDERS`. */
    provider: z.string().transform(normalizeProviderKey).pipe(z.string().min(1)),
    endpoint: z.object({ url: z.string().url().optional(), boardToken: z.string().optional() }).default({}),
    acquisition: z.object({
      workflowKey: z.string(),
      workflowVersion: z.number().int().positive().optional(),
      config: jsonObjectSchema.default({}),
      credentialRefs: z.array(z.object({ kind: z.literal('env'), name: z.string() })).default([]),
    }),
    companyId: z.string().optional(),
    schedule: z
      .object({
        cron: z.string().optional(),
        intervalMinutes: z.number().int().positive().optional(),
        timezone: z.string().default('UTC'),
      })
      .optional(),
    freshness: z.object({ policyClass: z.string(), maxAgeMinutes: z.number().int().positive() }),
    /** Required, except for providers with a default (company directory: `third_party`). */
    authority: z
      .object({
        tier: z.enum(AUTHORITY_TIERS),
        authoritativeFor: z.array(z.string()).default([]),
        listingIsComplete: z.boolean().default(false),
      })
      .optional(),
    governance: sourceGovernanceSchema.optional(),
    enabled: z.boolean().default(true),
    labels: z.record(z.string(), z.string()).default({}),
  })
  .superRefine((s, ctx) => {
    // PR #11 re-verify #7 LOW-1: job-source providers are a closed set.
    if (s.category === 'job_source' && !isJobSourceProvider(s.provider))
      ctx.addIssue({
        code: 'custom',
        path: ['provider'],
        message: `A job_source provider must be one of ${JOB_SOURCE_PROVIDERS.join(', ')}`,
      });
  });
export type CreateSourceInput = z.input<typeof createSourceInputSchema>;

export const updateSourceInputSchema = z.object({
  name: z.string().min(1).optional(),
  endpoint: z.object({ url: z.string().url().optional(), boardToken: z.string().optional() }).optional(),
  acquisition: z
    .object({
      config: jsonObjectSchema.optional(),
      workflowVersion: z.number().int().positive().nullable().optional(),
    })
    .optional(),
  schedule: z
    .object({
      cron: z.string().optional(),
      intervalMinutes: z.number().int().positive().optional(),
      timezone: z.string().default('UTC'),
    })
    .nullable()
    .optional(),
  freshness: z.object({ policyClass: z.string(), maxAgeMinutes: z.number().int().positive() }).optional(),
  governance: z.record(z.string(), z.unknown()).optional(),
  labels: z.record(z.string(), z.string()).optional(),
});

/**
 * Source management: registration (idempotent on `key`), configuration, enable/disable,
 * schedule synchronisation with the workflow runtime, manual runs and health bookkeeping.
 */
export class SourceService {
  /** Called after a standing change (the domain enqueues a recompute of the source's jobs). */
  onStandingChanged?: (source: SourceDoc, at: Date, actor: Actor) => Promise<void>;

  constructor(
    private readonly ctx: MarketContext,
    private readonly audit: AuditLog,
    private readonly launcher?: RunLauncher,
    private readonly schedules?: ScheduleSync,
  ) {}

  get col() {
    return getCollection(this.ctx.db, sourcesCollection);
  }

  async get(id: string): Promise<SourceDoc> {
    const s = await this.col.findOne({ _id: id });
    if (!s) throw new NotFoundError('Source', id);
    return s;
  }

  getByKey(key: string) {
    return this.col.findOne({ key });
  }

  /** Exact key first, then a case-insensitive match (board tokens differ only in case). */
  async getByKeyIgnoringCase(key: string): Promise<SourceDoc | null> {
    return (
      (await this.col.findOne({ key })) ??
      (await this.col.findOne({ key }, { collation: KEY_CASE_INSENSITIVE }))
    );
  }

  async list(q: {
    category?: string;
    health?: string;
    companyId?: string;
    q?: string;
    limit: number;
    offset: number;
  }): Promise<Page<SourceDoc>> {
    const filter: Filter<SourceDoc> = {};
    if (q.category) filter.category = q.category as SourceDoc['category'];
    if (q.health) filter['health.status'] = q.health as SourceDoc['health']['status'];
    if (q.companyId) filter.companyId = q.companyId;
    if (q.q)
      filter.$or = [
        { name: { $regex: escapeRegex(q.q), $options: 'i' } },
        { key: { $regex: escapeRegex(q.q), $options: 'i' } },
      ];
    const [items, total] = await Promise.all([
      this.col.find(filter).sort({ category: 1, name: 1 }).skip(q.offset).limit(q.limit).toArray(),
      this.col.countDocuments(filter),
    ]);
    return { items, total, limit: q.limit, offset: q.offset };
  }

  /** Idempotent on `key`: returns the existing source when already registered. */
  async register(input: CreateSourceInput, actor: Actor): Promise<{ source: SourceDoc; created: boolean }> {
    const parsed = createSourceInputSchema.parse(input);
    let authority = parsed.authority;
    if (parsed.provider === COMPANY_DIRECTORY_PROVIDER) {
      // Store the parsed (strict, defaults applied) column map, never the raw input.
      parsed.acquisition.config = parseDirectoryConfig(parsed.acquisition.config) as never;
      if (parsed.acquisition.workflowKey !== COMPANY_DIRECTORY_WORKFLOW)
        throw new AppError(
          'validation_failed',
          `A company directory source runs ${COMPANY_DIRECTORY_WORKFLOW} only (not ${parsed.acquisition.workflowKey})`,
          { param: 'acquisition.workflowKey' },
        );
      authority ??= { tier: DIRECTORY_DEFAULT_AUTHORITY, authoritativeFor: [], listingIsComplete: false };
      assertDirectoryAuthority(authority.tier);
      assertUploadOnly(parsed);
    }
    if (parsed.provider === ATS_BOARD_DIRECTORY_PROVIDER) {
      parsed.acquisition.config = parseBoardDirectoryConfig(parsed.acquisition.config) as never;
      if (parsed.acquisition.workflowKey !== ATS_BOARD_DIRECTORY_WORKFLOW)
        throw new AppError(
          'validation_failed',
          `An ATS board file source runs ${ATS_BOARD_DIRECTORY_WORKFLOW} only (not ${parsed.acquisition.workflowKey})`,
          { param: 'acquisition.workflowKey' },
        );
      // A board list names companies and boards; it is never official evidence (OPS-1b repair).
      authority ??= { tier: BOARD_FILE_AUTHORITY, authoritativeFor: [], listingIsComplete: false };
      assertBoardFileAuthority(authority.tier);
      assertUploadOnly(parsed, 'ATS board file');
    }
    if (!authority)
      throw new AppError('validation_failed', 'authority.tier is required for this provider', {
        param: 'authority',
      });
    assertTierFitsProvider(parsed.provider, authority.tier);
    // Keys that differ only in case are one source (a board key from before keys were lowercased).
    const existing = await this.getByKeyIgnoringCase(parsed.key);
    if (existing) return { source: existing, created: false };
    const now = this.ctx.clock.now();
    const id = newId('src');
    const doc = validateDocument(sourcesCollection, {
      _id: id,
      key: parsed.key,
      name: parsed.name,
      nameTokens: sourceNameTokens(parsed.name),
      nameKey: sourceNameKey(parsed.name),
      category: parsed.category,
      provider: parsed.provider,
      endpoint: withListingUrl(parsed.provider, parsed.endpoint),
      acquisition: parsed.acquisition,
      companyId: parsed.companyId,
      schedule: spreadSchedule(id, parsed.category, parsed.provider, parsed.schedule),
      freshness: parsed.freshness,
      authority,
      governance: parsed.governance ?? { accessMethod: 'public_web' },
      enabled: parsed.enabled,
      health: { status: 'never_run', consecutiveFailures: 0 },
      stats: { attempts: 0, successes: 0, failures: 0 },
      labels: parsed.labels,
      schemaVersion: SOURCE_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    });
    try {
      await this.col.insertOne(doc);
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        const winner = await this.getByKeyIgnoringCase(parsed.key);
        if (winner) return { source: winner, created: false };
      }
      throw err;
    }
    await this.audit.record({
      actor,
      action: 'source.registered',
      entity: { kind: 'source', id: doc._id },
      details: { key: doc.key },
    });
    await this.syncSchedule(doc);
    return { source: doc, created: true };
  }

  /**
   * Change the owner company of a source only while it is still `expected` (null: no owner), so
   * two writers can never both win (OPS-1b). `companyId` null releases the source. The change and
   * its audit event commit together. Returns false when the owner changed meanwhile.
   */
  async setOwnerIf(
    id: string,
    expected: string | null,
    companyId: string | null,
    actor: Actor,
    reason: string,
  ): Promise<boolean> {
    const now = this.ctx.clock.now();
    // `companyId: null` matches a source with no owner field.
    const filter = { _id: id, companyId: expected } as Filter<SourceDoc>;
    return withTransaction(this.ctx.db.client, async (session) => {
      const r = await this.col.updateOne(
        filter,
        companyId
          ? { $set: { companyId, updatedAt: now } }
          : { $unset: { companyId: '' }, $set: { updatedAt: now } },
        { session },
      );
      if (r.matchedCount === 0) return false;
      if (r.modifiedCount > 0)
        await this.audit.record(
          {
            actor,
            action: 'source.owner_changed',
            entity: { kind: 'source', id },
            details: { from: expected, to: companyId, reason },
          },
          { session },
        );
      return true;
    });
  }

  async update(id: string, patch: z.input<typeof updateSourceInputSchema>, actor: Actor): Promise<SourceDoc> {
    const p = updateSourceInputSchema.parse(patch);
    const current = await this.get(id);
    if (current.provider === COMPANY_DIRECTORY_PROVIDER) assertUploadOnly(p);
    if (current.provider === ATS_BOARD_DIRECTORY_PROVIDER) assertUploadOnly(p, 'ATS board file');
    // Authority is not patchable; a board file's never becomes official (OPS-1b repair M1).
    const tier = (patch as { authority?: { tier?: unknown } }).authority?.tier;
    if (current.provider === ATS_BOARD_DIRECTORY_PROVIDER && tier !== undefined)
      assertBoardFileAuthority(String(tier));
    const now = this.ctx.clock.now();
    const $set: Record<string, unknown> = { updatedAt: now };
    const $unset: Record<string, ''> = {};
    if (p.name) {
      $set.name = p.name;
      $set.nameTokens = sourceNameTokens(p.name);
      $set.nameKey = sourceNameKey(p.name);
    }
    if (p.endpoint) {
      const endpoint = withListingUrl(current.provider, p.endpoint, current.endpoint);
      $set.endpoint = endpoint;
      const changed =
        (endpoint?.url ?? null) !== (current.endpoint.url ?? null) ||
        (endpoint?.boardToken ?? null) !== (current.endpoint.boardToken ?? null);
      // The shrink baseline was measured on the old endpoint: keep it (it still guards against a
      // wrong endpoint) but flag it, so a held listing says why (`authority.listingIsComplete`
      // is not patchable, so the endpoint is the only listing-shaping field here).
      if (changed && current.health.listingBaseline) $set['health.listingBaseline.endpointChangedAt'] = now;
      // A copy's board is known only for listings fetched after this (MEDIUM-2).
      if (changed) $set.endpointChangedAt = now;
    }
    if (p.acquisition?.config) {
      $set['acquisition.config'] =
        current.provider === COMPANY_DIRECTORY_PROVIDER
          ? parseDirectoryConfig(p.acquisition.config)
          : current.provider === ATS_BOARD_DIRECTORY_PROVIDER
            ? parseBoardDirectoryConfig(p.acquisition.config)
            : p.acquisition.config;
    }
    if (p.acquisition?.workflowVersion === null) $unset['acquisition.workflowVersion'] = '';
    else if (p.acquisition?.workflowVersion)
      $set['acquisition.workflowVersion'] = p.acquisition.workflowVersion;
    if (p.schedule === null) $unset.schedule = '';
    else if (p.schedule) $set.schedule = spreadSchedule(id, current.category, current.provider, p.schedule);
    if (p.freshness) $set.freshness = p.freshness;
    if (p.governance) $set.governance = { ...current.governance, ...p.governance };
    if (p.labels) $set.labels = p.labels;
    // Validate the would-be document before writing so an invalid patch never persists.
    const candidate: Record<string, unknown> = structuredClone(current) as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries($set)) setDotted(candidate, k, v);
    for (const k of Object.keys($unset)) setDotted(candidate, k, undefined);
    validateDocument(sourcesCollection, candidate);
    await this.col.updateOne({ _id: id }, { $set, ...(Object.keys($unset).length ? { $unset } : {}) });
    const updated = await this.get(id);
    await this.audit.record({
      actor,
      action: 'source.updated',
      entity: { kind: 'source', id },
      details: { patch: JSON.parse(JSON.stringify(p)) as JsonObject },
    });
    await this.syncSchedule(updated);
    return updated;
  }

  /**
   * Job sources whose STORED provider is outside the closed job-source set (registered before the
   * set was enforced, e.g. `Aggregator`, `adzuna-feed`; PR #11 re-verify #7 LOW-1). They are not
   * migrated — the provider is read as stored — but their copies are never authoritative
   * (`authoritativeTierOf`). Reported at start-up (`MarketDomain.ensureReady`) so an operator can
   * re-register them under a supported provider.
   */
  async unrecognisedJobSourceProviders(): Promise<Array<Pick<SourceDoc, '_id' | 'key' | 'provider'>>> {
    return this.col
      .find(
        { category: 'job_source', provider: { $nin: [...JOB_SOURCE_PROVIDERS] } },
        { projection: { _id: 1, key: 1, provider: 1 } },
      )
      .limit(1000)
      .toArray();
  }

  /**
   * Enable or disable a source. A change appends to `standingHistory` in the same write (seeded,
   * the first time, with the state before it since the source's creation), so the jobs' derived
   * lifecycles evaluate the source's standing as of each piece of evidence (DECISION_LOG
   * 15c965b): a disable never rewrites the past. A change then enqueues a bounded, paged
   * recompute of the source's jobs (`onStandingChanged`) so time-based decay is applied.
   * Idempotent: setting the current value records nothing, and enqueues nothing unless the last
   * change's recompute is still pending (`standingRecompute`, DECISION_LOG 9b0cb03): then it
   * re-enqueues that same run (keyed by the change).
   */
  async setEnabled(id: string, enabled: boolean, actor: Actor): Promise<SourceDoc> {
    const now = this.ctx.clock.now();
    // One atomic write: the flag, its history entry and the pending recompute marker. The entry's
    // time is strictly after the previous entry's (a clock step back never reorders the history,
    // and every change keeps its own recompute key).
    await this.col.updateOne({ _id: id, enabled: { $ne: enabled } }, [
      {
        $set: {
          standingHistory: {
            $let: {
              vars: { h: { $ifNull: ['$standingHistory', [{ at: '$createdAt', enabled: '$enabled' }]] } },
              in: {
                $concatArrays: [
                  '$$h',
                  [{ at: { $max: [now, { $add: [{ $arrayElemAt: ['$$h.at', -1] }, 1] }] }, enabled }],
                ],
              },
            },
          },
          enabled,
          updatedAt: now,
        },
      },
      {
        $set: {
          standingRecompute: { pendingAt: { $arrayElemAt: ['$standingHistory.at', -1] }, cursor: null },
        },
      },
    ]);
    const s = await this.get(id);
    await this.audit.record({
      actor,
      action: enabled ? 'source.enabled' : 'source.disabled',
      entity: { kind: 'source', id },
    });
    await this.syncSchedule(s);
    // A change — or a retry of one whose recompute is still pending (a crash after the write) —
    // enqueues the recompute of the source's jobs, keyed by the change.
    const pending = s.standingRecompute?.pendingAt;
    if (pending && this.onStandingChanged) await this.onStandingChanged(s, pending, actor);
    return s;
  }

  /**
   * One-off OPS-2 migration: give every ATS board with an interval schedule its spread cron.
   * The scheduler is updated before the source document, so a crash in between only repeats the
   * same upsert on the next start. The upsert computes the next fire from now, so a fire that was
   * due when it runs moves to the next cron slot, at most one interval away, once per source (an
   * accepted trade-off: the scheduler port cannot keep a due fire). Each source is re-read first,
   * and an operator's enable or disable that lands during the upsert wins (it is synced again).
   * Runs only where schedules are wired.
   */
  async spreadAtsSchedules(): Promise<number> {
    if (!this.schedules) return 0;
    const pending = await this.col
      .find({
        category: 'job_source',
        provider: { $in: [...ATS_PROVIDERS] },
        'schedule.intervalMinutes': { $exists: true },
        'schedule.cron': { $exists: false },
      })
      .limit(10_000)
      .toArray();
    let migrated = 0;
    for (const { _id } of pending) {
      const s = await this.col.findOne({ _id, 'schedule.cron': { $exists: false } });
      const schedule = s && spreadSchedule(s._id, s.category, s.provider, s.schedule);
      if (!s || !schedule?.cron) continue;
      await this.syncSchedule({ ...s, schedule });
      const enabled = (await this.col.findOne({ _id }, { projection: { enabled: 1 } }))?.enabled;
      if (enabled !== undefined && enabled !== s.enabled)
        await this.syncSchedule({ ...(await this.get(_id)), schedule });
      const res = await this.col.updateOne(
        {
          _id: s._id,
          'schedule.cron': { $exists: false },
          'schedule.intervalMinutes': s.schedule?.intervalMinutes,
        },
        { $set: { 'schedule.cron': schedule.cron, updatedAt: this.ctx.clock.now() } },
      );
      migrated += res.modifiedCount;
    }
    return migrated;
  }

  /** Mirror the source schedule into the runtime scheduler (owner = this source). */
  async syncSchedule(s: SourceDoc): Promise<void> {
    if (!this.schedules) return;
    // An upload-only source has no schedule at all (not even a disabled placeholder): nothing is
    // ever fetched for it. Upload-only sources never had a schedule on main and a source's provider
    // cannot change, so there is nothing to remove either.
    if (isUploadOnly(s.provider)) return;
    const hasSchedule = !!(s.schedule?.cron || s.schedule?.intervalMinutes);
    if (!hasSchedule) {
      // Keep a disabled placeholder so stale schedules never fire.
      await this.schedules.upsert({
        workflowKey: s.acquisition.workflowKey,
        intervalMinutes: 24 * 60,
        enabled: false,
        input: this.runInput(s),
        labels: { sourceId: s._id },
        owner: { kind: 'source', id: s._id },
      });
      return;
    }
    await this.schedules.upsert({
      workflowKey: s.acquisition.workflowKey,
      workflowVersion: s.acquisition.workflowVersion,
      cron: s.schedule?.cron,
      intervalMinutes: s.schedule?.cron ? undefined : s.schedule?.intervalMinutes,
      timezone: s.schedule?.timezone,
      input: this.runInput(s),
      labels: { sourceId: s._id },
      enabled: s.enabled,
      owner: { kind: 'source', id: s._id },
    });
  }

  runInput(s: SourceDoc): Record<string, unknown> {
    return { ...s.acquisition.config, sourceId: s._id };
  }

  /** The byte ceiling of an upload to this source, or null when its provider has none. */
  async uploadLimit(id: string): Promise<number | null> {
    const source = await this.get(id);
    if (source.provider === COMPANY_DIRECTORY_PROVIDER)
      return parseDirectoryConfig(source.acquisition.config).maxBytes;
    if (source.provider === ATS_BOARD_DIRECTORY_PROVIDER)
      return parseBoardDirectoryConfig(source.acquisition.config).maxBytes;
    return null;
  }

  /**
   * Whether a run of `workflowKey` with `input` may start for the source named in `input.sourceId`
   * (upload-only providers: their pinned workflow, with a snapshotId). For run routes that take a
   * workflow key from the caller; `runNow` applies the same check.
   */
  async assertWorkflowRunAllowed(workflowKey: string, input: Record<string, unknown>): Promise<void> {
    if (typeof input.sourceId !== 'string') return;
    const source = await this.col.findOne({ _id: input.sourceId }, { projection: { key: 1, provider: 1 } });
    if (source) assertLaunchable(source, workflowKey, input);
  }

  async runNow(
    id: string,
    actor: Actor,
    extraInput: Record<string, unknown> = {},
    opts: { idempotencyKey?: string } = {},
  ): Promise<{ runId: string }> {
    if (!this.launcher) throw new AppError('unavailable', 'Run launcher not configured in this process');
    const s = await this.get(id);
    if (!s.enabled) throw new AppError('invalid_state', `Source ${s.key} is disabled`);
    // Upload-only sources run only their pinned workflow, on an uploaded snapshot (400 otherwise).
    assertLaunchable(s, s.acquisition.workflowKey, extraInput);
    // With an idempotency key (e.g. a review decision), a replay returns the same run.
    const run = await this.launcher.startRun({
      workflowKey: s.acquisition.workflowKey,
      version: s.acquisition.workflowVersion,
      input: { ...this.runInput(s), ...extraInput },
      labels: { sourceId: s._id },
      trigger: { kind: 'manual', actor: { kind: actor.kind, id: actor.id } },
      idempotencyKey: opts.idempotencyKey,
    });
    await this.audit.record({
      actor,
      action: 'source.run_requested',
      entity: { kind: 'source', id },
      runId: run._id,
      idempotencyKey: opts.idempotencyKey,
      details: opts.idempotencyKey ? { runId: run._id } : undefined,
    });
    return { runId: run._id };
  }

  // --- health bookkeeping (called by acquisition capabilities) -------------------------

  /**
   * Apply a counter update at most once per (source, run, outcome): the marker insert and the
   * increment commit together, so a replayed step (same run) changes nothing. Without a run id
   * the update applies every call. `guarded` is applied in the same commit, only when the source
   * also matches its filter (e.g. this outcome's fetch is still the latest one).
   */
  private async countOnce(
    id: string,
    runId: string | undefined,
    kind: SourceRunOutcomeDoc['kind'],
    update: UpdateFilter<SourceDoc>,
    guarded?: { filter: Record<string, unknown>; update: UpdateFilter<SourceDoc> },
  ): Promise<boolean> {
    const apply = async (session?: ClientSession) => {
      await this.col.updateOne({ _id: id }, update, { session });
      if (guarded) await this.col.updateOne({ _id: id, ...guarded.filter }, guarded.update, { session });
    };
    if (!runId) {
      await apply();
      return true;
    }
    const now = this.ctx.clock.now();
    try {
      await withTransaction(this.ctx.db.client, async (session) => {
        await getCollection(this.ctx.db, sourceRunOutcomesCollection).insertOne(
          {
            _id: `${id}:${runId}:${kind}`,
            sourceId: id,
            runId,
            kind,
            at: now,
            schemaVersion: SOURCE_SCHEMA_VERSION,
            createdAt: now,
          },
          { session },
        );
        await apply(session);
      });
      return true;
    } catch (err) {
      if (isDuplicateKeyError(err)) return false; // this run's outcome is already counted
      throw err;
    }
  }

  async recordAttempt(id: string, runId?: string): Promise<void> {
    const now = this.ctx.clock.now();
    await this.col.updateOne(
      { _id: id },
      { $set: { 'health.lastAttemptAt': now, 'health.lastRunId': runId, updatedAt: now } },
    );
    await this.countOnce(id, runId, 'attempt', { $inc: { 'stats.attempts': 1 } });
  }

  /**
   * A successful run. With `fetchAt` (a listing fetch or crawl), health changes only while that
   * fetch is still the source's latest (`health.latestFetch.at`, DECISION_LOG 9b0cb03 L-4): an
   * older run finishing after a newer failure never reports the source healthy. Run statistics
   * always count (once per run).
   */
  async recordSuccess(
    id: string,
    info: {
      snapshotId?: string;
      itemCount?: number;
      completeImportStartedAt?: Date;
      runId?: string;
      fetchAt?: Date;
    } = {},
  ): Promise<void> {
    const now = this.ctx.clock.now();
    const $set: Record<string, unknown> = {
      'health.status': 'healthy',
      'health.consecutiveFailures': 0,
      'health.lastSuccessAt': now,
      updatedAt: now,
    };
    if (info.snapshotId) $set['health.lastSnapshotId'] = info.snapshotId;
    if (info.itemCount !== undefined) $set['health.lastItemCount'] = info.itemCount;
    await this.col.updateOne(
      { _id: id, ...latestFetchIs(info.fetchAt) },
      {
        $set,
        // Source-chronology marker: only ever moves forward.
        ...(info.completeImportStartedAt
          ? { $max: { 'health.lastCompleteImportStartedAt': info.completeImportStartedAt } }
          : {}),
        $unset: { 'health.lastError': '' },
      },
    );
    await this.countOnce(id, info.runId, 'success', { $inc: { 'stats.successes': 1 } });
  }

  /**
   * A history register's period (fiscal year) was imported completely (M11.5): move the period's
   * replacement marker by compare-and-set on the marker the import's parse step read
   * (`expected`; null = there was none) — delta review B-M1. Source chronology: a snapshot older
   * than the marker never moves it (`older`). `moved`: another import changed the marker since
   * the parse step read it, so this import applies nothing for the period.
   */
  async casHistoryPeriod(
    id: string,
    next: { period: number; completeAt: Date; rowCount: number; snapshotId: string; parser: string },
    expected: { snapshotId: string; completeAt: Date } | null,
  ): Promise<'applied' | 'moved' | 'older'> {
    if (!expected) {
      const pushed = await this.col.updateOne(
        { _id: id, 'health.historyPeriods.period': { $ne: next.period } } as Filter<SourceDoc>,
        { $push: { 'health.historyPeriods': next } } as UpdateFilter<SourceDoc>,
      );
      return pushed.matchedCount ? 'applied' : 'moved';
    }
    if (next.completeAt < expected.completeAt) return 'older';
    const set = await this.col.updateOne(
      {
        _id: id,
        'health.historyPeriods': {
          $elemMatch: {
            period: next.period,
            snapshotId: expected.snapshotId,
            completeAt: expected.completeAt,
          },
        },
      } as Filter<SourceDoc>,
      { $set: { 'health.historyPeriods.$': next } } as UpdateFilter<SourceDoc>,
    );
    return set.matchedCount ? 'applied' : 'moved';
  }

  /**
   * A job listing's absences were applied: it becomes the shrink-guard baseline (source
   * chronology, only moves forward) and any hold is cleared; then the applied watermark moves.
   * The baseline is written BEFORE the watermark: a crash in between replays into a full
   * (per-job idempotent) re-application, never into "already applied" with a stale baseline.
   */
  async recordListingApplied(
    id: string,
    listing: { count: number; snapshotId: string; fetchedAt: Date },
  ): Promise<void> {
    const at = listing.fetchedAt;
    await this.col.updateOne(
      {
        _id: id,
        $or: [{ 'health.listingBaseline': { $exists: false } }, { 'health.listingBaseline.at': { $lt: at } }],
      },
      {
        $set: { 'health.listingBaseline': { count: listing.count, snapshotId: listing.snapshotId, at } },
        $unset: { 'health.listingHeld': '' },
      },
    );
    await this.col.updateOne({ _id: id }, { $max: { 'health.lastListingAppliedAt': at } });
  }

  /**
   * The listing guard held a job listing (not a failure): mark the hold, keeping the episode's
   * start (`since`, earliest) and its latest held listing (`lastAt`, latest). Replaying a held
   * listing rewrites the same marker.
   */
  async recordListingHeld(
    id: string,
    hold: {
      reason: 'shrink' | 'small_board_empty';
      count: number;
      baseline: number;
      reviewId?: string;
      fetchedAt: Date;
    },
  ): Promise<void> {
    const current = (await this.col.findOne({ _id: id }, { projection: { 'health.listingHeld': 1 } }))?.health
      ?.listingHeld;
    const at = hold.fetchedAt;
    const since = current?.since && current.since < at ? current.since : at;
    const lastAt = current?.lastAt && current.lastAt > at ? current.lastAt : at;
    await this.col.updateOne(
      { _id: id },
      {
        $set: {
          'health.listingHeld': {
            reason: hold.reason,
            since,
            lastAt,
            count: hold.count,
            baseline: hold.baseline,
            ...(hold.reviewId ? { reviewId: hold.reviewId } : {}),
          },
        },
      },
    );
  }

  /**
   * The latest real acquisition of the source's listing (a fetch or an upload): moves forward
   * only, so an older result arriving late never hides a newer failure. Reprocessing never calls
   * this (LOW-D). Returns false when a newer fetch outcome is already recorded (nothing changed).
   *
   * The failure streak (`health.consecutiveFailures`) is kept here, under the same only-newer
   * guard (re-verify #12 LOW-3): a newer successful fetch resets it, a newer failed one adds one
   * (a run counts once, however often it is retried and whatever ran in between: the streak's
   * run ids are kept in `health.failedRuns`, the latest `FAILED_RUNS_KEPT`). So a success whose finalize runs late, after
   * newer failures, never leaves the streak counting from before it. Recording the same fetch
   * again (a replay, same `at`) changes nothing.
   */
  async recordFetch(id: string, at: Date, ok: boolean, runId?: string): Promise<boolean> {
    // A failed run counts once however often it is retried, whatever ran in between: the streak's
    // runs are kept (bounded, most recent last) and cleared by a success (re-verify final L3).
    const runs = { $ifNull: ['$health.failedRuns', []] };
    const res = await this.col.updateOne(
      {
        _id: id,
        $or: [{ 'health.latestFetch': { $exists: false } }, { 'health.latestFetch.at': { $lt: at } }],
      },
      [
        {
          $set: {
            'health.consecutiveFailures': ok
              ? 0
              : runId
                ? {
                    $cond: [
                      { $in: [{ $literal: runId }, runs] },
                      { $ifNull: ['$health.consecutiveFailures', 0] },
                      { $add: [{ $ifNull: ['$health.consecutiveFailures', 0] }, 1] },
                    ],
                  }
                : { $add: [{ $ifNull: ['$health.consecutiveFailures', 0] }, 1] },
            'health.failedRuns': ok
              ? { $literal: [] }
              : runId
                ? {
                    $slice: [
                      {
                        $concatArrays: [
                          { $filter: { input: runs, cond: { $ne: ['$$this', { $literal: runId }] } } },
                          [{ $literal: runId }],
                        ],
                      },
                      -FAILED_RUNS_KEPT,
                    ],
                  }
                : runs,
            'health.latestFetch': { $literal: { at, ok, ...(runId ? { runId } : {}) } },
          },
        },
        // A successful fetch ends any backoff and 404 streak (OPS-2).
        ...(ok ? [{ $unset: ['health.backoffUntil', 'health.notFoundRuns'] }] : []),
      ],
    );
    if (res.matchedCount > 0) return true;
    // The same fetch recorded before (a replay): it is still the latest one.
    return !!(await this.col.findOne({ _id: id, 'health.latestFetch.at': at }, { projection: { _id: 1 } }));
  }

  /**
   * After a run's final failed fetch (OPS-2): defer scheduled runs until `until` and keep the 404
   * streak, only while that fetch is still the latest. A 404 adds the run to the streak once,
   * keeping the last `keep` runs; any other failure clears it. Returns the streak and, when this
   * run was newly added, its position in the streak (`reached`, else 0).
   */
  async recordFetchFailure(
    id: string,
    failure: { fetchAt: Date; until: Date; notFound: boolean; runId?: string; keep: number },
  ): Promise<{ runs: string[]; reached: number }> {
    const runId = failure.notFound ? failure.runId : undefined;
    const runs = { $ifNull: ['$health.notFoundRuns', []] };
    const before = await this.col.findOneAndUpdate(
      { _id: id, ...latestFetchIs(failure.fetchAt) },
      [
        {
          $set: {
            'health.backoffUntil': { $max: ['$health.backoffUntil', failure.until] },
            ...(runId
              ? {
                  'health.notFoundRuns': {
                    $cond: [
                      { $in: [runId, runs] },
                      runs,
                      { $slice: [{ $concatArrays: [runs, [runId]] }, -failure.keep] },
                    ],
                  },
                }
              : {}),
          },
        },
        ...(runId ? [] : [{ $unset: 'health.notFoundRuns' }]),
      ],
      { returnDocument: 'before', projection: { 'health.notFoundRuns': 1 } },
    );
    if (!before || !runId) return { runs: [], reached: 0 };
    const prior = before.health?.notFoundRuns ?? [];
    if (prior.includes(runId)) return { runs: prior, reached: 0 };
    return { runs: [...prior, runId].slice(-failure.keep), reached: prior.length + 1 };
  }

  /**
   * Write (or clear, with null) the listing stamp of the fetch at `fetchAt`, only while that
   * fetch is still the latest: an older run finishing late never stamps over a newer listing.
   */
  async recordListingStamp(
    id: string,
    fetchAt: Date,
    stamp: NonNullable<SourceDoc['health']['listingStamp']> | null,
  ): Promise<void> {
    await this.col.updateOne(
      { _id: id, ...latestFetchIs(fetchAt) },
      stamp ? { $set: { 'health.listingStamp': stamp } } : { $unset: { 'health.listingStamp': '' } },
    );
  }

  /**
   * A failed run. With `fetchAt` (the failed fetch's `recordFetch` time), health changes only
   * while that fetch is still the source's latest (L-4), as for `recordSuccess`.
   */
  async recordFailure(id: string, error: string, runId?: string, fetchAt?: Date): Promise<void> {
    const now = this.ctx.clock.now();
    const latest = latestFetchIs(fetchAt);
    await this.col.updateOne(
      { _id: id, ...latest },
      { $set: { 'health.lastFailureAt': now, 'health.lastError': error.slice(0, 1000), updatedAt: now } },
    );
    // A failed logical run counts once, however many times its failing step is replayed. With a
    // fetch, its failure streak is kept by `recordFetch` (LOW-3); without one (an import run), here.
    await this.countOnce(
      id,
      runId,
      'failure',
      { $inc: { 'stats.failures': 1 } },
      fetchAt ? undefined : { filter: {}, update: { $inc: { 'health.consecutiveFailures': 1 } } },
    );
    const s = await this.col.findOne({ _id: id, ...latest });
    if (s && s.health.consecutiveFailures > 0) {
      const status = s.health.consecutiveFailures >= 3 ? 'failing' : 'degraded';
      await this.col.updateOne({ _id: id, ...latest }, { $set: { 'health.status': status } });
    }
  }
}

/**
 * Company directory sources are upload-only: every file passes the pre-storage checks (size,
 * rows, company-only columns) in `uploadSnapshot`. A fetch URL or schedule would bypass them.
 */
function assertUploadOnly(
  input: { endpoint?: { url?: string } | null; schedule?: unknown },
  label = 'Company directory',
): void {
  if (input.endpoint?.url || input.schedule)
    throw new AppError(
      'validation_failed',
      `${label} sources are upload-only: they take no endpoint URL and no schedule`,
    );
}

/** Run ids of the current failure streak kept on the source (a longer streak is failing anyway). */
const FAILED_RUNS_KEPT = 20;

/** A filter: the source's latest fetch is the one at `fetchAt` (no filter without one). */
function latestFetchIs(fetchAt: Date | undefined): Record<string, unknown> {
  return fetchAt ? { 'health.latestFetch.at': fetchAt } : {};
}

/**
 * Providers that are third-party by nature (they republish other employers' postings,
 * `THIRD_PARTY_PROVIDERS`) can never carry an authoritative tier: their sightings would reset
 * absence runs and block closures (PR #11 re-verify #6 L-1). Operator, official ATS and official
 * site are the authoritative tiers.
 */
function assertTierFitsProvider(provider: string, tier: AuthorityTier): void {
  if (isThirdPartyProvider(provider) && isAuthoritativeForExistence(tier))
    throw new AppError(
      'validation_failed',
      `Provider ${provider} is third-party by nature; it cannot have authority tier ${tier}`,
    );
}

function setDotted(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let cur = target;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1] as string;
  if (value === undefined) delete cur[last];
  else cur[last] = value;
}

/**
 * A literal regex for `s`, bounded to its first 100 characters. Truncates **before** escaping, so
 * the cut can never split an escape (a pattern ending in a lone backslash is invalid: a 500).
 */
export function escapeRegex(s: string): string {
  return s.slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * ATS boards poll a provider shared by thousands of boards: an interval schedule becomes a cron
 * with the same interval and a stable per-source offset (OPS-2). The interval stays beside it
 * for the schedule view. Other sources, explicit crons and uneven intervals are unchanged.
 */
function spreadSchedule<T extends { cron?: string; intervalMinutes?: number } | undefined>(
  sourceId: string,
  category: string,
  provider: string,
  schedule: T,
): T {
  if (!schedule || schedule.cron || !schedule.intervalMinutes) return schedule;
  if (category !== 'job_source' || !(ATS_PROVIDERS as readonly string[]).includes(provider)) return schedule;
  const cron = spreadCron(sourceId, schedule.intervalMinutes);
  return cron ? { ...schedule, cron } : schedule;
}

/**
 * An ATS source always stores the listing URL it is fetched from (E1). Without an explicit URL
 * it is built on the API base the source already uses (`current`, a PATCH: a regional board keeps
 * its regional host — PR #11 LOW-1), else on the adapter's default host (a new source). A current
 * URL whose base cannot be recovered is refused: the host is never silently switched to the
 * default one.
 */
function withListingUrl<E extends { url?: string; boardToken?: string } | undefined>(
  provider: string,
  endpoint: E,
  current?: { url?: string; boardToken?: string },
): E {
  if (!endpoint || endpoint.url || !endpoint.boardToken) return endpoint;
  if (!(ATS_PROVIDERS as readonly string[]).includes(provider)) return endpoint;
  const adapter = getAdapter(provider as AtsProvider);
  if (!current?.url) return { ...endpoint, url: adapter.listingUrl(endpoint.boardToken) };
  const base = apiBaseOfListingUrl(current.url, current.boardToken ?? '', adapter);
  if (!base)
    throw new AppError(
      'validation_failed',
      `The source endpoint ${current.url} does not identify its ${provider} API host; send endpoint.url with the new board token`,
      { field: 'endpoint.url' },
    );
  return { ...endpoint, url: adapter.listingUrl(endpoint.boardToken, base) };
}
