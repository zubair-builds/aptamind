/**
 * Server-side client for the same-origin Next.js API. Used only from Server Components, Server
 * Actions and route handlers — never shipped to the browser.
 */

/**
 * Server Actions run outside a browser, so they need an absolute origin for fetch. This is the
 * public Next.js origin, never a separate API service.
 */
export const API_BASE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');

const TIMEOUT_MS = 20_000;

export interface ApiFailure {
  /** `unavailable`: the API could not be reached at all. `http`: it answered with an error. */
  kind: 'unavailable' | 'http';
  status: number | null;
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
  method: string;
  path: string;
}

export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; error: ApiFailure };

export type Query = Record<string, string | number | boolean | null | undefined>;

export function buildPath(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
}

/** Encode a path segment coming from user input / URL params. */
export const seg = (s: string) => encodeURIComponent(s);

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  query?: Query;
  /** JSON body (serialised) — mutually exclusive with `raw`. */
  json?: unknown;
  /** Raw body with explicit content type (e.g. snapshot uploads). */
  raw?: { body: ArrayBuffer | Uint8Array | string; contentType: string };
  timeoutMs?: number;
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<ApiResult<T>> {
  const method = opts.method ?? 'GET';
  const full = buildPath(path, opts.query);
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: BodyInit | undefined;
  if (opts.raw) {
    headers['content-type'] = opts.raw.contentType;
    body = opts.raw.body instanceof Uint8Array ? new Uint8Array(opts.raw.body) : opts.raw.body;
  } else if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${full}`, {
      method,
      headers,
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (err) {
    const cause =
      err instanceof Error ? ((err.cause as { code?: string } | undefined)?.code ?? err.name) : 'error';
    return {
      ok: false,
      error: {
        kind: 'unavailable',
        status: null,
        code: 'api_unavailable',
        message: `Could not reach the internal API at ${API_BASE_URL} (${cause}).`,
        method,
        path: full,
      },
    };
  }
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  if (!res.ok) {
    const e = (
      parsed as
        | {
            error?: {
              code?: string;
              message?: string;
              details?: unknown;
              issues?: unknown;
              requestId?: string;
            };
          }
        | undefined
    )?.error;
    return {
      ok: false,
      error: {
        kind: 'http',
        status: res.status,
        code: e?.code ?? `http_${res.status}`,
        message: e?.message ?? (text.slice(0, 500) || res.statusText),
        details: e ? (e.details ?? e.issues) : parsed,
        requestId: e?.requestId ?? res.headers.get('x-request-id') ?? undefined,
        method,
        path: full,
      },
    };
  }
  if (parsed === undefined && text) {
    return {
      ok: false,
      error: {
        kind: 'http',
        status: res.status,
        code: 'invalid_response',
        message: 'The API returned a non-JSON response.',
        method,
        path: full,
      },
    };
  }
  return { ok: true, status: res.status, data: parsed as T };
}

export const apiGet = <T>(path: string, query?: Query) => apiRequest<T>(path, { query });

export const apiPost = <T>(path: string, json: unknown = {}) => apiRequest<T>(path, { method: 'POST', json });

export const apiPatch = <T>(path: string, json: unknown) => apiRequest<T>(path, { method: 'PATCH', json });
