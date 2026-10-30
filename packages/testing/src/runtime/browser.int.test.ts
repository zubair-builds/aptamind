import net from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnsafeUrlError } from '@aptamind/net';
import {
  BROWSER,
  BROWSER_LAUNCH_POLICY,
  BrowserUnavailableError,
  PlaywrightBrowserService,
} from '@aptamind/workflow-nodes';
import {
  createTestInfra,
  createTestRuntime,
  startFixtureServer,
  type TestInfra,
  waitFor,
  waitForRun,
} from '../index';

/**
 * Real, sandboxed headless Chromium (audit B-4). Never skipped: CI installs Chromium, and a
 * missing browser fails this suite. BROWSER_EXECUTABLE_PATH is Chromium itself for a non-root
 * process, or scripts/chromium-unprivileged.sh (with CHROMIUM_BIN) when the tests run as root.
 */
const executablePath = process.env.BROWSER_EXECUTABLE_PATH;

describe('browser configuration', () => {
  it('a browser is configured for this suite (it is not skippable)', () => {
    expect(
      executablePath,
      'set BROWSER_EXECUTABLE_PATH (see docs/runbooks/local-development.md)',
    ).toBeTruthy();
  });

  it('Chromium is never started unsandboxed: as root it is refused, as a normal user it runs sandboxed', async () => {
    const root = process.getuid?.() === 0;
    // As root, the raw binary (without the privilege-dropping wrapper) must be refused rather
    // than started with --no-sandbox. As a normal user, the same binary starts sandboxed.
    const binary = root ? process.env.CHROMIUM_BIN : executablePath;
    expect(
      binary,
      root ? 'as root, set CHROMIUM_BIN to the raw Chromium binary' : 'set BROWSER_EXECUTABLE_PATH',
    ).toBeTruthy();
    const raw = new PlaywrightBrowserService({
      executablePath: binary,
      userAgent: 'aptamind-test',
      policy: { allowPrivateNetwork: true },
    });
    const page = await startFixtureServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><title>raw</title></head></html>');
    });
    try {
      if (root) {
        await expect(raw.fetch(`${page.url}/`, fetchOpts)).rejects.toBeInstanceOf(BrowserUnavailableError);
      } else {
        expect((await raw.fetch(`${page.url}/`, fetchOpts)).title).toBe('raw');
      }
    } finally {
      await raw.close();
      await page.close();
    }
  }, 60_000);
});

const fetchOpts = { timeoutMs: 20_000, waitUntil: 'load' as const, maxHtmlBytes: 5_000_000 };

