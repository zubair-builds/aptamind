/**
 * One interpretation input (M6.4): the `market.interpret_job` inspection capability must compute
 * exactly what canonical reconciliation computes — same primary copy, same provider fields
 * (department), same company context (licences, lapsed licences as history, HQ). It used to build
 * its own input (no department, no history, no HQ) and could disagree with the stored facts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestInfra, startFixtureServer, type TestInfra, waitForRun } from '@aptamind/testing';
import type { JobInterpretation } from './contracts/employment';
import type { JobDoc } from './jobs/job.schema';
import { createMarketTestRuntime } from './test-harness';

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let companyId: string;

const BOARDS: Array<{
  provider: 'greenhouse' | 'lever' | 'ashby';
  token: string;
  path: string;
  file: string[];
}> = [
  {
    provider: 'greenhouse',
    token: 'acme',
    path: '/v1/boards/acme/jobs',
    file: ['greenhouse', 'acme-listing-t1.json'],
  },
  {
    provider: 'lever',
    token: 'beta-co',
    path: '/v0/postings/beta-co',
    file: ['lever', 'beta-co-postings.json'],
  },
  {
    provider: 'ashby',
    token: 'gamma',
    path: '/posting-api/job-board/gamma',
    file: ['ashby', 'gamma-job-board.json'],
  },
];

beforeAll(async () => {
  infra = await createTestInfra('interpret_job');
  t = await createMarketTestRuntime(infra);
  server = await startFixtureServer(async (req, res) => {
    const board = BOARDS.find((b) => b.path === (req.url ?? '').split('?')[0]);
    if (!board) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(await t.fixture('ats', ...board.file));
  });
  const directory = (
    await t.market.sources.register(
      {
        key: 'directory:interpret',
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
    payload: { name: 'Acme Ltd', aliases: [], externalIds: [], locations: [], industries: [] },
    parser: { name: 'test', version: '1' },
  });
  if (company.outcome !== 'created' && company.outcome !== 'matched') throw new Error('company not created');
  companyId = company.companyId;
  // Company context the interpretation depends on: a UK licence that lapsed (hiring-history input)
  // and a known headquarters country.
  const at = new Date('2026-01-01T00:00:00Z');
  await t.market.companies.col.updateOne(
    { _id: companyId },
    {
      $set: {
        'employment.sponsorship.licences': [
          {
            register: 'uk_home_office_sponsor_register',
            country: 'GB',
            route: 'Skilled Worker',
            typeRating: 'Worker (A rating)',
            status: 'no_longer_listed',
            firstSeenAt: at,
            lastSeenAt: at,
            evidence: [],
          },
        ],
        'employment.sponsorship.licenceCountries': [],
        'geography.headquarters': {
          value: { text: 'London, United Kingdom', country: 'GB' },
          status: 'known',
          confidence: { level: 'high', reasons: ['test'] },
          evidence: [],
          conflicts: [],
          policyVersion: 'test',
        },
      },
    },
  );

  for (const b of BOARDS) {
    const { source } = await t.market.sources.register(
      {
        key: `${b.provider}:${b.token}`,
        name: `Acme (${b.provider})`,
        category: 'job_source',
        provider: b.provider,
        endpoint: { boardToken: b.token, url: `${server.url}${b.path}` },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      },
      t.actor,
    );
    expect((await t.runSource(source._id)).state).toBe('COMPLETED');
  }
  await t.runtime.catalog.register({
    key: 'test.interpret_job',
    title: 'Interpret stored job',
    nodes: [
      {
        id: 'start',
        capability: { type: 'core.manual_trigger', version: 1 },
        input: { payload: { $ref: 'run.input' } },
      },
      {
        id: 'interpret',
        capability: { type: 'market.interpret_job', version: 1 },
        input: { jobId: { $ref: 'nodes.start.output.payload.jobId' } },
      },
    ],
    edges: [{ from: 'start', to: 'interpret' }],
    outputNode: 'interpret',
  });
}, 120_000);

afterAll(async () => {
  await t?.stop();
  await server?.close();
  await infra?.cleanup();
});

async function interpret(jobId: string): Promise<JobInterpretation> {
  const run = await t.runtime.engine.startRun({
    workflowKey: 'test.interpret_job',
    input: { jobId },
    trigger: { kind: 'manual' },
  });
  const done = await waitForRun(t.runtime.engine, run._id, undefined, 60_000);
  expect(done.state).toBe('COMPLETED');
  return done.output as unknown as JobInterpretation;
}

/** The canonical facts reconciliation derived from its interpretation (no operator overrides here). */
function reconciled(job: JobDoc) {
  return {
    logicVersion: job.interpretation.logicVersion,
    department: job.identity.department.value,
    seniority: job.identity.seniority.value,
    roleFamily: job.identity.roleFamily.value,
    employmentType: job.employment.employmentType.value,
    workModel: job.geography.workModel.value,
    remoteScope: job.geography.remoteScope.value,
    officeAttendance: job.geography.officeAttendance.value,
    sponsorship: job.immigration.sponsorship.value,
    authorization: job.immigration.authorization.value,
    relocation: job.immigration.relocation.value,
    compensation: job.compensation.value,
    requirements: job.requirements.value?.length ?? 0,
    flags: job.interpretation.flags,
  };
}

