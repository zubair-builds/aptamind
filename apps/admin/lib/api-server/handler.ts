import { createPlatform, type Platform } from '@aptamind/platform';
import { buildApp } from './app';

type App = Awaited<ReturnType<typeof buildApp>>;

const STARTUP_COOLDOWN_MS = 5_000;
/** A hanging `platform.close()` must not block the failure record or the cooldown. */
const CLOSE_TIMEOUT_MS = 5_000;

/**
 * Process-wide startup gate for the in-process admin API.
 *
 * A rejected startup is never cached. The failure is remembered until `retryAt` (a cooldown of
 * `apiStartup.cooldownMs`, measured after cleanup finishes); requests in that window fail fast with
 * the same error and do not start the platform, log, or close anything. Concurrent callers share a
 * single in-flight attempt. If that attempt fails after the platform exists, `platform.close()` is
 * bounded by a timeout so it cannot throw, hang, or skip the failure record. A close error or
 * timeout is logged and never replaces the startup error. The failure and its cooldown are always
 * recorded. A successful app is cached for the process lifetime.
 */
// Test seam: cooldown length and clock, so tests can expire the cooldown without waiting.
export const apiStartup: { cooldownMs: number; now: () => number } = {
  cooldownMs: STARTUP_COOLDOWN_MS,
  now: () => Date.now(),
};

/** Set only after `buildApp` resolves. Kept for the process lifetime. */
let ready: Promise<App> | undefined;
/** The single shared in-flight attempt. Cleared when that attempt settles, only if it is still current. */
let inflight: Promise<App> | undefined;
let failure: { error: unknown; retryAt: number } | undefined;

/** Drops gate state so a test starts from a cold process. */
export function resetApiStartupForTests(): void {
  ready = inflight = failure = undefined;
  apiStartup.cooldownMs = STARTUP_COOLDOWN_MS;
  apiStartup.now = () => Date.now();
}

/** Logging must not throw: a throw would skip the cooldown record or replace the startup error. */
function warnQuietly(message: string, extra?: unknown): void {
  try {
    if (extra === undefined) console.warn(message);
    else console.warn(message, extra);
  } catch {
    // Swallowed. See the comment above.
  }
}

/**
 * `platform.close()` must not reject, throw, or hang past `CLOSE_TIMEOUT_MS`.
 * A failure or a timeout is logged and swallowed. This function itself never rejects.
 */
async function closeQuietly(platform: Platform): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      warnQuietly('admin API platform close timed out');
      resolve();
    }, CLOSE_TIMEOUT_MS);
  });
  // `Promise.resolve().then` turns a synchronous throw from `platform.close` into a rejection.
  const closing = Promise.resolve()
    .then(() => platform.close())
    .catch((closeErr: unknown) => {
      warnQuietly('admin API platform close failed', closeErr);
    });
  try {
    await Promise.race([closing, timeout]);
  } catch (closeErr) {
    warnQuietly('admin API platform close failed', closeErr);
  } finally {
    clearTimeout(timer);
  }
}

/** Logs the startup error. A throwing logger, or no platform yet, falls back to `console.error`. */
function logStartupFailure(platform: Platform | undefined, err: unknown): void {
  try {
    if (platform) {
      platform.logger.error({ err }, 'admin API startup failed');
      return;
    }
  } catch {
    // Fall through. The logger must not replace the startup error or skip the cooldown.
  }
  try {
    console.error('admin API startup failed', err);
  } catch {
    // Same rule as above: bookkeeping still runs.
  }
}

function getApp(): Promise<App> {
  if (ready) return ready;
  // Cooldown: fail fast with the original error. No startup and no log.
  if (failure && apiStartup.now() < failure.retryAt) return Promise.reject(failure.error);
  if (inflight) return inflight;
  const attempt = runStartup();
  inflight = attempt;
  // Identity guard: a rejection before `runStartup`'s first await must not clear a later attempt.
  const clear = () => {
    if (inflight === attempt) inflight = undefined;
  };
  void attempt.then(clear, clear);
  return attempt;
}

async function runStartup(): Promise<App> {
  let platform: Platform | undefined;
  try {
    platform = await createPlatform('api');
    await platform.init();
    const app = await buildApp(platform);
    ready = Promise.resolve(app);
    failure = undefined;
    return app;
  } catch (err) {
    // Cleanup cannot throw, hang, or skip the cooldown. `retryAt` is measured after it finishes,
    // and the original startup error is what we rethrow.
    if (platform) await closeQuietly(platform);
    logStartupFailure(platform, err);
    failure = { error: err, retryAt: apiStartup.now() + apiStartup.cooldownMs };
    throw err;
  }
}

export async function handleApiRequest(request: Request, path: string): Promise<Response> {
  const app = await getApp();
  const url = new URL(request.url);
  const headers = Object.fromEntries(request.headers.entries());
  const payload =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : Buffer.from(await request.arrayBuffer());
  const response = (await app.inject({
    method: request.method as 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: `${path}${url.search}`,
    headers,
    payload,
  })) as unknown as {
    statusCode: number;
    headers: Record<string, string | number | undefined>;
    payload: string;
    rawPayload?: Uint8Array;
  };
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value !== undefined) responseHeaders.set(name, String(value));
  }
  return new Response((response.rawPayload ?? response.payload) as BodyInit, {
    status: response.statusCode,
    headers: responseHeaders,
  });
}
