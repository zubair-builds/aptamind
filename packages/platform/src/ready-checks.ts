/**
 * FE-9: bound each /ready ping so a hung Redis, Mongo or S3 client cannot stall
 * readiness past the admin probe (2s first try). Timed-out or rejected pings
 * count as not-ready. The losing ping is given a catch so a late rejection is
 * never an unhandled rejection. Timers are always cleared.
 */

export const READY_CHECK_TIMEOUT_MS = 1_500;

export async function pingWithTimeout(
  ping: Promise<boolean>,
  timeoutMs: number = READY_CHECK_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const guarded = ping.then(
    (ok) => ok,
    () => false,
  );
  try {
    return await Promise.race([guarded, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type ReadyCheckPings = {
  mongo: () => Promise<boolean>;
  redis: () => Promise<boolean>;
  objectStorage: () => Promise<boolean>;
};

export type ReadyChecks = {
  mongo: boolean;
  redis: boolean;
  objectStorage: boolean;
};

/** Run the three readiness pings in parallel, each bounded by `timeoutMs`. */
export async function runReadyChecks(
  pings: ReadyCheckPings,
  timeoutMs: number = READY_CHECK_TIMEOUT_MS,
): Promise<ReadyChecks> {
  const bound = (start: () => Promise<boolean>) => {
    try {
      return pingWithTimeout(Promise.resolve(start()), timeoutMs);
    } catch {
      return Promise.resolve(false);
    }
  };
  const [mongo, redis, objectStorage] = await Promise.all([
    bound(pings.mongo),
    bound(pings.redis),
    bound(pings.objectStorage),
  ]);
  return { mongo, redis, objectStorage };
}
