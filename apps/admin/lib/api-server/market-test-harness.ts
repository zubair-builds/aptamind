// First: installs the Market egress guard before anything below is evaluated (PR #11 LOW-3).
import { assertNoEgress, egressGuardInstalled, installOfflineHttp } from '@aptamind/market/testing';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'vitest';
import type { z } from 'zod';
import { MARKET_FIXTURES_DIR } from '@aptamind/market';
import { createPlatform, type Platform } from '@aptamind/platform';
import { waitForRun } from '@aptamind/testing';
import { buildApp } from './app';

/**
 * Integration harness for the Market API route tests: a worker (running workflows) and an API
 * process on a fresh, randomly named database, plus fixture seeding through the public API.
 */
export async function startApiHarness(label: string) {
  // No Market API route test may reach a non-loopback host; `close()` fails the file if one tried.
  expect(egressGuardInstalled()).toBe(true);
  const suffix = randomBytes(4).toString('hex');
  process.env.MONGODB_DB = `t_${label}_${suffix}`;
  process.env.QUEUE_PREFIX = `t-${label}-${suffix}`;
  process.env.S3_BUCKET = 'aptamind-test';
  process.env.WORKER_METRICS_PORT = '0';

  const worker: Platform = await createPlatform('worker');
  await worker.init();
  // Company imports queue careers discovery, which fetches company sites: answer those offline.
  const webRequests = installOfflineHttp({ http: worker.http, services: worker.runtime.services });
  const host = worker.runtime.createWorkerHost({
    workerId: `${label}-worker`,
    schedulerEnabled: false,
    sweeperIntervalMs: 500,
  });
  host.start();
  const api: Platform = await createPlatform('api');
  const app = await buildApp(api);

  const request = async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.json() as unknown, headers: res.headers };
  };

  const h = {
    worker,
    api,
    app,
    market: worker.market,
    webRequests,
    get: (url: string) => request('GET', url),
    post: (url: string, payload: unknown = {}) => request('POST', url, payload),
    fixture: (...p: string[]) => readFile(path.join(MARKET_FIXTURES_DIR, ...p)),
    async waitRun(runId: string) {
      const run = await waitForRun(worker.runtime.engine, runId, undefined, 60_000);
      expect(run.state).toBe('COMPLETED');
      return run;
    },
    /** Upload a fixture file as a source snapshot and process it (the offline import path). */
    async uploadAndProcess(sourceId: string, body: Buffer, contentType: string) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/sources/${sourceId}/snapshots?process=true`,
        payload: body,
        headers: { 'content-type': contentType },
      });
      expect(res.statusCode).toBe(201);
      const { runId } = res.json() as { runId: string };
      return h.waitRun(runId);
    },
    /** UK sponsor register (fixture) → 16 canonical companies and company-resolution reviews. */
    async seedSponsorRegister() {
      const created = await request('POST', '/api/sources', {
        key: 'uk-sponsor-register',
        name: 'UK sponsor register (fixture)',
        category: 'company_universe',
        provider: 'uk_home_office_sponsor_register',
        endpoint: { url: 'https://assets.publishing.service.gov.uk/fixture' },
        acquisition: { workflowKey: 'market.uk_sponsor_register.import' },
        freshness: { policyClass: 'source.sponsor_register', maxAgeMinutes: 4320 },
        authority: { tier: 'official_registry', listingIsComplete: true },
        governance: { accessMethod: 'public_download' },
      });
      expect(created.status).toBe(201);
      const source = (created.body as { source: { _id: string } }).source;
      await h.uploadAndProcess(source._id, await h.fixture('uk-sponsor', 'register-t1.csv'), 'text/csv');
      return source;
    },
    /** Greenhouse board (fixture listing) attached to a company → canonical jobs. */
    async seedGreenhouseBoard(companyId: string, token = 'acme') {
      const created = await request('POST', '/api/sources', {
        key: `greenhouse:${token}`,
        name: `${token} (greenhouse)`,
        category: 'job_source',
        provider: 'greenhouse',
        endpoint: { boardToken: token, url: `https://boards-api.greenhouse.io/v1/boards/${token}/jobs` },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
        authority: { tier: 'official_ats', listingIsComplete: true },
        governance: { accessMethod: 'public_api' },
      });
      expect(created.status).toBe(201);
      const source = (created.body as { source: { _id: string } }).source;
      await h.uploadAndProcess(
        source._id,
        await h.fixture('ats', 'greenhouse', 'acme-listing-t1.json'),
        'application/json',
      );
      return source;
    },
    async close() {
      await app.close();
      await host.stop();
      await worker.mongo.db.dropDatabase().catch(() => {});
      await api.close();
      await worker.close();
      assertNoEgress();
    },
  };
  return h;
}

