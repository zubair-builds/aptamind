import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, UNAUTHENTICATED_INTERNAL_OPERATOR } from '@aptamind/contracts';
import {
  explainReviewList,
  JOB_CORRECTABLE_FIELDS,
  JOB_OVERRIDABLE,
  planStages,
  type ReviewItemDoc,
  errorResponseDto,
  reviewDetailResponseDto,
  reviewTriageResponseDto,
  triageHolderHash,
  reviewItemDocSchema,
  reviewListQuerySchema,
  reviewListV2ResponseDto,
  WORK_MODELS,
} from '@aptamind/market';
import {
  type ApiHarness,
  expectDto,
  expectValidationError,
  mongoOrderBy,
  startApiHarness,
  traverse,
} from './market-test-harness';

/**
 * Review queue v2 (M7.5): filters, sorts with keyset pagination, facets, server-computed queue
 * state, supported actions (property: every supported action is accepted by resolve) and
 * correctable field descriptors, and the detail's observations and targeted facts.
 */

let h: ApiHarness;
let acmeId: string;
let manualSourceId: string;
let disabledSourceId: string;
let jobIds: string[];
const ids: Record<string, string> = {};

type Row = ReviewItemDoc & {
  queueState: string;
  supportedActions: string[];
  correctable: Array<{
    field: string;
    type: string;
    values?: string[];
    targeted: boolean;
    current: { value: unknown; status: string; confidence: { level: string }; basis: string | null };
  }>;
  targetFields: string[];
};

async function raise(key: string, input: Parameters<ApiHarness['market']['reviews']['raise']>[0]) {
  const { item } = await h.market.reviews.raise(input);
  ids[key] = item._id;
  return item;
}

