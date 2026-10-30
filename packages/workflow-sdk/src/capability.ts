import type { z } from 'zod';
import type { ArtifactRef, Clock, JsonObject } from '@aptamind/contracts';
import type { RecordSet, RecordsInput } from './recordset';
import type { ServiceRegistry } from './services';

export interface CapabilityRef {
  type: string;
  version: number;
}

export function capabilityKey(ref: CapabilityRef): string {
  return `${ref.type}@${ref.version}`;
}

export type CapabilityCategory =
  'trigger' | 'control' | 'acquisition' | 'transform' | 'storage' | 'ai' | 'domain';

interface CapabilityExecutionBase {
  /** Default retry classification for unclassified errors. */
  retryable: boolean;
  defaultTimeoutMs?: number;
  /**
   * Capability class used to route work to dedicated worker pools
   * (e.g. `browser`, `ai`) so they scale independently. Defaults to `default`.
   */
  queue?: string;
  /** Engine-level execution mode. Only core control capabilities use `fanout`. */
  mode?: 'standard' | 'fanout';
}

/**
 * How a capability stays correct under the runtime's at-least-once execution (a node attempt
 * can run again after a crash, a lease takeover, a lost acknowledgement or a retry):
 *
 * - `pure` — no durable side effects. Allowed: read-only I/O and content-addressed artifact
 *   writes (deduplicated by hash, so idempotent by construction).
 * - `key` — side effects are keyed on `ctx.idempotencyKey` (or on an id derived from it), so a
 *   re-execution finds and reuses what the first one did. `idempotencyProof` says how.
 * - `natural` — side effects are idempotent by construction (deterministic ids from the input,
 *   unique indexes, set-based or recompute-from-evidence writes, durable replay markers).
 *   `idempotencyProof` says how.
 * - `no_retry` — not safe to execute twice: the runtime never re-executes it automatically
 *   (no error retries, a lease takeover fails the node instead of re-running it, operator retry
 *   is refused, and it cannot be a `for_each` body).
 *
 * The combinations are checked at compile time (this type) and at registration
 * (`assertExecutionContract`); an ambiguous retryable side effect is rejected.
 */
export type IdempotencyStrategy = 'pure' | 'key' | 'natural' | 'no_retry';

export type CapabilityExecution = CapabilityExecutionBase &
  (
    | { sideEffects: false; idempotency: 'pure'; idempotencyProof?: string }
    | { sideEffects: true; idempotency: 'key' | 'natural'; idempotencyProof: string }
    | { sideEffects: true; idempotency: 'no_retry'; retryable: false; idempotencyProof?: string }
  );

/** Runtime check of the execution contract (for definitions built without static types). */
export function executionContractViolation(e: {
  sideEffects?: unknown;
  idempotency?: unknown;
  retryable?: unknown;
  idempotencyProof?: unknown;
}): string | null {
  const strategies = ['pure', 'key', 'natural', 'no_retry'];
  if (typeof e.idempotency !== 'string' || !strategies.includes(e.idempotency)) {
    return `idempotency must be one of ${strategies.join(', ')} (got ${JSON.stringify(e.idempotency)})`;
  }
  if (typeof e.sideEffects !== 'boolean') return 'sideEffects must be declared';
  if (typeof e.retryable !== 'boolean') return 'retryable must be declared';
  if (!e.sideEffects && e.idempotency !== 'pure') {
    return `a capability without side effects must declare idempotency 'pure'`;
  }
  if (e.sideEffects && e.idempotency === 'pure') {
    return `a side-effecting capability cannot be 'pure': choose 'key', 'natural' or 'no_retry'`;
  }
  if (
    (e.idempotency === 'key' || e.idempotency === 'natural') &&
    !(typeof e.idempotencyProof === 'string' && e.idempotencyProof.trim().length >= 10)
  ) {
    return `idempotency '${e.idempotency}' requires idempotencyProof explaining why re-execution is safe`;
  }
  if (e.idempotency === 'no_retry' && e.retryable) return `idempotency 'no_retry' requires retryable: false`;
  return null;
}

/** Whether the runtime may execute this capability again for the same logical invocation. */
export function allowsReexecution(e: Pick<CapabilityExecution, 'idempotency'>): boolean {
  return e.idempotency !== 'no_retry';
}

