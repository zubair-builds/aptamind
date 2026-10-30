/**
 * Sponsorship overrides through real reconciliation (PR #21 review A-M3/B-M1, B-M2 ruling): a
 * job-level correction decides only the ROLE axis. The company axis (licence) is recomputed and
 * its evidence stays on the fact; the recomputed role reading is kept as an alternate; a stored
 * override with a company-axis status is not applied and is raised for review; the review path
 * refuses company-axis statuses up front.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestInfra, type TestInfra } from '@aptamind/testing';
import type { JobDoc } from './jobs/job.schema';
import type { SourceDoc } from './sources/source.schema';
import { createMarketTestRuntime } from './test-harness';

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let source: SourceDoc;
let companyId: string;

const payload = (externalId: string, descriptionText: string) => ({
  externalId,
  title: `Data Engineer ${externalId}`,
  descriptionText,
  locations: [{ text: 'London, United Kingdom' }],
  provider: { name: 'greenhouse', boardToken: 'acme-override' },
});

async function jobWith(externalId: string, descriptionText: string): Promise<JobDoc> {
  const r = await t.market.jobPipeline.process({
    source,
    locator: `/jobs/${externalId}`,
    payload: payload(externalId, descriptionText),
    parser: { name: 'test', version: '1' },
  });
  if (!('jobId' in r) || !r.jobId) throw new Error(`job not created: ${r.outcome}`);
  return t.market.jobs.get(r.jobId);
}

async function reconcile(job: JobDoc): Promise<JobDoc> {
  const fresh = await t.market.jobs.get(job._id);
  const company = await t.market.companies.resolveActive(fresh.companyId);
  return (await t.market.jobReconciler.reconcile(fresh, company)).job;
}

const override = (value: unknown) => ({
  value,
  reason: 'operator decision',
  actorId: 'op-1',
  at: new Date(),
});

beforeAll(async () => {
  infra = await createTestInfra('sponsorship_override');
  t = await createMarketTestRuntime(infra);
  const directory = (
    await t.market.sources.register(
      {
        key: 'directory:override',
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
    externalId: 'acme-override',
    payload: { name: 'Acme Override Ltd', aliases: [], externalIds: [], locations: [], industries: [] },
    parser: { name: 'test', version: '1' },
  });
  if (company.outcome !== 'created' && company.outcome !== 'matched') throw new Error('company not created');
  companyId = company.companyId;
  // A current UK licence with registry evidence.
  await t.market.companies.col.updateOne(
    { _id: companyId },
    {
      $set: {
        'employment.sponsorship.licenceCountries': ['GB'],
        'employment.sponsorship.capability': {
          value: 'licensed',
          status: 'known',
          confidence: { level: 'high', reasons: ['uk register'] },
          evidence: [
            {
              sourceId: directory._id,
              locator: 'register#row-42',
              observedAt: new Date('2026-09-01T00:00:00Z'),
              authority: 'official_registry',
            },
          ],
          conflicts: [],
          policyVersion: 'test',
        },
      },
    },
  );
  source = (
    await t.market.sources.register(
      {
        key: 'greenhouse:acme-override',
        name: 'Acme Override (greenhouse)',
        category: 'job_source',
        provider: 'greenhouse',
        endpoint: { boardToken: 'acme-override' },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      },
      t.actor,
    )
  ).source;
});

afterAll(async () => {
  await t?.stop();
  await infra?.cleanup();
});

describe('PR #21: a sponsorship override decides only the role axis', () => {
  it('keeps the licence evidence and the recomputed role reading; the company axis stays current', async () => {
    const job = await jobWith('o1', 'Build data pipelines. Python and SQL required.');
    expect(job.immigration.sponsorship.value).toMatchObject({
      status: 'company_capable',
      companyCapability: 'licensed',
    });
    await t.market.jobs.col.updateOne(
      { _id: job._id },
      {
        $set: {
          'overrides.sponsorship': override({
            status: 'explicit_no',
            roleStatement: 'no',
            companyCapability: 'none',
            capabilityCountries: [],
          }),
        },
      },
    );
    const after = await reconcile(job);
    const fact = after.immigration.sponsorship;
    expect(fact.value).toEqual({
      status: 'explicit_no',
      roleStatement: 'no',
      companyCapability: 'licensed',
      capabilityCountries: ['GB'],
    });
    expect(fact.evidence[0]).toMatchObject({ authority: 'operator', locator: 'override by op-1' });
    expect(fact.evidence).toContainEqual(expect.objectContaining({ locator: 'register#row-42' }));
    expect(fact.conflicts).toEqual([
      expect.objectContaining({
        value: expect.objectContaining({ status: 'company_capable' }),
        reason: 'overridden by operator',
      }),
    ]);
    // The replaced reading is not a source disagreement: no conflict field, no field_conflict.
    expect(after.quality.conflictFields).not.toContain('immigration.sponsorship');
    expect(await t.market.reviews.col.countDocuments({ type: 'field_conflict', 'entity.id': job._id })).toBe(
      0,
    );
  });

  it('a stored override with a company-axis status is not applied: status re-derived, one field_conflict review', async () => {
    const job = await jobWith('o2', 'Build data pipelines. Python and SQL required.');
    await t.market.jobs.col.updateOne(
      { _id: job._id },
      {
        $set: {
          'overrides.sponsorship': override({
            status: 'historical_evidence',
            roleStatement: 'none',
            companyCapability: 'historical',
            capabilityCountries: ['GB'],
          }),
        },
      },
    );
    const after = await reconcile(job);
    await reconcile(after);
    expect(after.immigration.sponsorship.value).toMatchObject({
      status: 'company_capable',
      companyCapability: 'licensed',
    });
    expect(after.immigration.sponsorship.evidence.some((e) => e.authority === 'operator')).toBe(false);
    const reviews = await t.market.reviews.col
      .find({ type: 'field_conflict', 'entity.id': job._id, status: 'open' })
      .toArray();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      dedupeKey: `field_conflict:job:${job._id}:override:sponsorship`,
      context: expect.objectContaining({ override: 'sponsorship' }),
    });
  });

  it('M3: the stale-override review offers only correct/dismiss; dismiss removes the override (audited) and the cycle ends', async () => {
    const job = await jobWith('o5', 'Build data pipelines. Python and SQL required.');
    await t.market.jobs.col.updateOne(
      { _id: job._id },
      {
        $set: {
          'overrides.sponsorship': override({
            status: 'company_capable',
            roleStatement: 'none',
            companyCapability: 'licensed',
            capabilityCountries: ['GB'],
          }),
        },
      },
    );
    await reconcile(job);
    const [item] = await t.market.reviews.col
      .find({ type: 'field_conflict', 'entity.id': job._id, status: 'open' })
      .toArray();
    expect(item!.allowedActions).toEqual(['correct', 'dismiss']);
    await expect(
      t.market.reviewService.resolve(item!._id, { action: 'confirm', reason: 'keep it' }, t.actor),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await t.market.reviewService.resolve(item!._id, { action: 'dismiss', reason: 'stale decision' }, t.actor);
    const after = await t.market.jobs.get(job._id);
    expect(after.overrides.sponsorship).toBeUndefined();
    const removedAudit = (await t.market.audit.list({ reviewItemId: item!._id })).find(
      (e) => e.action === 'job.override_removed',
    );
    // M3 Low: the audit keeps the removed override itself, not only the field name.
    expect(removedAudit?.details).toMatchObject({
      field: 'sponsorship',
      removed: {
        value: { status: 'company_capable', roleStatement: 'none', companyCapability: 'licensed' },
        reason: 'operator decision',
        actorId: 'op-1',
      },
    });
    // Reconciling again raises nothing: the stale override is gone.
    await reconcile(after);
    await reconcile(after);
    expect(
      await t.market.reviews.col.countDocuments({
        type: 'field_conflict',
        'entity.id': job._id,
        status: 'open',
      }),
    ).toBe(0);
    expect((await t.market.jobs.get(job._id)).immigration.sponsorship.value?.status).toBe('company_capable');
  });

  it.each(['company_capable', 'historical_evidence'])(
    'the review path refuses a %s correction (400 validation_failed)',
    async (status) => {
      const job = await jobWith(`o3-${status}`, 'Build data pipelines. Python and SQL required.');
      const { item } = await t.market.reviews.raise({
        type: 'employment_conflict',
        severity: 'medium',
        dedupeKey: `test:${job._id}:${status}`,
        entity: { kind: 'job', id: job._id },
        subject: 'test',
        reason: 'test',
        context: { flag: 'sponsorship_conflict' },
        allowedActions: ['correct', 'dismiss'],
      });
      await expect(
        t.market.reviewService.resolve(
          item._id,
          {
            action: 'correct',
            reason: 'operator thinks the company sponsors',
            field: 'sponsorship',
            value: {
              status,
              roleStatement: 'none',
              companyCapability: 'licensed',
              capabilityCountries: ['GB'],
            },
          },
          t.actor,
        ),
      ).rejects.toMatchObject({
        code: 'validation_failed',
        message: expect.stringMatching(/decides only the role/),
      });
      expect((await t.market.reviews.get(item._id)).status).toBe('open');
    },
  );

  it('the review path accepts a role-axis correction and requires the matching role statement', async () => {
    const job = await jobWith('o4', 'Build data pipelines. Python and SQL required.');
    const raise = (key: string) =>
      t.market.reviews.raise({
        type: 'employment_conflict',
        severity: 'medium',
        dedupeKey: `test:${job._id}:${key}`,
        entity: { kind: 'job', id: job._id },
        subject: 'test',
        reason: 'test',
        context: { flag: 'sponsorship_conflict' },
        allowedActions: ['correct', 'dismiss'],
      });
    const mismatch = await raise('mismatch');
    await expect(
      t.market.reviewService.resolve(
        mismatch.item._id,
        {
          action: 'correct',
          reason: 'mismatched axes',
          field: 'sponsorship',
          value: {
            status: 'explicit_yes',
            roleStatement: 'none',
            companyCapability: 'licensed',
            capabilityCountries: [],
          },
        },
        t.actor,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const ok = await raise('ok');
    await t.market.reviewService.resolve(
      ok.item._id,
      {
        action: 'correct',
        reason: 'the hiring manager confirmed sponsorship',
        field: 'sponsorship',
        value: {
          status: 'explicit_yes',
          roleStatement: 'yes',
          companyCapability: 'none',
          capabilityCountries: [],
        },
      },
      t.actor,
    );
    const after = await t.market.jobs.get(job._id);
    expect(after.immigration.sponsorship.value).toEqual({
      status: 'explicit_yes',
      roleStatement: 'yes',
      companyCapability: 'licensed',
      capabilityCountries: ['GB'],
    });
  });
});
