import type { FastifyInstance } from 'fastify';
import { AppError } from '@aptamind/contracts';
import {
  auditQuerySchema,
  entityRunsQuerySchema,
  listEntityAudit,
  listEntityObservations,
  listEntityRuns,
  listJobVerifications,
  listSources,
  type ScheduleCollection,
  observationPageQuerySchema,
  sourceListQuerySchema,
  subResourcePageQuerySchema,
  companyDetailQuerySchema,
  companyListQuerySchema,
  companySummaries,
  idParamsSchema,
  jobDetailQuerySchema,
  jobListQuerySchema,
  enrichReviewItems,
  jobSummary,
  listCompanies,
  listJobs,
  listReviews,
  reviewTargetedFacts,
  noQuerySchema,
  pageOnlyQuerySchema,
  reviewListQuerySchema,
  reviewClaimInputSchema,
  reviewReleaseInputSchema,
  triageAttempt,
  withoutExpiredAssignment,
} from '@aptamind/market';
import type { Platform } from '@aptamind/platform';

/**
 * Market record routes. Query strings are validated by the strict schemas in
 * `@aptamind/market` (`src/api/query.ts`): unknown parameters and misspelt enum values are
 * 400s. Response shapes are the DTOs in `src/api/dto.ts` (checked by the route contract tests).
 */

