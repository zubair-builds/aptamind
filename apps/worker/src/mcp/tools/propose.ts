import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Platform } from '@aptamind/platform';
import { z } from 'zod';
import { McpCallError, withAudit, type McpAuditDeps } from '../audit';
import type { McpLimiters } from '../rate-limit';
import { errorResult, okResult, publicCode } from './read';

export interface ProposeToolDeps extends McpAuditDeps {
  platform: Platform;
  limiters: McpLimiters;
}

const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'letters, digits and . _ - : only');

export const proposeSourceInput = z.object({
  source: z.record(z.unknown()), // full CreateSourceInput; Market validates
  idempotencyKey,
});
type ProposeSourceInput = z.infer<typeof proposeSourceInput>;

export const importLeadsInput = z.object({
  type: z.enum(['companies', 'ats_boards', 'snapshot', 'jobs']),
  sourceId: z.string().min(1).max(200),
  contentType: z.string().min(1).max(200),
  body: z.string().min(1), // raw text or base64; Market accepts string
  fileName: z.string().max(200).optional(),
  idempotencyKey,
});
type ImportLeadsInput = z.infer<typeof importLeadsInput>;

const MCP_ACTOR = { kind: 'internal-operator' as const, id: 'mcp' };

/**
 * propose_source and import_leads: raise-only proposals. Nothing canonical is written.
 * Approval happens later through the normal review flow.
 */
export function registerProposeTools(
  server: McpServer,
  deps: ProposeToolDeps,
  schemas: Map<string, z.ZodType>,
): void {
  schemas.set('propose_source', proposeSourceInput);
  schemas.set('import_leads', importLeadsInput);

  server.registerTool(
    'propose_source',
    {
      description:
        'Propose a new source. Creates a source_proposal review item only. An admin must approve before the source is registered. idempotencyKey is required.',
      inputSchema: proposeSourceInput,
    },
    async (args) => proposeSourceCall(deps, args),
  );

  server.registerTool(
    'import_leads',
    {
      description:
        'Propose an import of leads from a file. Stages the file and creates an import_proposal review item only. An admin must approve before any import runs. idempotencyKey is required.',
      inputSchema: importLeadsInput,
    },
    async (args) => importLeadsCall(deps, args),
  );
}

async function proposeSourceCall(deps: ProposeToolDeps, args: ProposeSourceInput): Promise<CallToolResult> {
  return writeCall(deps, 'propose_source', args, async () => {
    const result = await deps.platform.market.proposals.proposeSource(
      args.source as any,
      MCP_ACTOR,
      { idempotencyKey: args.idempotencyKey },
    );
    return {
      reviewId: result.item.id,
      type: result.item.type,
      created: result.created,
      status: result.item.status,
    };
  });
}

async function importLeadsCall(deps: ProposeToolDeps, args: ImportLeadsInput): Promise<CallToolResult> {
  return writeCall(deps, 'import_leads', args, async () => {
    const result = await deps.platform.market.proposals.proposeImport(
      {
        type: args.type as any,
        sourceId: args.sourceId,
        contentType: args.contentType,
        body: args.body,
        fileName: args.fileName,
      },
      MCP_ACTOR,
      { idempotencyKey: args.idempotencyKey },
    );
    return {
      reviewId: result.item.id,
      type: result.item.type,
      created: result.created,
      status: result.item.status,
    };
  });
}

async function writeCall(
  deps: ProposeToolDeps,
  tool: string,
  args: { idempotencyKey: string },
  fn: () => Promise<unknown>,
): Promise<CallToolResult> {
  const decision = deps.limiters.write.take();
  if (!decision.ok) {
    await withAudit(deps, tool, { idempotencyKey: args.idempotencyKey }, async () => {
      throw new McpCallError('rate_limited', 'rate_limited');
    }).catch(() => undefined);
    return errorResult('rate_limited');
  }
  try {
    const result = await withAudit(deps, tool, { idempotencyKey: args.idempotencyKey }, fn);
    return okResult(result);
  } catch (err) {
    const code = publicCode(err);
    if (code === 'rate_limited') return errorResult('rate_limited');
    throw err;
  }
}
