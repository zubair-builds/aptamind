/** Resolves after `ms`; rejects with the signal's reason as soon as it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Rejects as soon as `signal` aborts, without waiting for `work`. The work still settles later,
 * so its outcome goes to `onLate`: a caller can undo a grant nobody is waiting for any more.
 */
export function raceAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  onLate: (outcome: PromiseSettledResult<T>) => void,
): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      reject(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (aborted) onLate({ status: 'fulfilled', value });
        else resolve(value);
      },
      (reason: unknown) => {
        signal.removeEventListener('abort', onAbort);
        if (aborted) onLate({ status: 'rejected', reason });
        else reject(reason);
      },
    );
  });
}