beforeAll(async () => {
  h = await startApiHarness('review');
  await h.seedSponsorRegister();
  acmeId = (await h.market.companies.col.findOne({ 'identity.normalizedName': 'acme ltd' }))!._id;
  const board = await h.seedGreenhouseBoard(acmeId);
  // The property test retries every retryable item, including the board's parser_failure: a
  // retry fetches the listing, so the board must not point at the real Greenhouse host (the
  // Market egress guard fails the file on any non-loopback connect; PR #11 re-verify #7 LOW-3).
  await h.market.sources.update(
    board._id,
    { endpoint: { boardToken: 'acme', url: 'http://127.0.0.1:9/v1/boards/acme/jobs?content=true' } },
    UNAUTHENTICATED_INTERNAL_OPERATOR,
  );
  jobIds = (await h.market.jobs.col.find({ companyId: acmeId }).sort({ _id: 1 }).toArray()).map((j) => j._id);
  const other = (await h.market.companies.col.findOne({ status: 'active', _id: { $ne: acmeId } }))!;
  const manual = await h.post('/api/sources', {
    key: 'test:manual',
    name: 'Manual (harmless workflow)',
    category: 'manual_import',
    provider: 'manual',
    acquisition: { workflowKey: 'market.freshness.sweep' },
    freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 60 },
    authority: { tier: 'third_party' },
  });
  manualSourceId = (manual.body as { source: { _id: string } }).source._id;
  const off = await h.post('/api/sources', {
    key: 'test:disabled',
    name: 'Disabled',
    category: 'manual_import',
    provider: 'manual',
    acquisition: { workflowKey: 'market.freshness.sweep' },
    freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 60 },
    authority: { tier: 'third_party' },
    enabled: false,
  });
  disabledSourceId = (off.body as { source: { _id: string } }).source._id;
  const job0 = (await h.market.jobs.col.findOne({ _id: jobIds[0] }))!;

  await raise('employment', {
    type: 'employment_conflict',
    severity: 'medium',
    dedupeKey: 't:employment',
    entity: { kind: 'job', id: jobIds[0]! },
    subject: 'work model conflict',
    reason: 'r',
    context: { flag: 'work_model_conflict', observationId: job0.content.primaryObservationId },
    allowedActions: ['confirm', 'correct', 'retry', 'dismiss'],
  });
  await raise('salary', {
    type: 'salary_suspicious',
    severity: 'low',
    dedupeKey: 't:salary',
    entity: { kind: 'job', id: jobIds[1]! },
    subject: 's',
    reason: 'r',
    allowedActions: ['confirm', 'correct', 'dismiss'],
  });
  await raise('jobFields', {
    type: 'field_conflict',
    severity: 'low',
    dedupeKey: 't:jobFields',
    entity: { kind: 'job', id: jobIds[2]! },
    subject: 's',
    reason: 'r',
    context: { fields: ['compensation', 'geography.remoteScope'] },
    allowedActions: ['confirm', 'correct', 'retry', 'dismiss'],
  });
  await raise('companyDomain', {
    type: 'field_conflict',
    severity: 'medium',
    dedupeKey: 't:companyDomain',
    entity: { kind: 'company', id: acmeId },
    subject: 's',
    reason: 'r',
    context: { field: 'identity.domain', values: ['acme.com', 'acme.io'] },
    allowedActions: ['confirm', 'correct', 'dismiss'],
  });
  await raise('jobDup', {
    type: 'job_duplicate',
    severity: 'medium',
    dedupeKey: 't:jobDup',
    entity: { kind: 'job', id: jobIds[3]! },
    candidates: [{ kind: 'job', id: jobIds[4]!, label: 'j' }],
    subject: 's',
    reason: 'r',
    allowedActions: ['merge', 'keep_separate', 'dismiss'],
  });
  await raise('companyDup', {
    type: 'company_duplicate',
    severity: 'high',
    dedupeKey: 't:companyDup',
    entity: { kind: 'company', id: acmeId },
    candidates: [
      { kind: 'company', id: 'cmp_missing', label: 'gone' },
      { kind: 'company', id: other._id, label: 'o' },
    ],
    subject: 's',
    reason: 'r',
    allowedActions: ['merge', 'keep_separate', 'dismiss'],
  });
  await raise('parser', {
    type: 'parser_failure',
    severity: 'low',
    dedupeKey: 't:parser',
    entity: { kind: 'source', id: manualSourceId },
    subject: 's',
    reason: 'r',
    allowedActions: ['retry', 'dismiss'],
  });
  await raise('anomalyDisabled', {
    type: 'source_anomaly',
    severity: 'high',
    dedupeKey: 't:anomaly',
    entity: { kind: 'source', id: disabledSourceId },
    subject: 's',
    reason: 'r',
    allowedActions: ['retry', 'dismiss'],
  });
  await raise('careers', {
    type: 'careers_discovery',
    severity: 'low',
    dedupeKey: 't:careers',
    entity: { kind: 'company', id: other._id },
    subject: 's',
    reason: 'r',
    context: { sourceId: manualSourceId },
    allowedActions: ['confirm', 'dismiss'],
  });
  // Bulk items for paging: priorities, timestamps and statuses vary.
  for (let i = 0; i < 260; i++) {
    const item = await raise(`bulk${i}`, {
      type: (['parser_failure', 'source_anomaly', 'careers_discovery'] as const)[i % 3]!,
      severity: (['low', 'medium', 'high'] as const)[i % 3]!,
      priorityBoost: i % 4,
      dedupeKey: `t:bulk:${i}`,
      entity: { kind: i % 3 === 2 ? 'company' : 'source', id: i % 3 === 2 ? acmeId : manualSourceId },
      subject: `bulk ${i}`,
      reason: 'r',
      allowedActions: ['dismiss'],
    });
    const set: Partial<ReviewItemDoc> = {
      createdAt: new Date(Date.parse('2026-09-01T00:00:00Z') + (i % 40) * 60_000),
      updatedAt: new Date(Date.parse('2026-09-10T00:00:00Z') + (i % 30) * 60_000),
    };
    if (i % 10 === 0) set.status = 'resolved';
    if (i % 10 === 1) set.status = 'dismissed';
    if (i % 17 === 0 && !set.status)
      set.claim = {
        operationId: 'op_x',
        actor: { kind: 'internal-operator', id: 'x' },
        action: 'dismiss',
        reason: 'x',
        at: new Date(),
      };
    if (i % 13 === 0 && !set.status)
      set.lastFailure = {
        operationId: 'op_y',
        action: 'dismiss',
        kind: 'domain_conflict',
        code: 'invalid_state',
        message: 'm',
        at: new Date(),
      };
    await h.market.reviews.col.updateOne({ _id: item._id }, { $set: set });
  }
}, 180_000);

afterAll(async () => {
  await h?.close();
});

