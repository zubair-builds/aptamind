import * as cheerio from 'cheerio';
import { z } from 'zod';
import { artifactRefSchema } from '@aptamind/contracts';
import { HttpError, isInScope, type SafeHttpClient } from '@aptamind/net';
import {
  type CapabilityContext,
  defineCapability,
  RetryableError,
  TerminalError,
} from '@aptamind/workflow-sdk';
import { BROWSER, NET_CLIENT } from '../tokens';
import { hostScopeSchema } from './http';

/** Browser Fetch: render a page in headless Chromium (JS-heavy careers pages). */
export const browserFetch = defineCapability({
  type: 'core.browser_fetch',
  version: 1,
  title: 'Browser Fetch',
  description:
    'Renders a page in an isolated headless browser, scoped to allowed hosts, and stores the HTML.',
  category: 'acquisition',
  inputSchema: z.object({ url: z.string().url() }),
  outputSchema: z.object({
    requestedUrl: z.string(),
    finalUrl: z.string(),
    status: z.number().int().nullable(),
    title: z.string(),
    artifact: artifactRefSchema,
    blockedRequests: z.number().int(),
    durationMs: z.number(),
  }),
  configSchema: z.object({
    timeoutMs: z.number().int().positive().max(120_000).default(30_000),
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).default('domcontentloaded'),
    scope: hostScopeSchema.optional(),
    maxHtmlBytes: z
      .number()
      .int()
      .positive()
      .default(10 * 1024 * 1024),
  }),
  execution: {
    retryable: true,
    idempotency: 'pure',
    sideEffects: false,
    queue: 'browser',
    defaultTimeoutMs: 180_000,
  },
  async execute(ctx, input, config) {
    const browser = ctx.services.get(BROWSER);
    if (!browser.available) throw new TerminalError('Browser acquisition is not available in this worker');
    const scope = config.scope ?? { allowedHosts: [new URL(input.url).hostname], allowSubdomains: true };
    const res = await browser.fetch(input.url, { ...config, scope });
    const artifact = await ctx.artifacts.put(res.html, 'text/html', {
      url: res.finalUrl.slice(0, 500),
      via: 'browser',
    });
    return {
      requestedUrl: res.requestedUrl,
      finalUrl: res.finalUrl,
      status: res.status,
      title: res.title,
      artifact,
      blockedRequests: res.blockedRequests,
      durationMs: res.durationMs,
    };
  },
});

export function extractLinks(html: string, baseUrl: string): Array<{ url: string; text: string }> {
  const $ = cheerio.load(html);
  const out: Array<{ url: string; text: string }> = [];
  const seen = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;
    try {
      const u = new URL(href, baseUrl);
      u.hash = '';
      if (!/^https?:$/.test(u.protocol)) return;
      const key = u.href;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ url: key, text: $(el).text().replace(/\s+/g, ' ').trim().slice(0, 200) });
    } catch {
      /* ignore malformed hrefs */
    }
  });
  return out;
}

async function fetchPage(
  ctx: CapabilityContext,
  http: SafeHttpClient,
  url: string,
  config: { useBrowser: boolean; timeoutMs: number; scope: z.infer<typeof hostScopeSchema> },
): Promise<{ finalUrl: string; status: number | null; html: string }> {
  if (config.useBrowser) {
    const r = await ctx.services.get(BROWSER).fetch(url, {
      timeoutMs: config.timeoutMs,
      waitUntil: 'domcontentloaded',
      scope: config.scope,
      maxHtmlBytes: 5 * 1024 * 1024,
    });
    return { finalUrl: r.finalUrl, status: r.status, html: r.html };
  }
  const r = await http.request({
    url,
    timeoutMs: config.timeoutMs,
    scope: config.scope,
    maxBytes: 5 * 1024 * 1024,
    signal: ctx.signal,
  });
  const html = /html|xml|text/.test(r.contentType) ? new TextDecoder().decode(r.body) : '';
  return { finalUrl: r.url, status: r.status, html };
}

