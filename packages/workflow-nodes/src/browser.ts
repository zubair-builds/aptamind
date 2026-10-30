import { chromium, type Browser } from 'playwright-core';
import {
  EGRESS_BLOCKED_HEADER,
  type EgressProxyOptions,
  type HostScope,
  isInScope,
  parseAndValidateUrl,
  SafeEgressProxy,
  UnsafeUrlError,
  type UrlPolicy,
} from '@aptamind/net';

export interface BrowserFetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number | null;
  html: string;
  title: string;
  blockedRequests: number;
  durationMs: number;
}

export interface BrowserFetchOptions {
  timeoutMs: number;
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle';
  scope?: HostScope;
  maxHtmlBytes: number;
}

export interface BrowserService {
  readonly available: boolean;
  fetch(url: string, opts: BrowserFetchOptions): Promise<BrowserFetchResult>;
  close(): Promise<void>;
}

/** Chromium could not start with its sandbox; browser acquisition is unavailable. */
export class BrowserUnavailableError extends Error {
  readonly retryable = false;
  constructor(detail: string) {
    super(
      `Headless Chromium could not start with its sandbox enabled (${detail}). Browser acquisition is disabled ` +
        'rather than run unsandboxed: run the worker as a non-root user with user namespaces available, or see ' +
        'docs/runbooks/local-development.md (browser).',
    );
    this.name = 'BrowserUnavailableError';
  }
}

/**
 * Headless Chromium via playwright-core — sandboxed and network-confined.
 *
 * - **Sandbox always on.** Chromium is launched with `chromiumSandbox: true` and never with
 *   `--no-sandbox`. If it cannot sandbox (e.g. running as root, no user namespaces), the launch
 *   fails and the capability reports `BrowserUnavailableError` — it is disabled, not degraded.
 * - **All traffic through the egress proxy.** Chromium's only network path is a loopback
 *   `SafeEgressProxy` (`--proxy-server`, with `<-loopback>` so loopback is not implicitly
 *   bypassed). The proxy validates every navigation, redirect, sub-resource, fetch/XHR,
 *   WebSocket and CONNECT target, resolves hostnames once and connects only to validated public
 *   addresses — the same protection as the HTTP client, including against DNS rebinding.
 *   Non-proxied UDP (WebRTC) and QUIC are disabled.
 * - **Defence in depth.** Each intercepted request is also checked against the URL policy
 *   (protocol, credentials, blocked names, private IP literals) and top-level navigations must
 *   stay inside the host scope; a main document refused by the proxy fails the fetch.
 */
/**
 * The security-relevant Chromium launch options (audit B-4): OS sandbox on (Playwright's default
 * `--no-sandbox` is removed and never added back), all traffic through the egress proxy with no
 * implicit loopback bypass, and no non-proxied UDP (WebRTC) or QUIC. Exported so the policy can
 * be asserted on every platform.
 */
export function BROWSER_LAUNCH_POLICY(proxy: string) {
  return {
    headless: true,
    chromiumSandbox: true,
    args: [
      `--proxy-server=${proxy}`,
      '--proxy-bypass-list=<-loopback>',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--disable-quic',
      '--disable-background-networking',
    ],
    ignoreDefaultArgs: ['--no-sandbox'],
  };
}

export class PlaywrightBrowserService implements BrowserService {
  private browser: Promise<Browser> | null = null;
  readonly egress: SafeEgressProxy;

  constructor(
    private readonly opts: {
      executablePath: string | undefined;
      userAgent: string;
      policy: UrlPolicy;
      /** Resolver/connector overrides for the egress proxy (tests). */
      egress?: Pick<EgressProxyOptions, 'resolve' | 'connect'>;
    },
  ) {
    this.egress = new SafeEgressProxy({ ...opts.policy, ...opts.egress });
  }

  get available(): boolean {
    return !!this.opts.executablePath;
  }

