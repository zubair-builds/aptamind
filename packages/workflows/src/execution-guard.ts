import { CancelledError, NodeTimeoutError } from '@aptamind/workflow-sdk';

/**
 * Timeout, cancellation and lease-heartbeat supervision for one unit of work (a node attempt,
 * a fan-out chunk, a fan-out item). Owns an AbortController whose signal is handed to the
 * capability; the supervised promise is raced against it so a capability that ignores its
 * signal still cannot hold the attempt past its timeout.
 */
export type HeartbeatResult = 'ok' | 'lease_lost' | 'cancelled';

export interface ExecutionGuardOptions {
  timeoutMs?: number;
  heartbeat?: () => Promise<HeartbeatResult>;
  heartbeatEveryMs?: number;
  /** Propagate an outer abort (e.g. the chunk's signal into an item). */
  parent?: AbortSignal;
}

export class ExecutionGuard {
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private hb: NodeJS.Timeout | undefined;
  private onParentAbort: (() => void) | undefined;
  timedOut = false;
  cancelled = false;
  leaseLost = false;

  constructor(private readonly opts: ExecutionGuardOptions) {
    if (opts.timeoutMs) {
      const ms = opts.timeoutMs;
      this.timer = setTimeout(() => {
        this.timedOut = true;
        this.controller.abort(new NodeTimeoutError(ms));
      }, ms);
    }
    if (opts.heartbeat) {
      this.hb = setInterval(
        () => void this.beat().catch(() => {}),
        Math.max(250, opts.heartbeatEveryMs ?? 20_000),
      );
    }
    if (opts.parent) {
      const parent = opts.parent;
      if (parent.aborted) this.controller.abort(parent.reason);
      this.onParentAbort = () => this.controller.abort(parent.reason);
      parent.addEventListener('abort', this.onParentAbort, { once: true });
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Extend the lease and observe cancellation now (also runs on an interval). */
  async beat(): Promise<void> {
    if (!this.opts.heartbeat) return;
    const r = await this.opts.heartbeat();
    if (r === 'cancelled') {
      this.cancelled = true;
      this.controller.abort(new CancelledError('Run cancelled'));
    } else if (r === 'lease_lost' && !this.controller.signal.aborted) {
      this.leaseLost = true;
      this.controller.abort(new CancelledError('Lease lost to another worker'));
    }
  }

  /** Stop the timeout clock (e.g. once a fan-out coordinator hands over to chunks). */
  stopTimeout(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  run<T>(promise: Promise<T>): Promise<T> {
    return raceAbort(promise, this.controller.signal);
  }

  /** The error to attribute a failure to (a timeout wins over whatever the capability threw). */
  failureOf(err: unknown): unknown {
    return this.timedOut ? new NodeTimeoutError(this.opts.timeoutMs ?? 0) : err;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.hb) clearInterval(this.hb);
    if (this.onParentAbort) this.opts.parent?.removeEventListener('abort', this.onParentAbort);
  }
}

export async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {});
    throw signal.reason;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    // Avoid unhandled rejections from the losing promise.
    promise.catch(() => {});
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