describe('core.browser_fetch with headless Chromium', () => {
  let infra: TestInfra;
  let runtime: ReturnType<typeof createTestRuntime>;
  let browser: PlaywrightBrowserService;
  let server: Awaited<ReturnType<typeof startFixtureServer>>;
  let host: ReturnType<typeof runtime.createWorkerHost>;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));

  beforeAll(async () => {
    infra = await createTestInfra('browser');
    runtime = createTestRuntime(infra);
    browser = new PlaywrightBrowserService({
      executablePath,
      userAgent: 'aptamind-test',
      policy: { allowPrivateNetwork: true },
    });
    runtime.services.register(BROWSER, browser);
    server = await startFixtureServer((req, res) => {
      if (req.url === '/held.js') {
        // Keeps the page loading (and its renderer alive) until the test releases it.
        void held.then(() => res.writeHead(200, { 'content-type': 'text/javascript' }).end('1;'));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      if (req.url === '/held') {
        res.end('<html><head><title>held</title><script src="/held.js"></script></head><body></body></html>');
      } else if (req.url === '/jobs') {
        // Content rendered by JavaScript: only a real browser sees the job title.
        res.end(`<html><head><title>Jobs</title></head><body><div id="app"></div>
          <script>document.getElementById('app').innerHTML = '<h1>Senior Platform Engineer</h1>';</script>
          <img src="https://tracker.example.invalid/pixel.gif"></body></html>`);
      } else res.end('<html><body>home</body></html>');
    });
    await runtime.catalog.register({
      key: 'test.browser',
      title: 'browser',
      nodes: [
        {
          id: 'start',
          capability: { type: 'core.manual_trigger', version: 1 },
          input: { payload: { $ref: 'run.input' } },
        },
        {
          id: 'fetch',
          capability: { type: 'core.browser_fetch', version: 1 },
          input: { url: { $ref: 'nodes.start.output.payload.url' } },
        },
      ],
      edges: [{ from: 'start', to: 'fetch' }],
    });
    host = runtime.createWorkerHost({
      workerId: 'browser-test',
      schedulerEnabled: false,
      sweeperIntervalMs: 1000,
    });
    host.start();
  });

  afterAll(async () => {
    await host?.stop();
    await browser?.close();
    await server?.close();
    await runtime?.http.close();
    await infra?.cleanup();
  });

  it('renders JavaScript through the sandboxed browser and stores the HTML as an artifact', async () => {
    const run = await runtime.engine.startRun({
      workflowKey: 'test.browser',
      input: { url: `${server.url}/jobs` },
      trigger: { kind: 'manual' },
    });
    const done = await waitForRun(runtime.engine, run._id, undefined, 60_000);
    expect(done.state).toBe('COMPLETED');
    const out = done.output as { artifact: { artifactId: string }; title: string; status: number };
    expect(out.status).toBe(200);
    expect(out.title).toBe('Jobs');
    const html = await infra.artifacts.readText(out.artifact);
    expect(html).toContain('<h1>Senior Platform Engineer</h1>');
    // All traffic went through the egress proxy.
    expect(browser.egress.decisions.some((d) => d.allowed && d.target.includes('127.0.0.1'))).toBe(true);
  }, 90_000);

  it('the browser runs sandboxed behind the egress proxy (live process check on Linux)', async () => {
    // The launch policy itself, on every platform.
    const policy = BROWSER_LAUNCH_POLICY('http://127.0.0.1:1');
    expect(policy.chromiumSandbox).toBe(true);
    expect(policy.ignoreDefaultArgs).toContain('--no-sandbox');
    expect(policy.args).not.toContain('--no-sandbox');
    expect(policy.args).toEqual(
      expect.arrayContaining([
        '--proxy-server=http://127.0.0.1:1',
        '--proxy-bypass-list=<-loopback>',
        '--disable-quic',
      ]),
    );

    // A page held open, so the renderer is alive while it is inspected. Whatever happens below,
    // the page is released and the fetch settled before the test ends (clean teardown).
    const fetching = browser.fetch(`${server.url}/held`, fetchOpts);
    fetching.catch(() => undefined);
    try {
      // The page is loading and has requested its held script: the renderer is alive.
      await waitFor(async () => server.hits.includes('/held.js'), { timeoutMs: 20_000 });
      if (process.platform === 'linux') {
        // Linux (CI): the live renderer processes must run under a seccomp-bpf filter and never
        // with --no-sandbox. Inspected via /proc for any user (root via the wrapper, or non-root).
        let renderers: Renderer[] = [];
        for (let i = 0; i < 100 && renderers.length === 0; i++) {
          await new Promise((r) => setTimeout(r, 100));
          renderers = chromiumRenderers();
        }
        expect(renderers.length).toBeGreaterThan(0);
        for (const r of renderers) {
          expect(r.cmdline).not.toContain('--no-sandbox');
          expect(r.seccomp, `renderer ${r.pid} must run under a seccomp-bpf filter`).toBe('2');
        }
      } else {
        // The live seccomp inspection is Linux-specific (unsupported here, not skipped): the
        // launch policy above is asserted, and the held page's traffic went through the proxy.
        expect(browser.egress.decisions.some((d) => d.allowed && d.target.includes('127.0.0.1'))).toBe(true);
      }
    } finally {
      release();
      await fetching.catch(() => undefined);
    }
    expect((await fetching).title).toBe('held');
  }, 60_000);
});

interface Renderer {
  pid: string;
  cmdline: string;
  seccomp: string | undefined;
}

function chromiumRenderers(): Renderer[] {
  const renderers: Renderer[] = [];
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    let cmdline: string;
    let status: string;
    try {
      // Chromium rewrites its process title, so the arguments may all be in argv[0].
      cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
      const executable = cmdline.split(' ')[0] ?? '';
      if (!/(?:^|\/)(?:chrome|chromium|headless_shell)$/.test(executable)) continue;
      status = readFileSync(`/proc/${pid}/status`, 'utf8');
    } catch {
      continue; // exited meanwhile
    }
    if (!cmdline.includes('--type=renderer')) continue;
    renderers.push({ pid, cmdline, seccomp: /^Seccomp:\s+(\d)/m.exec(status)?.[1] });
  }
  return renderers;
}

