import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@aptamind/contracts';
import {
  factsHash,
  JOB_SUMMARY_FACTS,
  SUMMARY_ROW_MAX,
  BASIS_MAX,
  COMP_TEXT_MAX,
  COMP_WARNINGS_MAX,
  explainJobList,
  JOB_STATES,
  type JobDoc,
  jobDocSchema,
  jobListQuerySchema,
  jobListResponseDto,
  jobListSummaryResponseDto,
  jobSummaryDto,
  listingEvidenceKey,
  planStages,
  REMOTE_SCOPE_TYPES,
  RELOCATION_STATUSES,
  SPONSORSHIP_STATUSES,
  titleTokens,
  WORK_MODELS,
} from '@aptamind/market';
import {
  type ApiHarness,
  expectDto,
  expectValidationError,
  mongoOrder,
  startApiHarness,
  traverse,
} from './market-test-harness';

/**
 * Jobs list v2 (M7.3) over ~1.1k jobs derived from real pipeline output: sorts with keyset
 * pagination, stability under concurrent inserts, the filter matrix, title + company search,
 * the summary view, 400s and index use.
 */

let h: ApiHarness;
let acmeId: string;
let all: JobDoc[];
const T0 = Date.parse('2026-06-01T00:00:00Z');
const NOW = Date.now();
const TITLES = [
  'Senior Backend Engineer',
  'Product Designer',
  'Data Analyst',
  'Customer Success Manager (DACH)',
  'Platform Engineer, EMEA',
  'Staff Data Engineer',
];
const PROVIDERS = ['greenhouse', 'lever', 'ashby', 'aggregator'];
const LEVELS = ['high', 'medium', 'low', 'unknown'] as const;
const CURRENCIES = ['USD', 'GBP', 'EUR'];

const fact = <T>(value: T, level: (typeof LEVELS)[number] = 'high') => ({
  value,
  status: level === 'unknown' ? ('unknown' as const) : ('known' as const),
  confidence: { level, reasons: ['test'] },
  evidence: [],
  conflicts: [],
});

function variant(template: JobDoc, i: number, companyIds: string[]): JobDoc {
  const j = structuredClone(template);
  const id = newId('job');
  const sourceId = `src_syn${i % 4}`;
  j._id = id;
  j.companyId = companyIds[i % companyIds.length]!;
  j.sourceKeys = [`${sourceId}:${i}`];
  j.sourceRefs = j.sourceRefs.map((r) => ({
    ...r,
    sourceId,
    key: `${sourceId}:${i}`,
    provider: PROVIDERS[i % 4]!,
  }));
  const title = TITLES[i % TITLES.length]!;
  j.identity.title = fact(title);
  j.identity.normalizedTitle = title;
  j.identity.titleTokens = titleTokens(title);
  j.lifecycle = {
    ...j.lifecycle,
    state: JOB_STATES[i % 7]!,
    lastSeenAt: new Date(T0 + (i % 300) * 60_000),
    firstSeenAt: new Date(T0 - (i % 200) * 3_600_000),
    lastChangedAt: i % 4 === 0 ? undefined : new Date(T0 + (i % 90) * 60_000),
  };
  j.geography.workModel = fact(WORK_MODELS[i % 4]!, LEVELS[Math.floor(i / 4) % 4]);
  j.geography.remoteScope = fact({
    type: REMOTE_SCOPE_TYPES[i % 7]!,
    countries: i % 7 === 2 ? [['US', 'GB', 'DE'][i % 3]!] : [],
    regions: [],
    excludedCountries: [],
    excludedRegions: [],
    timezone: null,
  });
  j.geography.normalizedLocations = [
    {
      text: 'x',
      city: null,
      region: null,
      country: ['US', 'GB', 'DE', null][i % 4] ?? null,
      isRemoteLabel: false,
    },
  ];
  j.immigration.sponsorship = fact(
    {
      status: SPONSORSHIP_STATUSES[i % 5]!,
      roleStatement: 'none' as const,
      companyCapability: 'unknown' as const,
      capabilityCountries: [],
    },
    LEVELS[i % 3],
  );
  j.immigration.relocation = fact(RELOCATION_STATUSES[i % 4]!);
  j.immigration.authorization = fact({
    required: [true, false, null][i % 3]!,
    countries: [],
    regions: [],
    qualifiers: [],
  });
  j.interpretation.flags = [
    ...(i % 6 === 0
      ? [{ code: 'sponsorship_mixed_statement', message: 'm', severity: 'info' as const }]
      : []),
    ...(i % 10 === 0 ? [{ code: 'work_model_conflict', message: 'm', severity: 'high' as const }] : []),
  ];
  j.verification = {
    ...(i % 4 < 3 ? { lastOutcome: (['live', 'not_found', 'inconclusive'] as const)[i % 4] } : {}),
    ...(i % 3 === 0 ? { nextVerificationDueAt: new Date(NOW - 3_600_000) } : {}),
    ...(i % 3 === 1 ? { nextVerificationDueAt: new Date(NOW + 3_600_000) } : {}),
  };
  const parsed = i % 4 === 0;
  const min = 50_000 + (i % 20) * 5_000;
  j.compensation = fact({
    status: (['parsed', 'unknown', 'ambiguous', 'malformed'] as const)[i % 4]!,
    min: parsed ? min : null,
    max: parsed ? min + 20_000 : null,
    currency: parsed ? CURRENCIES[i % 3]! : null,
    period: parsed ? ('year' as const) : null,
    basis: 'base_salary' as const,
    annualized: parsed ? { min, max: i % 8 === 0 ? null : min + 20_000, assumptions: [] } : null,
    equityText: null,
    bonusText: null,
    originalText: null,
    warnings: [],
  });
  j.quality = { ...j.quality, conflictFields: i % 11 === 0 ? ['compensation'] : [] };
  return jobDocSchema.parse(j);
}

