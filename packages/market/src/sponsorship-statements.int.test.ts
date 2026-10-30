/**
 * Sponsorship statements across copies, operator decisions and the re-interpretation backfill
 * (PR #21 re-verify #8, DECISION_LOG 8d96663) through real ingestion and reconciliation:
 *
 *  - (2) stated values are compared across ALL present copies: an official ATS "yes" against a
 *    syndicated third-party "no" (and two copies of equal authority) is a `sponsorship_conflict`
 *    with an employment_conflict review, each copy's value and line kept as an alternate;
 *  - (4) an operator decision closes the question: no re-raise while the decision is newer than
 *    the stating copies; a changed copy re-opens it; an item whose flag is gone is closed by the
 *    system;
 *  - (3) `market.jobs.reinterpret_outdated` re-reconciles every job whose policy version is older
 *    (CLOSED, POSSIBLY_STALE and disabled-source jobs included; merged and newer ones skipped),
 *    keeps operator overrides, and is replay-safe.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentHash, type JsonObject } from '@aptamind/contracts';
import { createTestInfra, type TestInfra, waitForRun } from '@aptamind/testing';
import { INTERPRETATION_POLICY_VERSION } from './enrichment/interpret';
import { ashbyAdapter } from './connectors/ashby';
import { parseAggregatorFeed } from './connectors/aggregator';
import { greenhouseAdapter } from './connectors/greenhouse';
import { leverAdapter } from './connectors/lever';
import type { JobObservationPayload } from './contracts/observations';
import { extractJsonLdJobPostings } from './discovery/jsonld';
import type { JobDoc } from './jobs/job.schema';
import { selectOutdatedInterpretations } from './jobs/reinterpret-backfill';
import { EMPLOYMENT_CONFLICT_CLOSER } from './market-domain';
import { ASKED_AGAIN, REVIEW_EVIDENCE_VERSION } from './reconciliation/job-reconciler';
import type { SourceDoc } from './sources/source.schema';
import { createMarketTestRuntime } from './test-harness';

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let companyId: string;
let official: SourceDoc;
let officialB: SourceDoc;
let aggregator: SourceDoc;

const OLD_POLICY = 'employment-policy/2026-09-27.1';
const tick = () => new Promise((r) => setTimeout(r, 5));

async function copy(
  source: SourceDoc,
  externalId: string,
  descriptionText: string,
  postingUrl: string,
): Promise<JobDoc> {
  const r = await t.market.jobPipeline.process({
    source,
    locator: `/jobs/${externalId}`,
    payload: {
      externalId,
      title: `Platform Engineer ${postingUrl.split('/').pop()}`,
      descriptionText,
      locations: [{ text: 'London, United Kingdom' }],
      postingUrl,
      provider: { name: source.provider, boardToken: source.endpoint?.boardToken ?? 'feed' },
    },
    parser: { name: 'test', version: '1' },
  });
  if (!('jobId' in r) || !r.jobId) throw new Error(`job not created: ${r.outcome}`);
  return t.market.jobs.get(r.jobId);
}

async function reconcile(id: string): Promise<JobDoc> {
  const fresh = await t.market.jobs.get(id);
  const company = await t.market.companies.resolveActive(fresh.companyId);
  return (await t.market.jobReconciler.reconcile(fresh, company)).job;
}

const openConflicts = (jobId: string) =>
  t.market.reviews.col.find({ type: 'employment_conflict', 'entity.id': jobId, status: 'open' }).toArray();

async function register(key: string, provider: string, tier: string, boardToken?: string) {
  return (
    await t.market.sources.register(
      {
        key,
        name: key,
        category: 'job_source',
        provider,
        endpoint: boardToken ? { boardToken } : { url: 'http://127.0.0.1:9/feed.json' },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: tier as never, listingIsComplete: tier !== 'third_party' },
        governance: { accessMethod: tier === 'third_party' ? 'licensed_feed' : 'public_api' },
      },
      t.actor,
    )
  ).source;
}

beforeAll(async () => {
  infra = await createTestInfra('sponsorship_statements');
  t = await createMarketTestRuntime(infra);
  const directory = (
    await t.market.sources.register(
      {
        key: 'directory:statements',
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
    externalId: 'acme-statements',
    payload: { name: 'Acme Statements Ltd', aliases: [], externalIds: [], locations: [], industries: [] },
    parser: { name: 'test', version: '1' },
  });
  if (company.outcome !== 'created' && company.outcome !== 'matched') throw new Error('company not created');
  companyId = company.companyId;
  official = await register('greenhouse:acme-statements', 'greenhouse', 'official_ats', 'acme-statements');
  officialB = await register('lever:acme-statements', 'lever', 'official_ats', 'acme-statements');
  aggregator = await register('aggregator:statements', 'aggregator', 'third_party');
}, 60_000);

afterAll(async () => {
  await t?.stop();
  await infra?.cleanup();
});

describe('8d96663 (2): stated values are compared across all present copies', () => {
  it('an official ATS "yes" against a syndicated third-party "no": conflict, review, both values kept', async () => {
    const url = 'https://jobs.example.com/acme/syndicated-1';
    const job = await copy(official, 's1', 'Join us.\n\nVisa sponsorship: Yes\n25 days holiday', url);
    // The official copy alone states one value: no conflict.
    expect(job.interpretation.flags.map((f) => f.code)).not.toContain('sponsorship_conflict');
    const after = await copy(aggregator, 's1-agg', 'Join us.\n\nVisa sponsorship: No\n25 days holiday', url);
    expect(after._id).toBe(job._id);
    expect(after.sourceRefs.map((r) => r.authority).sort()).toEqual(['official_ats', 'third_party']);
    // The primary (official) copy's own interpretation has no conflict; the canonical one does.
    expect(after.interpretation.flags).toContainEqual(
      expect.objectContaining({ code: 'sponsorship_conflict', severity: 'high' }),
    );
    expect(after.interpretation.flags).toContainEqual(
      expect.objectContaining({ code: 'sponsorship_stated', value: 'yes' }),
    );
    // The third-party copy's "no" and its line are kept as an alternate on the fact.
    const alternate = after.immigration.sponsorship.conflicts.find((c) =>
      /the copy states visa sponsorship no/.test(c.reason),
    );
    expect(alternate?.reason).toMatch(/^lower authority/);
    expect(alternate?.evidence[0]).toMatchObject({
      sourceId: aggregator._id,
      authority: 'third_party',
      quote: 'Visa sponsorship: No',
    });
    expect(alternate?.evidence[0]?.locator).toMatch(/#description\[\d+:\d+\]$/);
    // The official copy's own stated line stays in the fact's evidence.
    expect(after.immigration.sponsorship.evidence.map((e) => e.quote)).toContain('Visa sponsorship: Yes');
    const [item, ...more] = await openConflicts(job._id);
    expect(more).toHaveLength(0);
    expect(item).toMatchObject({
      dedupeKey: `employment_conflict:${job._id}:sponsorship_conflict`,
      context: expect.objectContaining({ flag: 'sponsorship_conflict' }),
    });
    expect(item!.evidence.map((e) => e.quote)).toEqual(
      expect.arrayContaining(['Visa sponsorship: Yes', 'Visa sponsorship: No']),
    );
    // Re-reconciling is stable: one open item, one alternate.
    const again = await reconcile(job._id);
    expect(await openConflicts(job._id)).toHaveLength(1);
    expect(
      again.immigration.sponsorship.conflicts.filter((c) => /states visa sponsorship/.test(c.reason)),
    ).toHaveLength(1);
  });

  it('two copies of equal authority that disagree: conflict, and a listed conflict field', async () => {
    const url = 'https://jobs.example.com/acme/same-authority-1';
    const job = await copy(official, 'a1', 'Join us.\n\nVisa sponsorship: No\nPension', url);
    const after = await copy(officialB, 'a1-lever', 'Join us.\n\nVisa sponsorship: Yes\nPension', url);
    expect(after._id).toBe(job._id);
    expect(after.interpretation.flags.map((f) => f.code)).toContain('sponsorship_conflict');
    const alternate = after.immigration.sponsorship.conflicts.find((c) =>
      /the copy states visa sponsorship/.test(c.reason),
    );
    expect(alternate?.reason).toMatch(/^same authority disagreement/);
    expect(after.quality.conflictFields).toContain('immigration.sponsorship');
    expect(await openConflicts(job._id)).toHaveLength(1);
  });

  it('copies stating the same value are no conflict', async () => {
    const url = 'https://jobs.example.com/acme/agree-1';
    await copy(official, 'g1', 'Join us.\n\nVisa sponsorship: Yes', url);
    const after = await copy(aggregator, 'g1-agg', 'Join us.\n\nVisa sponsorship: Yes', url);
    expect(after.sourceRefs).toHaveLength(2);
    expect(after.interpretation.flags.map((f) => f.code)).not.toContain('sponsorship_conflict');
    expect(await openConflicts(after._id)).toHaveLength(0);
  });
});

describe('8d96663 (4): an operator decision closes the question', () => {
  it("the reviewer's sequence: decide → no re-raise → a changed copy re-opens → a gone flag closes the item", async () => {
    const url = 'https://jobs.example.com/acme/decided-1';
    const job = await copy(official, 'd1', 'Join us.\n\nVisa sponsorship: Yes', url);
    await copy(aggregator, 'd1-agg', 'Join us.\n\nVisa sponsorship: No', url);
    const [item] = await openConflicts(job._id);
    expect(item).toBeDefined();

    // 1. The operator decides the role (a role-axis correction).
    await tick();
    await t.market.reviewService.resolve(
      item!._id,
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
    let j = await t.market.jobs.get(job._id);
    expect(j.immigration.sponsorship.value?.status).toBe('explicit_yes');
    // 3dfe3c5 (2): the decision records the stating set it decided …
    expect(j.sponsorshipDecision).toMatchObject({ action: 'correct', reviewItemId: item!._id });
    expect(j.sponsorshipDecision!.stating.map((x) => x.value).sort()).toEqual(['no', 'yes']);
    // … and the other copy's value stays behind the operator reading as an alternate.
    expect(j.immigration.sponsorship.conflicts.map((c) => c.reason)).toEqual([
      'overridden by operator',
      'lower authority: the copy states visa sponsorship no',
    ]);
    expect(j.quality.conflictFields).not.toContain('immigration.sponsorship');
    expect(j.interpretation.flags.map((f) => f.code)).toContain('sponsorship_conflict_decided');
    expect(j.interpretation.flags.map((f) => f.code)).not.toContain('sponsorship_conflict');
    expect(await openConflicts(job._id)).toHaveLength(0);

    // 2. Newer sightings of the same copies and re-reconciliation do not re-raise it.
    await tick();
    await copy(official, 'd1', 'Join us.\n\nVisa sponsorship: Yes', url);
    await copy(aggregator, 'd1-agg', 'Join us.\n\nVisa sponsorship: No', url);
    await reconcile(job._id);
    expect(await openConflicts(job._id)).toHaveLength(0);
    // … nor does an edit of a stating copy that keeps its value: the same (copy, value) (bc013e8 L2).
    await tick();
    await copy(aggregator, 'd1-agg', 'Join us today.\n\nVisa sponsorship: No', url);
    expect(await openConflicts(job._id)).toHaveLength(0);

    // 3. A new stating copy after the decision (still contradicting) re-opens it.
    await tick();
    await copy(officialB, 'd1-lever', 'Join us today.\n\nVisa sponsorship: No', url);
    j = await t.market.jobs.get(job._id);
    expect(j.interpretation.flags.map((f) => f.code)).toContain('sponsorship_conflict');
    const reopened = await openConflicts(job._id);
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!._id).not.toBe(item!._id);
    // The operator's decision itself still stands.
    expect(j.immigration.sponsorship.value?.status).toBe('explicit_yes');

    // 4. The copies now agree: the flag is gone and the open item is closed by the system.
    await tick();
    await copy(aggregator, 'd1-agg', 'Join us today.\n\nVisa sponsorship: Yes', url);
    await copy(officialB, 'd1-lever', 'Join us today.\n\nVisa sponsorship: Yes', url);
    j = await t.market.jobs.get(job._id);
    expect(j.interpretation.flags.map((f) => f.code)).not.toContain('sponsorship_conflict');
    expect(await openConflicts(job._id)).toHaveLength(0);
    const closed = await t.market.reviews.get(reopened[0]!._id);
    expect(closed.status).toBe('dismissed');
    expect(closed.resolution).toMatchObject({
      action: 'dismiss',
      actor: { kind: 'system', id: EMPLOYMENT_CONFLICT_CLOSER.id },
      reason: expect.stringMatching(/sponsorship_conflict flag is no longer present/),
    });
    // Closing is idempotent: reconciling again changes nothing.
    await reconcile(job._id);
    expect((await t.market.reviews.get(reopened[0]!._id)).resolution?.at).toEqual(closed.resolution?.at);
  });

  it('an open item whose flag disappears without any decision is closed by the system', async () => {
    const url = 'https://jobs.example.com/acme/gone-1';
    const job = await copy(official, 'x1', 'Join us.\n\nVisa sponsorship: Yes', url);
    await copy(aggregator, 'x1-agg', 'Join us.\n\nVisa sponsorship: No', url);
    const [item] = await openConflicts(job._id);
    // An item raised by another path (its own dedupe key) is not reconciliation's to close.
    const { item: manual } = await t.market.reviews.raise({
      type: 'employment_conflict',
      severity: 'medium',
      dedupeKey: `manual:${job._id}`,
      entity: { kind: 'job', id: job._id },
      subject: 'raised by hand',
      reason: 'r',
      context: { flag: 'sponsorship_conflict' },
      allowedActions: ['confirm', 'dismiss'],
    });
    await tick();
    await copy(aggregator, 'x1-agg', 'Join us.\n\nWe look forward to your application.', url);
    expect((await openConflicts(job._id)).map((i) => i._id)).toEqual([manual._id]);
    expect((await t.market.reviews.get(item!._id)).resolution?.actor).toEqual({
      kind: 'system',
      id: EMPLOYMENT_CONFLICT_CLOSER.id,
    });
  });
});

async function resolveConflict(jobId: string, action: 'dismiss' | 'confirm') {
  const [item] = await openConflicts(jobId);
  expect(item, 'an open sponsorship conflict').toBeDefined();
  await t.market.reviewService.resolve(item!._id, { action, reason: `operator ${action}` }, t.actor);
  return item!;
}

describe('3dfe3c5 (2): the decided set', () => {
  it.each(['dismiss', 'confirm'] as const)(
    'a %s of the conflict sticks: the decided set is recorded and newer sightings raise nothing',
    async (action) => {
      const url = `https://jobs.example.com/acme/durable-${action}`;
      const job = await copy(official, `du-${action}`, 'Join us.\n\nVisa sponsorship: Yes', url);
      await copy(aggregator, `du-${action}-agg`, 'Join us.\n\nVisa sponsorship: No', url);
      const fieldConflicts = async () =>
        (await t.market.reviews.col.find({ type: 'field_conflict', 'entity.id': job._id }).toArray()).map(
          (i) => [i._id, i.occurrences],
        );
      const item = await resolveConflict(job._id, action);
      const fieldConflictsBefore = await fieldConflicts();
      let j = await t.market.jobs.get(job._id);
      expect(j.sponsorshipDecision).toMatchObject({ action, reviewItemId: item._id });
      expect(j.interpretation.flags.map((f) => f.code)).toContain('sponsorship_conflict_decided');
      await tick();
      await copy(official, `du-${action}`, 'Join us.\n\nVisa sponsorship: Yes', url);
      await copy(aggregator, `du-${action}-agg`, 'Join us.\n\nVisa sponsorship: No', url);
      await reconcile(job._id);
      expect(await openConflicts(job._id)).toHaveLength(0);
      j = await t.market.jobs.get(job._id);
      expect(j.interpretation.flags.map((f) => f.code)).not.toContain('sponsorship_conflict');
      // The decided sponsorship conflict is not raised (or re-raised) as a field_conflict either.
      expect(await fieldConflicts()).toEqual(fieldConflictsBefore);
    },
  );

  it('a merged-in copy (job_duplicate merge) with an older observation re-raises a decided conflict', async () => {
    const url = 'https://jobs.example.com/acme/merge-1';
    const j1 = await copy(official, 'm1', 'Join us.\n\nVisa sponsorship: Yes', url);
    await copy(aggregator, 'm1-agg', 'Join us.\n\nVisa sponsorship: No', url);
    // J2 is observed BEFORE the decision (its observation is older than the decision).
    const j2 = await copy(
      officialB,
      'm2',
      'Join us.\n\nVisa sponsorship: No',
      'https://jobs.example.com/acme/merge-2',
    );
    expect(j2._id).not.toBe(j1._id);
    await tick();
    const decided = await resolveConflict(j1._id, 'confirm');
    expect(await openConflicts(j1._id)).toHaveLength(0);
    const { item: dup } = await t.market.reviews.raise({
      type: 'job_duplicate',
      severity: 'medium',
      dedupeKey: `test:dup:${j1._id}`,
      entity: { kind: 'job', id: j1._id },
      subject: 'possible duplicate',
      reason: 'test',
      candidates: [{ kind: 'job', id: j2._id, label: 'J2' }],
      allowedActions: ['merge', 'keep_separate', 'dismiss'],
    });
    await t.market.reviewService.resolve(
      dup._id,
      { action: 'merge', reason: 'same opening', targetId: j2._id },
      t.actor,
    );
    const merged = await t.market.jobs.get(j1._id);
    expect(merged.sourceRefs).toHaveLength(3);
    expect(merged.interpretation.flags.map((f) => f.code)).toContain('sponsorship_conflict');
    const [reopened, ...more] = await openConflicts(j1._id);
    expect(more).toHaveLength(0);
    expect(reopened!._id).not.toBe(decided._id);
  });

  it('a reverted observation (same id, old firstObservedAt) re-raises the conflict', async () => {
    const url = 'https://jobs.example.com/acme/revert-1';
    const job = await copy(official, 'r1', 'Join us.\n\nVisa sponsorship: Yes', url);
    await copy(aggregator, 'r1-agg', 'Join us.\n\nVisa sponsorship: No', url);
    const [first] = await openConflicts(job._id);
    await tick();
    await copy(aggregator, 'r1-agg', 'Join us.\n\nVisa sponsorship: Yes', url);
    expect(await openConflicts(job._id)).toHaveLength(0);
    expect((await t.market.reviews.get(first!._id)).resolution?.actor.kind).toBe('system');
    // An unrelated operator override after it.
    await tick();
    await t.market.jobs.col.updateOne(
      { _id: job._id },
      {
        $set: {
          'overrides.workModel': { value: 'hybrid', reason: 'operator', actorId: 'op-1', at: new Date() },
        },
      },
    );
    await tick();
    const reverted = await copy(aggregator, 'r1-agg', 'Join us.\n\nVisa sponsorship: No', url);
    expect(reverted.interpretation.flags.map((f) => f.code)).toContain('sponsorship_conflict');
    expect(await openConflicts(job._id)).toHaveLength(1);
  });

  it('the backfill raises a conflict hidden when an old override was made (no decided set)', async () => {
    const url = 'https://jobs.example.com/acme/bf-override-1';
    const job = await copy(official, 'bo1', 'Join us.\n\nVisa sponsorship: Yes', url);
    await copy(aggregator, 'bo1-agg', 'Join us.\n\nVisa sponsorship: No', url);
    // As stored by the pre-8d96663 code: an override, no cross-copy flag, no conflict item.
    await t.market.reviews.col.deleteMany({ 'entity.id': job._id });
    await t.market.jobs.col.updateOne(
      { _id: job._id },
      {
        $set: {
          'overrides.sponsorship': {
            value: {
              status: 'explicit_no',
              roleStatement: 'no',
              companyCapability: 'none',
              capabilityCountries: [],
            },
            reason: 'old decision',
            actorId: 'op-1',
            at: new Date(),
          },
          'interpretation.policyVersion': OLD_POLICY,
          'interpretation.flags': [],
        },
      },
    );
    const run = await t.runtime.engine.startRun({
      workflowKey: 'market.jobs.reinterpret_outdated',
      input: {},
      trigger: { kind: 'manual' },
    });
    expect((await waitForRun(t.runtime.engine, run._id, undefined, 120_000)).state).toBe('COMPLETED');
    const j = await t.market.jobs.get(job._id);
    expect(j.immigration.sponsorship.value?.status).toBe('explicit_no');
    expect(j.interpretation.flags.map((f) => f.code)).toContain('sponsorship_conflict');
    expect(j.immigration.sponsorship.conflicts.map((c) => c.reason)).toContain(
      'lower authority: the copy states visa sponsorship no',
    );
    expect(await openConflicts(job._id)).toHaveLength(1);
  }, 180_000);
});

describe('3dfe3c5 (3): decided and CLOSED questions are not re-raised', () => {
  it('a dismissed salary_suspicious item on a CLOSED job: the backfill raises 0 new items', async () => {
    const job = await copy(
      official,
      'sal1',
      'Join us.\n\nSalary: $90,000 - $110,000',
      'https://jobs.example.com/acme/salary-1',
    );
    const salary = () =>
      t.market.reviews.col.find({ type: 'salary_suspicious', 'entity.id': job._id }).toArray();
    const [item, ...more] = await salary();
    expect(item, 'a salary_suspicious item').toBeDefined();
    expect(more).toHaveLength(0);
    await t.market.reviewService.resolve(item!._id, { action: 'dismiss', reason: 'fine as is' }, t.actor);
    // Re-reconciling an open job does not reopen the dismissed question (evidence unchanged).
    await reconcile(job._id);
    expect(await salary()).toHaveLength(1);
    await t.market.jobs.col.updateOne(
      { _id: job._id },
      { $set: { 'lifecycle.state': 'CLOSED', 'interpretation.policyVersion': OLD_POLICY } },
    );
    const run = await t.runtime.engine.startRun({
      workflowKey: 'market.jobs.reinterpret_outdated',
      input: {},
      trigger: { kind: 'manual' },
    });
    expect((await waitForRun(t.runtime.engine, run._id, undefined, 120_000)).state).toBe('COMPLETED');
    expect((await t.market.jobs.get(job._id)).interpretation.policyVersion).toBe(
      INTERPRETATION_POLICY_VERSION,
    );
    expect(await salary()).toHaveLength(1);
    expect(await t.market.reviews.col.countDocuments({ 'entity.id': job._id, status: 'open' })).toBe(0);
  }, 180_000);

  it('a CLOSED job raises no new review at all', async () => {
    const url = 'https://jobs.example.com/acme/closed-1';
    const job = await copy(official, 'c1', 'Join us.\n\nVisa sponsorship: Yes', url);
    await copy(aggregator, 'c1-agg', 'Join us.\n\nVisa sponsorship: No', url);
    // (A new sighting reopens a CLOSED job; a reconciliation of a CLOSED one — the backfill,
    // a company change — must not ask anything new.)
    await t.market.reviews.col.deleteMany({ 'entity.id': job._id });
    await t.market.jobs.col.updateOne({ _id: job._id }, { $set: { 'lifecycle.state': 'CLOSED' } });
    const after = await reconcile(job._id);
    expect(after.lifecycle.state).toBe('CLOSED');
    expect(after.interpretation.flags.map((f) => f.code)).toContain('sponsorship_conflict');
    expect(await t.market.reviews.col.countDocuments({ 'entity.id': job._id })).toBe(0);
  });
});

describe('3dfe3c5 (1) and L-e through ingestion', () => {
  it('an HTML table never yields a stated value (column shift)', async () => {
    const r = await t.market.jobPipeline.process({
      source: official,
      locator: '/jobs/tbl1',
      payload: {
        externalId: 'tbl1',
        title: 'Platform Engineer table',
        descriptionHtml:
          '<p>Join us.</p><table><tr><th>Benefit</th><th>Full-time</th><th>Contractor</th></tr><tr><td>Visa sponsorship:</td><td></td><td>No</td></tr></table>',
        locations: [{ text: 'London, United Kingdom' }],
        provider: { name: 'greenhouse', boardToken: 'acme-statements' },
      },
      parser: { name: 'test', version: '1' },
    });
    const j = await t.market.jobs.get((r as { jobId: string }).jobId);
    expect(j.content.descriptionText).toContain('Visa sponsorship: No');
    expect(j.interpretation.flags.map((f) => f.code)).not.toContain('sponsorship_stated');
    expect(j.interpretation.flags.map((f) => f.code)).toContain('sponsorship_mentioned');
  });

  it('a cross-copy stated "no" counts like the primary copy\'s for company confidence and role_overrides_company', async () => {
    await t.market.companies.col.updateOne(
      { _id: companyId },
      { $set: { 'employment.sponsorship.licenceCountries': ['GB'] } },
    );
    try {
      const url = 'https://jobs.example.com/acme/le-1';
      const job = await copy(official, 'le1', 'Join us.\n\nWe build payments software.', url);
      expect(job.immigration.sponsorship).toMatchObject({
        value: { status: 'company_capable' },
        confidence: { level: 'medium' },
      });
      const after = await copy(aggregator, 'le1-agg', 'Join us.\n\nVisa sponsorship: No', url);
      expect(after.immigration.sponsorship).toMatchObject({
        value: { status: 'company_capable' },
        confidence: { level: 'low' },
      });
      expect(after.interpretation.flags.map((f) => f.code)).toContain('sponsorship_role_overrides_company');
    } finally {
      await t.market.companies.col.updateOne(
        { _id: companyId },
        { $set: { 'employment.sponsorship.licenceCountries': [] } },
      );
    }
  });
});

describe('a720377 (1): the production path — the real adapters', () => {
  const TABLE =
    '<p>Join us.</p><table><tr><th>Benefit</th><th>Full-time</th><th>Contractor</th></tr><tr><td>Visa sponsorship:</td><td></td><td>No</td></tr></table>';

  async function ingest(source: SourceDoc, payload: JobObservationPayload, tag: string) {
    const r = await t.market.jobPipeline.process({
      source,
      locator: `/jobs/${tag}`,
      payload: { ...payload, locations: [{ text: 'London, United Kingdom' }] },
      parser: { name: 'test', version: '1' },
    });
    if (!('jobId' in r) || !r.jobId) throw new Error(`job not created: ${r.outcome}`);
    return t.market.jobs.get(r.jobId);
  }
  const codes = (j: JobDoc) => j.interpretation.flags.map((f) => f.code);
  const expectLayoutMention = (j: JobDoc) => {
    expect(codes(j)).not.toContain('sponsorship_stated');
    expect(codes(j)).toContain('sponsorship_mentioned');
    // The mention cites the canonical rendering, labelled as such.
    expect(j.immigration.sponsorship.evidence.map((e) => e.locator)).toContainEqual(
      expect.stringMatching(/#description\.html_layout\[\d+:\d+\]$/),
    );
  };

  it('Greenhouse: the connector text reads "Visa sponsorship:No", the statement rendering marks it layout', async () => {
    const listing = greenhouseAdapter.parseListing(
      {
        jobs: [
          {
            id: 7001,
            title: 'Platform Engineer gh-table',
            absolute_url: 'https://job-boards.greenhouse.io/acme-statements/jobs/7001',
            location: { name: 'London, United Kingdom' },
            content: TABLE,
            updated_at: '2026-09-01T10:00:00Z',
          },
        ],
      },
      { boardToken: 'acme-statements' },
    );
    const payload = listing.jobs[0]!.payload;
    expect(payload.descriptionText).toContain('Visa sponsorship:No');
    const job = await ingest(official, payload, 'gh-table');
    // The stored description text is the connector's, unchanged (no hash churn).
    expect(job.content.descriptionText).toBe(payload.descriptionText);
    expectLayoutMention(job);
  });

  it('Lever, Ashby (HTML next to descriptionPlain), the aggregator feed and JSON-LD', async () => {
    const lever = leverAdapter.parseListing(
      [
        {
          id: 'lv-table-1',
          text: 'Platform Engineer lever-table',
          categories: { location: 'London, United Kingdom', allLocations: ['London, United Kingdom'] },
          createdAt: 1756130400000,
          description: TABLE,
          descriptionPlain: 'Join us.\nBenefit Full-time Contractor\nVisa sponsorship: No',
          lists: [],
          hostedUrl: 'https://jobs.lever.co/acme-statements/lv-table-1',
          applyUrl: 'https://jobs.lever.co/acme-statements/lv-table-1/apply',
        },
      ],
      { boardToken: 'acme-statements' },
    );
    expectLayoutMention(await ingest(official, lever.jobs[0]!.payload, 'lever-table'));
    const ashby = ashbyAdapter.parseListing(
      {
        jobs: [
          {
            id: 'as-table-1',
            title: 'Platform Engineer ashby-table',
            location: 'London, United Kingdom',
            isListed: true,
            publishedAt: '2026-09-08T14:03:21.118+00:00',
            jobUrl: 'https://jobs.ashbyhq.com/acme-statements/as-table-1',
            applyUrl: 'https://jobs.ashbyhq.com/acme-statements/as-table-1/application',
            descriptionHtml: TABLE,
            // Ashby's plain rendering puts the key and the Contractor value on one line.
            descriptionPlain: 'Join us.\nBenefit Full-time Contractor\nVisa sponsorship: No',
          },
        ],
      },
      { boardToken: 'acme-statements' },
    );
    const ashbyPayload = ashby.jobs[0]!.payload;
    expect(ashbyPayload.descriptionText).toContain('Visa sponsorship: No');
    expectLayoutMention(await ingest(official, ashbyPayload, 'ashby-table'));
    const feed = parseAggregatorFeed({
      jobs: [
        {
          id: 'agg-table-1',
          company: 'Acme Statements Ltd',
          title: 'Platform Engineer agg-table',
          location: 'London, United Kingdom',
          url: 'https://jobhub.example.com/jobs/agg-table-1',
          description: TABLE,
        },
      ],
    });
    expectLayoutMention(await ingest(aggregator, feed.jobs[0]!.payload, 'agg-table'));
    const [posting] = extractJsonLdJobPostings(
      `<html><head><script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'JobPosting',
        title: 'Platform Engineer jsonld-table',
        identifier: 'ld-table-1',
        description: TABLE,
        url: 'https://acme.example.com/careers/ld-table-1',
      })}</script></head><body></body></html>`,
      'https://acme.example.com/careers/ld-table-1',
    );
    expectLayoutMention(await ingest(official, posting!, 'jsonld-table'));
  });

  it('a plain-text-only copy is read as text, and says so (the residual: no layout without HTML)', async () => {
    const r = await t.market.jobPipeline.process({
      source: official,
      locator: '/jobs/plain-only',
      payload: {
        externalId: 'plain-only',
        title: 'Platform Engineer plain-only',
        descriptionText: 'Join us.\n\nVisa sponsorship: No',
        locations: [{ text: 'London, United Kingdom' }],
        provider: { name: 'greenhouse', boardToken: 'acme-statements' },
      },
      parser: { name: 'test', version: '1' },
    });
    const j = await t.market.jobs.get((r as { jobId: string }).jobId);
    const stated = j.interpretation.flags.find((f) => f.code === 'sponsorship_stated');
    expect(stated).toMatchObject({ value: 'no', evidence: { rendering: 'description_text' } });
    expect(j.content.descriptionText.slice(stated!.evidence!.start, stated!.evidence!.end)).toBe(
      'Visa sponsorship: No',
    );
  });
});

describe('a720377 (2)/(3): legacy closures re-ask once; decisions survive merges and field_conflict', () => {
  /** Mimic an item closed (and a job decided) before 3dfe3c5: no hash, no stating set, no decision. */
  async function makeLegacy(itemId: string, jobId: string) {
    await t.market.reviews.col.updateOne(
      { _id: itemId },
      { $unset: { 'context.evidenceHash': '', 'context.evidenceVersion': '', 'context.stating': '' } },
    );
    await t.market.jobs.col.updateOne({ _id: jobId }, { $unset: { sponsorshipDecision: '' } });
  }

  it("the reviewer's legacy sequence: one new open item, then the new decision holds until new evidence", async () => {
    const url = 'https://jobs.example.com/acme/legacy-1';
    const job = await copy(official, 'lg1', 'Join us.\n\nVisa sponsorship: Yes', url);
    await copy(aggregator, 'lg1-agg', 'Join us.\n\nVisa sponsorship: No', url);
    const legacy = await resolveConflict(job._id, 'dismiss');
    await makeLegacy(legacy._id, job._id);
    // A third copy (new observation) stating "No".
    await copy(officialB, 'lg1-lever', 'Join us.\n\nVisa sponsorship: No', url);
    const [fresh, ...more] = await openConflicts(job._id);
    expect(more).toHaveLength(0);
    expect(fresh!._id).not.toBe(legacy._id);
    expect(typeof fresh!.context.evidenceHash).toBe('string');
    // The operator decides the new item; sightings and reconciles ask nothing more …
    await resolveConflict(job._id, 'dismiss');
    await tick();
    await copy(officialB, 'lg1-lever', 'Join us.\n\nVisa sponsorship: No', url);
    await reconcile(job._id);
    expect(await openConflicts(job._id)).toHaveLength(0);
    // … until new evidence arrives: the third copy now states another value.
    await tick();
    await copy(officialB, 'lg1-lever', 'Join our team.\n\nVisa sponsorship: Yes', url);
    expect(await openConflicts(job._id)).toHaveLength(1);
  });

  it('a legacy dismissed salary_suspicious item is asked once more; a legacy one on a CLOSED job is not', async () => {
    const salary = (id: string) =>
      t.market.reviews.col.find({ type: 'salary_suspicious', 'entity.id': id }).toArray();
    const open = await copy(
      official,
      'lgs1',
      'Join us.\n\nSalary: $90,000 - $110,000',
      'https://jobs.example.com/acme/lgs-1',
    );
    const [item] = await salary(open._id);
    await t.market.reviewService.resolve(item!._id, { action: 'dismiss', reason: 'fine' }, t.actor);
    await makeLegacy(item!._id, open._id);
    await reconcile(open._id);
    expect((await salary(open._id)).filter((i) => i.status === 'open')).toHaveLength(1);
    const [again] = (await salary(open._id)).filter((i) => i.status === 'open');
    await t.market.reviewService.resolve(again!._id, { action: 'dismiss', reason: 'still fine' }, t.actor);
    await reconcile(open._id);
    expect(await salary(open._id)).toHaveLength(2);

    const closed = await copy(
      official,
      'lgs2',
      'Join us.\n\nSalary: $90,000 - $110,000',
      'https://jobs.example.com/acme/lgs-2',
    );
    const [c] = await salary(closed._id);
    await t.market.reviewService.resolve(c!._id, { action: 'dismiss', reason: 'fine' }, t.actor);
    await makeLegacy(c!._id, closed._id);
    await t.market.jobs.col.updateOne({ _id: closed._id }, { $set: { 'lifecycle.state': 'CLOSED' } });
    await reconcile(closed._id);
    expect(await salary(closed._id)).toHaveLength(1);
  });

  it('a legacy OPEN item never refreshed under the new code: its decision records nothing and it is asked again', async () => {
    const url = 'https://jobs.example.com/acme/legacy-open-1';
    const job = await copy(official, 'lo1', 'Join us.\n\nVisa sponsorship: Yes', url);
    await copy(aggregator, 'lo1-agg', 'Join us.\n\nVisa sponsorship: No', url);
    const [item] = await openConflicts(job._id);
    await makeLegacy(item!._id, job._id);
    await t.market.reviewService.resolve(
      item!._id,
      { action: 'confirm', reason: 'operator confirmed' },
      t.actor,
    );
    const j = await t.market.jobs.get(job._id);
    expect(j.sponsorshipDecision).toBeUndefined();
    // Asked again on the job's next reconciliation (any sighting or re-interpretation).
    await reconcile(job._id);
    const [asked] = await openConflicts(job._id);
    expect(asked).toBeDefined();
    expect(asked!._id).not.toBe(item!._id);
    expect(Array.isArray(asked!.context.stating)).toBe(true);
  });

  it('a sponsorship correction through a field_conflict item records a decision', async () => {
    const url = 'https://jobs.example.com/acme/fc-correct-1';
    const job = await copy(official, 'fc1', 'Join us.\n\nVisa sponsorship: Yes', url);
    await copy(aggregator, 'fc1-agg', 'Join us.\n\nVisa sponsorship: No', url);
    const fc = await t.market.reviews.col.findOne({
      type: 'field_conflict',
      'entity.id': job._id,
      status: 'open',
      'context.fields': 'immigration.sponsorship',
    });
    expect(Array.isArray(fc?.context.stating)).toBe(true);
    await t.market.reviewService.resolve(
      fc!._id,
      {
        action: 'correct',
        reason: 'hiring manager confirmed',
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
    const j = await t.market.jobs.get(job._id);
    expect(j.sponsorshipDecision).toMatchObject({ action: 'correct', reviewItemId: fc!._id });
    expect(j.interpretation.flags.map((f) => f.code)).toContain('sponsorship_conflict_decided');
    // The employment_conflict question is answered too: closed by the system, none open.
    expect(await openConflicts(job._id)).toHaveLength(0);
  });

  it("a job merge keeps a sponsorship decision (the merged job's when the survivor has none)", async () => {
    const survivor = await copy(
      official,
      'mg-s',
      'Join us.\n\nPension.',
      'https://jobs.example.com/acme/mg-s',
    );
    const url = 'https://jobs.example.com/acme/mg-m';
    const mergedAway = await copy(officialB, 'mg-m', 'Join us.\n\nVisa sponsorship: Yes', url);
    await copy(aggregator, 'mg-m-agg', 'Join us.\n\nVisa sponsorship: No', url);
    const decided = await resolveConflict(mergedAway._id, 'confirm');
    expect((await t.market.jobs.get(mergedAway._id)).sponsorshipDecision).toBeDefined();
    const { item: dup } = await t.market.reviews.raise({
      type: 'job_duplicate',
      severity: 'medium',
      dedupeKey: `test:dup:${survivor._id}`,
      entity: { kind: 'job', id: survivor._id },
      subject: 'possible duplicate',
      reason: 'test',
      candidates: [{ kind: 'job', id: mergedAway._id, label: 'M' }],
      allowedActions: ['merge', 'keep_separate', 'dismiss'],
    });
    await t.market.reviewService.resolve(
      dup._id,
      { action: 'merge', reason: 'same', targetId: mergedAway._id },
      t.actor,
    );
    const j = await t.market.jobs.get(survivor._id);
    expect(j.sponsorshipDecision).toMatchObject({ action: 'confirm', reviewItemId: decided._id });
    // The decided copies are the same ones: still decided, nothing re-raised.
    expect(j.interpretation.flags.map((f) => f.code)).toContain('sponsorship_conflict_decided');
    expect(await openConflicts(survivor._id)).toHaveLength(0);
  });

  it('a dismissed work-model conflict is not re-raised by a sponsorship change on another copy (L2)', async () => {
    const url = 'https://jobs.example.com/acme/wm-1';
    const text =
      'This is a fully remote role.\nThis role is fully on-site in our London office five days a week.';
    const job = await copy(official, 'wm1', text, url);
    const wm = () =>
      t.market.reviews.col
        .find({ type: 'employment_conflict', 'entity.id': job._id, 'context.flag': 'work_model_conflict' })
        .toArray();
    const [item] = await wm();
    expect(item).toBeDefined();
    await t.market.reviewService.resolve(item!._id, { action: 'dismiss', reason: 'fine' }, t.actor);
    await tick();
    // A sponsorship statement on another copy (which raises no work-model flag) is not the
    // flag's evidence; a newer sighting of the same copy neither.
    await copy(aggregator, 'wm1-agg', 'Join us.\n\nVisa sponsorship: No', url);
    await copy(official, 'wm1', text, url);
    expect(await wm()).toHaveLength(1);
  });
});

