import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Platform } from '@aptamind/platform';
import { describe, expect, it } from 'vitest';
import { createMcpLimiters, type McpLimiters } from '../rate-limit';
import { registerProposeTools } from './propose';

function fake() {
  const proposals: Array<{ tool: string; args: unknown }> = [];
  const audits: Array<{ action: string; details: Record<string, unknown> }> = [];
  const platform = {
    market: {
      audit: { record: async (e: { action: string; details: Record<string, unknown> }) => audits.push(e) },
      proposals: {
        proposeSource: async (input: unknown, actor: unknown, opts: { idempotencyKey: string }) => {
          proposals.push({ tool: 'propose_source', args: { input, actor, opts } });
          return { item: { _id: 'rev_src_1', type: 'source_proposal', status: 'open' }, created: true };
        },
        proposeImport: async (input: unknown, actor: unknown, opts: { idempotencyKey: string }) => {
          proposals.push({ tool: 'import_leads', args: { input, actor, opts } });
          return { item: { _id: 'rev_imp_1', type: 'import_proposal', status: 'open' }, created: true };
        },
      },
    },
  };
  return { platform: platform as unknown as Platform, proposals, audits };
}

async function client(platform: Platform, limiters: McpLimiters = createMcpLimiters()) {
  const server = new McpServer({ name: 't', version: '0' });
  registerProposeTools(
    server,
    { platform, limiters, logger: { error() {} }, clientIp: 'x' },
    new Map(),
  );
  const [t1, t2] = InMemoryTransport.createLinkedPair();
  await server.connect(t1);
  const c = new Client({ name: 'c', version: '0' });
  await c.connect(t2);
  return c;
}

describe('MCP propose tools', () => {
  it('propose_source creates a review item only', async () => {
    const { platform, proposals } = fake();
    const c = await client(platform);
    const res = await c.callTool({
      name: 'propose_source',
      arguments: {
        source: { key: 'test-src', name: 'Test' },
        idempotencyKey: 'src-key-001',
      },
    });
    expect(res.isError).toBeFalsy();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].tool).toBe('propose_source');
    const content = JSON.parse((res.content as any)[0].text);
    expect(content.reviewId).toBe('rev_src_1');
    expect(content.created).toBe(true);
  });

  it('import_leads stages a proposal only', async () => {
    const { platform, proposals } = fake();
    const c = await client(platform);
    const res = await c.callTool({
      name: 'import_leads',
      arguments: {
        type: 'companies',
        sourceId: 'test-src',
        contentType: 'text/csv',
        body: 'name,domain\nAcme,acme.com',
        fileName: 'leads.csv',
        idempotencyKey: 'imp-key-001',
      },
    });
    expect(res.isError).toBeFalsy();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].tool).toBe('import_leads');
    const content = JSON.parse((res.content as any)[0].text);
    expect(content.reviewId).toBe('rev_imp_1');
    expect(content.type).toBe('import_proposal');
  });

  it('rate-limits writes', async () => {
    const { platform } = fake();
    const limiters = createMcpLimiters(() => 0);
    // drain the write bucket
    for (let i = 0; i < 10; i++) limiters.write.take();
    const c = await client(platform, limiters);
    const res = await c.callTool({
      name: 'propose_source',
      arguments: { source: { key: 'x' }, idempotencyKey: 'rate-001' },
    });
    expect(res.isError).toBe(true);
  });
});
