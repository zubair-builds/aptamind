import { hostname } from 'node:os';
import { type AiGateway, createAiGateway } from '@aptamind/ai';
import { type AppConfig, loadConfig } from '@aptamind/config';
import { type Actor, type Clock, systemClock } from '@aptamind/contracts';
import type { Db } from 'mongodb';
import { connectMongo, type Migration, type MongoHandle, runMigrations } from '@aptamind/db';
import {
  createMarketDomain,
  ensureMarketCollections,
  MARKET,
  type MarketDomain,
  marketAiTasks,
  marketCapabilities,
  marketWorkflows,
  dropRetiredMarketIndexes,
  migrateCompanyNameKeysV2,
  migrateJobTitleTokens,
  migrateSourceNameKeys,
  migrateSourceNameTokens,
} from '@aptamind/market';
import { HostRateLimiter, RedisHostRateLimiter, SafeHttpClient, type HostLimiter } from '@aptamind/net';
import { createLogger, type Logger, metrics } from '@aptamind/observability';
import {
  backfillSubjectAcquisitionCount,
  createProfessionalDomain,
  DEFAULT_PROFESSIONAL_LIMITS,
  ensureProfessionalCollections,
  PROFESSIONAL,
  type ProfessionalDomain,
  professionalCapabilities,
  professionalWorkflows,
} from '@aptamind/professional';
import { QueueTransport } from '@aptamind/queue';
import { type ArtifactDoc, ArtifactStore, S3ObjectStorage } from '@aptamind/storage';
import {
  AI_GATEWAY,
  AI_TASKS,
  AiTaskRegistry,
  BROWSER,
  type BrowserService,
  genericCapabilities,
  NET_CLIENT,
  PlaywrightBrowserService,
  UnavailableBrowserService,
} from '@aptamind/workflow-nodes';
import { createWorkflowRuntime, ensureWorkflowCollections, type WorkflowRuntime } from '@aptamind/workflows';
import { ensureRunLabelIndexes, type RunLabelIndexSpec } from './run-label-indexes';

/**
 * Decides whether the generic artifact routes (`/api/artifacts/:id(/content)`) may serve an
 * artifact (FE-P6). Artifacts owned by a private domain are refused so their bytes are only
 * reachable through that domain's own, subject-checked routes. The generic routes consult this
 * guard and never import a domain; the composition root assembles it from the domains.
 */
export interface ArtifactAccessGuard {
  /** `true` when the artifact must not be served by generic routes (fails closed on error). */
  isRestricted(artifact: Pick<ArtifactDoc, '_id' | 'context'>): Promise<boolean>;
  /**
   * The artifact refs a generic run view (`GET /api/runs/:id`) may list for a run: none for a
   * private domain's workflow, otherwise those no private-domain document references (fails
   * closed on error). Refs carry size and sha256, so listing one is an existence oracle.
   */
  listableRunArtifacts<T extends { artifactId: string }>(
    run: { workflowKey: string },
    refs: readonly T[],
  ): Promise<T[]>;
}

/**
 * Composition root shared by Aptamind processes (api, worker, scripts). It wires generic
 * infrastructure, the workflow runtime, and the Market and Professional domains — the only
 * place where the domains and the generic runtime meet (domains never meet each other).
 */
export interface Platform {
  role: 'api' | 'worker' | 'script';
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  mongo: MongoHandle;
  transport: QueueTransport;
  storage: S3ObjectStorage;
  artifacts: ArtifactStore;
  http: SafeHttpClient;
  browser: BrowserService;
  ai: AiGateway;
  runtime: WorkflowRuntime;
  market: MarketDomain;
  professional: ProfessionalDomain;
  /** Generic artifact routes consult this before serving metadata or bytes (FE-P6). */
  artifactAccess: ArtifactAccessGuard;
  /**
   * The generic run routes consult this: a private domain's workflows (Professional) are started
   * (`POST /api/workflows/:key/runs`) and mutated (`POST /api/runs/:id/cancel`,
   * `POST /api/node-runs/:id/{retry,resume}`) only through that domain's services (P1.3 review
   * rulings); the routes refuse them exactly like unknown ids. Generic reads are not guarded here
   * (FE-P7).
   */
  workflowAccess: {
    startableGenerically(workflowKey: string): boolean;
    mutableGenerically(workflowKey: string): boolean;
  };
  workerId: string;
  init(): Promise<void>;
  checks(): Promise<Record<string, boolean>>;
  close(): Promise<void>;
}

/** Apps build raw S3 clients (dev scripts) through the same fail-closed settings (FE-3). */
export { s3ClientConfig } from '@aptamind/storage';
export { ensureRunLabelIndexes, replacementIndexName, type RunLabelIndexSpec } from './run-label-indexes';

