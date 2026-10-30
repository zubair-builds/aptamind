/**
 * Company reconciliation at history scale (audit M-5). A company observed by 4 sources × 25
 * records × 30 successive versions (3,000 immutable observations) must reconcile from the current
 * version of each record (100 observations), keep every historical name as an alias, lose no
 * evidence, and stay fast. Prints a before/after-comparable benchmark line.
 */
// First: installs the egress guard before anything below is evaluated (PR #11 LOW-3).
import { assertNoEgress } from './testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestInfra, type TestInfra } from '@aptamind/testing';
import { createMarketDomain, type MarketDomain } from './market-domain';

let infra: TestInfra;
let market: MarketDomain;
const SOURCES = 4;
const RECORDS = 25;
const VERSIONS = 30;

beforeAll(async () => {
  infra = await createTestInfra('reconcile_scale');
  market = createMarketDomain({
    db: infra.db,
    clock: { now: () => new Date() },
    logger: infra.logger,
    artifacts: infra.artifacts,
  });
  await market.ensureReady();
});
afterAll(async () => {
  await infra?.cleanup();
  assertNoEgress();
});

describe('M-5: company reconciliation is bounded by current records, not history', () => {
  it('reconciles 3,000 historical observations from the 100 current ones, without losing evidence', async () => {
    const company = (await market.companies.createFromCandidate({
      name: 'Scale Test Ltd',
      domain: null,
      externalIds: [],
    } as never))!;
    const sourceIds: string[] = [];
    for (let s = 0; s < SOURCES; s++) {
      const { source } = await market.sources.register(
        {
          key: `fixture:scale-${s}`,
          name: `Scale source ${s}`,
          category: 'company_universe',
          provider: 'fixture',
          acquisition: { workflowKey: 'market.noop' },
          freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 100000 },
          authority: { tier: s === 0 ? 'official_site' : 'third_party' },
        },
        { kind: 'system', id: 'test' },
      );
      sourceIds.push(source._id);
    }
    // History: every record goes through VERSIONS versions; version 0 of record 0 of source 0
    // carries a former trading name that later versions no longer mention.
    const ids: string[] = [];
    for (let v = 0; v < VERSIONS; v++) {
      for (let s = 0; s < SOURCES; s++) {
        for (let r = 0; r < RECORDS; r++) {
          const { observation } = await market.observations.recordCompanyObservation({
            sourceId: sourceIds[s] as string,
            externalId: `rec-${r}`,
            payload: {
              name: 'Scale Test Ltd',
              aliases: v === 0 && s === 0 && r === 0 ? ['Old Brand Name'] : [],
              externalIds: [],
              locations: [],
              industries: [`industry-v${v}`],
              employeeCount: { estimate: 100 + v },
            },
            parser: { name: 'test', version: '1' },
          });
          ids.push(observation._id);
        }
      }
    }
    await market.observations.setCompanyResolution(ids, {
      state: 'resolved',
      entityId: company._id,
      method: 'test',
      confidence: 'high',
      resolverVersion: 'test',
    });
    const total = await market.observations.companyObservations.countDocuments({
      'resolution.entityId': company._id,
    });
    expect(total).toBe(SOURCES * RECORDS * VERSIONS);

    const started = performance.now();
    const { company: reconciled } = await market.companyReconciler.reconcile(company._id);
    const ms = performance.now() - started;
    const current = await market.observations.companyObservations.countDocuments({
      'resolution.entityId': company._id,
      superseded: { $ne: true },
    });
    console.log(
      `BENCHMARK company reconcile: ${total} observations in history, ${current} current, ${ms.toFixed(0)} ms`,
    );

    // Bounded input: only the current version of each record is read.
    expect(current).toBe(SOURCES * RECORDS);
    // Current values come from the latest versions…
    expect(reconciled.classification.industries.value).toEqual(
      expect.arrayContaining([`industry-v${VERSIONS - 1}`]),
    );
    expect(reconciled.classification.industries.value).not.toContain('industry-v0');
    expect(reconciled.firmographics.employeeEstimate.value).toBe(100 + VERSIONS - 1);
    // …and historical evidence is not lost: a former name is still an alias, and every
    // observation (including superseded ones) is still stored for audit.
    expect(reconciled.identity.aliases.map((a) => a.name)).toContain('Old Brand Name');
    expect(await market.observations.companyObservations.countDocuments({})).toBe(total);
    expect(ms).toBeLessThan(5_000);
  }, 300_000);

  it('concurrent recordings of one source record leave exactly one current version', async () => {
    const { source } = await market.sources.register(
      {
        key: 'fixture:scale-race',
        name: 'Scale race source',
        category: 'company_universe',
        provider: 'fixture',
        acquisition: { workflowKey: 'market.noop' },
        freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 100000 },
        authority: { tier: 'third_party' },
      },
      { kind: 'system', id: 'test' },
    );
    for (let round = 0; round < 5; round++) {
      await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          market.observations.recordCompanyObservation({
            sourceId: source._id,
            externalId: 'race-record',
            payload: {
              name: `Race Co ${round}-${i}`,
              aliases: [],
              externalIds: [],
              locations: [],
              industries: [],
            },
            parser: { name: 'test', version: '1' },
          }),
        ),
      );
      const current = await market.observations.companyObservations.countDocuments({
        sourceId: source._id,
        superseded: { $ne: true },
      });
      expect(current).toBe(1);
    }
  });
});

