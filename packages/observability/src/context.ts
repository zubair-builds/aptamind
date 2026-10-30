import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Correlation context propagated through async work. Every log line emitted inside
 * `withCorrelation` automatically carries these identifiers.
 */
export interface Correlation {
  requestId?: string;
  workflowRunId?: string;
  nodeRunId?: string;
  workflowKey?: string;
  sourceId?: string;
  companyId?: string;
  jobId?: string;
  [key: string]: string | undefined;
}

const storage = new AsyncLocalStorage<Correlation>();

export function currentCorrelation(): Correlation {
  return storage.getStore() ?? {};
}

export function withCorrelation<T>(fields: Correlation, fn: () => T): T {
  const merged = { ...currentCorrelation(), ...stripUndefined(fields) };
  return storage.run(merged, fn);
}

function stripUndefined(obj: Correlation): Correlation {
  const out: Correlation = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}