export const MIGRATIONS: Migration[] = [
  {
    id: '2026-09-27-001-workflow-collections',
    description: 'Workflow runtime collections, validators and indexes',
    up: (db) => ensureWorkflowCollections(db),
  },
  {
    id: '2026-09-27-002-market-collections',
    description: 'Market collections, validators and indexes',
    up: (db) => ensureMarketCollections(db),
  },
  {
    // The generic runtime indexes no domain labels; the composition root adds the indexes
    // its domains query by (Market: run history per source).
    id: '2026-09-27-003-run-label-indexes',
    description: 'Workflow runs by domain labels (Market source run history)',
    // This used to create a sparse index. On a fresh database the API's lock-busy fallback
    // builds the partial one at the same time, and the two definitions conflicted. Building the
    // final indexes through the shared, race-safe helper avoids that; 2026-09-30-003 is then a no-op.
    up: (db) => ensureMarketRunLabelIndexes(db),
  },
  {
    id: '2026-09-29-001-professional-collections',
    description:
      'Professional core collections (subjects, sources, snapshots, extractions, observations, events, review items), validators and indexes',
    up: (db) => ensureProfessionalCollections(db),
  },
  {
    // Professional runs carry the opaque subject id as a label (never PII); run history per subject.
    id: '2026-09-29-002-professional-run-label-index',
    description: 'Workflow runs by domain labels (Professional run history per subject)',
    up: (db) => ensureProfessionalRunLabelIndex(db),
  },
  {
    // Job search moved from a text index to title tokens (the index manager cannot compare a text
    // index's key and rebuilt it on every boot). Drops the text index; backfills the tokens.
    id: '2026-09-29-011-market-job-title-tokens',
    description: 'Market job title search tokens (backfill) and removal of the legacy text index',
    up: async (db) => {
      await migrateJobTitleTokens(db);
    },
  },
  {
    // `by_last_changed` on companies and jobs is covered by `list_changed` (the dashboard counts
    // filter on `status: active`).
    id: '2026-09-29-012-market-retired-indexes',
    description: 'Drop Market indexes superseded by the list v2 indexes',
    up: async (db) => {
      await dropRetiredMarketIndexes(db);
    },
  },
  {
    // Source search (`q`) matches an anchored prefix of the normalised name (`by_name_key`).
    id: '2026-09-29-013-market-source-name-keys',
    description: 'Market source name search keys (backfill)',
    up: async (db) => {
      await migrateSourceNameKeys(db);
    },
  },
  {
    // Databases that applied 002 while it created a sparse index get the partial definition.
    id: '2026-09-30-001-professional-run-label-index-repair',
    description: 'Repair the Professional run-label index to its partial definition',
    up: (db) => ensureProfessionalRunLabelIndex(db),
  },
  {
    // Widen → backfill → tighten (domain doc §15): P1.2 added `acquisitionCount` as optional in
    // the validator; this backfills subjects created before it. Migrations run before
    // `professional.ensureReady()`, so it widens the validator itself first (a P1.1 database
    // still has the closed validator without the field). Idempotent.
    id: '2026-09-30-002-professional-subject-acquisition-count',
    description:
      'Widen the Professional validators, then backfill professional_subjects.acquisitionCount = 0',
    up: async (db) => {
      await ensureProfessionalCollections(db);
      await backfillSubjectAcquisitionCount(db);
    },
  },
  {
    // Market run history per source, company and job (M7.6): partial label indexes on
    // `workflow_runs`; the sparse `by_label_source` of 003 is replaced (built first, then the
    // sparse one dropped — `ensureRunLabelIndexes`).
    id: '2026-09-30-003-market-run-label-indexes',
    description: 'Workflow runs by Market record labels (source, company, job; partial)',
    up: (db) => ensureMarketRunLabelIndexes(db),
  },
  {
    // Source search (`q`) on name word prefixes (`by_name_tokens`). Widen phase: backfills
    // `nameTokens` only; `nameKey` and `by_name_key` stay (written and searched) until the tighten
    // release (re-run this backfill, then unset `nameKey` and drop `by_name_key`).
    id: '2026-09-30-004-market-source-name-tokens',
    description: 'Market source name search tokens (backfill; nameKey kept)',
    up: async (db) => {
      await migrateSourceNameTokens(db);
    },
  },
  {
    // name-norm/2 (PR #27): add v2 name keys beside the stored v1 keys (additive, idempotent).
    id: '2026-09-30-005-market-company-name-keys-v2',
    description: 'Market company name keys: add name-norm/2 keys beside stored name-norm/1 keys',
    up: async (db) => {
      const counts = await migrateCompanyNameKeysV2(db);
      createLogger({ service: 'market-migrations' }).info(counts, 'company name-norm/2 keys backfilled');
    },
  },
];

