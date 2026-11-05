import { AppError, newId, type JsonObject, type JsonValue } from '@aptamind/contracts';
import { ZodError } from 'zod';

export type McpAuditOutcome = 'ok' | 'error' | 'denied' | 'rate_limited' | 'unauthorized';

export interface McpLogger {
  error(obj: unknown, msg?: string): void;
}

/** Thrown by a tool (or the HTTP gate) to record an outcome other than a generic error. */
export class McpCallError extends Error {
  readonly outcome: Exclude<McpAuditOutcome, 'ok'>;
  readonly errorCode: string;

  constructor(outcome: Exclude<McpAuditOutcome, 'ok'>, errorCode: string, message: string = errorCode) {
    super(message);
    this.name = 'McpCallError';
    this.outcome = outcome;
    this.errorCode = errorCode;
  }
}

export interface McpAuditDeps {
  platform: {
    market: {
      audit: {
        record(event: {
          actor: { kind: 'internal-operator'; id: 'mcp' };
          action: string;
          entity: { kind: 'mcp_call'; id: string };
          details: JsonObject;
        }): Promise<unknown>;
      };
    };
  };
  logger: McpLogger;
  clientIp: string;
}

const ARG_MAX = 200;

/** Top-level keys only. Primitives are kept (strings cut to 200 chars); nested values are not. */
export function redactArgs(args: unknown): JsonObject {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(args)) {
    const redacted = redactValue(value);
    if (redacted !== undefined) out[key] = redacted;
  }
  return out;
}

function redactValue(value: unknown): JsonValue | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return value.length > ARG_MAX ? value.slice(0, ARG_MAX) : value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.toISOString();
  // Keep the key, drop the nested value.
  if (typeof value === 'object') return '[redacted]';
  return undefined;
}

function resultCountOf(result: unknown): number | undefined {
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === 'object' && 'items' in result) {
    const items = (result as { items?: unknown }).items;
    if (Array.isArray(items)) return items.length;
  }
  return undefined;
}

function classify(err: unknown): { outcome: Exclude<McpAuditOutcome, 'ok'>; errorCode: string } {
  if (err instanceof McpCallError) return { outcome: err.outcome, errorCode: err.errorCode };
  if (err instanceof AppError) return { outcome: 'error', errorCode: err.code };
  if (err instanceof ZodError) return { outcome: 'error', errorCode: 'validation_failed' };
  return { outcome: 'error', errorCode: 'internal' };
}

/**
 * Run `fn` and record one audit event. An audit-write failure is logged and never replaces
 * the tool result or the original error.
 */
export async function withAudit<T>(
  deps: McpAuditDeps,
  tool: string,
  args: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  let result: T | undefined;
  let thrown: unknown;
  let outcome: McpAuditOutcome = 'ok';
  let errorCode: string | undefined;
  try {
    result = await fn();
  } catch (err) {
    thrown = err;
    const classified = classify(err);
    outcome = classified.outcome;
    errorCode = classified.errorCode;
  }
  const details: JsonObject = {
    tool,
    outcome,
    durationMs: Date.now() - started,
    args: redactArgs(args),
    clientIp: deps.clientIp,
  };
  if (outcome === 'ok') {
    const resultCount = resultCountOf(result);
    if (resultCount !== undefined) details.resultCount = resultCount;
    if (result && typeof result === 'object' && 'runId' in result) {
      const r = result as { runId?: unknown; replayed?: unknown; idempotencyKey?: unknown };
      if (typeof r.runId === 'string') details.runId = r.runId;
      if (typeof r.replayed === 'boolean') details.replayed = r.replayed;
      if (typeof r.idempotencyKey === 'string') details.idempotencyKey = r.idempotencyKey;
    }
  }
  if (errorCode !== undefined) details.errorCode = errorCode;
  try {
    await deps.platform.market.audit.record({
      actor: { kind: 'internal-operator', id: 'mcp' },
      action: `mcp.${tool}`,
      entity: { kind: 'mcp_call', id: newId('mcp') },
      details,
    });
  } catch (err) {
    try {
      deps.logger.error({ errName: err instanceof Error ? err.name : typeof err, tool }, 'mcp audit failed');
    } catch {
      // The request must still finish when both the audit store and the logger fail.
    }
  }
  if (thrown) throw thrown;
  return result as T;
}
