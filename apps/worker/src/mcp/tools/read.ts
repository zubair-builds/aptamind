import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AppError, NotFoundError } from '@aptamind/contracts';
import {
  companyListQuerySchema,
  companySummaries,
  idParamsSchema,
  jobListQuerySchema,
  jobSummary,
  listCompanies,
  listJobs,
  listSources,
  sourceListQuerySchema,
  type ScheduleCollection,
} from '@aptamind/market';
import type { Platform } from '@aptamind/platform';
import { DEFAULT_CAPABILITY_QUEUES, FANOUT_QUEUE, nodeQueueName } from '@aptamind/workflows';
import { z, ZodError } from 'zod';
import { McpCallError, withAudit, type McpAuditDeps, type McpLogger } from '../audit';
import type { McpLimiters } from '../rate-limit';

export interface ReadToolDeps extends McpAuditDeps {
  platform: Platform;
  limiters: McpLimiters;
  logger: McpLogger;
  clientIp: string;
}

const dashboardInput = z.object({
  hours: z.number().int().min(1).max(720).default(24),
});

const listRunsInput = z.object({
  workflowKey: z.string().min(1).max(200).optional(),
  state: z.string().min(1).max(100).optional(),
  sourceId: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(100_000).default(0),
});

const LIST_CAP = 100;

/**
 * Read tools. Each call takes one token from the read bucket, runs the same service the admin
 * route uses, and writes one audit event. Failures are a short code (`isError`), never a stack.
 */
export function registerReadTools(server: McpServer, deps: ReadToolDeps): Map<string, z.ZodType> {
  const { platform } = deps;
  const schemas = new Map<string, z.ZodType>();
  const tool: McpServer['registerTool'] = (name, config, cb) => {
    if (config.inputSchema) schemas.set(name, config.inputSchema as unknown as z.ZodType);
    return server.registerTool(name, config, cb);
  };

  tool(
    'get_dashboard',
    {
      description: 'Operational dashboard: market summary, run stats, queue depth and freshness.',
      inputSchema: dashboardInput,
    },
    async (args) => readCall(deps, 'get_dashboard', args, () => getDashboard(platform, args.hours)),
  );

  tool(
    'list_jobs',
    {
      description: 'List jobs in the summary shape. At most 100 rows; view is always summary.',
      inputSchema: jobListQuerySchema,
    },
    async (args) =>
      readCall(deps, 'list_jobs', args, () =>
        listJobs(
          platform.market.ctx.db,
          { ...args, view: 'summary', limit: Math.min(args.limit, LIST_CAP) },
          platform.market.ctx.clock.now(),
        ),
      ),
  );

  tool(
    'get_job',
    {
      description: 'One job in the summary list-row shape (no observations, verifications or audit).',
      inputSchema: idParamsSchema,
    },
    async (args) =>
      readCall(deps, 'get_job', args, async () => {
        const job = await platform.market.jobs.get(args.id);
        return jobSummary(platform.market.ctx.db, job);
      }),
  );

  tool(
    'list_companies',
    {
      description: 'List companies in the summary shape. At most 100 rows; view is always summary.',
      inputSchema: companyListQuerySchema,
    },
    async (args) =>
      readCall(deps, 'list_companies', args, () =>
        listCompanies(platform.market.ctx.db, {
          ...args,
          view: 'summary',
          limit: Math.min(args.limit, LIST_CAP),
        }),
      ),
  );

  tool(
    'get_company',
    {
      description: 'One company in the summary list-row shape (no observations, reviews or audit).',
      inputSchema: idParamsSchema,
    },
    async (args) =>
      readCall(deps, 'get_company', args, async () => {
        const company = await platform.market.companies.get(args.id);
        const [summary] = await companySummaries(platform.market.ctx.db, [company]);
        if (!summary) throw new NotFoundError('Company', args.id);
        return summary;
      }),
  );

  tool(
    'list_sources',
    {
      description:
        'List sources: key, name, provider, enabled, health status, freshness and schedule. At most 100 rows.',
      inputSchema: sourceListQuerySchema,
    },
    async (args) =>
      readCall(deps, 'list_sources', args, async () => {
        const schedules = platform.runtime.engine.db.collection(
          'workflow_schedules',
        ) as unknown as ScheduleCollection;
        const page = await listSources(
          platform.market.ctx.db,
          { ...args, limit: Math.min(args.limit, LIST_CAP) },
          platform.market.ctx.clock.now(),
          schedules,
        );
        return { ...page, items: page.items.map(sourceRow) };
      }),
  );

  tool(
    'list_workflows',
    {
      description:
        'Workflow definitions that can be started generically (key, name, description, latest version).',
      inputSchema: z.object({}),
    },
    async (args) => readCall(deps, 'list_workflows', args, () => listWorkflows(platform)),
  );

  tool(
    'list_runs',
    {
      description: 'Top-level workflow runs for generically startable workflows.',
      inputSchema: listRunsInput,
    },
    async (args) => readCall(deps, 'list_runs', args, () => listRuns(platform, args)),
  );

  tool(
    'get_run',
    {
      description: 'Run summary: ids, state, timings, version and errors. No input, output or artifacts.',
      inputSchema: idParamsSchema,
    },
    async (args) => readCall(deps, 'get_run', args, () => getRun(platform, args.id)),
  );
  return schemas;
}