beforeAll(async () => {
  h = await startApiHarness('jobs');
  await h.seedSponsorRegister();
  acmeId = (await h.market.companies.col.findOne({ 'identity.normalizedName': 'acme ltd' }))!._id;
  await h.seedGreenhouseBoard(acmeId);
  const templates = await h.market.jobs.col.find({ companyId: acmeId }).toArray();
  const others = await h.market.companies.col
    .find({ status: 'active', _id: { $ne: acmeId } })
    .limit(4)
    .toArray();
  const companyIds = [acmeId, ...others.map((c) => c._id)];
  await h.market.jobs.col.insertMany(
    Array.from({ length: 1100 }, (_, i) => variant(templates[i % 5]!, i, companyIds)),
  );
  // Open reviews on some jobs.
  const some = await h.market.jobs.col.find({}).limit(40).toArray();
  for (const [k, j] of some.entries())
    if (k % 3 === 0)
      await h.market.reviews.raise({
        type: 'employment_conflict',
        severity: 'medium',
        dedupeKey: `t:job:${j._id}`,
        entity: { kind: 'job', id: j._id },
        subject: 's',
        reason: 'r',
        allowedActions: ['dismiss'],
      });
  all = await h.market.jobs.col.find({ status: 'active' }).toArray();
}, 180_000);

afterAll(async () => {
  await h?.close();
});

const idsOf = (rows: Array<{ _id: string }>) => rows.map((r) => r._id);