describe('browser SSRF protection (production policy: private networking disallowed)', () => {
  const PUBLIC_IP = '93.184.215.14'; // a public address; never actually contacted
  let server: Awaited<ReturnType<typeof startFixtureServer>>;
  let browser: PlaywrightBrowserService;
  const connectedTo: string[] = [];
  let rebindLookups = 0;
  const secretHits = () => server.hits.filter((h) => h.startsWith('/secret')).length;

  beforeAll(async () => {
    server = await startFixtureServer((req, res) => {
      const port = (server.url.split(':').pop() ?? '').replace('/', '');
      if (req.url === '/ok') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<html><head><title>OK</title></head><body><p id="p">public page</p>
          <script>
            // Sub-resources towards private targets (by name and by address).
            fetch('http://evil.test/secret-subresource').catch(() => {});
            fetch('http://127.0.0.1:${port}/secret-literal').catch(() => {});
            fetch('https://evil.test/secret-tls').catch(() => {});
            new WebSocket('ws://evil.test/secret-ws');
          </script></body></html>`);
      } else if (req.url === '/redirect-private') {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/secret-redirect` }).end();
      } else if (req.url === '/redirect-metadata') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
      } else if (req.url === '/redirect-name') {
        res.writeHead(302, { location: 'http://internal.test/secret-redirect-name' }).end();
      } else if (req.url === '/rebind') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<html><head><title>Rebind</title></head><body><script>
          fetch('http://rebind.test/secret-rebind').then((r) => document.title = r.ok ? 'LEAKED' : 'Blocked').catch(() => document.title = 'Blocked');
        </script></body></html>`);
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('SECRET');
      }
    });
    browser = new PlaywrightBrowserService({
      executablePath,
      userAgent: 'aptamind-test',
      policy: { allowPrivateNetwork: false },
      egress: {
        // Test DNS: public names map to a public IP; attacker names map to private ones.
        async resolve(hostname) {
          const map: Record<string, string[]> = {
            'allowed.test': [PUBLIC_IP],
            'evil.test': ['127.0.0.1'],
            'internal.test': ['10.0.0.5'],
            'mixed.test': [PUBLIC_IP, '192.168.1.20'],
          };
          if (hostname === 'rebind.test') {
            // DNS rebinding: public for the page, private afterwards.
            rebindLookups += 1;
            return [{ address: rebindLookups === 1 ? PUBLIC_IP : '127.0.0.1', family: 4 }];
          }
          const hit = map[hostname];
          if (!hit) throw new Error(`ENOTFOUND ${hostname}`);
          return hit.map((address) => ({ address, family: net.isIP(address) }));
        },
        // The public address is served by the local fixture server; anything else is recorded.
        connect(address, port) {
          connectedTo.push(address);
          const target =
            address === PUBLIC_IP
              ? { host: '127.0.0.1', port: Number(server.url.split(':').pop()) }
              : { host: address, port };
          return net.connect(target);
        },
      },
    });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it('allows a public URL', async () => {
    const r = await browser.fetch('http://allowed.test/ok', { ...fetchOpts, waitUntil: 'load' });
    expect(r).toMatchObject({ status: 200, title: 'OK' });
    expect(r.html).toContain('public page');
  }, 60_000);

  it.each([
    ['localhost', 'http://localhost/secret'],
    ['127.0.0.1', 'http://127.0.0.1/secret'],
    ['::1', 'http://[::1]/secret'],
    ['RFC 1918 (10/8)', 'http://10.0.0.1/secret'],
    ['RFC 1918 (192.168/16)', 'http://192.168.1.10/secret'],
    ['link-local', 'http://169.254.1.1/secret'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/secret'],
    ['file protocol', 'file:///etc/passwd'],
  ])('refuses %s before any navigation', async (_label, url) => {
    await expect(browser.fetch(url, fetchOpts)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('refuses a public hostname that resolves to a private address (and one with any private address)', async () => {
    await expect(browser.fetch('http://evil.test/secret-name', fetchOpts)).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
    await expect(browser.fetch('http://mixed.test/secret-mixed', fetchOpts)).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
    await expect(browser.fetch('https://internal.test/secret-tls', fetchOpts)).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  }, 60_000);

  it.each([
    ['a private address', '/redirect-private'],
    ['cloud metadata', '/redirect-metadata'],
    ['a name resolving privately', '/redirect-name'],
  ])(
    'refuses a redirect from a public page to %s',
    async (_label, path) => {
      await expect(browser.fetch(`http://allowed.test${path}`, fetchOpts)).rejects.toBeInstanceOf(
        UnsafeUrlError,
      );
    },
    60_000,
  );

  it('refuses private sub-resources, TLS tunnels and WebSockets of an allowed page', async () => {
    const before = browser.egress.blocked.length;
    const r = await browser.fetch('http://allowed.test/ok', { ...fetchOpts, waitUntil: 'networkidle' });
    expect(r.title).toBe('OK');
    const refused = browser.egress.blocked.slice(before).map((d) => d.target);
    expect(refused).toEqual(expect.arrayContaining(['http://evil.test:80', 'https://evil.test:443']));
  }, 60_000);

  it('defeats DNS rebinding: a host that re-resolves to a private address is refused', async () => {
    const r = await browser.fetch('http://rebind.test/rebind', { ...fetchOpts, waitUntil: 'networkidle' });
    expect(r.title).toBe('Blocked');
    expect(rebindLookups).toBeGreaterThanOrEqual(2);
    // The page itself was fetched from the public address; the rebound request was refused.
    const rebind = browser.egress.decisions.filter((d) => d.target === 'http://rebind.test:80');
    expect(rebind[0]).toMatchObject({ allowed: true, address: PUBLIC_IP });
    expect(rebind.some((d) => !d.allowed && /non-public address 127\.0\.0\.1/.test(d.reason ?? ''))).toBe(
      true,
    );
  }, 60_000);

  it('never connected to, or served, a private target', () => {
    expect(secretHits()).toBe(0);
    expect(connectedTo.every((a) => a === PUBLIC_IP)).toBe(true);
    expect(browser.egress.blocked.length).toBeGreaterThan(5);
  });
});