async function readCall(
  deps: ReadToolDeps,
  tool: string,
  args: unknown,
  fn: () => Promise<unknown>,
): Promise<CallToolResult> {
  const decision = deps.limiters.read.take();
  if (!decision.ok) {
    await withAudit(deps, tool, args, async () => {
      throw new McpCallError('rate_limited', 'rate_limited');
    }).catch((err: unknown) => {
      if (!(err instanceof McpCallError)) throw err;
    });
    return errorResult('rate_limited');
  }
  try {
    const result = await withAudit(deps, tool, args, fn);
    return okResult(result);
  } catch (err) {
    return errorResult(publicCode(err));
  }
}

export function publicCode(err: unknown): string {
  if (err instanceof McpCallError) return err.errorCode;
  if (err instanceof AppError) return err.code;
  if (err instanceof ZodError) return 'validation_failed';
  return 'internal';
}

export function okResult(result: unknown): CallToolResult {
  const text = JSON.stringify(result ?? null);
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    return {
      content: [{ type: 'text', text }],
      structuredContent: result as Record<string, unknown>,
    };
  }
  return { content: [{ type: 'text', text }] };
}

export function errorResult(code: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: code }] };
}

async function getDashboard(platform: Platform, hours: number) {
  const windowMs = hours * 3_600_000;
  const names = [...DEFAULT_CAPABILITY_QUEUES.map(nodeQueueName), FANOUT_QUEUE];
  const [summary, runs, queues, overdue] = await Promise.all([
    platform.market.dashboard.summary(windowMs),
    genericRunsByState(platform, new Date(Date.now() - windowMs)),
    Promise.all(names.map(async (n) => ({ queue: n, ...(await platform.transport.counts(n)) }))),
    platform.market.freshness.overdueSources(),
  ]);
  const due = await platform.market.freshness.jobsDueForVerification(1000);
  return {
    ...summary,
    // Failing sources keep only their status: `lastError` may quote upstream responses.
    sources: {
      ...summary.sources,
      failing: summary.sources.failing.map((f) => ({ ...f, health: { status: f.health?.status } })),
    },
    runs,
    queues,
    freshness: { overdueSources: overdue, jobsDueForVerification: due.length },
  };
}

async function listWorkflows(platform: Platform) {
  const defs = await platform.runtime.catalog.listDefinitions();
  return {
    items: defs
      .filter((d) => platform.workflowAccess.startableGenerically(d._id))
      .map((d) => ({
        key: d._id,
        name: d.title,
        description: d.description,
        latestVersion: d.latestVersion,
      })),
  };
}

const NOT_PROFESSIONAL = { $not: /^professional\./ };

/** Run counts by state in the window, without private-domain (Professional) runs. */
async function genericRunsByState(platform: Platform, since: Date) {
  const rows = await platform.runtime.engine.runs
    .aggregate<{ _id: string; n: number }>([
      { $match: { createdAt: { $gte: since }, workflowKey: NOT_PROFESSIONAL } },
      { $group: { _id: '$state', n: { $sum: 1 } } },
    ])
    .toArray();
  return { since, byState: Object.fromEntries(rows.map((r) => [r._id, r.n])) };
}