// Independent re-audit probes (M-5): supersession follows SOURCE chronology (the fetch time of the
// snapshot an observation came from), never processing/replay time.
describe('M-5: company observation chronology is immutable under replay', () => {
  let n = 0;
  async function setup(tag: string) {
    n += 1;
    const company = (await market.companies.createFromCandidate({
      name: `Chrono ${tag} ${n} Ltd`,
      domain: null,
      externalIds: [],
    } as never))!;
    const { source } = await market.sources.register(
      {
        key: `fixture:chrono-${tag}-${n}`,
        name: `Chrono source ${tag}`,
        category: 'company_universe',
        provider: 'fixture',
        acquisition: { workflowKey: 'market.noop' },
        freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 100000 },
        authority: { tier: 'third_party' },
      },
      { kind: 'system', id: 'test' },
    );
    const snapshot = async (content: string) => {
      const artifact = await infra.artifacts.put(new TextEncoder().encode(`${tag}:${content}`), 'text/plain');
      return (await market.observations.recordSnapshot({ sourceId: source._id, artifact, via: 'upload' }))
        .snapshot;
    };
    const observe = async (
      snapshotId: string | undefined,
      industry: string,
      extra: { sourceObservedAt?: Date } = {},
    ) => {
      const { observation } = await market.observations.recordCompanyObservation({
        sourceId: source._id,
        externalId: 'record-1',
        snapshotId,
        payload: {
          name: company.identity.displayName.value ?? 'x',
          aliases: [],
          externalIds: [],
          locations: [],
          industries: [industry],
        },
        parser: { name: 'test', version: '1' },
        ...extra,
      });
      await market.observations.setCompanyResolution([observation._id], {
        state: 'resolved',
        entityId: company._id,
        method: 'test',
        confidence: 'high',
        resolverVersion: 'test',
      });
      return observation;
    };
    const current = () =>
      market.observations.companyObservations
        .find({ sourceId: source._id, superseded: { $ne: true } })
        .toArray();
    const industries = async () =>
      (await market.companyReconciler.reconcile(company._id)).company.classification.industries.value;
    return { company, source, snapshot, observe, current, industries };
  }
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it('reprocessing an older snapshot after a newer one never makes the old content current', async () => {
    const c = await setup('replay');
    const s1 = await c.snapshot('v1'); // T1
    await c.observe(s1._id, 'industry-v1');
    await tick();
    const s2 = await c.snapshot('v2'); // T2 > T1
    await c.observe(s2._id, 'industry-v2');
    expect(await c.industries()).toEqual(['industry-v2']);

    await tick();
    await c.observe(s1._id, 'industry-v1'); // reprocess S1 at T3 > T2
    const current = await c.current();
    expect(current).toHaveLength(1);
    expect(current[0]!.payload.industries).toEqual(['industry-v2']);
    expect(await c.industries()).toEqual(['industry-v2']);
  });

  it('a genuinely later fetch of earlier content (A -> B -> A) does become current', async () => {
    const c = await setup('flap');
    const s1 = await c.snapshot('A');
    await c.observe(s1._id, 'industry-A');
    await tick();
    const s2 = await c.snapshot('B');
    await c.observe(s2._id, 'industry-B');
    await tick();
    const again = await c.snapshot('A'); // the source is fetched again and serves A: same snapshot, later fetch
    expect(again._id).toBe(s1._id);
    await c.observe(again._id, 'industry-A');
    expect((await c.current()).map((o) => o.payload.industries)).toEqual([['industry-A']]);
    expect(await c.industries()).toEqual(['industry-A']);
  });

  it('concurrent processing of an older and a newer snapshot leaves the newer content current', async () => {
    for (let round = 0; round < 5; round++) {
      const c = await setup(`concurrent-${round}`);
      const older = await c.snapshot('old');
      await tick();
      const newer = await c.snapshot('new');
      const writes = [() => c.observe(older._id, 'industry-old'), () => c.observe(newer._id, 'industry-new')];
      if (round % 2) writes.reverse();
      await Promise.all(writes.map((w) => w()));
      const current = await c.current();
      expect(current).toHaveLength(1);
      expect(current[0]!.payload.industries).toEqual(['industry-new']);
    }
  });

  it('equal source times are ordered deterministically by id, whatever the processing order', async () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const winners: string[] = [];
    for (const order of [0, 1]) {
      const c = await setup(`tie-${order}`);
      const versions = ['industry-x', 'industry-y'];
      if (order) versions.reverse();
      const docs = [];
      for (const v of versions) docs.push(await c.observe(undefined, v, { sourceObservedAt: at }));
      const current = await c.current();
      expect(current).toHaveLength(1);
      const expected = [...docs].sort((a, b) => (a._id < b._id ? 1 : -1))[0]!;
      expect(current[0]!._id).toBe(expected._id);
      winners.push(current[0]!.payload.industries[0]!);
    }
  });
});
