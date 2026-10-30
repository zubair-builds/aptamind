import { describe, expect, it } from 'vitest';
import { ServiceRegistry } from '@aptamind/workflow-sdk';
import { MARKET } from '../market-domain';
import { mapCompanyDirectory } from './directory';

/**
 * PR #27 re-verification #12, M-4: a long map pass keeps its lease. The map yields the event loop
 * and heartbeats between batches of rows, so the runtime's own heartbeat timer (every lease/3)
 * keeps firing and the explicit `ctx.heartbeat()` renews the lease during the pass: here the map
 * runs for several times a small lease and the longest gap between heartbeats stays well inside it.
 */

const LEASE_MS = 1_000;

function fakeContext(csv: string) {
  const services = new ServiceRegistry();
  services.register(MARKET, {
    sources: {
      get: async () => ({
        _id: 'src_lease',
        provider: 'company_directory',
        acquisition: {
          config: {
            columns: {
              name: 'Company',
              legalName: 'Legal',
              town: 'Town',
              country: 'Country',
              careersUrl: 'Careers',
            },
          },
        },
      }),
    },
  } as never);
  const beats: number[] = [];
  const ctx = {
    services,
    artifacts: {
      readText: async () => csv,
      putJson: async () => ({ artifactId: 'art_report', sha256: 'x', size: 1, mimeType: 'application/json' }),
    },
    records: { write: async () => ({ artifactId: 'art_records', count: 0, sha256: 'x', size: 1 }) },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    heartbeat: async () => {
      beats.push(performance.now());
    },
    signal: new AbortController().signal,
  };
  return { ctx, beats };
}

describe('map_company_directory keeps its lease on a long pass', () => {
  it(
    'yields the event loop and heartbeats well inside the lease while mapping for several leases',
    { timeout: 120_000 },
    async () => {
      const fill = (pre: string, unit: string) => (pre + unit.repeat(1000)).slice(0, 1990);
      const rows = Array.from(
        { length: 400 },
        (_, i) =>
          `"Acme ${i} ${fill('', 'a.')}","${fill('x at ', 'a.')}","${fill('x at ', 'a-')}",GB,"${fill('https://acme.com/x-at-', 'a.')}"`,
      );
      const csv = ['Company,Legal,Town,Country,Careers', ...rows].join('\n');
      const { ctx, beats } = fakeContext(csv);
      // The runtime's interval heartbeat stands in for this timer: it must keep firing during the map.
      const ticks: number[] = [];
      const timer = setInterval(() => ticks.push(performance.now()), LEASE_MS / 3);
      const start = performance.now();
      try {
        await mapCompanyDirectory.execute(
          ctx as never,
          {
            sourceId: 'src_lease',
            snapshotId: 'snap_lease',
            artifact: { artifactId: 'art_csv', sha256: 'x', size: csv.length, mimeType: 'text/csv' },
          } as never,
          {},
        );
      } finally {
        clearInterval(timer);
      }
      const end = performance.now();
      const elapsed = end - start;
      expect(elapsed).toBeGreaterThan(LEASE_MS); // the pass outlasts the lease
      // No gap — from the start, between heartbeats or timer ticks, to the end — reaches the lease.
      const maxGap = (xs: number[]) => Math.max(...xs.slice(1).map((x, k) => x - xs[k]!));
      expect(maxGap([start, ...beats, end])).toBeLessThan(LEASE_MS);
      expect(maxGap([start, ...ticks, end])).toBeLessThan(LEASE_MS);
    },
  );

  it('an aborted signal stops the map at its next pause', async () => {
    // 2 500 rows: several batches, so the map pauses again after the abort.
    const rows = Array.from({ length: 2500 }, (_, i) => `"Acme ${i} Ltd","Acme ${i} Limited",,GB,`);
    const csv = ['Company,Legal,Town,Country,Careers', ...rows].join('\n');
    const { ctx, beats } = fakeContext(csv);
    const controller = new AbortController();
    ctx.signal = controller.signal;
    // Abort once the map is under way (after its first heartbeat).
    ctx.heartbeat = async () => {
      beats.push(performance.now());
      controller.abort(new Error('lease lost'));
    };
    const run = mapCompanyDirectory.execute(
      ctx as never,
      {
        sourceId: 'src_lease',
        snapshotId: 'snap_lease',
        artifact: { artifactId: 'art_csv', sha256: 'x', size: csv.length, mimeType: 'text/csv' },
      } as never,
      {},
    );
    await expect(run).rejects.toThrow('lease lost');
    expect(beats).toHaveLength(1);
  });
});
