import { z } from 'zod';
import { artifactRefSchema } from '@aptamind/contracts';
import { HttpError, isRetryableStatus } from '@aptamind/net';
import { defineCapability, RetryableError, TerminalError } from '@aptamind/workflow-sdk';
import { NET_CLIENT } from '../tokens';

export const hostScopeSchema = z.object({
  allowedHosts: z.array(z.string()).min(1),
  allowSubdomains: z.boolean().default(true),
});

/**
 * HTTP Request / Download. All requests go through the SSRF-safe client (URL validation,
 * private-network blocking, redirect re-validation, size/time limits, per-host politeness).
 * Response bodies are stored as content-addressed artifacts rather than inline state.
 */
export const httpRequest = defineCapability({
  type: 'core.http_request',
  version: 1,
  title: 'HTTP Request / Download',
  description: 'Fetches a URL safely and stores the response body as an artifact.',
  category: 'acquisition',
  inputSchema: z.object({
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  outputSchema: z.object({
    url: z.string(),
    requestedUrl: z.string(),
    status: z.number().int(),
    contentType: z.string(),
    size: z.number().int(),
    artifact: artifactRefSchema.optional(),
    text: z.string().optional(),
    fetchedAt: z.string(),
    durationMs: z.number(),
    redirects: z.array(z.string()),
  }),
  configSchema: z.object({
    method: z.enum(['GET', 'HEAD']).default('GET'),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(10 * 60_000)
      .optional(),
    maxBytes: z.number().int().positive().optional(),
    storeArtifact: z.boolean().default(true),
    /** Return text inline (only for small textual responses). */
    inlineTextMaxBytes: z
      .number()
      .int()
      .min(0)
      .max(64 * 1024)
      .default(0),
    /** Status codes treated as success; others raise (retryable for 408/429/5xx). */
    acceptStatus: z.array(z.number().int()).default([]),
    scope: hostScopeSchema.optional(),
    mimeTypeOverride: z.string().optional(),
  }),
  execution: {
    retryable: true,
    idempotency: 'pure',
    sideEffects: false,
    queue: 'io',
    defaultTimeoutMs: 5 * 60_000,
  },
  async execute(ctx, input, config) {
    const client = ctx.services.get(NET_CLIENT);
    let res;
    try {
      res = await client.request({
        url: input.url,
        method: config.method,
        headers: input.headers,
        timeoutMs: config.timeoutMs,
        maxBytes: config.maxBytes,
        scope: config.scope,
        signal: ctx.signal,
      });
    } catch (err) {
      if (err instanceof HttpError)
        throw err.retryable ? new RetryableError(err.message) : new TerminalError(err.message);
      throw err;
    }
    const ok = res.ok || config.acceptStatus.includes(res.status);
    if (!ok) {
      const msg = `HTTP ${res.status} fetching ${res.url}`;
      throw isRetryableStatus(res.status)
        ? new RetryableError(msg, { status: res.status })
        : new TerminalError(msg, { status: res.status });
    }
    const mime =
      config.mimeTypeOverride ?? res.contentType.split(';')[0]?.trim() ?? 'application/octet-stream';
    const artifact =
      config.storeArtifact && config.method === 'GET'
        ? await ctx.artifacts.put(res.body, mime, { url: res.url.slice(0, 500) })
        : undefined;
    const textual = /^(text\/|application\/(json|xml|x-ndjson|csv))/.test(mime);
    ctx.log.info('fetched', {
      url: res.url,
      status: res.status,
      size: res.body.byteLength,
      ms: res.durationMs,
    });
    return {
      url: res.url,
      requestedUrl: res.requestedUrl,
      status: res.status,
      contentType: res.contentType,
      size: res.body.byteLength,
      artifact,
      text:
        textual && config.inlineTextMaxBytes > 0 && res.body.byteLength <= config.inlineTextMaxBytes
          ? new TextDecoder().decode(res.body)
          : undefined,
      fetchedAt: res.fetchedAt.toISOString(),
      durationMs: res.durationMs,
      redirects: res.redirects,
    };
  },
});
