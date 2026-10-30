import { createHash, randomBytes } from 'node:crypto';

/**
 * Identifier helpers.
 *
 * Aptamind uses prefixed string identifiers so that an ID is self-describing in logs,
 * URLs and evidence references (e.g. `cmp_01J...` is a company, `run_01J...` a workflow run).
 *
 * Two flavours exist:
 *  - `newId(prefix)` — time-ordered, random (ULID-compatible Crockford base32 body).
 *  - `deterministicId(prefix, ...parts)` — stable hash of the given parts. Used for
 *    idempotent inserts: retries of the same logical operation produce the same ID,
 *    so a duplicate-key error means "already done".
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = 0;
let lastRandom: number[] = [];

function encodeTime(time: number, length: number): string {
  let out = '';
  let t = time;
  for (let i = length - 1; i >= 0; i--) {
    const mod = t % 32;
    out = CROCKFORD[mod] + out;
    t = (t - mod) / 32;
  }
  return out;
}

function randomDigits(): number[] {
  const bytes = randomBytes(16);
  return Array.from(bytes, (b) => b % 32);
}

/** Monotonic ULID body (26 chars). */
export function ulid(now: number = Date.now()): string {
  let rand: number[];
  if (now === lastTime) {
    rand = [...lastRandom];
    // increment the random component to keep ordering monotonic within the same millisecond
    for (let i = rand.length - 1; i >= 0; i--) {
      const cur = rand[i] ?? 0;
      if (cur < 31) {
        rand[i] = cur + 1;
        break;
      }
      rand[i] = 0;
    }
  } else {
    rand = randomDigits();
  }
  lastTime = now;
  lastRandom = rand;
  return encodeTime(now, 10) + rand.map((d) => CROCKFORD[d]).join('');
}

export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Stable, collision-resistant ID derived from the given parts. */
export function deterministicId(prefix: string, ...parts: Array<string | number | undefined | null>): string {
  const material = parts.map((p) => (p === undefined || p === null ? '\u0000' : String(p))).join('\u001f');
  return `${prefix}_${sha256Hex(material).slice(0, 26)}`;
}

/**
 * Canonical JSON serialisation (sorted keys, no whitespace) used for content hashing.
 * `undefined` object members are dropped, mirroring JSON.stringify.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function contentHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export const ID_PREFIX = {
  workflowRun: 'run',
  nodeRun: 'nrun',
  artifact: 'art',
  schedule: 'sch',
  source: 'src',
  snapshot: 'snap',
  companyObservation: 'cobs',
  jobObservation: 'jobs',
  company: 'cmp',
  job: 'job',
  signal: 'sig',
  reviewItem: 'rev',
  auditEvent: 'aud',
  verification: 'ver',
  fanoutChunk: 'fch',
} as const;
