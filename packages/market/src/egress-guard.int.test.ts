/**
 * Canaries for the Market integration-test egress guard (PR #11 re-verify #7 LOW-3). Each bypass
 * the re-verification found must now be refused AND recorded — a recorded attempt fails the test
 * file through `assertNoEgress` in the harness:
 *
 *  - a connect to the outbound proxy's port under another loopback name (`localhost:<port>`);
 *  - a DNS lookup through a NAMED import of `lookup` from `node:dns` — both in this file and in
 *    `@aptamind/net` (`createSafeLookup`), a module loaded before the guard was installed;
 *  - `dns.resolve*` (callback, promise and `Resolver` forms), which bypass `dns.lookup`;
 *  - (re-verify #8 LOW-E) a loopback host NAME whose custom `lookup` resolves to a public address.
 */
// First: installs the guard before anything below is evaluated.
import {
  assertNoEgress,
  clearEgressAttempts,
  egressAttempts,
  egressGuardInstalled,
  isLoopbackHost,
} from './testing';
import dns, { lookup as namedLookup, resolve4 as namedResolve4 } from 'node:dns';
import { lookup as promiseNamedLookup, resolveTxt as promiseNamedResolveTxt } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSafeLookup } from '@aptamind/net';

const HOST = 'egress-canary.example.com';

let server: net.Server;
let port: number;
const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy };

beforeAll(async () => {
  expect(egressGuardInstalled()).toBe(true);
  server = net.createServer((s) => s.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterEach(() => {
  process.env.HTTPS_PROXY = saved.HTTPS_PROXY;
  process.env.https_proxy = saved.https_proxy;
  if (saved.HTTPS_PROXY === undefined) delete process.env.HTTPS_PROXY;
  if (saved.https_proxy === undefined) delete process.env.https_proxy;
  clearEgressAttempts(); // each canary provoked its attempts on purpose
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assertNoEgress();
});

/** Resolve with the error (or null) of a callback-style call. */
const callbackError = (call: (cb: (err: Error | null) => void) => void) =>
  new Promise<Error | null>((resolve) => call((err) => resolve(err)));

/** The error a socket was destroyed with (or null when it connected). */
const connectError = (socket: net.Socket) =>
  new Promise<Error | null>((resolve) => {
    socket.once('error', (err) => resolve(err));
    socket.once('connect', () => {
      socket.destroy();
      resolve(null);
    });
  });

describe('egress guard canaries', () => {
  it('a local server on a non-proxy port is reachable (the guard is not a blanket block)', async () => {
    expect(await connectError(net.connect({ host: 'localhost', port }))).toBeNull();
    expect(egressAttempts()).toEqual([]);
  });

  it('the proxy port is refused under every loopback name (localhost:<port> was a bypass)', async () => {
    process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`;
    for (const host of ['127.0.0.1', 'localhost', '::1', '127.0.0.2']) {
      const err = await connectError(net.connect({ host, port }));
      expect(err?.message).toContain('EGRESS BLOCKED');
    }
    const err = await connectError(net.connect(port, 'localhost'));
    expect(err?.message).toContain('EGRESS BLOCKED');
    expect(egressAttempts()).toEqual(
      expect.arrayContaining([
        `connect localhost:${port}`,
        `connect ::1:${port}`,
        `connect 127.0.0.1:${port}`,
      ]),
    );
  });

  it('a TLS connect to a public host is refused', async () => {
    const err = await connectError(tls.connect({ host: HOST, port: 443, servername: HOST }));
    expect(err?.message).toContain('EGRESS BLOCKED');
    expect(egressAttempts().some((a) => a.includes(HOST))).toBe(true);
  });

  it('a lookup through a NAMED import of node:dns is refused (this file and @aptamind/net)', async () => {
    const own = await callbackError((cb) => namedLookup(HOST, cb));
    expect(own?.message).toContain('EGRESS BLOCKED');
    // @aptamind/net was loaded before the guard (it imports `lookup` by name): still refused.
    const viaNet = await callbackError((cb) => createSafeLookup({ allowPrivateNetwork: true })(HOST, {}, cb));
    expect(viaNet?.message).toContain('EGRESS BLOCKED');
    await expect(promiseNamedLookup(HOST)).rejects.toThrow('EGRESS BLOCKED');
    expect(egressAttempts().filter((a) => a === `dns ${HOST}`)).toHaveLength(3);
  });

  it('dns.resolve* — callback, promise, named and Resolver forms — is refused', async () => {
    const errors = [
      await callbackError((cb) => dns.resolve(HOST, cb)),
      await callbackError((cb) => dns.resolve4(HOST, cb)),
      await callbackError((cb) => dns.resolveTxt(HOST, cb)),
      await callbackError((cb) => namedResolve4(HOST, cb)),
      await callbackError((cb) => new dns.Resolver().resolve6(HOST, cb)),
    ];
    for (const err of errors) expect(err?.message).toContain('EGRESS BLOCKED');
    await expect(dns.promises.resolveSrv(HOST)).rejects.toThrow('EGRESS BLOCKED');
    await expect(promiseNamedResolveTxt(HOST)).rejects.toThrow('EGRESS BLOCKED');
    await expect(new dns.promises.Resolver().resolveMx(HOST)).rejects.toThrow('EGRESS BLOCKED');
    const recorded = egressAttempts();
    for (const label of [
      'dns.resolve',
      'dns.resolve4',
      'dns.resolveTxt',
      'dns.Resolver.resolve6',
      'dns.resolveSrv',
      'dns.promises.Resolver.resolveMx',
    ])
      expect(recorded).toContain(`${label} ${HOST}`);
  });

  it('LOW-E (re-verify #8): a loopback NAME resolved by a custom lookup to a public address is refused', async () => {
    const lookup = (_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) =>
      opts?.all ? cb(null, [{ address: '203.0.113.7', family: 4 }]) : cb(null, '203.0.113.7', 4);
    for (const extra of [{}, { autoSelectFamily: false }]) {
      const err = await connectError(
        net.connect({ host: 'localhost', port, lookup: lookup as never, ...extra }),
      );
      expect(err?.message).toContain('EGRESS BLOCKED');
    }
    expect(egressAttempts()).toContain(`connect localhost:${port} → 203.0.113.7`);
    // A custom lookup that resolves to loopback still connects.
    const ok = (_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) =>
      opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
    clearEgressAttempts();
    expect(await connectError(net.connect({ host: 'localhost', port, lookup: ok as never }))).toBeNull();
    expect(egressAttempts()).toEqual([]);
  });

  it('loopback names are recognised; anything else is not', () => {
    for (const h of [
      'localhost',
      '127.0.0.1',
      '127.9.9.9',
      '::1',
      '[::1]',
      'a.localhost',
      '::ffff:127.0.0.1',
    ])
      expect(isLoopbackHost(h)).toBe(true);
    for (const h of [
      'example.com',
      '10.0.0.1',
      '169.254.169.254',
      'localhost.example.com',
      '::ffff:10.0.0.1',
    ])
      expect(isLoopbackHost(h)).toBe(false);
  });
});
