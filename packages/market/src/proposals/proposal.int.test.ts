/**
 * Agent proposals raise a review and write nothing canonical until a human approves through
 * the existing resolve flow. Approval is idempotent: a resumed decision does not register or
 * import twice.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '@aptamind/contracts';
import { artifactIdForHash } from '@aptamind/storage';
import { createTestInfra, type TestInfra } from '@aptamind/testing';
import type { ImportType } from '../imports/import.schema';
import type { MarketDomain } from '../market-domain';
import {
  IMPORT_PROPOSAL_MAX_BYTES,
  PROPOSAL_REASON_MAX,
  PROPOSAL_SUBJECT_MAX,
  importProposalDedupeKey,
  sourceProposalDedupeKey,
} from './proposal.service';
import { createMarketTestRuntime } from '../test-harness';

let infra: TestInfra;
let t: Awaited<ReturnType<typeof createMarketTestRuntime>>;
let runNowCalls = 0;
let registerCalls = 0;
let originalRunNow: MarketDomain['sources']['runNow'];
let originalRegister: MarketDomain['sources']['register'];

beforeAll(async () => {
  infra = await createTestInfra('market_proposals');
  t = await createMarketTestRuntime(infra);
  originalRunNow = t.market.sources.runNow.bind(t.market.sources);
  originalRegister = t.market.sources.register.bind(t.market.sources);
  t.market.sources.runNow = async (...args) => {
    runNowCalls += 1;
    return originalRunNow(...args);
  };
  t.market.sources.register = async (...args) => {
    registerCalls += 1;
    return originalRegister(...args);
  };
});

afterAll(async () => {
  if (t && originalRunNow) t.market.sources.runNow = originalRunNow;
  if (t && originalRegister) t.market.sources.register = originalRegister;
  await t?.stop();
  await infra?.cleanup();
});

let seq = 0;
const tag = () => `mcp-prop-${++seq}`;

function fixtureInput(key: string, enabled?: boolean) {
  return {
    key,
    name: `Proposed ${key}`,
    category: 'manual_import' as const,
    provider: 'fixture',
    acquisition: { workflowKey: 'market.noop' },
    freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 100_000 },
    authority: { tier: 'official_site' as const },
    ...(enabled === undefined ? {} : { enabled }),
  };
}

async function registerFixture(key = tag()) {
  const { source } = await t.market.sources.register(fixtureInput(key), t.actor);
  return source;
}

async function registerDirectory(key = tag()) {
  const { source } = await t.market.sources.register(
    {
      key: `directory:${key}`,
      name: `${key} directory`,
      category: 'company_universe',
      provider: 'company_directory',
      acquisition: {
        workflowKey: 'market.company_directory.import',
        config: { columns: { name: 'Company', domain: 'Domain' } },
      },
      freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 100_000 },
      governance: { accessMethod: 'manual_upload' },
    },
    t.actor,
  );
  return source;
}

async function canonical(sourceId: string) {
  const [snapshots, imports] = await Promise.all([
    infra.db.collection('market_snapshots').countDocuments({ sourceId }),
    infra.db.collection('market_imports').countDocuments({ sourceId }),
  ]);
  return { snapshots, imports, runs: runNowCalls };
}

const REASON = 'A human reviewer decided this proposal';

function resolve(itemId: string, action: 'create_new' | 'reject' | 'dismiss', operationId: string) {
  return t.market.reviewService.resolve(itemId, { action, reason: REASON }, t.actor, { operationId });
}

async function proposedAudits(action: string, entityId: string) {
  const events = await t.market.audit.list({ entityKind: 'source', entityId });
  return events.filter((event) => event.action === action);
}

describe('source proposals', () => {
  it('raises a review and registers nothing', async () => {
    const key = tag();
    const { item, created } = await t.market.proposals.proposeSource(fixtureInput(key), t.actor, {
      idempotencyKey: `idem-${key}`,
    });
    expect(created).toBe(true);
    expect(item).toMatchObject({
      type: 'source_proposal',
      severity: 'low',
      status: 'open',
      dedupeKey: sourceProposalDedupeKey(key),
      entity: { kind: 'source', id: key },
      allowedActions: ['create_new', 'reject', 'dismiss'],
      occurrences: 1,
    });
    expect(item.context.input).toMatchObject({ key, enabled: true });
    expect(item.subject.length).toBeLessThanOrEqual(PROPOSAL_SUBJECT_MAX);
    expect(await t.market.sources.getByKey(key)).toBeNull();
    expect(await proposedAudits('proposal.source_proposed', key)).toHaveLength(1);
  });

  it('bounds a long proposed name onto the review reason', async () => {
    const key = tag();
    const { item } = await t.market.proposals.proposeSource(
      { ...fixtureInput(key), name: 'N'.repeat(3000) },
      t.actor,
      { idempotencyKey: `idem-long-${key}` },
    );
    expect(item.reason.length).toBeLessThanOrEqual(PROPOSAL_REASON_MAX);
    expect(item.subject.length).toBeLessThanOrEqual(PROPOSAL_SUBJECT_MAX);
    expect(await t.market.sources.getByKey(key)).toBeNull();
  });

  it('dedupes an open source proposal and replays an idempotency key', async () => {
    const key = tag();
    const first = await t.market.proposals.proposeSource(fixtureInput(key), t.actor, {
      idempotencyKey: `idem-a-${key}`,
    });
    const replay = await t.market.proposals.proposeSource(fixtureInput(key), t.actor, {
      idempotencyKey: `idem-a-${key}`,
    });
    expect(replay.created).toBe(false);
    expect(replay.item._id).toBe(first.item._id);
    expect(replay.item.occurrences).toBe(1);
    expect(await proposedAudits('proposal.source_proposed', key)).toHaveLength(1);

    const again = await t.market.proposals.proposeSource(fixtureInput(key), t.actor, {
      idempotencyKey: `idem-b-${key}`,
    });
    expect(again.item._id).toBe(first.item._id);
    expect(again.item.occurrences).toBe(2);
    expect(await proposedAudits('proposal.source_proposed', key)).toHaveLength(2);
    expect(await t.market.sources.getByKey(key)).toBeNull();
  });

  it('refuses to reuse an idempotency key for a different source', async () => {
    const key = tag();
    const other = tag();
    const shared = `idem-shared-${key}`;
    await t.market.proposals.proposeSource(fixtureInput(key), t.actor, { idempotencyKey: shared });
    await expect(
      t.market.proposals.proposeSource(fixtureInput(other), t.actor, { idempotencyKey: shared }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await t.market.sources.getByKey(other)).toBeNull();
    expect(await t.market.reviews.col.countDocuments({ dedupeKey: sourceProposalDedupeKey(other) })).toBe(0);
  });

  it('registers the source once when create_new is approved, including a disabled proposal', async () => {
    const key = tag();
    const { item } = await t.market.proposals.proposeSource(fixtureInput(key), t.actor, {
      idempotencyKey: `idem-approve-${key}`,
    });
    const before = registerCalls;
    const operationId = `rop-approve-${key}`;
    const closed = await resolve(item._id, 'create_new', operationId);
    expect(closed.status).toBe('resolved');
    expect(closed.resolution?.result).toMatchObject({ approved: true, effectApplied: true, key });
    const source = await t.market.sources.getByKey(key);
    expect(source?.enabled).toBe(true);
    expect(registerCalls).toBe(before + 1);

    await resolve(item._id, 'create_new', operationId);
    expect(registerCalls).toBe(before + 1);
    expect(await t.market.sources.col.countDocuments({ key })).toBe(1);

    const disabledKey = tag();
    const proposed = await t.market.proposals.proposeSource(fixtureInput(disabledKey, false), t.actor, {
      idempotencyKey: `idem-off-${disabledKey}`,
    });
    expect(proposed.item.context.input).toMatchObject({ enabled: false });
    const registersBefore = registerCalls;
    await resolve(proposed.item._id, 'create_new', `rop-off-${disabledKey}`);
    expect((await t.market.sources.getByKey(disabledKey))?.enabled).toBe(false);
    expect(registerCalls).toBe(registersBefore + 1);
  });

  it('reject and dismiss register nothing', async () => {
    for (const action of ['reject', 'dismiss'] as const) {
      const key = tag();
      const { item } = await t.market.proposals.proposeSource(fixtureInput(key), t.actor, {
        idempotencyKey: `idem-${action}-${key}`,
      });
      const before = registerCalls;
      const closed = await resolve(item._id, action, `rop-${action}-${key}`);
      expect(closed.status).toBe(action === 'dismiss' ? 'dismissed' : 'resolved');
      expect(closed.resolution?.result).toMatchObject({ applied: false });
      expect(closed.resolution?.result?.approved).toBeUndefined();
      expect(await t.market.sources.getByKey(key)).toBeNull();
      expect(registerCalls).toBe(before);
    }
  });
});

describe('import proposals', () => {
  const csv = 'Company,Domain\nOrbit,orbit.example\n';

  it('stages an artifact and writes no snapshot, import, or run', async () => {
    const source = await registerFixture();
    const before = await canonical(source._id);
    const { item, created } = await t.market.proposals.proposeImport(
      { type: 'snapshot', sourceId: source._id, fileName: 'rows.csv', body: csv, contentType: 'text/csv' },
      t.actor,
      { idempotencyKey: `idem-imp-${source._id}` },
    );
    expect(created).toBe(true);
    expect(item).toMatchObject({
      type: 'import_proposal',
      severity: 'low',
      status: 'open',
      entity: { kind: 'source', id: source._id },
      allowedActions: ['create_new', 'reject', 'dismiss'],
    });
    expect(item.context).toMatchObject({
      type: 'snapshot',
      sourceId: source._id,
      fileName: 'rows.csv',
      contentType: 'text/csv',
      size: new TextEncoder().encode(csv).byteLength,
      rowCount: 2,
    });
    expect(item.evidence[0]).toMatchObject({
      sourceId: source._id,
      artifactId: item.context.artifactId,
      locator: 'import-proposal',
    });
    const artifact = await t.market.ctx.artifacts.get(String(item.context.artifactId));
    expect(artifact.sha256).toBe(item.context.sha256);
    expect(await canonical(source._id)).toEqual(before);
    expect(await proposedAudits('proposal.import_proposed', source._id)).toHaveLength(1);
  });

  it('dedupes the same bytes for one source and replays the idempotency key', async () => {
    const source = await registerFixture();
    const body = `only,once\n${source._id}\n`;
    const first = await t.market.proposals.proposeImport(
      { type: 'snapshot', sourceId: source._id, body, contentType: 'text/csv' },
      t.actor,
      { idempotencyKey: `idem-dedupe-a-${source._id}` },
    );
    const replay = await t.market.proposals.proposeImport(
      { type: 'snapshot', sourceId: source._id, body, contentType: 'text/csv' },
      t.actor,
      { idempotencyKey: `idem-dedupe-a-${source._id}` },
    );
    expect(replay.item._id).toBe(first.item._id);
    expect(replay.item.occurrences).toBe(1);
    const sha = String(first.item.context.sha256);
    expect(first.item.dedupeKey).toBe(
      importProposalDedupeKey(sha, source._id, first.item.context.type as string),
    );
    const second = await t.market.proposals.proposeImport(
      { type: 'snapshot', sourceId: source._id, body, contentType: 'text/csv' },
      t.actor,
      { idempotencyKey: `idem-dedupe-b-${source._id}` },
    );
    expect(second.item._id).toBe(first.item._id);
    expect(second.item.occurrences).toBe(2);
    expect(await proposedAudits('proposal.import_proposed', source._id)).toHaveLength(2);
    expect(await canonical(source._id)).toMatchObject({ snapshots: 0, imports: 0 });
  });

  it('imports exactly once on approval, and a repeated resolve does not import again', async () => {
    const source = await registerFixture();
    const { item } = await t.market.proposals.proposeImport(
      { type: 'snapshot', sourceId: source._id, fileName: 'once.csv', body: csv, contentType: 'text/csv' },
      t.actor,
      { idempotencyKey: `idem-once-${source._id}` },
    );
    const runsBefore = runNowCalls;
    const operationId = `rop-once-${source._id}`;
    const closed = await resolve(item._id, 'create_new', operationId);
    expect(closed.status).toBe('resolved');
    expect(closed.resolution?.result).toMatchObject({
      approved: true,
      effectApplied: true,
      importId: closed.resolution?.result?.plannedImportId,
    });
    expect(await canonical(source._id)).toMatchObject({ snapshots: 1, imports: 1, runs: runsBefore + 1 });

    await resolve(item._id, 'create_new', operationId);
    expect(await canonical(source._id)).toMatchObject({ snapshots: 1, imports: 1, runs: runsBefore + 1 });
  });

  it('resumes a committed approval that failed after commit, still exactly once', async () => {
    const source = await registerFixture();
    const { item } = await t.market.proposals.proposeImport(
      { type: 'snapshot', sourceId: source._id, body: `resume,${source._id}\n`, contentType: 'text/csv' },
      t.actor,
      { idempotencyKey: `idem-resume-${source._id}` },
    );
    const proposals = t.market.proposals;
    const original = proposals.executeApproved.bind(proposals);
    let armed = true;
    proposals.executeApproved = async (reviewItem, op) => {
      if (armed) {
        armed = false;
        throw new Error('proposal effect crashed');
      }
      return original(reviewItem, op);
    };
    const operationId = `rop-resume-${source._id}`;
    const runsBefore = runNowCalls;
    try {
      await expect(resolve(item._id, 'create_new', operationId)).rejects.toThrow(/proposal effect crashed/);
      const decided = await t.market.reviews.get(item._id);
      expect(decided.status).toBe('resolved');
      expect(await canonical(source._id)).toMatchObject({ snapshots: 0, imports: 0, runs: runsBefore });

      const resumed = await resolve(item._id, 'create_new', operationId);
      expect(resumed.resolution?.result?.effectApplied).toBe(true);
      expect(await canonical(source._id)).toMatchObject({ snapshots: 1, imports: 1, runs: runsBefore + 1 });

      await t.market.reviewService.operations.updateOne(
        { _id: item._id },
        {
          $set: { state: 'finalized', 'outbox.proposal': false },
          $unset: { 'result.effectApplied': '' },
        },
      );
      const again = await t.market.proposals.resumeApproved(item._id);
      expect(again.resolution?.result?.effectApplied).toBe(true);
      expect(again.resolution?.result?.importId).toBe(resumed.resolution?.result?.importId);
      expect(await canonical(source._id)).toMatchObject({ snapshots: 1, imports: 1, runs: runsBefore + 1 });
    } finally {
      Reflect.deleteProperty(proposals, 'executeApproved');
    }
  });

  it('reject and dismiss import nothing', async () => {
    for (const action of ['reject', 'dismiss'] as const) {
      const source = await registerFixture();
      const { item } = await t.market.proposals.proposeImport(
        { type: 'snapshot', sourceId: source._id, body: csv, contentType: 'text/csv' },
        t.actor,
        { idempotencyKey: `idem-${action}-${source._id}` },
      );
      const artifactId = String(item.context.artifactId);
      const closed = await resolve(item._id, action, `rop-imp-${action}-${source._id}`);
      expect(closed.status).toBe(action === 'dismiss' ? 'dismissed' : 'resolved');
      expect(await canonical(source._id)).toMatchObject({ snapshots: 0, imports: 0 });
      expect((await t.market.ctx.artifacts.get(artifactId)).sha256).toBe(item.context.sha256);
    }
  });

  it('refuses a disabled or wrong-type source at proposal time and stores no artifact', async () => {
    const disabled = await registerFixture();
    await t.market.sources.col.updateOne({ _id: disabled._id }, { $set: { enabled: false } });
    const disabledBody = `disabled,${disabled._id}\n`;
    await expect(
      t.market.proposals.proposeImport(
        { type: 'snapshot', sourceId: disabled._id, body: disabledBody, contentType: 'text/csv' },
        t.actor,
        { idempotencyKey: `idem-disabled-${disabled._id}` },
      ),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(missingArtifact(disabledBody)).rejects.toMatchObject({ code: 'not_found' });
    expect(
      await t.market.reviews.col.countDocuments({ type: 'import_proposal', 'entity.id': disabled._id }),
    ).toBe(0);

    const wrong = await registerFixture();
    const wrongBody = `wrong,${wrong._id}\n`;
    await expect(
      t.market.proposals.proposeImport(
        { type: 'companies', sourceId: wrong._id, body: wrongBody, contentType: 'text/csv' },
        t.actor,
        { idempotencyKey: `idem-wrong-${wrong._id}` },
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(missingArtifact(wrongBody)).rejects.toMatchObject({ code: 'not_found' });
    expect(await canonical(wrong._id)).toMatchObject({ snapshots: 0, imports: 0 });
  });

  it('refuses a disabled or wrong-type source at approval and leaves the item open', async () => {
    const disabled = await registerFixture();
    const proposed = await t.market.proposals.proposeImport(
      { type: 'snapshot', sourceId: disabled._id, body: csv, contentType: 'text/csv' },
      t.actor,
      { idempotencyKey: `idem-later-off-${disabled._id}` },
    );
    await t.market.sources.col.updateOne({ _id: disabled._id }, { $set: { enabled: false } });
    const runsBefore = runNowCalls;
    await expect(
      resolve(proposed.item._id, 'create_new', `rop-later-off-${disabled._id}`),
    ).rejects.toMatchObject({
      code: 'invalid_state',
    });
    expect((await t.market.reviews.get(proposed.item._id)).status).toBe('open');
    expect(await t.market.reviewService.operations.findOne({ _id: proposed.item._id })).toBeNull();
    expect(await canonical(disabled._id)).toMatchObject({ snapshots: 0, imports: 0, runs: runsBefore });

    const directory = await registerDirectory();
    const companies = await t.market.proposals.proposeImport(
      {
        type: 'companies' satisfies ImportType,
        sourceId: directory._id,
        body: 'Company,Domain\nKept,kept.example\n',
        contentType: 'text/csv',
      },
      t.actor,
      { idempotencyKey: `idem-later-type-${directory._id}` },
    );
    await t.market.sources.col.updateOne({ _id: directory._id }, { $set: { provider: 'fixture' } });
    await expect(
      resolve(companies.item._id, 'create_new', `rop-later-type-${directory._id}`),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect((await t.market.reviews.get(companies.item._id)).status).toBe('open');
    expect(await canonical(directory._id)).toMatchObject({ snapshots: 0, imports: 0 });
  });

  it('refuses an import body over 5 MB before storing an artifact or a review', async () => {
    const source = await registerFixture();
    const body = new Uint8Array(IMPORT_PROPOSAL_MAX_BYTES + 1);
    body[0] = seq;
    const beforeReviews = await t.market.reviews.col.countDocuments({
      type: 'import_proposal',
      'entity.id': source._id,
    });
    await expect(
      t.market.proposals.proposeImport(
        { type: 'snapshot', sourceId: source._id, body, contentType: 'application/octet-stream' },
        t.actor,
        { idempotencyKey: `idem-big-${source._id}` },
      ),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      t.market.proposals.proposeImport(
        { type: 'snapshot', sourceId: source._id, body, contentType: 'application/octet-stream' },
        t.actor,
        { idempotencyKey: `idem-big-${source._id}` },
      ),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
    expect(
      await t.market.reviews.col.countDocuments({ type: 'import_proposal', 'entity.id': source._id }),
    ).toBe(beforeReviews);
    await expect(missingArtifact(body)).rejects.toMatchObject({ code: 'not_found' });
    expect(await canonical(source._id)).toMatchObject({ snapshots: 0, imports: 0 });
  });
});

function missingArtifact(body: Uint8Array | string) {
  const sha = createHash('sha256').update(body).digest('hex');
  return t.market.ctx.artifacts.get(artifactIdForHash(sha));
}