const idsOf = (rows: Array<{ _id: string }>) => rows.map((r) => r._id);
const allItems = () => h.market.reviews.col.find({}).toArray();
const row = async (key: string) => {
  const page = expectDto(
    reviewListV2ResponseDto,
    (
      await h.get(
        `/api/review?status=all&include=actions&entityId=${(await h.market.reviews.get(ids[key]!)).entity.id}&limit=200`,
      )
    ).body,
  );
  return page.items.find((i) => i._id === ids[key]) as unknown as Row;
};

describe('GET /api/review v2: sort, keyset pagination, filters, facets', () => {
  it('open queue: priority desc, oldest first, `_id` tiebreak; walked with a cursor', async () => {
    const open = (await allItems()).filter((i) => i.status === 'open');
    const { rows } = await traverse<{ _id: string }>(h, '/api/review?limit=37&count=none');
    expect(idsOf(rows)).toEqual(
      mongoOrderBy(open, [
        [(i) => i.priority, -1],
        [(i) => i.createdAt, 1],
      ]),
    );
  });

  it.each([
    [
      'status=resolved',
      (i: ReviewItemDoc) => i.status === 'resolved',
      [[(i: ReviewItemDoc) => i.updatedAt, -1]],
    ],
    ['status=all&sort=createdAt', () => true, [[(i: ReviewItemDoc) => i.createdAt, 1]]],
    [
      'status=open&sort=-priority',
      (i: ReviewItemDoc) => i.status === 'open',
      [
        [(i: ReviewItemDoc) => i.priority, 1],
        [(i: ReviewItemDoc) => i.createdAt, -1],
      ],
    ],
  ] as const)('%s', async (query, filter, fields) => {
    const docs = (await allItems()).filter(filter);
    const { rows } = await traverse<{ _id: string }>(h, `/api/review?${query}&limit=29&count=none`);
    expect(idsOf(rows)).toEqual(mongoOrderBy(docs, fields as never));
  });

  const check = async (query: string, predicate: (i: ReviewItemDoc) => boolean) => {
    const expected = (await allItems()).filter(predicate).map((i) => i._id);
    const { rows, first } = await traverse<{ _id: string }>(h, `/api/review?${query}&limit=200`);
    expect(new Set(idsOf(rows))).toEqual(new Set(expected));
    expect(first.total).toBe(expected.length);
    expect(expected.length).toBeGreaterThan(0);
  };

  it('type[], severity[], entityKind[], entityId, scopeId, resolving, hasFailure, createdAfter', async () => {
    const open = (i: ReviewItemDoc) => i.status === 'open';
    await check(
      'type=parser_failure,source_anomaly',
      (i) => open(i) && ['parser_failure', 'source_anomaly'].includes(i.type),
    );
    await check('severity=high&status=all', (i) => i.severity === 'high');
    await check(
      'entityKind=job,observation',
      (i) => open(i) && ['job', 'observation'].includes(i.entity.kind),
    );
    await check(
      `entityId=${jobIds[4]}`,
      (i) => open(i) && (i.entity.id === jobIds[4] || i.candidates.some((c) => c.id === jobIds[4])),
    );
    await check(
      `scopeId=${manualSourceId}`,
      (i) => open(i) && (i.entity.id === manualSourceId || i.context.sourceId === manualSourceId),
    );
    await check('resolving=true', (i) => open(i) && !!i.claim);
    await check('hasFailure=true&resolving=false', (i) => open(i) && !!i.lastFailure && !i.claim);
    await check(
      'status=all&createdAfter=2026-09-01T00:30:00Z',
      (i) => i.createdAt >= new Date('2026-09-01T00:30:00Z'),
    );
  });

  it('facets count by type and severity, each ignoring its own filter', async () => {
    const res = expectDto(
      reviewListV2ResponseDto,
      (await h.get('/api/review?facets=true&type=parser_failure&severity=high')).body,
    );
    const open = (await allItems()).filter((i) => i.status === 'open');
    const count = <K extends string>(xs: ReviewItemDoc[], key: (i: ReviewItemDoc) => K) =>
      xs.reduce<Record<string, number>>((m, i) => ({ ...m, [key(i)]: (m[key(i)] ?? 0) + 1 }), {});
    expect(res.facets?.type).toEqual(
      count(
        open.filter((i) => i.severity === 'high'),
        (i) => i.type,
      ),
    );
    expect(res.facets?.severity).toEqual(
      count(
        open.filter((i) => i.type === 'parser_failure'),
        (i) => i.severity,
      ),
    );
    expect(res.items.every((i) => i.type === 'parser_failure' && i.severity === 'high')).toBe(true);
    expect((await h.get('/api/review')).body).not.toHaveProperty('facets');
  });
});