async function listRuns(
  platform: Platform,
  args: { workflowKey?: string; state?: string; sourceId?: string; limit: number; offset: number },
) {
  // Professional runs are not part of the generic read surface: filter in the query so
  // `total` and the pages match what is returned.
  if (args.workflowKey && !platform.workflowAccess.startableGenerically(args.workflowKey))
    return { items: [], total: 0, limit: args.limit, offset: args.offset };
  const filter: Record<string, unknown> = { depth: 0, workflowKey: args.workflowKey ?? NOT_PROFESSIONAL };
  if (args.state) filter.state = args.state;
  if (args.sourceId) filter['labels.sourceId'] = args.sourceId;
  const runs = platform.runtime.engine.runs;
  const [items, total] = await Promise.all([
    runs
      .find(filter, { projection: { input: 0, output: 0 } })
      .sort({ createdAt: -1 })
      .skip(args.offset)
      .limit(args.limit)
      .toArray(),
    runs.countDocuments(filter),
  ]);
  return {
    items: items.map((run) => runRow(run as unknown as RunLike)),
    total,
    limit: args.limit,
    offset: args.offset,
  };
}

async function getRun(platform: Platform, id: string) {
  // Check ownership before loading the full detail (input, output, node config).
  const head = await platform.runtime.engine.runs.findOne({ _id: id }, { projection: { workflowKey: 1 } });
  if (!head || !platform.workflowAccess.startableGenerically(head.workflowKey))
    throw new NotFoundError('WorkflowRun', id);
  const detail = await platform.runtime.queries.getRunDetail(id);
  return summarizeRun(detail);
}

interface RunLike {
  _id: string;
  workflowKey: string;
  workflowVersion: number;
  state: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  durationMs?: number;
  error?: { name: string; message: string; code?: string };
}

function runRow(run: RunLike) {
  const error = errorSummary(run.error);
  return {
    id: run._id,
    workflowKey: run.workflowKey,
    version: run.workflowVersion,
    state: run.state,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    durationMs: run.durationMs ?? null,
    ...(error ? { error } : {}),
  };
}

export function sourceRow(s: Record<string, unknown>) {
  const health = (s.health ?? {}) as { status?: unknown; lastSuccessAt?: unknown; lastFailureAt?: unknown };
  return {
    id: s._id,
    key: s.key,
    name: s.name,
    category: s.category,
    provider: s.provider,
    enabled: s.enabled,
    companyName: s.companyName ?? null,
    health: {
      status: health.status ?? null,
      lastSuccessAt: health.lastSuccessAt ?? null,
      lastFailureAt: health.lastFailureAt ?? null,
    },
    freshness: s.freshness ?? null,
    schedule: s.schedule ?? null,
  };
}

function errorSummary(error: { name: string; message: string; code?: string } | undefined) {
  // The message can quote the failing input; return the name and code only.
  if (!error) return undefined;
  return error.code ? { name: error.name, code: error.code } : { name: error.name };
}

function summarizeRun(detail: {
  run: {
    _id: string;
    workflowKey: string;
    workflowVersion: number;
    state: string;
    createdAt: Date;
    updatedAt: Date;
    startedAt?: Date;
    finishedAt?: Date;
    durationMs?: number;
    error?: { name: string; message: string; code?: string };
  };
  nodes: Array<{
    nodeId: string;
    nodeRun: {
      state: string;
      startedAt?: Date;
      finishedAt?: Date;
      durationMs?: number;
      error?: { name: string; message: string; code?: string };
    } | null;
  }>;
}) {
  const run = detail.run;
  const runError = errorSummary(run.error);
  return {
    id: run._id,
    workflowKey: run.workflowKey,
    version: run.workflowVersion,
    state: run.state,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    durationMs: run.durationMs ?? null,
    ...(runError ? { error: runError } : {}),
    nodes: detail.nodes.map((node) => {
      const nodeError = errorSummary(node.nodeRun?.error);
      return {
        nodeId: node.nodeId,
        state: node.nodeRun?.state ?? null,
        startedAt: node.nodeRun?.startedAt ?? null,
        finishedAt: node.nodeRun?.finishedAt ?? null,
        durationMs: node.nodeRun?.durationMs ?? null,
        ...(nodeError ? { error: nodeError } : {}),
      };
    }),
  };
}
