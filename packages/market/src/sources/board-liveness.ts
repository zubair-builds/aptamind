import type { ArtifactRef } from '@aptamind/contracts';
import { isRetryableStatus, type SafeHttpClient, type SafeRequest } from '@aptamind/net';
import { getAdapter } from '../connectors';
import type { AtsProvider } from '../contracts/common';

/**
 * Whether a board is live (OPS-1b): one listing fetch through the provider adapter and the shared
 * host limiter, scoped to the provider's API hosts. `live`: HTTP 200 and a listing the adapter
 * parses. 0 jobs is still live: all three providers answer 404 for an unknown board (checked live,
 * OPS-1b repair). `not_live`: 404/410, or JSON the adapter cannot read as a listing.
 * `unreachable`: anything transient or unknown (timeout, 5xx, 429, a 200 that is not JSON such as
 * an HTML error page, a redirect off the API hosts, a refused or oversized response); a later
 * import tries again.
 */
export type BoardLiveness =
  | {
      state: 'live';
      artifact: ArtifactRef;
      url: string;
      httpStatus: number;
      contentType: string;
      jobs: number;
    }
  | { state: 'not_live'; reason: string }
  | { state: 'unreachable'; reason: string };

export interface LivenessDeps {
  http: Pick<SafeHttpClient, 'request'>;
  /** Stores the listing bytes (content-addressed). */
  putArtifact(body: Uint8Array, contentType: string): Promise<ArtifactRef>;
  signal?: AbortSignal;
}

const TIMEOUT_MS = 30_000;
/** One retry of a transient failure, after the provider's Retry-After when it is short. */
const RETRY_WAIT_MS = 2_000;
const MAX_RETRY_WAIT_MS = 30_000;

/** @throws the abort reason when `deps.signal` aborts (the run was cancelled or lost its lease). */
export async function probeBoardLiveness(
  deps: LivenessDeps,
  board: { provider: AtsProvider; boardToken: string; apiBase: string },
): Promise<BoardLiveness> {
  const adapter = getAdapter(board.provider);
  const url = adapter.listingUrl(board.boardToken, board.apiBase);
  // Every hop stays on the provider's API hosts: a redirect elsewhere is not the board.
  const scope = {
    allowedHosts: Object.values(adapter.apiBases).map((base) => new URL(base).hostname),
    allowSubdomains: false,
  };
  let last: BoardLiveness = { state: 'unreachable', reason: 'not tried' };
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetchOnce(deps, url, scope);
    if (r.kind === 'response') {
      const res = r.res;
      if (res.status === 404 || res.status === 410)
        return { state: 'not_live', reason: `HTTP ${res.status} from the board listing` };
      if (res.status === 200) {
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(res.body));
        } catch {
          // Often a temporary HTML error page in front of the API: try once more, then later.
          last = { state: 'unreachable', reason: 'HTTP 200 from the board listing, but not JSON' };
          if (attempt === 0)
            await wait(Math.min(res.retryAfterMs ?? RETRY_WAIT_MS, MAX_RETRY_WAIT_MS), deps.signal);
          continue;
        }
        let jobs: number;
        try {
          jobs = adapter.parseListing(body, { boardToken: board.boardToken }).jobs.length;
        } catch {
          return { state: 'not_live', reason: 'the board listing could not be parsed' };
        }
        const artifact = await deps.putArtifact(res.body, 'application/json');
        return {
          state: 'live',
          artifact,
          url: res.url,
          httpStatus: res.status,
          contentType: res.contentType,
          jobs,
        };
      }
      last = { state: 'unreachable', reason: `HTTP ${res.status} from the board listing` };
      if (!isRetryableStatus(res.status)) return last;
      if (attempt === 0)
        await wait(Math.min(res.retryAfterMs ?? RETRY_WAIT_MS, MAX_RETRY_WAIT_MS), deps.signal);
    } else {
      last = { state: 'unreachable', reason: r.reason };
      if (!r.retryable) return last;
      if (attempt === 0)
        await wait(Math.min(r.retryAfterMs ?? RETRY_WAIT_MS, MAX_RETRY_WAIT_MS), deps.signal);
    }
  }
  return last;
}

type FetchResult =
  | { kind: 'response'; res: Awaited<ReturnType<SafeHttpClient['request']>> }
  | { kind: 'error'; reason: string; retryable: boolean; retryAfterMs?: number };

async function fetchOnce(
  deps: LivenessDeps,
  url: string,
  scope: NonNullable<SafeRequest['scope']>,
): Promise<FetchResult> {
  try {
    const res = await deps.http.request({
      url,
      scope,
      headers: { accept: 'application/json' },
      timeoutMs: TIMEOUT_MS,
      signal: deps.signal,
    });
    return { kind: 'response', res };
  } catch (err) {
    deps.signal?.throwIfAborted();
    const e = err as { message?: string; retryable?: boolean; retryAfterMs?: number };
    return {
      kind: 'error',
      // The client's messages name the host and the failure, never response text.
      reason: (e.message ?? 'request failed').slice(0, 200),
      retryable: e.retryable === true,
      ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
    };
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}