describe('GET /api/review v2: server-computed state, actions and correctable fields', () => {
  it('queueState reflects claim, failure and status; closed and resolving items support nothing', async () => {
    const { rows } = await traverse<Row>(h, '/api/review?status=all&limit=200&include=actions');
    for (const r of rows) {
      const expected =
        r.status !== 'open' ? r.status : r.claim ? 'resolving' : r.lastFailure ? 'failed' : 'open';
      expect(r.queueState).toBe(expected);
      if (r.status !== 'open' || r.claim) expect(r.supportedActions).toEqual([]);
      for (const a of r.supportedActions) expect(r.allowedActions).toContain(a);
    }
    // (A claim is informational; the durable operation decides who may resolve — see ADR-0017.)
    expect(rows.some((r) => r.queueState === 'resolving')).toBe(true);
    expect(rows.some((r) => r.queueState === 'failed' && r.supportedActions.includes('dismiss'))).toBe(true);
  });

  it('correctable descriptors: typed fields with current values, targeted first', async () => {
    const employment = await row('employment');
    const job0 = (await h.market.jobs.col.findOne({ _id: jobIds[0] }))!;
    expect(employment.targetFields).toEqual(['workModel']);
    expect(employment.correctable[0]).toEqual({
      field: 'workModel',
      path: 'geography.workModel',
      type: 'enum',
      values: [...WORK_MODELS],
      targeted: true,
      current: {
        value: job0.geography.workModel.value,
        status: job0.geography.workModel.status,
        confidence: { level: job0.geography.workModel.confidence.level },
        basis: job0.geography.workModel.confidence.reasons[0] ?? null,
        alternates: job0.geography.workModel.conflicts.length,
      },
    });
    expect(new Set(employment.correctable.map((c) => c.field))).toEqual(JOB_OVERRIDABLE);
    expect(Object.keys(JOB_CORRECTABLE_FIELDS).sort()).toEqual([...JOB_OVERRIDABLE].sort());
    expect((await row('jobFields')).targetFields).toEqual(['compensation', 'remoteScope']);
    expect((await row('salary')).targetFields).toEqual(['compensation']);
    const company = await row('companyDomain');
    expect(company.targetFields).toEqual(['identity.domain']);
    expect(company.correctable.map((c) => [c.field, c.type, c.targeted])).toEqual([
      ['identity.domain', 'string', true],
      ['identity.website', 'string', false],
      ['identity.displayName', 'string', false],
    ]);
    expect(company.correctable.find((c) => c.field === 'identity.displayName')?.current).toMatchObject({
      value: 'Acme Ltd',
      status: 'known',
    });
    expect((await row('parser')).correctable).toEqual([]);
  });

  it('supported actions follow the domain: a disabled source cannot be retried; an invalid candidate is skipped', async () => {
    expect((await row('parser')).supportedActions).toEqual(['retry', 'dismiss']);
    expect((await row('anomalyDisabled')).supportedActions).toEqual(['dismiss']);
    expectValidationError(
      await h.post(`/api/review/${ids.anomalyDisabled}/resolve`, { action: 'retry', reason: 'try it' }),
    );
    expect((await row('companyDup')).supportedActions).toEqual(['merge', 'keep_separate', 'dismiss']);
    expect((await row('careers')).supportedActions).toEqual(['confirm', 'dismiss']);
    expect((await row('employment')).supportedActions).toEqual(['confirm', 'correct', 'retry', 'dismiss']);
  });

  it('supportedActions are computed on the detail, and on the list only with include=actions', async () => {
    const plain = expectDto(reviewListV2ResponseDto, (await h.get('/api/review?limit=50')).body);
    expect(plain.items.length).toBeGreaterThan(0);
    for (const r of plain.items) expect(r).not.toHaveProperty('supportedActions');
    const probed = expectDto(
      reviewListV2ResponseDto,
      (await h.get('/api/review?limit=50&include=actions')).body,
    );
    expect(probed.items.map((r) => r._id)).toEqual(plain.items.map((r) => r._id));
    for (const r of probed.items) expect(Array.isArray(r.supportedActions)).toBe(true);
    const d = expectDto(reviewDetailResponseDto, (await h.get(`/api/review/${ids.employment}`)).body);
    expect(d.item.supportedActions).toEqual(['confirm', 'correct', 'retry', 'dismiss']);
    expectValidationError(await h.get('/api/review?include=everything'));
  });

  it('a transient probe failure degrades that item only (supportedActions: null), never the page', async () => {
    const svc = h.api.market.reviewService; // the API process's service (h.market is the worker's)
    const original = svc.accepts.bind(svc);
    const broken = ids.employment!;
    svc.accepts = async (item, decision) => {
      if (item._id === broken) throw new Error('mongo: connection reset');
      return original(item, decision);
    };
    try {
      const page = expectDto(
        reviewListV2ResponseDto,
        (await h.get('/api/review?limit=200&include=actions')).body,
      );
      const byId = new Map(page.items.map((r) => [r._id, r]));
      expect(byId.get(broken)?.supportedActions).toBeNull();
      expect((byId.get(broken) as unknown as Row).correctable.length).toBeGreaterThan(0);
      expect(page.items.filter((r) => r._id !== broken).every((r) => Array.isArray(r.supportedActions))).toBe(
        true,
      );
      const detail = await h.get(`/api/review/${broken}`);
      expect(detail.status).toBe(200);
      expect(expectDto(reviewDetailResponseDto, detail.body).item.supportedActions).toBeNull();
    } finally {
      svc.accepts = original;
    }
    // Deterministic rejections are not failures: they just drop the action.
    expect((await row('anomalyDisabled')).supportedActions).toEqual(['dismiss']);
  });

  it('property: every supported action of every open item is accepted by resolve', async () => {
    const { rows } = await traverse<Row>(h, '/api/review?limit=200&resolving=false&include=actions');
    const sample = rows.filter((r) => !r.dedupeKey.startsWith('t:bulk') || r.dedupeKey.endsWith(':5'));
    expect(sample.length).toBeGreaterThan(8);
    let n = 0;
    let checked = 0;
    for (const r of sample) {
      for (const action of r.supportedActions) {
        // A fresh copy per action (a decision closes its item).
        const raw = (await h.market.reviews.get(r._id))!;
        const copy = reviewItemDocSchema.parse({
          ...raw,
          _id: newId('rev'),
          dedupeKey: `${raw.dedupeKey}#${n++}`,
        });
        await h.market.reviews.col.insertOne(copy);
        // Earlier decisions (merges, corrections) change the domain: the property is about what
        // the copy supports *now*.
        const now = expectDto(reviewDetailResponseDto, (await h.get(`/api/review/${copy._id}`)).body).item;
        if (!(now.supportedActions as string[]).includes(action)) continue;
        checked += 1;
        const attempts: Array<Record<string, unknown>> = [];
        if (action === 'merge' || action === 'keep_separate')
          attempts.push(...copy.candidates.map((c) => ({ targetId: c.id })));
        else if (action === 'correct')
          for (const f of r.correctable) {
            if (f.type === 'enum')
              attempts.push(...(f.values ?? []).slice(0, 2).map((v) => ({ field: f.field, value: v })));
            else if (f.type === 'string') attempts.push({ field: f.field, value: 'example.org' });
            else if (f.current.value !== null && f.current.value !== undefined)
              attempts.push({ field: f.field, value: f.current.value });
          }
        else attempts.push({});
        let status = 0;
        for (const extra of attempts) {
          const res = await h.post(`/api/review/${copy._id}/resolve`, {
            action,
            reason: 'property check',
            ...extra,
          });
          status = res.status;
          if (status === 200) break;
          expect(status).toBe(400); // an invalid target/value for this attempt, never a server error
        }
        expect(`${r.type}:${action}:${status}`).toBe(`${r.type}:${action}:200`);
      }
    }
    expect(checked).toBeGreaterThan(15);
  }, 120_000);
});

