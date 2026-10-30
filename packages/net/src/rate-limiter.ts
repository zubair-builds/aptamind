import { AppError } from '@aptamind/contracts';
import { sleep } from './abort';

export interface AcquireOptions {
  signal?: AbortSignal;
  /**
   * Epoch ms by which the request must be finished. A wait that would end later fails at once
   * with `HostBusyError`, and a lease is held at least this long.
   */
  deadlineMs?: number;
}

/**
 * Per-host request budget: bounded concurrency, a minimum interval between request starts and
 * a cool-down set from Retry-After. `SafeHttpClient` takes one so the budget can be shared.
 */
export interface HostLimiter {
  /** Waits for a slot on `host`. The returned function frees it and is safe to call twice. */
  acquire(host: string, opts?: AcquireOptions): Promise<() => void>;
  /**
   * No request to `host` starts before `untilEpochMs`. A later deadline wins; none is shortened.
   * Fire-and-forget: callers do not wait, and implementations report their own failures.
   */
  coolDown(host: string, untilEpochMs: number): void;
}

/** The host cannot start a request before the caller's deadline. Retry after `waitMs`. */
export class HostBusyError extends AppError {
  readonly retryable = true;
  constructor(
    host: string,
    public readonly waitMs: number,
  ) {
    super('unavailable', `${host} cannot take a request for another ${waitMs}ms`, { host, waitMs });
    this.name = 'HostBusyError';
  }
}

interface HostState {
  active: number;
  lastStart: number;
  coolUntil: number;
  waiters: Array<() => void>;
}

/**
 * In-process `HostLimiter`. Each process has its own budget, so N workers send N times the
 * intended rate; use `RedisHostRateLimiter` to share one budget (FE-2).
 */
export class HostRateLimiter implements HostLimiter {
  private readonly state = new Map<string, HostState>();

  constructor(
    private readonly maxConcurrent: number,
    private readonly minIntervalMs: number,
  ) {}

  async acquire(host: string, { signal, deadlineMs }: AcquireOptions = {}): Promise<() => void> {
    const st = this.stateFor(host);
    // Fail before queueing: a long cool-down would otherwise hold the caller until its timeout.
    failIfPastDeadline(host, st.coolUntil - Date.now(), deadlineMs);
    while (st.active >= this.maxConcurrent) await waitForSlot(st, signal);
    if (signal?.aborted) {
      // We may have been the waiter a release woke; pass that wake-up on so nobody starves.
      st.waiters.shift()?.();
      throw signal.reason;
    }
    st.active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      st.active -= 1;
      st.waiters.shift()?.();
    };
    try {
      // Re-check after every sleep: a cool-down can arrive while we wait.
      for (;;) {
        const now = Date.now();
        const start = Math.max(now, st.lastStart + this.minIntervalMs, st.coolUntil);
        if (start <= now) {
          st.lastStart = now;
          return release;
        }
        failIfPastDeadline(host, start - now, deadlineMs);
        await sleep(start - now, signal);
      }
    } catch (err) {
      release();
      throw err;
    }
  }

  coolDown(host: string, untilEpochMs: number): void {
    const st = this.stateFor(host);
    st.coolUntil = Math.max(st.coolUntil, untilEpochMs);
  }

  private stateFor(host: string): HostState {
    let st = this.state.get(host);
    if (!st) {
      st = { active: 0, lastStart: 0, coolUntil: 0, waiters: [] };
      this.state.set(host, st);
    }
    return st;
  }
}

/** @throws HostBusyError when a wait of `waitMs` from now would end after `deadlineMs`. */
function failIfPastDeadline(host: string, waitMs: number, deadlineMs: number | undefined): void {
  if (waitMs > 0 && deadlineMs !== undefined && Date.now() + waitMs > deadlineMs) {
    throw new HostBusyError(host, Math.ceil(waitMs));
  }
}

function waitForSlot(st: HostState, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      const i = st.waiters.indexOf(wake);
      if (i >= 0) st.waiters.splice(i, 1);
      reject(signal?.reason);
    };
    const wake = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    st.waiters.push(wake);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