function inspected(i: JobInterpretation) {
  return {
    logicVersion: i.logicVersion,
    department: i.title.value.department,
    seniority: i.title.value.seniority,
    roleFamily: i.title.value.roleFamily,
    employmentType: i.employmentType.value,
    workModel: i.workModel.value,
    remoteScope: i.remoteScope.value,
    officeAttendance: i.officeAttendance.value,
    sponsorship: i.sponsorship.value,
    authorization: i.authorization.value,
    relocation: i.relocation.value,
    compensation: i.compensation.value,
    requirements: i.requirements.length,
    flags: i.flags,
  };
}

describe('M6.4: market.interpret_job uses the reconciliation input', () => {
  it('interpret_job output equals the reconciled facts for every fixture job', async () => {
    const jobs = await t.market.jobs.col.find({ companyId, status: 'active' }).toArray();
    expect(jobs.length).toBeGreaterThanOrEqual(12); // 5 Greenhouse + 4 Lever + 4 Ashby
    for (const job of jobs) {
      const title = job.identity.title.value;
      // JSON round trip: the capability output crossed the runtime as JSON.
      expect(inspected(await interpret(job._id)), title ?? job._id).toEqual(
        JSON.parse(JSON.stringify(reconciled(job))),
      );
    }
    // The fixtures exercise the inputs the old capability dropped.
    expect(jobs.some((j) => j.identity.department.value)).toBe(true);
    // The lapsed licence reaches the interpretation (M11.1: as past capability, not history).
    expect(
      jobs.some((j) => j.immigration.sponsorship.value?.companyCapability === 'previously_licensed'),
    ).toBe(true);
  }, 180_000);

  it('interprets the copy reconciliation would choose now (present, most authoritative), not a stale pointer', async () => {
    const job = (await t.market.jobs.col.findOne({ companyId, 'identity.title.value': 'Product Designer' }))!;
    // A stale `content.primaryObservationId` (e.g. left by a lifecycle write before the next
    // reconciliation) must not change what is inspected.
    await t.market.jobs.col.updateOne(
      { _id: job._id },
      { $set: { 'content.primaryObservationId': 'jobobs_stale_pointer' } },
    );
    try {
      expect(inspected(await interpret(job._id))).toEqual(JSON.parse(JSON.stringify(reconciled(job))));
    } finally {
      await t.market.jobs.col.updateOne(
        { _id: job._id },
        { $set: { 'content.primaryObservationId': job.content.primaryObservationId } },
      );
    }
  }, 60_000);
});