describe('GET /api/review/:id v2', () => {
  it('the item carries the list fields; the detail adds job observations and the targeted facts', async () => {
    const d = expectDto(reviewDetailResponseDto, (await h.get(`/api/review/${ids.employment}`)).body);
    expect(d.item.queueState).toBe('open');
    expect(d.item.supportedActions).toContain('correct');
    expect(d.observations.map((o) => (o as { _id: string })._id)).toEqual([
      (await h.market.jobs.col.findOne({ _id: jobIds[0] }))!.content.primaryObservationId,
    ]);
    expect(d.targetedFacts.map((f) => f.field)).toEqual(['workModel']);
    expect(d.targetedFacts[0]!.fact).toHaveProperty('evidence');
    const src = expectDto(reviewDetailResponseDto, (await h.get(`/api/review/${ids.parser}`)).body);
    expect(src.targetedFacts).toEqual([]);
  });
});

describe('GET /api/review v2: validation and index use', () => {
  it.each([
    ['bad severity', '/api/review?severity=critical'],
    ['bad entity kind', '/api/review?entityKind=person'],
    ['unknown sort', '/api/review?sort=severity'],
    ['bad resolving', '/api/review?resolving=yes'],
    ['bad status', '/api/review?status=closed'],
    ['bad facets', '/api/review?facets=1'],
    ['after with offset', '/api/review?after=x&offset=1'],
    ['detail query', `/api/review/rev_x?view=summary`],
  ])('400: %s', async (_name, url) => {
    expectValidationError(await h.get(url));
  });

  it('queue pages are index-backed without a blocking sort', async () => {
    const db = h.market.ctx.db;
    const q = (query: Record<string, string | undefined>) => reviewListQuerySchema.parse(query);
    const cursor = ((await h.get('/api/review?limit=10')).body as { nextCursor: string }).nextCursor;
    for (const query of [
      {},
      { after: cursor },
      { status: 'resolved' },
      { sort: 'createdAt' },
      { status: 'dismissed', sort: '-priority' },
    ]) {
      const stages = planStages(await explainReviewList(db, q(query)));
      expect(stages).toContain('IXSCAN');
      expect(stages).not.toContain('COLLSCAN');
      expect(stages).not.toContain('SORT');
    }
    for (const query of [{ scopeId: manualSourceId }, { entityId: acmeId }, { type: 'parser_failure' }]) {
      const stages = planStages(await explainReviewList(db, q(query)));
      expect(stages).not.toContain('COLLSCAN');
    }
  });
});

