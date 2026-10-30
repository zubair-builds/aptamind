import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';
import ipaddr from 'ipaddr.js';
import { AppError } from '@aptamind/contracts';

/**
 * URL validation and SSRF protection.
 *
 * - Only http/https.
 * - No embedded credentials.
 * - Hostnames resolving to private, loopback, link-local, multicast, reserved or
 *   cloud-metadata addresses are blocked unless private networking is explicitly
 *   enabled for local development/tests. The check is enforced again at socket
 *   connect time (see `safeLookup`) to defeat DNS rebinding and redirects.
 */

export interface UrlPolicy {
  allowPrivateNetwork: boolean;
  allowedProtocols?: string[];
}

export class UnsafeUrlError extends AppError {
  readonly retryable = false;
  constructor(message: string, details?: Record<string, unknown>) {
    super('unsafe_url', message, details);
    this.name = 'UnsafeUrlError';
  }
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'metadata', 'instance-data']);

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  return parsed.range() === 'unicast';
}

export function parseAndValidateUrl(input: string, policy: UrlPolicy): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UnsafeUrlError(`Invalid URL: ${input}`);
  }
  const protocols = policy.allowedProtocols ?? ['http:', 'https:'];
  if (!protocols.includes(url.protocol)) {
    throw new UnsafeUrlError(`Protocol ${url.protocol} is not allowed`, { url: input });
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError('URLs with embedded credentials are not allowed', { url: url.origin });
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new UnsafeUrlError('URL has no host', { url: input });
  if (!policy.allowPrivateNetwork) {
    if (
      BLOCKED_HOSTNAMES.has(host) ||
      host.endsWith('.localhost') ||
      host.endsWith('.internal') ||
      host.endsWith('.local')
    ) {
      throw new UnsafeUrlError(`Host ${host} is not allowed`, { host });
    }
    if (ipaddr.isValid(host) && !isPublicAddress(host)) {
      throw new UnsafeUrlError(`Address ${host} is not a public address`, { host });
    }
  }
  return url;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * `dns.lookup` replacement used by the HTTP agent: resolves the hostname and refuses to
 * connect if any resolved address is non-public (unless private networking is allowed).
 */
export function createSafeLookup(policy: UrlPolicy) {
  return function safeLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, [] as LookupAddress[]);
      const list = (Array.isArray(addresses) ? addresses : [addresses]) as LookupAddress[];
      if (!policy.allowPrivateNetwork) {
        const bad = list.find((a) => !isPublicAddress(a.address));
        if (bad) {
          const e = new UnsafeUrlError(`Host ${hostname} resolves to non-public address ${bad.address}`, {
            hostname,
          }) as unknown as NodeJS.ErrnoException;
          return callback(e, [] as LookupAddress[]);
        }
      }
      if (options.all) return callback(null, list);
      const first = list[0];
      if (!first) return callback(new Error(`No addresses for ${hostname}`) as NodeJS.ErrnoException, []);
      callback(null, first.address, first.family);
    });
  };
}

/** Crawl/host scope: a URL is in scope if its host equals or is a subdomain of an allowed host. */
export interface HostScope {
  allowedHosts: string[];
  allowSubdomains?: boolean;
}

export function isInScope(url: URL | string, scope: HostScope): boolean {
  const host = (typeof url === 'string' ? new URL(url) : url).hostname.toLowerCase().replace(/^www\./, '');
  return scope.allowedHosts.some((allowed) => {
    const a = allowed.toLowerCase().replace(/^www\./, '');
    return host === a || (scope.allowSubdomains !== false && host.endsWith(`.${a}`));
  });
}