describe('GET /api/jobs v2: sort + keyset pagination', () => {
  const cases: Array<[string, (j: JobDoc) => string | Date | null | undefined, 1 | -1]> = [
    ['-lastSeenAt', (j) => j.lifecycle.lastSeenAt, -1],
    ['lastSeenAt', (j) => j.lifecycle.lastSeenAt, 1],
    ['firstSeenAt', (j) => j.lifecycle.firstSeenAt, 1],
    ['-firstSeenAt', (j) => j.lifecycle.firstSeenAt, -1],
    ['lastChangedAt', (j) => j.lifecycle.lastChangedAt, 1],
    ['-lastChangedAt', (j) => j.lifecycle.lastChangedAt, -1],
    ['title', (j) => j.identity.normalizedTitle, 1],
    ['-title', (j) => j.identity.normalizedTitle, -1],
  ];
  it.each(cases)('sort=%s walks every job once, in order', async (sort, value, dir) => {
    const { rows } = await traverse<{ _id: string }>(
      h,
      `/api/jobs?sort=${sort}&limit=113&view=summary&count=none`,
    );
    expect(idsOf(rows)).toEqual(mongoOrder(all, value, dir));
  });

  it('the default order is -lastSeenAt, and v1 offset pages follow it', async () => {
    const expected = mongoOrder(all, (j) => j.lifecycle.lastSeenAt, -1);
    const v1 = expectDto(jobListResponseDto, (await h.get('/api/jobs?limit=50&offset=100')).body);
    expect(v1.total).toBe(all.length);
    expect(idsOf(v1.items as Array<{ _id: string }>)).toEqual(expected.slice(100, 150));
    const raw = (await h.get('/api/jobs?limit=1')).body as { items: Array<{ content: object }> };
    expect(raw.items[0]!.content).not.toHaveProperty('descriptionText');
  });

  it('is stable under concurrent inserts (newer rows land before the cursor, older after it)', async () => {
    const before = new Set(all.map((j) => j._id));
    const template = all[0]!;
    const inserted: string[] = [];
    let n = 0;
    const { rows } = await traverse<{ _id: string }>(h, '/api/jobs?limit=71&count=none&view=summary', {
      between: async () => {
        const docs = [NOW + 1e9, T0 + 150 * 60_000, T0 - 1e9].map((t) => {
          const d = structuredClone(template);
          d._id = newId('job');
          d.sourceKeys = [`src_concurrent:${n++}`];
          d.lifecycle = { ...d.lifecycle, lastSeenAt: new Date(t) };
          return jobDocSchema.parse(d);
        });
        inserted.push(...docs.map((d) => d._id));
        await h.market.jobs.col.insertMany(docs);
      },
    });
    const ids = idsOf(rows);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of before) expect(ids).toContain(id);
    expect(ids.filter((id) => !before.has(id)).every((id) => inserted.includes(id))).toBe(true);
    await h.market.jobs.col.deleteMany({ _id: { $in: inserted } });
  });
});