/** Market run-label indexes on `workflow_runs` (run history per source, company and job). */
export const MARKET_RUN_LABEL_INDEXES: readonly RunLabelIndexSpec[] = [
  {
    // Source run history (`GET /api/sources/:id/runs`); created sparse by 2026-09-27-003.
    key: { 'labels.sourceId': 1, createdAt: -1 },
    name: 'by_label_source',
    partialFilterExpression: { 'labels.sourceId': { $exists: true } },
  },
  {
    key: { 'labels.companyId': 1, createdAt: -1 },
    name: 'by_label_company',
    partialFilterExpression: { 'labels.companyId': { $exists: true } },
  },
  {
    key: { 'labels.jobId': 1, createdAt: -1 },
    name: 'by_label_job',
    partialFilterExpression: { 'labels.jobId': { $exists: true } },
  },
];

/** Professional run-label index (run history per subject; the opaque subject id, never PII). */
export const PROFESSIONAL_RUN_LABEL_INDEXES: readonly RunLabelIndexSpec[] = [
  {
    key: { 'labels.subjectId': 1, createdAt: -1 },
    name: 'by_label_subject',
    partialFilterExpression: { 'labels.subjectId': { $exists: true } },
  },
];

/** The Market run-label indexes through the shared helper (migrations, lock-busy fallback). */
export const ensureMarketRunLabelIndexes = (db: Db) => ensureRunLabelIndexes(db, MARKET_RUN_LABEL_INDEXES);
/** The Professional run-label index through the shared helper (migrations, lock-busy fallback). */
export const ensureProfessionalRunLabelIndex = (db: Db) =>
  ensureRunLabelIndexes(db, PROFESSIONAL_RUN_LABEL_INDEXES);

