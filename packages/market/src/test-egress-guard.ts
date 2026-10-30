import dgram from 'node:dgram';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';

/**
 * Egress guard for Market integration tests (PR #11 re-verify #6 M-1, #7 LOW-3): no test may
 * reach a host outside the machine. Refused and recorded:
 *
 *  - every socket connect (`net.Socket.prototype.connect`, which `net.connect`, `tls.connect`,
 *    `http`, `https` and undici all go through) to a non-loopback host, and any connect to the
 *    outbound proxy's port on ANY loopback name (`127.0.0.1`, `localhost`, `::1`, …);
 *  - every DNS lookup or query of a non-loopback name: `dns.lookup`, `dns.resolve*`,
 *    `dns.reverse`, their `dns.promises` forms and `Resolver` instances of both;
 *  - every UDP send / connect to a non-loopback address.
 *
 * Named imports (`import { lookup } from 'node:dns'`, as `@aptamind/net` does) are covered too:
 * after patching the module objects, `syncBuiltinESMExports()` updates the ESM named exports of
 * the built-ins, which importers read live — so the guard works whenever it is installed before
 * the call, including for modules that were loaded earlier. The canaries in
 * `egress-guard.int.test.ts` prove each path. The harnesses fail the test file when anything was
 * recorded (`assertNoEgress`). Installed once per worker process.
 */

const attempts: string[] = [];
let installed = false;

