import { Agent, fetch, type Dispatcher } from 'undici';
import { AppError } from '@aptamind/contracts';
import { HostBusyError, HostRateLimiter, type HostLimiter } from './rate-limiter';
import { DEFAULT_RETRY_AFTER_CAP_MS, parseRetryAfter } from './retry-after';
import {
  createSafeLookup,
  isInScope,
  parseAndValidateUrl,
  type HostScope,
  type UrlPolicy,
} from './url-safety';

export interface SafeHttpClientOptions extends UrlPolicy {
  userAgent: string;
  defaultTimeoutMs: number;
  maxResponseBytes: number;
  perHostConcurrency: number;
  perHostMinIntervalMs: number;
  maxRedirects?: number;
  /** Shared per-host budget. Defaults to an in-process `HostRateLimiter` from the two fields above. */
  limiter?: HostLimiter;
  /** Longest Retry-After the client honours (default 1 h). */
  retryAfterCapMs?: number;
}

export interface SafeRequest {
  url: string;
  method?: 'GET' | 'HEAD' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** When set, every hop (including redirects) must stay within this scope. */
  scope?: HostScope;
  signal?: AbortSignal;
}

export interface SafeResponse {
  url: string;
  requestedUrl: string;
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  contentType: string;
  body: Uint8Array;
  redirects: string[];
  fetchedAt: Date;
  durationMs: number;
  /** Parsed and capped `Retry-After` of a 429 or 503. The client never retries by itself. */
  retryAfterMs?: number;
}

export class HttpError extends AppError {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    details?: Record<string, unknown>,
    public readonly retryAfterMs?: number,
  ) {
    super('unavailable', message, {
      status,
      ...details,
      ...(retryAfterMs !== undefined && { retryAfterMs }),
    });
    this.name = 'HttpError';
  }
}

export class ResponseTooLargeError extends AppError {
  readonly retryable = false;
  constructor(limit: number) {
    super('limit_exceeded', `Response exceeded ${limit} bytes`, { limit });
    this.name = 'ResponseTooLargeError';
  }
}

/** Status codes that indicate a transient condition worth retrying. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * HTTP client with SSRF protection, host scoping, redirects re-validated per hop,
 * timeouts, response-size limits and per-host rate limiting.
 */
export class SafeHttpClient {
  private readonly dispatcher: Dispatcher;
  private readonly limiter: HostLimiter;

  constructor(private readonly opts: SafeHttpClientOptions) {
    this.dispatcher = new Agent({
      connect: { lookup: createSafeLookup(opts) as never },
      headersTimeout: opts.defaultTimeoutMs,
      bodyTimeout: opts.defaultTimeoutMs,
    });
    this.limiter = opts.limiter ?? new HostRateLimiter(opts.perHostConcurrency, opts.perHostMinIntervalMs);
  }

  get policy(): UrlPolicy {
    return { allowPrivateNetwork: this.opts.allowPrivateNetwork };
  }

  async request(req: SafeRequest): Promise<SafeResponse> {
    const started = Date.now();
    const timeoutMs = req.timeoutMs ?? this.opts.defaultTimeoutMs;
    const maxBytes = Math.min(req.maxBytes ?? this.opts.maxResponseBytes, this.opts.maxResponseBytes);
    const maxRedirects = this.opts.maxRedirects ?? 5;
    const redirects: string[] = [];
    let current = parseAndValidateUrl(req.url, this.opts);
    if (req.scope && !isInScope(current, req.scope)) {
      throw new HttpError(`URL ${current.href} is outside the allowed scope`, false, undefined, {
        scope: req.scope,
      });
    }

    const deadlineMs = started + timeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;

    for (let hop = 0; ; hop++) {
      let release: () => void;
      try {
        release = await this.limiter.acquire(current.host, { signal, deadlineMs });
      } catch (err) {
        if (err instanceof HostBusyError)
          throw new HttpError(err.message, true, undefined, { host: current.host }, err.waitMs);
        if (timeoutSignal.aborted)
          throw new HttpError(
            `Waiting for a ${current.host} request slot timed out after ${timeoutMs}ms`,
            true,
          );
        if (err instanceof AppError) throw err;
        throw new HttpError(
          `Waiting for a ${current.host} request slot failed: ${(err as Error).message}`,
          true,
        );
      }
      let res: Awaited<ReturnType<typeof fetch>>;
      try {
        res = await fetch(current.href, {
          method: req.method ?? 'GET',
          headers: { 'user-agent': this.opts.userAgent, accept: '*/*', ...req.headers },
          body: req.body,
          redirect: 'manual',
          dispatcher: this.dispatcher,
          signal,
        });
      } catch (err) {
        release();
        if (timeoutSignal.aborted)
          throw new HttpError(`Request to ${current.host} timed out after ${timeoutMs}ms`, true);
        const cause = (err as { cause?: unknown }).cause;
        if (cause instanceof AppError) throw cause;
        throw new HttpError(
          `Request to ${current.host} failed: ${(cause as Error)?.message ?? (err as Error).message}`,
          true,
        );
      }

      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        release();
        await res.body?.cancel();
        if (hop >= maxRedirects) throw new HttpError(`Too many redirects fetching ${req.url}`, false);
        const next = parseAndValidateUrl(
          new URL(res.headers.get('location') as string, current).href,
          this.opts,
        );
        if (req.scope && !isInScope(next, req.scope)) {
          throw new HttpError(`Redirect to ${next.href} leaves the allowed scope`, false);
        }
        redirects.push(next.href);
        current = next;
        continue;
      }

      try {
        const retryAfterMs =
          res.status === 429 || res.status === 503
            ? parseRetryAfter(
                res.headers.get('retry-after'),
                Date.now(),
                this.opts.retryAfterCapMs ?? DEFAULT_RETRY_AFTER_CAP_MS,
              )
            : undefined;
        // Not awaited: a stalled limiter store must not hold a response we already have.
        if (retryAfterMs) this.limiter.coolDown(current.host, Date.now() + retryAfterMs);
        const body = await readLimited(res, maxBytes, req.method === 'HEAD');
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
        return {
          url: current.href,
          requestedUrl: req.url,
          status: res.status,
          ok: res.ok,
          headers,
          contentType: res.headers.get('content-type') ?? 'application/octet-stream',
          body,
          redirects,
          fetchedAt: new Date(),
          durationMs: Date.now() - started,
          retryAfterMs,
        };
      } catch (err) {
        if (timeoutSignal.aborted)
          throw new HttpError(`Reading ${current.host} timed out after ${timeoutMs}ms`, true);
        throw err;
      } finally {
        release();
      }
    }
  }

  /** GET that throws `HttpError` for non-2xx responses (retryable for 429/5xx). */
  async getOk(req: SafeRequest): Promise<SafeResponse> {
    const res = await this.request(req);
    if (!res.ok) {
      throw new HttpError(
        `HTTP ${res.status} from ${new URL(res.url).host}`,
        isRetryableStatus(res.status),
        res.status,
        { url: res.url },
        res.retryAfterMs,
      );
    }
    return res;
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }
}

async function readLimited(
  res: Awaited<ReturnType<typeof fetch>>,
  maxBytes: number,
  isHead: boolean,
): Promise<Uint8Array> {
  if (isHead || !res.body) return new Uint8Array();
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    await res.body.cancel();
    throw new ResponseTooLargeError(maxBytes);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new ResponseTooLargeError(maxBytes);
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export function decodeBody(res: Pick<SafeResponse, 'body'>): string {
  return new TextDecoder().decode(res.body);
}
