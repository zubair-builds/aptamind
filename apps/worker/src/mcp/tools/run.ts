import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { NotFoundError, jsonObjectSchema } from '@aptamind/contracts';
import type { Platform } from '@aptamind/platform';
import { z } from 'zod';
import { McpCallError, withAudit, type McpAuditDeps } from '../audit';
import type { McpLimiters } from '../rate-limit';
import { errorResult, okResult, publicCode } from './read';

export interface RunToolDeps extends McpAuditDeps {
  platform: Platform;
  limiters: McpLimiters;
  runAllowlist: readonly string[];
}

export const startWorkflowRunInput = z.object({
  workflowKey: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._-]+$/),
  input: jsonObjectSchema.default({}),
  idempotencyKey: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9._-]+$/, 'letters, digits and . _ - only'),
});
type StartWorkflowRunInput = z.infer<typeof startWorkflowRunInput>;

// Draft 2020-12 (the workflow spec's dialect). `addUsedSchema: false` keeps a schema `$id` from
// poisoning later compiles; validators are cached per immutable workflow version.
const ajv = new Ajv2020({ allErrors: false, strict: false, addUsedSchema: false });
const validators = new Map<string, ValidateFunction>();

/** Key order-independent JSON, so a replay with the same input in another key order matches. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * `start_workflow_run`: starts an allowlisted workflow (deny by default). The engine dedupes on
 * the key alone, so a replay with a different workflow or input is refused here.
 */
export function registerRunTools(
  server: McpServer,
  deps: RunToolDeps,
  schemas: Map<string, z.ZodType>,
): void {
  schemas.set('start_workflow_run', startWorkflowRunInput);
  server.registerTool(
    'start_workflow_run',
    {
      description:
        'Start an allowlisted, proposal-only workflow run. idempotencyKey is required; a replay with the same key returns the same run.',
      inputSchema: startWorkflowRunInput,
    },
    async (args) => runCall(deps, args),
  );
}

async function runCall(deps: RunToolDeps, args: StartWorkflowRunInput): Promise<CallToolResult> {
  const decision = deps.limiters.write.take();
  if (!decision.ok) {
    await withAudit(deps, 'start_workflow_run', auditArgs(args), async () => {
      throw new McpCallError('rate_limited', 'rate_limited');
    }).catch(() => undefined);
    return errorResult('rate_limited');
  }
  try {
    const result = await withAudit(deps, 'start_workflow_run', auditArgs(args), () => startRun(deps, args));
    return okResult(result);
  } catch (err) {
    return errorResult(publicCode(err));
  }
}

/** Audit the key and workflow; the input is only summarised (top-level keys). */
function auditArgs(args: StartWorkflowRunInput) {
  return {
    workflowKey: args.workflowKey,
    idempotencyKey: args.idempotencyKey,
    inputKeys: Object.keys(args.input).sort().join(',').slice(0, 200),
  };
}

async function startRun(deps: RunToolDeps, args: StartWorkflowRunInput) {
  const { platform } = deps;
  const { workflowKey, input } = args;
  if (!deps.runAllowlist.includes(workflowKey)) throw new McpCallError('denied', 'workflow_not_allowed');
  // A private domain's workflow is refused like an unknown one, even if allowlisted by mistake.
  if (!platform.workflowAccess.startableGenerically(workflowKey))
    throw new NotFoundError('Workflow', workflowKey);

  const version = await platform.runtime.catalog.getVersion(workflowKey);
  if (version.inputSchema) {
    const cacheKey = `${workflowKey}@${version.version}`;
    let validate = validators.get(cacheKey);
    if (!validate) {
      validate = ajv.compile(version.inputSchema);
      validators.set(cacheKey, validate);
    }
    if (!validate(input)) throw new McpCallError('error', 'validation_failed');
  }

  // Fail closed on a source the launch rules cannot check (the generic helper skips unknown ids).
  if ('sourceId' in input) {
    if (typeof input.sourceId !== 'string') throw new McpCallError('error', 'validation_failed');
    await platform.market.sources.get(input.sourceId);
  }
  await platform.market.sources.assertWorkflowRunAllowed(workflowKey, input);

  // Neither segment may contain ':' (both regexes), so keys cannot collide across workflows.
  const idempotencyKey = `mcp:${workflowKey}:${args.idempotencyKey}`;
  const callStartedAt = Date.now();
  const existing = await platform.runtime.engine.runs.findOne(
    { idempotencyKey },
    { projection: { workflowKey: 1, input: 1, state: 1 } },
  );
  if (existing) {
    if (existing.workflowKey !== workflowKey || canonicalJson(existing.input) !== canonicalJson(input))
      throw new McpCallError('denied', 'idempotency_conflict');
    return { runId: existing._id, state: existing.state, replayed: true, idempotencyKey };
  }
  const run = await platform.runtime.engine.startRun({
    workflowKey,
    version: version.version,
    input,
    idempotencyKey,
    labels: typeof input.sourceId === 'string' ? { sourceId: input.sourceId } : {},
    trigger: { kind: 'manual', actor: { kind: 'internal-operator', id: 'mcp' } },
  });
  // A lost insert race returns the other writer's run: check it is the same request.
  if (
    run.workflowKey !== workflowKey ||
    run.workflowVersion !== version.version ||
    canonicalJson(run.input) !== canonicalJson(input)
  )
    throw new McpCallError('denied', 'idempotency_conflict');
  // A run created before this call is the winner of a concurrent insert, i.e. a replay.
  const replayed = new Date(run.createdAt).getTime() < callStartedAt;
  return { runId: run._id, state: run.state, replayed, idempotencyKey };
}
