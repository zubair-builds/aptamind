/**
 * Defence in depth (audit M-3): the durable collections carry server-side `$jsonSchema`
 * validators derived from their Zod schemas, so a write that bypasses the TypeScript types
 * (a raw `$set`, a script, another process) is rejected by MongoDB itself.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Collection, Document } from 'mongodb';
import { createTestInfra, startFixtureServer, type TestInfra } from '@aptamind/testing';
import { createMarketTestRuntime } from './test-harness';

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  infra = await createTestInfra('schema_validation');
  t = await createMarketTestRuntime(infra);
  server = await startFixtureServer(async (req, res) => {
    if ((req.url ?? '').startsWith('/v1/boards/acme/jobs')) {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(await t.fixture('ats', 'greenhouse', 'acme-listing-t1.json'));
    } else res.writeHead(404).end('gone');
  });
  // Real documents in every durable collection, produced by the real flows.
  const directory = (
    await t.market.sources.register(
      {
        key: 'directory:schema',
        name: 'Directory',
        category: 'company_universe',
        provider: 'fixture',
        acquisition: { workflowKey: 'market.noop' },
        freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 100000 },
        authority: { tier: 'official_site' },
      },
      t.actor,
    )
  ).source;
  const company = await t.market.companyPipeline.process({
    sourceId: directory._id,
    externalId: 'acme',
    payload: {
      name: 'Acme Ltd',
      domain: 'acme.example',
      aliases: [],
      externalIds: [],
      locations: [],
      industries: [],
    },
    parser: { name: 'test', version: '1' },
  });
  const source = (
    await t.market.sources.register(
      {
        key: 'greenhouse:acme-schema',
        name: 'Acme',
        category: 'job_source',
        provider: 'greenhouse',
        endpoint: { boardToken: 'acme', url: `${server.url}/v1/boards/acme/jobs` },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId: 'companyId' in company ? company.companyId : undefined,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      },
      t.actor,
    )
  ).source;
  expect((await t.runSource(source._id)).state).toBe('COMPLETED');
  const job = (await t.market.jobs.col.findOne({}))!;
  await t.market.jobs.col.updateOne(
    { _id: job._id },
    {
      $set: {
        'application.ats': null,
        'sourceRefs.$[].provider': 'careers_page',
        'sourceRefs.$[].postingUrl': `${server.url}/posting/x`,
      },
    },
  );
  await t.market.verification.verify(job._id, t.runtime.http, { operationKey: 'schema-op' });
  await t.market.reviews.raise({
    type: 'job_duplicate',
    severity: 'low',
    dedupeKey: 'schema:dup',
    entity: { kind: 'job', id: job._id },
    subject: 'dup?',
    reason: 'test',
    allowedActions: ['dismiss'],
  });
  const { item: resolved } = await t.market.reviews.raise({
    type: 'job_duplicate',
    severity: 'low',
    dedupeKey: 'schema:dup-resolved',
    entity: { kind: 'job', id: job._id },
    subject: 'dup?',
    reason: 'test',
    allowedActions: ['dismiss'],
  });
  await t.market.reviewService.resolve(resolved._id, { action: 'dismiss', reason: 'schema test' }, t.actor);
});
afterAll(async () => {
  await t?.stop();
  await server?.close();
  await infra?.cleanup();
});

const REJECTED = /Document failed validation/;

describe('server-side validators on durable collections (audit M-3)', () => {
  const cases: Array<[collection: string, invalid: Document[]]> = [
    ['workflow_runs', [{ state: 'BOGUS' }, { workflowVersion: 'one' }, { rootRunId: 42 }]],
    ['workflow_node_runs', [{ state: 'BOGUS' }, { attempt: 'x' }, { leaseExpiresAt: 'soon' }]],
    ['workflow_fanout_chunks', [{ state: 'BOGUS' }, { results: 'none' }]],
    ['market_sources', [{ 'authority.tier': 'bogus' }, { category: 'bogus' }]],
    ['market_snapshots', [{ fetchCount: 'many' }, { via: 'pigeon' }]],
    ['market_company_observations', [{ seenCount: 'many' }, { 'resolution.state': 'bogus' }]],
    ['market_job_observations', [{ seenCount: 'many' }, { 'payload.title': 7 }]],
    ['market_companies', [{ status: 'deleted' }, { identityKeys: 'x' }]],
    [
      'market_jobs',
      [
        { 'lifecycle.state': 'BOGUS' },
        { 'lifecycle.consecutiveAbsences': 'two' },
        { rev: 'x' },
        { status: 'gone' },
        // 8d96663 L3: a flag value is only the stated `yes` / `no`.
        {
          'interpretation.flags': [
            { code: 'sponsorship_stated', message: 'm', severity: 'info', value: 'maybe' },
          ],
        },
      ],
    ],
    [
      'market_review_items',
      [
        { status: 'bogus' },
        { 'claim.operationId': 5 },
        { priority: 'high' },
        { 'lastFailure.kind': 'bogus' },
      ],
    ],
    ['market_job_verifications', [{ status: 'weird' }, { outcome: 'maybe' }, { lifecycleApplied: 'yes' }]],
    ['market_source_run_outcomes', [{ kind: 'bogus' }, { runId: 5 }]],
    [
      'market_review_operations',
      [
        { state: 'bogus' },
        { generation: 'two' },
        { 'owner.operationId': 5 },
        { 'failure.kind': 'bogus' },
        { 'lastError.generation': 'x' },
      ],
    ],
  ];

  it.each(cases)(
    '%s accepts valid writes and rejects writes that violate its schema',
    async (name, invalid) => {
      const options = await infra.db.listCollections({ name }).next();
      expect(
        (options as { options?: Document } | null)?.options?.validator?.$jsonSchema,
        `${name} has a validator`,
      ).toBeTruthy();
      const col: Collection<Document> = infra.db.collection(name);
      const doc = await col.findOne({});
      expect(doc, `${name} has a real document`).not.toBeNull();
      await infra.db.command({ collMod: name, validationLevel: 'strict' });
      try {
        // The real document is valid: an ordinary update passes.
        await col.updateOne({ _id: doc!._id }, { $set: { updatedAt: new Date() } });
        for (const $set of invalid) {
          await expect(col.updateOne({ _id: doc!._id }, { $set }), JSON.stringify($set)).rejects.toThrow(
            REJECTED,
          );
        }
        await expect(col.insertOne({ _id: `bad_${name}` as never })).rejects.toThrow(REJECTED);
      } finally {
        await infra.db.command({ collMod: name, validationLevel: 'moderate' });
      }
    },
  );
});
