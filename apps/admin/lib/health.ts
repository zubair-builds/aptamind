import { cache } from 'react';
import { API_BASE_URL, apiRequest } from './api';
import type { Readiness } from './types';

export interface ApiHealth {
  state: 'ready' | 'not_ready' | 'unavailable';
  url: string;
  checks: Record<string, boolean> | null;
  message?: string;
}

/** API readiness, fetched at most once per request (sidebar dot, notice and System page). */
export const getApiHealth = cache(async (): Promise<ApiHealth> => {
  const res = await apiRequest<Readiness>('/ready', { timeoutMs: 3000 });
  if (!res.ok && res.error.kind === 'unavailable')
    return { state: 'unavailable', url: API_BASE_URL, checks: null, message: res.error.message };
  // /ready answers 503 with the same body shape when a dependency is down.
  const checks = res.ok
    ? res.data.checks
    : ((res.error.details as Partial<Readiness> | undefined)?.checks ?? null);
  const ready = res.ok && res.data.status === 'ready';
  return {
    state: ready ? 'ready' : 'not_ready',
    url: API_BASE_URL,
    checks,
    message: res.ok ? undefined : res.error.message,
  };
});

export const HEALTH_LABEL: Record<ApiHealth['state'], string> = {
  ready: 'API ready',
  not_ready: 'API not ready',
  unavailable: 'API unavailable',
};

/** Short form for the sidebar, so "System status" never truncates. */
export const HEALTH_SHORT: Record<ApiHealth['state'], string> = {
  ready: 'Ready',
  not_ready: 'Not ready',
  unavailable: 'Down',
};