describe('POST /api/review/:id/{claim,release} (API-9 triage claims)', () => {
  type Assignment = { holderHash: string; claimedAt: string; expiresAt: string };
  type TriageBody = { item: Omit<Row, 'assignment'> & { assignment?: Assignment } };
  const call = async (id: string, op: 'claim' | 'release', payload: unknown, key?: string) => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/review/${id}/${op}`,
      payload: payload as never,
      headers: key ? { 'idempotency-key': key } : {},
    });
    return { status: res.statusCode, body: res.json() as TriageBody, raw: res.body };
  };
  const A = 'holder-alice-0001';
  const B = 'holder-bob-000002';
  const fresh = async (tag: string) =>
    (
      await h.market.reviews.raise({
        type: 'employment_conflict',
        severity: 'low',
        dedupeKey: `t:triage:${tag}:${newId('x')}`,
        entity: { kind: 'job', id: jobIds[0]! },
        subject: 's',
        reason: 'r',
        allowedActions: ['confirm', 'dismiss'],
      })
    ).item._id;

  it('validates the holder token, the body and the item', async () => {
    const id = await fresh('validation');
    expectValidationError(await call(id, 'claim', {}));
    expectValidationError(await call(id, 'claim', { holder: 'short' }));
    expectValidationError(await call(id, 'claim', { holder: 'has space in it' }));
    expectValidationError(await call(id, 'claim', { holder: 'x'.repeat(129) }));
    expectValidationError(await call(id, 'claim', { holder: A, ttlMinutes: 0 }));
    expectValidationError(await call(id, 'claim', { holder: A, ttlMinutes: 241 }));
    expectValidationError(await call(id, 'claim', { holder: A, assignee: 'bob' }));
    expectValidationError(await call(id, 'claim', { holder: A }, 'k'.repeat(201)));
    expectValidationError(await call(id, 'release', {}));
    expect((await call('rev_missing', 'claim', { holder: A })).status).toBe(404);
    expect((await call('rev_missing', 'release', { holder: A })).status).toBe(404);
  });

  it('claim, renew by the same holder, 409 for another holder, release by the holder (idempotent)', async () => {
    const id = await fresh('flow');
    const t0 = Date.now();
    const a = await call(id, 'claim', { holder: A }, 'attempt-1');
    expect(a.status).toBe(200);
    expectDto(reviewTriageResponseDto, a.body);
    const first = a.body.item.assignment!;
    expect(first.holderHash).toBe(triageHolderHash(A));
    expect(first.holderHash).toBe(createHash('sha256').update(A).digest('hex')); // client-computable
    expect(Date.parse(first.expiresAt) - t0).toBeGreaterThan(29 * 60_000);
    // The holder token and the attempt key never appear raw.
    expect(a.raw).not.toContain(A);
    expect(a.raw).not.toContain('attempt-1');
    // A replayed attempt audits once.
    expect((await call(id, 'claim', { holder: A }, 'attempt-1')).status).toBe(200);
    const claimed = (await h.get('/api/review?claimed=true&limit=200')).body as { items: Row[] };
    expect(claimed.items.map((r) => r._id)).toContain(id);
    const unclaimed = await traverse<Row>(h, '/api/review?claimed=false&limit=200&count=none');
    expect(unclaimed.rows.map((r) => r._id)).not.toContain(id);
    const renewed = (await call(id, 'claim', { holder: A, ttlMinutes: 120 })).body.item.assignment!;
    expect(renewed.claimedAt).toBe(first.claimedAt);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(first.expiresAt));
    const b = await call(id, 'claim', { holder: B });
    expect(b.status).toBe(409);
    expect(expectDto(errorResponseDto, b.body).error.details).toMatchObject({
      assignment: { holderHash: triageHolderHash(A), expiresAt: renewed.expiresAt },
    });
    expect((await call(id, 'release', { holder: B })).status).toBe(409);
    const released = await call(id, 'release', { holder: A });
    expect(released.status).toBe(200);
    expect(released.body.item).not.toHaveProperty('assignment');
    expect((await call(id, 'release', { holder: A })).status).toBe(200);
    expect((await call(id, 'claim', { holder: B })).status).toBe(200);
    // Audited on the review item only, once per claim and release, never with the holder.
    const events = await h.market.audit.list({ reviewItemId: id }, 20);
    expect(events.map((e) => e.action).sort()).toEqual([
      'review.claimed',
      'review.claimed',
      'review.released',
    ]);
    for (const e of events) {
      expect(e.entity).toEqual({ kind: 'review_item', id });
      expect(JSON.stringify(e)).not.toContain(A);
      expect(JSON.stringify(e)).not.toContain('attempt-1');
    }
    expect(await h.market.audit.list({ entityKind: 'job', entityId: jobIds[0]! }, 200)).not.toContainEqual(
      expect.objectContaining({ action: 'review.claimed' }),
    );
  });

  it('cooperative: any client can force-release a live claim', async () => {
    const id = await fresh('force');
    expect((await call(id, 'claim', { holder: A })).status).toBe(200);
    const forced = await call(id, 'release', { holder: B, force: true });
    expect(forced.status).toBe(200);
    expect(forced.body.item).not.toHaveProperty('assignment');
    expect((await h.market.audit.list({ reviewItemId: id }, 20)).map((e) => e.action)).toContain(
      'review.claim_forced_release',
    );
  });

  it('an expired claim no longer blocks and is hidden from rows and from claim/release responses', async () => {
    const id = await fresh('expiry');
    expect((await call(id, 'claim', { holder: A })).status).toBe(200);
    await h.market.reviews.col.updateOne(
      { _id: id },
      { $set: { 'assignment.expiresAt': new Date(Date.now() - 1000) } },
    );
    const row = (await h.get(`/api/review/${id}`)).body as { item: Row };
    expect(row.item).not.toHaveProperty('assignment');
    const unclaimed = await traverse<Row>(h, '/api/review?claimed=false&limit=200&count=none');
    expect(unclaimed.rows.map((r) => r._id)).toContain(id);
    const noop = await call(id, 'release', { holder: B }); // nothing live to release
    expect(noop.status).toBe(200);
    expect(noop.body.item).not.toHaveProperty('assignment');
    const taken = await call(id, 'claim', { holder: B });
    expect(taken.status).toBe(200);
    expect(taken.body.item.assignment?.holderHash).toBe(triageHolderHash(B));
  });

  it('concurrent claims by different holders: exactly one wins', async () => {
    const id = await fresh('race');
    const holders = ['racer-000001', 'racer-000002', 'racer-000003', 'racer-000004'];
    const results = await Promise.all(holders.map((holder) => call(id, 'claim', { holder })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
  });

  it('closing an item removes its claim: no assignment on the resolve body, the record detail or the stored item', async () => {
    const id = await fresh('close');
    expect((await call(id, 'claim', { holder: A })).status).toBe(200);
    const resolved = await h.post(`/api/review/${id}/resolve`, { action: 'dismiss', reason: 'not an issue' });
    expect(resolved.status).toBe(200);
    expect((resolved.body as { item: Row }).item).not.toHaveProperty('assignment');
    expect((await h.market.reviews.col.findOne({ _id: id }))!).not.toHaveProperty('assignment');
    const job = (await h.get(`/api/jobs/${jobIds[0]}`)).body as { reviews: Row[] };
    expect(job.reviews.find((r) => r._id === id)).toBeDefined();
    expect(job.reviews.find((r) => r._id === id)).not.toHaveProperty('assignment');
    // A closed item whose (legacy) stored assignment survived is still never shown as claimed.
    await h.market.reviews.col.updateOne(
      { _id: id },
      {
        $set: {
          assignment: {
            holderHash: triageHolderHash(A),
            actor: { kind: 'system', id: 't' },
            claimedAt: new Date(),
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        },
      },
    );
    const again = (await h.get(`/api/jobs/${jobIds[0]}`)).body as { reviews: Row[] };
    expect(again.reviews.find((r) => r._id === id)).not.toHaveProperty('assignment');
    expect((await h.get(`/api/review/${id}`)).body).not.toHaveProperty('item.assignment');
    // claimed=false includes the closed item (the closed-item branch), claimed=true never does.
    const unclaimed = await traverse<Row>(h, '/api/review?claimed=false&status=all&limit=200&count=none');
    expect(unclaimed.rows.map((r) => r._id)).toContain(id);
    const claimed = await traverse<Row>(h, '/api/review?claimed=true&status=all&limit=200&count=none');
    expect(claimed.rows.map((r) => r._id)).not.toContain(id);
  });

  it('a forced release records the displaced holder hash; forcing an expired or closed claim changes nothing', async () => {
    const id = await fresh('force-audit');
    expect((await call(id, 'claim', { holder: A })).status).toBe(200);
    expect((await call(id, 'release', { holder: B, force: true })).status).toBe(200);
    const forced = (await h.market.audit.list({ reviewItemId: id }, 20)).find(
      (e) => e.action === 'review.claim_forced_release',
    )!;
    expect(forced.details).toEqual({ displacedHolderHash: triageHolderHash(A) });
    // Expired claim: 200, unchanged, not audited.
    expect((await call(id, 'claim', { holder: A })).status).toBe(200);
    await h.market.reviews.col.updateOne(
      { _id: id },
      { $set: { 'assignment.expiresAt': new Date(Date.now() - 1000) } },
    );
    const before = (await h.market.audit.list({ reviewItemId: id }, 20)).length;
    const expired = await call(id, 'release', { holder: B, force: true });
    expect(expired.status).toBe(200);
    expect(expired.body.item).not.toHaveProperty('assignment');
    expect((await h.market.reviews.col.findOne({ _id: id }))!.assignment).toBeDefined(); // left as is
    expect(await h.market.audit.list({ reviewItemId: id }, 20)).toHaveLength(before);
    // Closed item: 200, unchanged, not audited.
    await h.market.reviews.col.updateOne(
      { _id: id },
      { $set: { status: 'dismissed', 'assignment.expiresAt': new Date(Date.now() + 3_600_000) } },
    );
    const closed = await call(id, 'release', { holder: B, force: true });
    expect(closed.status).toBe(200);
    expect(closed.body.item).not.toHaveProperty('assignment');
    expect(await h.market.audit.list({ reviewItemId: id }, 20)).toHaveLength(before);
  });

  it('claims are advisory: resolve does not require them; closed items are never claimed', async () => {
    const id = await fresh('advisory');
    expect((await call(id, 'claim', { holder: A })).status).toBe(200);
    const resolved = await h.post(`/api/review/${id}/resolve`, { action: 'dismiss', reason: 'not an issue' });
    expect(resolved.status).toBe(200);
    expect((await call(id, 'claim', { holder: A })).status).toBe(409);
    const closed = (await h.get(`/api/review/${id}`)).body as { item: Row };
    expect(closed.item).not.toHaveProperty('assignment');
    // A closed item whose stale assignment is still stored never counts as claimed.
    const claimed = (await h.get('/api/review?claimed=true&status=all&limit=200')).body as { items: Row[] };
    expect(claimed.items.map((r) => r._id)).not.toContain(id);
  });
});