export interface NodeLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface ArtifactAccess {
  put(body: Uint8Array | string, mimeType: string, labels?: Record<string, string>): Promise<ArtifactRef>;
  putJson(value: unknown, labels?: Record<string, string>): Promise<ArtifactRef>;
  readBytes(ref: Pick<ArtifactRef, 'artifactId'> & Partial<ArtifactRef>): Promise<Uint8Array>;
  readText(ref: Pick<ArtifactRef, 'artifactId'> & Partial<ArtifactRef>): Promise<string>;
  readJson<T = unknown>(ref: Pick<ArtifactRef, 'artifactId'> & Partial<ArtifactRef>): Promise<T>;
}

export interface RecordAccess {
  /** Persist records as a JSONL record set. */
  write(
    records: Iterable<unknown> | AsyncIterable<unknown>,
    labels?: Record<string, string>,
  ): Promise<RecordSet>;
  /** Iterate records from an inline array or a record set. */
  read(input: RecordsInput): AsyncIterable<unknown>;
}

export interface SubworkflowRequest {
  workflowKey: string;
  version?: number;
  input: JsonObject;
  /** Stable key; re-invocation with the same key resumes/returns the same child run. */
  idempotencyKey: string;
  labels?: Record<string, string>;
}

export interface SubworkflowResult {
  runId: string;
  state: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'WAITING';
  output: unknown;
  error?: { message: string; name: string };
}

export interface WaitSpec {
  /** What the node is waiting for, e.g. `review`, `external-callback`. */
  kind: string;
  reason: string;
  /** Opaque correlation key used by whatever resumes the node (e.g. a review item id). */
  correlationKey?: string;
  timeoutAt?: Date;
  data?: JsonObject;
}

export const SUSPEND = Symbol.for('aptamind.workflow.suspend');
export interface Suspend {
  [SUSPEND]: true;
  wait: WaitSpec;
}

export function isSuspend(value: unknown): value is Suspend {
  return !!value && typeof value === 'object' && (value as Record<symbol, unknown>)[SUSPEND] === true;
}

export interface CapabilityContext {
  runId: string;
  rootRunId: string;
  nodeRunId: string;
  nodeId: string;
  workflowKey: string;
  workflowVersion: number;
  attempt: number;
  /** Stable across retries of the same logical step (and per fan-out item). */
  idempotencyKey: string;
  /** Generic run labels, e.g. `{ sourceId }`. The runtime attaches no meaning to them. */
  labels: Record<string, string>;
  signal: AbortSignal;
  clock: Clock;
  log: NodeLogger;
  artifacts: ArtifactAccess;
  records: RecordAccess;
  services: ServiceRegistry;
  /** Present when the node is resumed after `ctx.suspend(...)`. */
  resume?: JsonObject;
  /** Extend the execution lease during long work. Called automatically on an interval too. */
  heartbeat(): Promise<void>;
  /** Suspend this node until resumed externally (human review, callback). */
  suspend(wait: WaitSpec): Suspend;
  /** Execute a child workflow inline (durably recorded, resumable) and return its result. */
  runSubworkflow(req: SubworkflowRequest): Promise<SubworkflowResult>;
}

export interface CapabilityDefinition<I = unknown, O = unknown, C = unknown> {
  type: string;
  version: number;
  title: string;
  description: string;
  category: CapabilityCategory;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  configSchema: z.ZodType<C>;
  execution: CapabilityExecution;
  execute(ctx: CapabilityContext, input: I, config: C): Promise<O | Suspend>;
}

// Registry entries erase generic parameters.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCapability = CapabilityDefinition<any, any, any>;

/** Identity helper that preserves inference of I/O/C from the schemas. */
export function defineCapability<I, O, C>(def: CapabilityDefinition<I, O, C>): CapabilityDefinition<I, O, C> {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(def.type)) {
    throw new Error(
      `Capability type "${def.type}" must be namespaced lower_snake segments, e.g. core.http_request`,
    );
  }
  if (!Number.isInteger(def.version) || def.version < 1)
    throw new Error(`Capability ${def.type} version must be >= 1`);
  return def;
}