  private getBrowser(): Promise<Browser> {
    if (!this.opts.executablePath)
      throw new Error('No browser executable configured (BROWSER_EXECUTABLE_PATH)');
    const executablePath = this.opts.executablePath;
    this.browser ??= (async () => {
      const proxy = await this.egress.start();
      try {
        return await chromium.launch({ executablePath, ...BROWSER_LAUNCH_POLICY(proxy) });
      } catch (err) {
        await this.egress.close();
        const msg = (err as Error).message;
        const detail = /as root without --no-sandbox/.test(msg)
          ? 'running as root'
          : /No usable sandbox|namespace|setuid/i.test(msg)
            ? 'no usable sandbox (user namespaces / setuid sandbox unavailable)'
            : (msg.split('\n')[0] ?? 'launch failed');
        throw new BrowserUnavailableError(detail);
      }
    })();
    this.browser.catch(() => {
      this.browser = null;
    });
    return this.browser;
  }

  async fetch(url: string, o: BrowserFetchOptions): Promise<BrowserFetchResult> {
    const started = Date.now();
    parseAndValidateUrl(url, this.opts.policy);
    if (o.scope && !isInScope(url, o.scope)) throw new Error(`URL ${url} is outside the crawl scope`);
    const browser = await this.getBrowser();
    const blockedBefore = this.egress.blocked.length;
    const context = await browser.newContext({
      userAgent: this.opts.userAgent,
      javaScriptEnabled: true,
      acceptDownloads: false,
      serviceWorkers: 'block',
    });
    let blocked = 0;
    try {
      await context.route('**/*', async (route) => {
        const req = route.request();
        try {
          const u = parseAndValidateUrl(req.url(), this.opts.policy);
          if (
            req.isNavigationRequest() &&
            req.frame() === page.mainFrame() &&
            o.scope &&
            !isInScope(u, o.scope)
          ) {
            blocked += 1;
            return route.abort('blockedbyclient');
          }
          if (['media', 'font', 'image'].includes(req.resourceType())) return route.abort('blockedbyclient');
          return route.continue();
        } catch {
          blocked += 1;
          return route.abort('blockedbyclient');
        }
      });
      const page = await context.newPage();
      let response: Awaited<ReturnType<typeof page.goto>>;
      try {
        response = await page.goto(url, { timeout: o.timeoutMs, waitUntil: o.waitUntil });
      } catch (err) {
        if (this.egress.blocked.length > blockedBefore) {
          throw new UnsafeUrlError(`Navigation to ${url} was refused by the egress policy`, {
            refused: this.egress.blocked.slice(blockedBefore).map((d) => `${d.target}: ${d.reason}`),
          });
        }
        throw err;
      }
      // A plain-HTTP main document refused by the proxy arrives as the proxy's 403: fail, don't
      // return it as page content.
      if (response && (await response.headerValue(EGRESS_BLOCKED_HEADER))) {
        throw new UnsafeUrlError(`Navigation to ${url} was refused by the egress policy`, {
          finalUrl: response.url(),
          refused: this.egress.blocked.slice(blockedBefore).map((d) => `${d.target}: ${d.reason}`),
        });
      }
      const html = await page.content();
      if (Buffer.byteLength(html) > o.maxHtmlBytes)
        throw new Error(`Rendered HTML exceeds ${o.maxHtmlBytes} bytes`);
      return {
        requestedUrl: url,
        finalUrl: page.url(),
        status: response?.status() ?? null,
        html,
        title: await page.title(),
        // Egress refusals are counted process-wide; under concurrency this is approximate.
        blockedRequests: blocked + (this.egress.blocked.length - blockedBefore),
        durationMs: Date.now() - started,
      };
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    if (this.browser) await (await this.browser.catch(() => null))?.close();
    this.browser = null;
    await this.egress.close();
  }
}

export class UnavailableBrowserService implements BrowserService {
  readonly available = false;
  async fetch(): Promise<BrowserFetchResult> {
    throw new Error('Browser acquisition is not available in this process');
  }
  async close(): Promise<void> {}
}
