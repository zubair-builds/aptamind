import type { AtsProvider } from '../contracts/common';
import type { JobBoardAdapter } from './types';

/** `https://host/path/` → `https://host/path` (bases are compared and joined without a trailing slash). */
function trimBase(base: string): string {
  return base.replace(/\/+$/, '');
}

/** Join an adapter API base with an encoded path. */
export function onBase(apiBase: string, path: string): string {
  return `${trimBase(apiBase)}/${path}`;
}

/**
 * The API base a source's listing endpoint was built on — the inverse of `listingUrl`. With the
 * `adapter`, its known API bases are matched by prefix first (`<base>/<token>`), then the
 * adapter's own listing path is stripped from the URL's end (any host: test servers, proxies).
 * Without it (or when neither matches), the URL's origin and path up to (excluding) the first
 * board-token segment. Matching the known bases first matters for tokens that equal a base's
 * own path segment (`boards`, `v1`, `postings`, A-L1). Null when the URL is not http(s) or does
 * not carry the token: the caller must then not guess a host.
 */
export function apiBaseOfListingUrl(
  url: string,
  boardToken: string,
  adapter?: JobBoardAdapter,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const path = `${parsed.origin}${parsed.pathname}`;
  const token = encodeURIComponent(boardToken);
  if (adapter) {
    for (const base of Object.values(adapter.apiBases)) {
      const prefix = `${trimBase(base)}/${token}`;
      if (path === prefix || path.startsWith(`${prefix}/`)) return trimBase(base);
    }
    // The adapter's listing path after the base (e.g. `/<token>/jobs`), stripped from the end.
    const probe = 'https://api-base.invalid/_';
    const suffix = new URL(adapter.listingUrl(boardToken, probe)).pathname.slice('/_'.length);
    if (suffix.startsWith('/') && path.endsWith(suffix)) return trimBase(path.slice(0, -suffix.length));
  }
  const segments = parsed.pathname.split('/');
  const index = segments.findIndex((segment) => {
    try {
      return segment === encodeURIComponent(boardToken) || decodeURIComponent(segment) === boardToken;
    } catch {
      return false;
    }
  });
  if (index < 1) return null;
  return trimBase(`${parsed.origin}${segments.slice(0, index).join('/')}`);
}

/** The region name of a known API base of `adapter` (`default`, `eu`, …), or null for any other URL. */
export function regionOfApiBase(adapter: JobBoardAdapter, apiBase: string): string | null {
  const wanted = trimBase(apiBase);
  for (const [region, base] of Object.entries(adapter.apiBases)) if (trimBase(base) === wanted) return region;
  return null;
}

/**
 * Identity of an ATS board as a job source (M6.3): its source key, region and listing endpoint.
 * Default-region boards keep the historical key `provider:token`; a regional board is
 * `provider:region:token` (board tokens are per data centre). The key uses the lowercased token
 * (providers treat tokens case-insensitively, OPS-1b), so every writer builds one key per board;
 * the listing URL keeps the token as given. Throws for an API base that is not one of the
 * adapter's known hosts.
 */
export function boardSourceIdentity(
  adapter: JobBoardAdapter,
  boardToken: string,
  apiBase?: string | null,
): { key: string; region: string; apiBase: string; listingUrl: string } {
  const base = apiBase ?? adapter.apiBases.default;
  const region = regionOfApiBase(adapter, base);
  if (!region) throw new Error(`${base} is not a known ${adapter.provider} API host`);
  const provider: AtsProvider = adapter.provider;
  const token = boardToken.toLowerCase();
  return {
    key: region === 'default' ? `${provider}:${token}` : `${provider}:${region}:${token}`,
    region,
    apiBase: base,
    listingUrl: adapter.listingUrl(boardToken, base),
  };
}