export type ApiHarness = Awaited<ReturnType<typeof startApiHarness>>;

/** Parse a response body with its DTO; on failure the error lists the offending paths. */
export function expectDto<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 10)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Response does not match its DTO:\n${issues}`);
  }
  return parsed.data;
}

/** A 400 `validation_failed` in the standard error envelope. */
export function expectValidationError(res: { status: number; body: unknown }): void {
  expect(res.status).toBe(400);
  expect((res.body as { error: { code: string } }).error.code).toBe('validation_failed');
}

interface V2Page<T> {
  items: T[];
  total: number | null;
  nextCursor: string | null;
}

/** Follow `nextCursor` from `url` to the end; returns every row and the pages walked. */
export async function traverse<T extends { _id: string }>(
  h: ApiHarness,
  url: string,
  opts: { between?: (page: number, rows: T[]) => Promise<void>; maxPages?: number } = {},
): Promise<{ rows: T[]; pages: number; first: V2Page<T> }> {
  const sep = url.includes('?') ? '&' : '?';
  const rows: T[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let first: V2Page<T> | undefined;
  do {
    const res = await h.get(cursor ? `${url}${sep}after=${encodeURIComponent(cursor)}` : url);
    if (res.status !== 200) throw new Error(`${url} → ${res.status} ${JSON.stringify(res.body)}`);
    const page = res.body as V2Page<T>;
    first ??= page;
    rows.push(...page.items);
    cursor = page.nextCursor;
    pages += 1;
    if (pages > (opts.maxPages ?? 1000)) throw new Error('too many pages');
    if (cursor && opts.between) await opts.between(pages, rows);
  } while (cursor);
  return { rows, pages, first: first! };
}

type SortValue = string | number | Date | null | undefined;

/** MongoDB order of (value, _id) pairs for one sort field: nulls first ascending, `_id` tiebreak. */
export function mongoOrder<T extends { _id: string }>(
  docs: T[],
  value: (d: T) => SortValue,
  dir: 1 | -1,
): string[] {
  const key = (v: SortValue) => (v instanceof Date ? v.getTime() : v);
  return [...docs]
    .sort((a, b) => {
      const va = key(value(a));
      const vb = key(value(b));
      let c = 0;
      if (va === null || va === undefined) c = vb === null || vb === undefined ? 0 : -1;
      else if (vb === null || vb === undefined) c = 1;
      else c = va < vb ? -1 : va > vb ? 1 : 0;
      if (c === 0) c = a._id < b._id ? -1 : a._id > b._id ? 1 : 0;
      return c * dir;
    })
    .map((d) => d._id);
}

/** MongoDB order over several sort fields (each with its direction), `_id` tiebreak in the last direction. */
export function mongoOrderBy<T extends { _id: string }>(
  docs: T[],
  fields: Array<[(d: T) => SortValue, 1 | -1]>,
): string[] {
  const key = (v: SortValue) => (v instanceof Date ? v.getTime() : v);
  const cmp = (va: SortValue, vb: SortValue) => {
    const a = key(va);
    const b = key(vb);
    if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
    if (b === null || b === undefined) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  };
  const lastDir = fields[fields.length - 1]?.[1] ?? 1;
  return [...docs]
    .sort((a, b) => {
      for (const [f, dir] of fields) {
        const c = cmp(f(a), f(b));
        if (c) return c * dir;
      }
      return (a._id < b._id ? -1 : a._id > b._id ? 1 : 0) * lastDir;
    })
    .map((d) => d._id);
}