/**
 * Bounded crawl within a host scope: breadth-first, limited by pages and depth, optional
 * URL pattern filter. Every page is stored as an artifact for later re-processing.
 */
export const browserCrawl = defineCapability({
  type: 'core.browser_crawl',
  version: 1,
  title: 'Browser Crawl (bounded)',
  description: 'Breadth-first crawl constrained by host scope, max pages, max depth and a URL pattern.',
  category: 'acquisition',
  inputSchema: z.object({ startUrl: z.string().url() }),
  outputSchema: z.object({
    pages: z.array(
      z.object({
        url: z.string(),
        depth: z.number().int(),
        status: z.number().int().nullable(),
        artifact: artifactRefSchema.optional(),
        matched: z.boolean(),
        error: z.string().optional(),
      }),
    ),
    truncated: z.boolean(),
  }),
  configSchema: z.object({
    scope: hostScopeSchema.optional(),
    maxPages: z.number().int().min(1).max(500).default(25),
    maxDepth: z.number().int().min(0).max(5).default(2),
    /** Only follow/record URLs matching this pattern (plain substring list; no regex evaluation of page content). */
    followPatterns: z.array(z.string()).default([]),
    /** Pages whose URL contains any of these substrings are flagged `matched` (e.g. job detail pages). */
    matchPatterns: z.array(z.string()).default([]),
    useBrowser: z.boolean().default(false),
    timeoutMs: z.number().int().positive().max(120_000).default(20_000),
  }),
  execution: {
    retryable: true,
    idempotency: 'pure',
    sideEffects: false,
    queue: 'io',
    defaultTimeoutMs: 15 * 60_000,
  },
  async execute(ctx, input, config) {
    const scope = config.scope ?? { allowedHosts: [new URL(input.startUrl).hostname], allowSubdomains: true };
    const http = ctx.services.get(NET_CLIENT);
    const queue: Array<{ url: string; depth: number }> = [{ url: input.startUrl, depth: 0 }];
    const visited = new Set<string>();
    const pages: Array<{
      url: string;
      depth: number;
      status: number | null;
      artifact?: z.infer<typeof artifactRefSchema>;
      matched: boolean;
      error?: string;
    }> = [];
    const matches = (u: string, pats: string[]) => pats.length === 0 || pats.some((p) => u.includes(p));
    while (queue.length && pages.length < config.maxPages) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      const next = queue.shift() as { url: string; depth: number };
      if (visited.has(next.url)) continue;
      visited.add(next.url);
      if (!isInScope(next.url, scope)) continue;
      try {
        const page = await fetchPage(ctx, http, next.url, {
          useBrowser: config.useBrowser,
          timeoutMs: config.timeoutMs,
          scope,
        });
        const artifact = page.html
          ? await ctx.artifacts.put(page.html, 'text/html', { url: page.finalUrl.slice(0, 500) })
          : undefined;
        pages.push({
          url: page.finalUrl,
          depth: next.depth,
          status: page.status,
          artifact,
          matched:
            config.matchPatterns.length > 0 && config.matchPatterns.some((p) => page.finalUrl.includes(p)),
        });
        if (next.depth < config.maxDepth && page.html) {
          for (const link of extractLinks(page.html, page.finalUrl)) {
            if (
              !visited.has(link.url) &&
              isInScope(link.url, scope) &&
              (matches(link.url, config.followPatterns) || matches(link.url, config.matchPatterns))
            ) {
              queue.push({ url: link.url, depth: next.depth + 1 });
            }
          }
        }
        await ctx.heartbeat();
      } catch (err) {
        if (err instanceof HttpError && err.retryable && pages.length === 0)
          throw new RetryableError(err.message);
        pages.push({
          url: next.url,
          depth: next.depth,
          status: null,
          matched: false,
          error: (err as Error).message,
        });
      }
    }
    return { pages, truncated: queue.length > 0 };
  },
});
