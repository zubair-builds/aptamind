import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestInfra, startFixtureServer, type TestInfra } from '@aptamind/testing';
import type { JobDoc } from './jobs/job.schema';
import type { SourceDoc } from './sources/source.schema';
import { LIFECYCLE_SIGNAL_WRITER } from './signals/lifecycle-signals';
import { createMarketTestRuntime } from './test-harness';

/**
 * OPS-4: an authoritative ATS listing's first sighting is VERIFIED_LIVE (derived from
 * market_job_evidence), and that transition is a job_discovered signal.
 */
let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let source: SourceDoc;

beforeAll(async () => {
  infra = await createTestInfra('lifecycle_derived');
  t = await createMarketTestRuntime(infra);
  server = await startFixtureServer(async (req, res) => {
    if ((req.url ?? '').startsWith('/v1/boards/acme/jobs')) {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(await t.fixture('ats', 'greenhouse', 'acme-listing-t1.json'));
      return;
    }
    res.writeHead(404).end();
  });
  const directory = (
    await t.market.sources.register(
      {
        key: 'directory:lifecycle-derived',
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
  if (company.outcome !== 'created' && company.outcome !== 'matched') throw new Error('company not created');
  source = (
    await t.market.sources.register(
      {
        key: 'greenhouse:lifecycle-derived',
        name: 'Acme (greenhouse)',
        category: 'job_source',
        provider: 'greenhouse',
        endpoint: { boardToken: 'acme', url: `${server.url}/v1/boards/acme/jobs` },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId: company.companyId,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      },
      t.actor,
    )
  ).source;
  expect((await t.runSource(source._id)).state).toBe('COMPLETED');
});

afterAll(async () => {
  await t?.stop();
  await server?.close();
  await infra?.cleanup();
});

describe('lifecycle signals from derived ATS evidence', () => {
  it('emits job_discovered for the first sourced VERIFIED_LIVE transition', async () => {
    const job = (await t.market.jobs.col.findOne({
      sourceKeys: `${source._id}:4012345001`,
    })) as JobDoc;
    expect(job.lifecycle.history[0]).toMatchObject({
      from: null,
      to: 'VERIFIED_LIVE',
      reason: 'first seen on authoritative source',
      sourceId: source._id,
    });
    expect(job.lifecycle.history.filter((h) => h.to === 'DISCOVERED')).toHaveLength(0);

    const r = await t.market.lifecycleSignals.run();
    expect(r.written).toBeGreaterThan(0);
    const sig = await infra.db.collection('market_signals').findOne({
      type: 'job_discovered',
      'facts.jobId': job._id,
    });
    expect(sig).toMatchObject({
      sourceId: source._id,
      facts: { writer: LIFECYCLE_SIGNAL_WRITER, to: 'VERIFIED_LIVE', from: null, jobId: job._id },
    });
    expect(sig!.evidence.length).toBeGreaterThan(0);
    expect(sig!.evidence[0]).toMatchObject({ sourceId: source._id });
  });
});
