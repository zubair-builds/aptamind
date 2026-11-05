import { describe, expect, it } from 'vitest';
import { loadMcpConfig } from './config';

const TOKEN = 'mcp-token-value-0123456789abcdef';

describe('loadMcpConfig', () => {
  it('is off by default', () => {
    expect(loadMcpConfig({})).toEqual({ enabled: false });
    expect(loadMcpConfig({ MCP_ENABLED: 'false', MCP_TOKEN: 'short' })).toEqual({ enabled: false });
  });

  it('rejects a missing or short token without echoing it', () => {
    expect(() => loadMcpConfig({ MCP_ENABLED: 'true' })).toThrow(/MCP_TOKEN/);

    const short = 'short-token-value';
    let message = '';
    try {
      loadMcpConfig({ MCP_ENABLED: 'true', MCP_TOKEN: short });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/MCP_TOKEN/);
    expect(message).not.toContain(short);
  });

  it('parses the workflow allowlist', () => {
    const cfg = loadMcpConfig({
      MCP_ENABLED: 'true',
      MCP_TOKEN: TOKEN,
      MCP_PORT: '4103',
      MCP_RUN_WORKFLOW_ALLOWLIST: ' market.jobs.verify_due, , professional.x ,',
    });
    expect(cfg).toEqual({
      enabled: true,
      port: 4103,
      token: TOKEN,
      runAllowlist: ['market.jobs.verify_due', 'professional.x'],
    });
    expect(
      loadMcpConfig({ MCP_ENABLED: 'true', MCP_TOKEN: TOKEN, MCP_RUN_WORKFLOW_ALLOWLIST: '' }),
    ).toMatchObject({ runAllowlist: [] });
  });

  it('rejects a port that clashes with the worker metrics port', () => {
    expect(() => loadMcpConfig({ MCP_ENABLED: 'true', MCP_TOKEN: TOKEN }, 4102)).toThrow(/metrics port/);
    expect(() => loadMcpConfig({ MCP_ENABLED: 'true', MCP_TOKEN: TOKEN, MCP_PORT: '9090' }, 9090)).toThrow(
      /9090/,
    );
    const clash = () => loadMcpConfig({ MCP_ENABLED: 'true', MCP_TOKEN: TOKEN, MCP_PORT: '9090' }, 9090);
    let message = '';
    try {
      clash();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain(TOKEN);
  });

  it('rejects an invalid port or enabled flag', () => {
    expect(() => loadMcpConfig({ MCP_ENABLED: 'yes' })).toThrow(/MCP_ENABLED/);
    expect(() => loadMcpConfig({ MCP_ENABLED: 'true', MCP_TOKEN: TOKEN, MCP_PORT: '0' })).toThrow(/MCP_PORT/);
    expect(() => loadMcpConfig({ MCP_ENABLED: 'true', MCP_TOKEN: TOKEN, MCP_PORT: 'nope' })).toThrow(
      /MCP_PORT/,
    );
  });
});