export async function entityRoutes(app: FastifyInstance, { platform }: { platform: Platform }) {
  const { market, runtime } = platform;

  // ---------------------------------------------------------------- companies
  app.get('/api/companies', async (req) => {
    const q = companyListQuerySchema.parse(req.query);
    return listCompanies(market.ctx.db, q);
  });

  app.get('/api/companies/:id', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const { view } = companyDetailQuerySchema.parse(req.query);
    const company = await market.companies.get(id);
    // The peek-panel shape: exactly one list row (`view=summary`) of the requested document.
    if (view === 'summary') return (await companySummaries(market.ctx.db, [company]))[0];
    const survivor = company.status === 'merged' ? await market.companies.resolveSurvivor(id) : company;
    const [observations, jobs, sources, reviews, audit] = await Promise.all([
      market.observations.companyObservations
        .find({ 'resolution.entityId': survivor._id })
        .sort({ lastObservedAt: -1 })
        .limit(100)
        .toArray(),
      market.jobs.list({ companyId: survivor._id, limit: 100, offset: 0 }),
      market.sources.list({ companyId: survivor._id, limit: 50, offset: 0 }),
      market.reviews.list({ entityId: survivor._id, limit: 50, offset: 0 }),
      market.audit.list({ entityKind: 'company', entityId: survivor._id }, 50),
    ]);
    const obsSources = await market.sources.col
      .find(
        { _id: { $in: [...new Set(observations.map((o) => o.sourceId))] } },
        { projection: { key: 1, name: 1, authority: 1 } },
      )
      .toArray();
    return {
      company,
      survivor: survivor._id !== company._id ? survivor : null,
      observations,
      observationSources: obsSources,
      jobs: jobs.items,
      jobSources: sources.items,
      reviews: reviews.items.map((r) => withoutExpiredAssignment(r, market.ctx.clock.now())),
      audit,
    };
  });

  app.post('/api/companies/:id/reconcile', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    noQuerySchema.parse(req.query);
    const { company, changed } = await market.companyReconciler.reconcile(id);
    return { companyId: company._id, changed };
  });

  app.post('/api/companies/:id/discover-careers', async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    noQuerySchema.parse(req.query);
    const run = await runtime.engine.startRun({
      workflowKey: 'market.company.discover_careers',
      input: { companyId: id },
      labels: { companyId: id },
      trigger: { kind: 'manual', actor: { kind: req.ctx.actor.kind, id: req.ctx.actor.id } },
    });
    return reply.status(202).send({ runId: run._id });
  });

  // ---------------------------------------------------------------- jobs
  app.get('/api/jobs', async (req) => {
    const q = jobListQuerySchema.parse(req.query);
    return listJobs(market.ctx.db, q, market.ctx.clock.now());
  });

  app.get('/api/jobs/:id', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const { view } = jobDetailQuerySchema.parse(req.query);
    const job = await market.jobs.get(id);
    // The peek-panel shape: exactly one list row (`view=summary`) of the requested document.
    if (view === 'summary') return jobSummary(market.ctx.db, job);
    const [company, survivor, observations, verifications, reviews, audit] = await Promise.all([
      market.companies.resolveSurvivor(job.companyId),
      // A merged job points at the job it was merged into (M7.6); related lists stay the requested job's.
      job.status === 'merged' ? market.jobs.resolveSurvivor(job._id) : Promise.resolve(null),
      market.observations.jobObservations
        .find({ 'resolution.entityId': job._id })
        .sort({ lastObservedAt: -1 })
        .limit(50)
        .toArray(),
      // With the verifications of the jobs merged into it (M6.2 MR1), like `/verifications`.
      listJobVerifications(
        market.ctx.db,
        job._id,
        subResourcePageQuerySchema.parse({ limit: '20', count: 'none' }),
      ).then((page) => page.items),
      market.reviews.list({ entityId: job._id, limit: 50, offset: 0 }),
      market.audit.list({ entityKind: 'job', entityId: job._id }, 50),
    ]);
    // The job's source copies, plus the operator source when operator overrides are applied (their
    // evidence cites it; legacy evidence citing the literal 'operator' means the same source).
    const sourceIds = [...new Set(job.sourceRefs.map((r) => r.sourceId))];
    const sources = await market.sources.col
      .find(
        Object.keys(job.overrides ?? {}).length
          ? { $or: [{ _id: { $in: sourceIds } }, { key: 'system:operator' }] }
          : { _id: { $in: sourceIds } },
        { projection: { key: 1, name: 1, authority: 1, provider: 1 } },
      )
      .toArray();
    return {
      job,
      survivor: survivor && survivor._id !== job._id ? survivor : null,
      company: {
        _id: company._id,
        name: company.identity.displayName.value,
        sponsorship: company.employment.sponsorship,
        domain: company.identity.domain.value,
      },
      observations,
      sources,
      verifications,
      reviews: reviews.items.map((r) => withoutExpiredAssignment(r, market.ctx.clock.now())),
      audit,
    };
  });

  // ------------------------------------------------ record sub-resources (M7.6, API-5)
  // Paginated tabs of the company and job records. They follow merges: a merged company's or
  // job's sub-resources are its survivor's (as the company detail's related lists are).
  const survivorCompany = async (id: string) => (await market.companies.resolveSurvivor(id))._id;
  const survivorJob = async (id: string) => (await market.jobs.resolveSurvivor(id))._id;
  const db = market.ctx.db;
  const noCompanyId = (q: { companyId?: unknown }) => {
    if (q.companyId !== undefined)
      throw new AppError('validation_failed', 'companyId is given by the path', { param: 'companyId' });
  };

  app.get('/api/companies/:id/runs', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const q = entityRunsQuerySchema.parse(req.query);
    return listEntityRuns(db, runtime.engine.runs, 'company', await survivorCompany(id), q);
  });

  app.get('/api/companies/:id/observations', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const q = observationPageQuerySchema.parse(req.query);
    return listEntityObservations(db, 'company', await survivorCompany(id), q);
  });

  app.get('/api/companies/:id/jobs', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const q = jobListQuerySchema.parse(req.query);
    noCompanyId(q);
    return listJobs(db, { ...q, companyId: [await survivorCompany(id)] }, market.ctx.clock.now());
  });

  app.get('/api/companies/:id/sources', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const q = sourceListQuerySchema.parse(req.query);
    noCompanyId(q);
    return listSources(
      db,
      { ...q, companyId: [await survivorCompany(id)] },
      market.ctx.clock.now(),
      runtime.engine.db.collection('workflow_schedules') as unknown as ScheduleCollection,
    );
  });

  app.get('/api/companies/:id/audit', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const q = subResourcePageQuerySchema.parse(req.query);
    return listEntityAudit(db, { kind: 'company', id: await survivorCompany(id) }, q);
  });

  app.get('/api/jobs/:id/runs', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const q = entityRunsQuerySchema.parse(req.query);
    return listEntityRuns(db, runtime.engine.runs, 'job', await survivorJob(id), q);
  });

  app.get('/api/jobs/:id/observations', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const q = observationPageQuerySchema.parse(req.query);
    return listEntityObservations(db, 'job', await survivorJob(id), q);
  });

  app.get('/api/jobs/:id/verifications', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const q = subResourcePageQuerySchema.parse(req.query);
    return listJobVerifications(db, await survivorJob(id), q);
  });

  app.get('/api/jobs/:id/audit', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const q = subResourcePageQuerySchema.parse(req.query);
    return listEntityAudit(db, { kind: 'job', id: await survivorJob(id) }, q);
  });

  app.post('/api/jobs/:id/verify', async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    noQuerySchema.parse(req.query);
    const run = await runtime.engine.startRun({
      workflowKey: 'market.jobs.verify_due',
      input: { jobIds: [id] },
      labels: { jobId: id },
      trigger: { kind: 'manual', actor: { kind: req.ctx.actor.kind, id: req.ctx.actor.id } },
    });
    return reply.status(202).send({ runId: run._id });
  });

  app.post('/api/jobs/:id/reinterpret', async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    noQuerySchema.parse(req.query);
    const run = await runtime.engine.startRun({
      workflowKey: 'market.job.reinterpret',
      input: { jobId: id },
      labels: { jobId: id },
      trigger: { kind: 'manual', actor: { kind: req.ctx.actor.kind, id: req.ctx.actor.id } },
    });
    return reply.status(202).send({ runId: run._id });
  });

  // ---------------------------------------------------------------- observations / provenance
  app.get('/api/observations/:id', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    noQuerySchema.parse(req.query);
    const doc =
      (await market.observations.companyObservations.findOne({ _id: id })) ??
      (await market.observations.jobObservations.findOne({ _id: id }));
    if (!doc) return { observation: null };
    const source = await market.sources.col.findOne(
      { _id: doc.sourceId },
      { projection: { key: 1, name: 1, authority: 1 } },
    );
    return { observation: doc, kind: id.startsWith('cobs_') ? 'company' : 'job', source };
  });

  // ---------------------------------------------------------------- review
  app.get('/api/review', async (req) => {
    const q = reviewListQuerySchema.parse(req.query);
    return listReviews(market, q);
  });

  app.get('/api/review/:id', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    noQuerySchema.parse(req.query);
    const raw = await market.reviews.get(id);
    // Company and job observations: the item's own, plus the one a flag was raised on.
    const observationIds = [
      ...new Set([
        ...raw.observationIds,
        ...(typeof raw.context.observationId === 'string' ? [raw.context.observationId] : []),
      ]),
    ];
    const [[item], observations, jobObservations, candidates, audit] = await Promise.all([
      // The detail always probes the supported actions (one item; the list does it on request).
      enrichReviewItems(market, [raw], { actions: true }),
      market.observations.companyObservations
        .find({ _id: { $in: observationIds } })
        .limit(20)
        .toArray(),
      market.observations.jobObservations
        .find({ _id: { $in: observationIds } })
        .limit(20)
        .toArray(),
      Promise.all(
        raw.candidates.map(async (c) =>
          c.kind === 'company'
            ? {
                ...c,
                entity: await market.companies.col.findOne(
                  { _id: c.id },
                  { projection: { identity: 1, geography: 1, employment: 1, quality: 1 } },
                ),
              }
            : {
                ...c,
                entity: await market.jobs.col.findOne(
                  { _id: c.id },
                  { projection: { identity: 1, geography: 1, lifecycle: 1, sourceRefs: 1 } },
                ),
              },
        ),
      ),
      market.audit.list({ reviewItemId: id }, 20),
    ]);
    const entity =
      raw.entity.kind === 'company'
        ? await market.companies.col.findOne({ _id: raw.entity.id })
        : raw.entity.kind === 'job'
          ? await market.jobs.col.findOne({ _id: raw.entity.id })
          : raw.entity.kind === 'source'
            ? await market.sources.col.findOne({ _id: raw.entity.id })
            : null;
    return {
      item: item!,
      entity,
      observations: [...observations, ...jobObservations],
      candidates,
      audit,
      targetedFacts: reviewTargetedFacts(
        item!,
        raw.entity.kind === 'job' || raw.entity.kind === 'company' ? (entity as never) : null,
      ),
    };
  });

  // Advisory, cooperative triage claims (API-9; `review/triage.ts`). The holder is a client
  // token in the body; the optional Idempotency-Key names one attempt (replays audit once).
  app.post('/api/review/:id/claim', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    noQuerySchema.parse(req.query);
    const input = reviewClaimInputSchema.parse(req.body ?? {});
    const attempt = triageAttempt(req.headers['idempotency-key']);
    const item = await market.reviewTriage.claim(id, input, req.ctx.actor, attempt);
    return { item: withoutExpiredAssignment(item, market.ctx.clock.now()) };
  });

  app.post('/api/review/:id/release', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    noQuerySchema.parse(req.query);
    const input = reviewReleaseInputSchema.parse(req.body ?? {});
    const attempt = triageAttempt(req.headers['idempotency-key']);
    const item = await market.reviewTriage.release(id, input, req.ctx.actor, attempt);
    return { item: withoutExpiredAssignment(item, market.ctx.clock.now()) };
  });

  app.post('/api/review/:id/resolve', async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    noQuerySchema.parse(req.query);
    // An Idempotency-Key lets a client resume its own interrupted resolution; a concurrent
    // resolver without it gets 409 (already being resolved / already resolved).
    const key = req.headers['idempotency-key'];
    const operationId = typeof key === 'string' && key.length <= 200 ? `api:${key}` : undefined;
    const item = await market.reviewService.resolve(id, req.body as never, req.ctx.actor, { operationId });
    return { item: withoutExpiredAssignment(item, market.ctx.clock.now()) };
  });

  // ---------------------------------------------------------------- audit & signals
  app.get('/api/audit', async (req) => {
    const q = auditQuerySchema.parse(req.query);
    return { items: await market.audit.list(q, q.limit) };
  });

  app.get('/api/signals', async (req) => {
    const q = pageOnlyQuerySchema.parse(req.query);
    const col = market.ctx.db.collection('market_signals');
    const [items, total] = await Promise.all([
      col.find({}).sort({ observedAt: -1 }).skip(q.offset).limit(q.limit).toArray(),
      col.countDocuments({}),
    ]);
    return { items, total, limit: q.limit, offset: q.offset };
  });
}