describe('GET /api/jobs v2: filters and search', () => {
  const check = async (query: string, predicate: (j: JobDoc) => boolean, min = 1) => {
    const expected = all.filter(predicate).map((j) => j._id);
    const { rows, first } = await traverse<{ _id: string }>(h, `/api/jobs?${query}&view=summary&limit=200`);
    expect(new Set(idsOf(rows))).toEqual(new Set(expected));
    expect(first.total).toBe(expected.length);
    expect(expected.length).toBeGreaterThanOrEqual(min);
    return expected.length;
  };

  it('multi-value enums: state, workModel, remoteScope, sponsorship, relocation', async () => {
    await check(
      'state=CLOSED,POSSIBLY_STALE',
      (j) => ['CLOSED', 'POSSIBLY_STALE'].includes(j.lifecycle.state),
      100,
    );
    await check('workModel=remote&workModel=hybrid', (j) =>
      ['remote', 'hybrid'].includes(j.geography.workModel.value ?? ''),
    );
    await check('remoteScope=country,timezone', (j) =>
      ['country', 'timezone'].includes(j.geography.remoteScope.value?.type ?? ''),
    );
    await check(
      'sponsorship=company_capable',
      (j) => j.immigration.sponsorship.value?.status === 'company_capable',
    );
    await check('relocation=possible,explicit_no', (j) =>
      ['possible', 'explicit_no'].includes(j.immigration.relocation.value ?? ''),
    );
  });

  it('authorizationRequired, country, minConfidence, flag', async () => {
    await check('authorizationRequired=true', (j) => j.immigration.authorization.value?.required === true);
    await check(
      'authorizationRequired=unknown',
      (j) => (j.immigration.authorization.value?.required ?? null) === null,
    );
    await check(
      'country=de,GB',
      (j) =>
        j.geography.normalizedLocations.some((l) => ['DE', 'GB'].includes(l.country ?? '')) ||
        (j.geography.remoteScope.value?.countries ?? []).some((c) => ['DE', 'GB'].includes(c)),
    );
    await check('minConfidence=workModel:medium', (j) =>
      ['high', 'medium'].includes(j.geography.workModel.confidence.level),
    );
    await check(
      'minConfidence=workModel:low,sponsorship:high',
      (j) =>
        ['high', 'medium', 'low'].includes(j.geography.workModel.confidence.level) &&
        j.immigration.sponsorship.confidence.level === 'high',
    );
    await check('flag=work_model_conflict,sponsorship_mixed_statement', (j) =>
      j.interpretation.flags.some((f) =>
        ['work_model_conflict', 'sponsorship_mixed_statement'].includes(f.code),
      ),
    );
  });

  it('verification, salary, currency and minAnnual', async () => {
    await check('verificationOutcome=none,not_found', (j) =>
      [undefined, 'not_found'].includes(j.verification.lastOutcome),
    );
    await check(
      'verificationDue=true',
      (j) =>
        !!j.verification.nextVerificationDueAt &&
        j.verification.nextVerificationDueAt.getTime() <= Date.now(),
    );
    await check(
      'verificationDue=false',
      (j) =>
        !j.verification.nextVerificationDueAt || j.verification.nextVerificationDueAt.getTime() > Date.now(),
    );
    await check('salaryStatus=unknown,malformed', (j) =>
      ['unknown', 'malformed'].includes(j.compensation.value?.status ?? 'unknown'),
    );
    await check('currency=usd', (j) => j.compensation.value?.currency === 'USD');
    await check('currency=GBP&minAnnual=120000', (j) => {
      const c = j.compensation.value;
      const a = c?.annualized;
      return c?.currency === 'GBP' && !!a && (a.max !== null ? a.max >= 120_000 : (a.min ?? -1) >= 120_000);
    });
  });

  it('sourceId, provider, companyId, hasConflicts, hasOpenReviews and date ranges', async () => {
    await check('sourceId=src_syn1,src_syn3', (j) => j.sourceKeys.some((k) => /^src_syn[13]:/.test(k)));
    await check('provider=lever', (j) => j.sourceRefs.some((r) => r.provider === 'lever'));
    await check(`companyId=${acmeId}`, (j) => j.companyId === acmeId);
    await check('hasConflicts=true', (j) => j.quality.conflictFields.length > 0);
    await check(
      'hasConflicts=false&state=VERIFIED_LIVE',
      (j) => !j.quality.conflictFields.length && j.lifecycle.state === 'VERIFIED_LIVE',
    );
    const open = new Set(
      (await h.market.reviews.col.find({ status: 'open', 'entity.kind': 'job' }).toArray()).map(
        (r) => r.entity.id,
      ),
    );
    await check('hasOpenReviews=true&count=exact', (j) => open.has(j._id), 5);
    await check(
      'hasOpenReviews=false&count=exact&state=CLOSED',
      (j) => !open.has(j._id) && j.lifecycle.state === 'CLOSED',
    );
    const a = new Date(T0 + 100 * 60_000);
    const b = new Date(T0 + 200 * 60_000);
    await check(
      `lastSeenAfter=${a.toISOString()}&lastSeenBefore=${b.toISOString()}`,
      (j) => j.lifecycle.lastSeenAt >= a && j.lifecycle.lastSeenAt < b,
    );
    await check(
      'changedAfter=2026-06-01T01:00:00Z',
      (j) => !!j.lifecycle.lastChangedAt && j.lifecycle.lastChangedAt >= new Date(T0 + 3_600_000),
    );
    await check(
      'firstSeenBefore=2026-05-25',
      (j) => j.lifecycle.firstSeenAt < new Date('2026-05-25T00:00:00Z'),
    );
  });

  it('q searches titles (every word, any case) and company names (prefix)', async () => {
    await check('q=DESIGNER', (j) => j.identity.normalizedTitle === 'Product Designer', 100);
    await check('q=data engineer', (j) => j.identity.normalizedTitle === 'Staff Data Engineer', 100);
    await check(
      'q=backend engineer&state=VERIFIED_LIVE',
      (j) =>
        j.identity.normalizedTitle === 'Senior Backend Engineer' && j.lifecycle.state === 'VERIFIED_LIVE',
    );
    // Company-name prefix ("acme") finds Acme's jobs whatever their title.
    await check('q=acme', (j) => j.companyId === acmeId, 100);
    // Partial words and symbols: every word is a prefix of some title token.
    await check('q=eng', (j) => /\beng/i.test(j.identity.normalizedTitle), 100);
    await check('q=Staff Eng', (j) => j.identity.normalizedTitle === 'Staff Data Engineer', 100);
    await check(
      'q=success (dach)',
      (j) => j.identity.normalizedTitle === 'Customer Success Manager (DACH)',
      100,
    );
    await check('q=zzz nothing', () => false, 0);
  });
});

