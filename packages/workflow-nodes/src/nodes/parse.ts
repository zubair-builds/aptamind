import { parse as parseCsv } from 'csv-parse/sync';
import { z } from 'zod';
import { artifactRefSchema, jsonValueSchema } from '@aptamind/contracts';
import { defineCapability, recordSetSchema, TerminalError } from '@aptamind/workflow-sdk';
import { getPath } from './paths';

const textSource = z
  .object({ artifact: artifactRefSchema.optional(), text: z.string().optional() })
  .refine((s) => !!s.artifact !== (s.text !== undefined), {
    message: 'Provide exactly one of artifact or text',
  });

/** Parse CSV into a record set. Malformed rows are reported, not silently dropped. */
export const parseCsvCapability = defineCapability({
  type: 'core.parse_csv',
  version: 1,
  title: 'Parse CSV',
  description: 'Parses CSV (from an artifact or text) into a JSONL record set keyed by header names.',
  category: 'transform',
  inputSchema: textSource,
  outputSchema: z.object({
    records: recordSetSchema,
    columns: z.array(z.string()),
    rowCount: z.number().int(),
    errors: z.array(z.object({ line: z.number().int(), message: z.string() })),
    truncated: z.boolean(),
  }),
  configSchema: z.object({
    delimiter: z.string().min(1).max(4).optional(),
    trim: z.boolean().default(true),
    maxRows: z.number().int().positive().max(5_000_000).default(1_000_000),
    /** Skip leading lines before the header row (some government exports have preambles). */
    fromLine: z.number().int().min(1).default(1),
  }),
  execution: { retryable: false, idempotency: 'pure', sideEffects: false, defaultTimeoutMs: 10 * 60_000 },
  async execute(ctx, input, config) {
    const text = input.artifact ? await ctx.artifacts.readText(input.artifact) : (input.text as string);
    const errors: Array<{ line: number; message: string }> = [];
    let rows: Array<Record<string, string>>;
    try {
      rows = parseCsv(text.replace(/^\uFEFF/, ''), {
        columns: (header: string[]) => header.map((h) => h.trim()),
        delimiter: config.delimiter,
        trim: config.trim,
        skip_empty_lines: true,
        relax_column_count: true,
        relax_quotes: true,
        from_line: config.fromLine,
        on_record: (record: Record<string, string>, context: { lines: number; error?: Error }) => {
          if (context.error) errors.push({ line: context.lines, message: context.error.message });
          return record;
        },
      }) as Array<Record<string, string>>;
    } catch (err) {
      throw new TerminalError(`CSV could not be parsed: ${(err as Error).message}`);
    }
    const truncated = rows.length > config.maxRows;
    if (truncated) rows = rows.slice(0, config.maxRows);
    const columns = rows[0] ? Object.keys(rows[0]) : [];
    const records = await ctx.records.write(rows, { format: 'csv-rows' });
    ctx.log.info('parsed csv', { rows: rows.length, columns: columns.length, errors: errors.length });
    return { records, columns, rowCount: rows.length, errors: errors.slice(0, 100), truncated };
  },
});

/** Parse JSON, optionally selecting an array at a path and emitting it as a record set. */
export const parseJsonCapability = defineCapability({
  type: 'core.parse_json',
  version: 1,
  title: 'Parse JSON',
  description:
    'Parses JSON from an artifact or text. With `recordsPath`, emits the array at that path as a record set.',
  category: 'transform',
  inputSchema: textSource,
  outputSchema: z.object({
    value: jsonValueSchema.optional(),
    records: recordSetSchema.optional(),
    count: z.number().int().optional(),
  }),
  configSchema: z.object({
    recordsPath: z.string().optional(),
    maxInlineBytes: z
      .number()
      .int()
      .min(0)
      .max(64 * 1024)
      .default(16 * 1024),
  }),
  execution: { retryable: false, idempotency: 'pure', sideEffects: false },
  async execute(ctx, input, config) {
    const text = input.artifact ? await ctx.artifacts.readText(input.artifact) : (input.text as string);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (err) {
      throw new TerminalError(`Invalid JSON: ${(err as Error).message}`);
    }
    if (config.recordsPath !== undefined) {
      const arr = getPath(value, config.recordsPath);
      if (!Array.isArray(arr)) throw new TerminalError(`Path "${config.recordsPath}" is not an array`);
      const records = await ctx.records.write(arr);
      return { records, count: arr.length };
    }
    if (text.length > config.maxInlineBytes) {
      throw new TerminalError(
        'JSON too large to return inline; set recordsPath or load it downstream from the artifact',
      );
    }
    return { value: value as z.infer<typeof jsonValueSchema> };
  },
});