describe("5a13fed: digests independent of the primary; the interpretation's own reading; plain text", () => {
  it('two equal-authority copies with alternating sightings, dismissed once: no new field_conflict while the set is unchanged (H-B)', async () => {
    const url = 'https://jobs.example.com/acme/alt-1';
    const a = 'Join us.\n\nSalary: £50,000 - £60,000';
    const b = 'Join us.\n\nSalary: £70,000 - £80,000';
    const job = await copy(official, 'alt-a', a, url);
    await copy(officialB, 'alt-b', b, url);
    const items = () => t.market.reviews.col.find({ type: 'field_conflict', 'entity.id': job._id }).toArray();
    const [item, ...more] = await items();
    expect(more).toHaveLength(0);
    expect(item!.context.fields).toContain('compensation');
    await t.market.reviewService.resolve(item!._id, { action: 'dismiss', reason: 'both are fine' }, t.actor);
    for (const [src, tag, text] of [
      [official, 'alt-a', a],
      [officialB, 'alt-b', b],
      [official, 'alt-a', a],
      [officialB, 'alt-b', b],
    ] as const) {
      await tick();
      await copy(src, tag, text, url);
    }
    expect(await items()).toHaveLength(1);
    // A changed reading is new evidence: asked again.
    await tick();
    await copy(officialB, 'alt-b', 'Join us.\n\nSalary: £75,000 - £85,000', url);
    expect((await items()).filter((i) => i.status === 'open')).toHaveLength(1);
  });

  it("a work-model correction does not ask the question again (M2, the reviewer's P1)", async () => {
    const text =
      'This is a fully remote role.\nThis role is fully on-site in our London office five days a week.';
    const job = await copy(official, 'p1', text, 'https://jobs.example.com/acme/p1');
    const wm = () =>
      t.market.reviews.col
        .find({ type: 'employment_conflict', 'entity.id': job._id, 'context.flag': 'work_model_conflict' })
        .toArray();
    const [item] = await wm();
    await t.market.reviewService.resolve(
      item!._id,
      { action: 'correct', reason: 'the team confirmed remote', field: 'workModel', value: 'remote' },
      t.actor,
    );
    await reconcile(job._id);
    await reconcile(job._id);
    expect((await t.market.jobs.get(job._id)).geography.workModel.value).toBe('remote');
    expect(await wm()).toHaveLength(1);
  });

  it('the anti-signal line is part of the work_model_anti_signal digest (L-e)', async () => {
    const url = 'https://jobs.example.com/acme/anti-1';
    const job = await copy(
      official,
      'anti1',
      'This is a fully remote role.\n\nWho should not apply\nIf you want to work remotely, this role is not for you.',
      url,
    );
    const anti = () =>
      t.market.reviews.col
        .find({ type: 'employment_conflict', 'entity.id': job._id, 'context.flag': 'work_model_anti_signal' })
        .toArray();
    const [item] = await anti();
    expect(item).toBeDefined();
    await t.market.reviewService.resolve(item!._id, { action: 'dismiss', reason: 'fine as is' }, t.actor);
    await tick();
    await copy(
      official,
      'anti1',
      'This is a fully remote role.\n\nWho should not apply\nIf you want to work remotely, this job is not for you.',
      url,
    );
    expect((await anti()).filter((i) => i.status === 'open')).toHaveLength(1);
  });

  it('a correct on a legacy conflict item reports askAgain, and the re-raised item says why (L-b)', async () => {
    const url = 'https://jobs.example.com/acme/lb-1';
    const job = await copy(official, 'lb1', 'Join us.\n\nVisa sponsorship: Yes', url);
    await copy(aggregator, 'lb1-agg', 'Join us.\n\nVisa sponsorship: No', url);
    const [item] = await openConflicts(job._id);
    await t.market.reviews.col.updateOne(
      { _id: item!._id },
      { $unset: { 'context.evidenceHash': '', 'context.evidenceVersion': '', 'context.stating': '' } },
    );
    const closed = await t.market.reviewService.resolve(
      item!._id,
      {
        action: 'correct',
        reason: 'hiring manager confirmed',
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
    expect(closed.resolution?.result).toMatchObject({ overridden: 'sponsorship', askAgain: true });
    expect((await t.market.jobs.get(job._id)).sponsorshipDecision).toBeUndefined();
    await reconcile(job._id);
    const [asked] = await openConflicts(job._id);
    expect(asked!.reason).toContain(ASKED_AGAIN);
  });

  it('tagless descriptions through the aggregator, JSON-LD and Greenhouse keep their lines (M1)', async () => {
    const plain = 'US applicants\nVisa sponsorship: No\nUK applicants\nVisa sponsorship: Yes';
    const feed = parseAggregatorFeed({
      jobs: [
        {
          id: 'agg-plain-1',
          company: 'Acme Statements Ltd',
          title: 'Platform Engineer agg-plain',
          location: 'London, United Kingdom',
          url: 'https://jobhub.example.com/jobs/agg-plain-1',
          description: plain,
        },
      ],
    });
    const payload = feed.jobs[0]!.payload;
    expect(payload.descriptionHtml).toBe(plain);
    const r = await t.market.jobPipeline.process({
      source: aggregator,
      locator: '/jobs/agg-plain-1',
      payload,
      parser: { name: 'test', version: '1' },
    });
    const j = await t.market.jobs.get((r as { jobId: string }).jobId);
    expect(
      j.interpretation.flags
        .filter((f) => f.code === 'sponsorship_stated')
        .map((f) => f.value)
        .sort(),
    ).toEqual(['no', 'yes']);
    expect(j.interpretation.flags.map((f) => f.code)).toContain('sponsorship_conflict');
    expect(await openConflicts(j._id)).toHaveLength(1);
    const [posting] = extractJsonLdJobPostings(
      `<html><head><script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'JobPosting',
        title: 'Platform Engineer jsonld-plain',
        identifier: 'ld-plain-1',
        description: 'Role: Platform Engineer\nVisa sponsorship: No',
        url: 'https://acme.example.com/careers/ld-plain-1',
      })}</script></head><body></body></html>`,
      'https://acme.example.com/careers/ld-plain-1',
    );
    const ld = await t.market.jobPipeline.process({
      source: official,
      locator: '/jobs/ld-plain-1',
      payload: { ...posting!, locations: [{ text: 'London, United Kingdom' }] },
      parser: { name: 'test', version: '1' },
    });
    const ldJob = await t.market.jobs.get((ld as { jobId: string }).jobId);
    expect(ldJob.interpretation.flags.find((f) => f.code === 'sponsorship_stated')).toMatchObject({
      value: 'no',
      evidence: { rendering: 'description_text' },
    });
    const gh = greenhouseAdapter.parseListing(
      {
        jobs: [
          {
            id: 7002,
            title: 'Platform Engineer gh-plain',
            absolute_url: 'https://job-boards.greenhouse.io/acme-statements/jobs/7002',
            location: { name: 'London, United Kingdom' },
            content: 'Role: Platform Engineer\nVisa sponsorship: Yes',
            updated_at: '2026-09-01T10:00:00Z',
          },
        ],
      },
      { boardToken: 'acme-statements' },
    );
    const ghr = await t.market.jobPipeline.process({
      source: official,
      locator: '/jobs/gh-plain',
      payload: { ...gh.jobs[0]!.payload, locations: [{ text: 'London, United Kingdom' }] },
      parser: { name: 'test', version: '1' },
    });
    const ghJob = await t.market.jobs.get((ghr as { jobId: string }).jobId);
    expect(ghJob.interpretation.flags.find((f) => f.code === 'sponsorship_stated')).toMatchObject({
      value: 'yes',
    });
  });

  it('struck and hidden statements through Ashby are mentions (H-A, M3)', async () => {
    const ashby = ashbyAdapter.parseListing(
      {
        jobs: [
          {
            id: 'as-struck-1',
            title: 'Platform Engineer ashby-struck',
            location: 'London, United Kingdom',
            isListed: true,
            publishedAt: '2026-09-08T14:03:21.118+00:00',
            jobUrl: 'https://jobs.ashbyhq.com/acme-statements/as-struck-1',
            applyUrl: 'https://jobs.ashbyhq.com/acme-statements/as-struck-1/application',
            descriptionHtml:
              '<p>We build payments.</p><p><s>Visa sponsorship: Yes</s></p><div hidden><p>Visa sponsorship: Yes</p></div><p>We are unable to sponsor visas for this role.</p>',
          },
        ],
      },
      { boardToken: 'acme-statements' },
    );
    const r = await t.market.jobPipeline.process({
      source: official,
      locator: '/jobs/as-struck-1',
      payload: { ...ashby.jobs[0]!.payload, locations: [{ text: 'London, United Kingdom' }] },
      parser: { name: 'test', version: '1' },
    });
    const j = await t.market.jobs.get((r as { jobId: string }).jobId);
    expect(j.interpretation.flags.map((f) => f.code)).not.toContain('sponsorship_stated');
    expect(j.interpretation.flags.map((f) => f.code)).toContain('sponsorship_mentioned');
  });
});

describe('7f01fe5: per-copy flag digests, any earlier decision, digest versions', () => {
  it('two official copies that word a work-model conflict differently, alternating sightings, a dismissal after each: one item (H3)', async () => {
    const url = 'https://jobs.example.com/acme/h3-1';
    const a =
      'This is a fully remote role.\nThis role is fully on-site in our London office five days a week.';
    const b =
      'This is a fully remote role.\nThis role is fully on-site in our London office, five days a week.';
    const job = await copy(official, 'h3-a', a, url);
    await copy(officialB, 'h3-b', b, url);
    const items = () =>
      t.market.reviews.col
        .find({ type: 'employment_conflict', 'entity.id': job._id, 'context.flag': 'work_model_conflict' })
        .toArray();
    const dismissOpen = async () => {
      for (const i of (await items()).filter((x) => x.status === 'open'))
        await t.market.reviewService.resolve(i._id, { action: 'dismiss', reason: 'known wording' }, t.actor);
    };
    await dismissOpen();
    for (const [src, tag, text] of [
      [official, 'h3-a', a],
      [officialB, 'h3-b', b],
      [official, 'h3-a', a],
      [officialB, 'h3-b', b],
    ] as const) {
      await tick();
      await copy(src, tag, text, url);
      await dismissOpen();
    }
    expect(await items()).toHaveLength(1);
  });

  it("evidence flapping between two decided states asks nothing more (M2, the reviewer's A/B/C)", async () => {
    // A = {official yes, aggregator no} and B = {official no, aggregator yes}: neither is a
    // subset of the other, so only "any earlier decision" (not the latest) settles A again.
    const url = 'https://jobs.example.com/acme/flap-1';
    const yes = 'Join us.\n\nVisa sponsorship: Yes';
    const no = 'Join us.\n\nVisa sponsorship: No';
    const state = async (officialText: string, aggregatorText: string) => {
      await tick();
      await copy(official, 'fl1', officialText, url);
      await copy(aggregator, 'fl1-agg', aggregatorText, url);
    };
    const job = await copy(official, 'fl1', yes, url);
    await copy(aggregator, 'fl1-agg', no, url);
    await resolveConflict(job._id, 'dismiss'); // A decided
    await state(no, yes);
    await resolveConflict(job._id, 'dismiss'); // B decided
    for (const [o, g] of [
      [yes, no], // A
      [no, yes], // B
      [yes, no], // A again (C)
    ] as const) {
      await state(o, g);
      expect(await openConflicts(job._id)).toHaveLength(0);
    }
    expect(
      await t.market.reviews.col.countDocuments({ type: 'employment_conflict', 'entity.id': job._id }),
    ).toBe(2);
  });

  it('a legacy field_conflict sponsorship correction reports askAgain (L4)', async () => {
    const url = 'https://jobs.example.com/acme/l4-1';
    const job = await copy(official, 'l4', 'Join us.\n\nVisa sponsorship: Yes', url);
    await copy(aggregator, 'l4-agg', 'Join us.\n\nVisa sponsorship: No', url);
    const fc = await t.market.reviews.col.findOne({
      type: 'field_conflict',
      'entity.id': job._id,
      status: 'open',
      'context.fields': 'immigration.sponsorship',
    });
    await t.market.reviews.col.updateOne(
      { _id: fc!._id },
      { $unset: { 'context.evidenceHash': '', 'context.evidenceVersion': '', 'context.stating': '' } },
    );
    const closed = await t.market.reviewService.resolve(
      fc!._id,
      {
        action: 'correct',
        reason: 'hiring manager confirmed',
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
    expect(closed.resolution?.result).toMatchObject({ overridden: 'sponsorship', askAgain: true });
    expect((await t.market.jobs.get(job._id)).sponsorshipDecision).toBeUndefined();
  });

  it('a decision recorded under an older digest version is asked once more, saying why (L5)', async () => {
    const job = await copy(
      official,
      'l5',
      'Join us.\n\nSalary: $90,000 - $110,000',
      'https://jobs.example.com/acme/l5',
    );
    const salary = () =>
      t.market.reviews.col.find({ type: 'salary_suspicious', 'entity.id': job._id }).toArray();
    const [item] = await salary();
    await t.market.reviewService.resolve(item!._id, { action: 'dismiss', reason: 'fine as is' }, t.actor);
    await reconcile(job._id);
    expect(await salary()).toHaveLength(1);
    // As recorded by f0e4e4a: a hash, no digest version.
    await t.market.reviews.col.updateOne({ _id: item!._id }, { $unset: { 'context.evidenceVersion': '' } });
    await reconcile(job._id);
    const again = (await salary()).filter((i) => i.status === 'open');
    expect(again).toHaveLength(1);
    expect(again[0]!.reason).toContain(ASKED_AGAIN);
    expect(again[0]!.context.evidenceVersion).toBe(REVIEW_EVIDENCE_VERSION);
    await t.market.reviewService.resolve(again[0]!._id, { action: 'dismiss', reason: 'still fine' }, t.actor);
    await reconcile(job._id);
    expect(await salary()).toHaveLength(2);
  });
});

describe('bc013e8: what is shown is what is decided; any copy raises; copies, not observations', () => {
  const wmItems = (jobId: string, flag = 'work_model_conflict') =>
    t.market.reviews.col
      .find({ type: 'employment_conflict', 'entity.id': jobId, 'context.flag': flag })
      .toArray();
  const V1 =
    'This is a fully remote role.\nThis role is fully on-site in our London office five days a week.';
  const V2 = 'This is a fully remote role.\nThis role is hybrid, 3 days a week in our London office.';

  it("the reviewer's V1→V2 edit while open: the item shows V2, so dismissing it decides V2 (M2)", async () => {
    const url = 'https://jobs.example.com/acme/m2-1';
    const job = await copy(official, 'm2', V1, url);
    const [item] = await wmItems(job._id);
    expect(item!.evidence.map((e) => e.quote)).toContain(
      'This role is fully on-site in our London office five days a week.',
    );
    await tick();
    await copy(official, 'm2', V2, url);
    const [shown] = await wmItems(job._id);
    // Refreshed together: the shown lines, the observations and the digest.
    expect(shown!._id).toBe(item!._id);
    expect(shown!.evidence.map((e) => e.quote)).toContain(
      'This role is hybrid, 3 days a week in our London office.',
    );
    expect(shown!.evidence.map((e) => e.quote)).not.toContain(
      'This role is fully on-site in our London office five days a week.',
    );
    const v2Obs = (await t.market.jobs.get(job._id)).content.primaryObservationId;
    expect(shown!.observationIds).toEqual([v2Obs]);
    expect(shown!.context.evidenceHash).not.toBe(item!.context.evidenceHash);
    await t.market.reviewService.resolve(item!._id, { action: 'dismiss', reason: 'hybrid is fine' }, t.actor);
    await tick();
    await copy(official, 'm2', V2, url);
    expect(await wmItems(job._id)).toHaveLength(1);
  });

  it('If-Match: a decision on evidence that changed since it was shown is refused (M2)', async () => {
    const url = 'https://jobs.example.com/acme/m2-2';
    const job = await copy(official, 'm2b', V1, url);
    const [item] = await wmItems(job._id);
    const shownHash = String(item!.context.evidenceHash);
    await tick();
    await copy(official, 'm2b', V2, url);
    await expect(
      t.market.reviewService.resolve(
        item!._id,
        { action: 'dismiss', reason: 'fine as shown', evidenceHash: shownHash },
        t.actor,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    const current = String((await t.market.reviews.get(item!._id)).context.evidenceHash);
    const closed = await t.market.reviewService.resolve(
      item!._id,
      { action: 'dismiss', reason: 'fine as shown', evidenceHash: current },
      t.actor,
    );
    expect(closed.context.evidenceHash).toBe(current);
  });

  it('a work-model flag raised by one copy only: one item while it is present, no system churn (M3)', async () => {
    const url = 'https://jobs.example.com/acme/m3-1';
    const job = await copy(official, 'm3-a', V1, url);
    await copy(officialB, 'm3-b', 'This is a fully remote role.', url);
    for (const [src, tag, text] of [
      [official, 'm3-a', V1],
      [officialB, 'm3-b', 'This is a fully remote role.'],
      [official, 'm3-a', V1],
      [officialB, 'm3-b', 'This is a fully remote role.'],
    ] as const) {
      await tick();
      await copy(src, tag, text, url);
    }
    const items = await wmItems(job._id);
    expect(items).toHaveLength(1);
    expect(items[0]!.status).toBe('open');
  });

  it('the "asked again" suffix survives later reconciles until a current decision (L1)', async () => {
    const job = await copy(
      official,
      'l1s',
      'Join us.\n\nSalary: $90,000 - $110,000',
      'https://jobs.example.com/acme/l1s',
    );
    const salary = () =>
      t.market.reviews.col.find({ type: 'salary_suspicious', 'entity.id': job._id }).toArray();
    const [item] = await salary();
    await t.market.reviewService.resolve(item!._id, { action: 'dismiss', reason: 'fine as is' }, t.actor);
    await t.market.reviews.col.updateOne({ _id: item!._id }, { $unset: { 'context.evidenceVersion': '' } });
    await reconcile(job._id);
    await reconcile(job._id);
    await reconcile(job._id);
    const [open] = (await salary()).filter((i) => i.status === 'open');
    expect(open!.reason).toContain(ASKED_AGAIN);
  });

  it('a metadata-only re-observation, or an edit that leaves the reading alone, does not re-ask (L2)', async () => {
    const url = 'https://jobs.example.com/acme/l2-1';
    const ingest = (descriptionText: string, sourceUpdatedAt: string) =>
      t.market.jobPipeline.process({
        source: official,
        locator: '/jobs/l2-1',
        payload: {
          externalId: 'l2-1',
          title: 'Platform Engineer l2-1',
          descriptionText,
          locations: [{ text: 'London, United Kingdom' }],
          postingUrl: url,
          sourceUpdatedAt,
          provider: { name: 'greenhouse', boardToken: 'acme-statements' },
        },
        parser: { name: 'test', version: '1' },
      });
    const r = await ingest(V1, '2026-09-01T00:00:00Z');
    const jobId = (r as { jobId: string }).jobId;
    const [item] = await wmItems(jobId);
    await t.market.reviewService.resolve(item!._id, { action: 'dismiss', reason: 'known' }, t.actor);
    await tick();
    await ingest(V1, '2026-09-02T00:00:00Z'); // new observation, same text
    await tick();
    await ingest(`${V1}\nWe offer a pension.`, '2026-09-03T00:00:00Z'); // an edit elsewhere
    expect(await wmItems(jobId)).toHaveLength(1);
    // A changed reading is new evidence.
    await tick();
    await ingest(V2, '2026-09-04T00:00:00Z');
    expect((await wmItems(jobId)).filter((i) => i.status === 'open')).toHaveLength(1);
  });
});

describe('bc013e8 M4 across copies', () => {
  it('a copy\'s "H-1B sponsorship: No" does not count against a GB licence for a London + New York job', async () => {
    await t.market.companies.col.updateOne(
      { _id: companyId },
      { $set: { 'employment.sponsorship.licenceCountries': ['GB'] } },
    );
    try {
      const url = 'https://jobs.example.com/acme/m4x-1';
      const ingest = (source: SourceDoc, externalId: string, descriptionText: string) =>
        t.market.jobPipeline.process({
          source,
          locator: `/jobs/${externalId}`,
          payload: {
            externalId,
            title: 'Platform Engineer m4x',
            descriptionText,
            locations: [{ text: 'London, United Kingdom' }, { text: 'New York, NY, United States' }],
            postingUrl: url,
            provider: { name: source.provider, boardToken: source.endpoint?.boardToken ?? 'feed' },
          },
          parser: { name: 'test', version: '1' },
        });
      const r = await ingest(official, 'm4x', 'Join us.\n\nWe build payments software.');
      await ingest(aggregator, 'm4x-agg', 'Join us.\n\nH-1B sponsorship: No');
      const j = await t.market.jobs.get((r as { jobId: string }).jobId);
      expect(j.sourceRefs).toHaveLength(2);
      expect(j.immigration.sponsorship).toMatchObject({
        value: { status: 'company_capable' },
        confidence: { level: 'medium' },
      });
      expect(j.interpretation.flags.map((f) => f.code)).not.toContain('sponsorship_role_overrides_company');
    } finally {
      await t.market.companies.col.updateOne(
        { _id: companyId },
        { $set: { 'employment.sponsorship.licenceCountries': [] } },
      );
    }
  });
});

describe('re-verify #14 L4 across copies', () => {
  it('a copy\'s Blue Card "No" for a Berlin + London job does not touch a GB + NL licence', async () => {
    await t.market.companies.col.updateOne(
      { _id: companyId },
      { $set: { 'employment.sponsorship.licenceCountries': ['GB', 'NL'] } },
    );
    try {
      const url = 'https://jobs.example.com/acme/l4x-1';
      const ingest = (source: SourceDoc, externalId: string, descriptionText: string) =>
        t.market.jobPipeline.process({
          source,
          locator: `/jobs/${externalId}`,
          payload: {
            externalId,
            title: 'Platform Engineer l4x',
            descriptionText,
            locations: [{ text: 'Berlin, Germany' }, { text: 'London, United Kingdom' }],
            postingUrl: url,
            provider: { name: source.provider, boardToken: source.endpoint?.boardToken ?? 'feed' },
          },
          parser: { name: 'test', version: '1' },
        });
      const r = await ingest(official, 'l4x', 'Join us.\n\nWe build payments software.');
      await ingest(aggregator, 'l4x-agg', 'Join us.\n\nEU Blue Card sponsorship: No');
      const j = await t.market.jobs.get((r as { jobId: string }).jobId);
      expect(j.sourceRefs).toHaveLength(2);
      expect(j.immigration.sponsorship).toMatchObject({
        value: { status: 'company_capable' },
        confidence: { level: 'medium' },
      });
      expect(j.interpretation.flags.map((f) => f.code)).not.toContain('sponsorship_role_overrides_company');
    } finally {
      await t.market.companies.col.updateOne(
        { _id: companyId },
        { $set: { 'employment.sponsorship.licenceCountries': [] } },
      );
    }
  });
});

describe('re-verify #14: the claim is a compare-and-set; stating by copy; scoped conflicts', () => {
  /** Run `during` between resolve's check and its claim (the reviewer's race). */
  async function withRaceBeforeClaim<T>(during: () => Promise<unknown>, run: () => Promise<T>): Promise<T> {
    const service = t.market.reviewService;
    const original = service.claim.bind(service);
    let fired = false;
    service.claim = (async (...args: Parameters<typeof original>) => {
      if (!fired) {
        fired = true;
        await during();
      }
      return original(...args);
    }) as typeof original;
    try {
      return await run();
    } finally {
      service.claim = original;
    }
  }

  it('If-Match: a third stating copy ingested between the check and the claim → 409, nothing claimed (M1)', async () => {
    const url = 'https://jobs.example.com/acme/cas-1';
    const job = await copy(official, 'cas1', 'Join us.\n\nVisa sponsorship: Yes', url);
    await copy(aggregator, 'cas1-agg', 'Join us.\n\nVisa sponsorship: No', url);
    const [item] = await openConflicts(job._id);
    const shown = String(item!.context.evidenceHash);
    await withRaceBeforeClaim(
      () => copy(officialB, 'cas1-lever', 'Join us.\n\nVisa sponsorship: No', url),
      () =>
        expect(
          t.market.reviewService.resolve(
            item!._id,
            { action: 'dismiss', reason: 'as shown', evidenceHash: shown },
            t.actor,
          ),
        ).rejects.toMatchObject({ code: 'conflict' }),
    );
    const after = await t.market.reviews.get(item!._id);
    expect(after.status).toBe('open');
    expect(after.claim).toBeUndefined();
    expect(after.context.evidenceHash).not.toBe(shown);
    expect((await t.market.jobs.get(job._id)).sponsorshipDecision).toBeUndefined();
    // The released item takes a decision on what it now shows.
    await t.market.reviewService.resolve(
      item!._id,
      { action: 'dismiss', reason: 'as shown now', evidenceHash: String(after.context.evidenceHash) },
      t.actor,
    );
    expect((await t.market.reviews.get(item!._id)).status).toBe('dismissed');
  });

  it('without If-Match the recorded digest and stating set are the ones the claim saw, and match (M1)', async () => {
    const url = 'https://jobs.example.com/acme/cas-2';
    const job = await copy(official, 'cas2', 'Join us.\n\nVisa sponsorship: Yes', url);
    await copy(aggregator, 'cas2-agg', 'Join us.\n\nVisa sponsorship: No', url);
    const [item] = await openConflicts(job._id);
    await withRaceBeforeClaim(
      () => copy(officialB, 'cas2-lever', 'Join us.\n\nVisa sponsorship: No', url),
      () => t.market.reviewService.resolve(item!._id, { action: 'dismiss', reason: 'as shown' }, t.actor),
    );
    const closed = await t.market.reviews.get(item!._id);
    const stating = closed.context.stating as Array<{ copy: string; observationId: string; value: string }>;
    expect(stating).toHaveLength(3);
    expect(closed.context.evidenceHash).toBe(
      contentHash({
        flag: 'sponsorship_conflict',
        stating: stating.map((e) => [
          e.copy,
          e.value,
          (e as { scope?: string }).scope,
          (e as { line?: string }).line,
        ]),
      }),
    );
    expect((await t.market.jobs.get(job._id)).sponsorshipDecision!.stating).toEqual(stating);
  });

  it('the conflict item shows every stating line and nothing else but capped licence evidence (L1)', async () => {
    const url = 'https://jobs.example.com/acme/ev-1';
    const job = await copy(
      official,
      'ev1',
      'Join us.\n\nVisa sponsorship: Yes\nWe sponsor Skilled Worker visas.',
      url,
    );
    await copy(aggregator, 'ev1-agg', 'Join us.\n\nVisa sponsorship: No', url);
    const [item] = await openConflicts(job._id);
    expect(item!.evidence.map((e) => e.quote).sort()).toEqual([
      'Visa sponsorship: No',
      'Visa sponsorship: Yes',
    ]);
  });

  it('a metadata-only re-observation of a stating copy does not re-ask (L2)', async () => {
    const url = 'https://jobs.example.com/acme/meta-1';
    const job = await copy(official, 'meta1', 'Join us.\n\nVisa sponsorship: Yes', url);
    const agg = (sourceUpdatedAt: string) =>
      t.market.jobPipeline.process({
        source: aggregator,
        locator: '/jobs/meta1-agg',
        payload: {
          externalId: 'meta1-agg',
          title: 'Platform Engineer meta-1',
          descriptionText: 'Join us.\n\nVisa sponsorship: No',
          locations: [{ text: 'London, United Kingdom' }],
          postingUrl: url,
          sourceUpdatedAt,
          provider: { name: 'aggregator', boardToken: 'feed' },
        },
        parser: { name: 'test', version: '1' },
      });
    await agg('2026-09-01T00:00:00Z');
    await resolveConflict(job._id, 'dismiss');
    const before = (await t.market.jobs.get(job._id)).sourceRefs.map((r) => r.lastObservationId).sort();
    await tick();
    await agg('2026-09-02T00:00:00Z');
    const after = (await t.market.jobs.get(job._id)).sourceRefs.map((r) => r.lastObservationId).sort();
    expect(after).not.toEqual(before); // a new observation of the same copy
    expect(await openConflicts(job._id)).toHaveLength(0);
  });

  it('copies stating "Skilled Worker: Yes" and "H-1B: No" for a London + New York job are no conflict (L3)', async () => {
    const url = 'https://jobs.example.com/acme/scope-1';
    const ingest = (source: SourceDoc, externalId: string, descriptionText: string) =>
      t.market.jobPipeline.process({
        source,
        locator: `/jobs/${externalId}`,
        payload: {
          externalId,
          title: 'Platform Engineer scope-1',
          descriptionText,
          locations: [{ text: 'London, United Kingdom' }, { text: 'New York, NY, United States' }],
          postingUrl: url,
          provider: { name: source.provider, boardToken: source.endpoint?.boardToken ?? 'feed' },
        },
        parser: { name: 'test', version: '1' },
      });
    const r = await ingest(official, 'scope1', 'Join us.\n\nSkilled Worker sponsorship: Yes');
    await ingest(aggregator, 'scope1-agg', 'Join us.\n\nH-1B sponsorship: No');
    const j = await t.market.jobs.get((r as { jobId: string }).jobId);
    expect(j.sourceRefs).toHaveLength(2);
    expect(j.interpretation.flags.map((f) => f.code)).not.toContain('sponsorship_conflict');
    expect(await openConflicts(j._id)).toHaveLength(0);
  });
});

describe('final check: claim CAS, stated line and scope in the stating set, resume safety', () => {
  const ingest = (source: SourceDoc, externalId: string, url: string, descriptionText: string) =>
    t.market.jobPipeline.process({
      source,
      locator: `/jobs/${externalId}`,
      payload: {
        externalId,
        title: `Platform Engineer ${externalId}`,
        descriptionText,
        locations: [{ text: 'London, United Kingdom' }, { text: 'New York, NY, United States' }],
        postingUrl: url,
        provider: { name: source.provider, boardToken: source.endpoint?.boardToken ?? 'feed' },
      },
      parser: { name: 'test', version: '1' },
    });

  it('a leftover claim marker (failed operation, stale claim) does not block an If-Match decision (M-1)', async () => {
    const url = 'https://jobs.example.com/acme/fc-m1';
    const job = await copy(official, 'fcm1', 'Join us.\n\nVisa sponsorship: Yes', url);
    await copy(aggregator, 'fcm1-agg', 'Join us.\n\nVisa sponsorship: No', url);
    const [item] = await openConflicts(job._id);
    const now = new Date();
    const actor = { kind: 'user', id: 'op-old' };
    // A crash between release's two writes: the operation is failed, the item keeps its marker.
    await infra.db.collection('market_review_operations').insertOne({
      _id: item!._id as never,
      operationId: 'rop_old',
      generation: 1,
      owner: { operationId: 'rop_old', actor, at: now },
      decision: { action: 'dismiss', reason: 'an older attempt' },
      decisionActor: actor,
      state: 'failed',
      failure: { kind: 'domain_conflict', code: 'invalid_state', message: 'old', at: now, generation: 1 },
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    await t.market.reviews.col.updateOne(
      { _id: item!._id },
      {
        $set: {
          claim: { operationId: 'rop_old', actor, action: 'dismiss', reason: 'an older attempt', at: now },
        },
      },
    );
    const closed = await t.market.reviewService.resolve(
      item!._id,
      { action: 'dismiss', reason: 'decided now', evidenceHash: String(item!.context.evidenceHash) },
      t.actor,
    );
    expect(closed.status).toBe('dismissed');
  });

  it('If-Match on an item without an evidence digest is accepted (L-1)', async () => {
    const job = await copy(official, 'l1f', 'Join us.', 'https://jobs.example.com/acme/l1f');
    const { item } = await t.market.reviews.raise({
      type: 'employment_conflict',
      severity: 'medium',
      dedupeKey: `manual:l1f:${job._id}`,
      entity: { kind: 'job', id: job._id },
      subject: 'raised by hand',
      reason: 'no digest',
      context: { flag: 'x' },
      allowedActions: ['confirm', 'dismiss'],
    });
    const closed = await t.market.reviewService.resolve(
      item._id,
      { action: 'dismiss', reason: 'fine', evidenceHash: 'whatever-was-shown' },
      t.actor,
    );
    expect(closed.status).toBe('dismissed');
  });

  it('a lifecycle_failure item (M6 sweep, refreshed, no digest) follows the hashless If-Match rule', async () => {
    const job = await copy(official, 'lf1', 'Join us.', 'https://jobs.example.com/acme/lf1');
    // Raised as the recorded-evidence sweep raises it (evidence.service), twice: the refresh
    // replaces the context and never adds a reconciler digest.
    const raise = (failures: number) =>
      t.market.reviews.raise({
        type: 'lifecycle_failure',
        severity: 'medium',
        dedupeKey: `lifecycle_failure:${job._id}`,
        entity: { kind: 'job', id: job._id },
        subject: `Job ${job._id}: lifecycle could not be re-derived`,
        reason: `failed ${failures} times`,
        context: { jobId: job._id, code: 'E', failures },
        allowedActions: ['dismiss'],
        refresh: true,
      });
    await raise(3);
    const { item } = await raise(4);
    expect(item.context.failures).toBe(4);
    expect(item.context.evidenceHash).toBeUndefined();
    const closed = await t.market.reviewService.resolve(
      item._id,
      { action: 'dismiss', reason: 'looked at', evidenceHash: 'whatever-was-shown' },
      t.actor,
    );
    expect(closed.status).toBe('dismissed');
  });

  it('an edited stated line changes the digest: a stale If-Match is refused (M-2, open item)', async () => {
    const url = 'https://jobs.example.com/acme/m2-line-1';
    const r = await ingest(official, 'm2l1', url, 'Join us.\n\nVisa sponsorship: Yes');
    await ingest(aggregator, 'm2l1-agg', url, 'Join us.\n\nH-1B sponsorship: No');
    const jobId = (r as { jobId: string }).jobId;
    const [item] = await openConflicts(jobId);
    const shown = String(item!.context.evidenceHash);
    await tick();
    await ingest(aggregator, 'm2l1-agg', url, 'Join us.\n\nVisa sponsorship: No');
    const [refreshed] = await openConflicts(jobId);
    expect(refreshed!._id).toBe(item!._id);
    expect(refreshed!.context.evidenceHash).not.toBe(shown);
    await expect(
      t.market.reviewService.resolve(
        item!._id,
        { action: 'dismiss', reason: 'as shown', evidenceHash: shown },
        t.actor,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('a decided conflict re-asks after the same line edit, but not after an unrelated edit (M-2)', async () => {
    const url = 'https://jobs.example.com/acme/m2-line-2';
    const r = await ingest(official, 'm2l2', url, 'Join us.\n\nVisa sponsorship: Yes');
    await ingest(aggregator, 'm2l2-agg', url, 'Join us.\n\nH-1B sponsorship: No');
    const jobId = (r as { jobId: string }).jobId;
    await resolveConflict(jobId, 'dismiss');
    await tick();
    // Unrelated text change around the stated lines: nothing to ask.
    await ingest(aggregator, 'm2l2-agg', url, 'Join us today.\n\nH-1B sponsorship: No');
    expect(await openConflicts(jobId)).toHaveLength(0);
    await tick();
    // The stated line itself changes (another key, another scope): asked again.
    await ingest(aggregator, 'm2l2-agg', url, 'Join us today.\n\nVisa sponsorship: No');
    expect(await openConflicts(jobId)).toHaveLength(1);
  });

  it('a crash after the refused claim, then a resume with the same key: the decision is not applied (L-2)', async () => {
    const url = 'https://jobs.example.com/acme/l2r-1';
    const job = await copy(official, 'l2r', 'Join us.\n\nVisa sponsorship: Yes', url);
    await copy(aggregator, 'l2r-agg', 'Join us.\n\nVisa sponsorship: No', url);
    const [item] = await openConflicts(job._id);
    const shown = String(item!.context.evidenceHash);
    // The refresh lands between resolve's check and its claim, so the claim CAS refuses.
    const service = t.market.reviewService;
    const claim = service.claim.bind(service);
    service.claim = (async (...args: Parameters<typeof claim>) => {
      service.claim = claim;
      await copy(officialB, 'l2r-lever', 'Join us.\n\nVisa sponsorship: No', url);
      return claim(...args);
    }) as typeof claim;
    // A crash right after the refused claim CAS: the operation record is never released.
    const proto = Object.getPrototypeOf(service) as object;
    const getter = Object.getOwnPropertyDescriptor(proto, 'operations')!.get!;
    Object.defineProperty(service, 'operations', {
      configurable: true,
      get() {
        const col = getter.call(service) as object;
        return new Proxy(col, {
          get(target, prop, receiver) {
            if (prop === 'deleteOne')
              return () => {
                throw new Error('crash after the refused claim');
              };
            return Reflect.get(target, prop, receiver) as unknown;
          },
        });
      },
    });
    const restoreOperations = () => delete (service as unknown as { operations?: unknown }).operations;
    const input = { action: 'dismiss' as const, reason: 'as shown', evidenceHash: shown };
    try {
      await expect(
        t.market.reviewService.resolve(item!._id, input, t.actor, { operationId: 'rop_crash_1' }),
      ).rejects.toThrow(/crash after the refused claim/);
    } finally {
      restoreOperations();
      service.claim = claim;
    }
    await expect(
      t.market.reviewService.resolve(item!._id, input, t.actor, { operationId: 'rop_crash_1' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const after = await t.market.reviews.get(item!._id);
    expect(after.status).toBe('open');
    expect((await t.market.jobs.get(job._id)).sponsorshipDecision).toBeUndefined();
  });
});

describe('8d96663 (3): the re-interpretation backfill', () => {
  async function runBackfill(input: JsonObject = {}) {
    const run = await t.runtime.engine.startRun({
      workflowKey: 'market.jobs.reinterpret_outdated',
      input,
      trigger: { kind: 'manual' },
    });
    const done = await waitForRun(t.runtime.engine, run._id, undefined, 120_000);
    expect(done.state).toBe('COMPLETED');
    return done.output as {
      selected: number;
      succeeded: number;
      failed: number;
      remaining: number;
      done: boolean;
      nextAfter: string | null;
    };
  }

  /** Rewind a job to what 2026-09-27.1 stored: a posting-text verdict, no statement flags. */
  async function storeOld(id: string, set: Record<string, unknown> = {}) {
    await t.market.jobs.col.updateOne(
      { _id: id },
      {
        $set: {
          'immigration.sponsorship.value.status': 'explicit_yes',
          'immigration.sponsorship.value.roleStatement': 'yes',
          'interpretation.policyVersion': OLD_POLICY,
          'interpretation.flags': [],
          ...set,
        },
      },
    );
  }

  it('re-interprets every older job (any state or source), keeps overrides, skips merged/newer, and is replay-safe', async () => {
    const statement = 'Join us.\n\nVisa sponsorship: Yes\nWe sponsor Skilled Worker visas.';
    const plain = await copy(official, 'b1', statement, 'https://jobs.example.com/acme/b1');
    const closed = await copy(official, 'b2', statement, 'https://jobs.example.com/acme/b2');
    const stale = await copy(official, 'b3', statement, 'https://jobs.example.com/acme/b3');
    const overridden = await copy(official, 'b4', statement, 'https://jobs.example.com/acme/b4');
    const disabledSrc = await register('lever:acme-disabled', 'lever', 'official_ats', 'acme-disabled');
    const onDisabled = await copy(disabledSrc, 'b5', statement, 'https://jobs.example.com/acme/b5');
    await t.market.sources.setEnabled(disabledSrc._id, false, t.actor);
    const merged = await copy(official, 'b6', 'Different role entirely.', 'https://jobs.example.com/acme/b6');
    const newer = await copy(official, 'b7', statement, 'https://jobs.example.com/acme/b7');

    await storeOld(plain._id);
    await storeOld(closed._id, { 'lifecycle.state': 'CLOSED' });
    await storeOld(stale._id, { 'lifecycle.state': 'POSSIBLY_STALE' });
    const decision = {
      value: {
        status: 'explicit_no',
        roleStatement: 'no',
        companyCapability: 'none',
        capabilityCountries: [],
      },
      reason: 'operator decision',
      actorId: 'op-1',
      at: new Date(),
    };
    await storeOld(overridden._id, {
      'overrides.sponsorship': decision,
      'immigration.sponsorship.value.status': 'explicit_no',
      'immigration.sponsorship.value.roleStatement': 'no',
    });
    await storeOld(onDisabled._id);
    await storeOld(merged._id, { status: 'merged', mergedInto: plain._id });
    await t.market.jobs.col.updateOne(
      { _id: newer._id },
      { $set: { 'interpretation.policyVersion': 'employment-policy/2099-01-01.1' } },
    );

    const report = await runBackfill();
    expect(report).toMatchObject({ failed: 0, remaining: 0, done: true, nextAfter: null });
    expect(report.selected).toBe(5);
    expect(report.succeeded).toBe(report.selected);

    for (const id of [plain._id, closed._id, stale._id, onDisabled._id]) {
      const j = await t.market.jobs.get(id);
      expect(j.interpretation.policyVersion, id).toBe(INTERPRETATION_POLICY_VERSION);
      // The stored posting-text verdict is gone: unclear, with the statement and the mention.
      expect(j.immigration.sponsorship.value, id).toMatchObject({ status: 'unclear', roleStatement: 'none' });
      expect(j.interpretation.flags, id).toContainEqual(
        expect.objectContaining({ code: 'sponsorship_stated', value: 'yes' }),
      );
      expect(
        j.interpretation.flags.map((f) => f.code),
        id,
      ).toContain('sponsorship_mentioned');
    }
    // Lifecycle states are not touched by re-interpretation.
    expect((await t.market.jobs.get(closed._id)).lifecycle.state).toBe('CLOSED');
    expect((await t.market.jobs.get(stale._id)).lifecycle.state).toBe('POSSIBLY_STALE');
    // The operator's decision survives, recorded and applied.
    const o = await t.market.jobs.get(overridden._id);
    expect(o.interpretation.policyVersion).toBe(INTERPRETATION_POLICY_VERSION);
    expect(o.overrides.sponsorship).toMatchObject({ actorId: 'op-1', value: { status: 'explicit_no' } });
    expect(o.immigration.sponsorship.value).toMatchObject({ status: 'explicit_no', roleStatement: 'no' });
    expect(o.immigration.sponsorship.evidence[0]).toMatchObject({ authority: 'operator' });
    // Merged and newer jobs are left alone.
    expect((await t.market.jobs.get(merged._id)).interpretation.policyVersion).toBe(OLD_POLICY);
    expect((await t.market.jobs.get(newer._id)).interpretation.policyVersion).toBe(
      'employment-policy/2099-01-01.1',
    );

    // Replay-safe: a second run finds nothing and changes nothing.
    const before = await t.market.jobs.get(plain._id);
    const second = await runBackfill();
    expect(second).toMatchObject({ selected: 0, succeeded: 0, failed: 0, remaining: 0, done: true });
    expect((await t.market.jobs.get(plain._id)).rev).toBe(before.rev);
  }, 180_000);

  it('pages by `_id` (limit + nextAfter) and resumes where a page stopped', async () => {
    const jobs = await Promise.all(
      ['p1', 'p2', 'p3'].map((x) =>
        copy(official, x, 'Visa sponsorship: No', `https://jobs.example.com/acme/${x}`),
      ),
    );
    for (const j of jobs) await storeOld(j._id);
    // Keyset pages are disjoint and in `_id` order (`after` skips what an earlier page covered,
    // e.g. jobs whose re-interpretation failed).
    const ids = jobs.map((j) => j._id).sort();
    const page1 = await selectOutdatedInterpretations(infra.db, { limit: 2 });
    expect(page1.jobIds).toEqual(ids.slice(0, 2));
    expect(page1.nextAfter).toBe(ids[1]);
    const page2 = await selectOutdatedInterpretations(infra.db, { after: page1.nextAfter!, limit: 2 });
    expect(page2).toMatchObject({ jobIds: [ids[2]], nextAfter: null, outdatedTotal: 3 });
    // The startup warning's index-only count (3dfe3c5 (4)).
    expect(await t.market.warnOutdatedInterpretations()).toBe(3);
    const first = await runBackfill({ limit: 2 });
    expect(first).toMatchObject({ selected: 2, succeeded: 2, remaining: 1, done: false });
    expect(first.nextAfter).not.toBeNull();
    const rest = await runBackfill({ after: first.nextAfter });
    expect(await t.market.warnOutdatedInterpretations()).toBe(0);
    expect(rest).toMatchObject({ selected: 1, remaining: 0, done: true });
    for (const j of jobs) {
      const after = await t.market.jobs.get(j._id);
      expect(after.interpretation.policyVersion).toBe(INTERPRETATION_POLICY_VERSION);
      expect(after.interpretation.flags).toContainEqual(
        expect.objectContaining({ code: 'sponsorship_stated', value: 'no' }),
      );
    }
  }, 180_000);
});
