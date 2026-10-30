import { z } from 'zod';
import { jsonObjectSchema, jsonValueSchema } from '@aptamind/contracts';

/**
 * Code/config-authored workflow specification. Registering a spec whose content differs
 * from the latest version creates a new immutable WorkflowVersion.
 *
 * Node inputs are templates: any object of the form `{ "$ref": "<path>" }` is replaced at
 * execution time. Supported roots:
 *   - `run.input[.path]`          workflow run input
 *   - `run.labels[.path]`         run labels
 *   - `trigger[.path]`            trigger metadata
 *   - `nodes.<nodeId>.output[.path]` output of a completed upstream node
 *   - `item[.path]`, `itemIndex`  current element inside a for-each body
 * A `$ref` may carry `"default": <json>` used when the path resolves to undefined.
 * No expression language / code evaluation is supported by design.
 */

export const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(20).default(3),
  backoffMs: z.number().int().min(0).default(2_000),
  maxBackoffMs: z
    .number()
    .int()
    .min(0)
    .default(5 * 60_000),
});
export type RetryPolicy = z.infer<typeof retryPolicySchema>;

export const nodeSpecSchema = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  title: z.string().optional(),
  capability: z.object({ type: z.string(), version: z.number().int().positive() }),
  config: jsonObjectSchema.default({}),
  input: jsonValueSchema.optional(),
  retry: retryPolicySchema.partial().optional(),
  timeoutMs: z.number().int().positive().optional(),
});
export type WorkflowNodeSpec = z.input<typeof nodeSpecSchema>;

export const edgeSpecSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** Edge is active only when the upstream output's `branch` equals this value. */
  when: z.object({ branch: z.string() }).optional(),
});
export type WorkflowEdgeSpec = z.infer<typeof edgeSpecSchema>;

export const scheduleSpecSchema = z
  .object({
    cron: z.string().optional(),
    intervalMinutes: z.number().int().positive().optional(),
    timezone: z.string().default('UTC'),
    input: jsonObjectSchema.default({}),
    enabled: z.boolean().default(false),
  })
  .refine((s) => !!s.cron !== !!s.intervalMinutes, {
    message: 'Exactly one of cron or intervalMinutes is required',
  });

export const workflowSpecSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_.-]{2,127}$/),
  title: z.string(),
  description: z.string().default(''),
  nodes: z.array(nodeSpecSchema).min(1),
  edges: z.array(edgeSpecSchema).default([]),
  /** JSON Schema (draft 2020-12) of the run input, for documentation and validation. */
  inputSchema: jsonObjectSchema.optional(),
  /** Node whose output becomes the run output. Defaults to the single sink node, if any. */
  outputNode: z.string().optional(),
  labels: z.record(z.string(), z.string()).default({}),
  defaultSchedule: scheduleSpecSchema.optional(),
});
export type WorkflowSpec = z.input<typeof workflowSpecSchema>;
export type ParsedWorkflowSpec = z.output<typeof workflowSpecSchema>;

export function ref(path: string, defaultValue?: unknown): { $ref: string; default?: unknown } {
  return defaultValue === undefined ? { $ref: path } : { $ref: path, default: defaultValue };
}

export function defineWorkflow(spec: WorkflowSpec): WorkflowSpec {
  return spec;
}
