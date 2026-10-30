import { promises as dns } from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import ipaddr from 'ipaddr.js';
import { isPublicAddress, parseAndValidateUrl, type UrlPolicy } from './url-safety';

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface EgressProxyOptions extends UrlPolicy {
  /** Hostname resolution (default: the system resolver, all addresses). Injectable for tests. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Opens the upstream TCP connection to an already validated address. Injectable for tests. */
  connect?: (address: string, port: number) => net.Socket;
}

export interface EgressDecision {
  target: string;
  allowed: boolean;
  reason?: string;
  address?: string;
}

/** Response header marking a request the egress policy refused (see the browser service). */
export const EGRESS_BLOCKED_HEADER = 'x-aptamind-egress-blocked';

/**
 * Local forward proxy that is the only network path of an untrusted client (headless Chromium).
 *
 * Every request — navigations, redirects, sub-resources, fetch/XHR, WebSockets, HTTPS via
 * CONNECT — arrives here with its hostname. The proxy validates the URL (protocol, credentials,
 * blocked names), resolves the hostname **once**, rejects the connection if any resolved address
 * is not public (loopback, RFC 1918, link-local incl. 169.254.169.254, CGNAT, multicast,
 * reserved, IPv4-mapped equivalents), and then connects to exactly the validated address. The
 * browser never resolves or connects by itself, so DNS rebinding between check and use is not
 * possible, and a later request that resolves to a private address is refused on its own.
 */
export class SafeEgressProxy {
  private server: http.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  readonly decisions: EgressDecision[] = [];

  constructor(private readonly opts: EgressProxyOptions) {}

  get blocked(): EgressDecision[] {
    return this.decisions.filter((d) => !d.allowed);
  }

  /** Start listening on loopback; returns the proxy URL. */
  async start(): Promise<string> {
    if (this.server) return this.url();
    const server = http.createServer((req, res) => void this.onHttp(req, res));
    server.on('connect', (req, socket, head) => void this.onConnect(req, socket as net.Socket, head));
    server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.server = server;
    return this.url();
  }

  url(): string {
    const { port } = this.server?.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    if (this.server) await new Promise<void>((r) => this.server?.close(() => r()));
    this.server = null;
  }

  /** Validate a target and pick the address to connect to (resolved exactly once). */
  async decide(scheme: 'http' | 'https', host: string, port: number): Promise<EgressDecision> {
    const bare = host.replace(/^\[|\]$/g, '');
    const target = `${scheme}://${ipaddr.IPv6.isValid(bare) ? `[${bare}]` : bare}:${port}`;
    const refuse = (reason: string): EgressDecision => {
      const d = { target, allowed: false, reason };
      this.decisions.push(d);
      return d;
    };
    try {
      parseAndValidateUrl(`${target}/`, this.opts);
    } catch (err) {
      return refuse((err as Error).message);
    }
    let addresses: ResolvedAddress[];
    if (net.isIP(bare)) addresses = [{ address: bare, family: net.isIP(bare) }];
    else {
      try {
        addresses = this.opts.resolve
          ? await this.opts.resolve(bare)
          : await dns.lookup(bare, { all: true, verbatim: true });
      } catch (err) {
        return refuse(`resolution failed: ${(err as Error).message}`);
      }
    }
    if (!addresses.length) return refuse('no addresses');
    if (!this.opts.allowPrivateNetwork) {
      const bad = addresses.find((a) => !isPublicAddress(a.address));
      if (bad) return refuse(`${bare} resolves to non-public address ${bad.address}`);
    }
    const d = { target, allowed: true, address: (addresses[0] as ResolvedAddress).address };
    this.decisions.push(d);
    return d;
  }

  private open(address: string, port: number): net.Socket {
    return this.opts.connect ? this.opts.connect(address, port) : net.connect({ host: address, port });
  }

  private async onConnect(req: http.IncomingMessage, client: net.Socket, head: Buffer): Promise<void> {
    client.on('error', () => {});
    const { host, port } = splitHostPort(req.url ?? '', 443);
    const decision = await this.decide('https', host, port);
    if (!decision.allowed || !decision.address) {
      client.end(
        `HTTP/1.1 403 Forbidden\r\n${EGRESS_BLOCKED_HEADER}: 1\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`,
      );
      return;
    }
    const upstream = this.open(decision.address, port);
    this.sockets.add(upstream);
    upstream.on('close', () => this.sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
  }

  private async onHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400, { [EGRESS_BLOCKED_HEADER]: '1' }).end('absolute URI required');
      return;
    }
    if (url.protocol !== 'http:') {
      res.writeHead(403, { [EGRESS_BLOCKED_HEADER]: '1' }).end('protocol not allowed');
      return;
    }
    const port = Number(url.port || 80);
    const decision = await this.decide('http', url.hostname, port);
    if (!decision.allowed || !decision.address) {
      res
        .writeHead(403, { [EGRESS_BLOCKED_HEADER]: '1', 'content-type': 'text/plain' })
        .end('blocked by egress policy');
      return;
    }
    const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: url.host };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const address = decision.address;
    const upstream = http.request({
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers,
      // Connect to the validated address — never re-resolve the hostname.
      createConnection: () => this.open(address, port),
    });
    upstream.on('response', (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    req.pipe(upstream);
  }
}

function splitHostPort(authority: string, defaultPort: number): { host: string; port: number } {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority) ?? /^([^:]+)(?::(\d+))?$/.exec(authority);
  return { host: m?.[1] ?? '', port: m?.[2] ? Number(m[2]) : defaultPort };
}
