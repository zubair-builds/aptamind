import { once } from 'node:events';
import type { AddressInfo, Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePublicPort, startPublicHealthServer } from './public-health-server';

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = undefined;
});

async function start(isRunning: () => boolean) {
  server = startPublicHealthServer(0, isRunning);
  await once(server, 'listening');
  const addr = server.address() as AddressInfo;
  return { addr, base: `http://127.0.0.1:${addr.port}` };
}

describe('public health server', () => {
  it('binds all interfaces', async () => {
    const { addr } = await start(() => true);
    expect(addr.address).toMatch(/^(0\.0\.0\.0|::)$/);
  });

  it('GET /healthz returns 200 with only {status:"ok"}', async () => {
    const { base } = await start(() => true);
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('HEAD /healthz returns 200 and ignores query strings', async () => {
    const { base } = await start(() => true);
    const res = await fetch(`${base}/healthz?ping=1`, { method: 'HEAD' });
    expect(res.status).toBe(200);
  });

  it('returns 503 while stopping', async () => {
    const { base } = await start(() => false);
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'stopping' });
  });

  it.each(['/metrics', '/ready', '/health', '/', '/healthz/x'])('%s is 404 with no body', async (p) => {
    const { base } = await start(() => true);
    const res = await fetch(`${base}${p}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
  });

  it('rejects non-GET methods on /healthz', async () => {
    const { base } = await start(() => true);
    expect((await fetch(`${base}/healthz`, { method: 'POST' })).status).toBe(404);
  });
});

describe('parsePublicPort', () => {
  it('parses valid ports and rejects the rest', () => {
    expect(parsePublicPort('10000')).toBe(10000);
    expect(parsePublicPort(undefined)).toBeNull();
    expect(parsePublicPort('')).toBeNull();
    expect(parsePublicPort('abc')).toBeNull();
    expect(parsePublicPort('0')).toBeNull();
    expect(parsePublicPort('70000')).toBeNull();
  });
});