export async function createPlatform(
  role: Platform['role'],
  overrides: { config?: AppConfig; clock?: Clock } = {},
): Promise<Platform> {
  const config = overrides.config ?? loadConfig();
  const clock = overrides.clock ?? systemClock;
  const logger = createLogger({ service: `${config.serviceName}-${role}`, level: config.logLevel });
  const workerId = config.worker.id ?? `${role}-${hostname()}-${process.pid}`;
  const mongo = await connectMongo({
    uri: config.mongo.uri,
    dbName: config.mongo.dbName,
    appName: `aptamind-${role}`,
  });
  const transport = new QueueTransport({ url: config.redis.url, prefix: config.redis.queuePrefix });
  const storage = new S3ObjectStorage(config.s3);
  const artifacts = new ArtifactStore(mongo.db, storage, clock);
  // `redis` shares one per-host budget across all API and worker processes (FE-2). It reuses the
  // transport's connection: if Redis is down the queue is down too, and waits stay bounded by
  // each request's timeout.
  const limiter: HostLimiter =
    config.net.hostLimiter === 'redis'
      ? new RedisHostRateLimiter({
          redis: transport.redis,
          keyPrefix: `${config.redis.queuePrefix}:`,
          maxConcurrent: config.net.perHostConcurrency,
          minIntervalMs: config.net.perHostMinIntervalMs,
          leaseTtlMs: config.net.hostLeaseTtlMs,
          onError: (err, op, host) =>
            logger.warn({ err, op, host }, 'host limiter write failed; the lease TTL bounds the damage'),
        })
      : new HostRateLimiter(config.net.perHostConcurrency, config.net.perHostMinIntervalMs);
  const http = new SafeHttpClient({
    limiter,
    allowPrivateNetwork: config.net.allowPrivateNetwork,
    userAgent: config.net.userAgent,
    defaultTimeoutMs: config.net.defaultTimeoutMs,
    maxResponseBytes: config.net.maxResponseBytes,
    perHostConcurrency: config.net.perHostConcurrency,
    perHostMinIntervalMs: config.net.perHostMinIntervalMs,
  });
  const browser: BrowserService = config.browser.executablePath
    ? new PlaywrightBrowserService({
        executablePath: config.browser.executablePath,
        userAgent: config.net.userAgent,
        policy: { allowPrivateNetwork: config.net.allowPrivateNetwork },
      })
    : new UnavailableBrowserService();
  const ai = createAiGateway(config.ai, process.env, {
    onCall(task, meta, outcome) {
      metrics.inc('ai_calls_total', { task, provider: meta.provider, outcome });
      metrics.observe('ai_call_latency_ms', meta.latencyMs, { task, provider: meta.provider });
      if (meta.estimatedCostUsd) metrics.inc('ai_cost_usd_total', { task }, meta.estimatedCostUsd);
    },
  });

  const runtime = createWorkflowRuntime({
    db: mongo.db,
    transport,
    artifacts,
    logger,
    capabilities: [...genericCapabilities, ...marketCapabilities, ...professionalCapabilities],
    clock,
    leaseMs: config.worker.leaseMs,
  });
  const market = createMarketDomain(
    { db: mongo.db, clock, logger, artifacts },
    {
      launcher: {
        startRun: (req) =>
          runtime.engine.startRun({
            workflowKey: req.workflowKey,
            version: req.version,
            input: JSON.parse(JSON.stringify(req.input)),
            labels: req.labels,
            trigger: req.trigger,
            idempotencyKey: req.idempotencyKey,
          }),
      },
      schedules: {
        upsert: (input) =>
          runtime.scheduler.upsert({ ...input, input: JSON.parse(JSON.stringify(input.input ?? {})) }),
      },
      // A workflow waiting on a review decision resumes when the item is resolved.
      onReviewResolved: async (item, actor: Actor) => {
        await runtime.engine.resumeByCorrelationKey(
          item._id,
          { reviewItemId: item._id, action: item.resolution?.action ?? 'dismiss' },
          actor,
        );
      },
    },
  );
  const professional = createProfessionalDomain(
    {
      db: mongo.db,
      clock,
      logger,
      artifacts,
      config: { aiModel: config.ai.model, limits: { ...DEFAULT_PROFESSIONAL_LIMITS } },
    },
    {
      launcher: {
        startRun: (req) =>
          runtime.engine.startRun({
            workflowKey: req.workflowKey,
            version: req.version,
            input: JSON.parse(JSON.stringify(req.input)),
            labels: req.labels,
            trigger: req.trigger,
            idempotencyKey: req.idempotencyKey,
          }),
      },
      resumer: {
        resumeByCorrelationKey: (key, payload, actor) =>
          runtime.engine.resumeByCorrelationKey(key, payload, actor),
      },
      runs: {
        states: async (ids) =>
          Object.fromEntries(
            (
              await runtime.engine.runs
                .find({ _id: { $in: [...ids] } }, { projection: { state: 1 } })
                .toArray()
            ).map((r) => [r._id, r.state]),
          ),
      },
    },
  );
  // Private domains' artifacts never leave through generic routes (Professional: R-4, FE-P6).
  const artifactAccess: ArtifactAccessGuard = {
    isRestricted: (artifact) => professional.ownsArtifact(artifact),
    async listableRunArtifacts(run, refs) {
      if (professional.ownsWorkflow(run.workflowKey)) return [];
      const owned = await professional.referencedArtifactIds(refs.map((r) => r.artifactId));
      return refs.filter((r) => !owned.has(r.artifactId));
    },
  };
  const tasks = new AiTaskRegistry();
  for (const t of marketAiTasks) tasks.register(t);
  runtime.services
    .register(MARKET, market)
    .register(PROFESSIONAL, professional)
    .register(NET_CLIENT, http)
    .register(BROWSER, browser)
    .register(AI_GATEWAY, ai)
    .register(AI_TASKS, tasks);

  return {
    role,
    config,
    logger,
    clock,
    mongo,
    transport,
    storage,
    artifacts,
    http,
    browser,
    ai,
    runtime,
    market,
    professional,
    artifactAccess,
    workflowAccess: {
      startableGenerically: (key) => !professional.ownsWorkflow(key),
      mutableGenerically: (key) => !professional.ownsWorkflow(key),
    },
    workerId,
    async init() {
      await runMigrations(mongo.db, MIGRATIONS, { owner: workerId, log: (m) => logger.info(m) }).catch(
        async (err) => {
          // Only a held lock means "another process is migrating"; any other failure is real.
          if (!/migration lock/.test((err as Error | undefined)?.message ?? '')) throw err;
          // Another process is migrating; continue (migrations are idempotent).
          logger.warn({ err: (err as Error).message }, 'migration lock busy; ensuring collections directly');
          await ensureWorkflowCollections(mongo.db);
          await ensureMarketCollections(mongo.db);
          await ensureMarketRunLabelIndexes(mongo.db);
          await ensureProfessionalCollections(mongo.db, (msg, data) => logger.warn(data, msg));
          await ensureProfessionalRunLabelIndex(mongo.db);
        },
      );
      await storage.ensureReady().catch((err) => logger.error({ err }, 'object storage not ready'));
      await runtime.registerWorkflows(marketWorkflows);
      await runtime.registerWorkflows(professionalWorkflows);
      await market.ensureReady();
      await professional.ensureReady();
    },
    async checks() {
      const [m, r, s] = await Promise.all([mongo.ping(), transport.ping(), storage.ping()]);
      return { mongo: m, redis: r, objectStorage: s };
    },
    async close() {
      await browser.close().catch(() => {});
      await http.close().catch(() => {});
      await transport.close();
      await mongo.close();
    },
  };
}