function bare(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export function isLoopbackHost(host: string | undefined | null): boolean {
  if (!host) return true; // Node's default host is localhost
  const h = bare(host).toLowerCase().replace(/\.$/, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    /^127\.\d+\.\d+\.\d+$/.test(h) ||
    h === '::1' ||
    h === '0:0:0:0:0:0:0:1' ||
    h === '0.0.0.0' ||
    h === '::' ||
    /^::ffff:127\.\d+\.\d+\.\d+$/.test(h)
  );
}

/**
 * The outbound proxy's ports on loopback (this environment's proxy is local): reaching one, under
 * any loopback name, is egress too. A non-loopback proxy host is refused like any other host.
 */
function loopbackProxyPorts(): Set<string> {
  const out = new Set<string>();
  for (const v of [
    process.env.HTTPS_PROXY,
    process.env.HTTP_PROXY,
    process.env.ALL_PROXY,
    process.env.https_proxy,
    process.env.http_proxy,
    process.env.all_proxy,
  ]) {
    if (!v) continue;
    try {
      const u = new URL(v);
      if (isLoopbackHost(u.hostname)) out.add(u.port || (u.protocol === 'https:' ? '443' : '80'));
    } catch {
      /* not a URL */
    }
  }
  return out;
}

const blocked = (what: string) =>
  Object.assign(new Error(`EGRESS BLOCKED ${what}`), { code: 'ENOTFOUND', egressBlocked: true });

/** What this worker tried to reach so far (for the canaries). */
export function egressAttempts(): readonly string[] {
  return [...attempts];
}

/** Forget what was recorded (a canary that provoked attempts on purpose clears them). */
export function clearEgressAttempts(): void {
  attempts.length = 0;
}

const RESOLVE_METHODS = [
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCaa',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTlsa',
  'resolveTxt',
  'reverse',
] as const;

type AnyFn = (...args: unknown[]) => unknown;
type Methods = Record<string, unknown>;

function refuse(label: string, cb: unknown): void {
  attempts.push(label);
  if (typeof cb === 'function') process.nextTick(() => (cb as (e: Error) => void)(blocked(label)));
}

/** Wrap a callback-style DNS function on `target`: refuse non-loopback names. */
function guardCallbackDns(target: Methods, name: string, label: string): void {
  const orig = target[name];
  if (typeof orig !== 'function') return;
  target[name] = function guardedDns(this: unknown, host: unknown, ...rest: unknown[]) {
    if (typeof host === 'string' && !isLoopbackHost(host)) return refuse(`${label} ${host}`, rest.at(-1));
    return (orig as AnyFn).call(this, host, ...rest);
  };
}

/** Wrap a promise-style DNS function on `target`: refuse non-loopback names. */
function guardPromiseDns(target: Methods, name: string, label: string): void {
  const orig = target[name];
  if (typeof orig !== 'function') return;
  target[name] = async function guardedDnsPromise(this: unknown, host: unknown, ...rest: unknown[]) {
    if (typeof host === 'string' && !isLoopbackHost(host)) {
      attempts.push(`${label} ${host}`);
      throw blocked(`${label} ${host}`);
    }
    return (orig as AnyFn).call(this, host, ...rest);
  };
}

/** Whether the guard is installed in this worker. */
export function egressGuardInstalled(): boolean {
  return installed;
}

/** A connect `lookup` whose non-loopback results are refused (and recorded). */
function guardedLookup(lookup: AnyFn, target: string): AnyFn {
  return function guarded(this: unknown, hostname: unknown, options: unknown, callback: unknown) {
    const cb = (typeof options === 'function' ? options : callback) as AnyFn;
    const opts = typeof options === 'function' ? {} : options;
    return lookup.call(this, hostname, opts, (err: Error | null, address: unknown, family?: number) => {
      if (err) return cb(err, address, family);
      const list = Array.isArray(address)
        ? (address as Array<{ address: string }>).map((a) => a.address)
        : [address as string];
      const bad = list.find((a) => !isLoopbackHost(a));
      if (bad === undefined) return cb(null, address, family);
      attempts.push(`connect ${target} → ${bad}`);
      return cb(blocked(`connect ${target} → ${bad}`), Array.isArray(address) ? [] : undefined, family);
    });
  };
}

export function installEgressGuard(): void {
  if (installed) return;
  installed = true;

  // --- TCP / TLS ----------------------------------------------------------------------------
  const origConnect = net.Socket.prototype.connect as AnyFn;
  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    let o = args[0] as unknown;
    if (Array.isArray(o)) o = o[0];
    let host: string | undefined;
    let port: string | undefined;
    if (o && typeof o === 'object') {
      const opts = o as { host?: string; port?: number | string; path?: string };
      if (opts.path) return origConnect.apply(this, args) as net.Socket; // IPC
      host = opts.host;
      port = opts.port === undefined ? undefined : String(opts.port);
    } else if (typeof o === 'number' || (typeof o === 'string' && /^\d+$/.test(o))) {
      port = String(o);
      host = typeof args[1] === 'string' ? args[1] : undefined;
    } else if (typeof o === 'string') return origConnect.apply(this, args) as net.Socket; // IPC path
    const target = `${host ?? 'localhost'}:${port ?? ''}`;
    // The proxy variables are read on every connect (a test may set them after install).
    if (!isLoopbackHost(host) || (port !== undefined && loopbackProxyPorts().has(port))) {
      attempts.push(`connect ${target}`);
      const err = blocked(`connect ${target}`);
      process.nextTick(() => this.destroy(err));
      return this;
    }
    // A loopback NAME is only trusted if it RESOLVES to loopback (re-verify #8 LOW-E): a custom
    // `lookup` (connect option) is wrapped so a non-loopback address is refused before any
    // connect, and the socket's 'lookup' event refuses one from any other resolver.
    if (o && typeof o === 'object' && typeof (o as { lookup?: unknown }).lookup === 'function') {
      // In place: `net.connect` hands a normalised argument array whose identity Node checks.
      const opts = o as { lookup: AnyFn };
      opts.lookup = guardedLookup(opts.lookup, target);
    }
    this.once('lookup', (err: Error | null, address: unknown) => {
      if (err || typeof address !== 'string' || isLoopbackHost(address)) return;
      attempts.push(`connect ${target} → ${address}`);
      this.destroy(blocked(`connect ${target} → ${address}`));
    });
    return origConnect.apply(this, args) as net.Socket;
  } as typeof net.Socket.prototype.connect;

  // --- UDP (a resolver or anything else talking to a remote address directly) ---------------
  const udp = dgram.Socket.prototype as unknown as Methods;
  const origSend = udp.send as AnyFn;
  udp.send = function guardedSend(this: unknown, ...args: unknown[]) {
    const address = args.slice(1).find((a) => typeof a === 'string') as string | undefined;
    if (address !== undefined && !isLoopbackHost(address)) return refuse(`udp ${address}`, args.at(-1));
    return origSend.apply(this, args);
  };
  const origUdpConnect = udp.connect as AnyFn;
  udp.connect = function guardedUdpConnect(this: unknown, ...args: unknown[]) {
    const address = typeof args[1] === 'string' ? args[1] : undefined;
    if (address !== undefined && !isLoopbackHost(address)) return refuse(`udp ${address}`, args.at(-1));
    return origUdpConnect.apply(this, args);
  };

  // --- DNS ----------------------------------------------------------------------------------
  const cbDns = dns as unknown as Methods;
  const promiseDns = dns.promises as unknown as Methods;
  guardCallbackDns(cbDns, 'lookup', 'dns');
  guardPromiseDns(promiseDns, 'lookup', 'dns');
  guardCallbackDns(cbDns, 'lookupService', 'dns.lookupService');
  guardPromiseDns(promiseDns, 'lookupService', 'dns.lookupService');
  for (const m of RESOLVE_METHODS) {
    guardCallbackDns(cbDns, m, `dns.${m}`);
    guardPromiseDns(promiseDns, m, `dns.${m}`);
    guardCallbackDns(dns.Resolver.prototype as unknown as Methods, m, `dns.Resolver.${m}`);
    guardPromiseDns(dns.promises.Resolver.prototype as unknown as Methods, m, `dns.promises.Resolver.${m}`);
  }
  // Named ESM imports of the built-ins (`import { lookup } from 'node:dns'`) read these live.
  syncBuiltinESMExports();
}

/** Throws when any test in this worker tried to reach a non-loopback host (and clears the record). */
export function assertNoEgress(): void {
  if (!attempts.length) return;
  const seen = [...new Set(attempts)];
  attempts.length = 0;
  throw new Error(`Integration test tried to reach the network: ${seen.join(', ')}`);
}
