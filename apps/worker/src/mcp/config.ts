import { z } from 'zod';

/**
 * Worker MCP listener settings. Disabled unless `MCP_ENABLED=true`. The bearer token is
 * required only when the listener is on, and it is never copied into an error message.
 */
export type McpConfig =
  { enabled: false } | { enabled: true; port: number; token: string; runAllowlist: string[] };

const enabledSchema = z.enum(['true', 'false']);
const portSchema = z.coerce.number().int().min(1).max(65535);
const allowlistSchema = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );

const TOKEN_MIN = 32;

function parseEnabled(raw: string | undefined): boolean {
  if (raw === undefined || raw === '') return false;
  const parsed = enabledSchema.safeParse(raw);
  if (!parsed.success) throw new Error('MCP_ENABLED must be "true" or "false"');
  return parsed.data === 'true';
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 4102;
  const parsed = portSchema.safeParse(raw.trim());
  if (!parsed.success) throw new Error('MCP_PORT must be an integer between 1 and 65535');
  return parsed.data;
}

function parseToken(raw: string | undefined): string {
  if (typeof raw !== 'string' || raw.length < TOKEN_MIN) {
    throw new Error(`MCP_TOKEN is required and must be at least ${TOKEN_MIN} characters when MCP is enabled`);
  }
  return raw;
}

/** Parse MCP_* env vars. `metricsPort` is the worker health port; the listener must not share it. */
export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env, metricsPort?: number): McpConfig {
  const enabled = parseEnabled(env.MCP_ENABLED);
  if (!enabled) return { enabled: false };

  const port = parsePort(env.MCP_PORT);
  if (typeof metricsPort === 'number' && Number.isFinite(metricsPort) && port === metricsPort) {
    throw new Error(`MCP_PORT ${port} must not equal the worker metrics port`);
  }
  return {
    enabled: true,
    port,
    token: parseToken(env.MCP_TOKEN),
    runAllowlist: allowlistSchema.parse(env.MCP_RUN_WORKFLOW_ALLOWLIST),
  };
}
