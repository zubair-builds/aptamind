import { cache } from 'react';
import { API_BASE_URL, type ApiResult, apiRequest } from './api';
import type { Readiness } from './types';

export interface ApiHealth {
  state: 'ready' | 'not_ready' | 'unavailable';
  url: string;
  checks: Record<string, boolean> | null;
  message?: string;
}

/** First readiness probe, then one short retry so a brief blip (startup, reconnect) never shows. */
export const HEALTH_PROBE_TIMEOUTS_MS = [2000, 700] as const;
export const HEALTH_RETRY_DELAY_MS = 300;

/** Maps one `/ready` answer to the admin's three health states (pure). */
export function toApiHealth(res: ApiResult<Readiness>): ApiHealth {
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
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Probe readiness (uncached). `getApiHealth` is the request-cached wrapper used by the shell. */
export async function fetchApiHealth(): Promise<ApiHealth> {
  const [first, second] = HEALTH_PROBE_TIMEOUTS_MS;
  const initial = toApiHealth(await apiRequest<Readiness>('/ready', { timeoutMs: first }));
  if (initial.state === 'ready') return initial;
  await sleep(HEALTH_RETRY_DELAY_MS);
  const retry = toApiHealth(await apiRequest<Readiness>('/ready', { timeoutMs: second }));
  if (retry.state === 'ready') return retry;
  // A hung dependency answers 503 in ~1.5s (FE-9). That fits the 2s first probe but not
  // the 700ms retry, so keep the first not_ready (with checks) instead of an abort.
  if (retry.state === 'unavailable' && initial.state === 'not_ready') return initial;
  return retry;
}

/** API readiness, fetched at most once per request (sidebar dot, notice and System page). */
export const getApiHealth = cache(fetchApiHealth);

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

/** What the shell notice says: plain language, by impact, technical detail left to System status. */
export interface HealthDescription {
  /** Stable id of this failure (`state:failedChecks`); a new signature re-shows a dismissed notice. */
  signature: string;
  headline: string;
  detail: string;
  /** Names of the readiness checks that failed, sorted. */
  failed: string[];
  /** Local-setup hints (env var names only, never values); the notice shows them outside production. */
  devHints: string[];
}

interface Impact {
  rank: number;
  short: string;
  headline: string;
  detail: string;
  devHint: string;
}

const RETRYING = 'Retrying automatically.';

const IMPACT: Record<string, Impact> = {
  mongo: {
    rank: 0,
    short: 'the database',
    headline: 'Data is temporarily unavailable.',
    detail: `The database isn't responding, so lists and counts may be empty. ${RETRYING}`,
    devHint:
      "MongoDB isn't reachable. Start it with docker compose up -d mongo and check MONGODB_URI in .env.",
  },
  redis: {
    rank: 1,
    short: 'background jobs',
    headline: 'Background jobs are paused.',
    detail: `The job queue isn't responding, so runs and queue numbers may be out of date. ${RETRYING}`,
    devHint: "Redis isn't reachable. Start it with docker compose up -d redis and check REDIS_URL in .env.",
  },
  objectStorage: {
    rank: 2,
    short: 'file storage',
    headline: "Snapshots and imports can't be opened right now.",
    detail: `File storage isn't responding. Everything else still works. ${RETRYING}`,
    devHint:
      "Object storage isn't reachable. Start it with docker compose up -d s3 and check S3_ENDPOINT in .env.",
  },
};

const GENERIC = {
  headline: 'Some data is temporarily unavailable.',
  detail: `Part of the system isn't responding. ${RETRYING}`,
};

const UNAVAILABLE = {
  headline: 'Data is temporarily unavailable.',
  detail: `The admin can't reach its data service right now, so some sections may be empty. ${RETRYING}`,
  devHint:
    "The internal API couldn't start or answer in time. Start local services with docker compose up -d " +
    '(MongoDB: MONGODB_URI, Redis: REDIS_URL, object storage: S3_ENDPOINT), then restart the dev server.',
};

const rankOf = (name: string) => IMPACT[name]?.rank ?? Number.MAX_SAFE_INTEGER;

/** Plain-language notice for a health state; null when the API is ready. Pure. */
export function describeHealth(health: ApiHealth): HealthDescription | null {
  if (health.state === 'ready') return null;
  const failed = Object.entries(health.checks ?? {})
    .filter(([, ok]) => !ok)
    .map(([name]) => name)
    .sort();
  const signature = `${health.state}:${failed.join(',')}`;
  if (health.state === 'unavailable')
    return {
      signature,
      headline: UNAVAILABLE.headline,
      detail: UNAVAILABLE.detail,
      failed,
      devHints: [UNAVAILABLE.devHint],
    };
  const bySeverity = [...failed].sort((a, b) => rankOf(a) - rankOf(b) || a.localeCompare(b));
  const top = bySeverity[0] !== undefined ? IMPACT[bySeverity[0]] : undefined;
  const others = bySeverity.slice(1).map((name) => IMPACT[name]?.short ?? name);
  const base = top ?? GENERIC;
  return {
    signature,
    headline: base.headline,
    detail: others.length ? `${base.detail} Also affected: ${others.join(', ')}.` : base.detail,
    failed,
    devHints: failed.flatMap((name) => (IMPACT[name] ? [IMPACT[name].devHint] : [])),
  };
}