describe('GET /api/jobs v2: summary view, validation and index use', () => {
  it('summary rows are strict, within the row budget and carry no evidence; the detail summary is the same row', async () => {
    const page = expectDto(
      jobListSummaryResponseDto,
      (await h.get(`/api/jobs?view=summary&limit=200&companyId=${acmeId}`)).body,
    );
    for (const row of page.items) {
      expect(JSON.stringify(row).length).toBeLessThanOrEqual(SUMMARY_ROW_MAX);
      expect(JSON.stringify(row)).not.toContain('"evidence"');
      expect(row.companyName).toBe('Acme Ltd');
    }
    const one = page.items[0]!;
    expect(expectDto(jobSummaryDto, (await h.get(`/api/jobs/${one._id}?view=summary`)).body)).toEqual(one);
  });

  it('hiddenByProvider (PR #11 U1): true only while every present copy is hidden by its provider', async () => {
    const target = all.find((j) => j.companyId === acmeId)!;
    const summaryOf = async () =>
      expectDto(jobSummaryDto, (await h.get(`/api/jobs/${target._id}?view=summary`)).body);
    expect((await summaryOf()).hiddenByProvider).toBe(false);
    const before = (await h.market.jobs.col.findOne({ _id: target._id }))!;
    await h.market.jobs.col.updateOne(
      { _id: target._id },
      { $set: { 'sourceRefs.$[r].providerState': 'unlisted' } },
      { arrayFilters: [{ 'r.present': true }] },
    );
    try {
      expect((await summaryOf()).hiddenByProvider).toBe(true);
    } finally {
      await h.market.jobs.col.updateOne({ _id: target._id }, { $set: { sourceRefs: before.sourceRefs } });
    }
  });

  it('summary facts carry basis and alternates; rev, contentHash and versions pin the row; review counts are live', async () => {
    const [target, other] = all.filter((j) => j.companyId === acmeId);
    const longReason = `operator override: ${'x'.repeat(400)}`;
    await h.market.jobs.col.updateOne(
      { _id: target!._id },
      {
        $set: {
          'geography.workModel.confidence.reasons': [longReason, 'second'],
          'geography.workModel.conflicts': [
            { value: 'onsite', evidence: [], reason: 'lower authority' },
            { value: 'hybrid', evidence: [], reason: 'older copy' },
          ],
          'compensation.value.originalText': `£${'y'.repeat(300)}`,
          'compensation.value.warnings': ['w1', 'w2', 'w3', 'w4', 'w5'],
        },
      },
    );
    const full = (await h.market.jobs.col.findOne({ _id: target!._id }))!;
    const summaryOf = async () =>
      expectDto(jobSummaryDto, (await h.get(`/api/jobs/${target!._id}?view=summary`)).body);
    const row = await summaryOf();
    // Every summary fact: basis = reasons[0] (clipped), alternates = conflicts.length.
    const facts: Array<[{ basis: string | null; alternates: number }, JobDoc['identity']['title']]> = [
      [row.identity.title, full.identity.title],
      [row.identity.seniority, full.identity.seniority],
      [row.employment.employmentType, full.employment.employmentType],
      [row.geography.remoteScope, full.geography.remoteScope as never],
      [row.immigration.sponsorship, full.immigration.sponsorship as never],
      [row.immigration.authorization, full.immigration.authorization as never],
      [row.immigration.relocation, full.immigration.relocation as never],
      [row.compensation, full.compensation as never],
    ];
    for (const [s, f] of facts) {
      expect(s.basis).toBe(f.confidence.reasons[0] ?? null);
      expect(s.alternates).toBe(f.conflicts.length);
    }
    expect(row.geography.workModel.alternates).toBe(2);
    expect(row.geography.workModel.basis).toHaveLength(BASIS_MAX);
    expect(row.geography.workModel.basis).toMatch(/^operator override: x+…$/);
    expect(row.compensation.value?.warnings).toEqual(['w1', 'w2', 'w3'].slice(0, COMP_WARNINGS_MAX));
    expect(row.compensation.value?.originalText).toHaveLength(COMP_TEXT_MAX);
    expect(row.rev).toBe(full.rev ?? 0);
    expect(row.contentHash).toBe(full.contentHash);
    expect(row.interpretation).toEqual({
      logicVersion: full.interpretation.logicVersion,
      policyVersion: full.interpretation.policyVersion,
      taxonomyVersion: full.interpretation.taxonomyVersion,
    });
    expect(JSON.stringify(row).length).toBeLessThanOrEqual(SUMMARY_ROW_MAX);

    // openReviewCount is live: an item naming the job as its entity and one naming it as a candidate.
    const before = row.openReviewCount;
    const asEntity = await h.market.reviews.raise({
      type: 'employment_conflict',
      severity: 'low',
      dedupeKey: `t:summary:${target!._id}`,
      entity: { kind: 'job', id: target!._id },
      subject: 's',
      reason: 'r',
      allowedActions: ['dismiss'],
    });
    const asCandidate = await h.market.reviews.raise({
      type: 'job_duplicate',
      severity: 'low',
      dedupeKey: `t:summary:dup:${other!._id}`,
      entity: { kind: 'job', id: other!._id },
      candidates: [{ kind: 'job', id: target!._id, label: 'x' }],
      subject: 's',
      reason: 'r',
      allowedActions: ['dismiss'],
    });
    expect((await summaryOf()).openReviewCount).toBe(before + 2);
    const listed = expectDto(
      jobListSummaryResponseDto,
      (await h.get(`/api/jobs?view=summary&limit=200&companyId=${acmeId}`)).body,
    );
    expect(listed.items.find((j) => j._id === target!._id)?.openReviewCount).toBe(before + 2);
    const snapshot = (await h.market.jobs.col.findOne({ _id: target!._id }))!.quality.openReviewCount;
    for (const r of [asEntity, asCandidate])
      await h.market.reviews.col.updateOne({ _id: r.item._id }, { $set: { status: 'dismissed' } });
    expect((await summaryOf()).openReviewCount).toBe(before);
    // The stored snapshot is untouched by review changes (it moves only on reconciliation).
    expect((await h.market.jobs.col.findOne({ _id: target!._id }))!.quality.openReviewCount).toBe(snapshot);
  });

  it('a job stub is searchable from insertion, before (or without) a successful reconciliation', async () => {
    const template = all.find((j) => j.companyId === acmeId)!;
    const obs = (await h.market.observations.jobObservations.findOne({
      _id: template.content.primaryObservationId,
    }))!;
    const ref = { ...template.sourceRefs[0]!, key: `src_stub:${newId('x')}`, externalId: newId('x') };
    const stubObs = { ...obs, payload: { ...obs.payload, title: 'Quixotic Ångström Wrangler' } };
    const pipeline = h.market.jobPipeline as unknown as {
      createJob(
        c: string,
        r: unknown,
        o: unknown,
        at: Date,
        rel: string[],
        evidenceFor: (jobId: string) => unknown,
      ): Promise<JobDoc | null>;
    };
    const at = new Date();
    // The creation sighting (PR #11: a job's lifecycle is derived from its evidence).
    const sighting = (jobId: string) => ({
      _id: listingEvidenceKey(ref.key, at, 'present'),
      jobId,
      copyKey: ref.key,
      sourceId: ref.sourceId,
      board: ref.board ?? null,
      at,
      kind: 'listing',
      outcome: 'present',
    });
    const stub = (await pipeline.createJob(acmeId, ref, stubObs, at, [], sighting))!;
    expect(stub.identity.titleTokens).toEqual(['quixotic', 'angstrom', 'wrangler']);
    const found = (await h.get('/api/jobs?q=angst wrang&count=exact')).body as {
      items: Array<{ _id: string }>;
    };
    expect(found.items.map((j) => j._id)).toEqual([stub._id]);
    await h.market.jobs.col.deleteOne({ _id: stub._id });
  });

  it('factsHash pins every summary fact: a status/confidence-only change moves it, not contentHash', async () => {
    const target = all.filter((j) => j.companyId === acmeId)[2]!;
    const summaryOf = async () =>
      expectDto(jobSummaryDto, (await h.get(`/api/jobs/${target._id}?view=summary`)).body);
    const before = await summaryOf();
    const listed = expectDto(
      jobListSummaryResponseDto,
      (await h.get(`/api/jobs?view=summary&limit=200&companyId=${acmeId}`)).body,
    ).items.find((j) => j._id === target._id)!;
    expect(listed.factsHash).toBe(before.factsHash);
    const doc = (await h.market.jobs.col.findOne({ _id: target._id }))!;
    expect(before.factsHash).toBe(factsHash(doc, JOB_SUMMARY_FACTS));
    // Same value, lower confidence and another status: contentHash (lifecycle CHANGED) ignores it.
    await h.market.jobs.col.updateOne(
      { _id: target._id },
      {
        $set: {
          'immigration.relocation.status': 'conflicting',
          'immigration.relocation.confidence.level': 'low',
        },
      },
    );
    const after = await summaryOf();
    expect(after.immigration.relocation.value).toEqual(before.immigration.relocation.value);
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.factsHash).not.toBe(before.factsHash);
    await h.market.jobs.col.updateOne({ _id: target._id }, { $set: { immigration: doc.immigration } });
    expect((await summaryOf()).factsHash).toBe(before.factsHash);
  });

  it.each([
    ['minAnnual without currency', '/api/jobs?minAnnual=100000'],
    ['minAnnual with two currencies', '/api/jobs?minAnnual=100000&currency=USD,GBP'],
    ['minConfidence unknown field', '/api/jobs?minConfidence=salary:high'],
    ['minConfidence bad level', '/api/jobs?minConfidence=workModel:certain'],
    ['bad flag', '/api/jobs?flag=Work Model'],
    ['bad currency', '/api/jobs?currency=dollars'],
    ['bad authorizationRequired', '/api/jobs?authorizationRequired=maybe'],
    ['bad state in list', '/api/jobs?state=CLOSED,OPEN'],
    ['unknown sort', '/api/jobs?sort=salary'],
    ['bad verificationOutcome', '/api/jobs?verificationOutcome=dead'],
    ['bad detail view', '/api/jobs/job_x?view=peek'],
  ])('400: %s', async (_name, url) => {
    expectValidationError(await h.get(url));
  });

  it('pages are index-backed (no collection scan; no blocking sort for plain sorts)', async () => {
    const db = h.market.ctx.db;
    const q = (query: Record<string, string | undefined>) => jobListQuerySchema.parse(query);
    const cursor = ((await h.get('/api/jobs?sort=title&limit=30')).body as { nextCursor: string }).nextCursor;
    for (const query of [
      {},
      { sort: 'firstSeenAt' },
      { sort: '-lastChangedAt', view: 'summary' },
      { sort: 'title', after: cursor },
      { companyId: acmeId },
    ]) {
      const stages = planStages(await explainJobList(db, q(query), new Date()));
      expect(stages).toContain('IXSCAN');
      expect(stages).not.toContain('COLLSCAN');
      expect(stages).not.toContain('SORT');
    }
    for (const query of [
      { q: 'engineer' },
      { q: 'acme' },
      { flag: 'work_model_conflict' },
      { state: 'CLOSED' },
    ]) {
      const stages = planStages(await explainJobList(db, q(query), new Date()));
      expect(stages).not.toContain('COLLSCAN');
      expect(stages).toContain('IXSCAN');
    }
  });
});
