/**
 * Admin route smoke (`pnpm test:admin-e2e`).
 *
 * Boots migrate → worker → api → admin on a throwaway stack isolated from anything else using the
 * shared infrastructure (own MongoDB database, queue prefix, S3 bucket and free ports), seeds
 * `seed:dev --demo`, waits for the demo runs to settle, then visits every admin route in Chromium
 * and asserts by role/name, HTTP status and a clean console. Everything is torn down afterwards
 * (processes, database, queue keys, bucket).
 *
 *   pnpm infra:up && pnpm build && pnpm test:admin-e2e
 *
 * Env: BROWSER_EXECUTABLE_PATH (Chromium; defaults to the playwright-core install),
 * ADMIN_E2E_KEEP=1 keeps the stack running after the smoke until Ctrl-C (manual/visual review),
 * ADMIN_E2E_LOG_DIR (process logs; default a temp dir, removed after a clean pass).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { chromium, type Browser, type Page } from 'playwright-core';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const adminDir = path.join(root, 'apps/admin');
const tsx = path.join(root, 'node_modules/.bin/tsx');
const next = path.join(adminDir, 'node_modules/.bin/next');
const logDir = process.env.ADMIN_E2E_LOG_DIR
  ? (mkdirSync(process.env.ADMIN_E2E_LOG_DIR, { recursive: true }), process.env.ADMIN_E2E_LOG_DIR)
  : mkdtempSync(path.join(os.tmpdir(), 'aptamind-admin-e2e-'));
const keep = process.env.ADMIN_E2E_KEEP === '1';

const log = (msg: string) => console.log(`[admin-e2e] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `n` distinct free ports: all sockets stay bound until every port is known, then close. */
async function freePorts(n: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from(
      { length: n },
      () =>
        new Promise<net.Server>((resolve, reject) => {
          const srv = net.createServer();
          srv.on('error', reject);
          srv.listen(0, '127.0.0.1', () => resolve(srv));
        }),
    ),
  );
  const ports = servers.map((srv) => (srv.address() as net.AddressInfo).port);
  await Promise.all(servers.map((srv) => new Promise((r) => srv.close(r))));
  return ports;
}

const withLocalhost = (list: string | undefined) =>
  [...new Set([...(list ?? '').split(','), '127.0.0.1', 'localhost'].filter(Boolean))].join(',');

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const [adminPort] = (await freePorts(1)) as [number];
const adminUrl = `http://127.0.0.1:${adminPort}`;
const apiUrl = adminUrl;

const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'development',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  MONGODB_DB: `t_admin_${runId}`,
  QUEUE_PREFIX: `t_admin_${runId}`,
  S3_BUCKET: `t-admin-${runId}`,
  // Hard-set local storage: exported MVP R2 settings must never reach the e2e run. Override only
  // through TEST_S3_* variables.
  S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
  S3_REGION: process.env.TEST_S3_REGION ?? 'us-east-1',
  S3_ACCESS_KEY_ID: process.env.TEST_S3_ACCESS_KEY_ID ?? 'aptamind',
  S3_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'aptamind-dev-secret',
  S3_FORCE_PATH_STYLE: 'true',
  S3_USE_AWS_DEFAULT_ENDPOINT: 'false',
  API_HOST: '127.0.0.1',
  API_CORS_ORIGINS: adminUrl,
  NEXT_PUBLIC_APP_URL: adminUrl,
  WORKER_METRICS_PORT: '0',
  // No cron triggers: the demo is offline fixtures only, never a live fetch.
  WORKER_SCHEDULER_ENABLED: 'false',
  // Local services must bypass any outbound HTTP proxy.
  NO_PROXY: withLocalhost(process.env.NO_PROXY),
  no_proxy: withLocalhost(process.env.no_proxy),
};

const children: ChildProcess[] = [];

function start(
  name: string,
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const out = createWriteStream(path.join(logDir, `${name}.log`));
  const child = spawn(cmd, args, { cwd: opts.cwd ?? root, env: opts.env ?? env, detached: true });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  children.push(child);
  return child;
}

function logTail(name: string, lines = 40) {
  try {
    return readFileSync(path.join(logDir, `${name}.log`), 'utf8')
      .split('\n')
      .slice(-lines)
      .join('\n');
  } catch {
    return '(no log)';
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals) {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    /* group already gone */
  }
}

/** Resolves with the exit code, or null if the child is still running after `timeoutMs`. */
function exited(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  // A child ended by a signal has no exit code: reported as -1.
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode ?? -1);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

async function runToCompletion(name: string, args: string[], timeoutMs = 180_000) {
  const child = start(name, tsx, args);
  const code = await exited(child, timeoutMs);
  if (code === null) {
    killGroup(child, 'SIGKILL');
    throw new Error(`${name} timed out after ${timeoutMs / 1000}s\n${logTail(name)}`);
  }
  if (code !== 0) throw new Error(`${name} exited with ${code}\n${logTail(name)}`);
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await probe();
      if (v !== undefined) return v;
    } catch (err) {
      last = err;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${String(last)})` : ''}`);
}

async function getJson<T>(url: string): Promise<T | undefined> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  return res.ok ? ((await res.json()) as T) : undefined;
}

/** Waits until the seeded runs exist and none is active for two consecutive polls. */
async function waitForRunsToSettle() {
  let quiet = 0;
  await waitFor(
    'demo runs to settle',
    async () => {
      const s = await getJson<{ runsByState: Record<string, number>; activeRuns: number }>(
        `${apiUrl}/api/runs/stats?hours=1`,
      );
      const total = s ? Object.values(s.runsByState).reduce((a, b) => a + b, 0) : 0;
      quiet = s && total >= 5 && s.activeRuns === 0 ? quiet + 1 : 0;
      return quiet >= 2 ? true : undefined;
    },
    240_000,
  );
}

async function api<T>(method: 'POST' | 'GET', pathname: string, body?: unknown, type = 'application/json') {
  const res = await fetch(`${apiUrl}${pathname}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': type },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${method} ${pathname}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Sole-trader names listed in two towns each: every pair becomes a company_resolution review item. */
const E2E_TRADERS = [
  'Dr A Patel',
  'Dr K Jones',
  'Mr R Singh',
  'Dr M Chen',
  'Mrs S Ahmed',
  'Dr L Brown',
  'Mr T Walker',
  'Dr P Green',
  'Dr H Khan',
  'Mr D Evans',
  'Dr F Wilson',
  'Dr E Taylor',
  'Mr B Hughes',
  'Dr N Shah',
];

/**
 * More list data, through the API only (sources, snapshot upload, runs, review decisions): enough
 * review items (open, resolved, dismissed) and runs (a failed one, a child run) to page at 10.
 * Resolving / failed-decision queue states are transient or need a failing domain effect, which
 * the public API cannot produce on purpose, so they are not seeded.
 */
async function seedLists() {
  const register = (source: Record<string, unknown>) =>
    api<{ source: { _id: string } }>('POST', '/api/sources', {
      freshness: { policyClass: 'source.sponsor_register', maxAgeMinutes: 4320 },
      governance: { accessMethod: 'manual_upload', termsNotes: 'Synthetic e2e fixture' },
      labels: { fixture: 'true' },
      ...source,
    }).then((r) => r.source._id);
  const extra = await register({
    key: 'e2e:sponsor-extract',
    name: 'Sponsor register extract (e2e fixture)',
    category: 'company_universe',
    provider: 'uk_home_office_sponsor_register',
    acquisition: { workflowKey: 'market.uk_sponsor_register.import' },
    authority: { tier: 'official_registry' },
  });
  const csv = [
    '"Organisation Name","Town/City","County","Type & Rating","Route"',
    ...E2E_TRADERS.flatMap((n) => [
      `"${n}","Leeds","West Yorkshire","Worker (A rating)","Skilled Worker"`,
      `"${n}","Bristol","","Worker (A rating)","Skilled Worker"`,
    ]),
  ].join('\n');
  await api('POST', `/api/sources/${extra}/snapshots?process=true`, csv, 'text/csv');
  // A job board without a board token: its refresh fails (TerminalError) — twice.
  const broken = await register({
    key: 'e2e:board-without-token',
    name: 'Board without a token (e2e fixture)',
    category: 'job_source',
    provider: 'greenhouse',
    acquisition: { workflowKey: 'market.ats.refresh' },
    freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 2160 },
    authority: { tier: 'official_ats' },
  });
  for (let i = 0; i < 2; i++) await api('POST', `/api/sources/${broken}/run`, {});
  // The demo directory's no-op workflow, run by hand: more top-level runs of another kind.
  const sources = await api<{ items: { _id: string; key: string }[] }>('GET', '/api/sources?limit=200');
  const directory = sources.items.find((x) => x.key === 'demo:company-directory');
  if (directory) for (let i = 0; i < 2; i++) await api('POST', `/api/sources/${directory._id}/run`, {});
  await waitForRunsToSettle();
  // A batch over one demo company: one child run. The batch only selects companies with a domain
  // (OPS-1), so this is Acme (acme.example). `.example` names never resolve, so no HTTP request leaves.
  const companies = await api<{ items: { _id: string }[] }>(
    'GET',
    '/api/companies?q=acme.example&hasDomain=true&limit=1',
  );
  if (companies.items[0])
    await api('POST', '/api/workflows/market.careers_discovery.batch/runs', {
      input: { companyIds: [companies.items[0]._id], limit: 1 },
    });
  await waitForRunsToSettle();
  // Decide some of the new items: 3 resolved (create new company), 3 dismissed.
  const open = await api<{ items: { _id: string; subject: string }[] }>('GET', '/api/review?limit=100');
  const mine = open.items.filter((r) => E2E_TRADERS.some((n) => r.subject.includes(`"${n}"`)));
  for (const [i, r] of mine.slice(0, 6).entries())
    await api('POST', `/api/review/${r._id}/resolve`, {
      action: i < 3 ? 'create_new' : 'dismiss',
      reason: i < 3 ? 'e2e: a different sole trader' : 'e2e: not actionable',
    });
  const all = await api<{ items: { queueState: string }[] }>('GET', '/api/review?status=all&limit=100');
  const runs = await api<{ items: { state: string; parent?: unknown }[]; total: number }>(
    'GET',
    '/api/runs?all=true&limit=100',
  );
  const states = all.items.reduce<Record<string, number>>(
    (a, r) => ({ ...a, [r.queueState]: (a[r.queueState] ?? 0) + 1 }),
    {},
  );
  const failed = runs.items.filter((r) => r.state === 'FAILED').length;
  const child = runs.items.filter((r) => r.parent).length;
  log(`list seed: review ${JSON.stringify(states)} · runs ${runs.total} (failed ${failed}, child ${child})`);
  if (all.items.length < 12 || runs.total < 12) throw new Error('list seed produced too few rows');
  if (!failed || !child) throw new Error('list seed produced no failed run or no child run');
}

// ---------------------------------------------------------------------------------------- routes

interface Visit {
  path: string;
  /** Accessible name of the page's h1; `undefined` only requires a non-empty h1. */
  heading?: string | RegExp;
  status?: number;
}

const failures: string[] = [];
let visited = 0;
/** Successfully visited page routes, replayed at phone width. */
const pagePaths: string[] = [];

function check(ok: boolean, message: string) {
  if (!ok) failures.push(message);
}

async function visit(page: Page, v: Visit): Promise<string[]> {
  const consoleErrors: string[] = [];
  const onConsole = (m: { type(): string; text(): string }) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  };
  const onPageError = (e: Error) => consoleErrors.push(`pageerror: ${e.message}`);
  // Names the failing subresource: Chromium's console message ("Failed to load resource") omits the URL.
  const failedResources: string[] = [];
  const onResponse = (r: { status(): number; url(): string }) => {
    if (r.status() >= 400) failedResources.push(`${r.status()} ${r.url().replace(adminUrl, '')}`);
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);
  const problems: string[] = [];
  try {
    const res = await page.goto(`${adminUrl}${v.path}`, { waitUntil: 'networkidle', timeout: 60_000 });
    const expected = v.status ?? 200;
    if (res?.status() !== expected) problems.push(`HTTP ${res?.status()} (expected ${expected})`);
    const h1 = page.getByRole('heading', { level: 1, ...(v.heading ? { name: v.heading } : {}) });
    if ((await h1.count()) !== 1 || !(await h1.first().isVisible()))
      problems.push(`expected one visible h1${v.heading ? ` named ${String(v.heading)}` : ''}`);
    else if (!(await h1.first().innerText()).trim()) problems.push('empty h1');
    // Below 1024 px the sidebar is a drawer behind the menu button.
    const narrow = (page.viewportSize()?.width ?? 0) < 1024;
    const nav = narrow
      ? page.getByRole('button', { name: 'Open navigation' })
      : page.getByRole('navigation', { name: 'Main' });
    if (!(await nav.isVisible())) problems.push(narrow ? 'menu button missing' : 'main navigation missing');
    if (!(await page.getByRole('main').isVisible())) problems.push('main landmark missing');
    // The no-auth marker must stay visible on every page and width (ADR-0008).
    if (!(await page.getByRole('link', { name: /Internal · password protected/ }).isVisible()))
      problems.push('"Internal · password protected" chip not visible');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) problems.push(`horizontal scroll of ${overflow}px`);
    // Scoped to <main>: Next's route announcer is a (normally empty) role=alert outside it.
    const alerts = await page.locator('main').getByRole('alert').allInnerTexts();
    if (alerts.length) problems.push(`alert shown: ${alerts.join(' | ').slice(0, 300)}`);
    // A 404 document load is itself reported as a console error by Chromium.
    const errors = expected === 404 ? consoleErrors.filter((e) => !/status of 404/.test(e)) : consoleErrors;
    if (errors.length)
      problems.push(
        `console errors: ${errors.join(' | ').slice(0, 500)}` +
          (failedResources.length ? ` (failed: ${failedResources.join(', ').slice(0, 300)})` : ''),
      );
  } catch (err) {
    problems.push(String(err));
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('response', onResponse);
  }
  visited++;
  const width = page.viewportSize()?.width;
  if (problems.length) failures.push(`${v.path} @${width}px: ${problems.join('; ')}`);
  else if ((v.status ?? 200) === 200 && !pagePaths.includes(v.path)) pagePaths.push(v.path);
  log(`${problems.length ? 'FAIL' : 'ok  '} ${v.path} @${width}px`);
  return page.locator('main a[href^="/"]').evaluateAll((els) => els.map((a) => a.getAttribute('href') ?? ''));
}

function pick(hrefs: string[], pattern: RegExp, what: string): string | undefined {
  const href = hrefs.find((h) => pattern.test(h));
  if (!href) failures.push(`no link to ${what} found (pattern ${pattern})`);
  return href;
}

async function smoke(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const detail = async (hrefs: string[], pattern: RegExp, what: string) => {
    const href = pick(hrefs, pattern, what);
    return href ? visit(page, { path: href }) : [];
  };
  /** Visits records matching `pattern` until one links to `needs` (not every record has one). */
  const detailLinkingTo = async (hrefs: string[], pattern: RegExp, needs: RegExp, what: string) => {
    for (const href of [...new Set(hrefs.filter((h) => pattern.test(h)))].slice(0, 8)) {
      const links = await visit(page, { path: href });
      if (links.some((l) => needs.test(l))) return links;
    }
    failures.push(`no ${what} links to ${needs}`);
    return [];
  };

  await visit(page, { path: '/', heading: 'Home' });

  const sources = await visit(page, { path: '/sources', heading: 'Sources' });
  await visit(page, { path: '/sources/new', heading: 'New source' });
  // `/imports` and `/imports/[id]` need the imports API (OPS-1); add them once it is on main.
  await visit(page, { path: '/imports/new', heading: 'New import' });
  await visit(page, { path: '/imports/new/companies', heading: 'Import companies' });
  await visit(page, { path: '/imports/new/ats-boards', heading: 'Import known ATS boards' });
  await visit(page, { path: '/imports/new/jobs', heading: 'Import job links' });
  await visit(page, { path: '/imports/new/snapshot', heading: 'Import a source snapshot' });
  const source = await detailLinkingTo(sources, /^\/sources\/src_[^/?#]+$/, /^\/snapshots\//, 'source');
  const snapshot = await detail(source, /^\/snapshots\/[^/?#]+$/, 'a snapshot');
  const artifactHref = pick(snapshot, /^\/artifacts\/[^/?#]+/, 'an artifact');
  if (artifactHref) {
    // Raw artifacts are served by a route handler, always as sandboxed text/plain.
    const res = await page.request.get(`${adminUrl}${artifactHref}`);
    const type = res.headers()['content-type'] ?? '';
    const csp = res.headers()['content-security-policy'] ?? '';
    if (res.status() !== 200 || !type.startsWith('text/plain') || !csp.includes('sandbox'))
      failures.push(`${artifactHref}: HTTP ${res.status()}, content-type ${type}, csp ${csp}`);
    visited++;
    log(`ok   ${artifactHref} (route handler)`);
  }

  const workflows = await visit(page, { path: '/workflows', heading: 'Workflows' });
  await detail(workflows, /^\/workflows\/[^/?#]+$/, 'a workflow');

  const runs = await visit(page, { path: '/runs', heading: 'Runs' });
  const run = await detailLinkingTo(runs, /^\/runs\/run_[^/?#]+$/, /^\/node-runs\//, 'run');
  await detail(run, /^\/node-runs\/[^/?#]+$/, 'a node run');

  const companies = await visit(page, { path: '/companies', heading: 'Companies' });
  await detail(companies, /^\/companies\/cmp_[^/?#]+$/, 'a company');

  const jobs = await visit(page, { path: '/jobs', heading: 'Jobs' });
  const job = await detailLinkingTo(jobs, /^\/jobs\/job_[^/?#]+$/, /^\/observations\//, 'job');
  await detail(job, /^\/observations\/[^/?#]+$/, 'an observation');

  const review = await visit(page, { path: '/review', heading: 'Review queue' });
  await detail(review, /^\/review\/rev_[^/?#]+$/, 'a review item');

  await visit(page, { path: '/capabilities', heading: 'Capabilities' });
  await visit(page, { path: '/settings/system', heading: 'System status' });
  await visit(page, { path: '/settings/ui', heading: 'UI catalogue' });
  await visit(page, { path: '/no-such-page', heading: 'Page not found', status: 404 });
  await context.close();

  // Phone width: every page again (no horizontal scroll, drawer trigger, chip visible).
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phonePage = await phone.newPage();
  for (const path of [...pagePaths]) await visit(phonePage, { path });
  await phone.close();
}

/** Shell interactions (UX1): slot reset, collapse + theme cookies, skip link, mobile drawer. */
async function shellChecks(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const url = (p: string) => `${adminUrl}${p}`;
  const nav = page.getByRole('navigation', { name: 'Main' });

  await page.goto(url('/sources'), { waitUntil: 'networkidle' });
  const newSource = page.getByRole('banner').getByRole('link', { name: 'New source' });
  check(await newSource.isVisible(), 'shell: "New source" missing from the top bar on /sources');
  const toggle = page.getByRole('button', { name: 'Collapse sidebar' });
  check(
    (await toggle.evaluate((el) => getComputedStyle(el).borderTopWidth)) === '0px',
    'shell: cascade layer order broken (legacy button styles override CSS Modules)',
  );
  await nav.getByRole('link', { name: /^Jobs/ }).click();
  await page.waitForURL(url('/jobs'));
  check(
    (await nav.getByRole('link', { name: /^Jobs/ }).getAttribute('aria-current')) === 'page',
    'shell: Jobs is not aria-current after navigating',
  );
  check((await newSource.count()) === 0, 'shell: page actions of /sources survived soft navigation');
  check(
    (await page.getByRole('navigation', { name: 'Breadcrumb' }).innerText()).trim() === 'Jobs',
    'shell: breadcrumb for /jobs',
  );

  await toggle.click();
  await page.reload({ waitUntil: 'networkidle' });
  const expand = page.getByRole('button', { name: 'Expand sidebar' });
  check(await expand.isVisible(), 'shell: collapsed sidebar not persisted across reload');
  await expand.click();

  await page.getByRole('radio', { name: 'Dark theme' }).check();
  check((await page.locator('html').getAttribute('data-theme')) === 'dark', 'shell: dark theme not applied');
  const html = await (await page.request.get(url('/jobs'))).text();
  check(/<html[^>]*data-theme="dark"/.test(html), 'shell: theme cookie not rendered server-side');
  await page.getByRole('radio', { name: 'System theme' }).check();
  check(
    (await page.locator('html').getAttribute('data-theme')) === null,
    'shell: system theme keeps data-theme',
  );

  await page.goto(url('/'), { waitUntil: 'networkidle' });
  await page.keyboard.press('Tab');
  check(
    (await page.evaluate(() => document.activeElement?.textContent?.trim())) === 'Skip to content',
    'shell: first Tab does not reach the skip link',
  );
  await page.keyboard.press('Enter');
  check(
    (await page.evaluate(() => document.activeElement?.id)) === 'main',
    'shell: skip link does not focus main',
  );
  await context.close();

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobile = await phone.newPage();
  await mobile.goto(url('/'), { waitUntil: 'networkidle' });
  const menu = mobile.getByRole('button', { name: 'Open navigation' });
  const drawerNav = mobile.getByRole('navigation', { name: 'Main' });
  check(!(await drawerNav.isVisible()), 'drawer: navigation visible before opening');
  await menu.click();
  await drawerNav.waitFor({ state: 'visible' });
  check((await menu.getAttribute('aria-expanded')) === 'true', 'drawer: aria-expanded not true when open');
  check(
    await mobile.getByRole('dialog', { name: 'Navigation' }).isVisible(),
    'drawer: open drawer is not a modal dialog named Navigation',
  );
  await mobile.keyboard.press('Escape');
  await drawerNav.waitFor({ state: 'hidden' });
  check(
    await menu.evaluate((el) => el === document.activeElement),
    'drawer: Esc does not return focus to menu',
  );
  await menu.click();
  await drawerNav.getByRole('link', { name: /^Review/ }).click();
  await mobile.waitForURL(url('/review'));
  await drawerNav.waitFor({ state: 'hidden' });
  check(
    (await mobile.evaluate(() => document.activeElement?.id)) === 'main',
    'drawer: focus not on main after navigating from the drawer',
  );
  await phone.close();
  log('ok   shell interactions (actions slot, collapse, theme, skip link, drawer)');
}

/**
 * Resolves once every finite animation in the page has finished. Dialogs, popovers and menus
 * fade in (opacity 0 → 1 over `--dur`/`--dur-fast`), and axe blends text with its stacking
 * context's *current* opacity: scanned mid-fade, `--text-secondary` on `--bg-surface` (6.4:1 when
 * settled) reads below 4.5:1 at any opacity under ~0.85. `waitFor()` resolves on the first
 * visible frame, so a scan must wait for the entry animation to end. Infinite animations
 * (skeleton shimmer, spinners) never finish and are skipped; a cancelled one counts as done.
 */
async function animationsSettled(page: Page) {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity);
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
  });
}

/** axe on the primitive catalogue (UX2): zero serious/critical violations, incl. open layers. */
async function a11yChecks(browser: Browser) {
  const scan = async (page: Page, what: string) => {
    await animationsSettled(page);
    const { violations, passes } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const bad = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    for (const v of bad)
      failures.push(
        `axe ${what}: ${v.id} (${v.impact}) ${v.help} — ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(' '))
          .join(', ')}`,
      );
    const minor = violations.length - bad.length;
    log(
      `${bad.length ? 'FAIL' : 'ok  '} axe ${what}: ${passes.length} rules passed, ${minor} minor/moderate`,
    );
  };
  for (const [width, scheme] of [
    [1440, 'light'],
    [1440, 'dark'],
    [390, 'light'],
  ] as const) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme });
    const page = await context.newPage();
    await page.goto(`${adminUrl}/settings/ui`, { waitUntil: 'networkidle' });
    await scan(page, `/settings/ui @${width}px ${scheme}`);
    if (width === 1440) {
      await page.getByRole('button', { name: 'Record actions' }).click();
      await page.getByRole('menu', { name: 'Record actions' }).waitFor();
      await scan(page, `menu open ${scheme}`);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Open dialog' }).click();
      await page.getByRole('dialog', { name: 'Disable source?' }).waitFor();
      await scan(page, `dialog open ${scheme}`);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '2 sources' }).click();
      await page.getByRole('dialog', { name: 'Provenance' }).waitFor();
      await scan(page, `popover open ${scheme}`);
    }
    await context.close();
  }

  // UX5: record pages with facts, and FR-23 (fact → observation in two clicks).
  const records = [
    { kind: 'job', pattern: /^\/jobs\/job_/, fact: 'Title' },
    { kind: 'company', pattern: /^\/companies\/cmp_/, fact: 'Display name' },
  ];
  for (const r of records) {
    const path = pagePaths.find((p) => r.pattern.test(p));
    if (!path) {
      failures.push(`a11y: no ${r.kind} page visited`);
      continue;
    }
    for (const [width, scheme] of [
      [1440, 'light'],
      [1440, 'dark'],
      [390, 'light'],
      [390, 'dark'],
    ] as const) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
      });
      const page = await context.newPage();
      await page.goto(`${adminUrl}${path}`, { waitUntil: 'networkidle' });
      await scan(page, `${r.kind} record @${width}px ${scheme}`);
      if (width === 390) {
        await context.close();
        continue;
      }
      await page.getByRole('button', { name: new RegExp(`^\\d+ sources? for ${r.fact}$`) }).click();
      const panel = page.getByRole('dialog', { name: `Provenance: ${r.fact}` });
      await panel.waitFor();
      await scan(page, `${r.kind} provenance popover ${scheme}`);
      if (scheme === 'light') {
        await panel.getByRole('link', { name: 'Observation' }).first().click();
        await page.waitForURL(/\/observations\//);
        const reached = await page
          .getByRole('heading', { level: 1, name: /Observation/ })
          .waitFor({ timeout: 15_000 })
          .then(() => true)
          .catch(() => false);
        check(reached, `FR-23: observation not reached from a ${r.kind} fact in two clicks`);
      }
      await context.close();
    }
  }
}

/**
 * Keyboard behaviour of the floating layers in a real browser (/settings/ui): focus moves into a
 * menu/popover only once it is visible in the top layer, Escape returns it, nested layers close
 * innermost first, and every catalogue link resolves.
 */
async function layerChecks(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${adminUrl}/settings/ui`, { waitUntil: 'networkidle' });
  const active = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      return {
        role: el?.getAttribute('role') ?? el?.tagName.toLowerCase() ?? null,
        name: (el?.getAttribute('aria-label') ?? el?.textContent ?? '').trim(),
        inMenu: !!el?.closest('[role="menu"]'),
        inDialog: !!el?.closest('[role="dialog"]'),
      };
    });
  const expectFocus = async (ok: (a: Awaited<ReturnType<typeof active>>) => boolean, what: string) => {
    const a = await active();
    const pass = ok(a);
    log(`${pass ? 'ok  ' : 'FAIL'} layers: ${what} (focus: ${a.role} "${a.name.slice(0, 30)}")`);
    check(pass, `layers: ${what}; focus on ${a.role} "${a.name.slice(0, 30)}"`);
  };

  const menuButton = page.getByRole('button', { name: 'Record actions' });
  for (const key of ['ArrowDown', 'Enter']) {
    await menuButton.focus();
    await page.keyboard.press(key);
    await page.getByRole('menu', { name: 'Record actions' }).waitFor();
    await expectFocus(
      (a) => a.role === 'menuitem' && a.inMenu,
      `${key} on "Record actions" focuses a menu item`,
    );
    await page.keyboard.press('ArrowDown');
    await expectFocus((a) => a.role === 'menuitem' && a.inMenu, 'ArrowDown moves between menu items');
    await page.keyboard.press('Escape');
    await expectFocus((a) => a.name === 'Record actions', 'Escape closes the menu and returns focus');
    check((await page.getByRole('menu').count()) === 0, 'layers: menu still open after Escape');
  }

  const sources = page.getByRole('button', { name: '2 sources' });
  await sources.click();
  await page.getByRole('dialog', { name: 'Provenance' }).waitFor();
  await expectFocus((a) => a.inDialog, 'clicking "2 sources" moves focus into the popover');
  await page.keyboard.press('Escape');
  await expectFocus((a) => a.name === '2 sources', 'Escape closes the popover and returns focus');

  // Popover inside a modal dialog: Escape closes the popover only, then the dialog.
  await page.getByRole('button', { name: 'Open dialog' }).click();
  const dialog = page.getByRole('dialog', { name: 'Disable source?' });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'What is kept?' }).click();
  await page.getByRole('dialog', { name: 'What is kept' }).waitFor();
  await expectFocus((a) => a.inDialog && a.name !== 'What is kept?', 'nested popover takes focus');
  await page.keyboard.press('Escape');
  const nestedClosed = (await page.getByRole('dialog', { name: 'What is kept' }).count()) === 0;
  const dialogOpen = await dialog.isVisible();
  log(`${nestedClosed && dialogOpen ? 'ok  ' : 'FAIL'} layers: Escape closes only the nested popover`);
  check(
    nestedClosed && dialogOpen,
    'layers: Escape in a popover inside a dialog must close only the popover',
  );
  await expectFocus((a) => a.name === 'What is kept?', 'focus returns to the nested trigger');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  check(!(await dialog.isVisible()), 'layers: second Escape did not close the dialog');
  log(`${(await dialog.isVisible()) ? 'FAIL' : 'ok  '} layers: second Escape closes the dialog`);

  // Every catalogue link resolves (no demo points at a 404).
  const hrefs = await page.$$eval('main a[href^="/"]', (as) => [
    ...new Set(as.map((a) => a.getAttribute('href')!)),
  ]);
  for (const href of hrefs) {
    const res = await fetch(`${adminUrl}${href}`, { redirect: 'manual' });
    check(res.status < 400, `catalogue link ${href} -> HTTP ${res.status}`);
  }
  log(`ok   catalogue links checked (${hrefs.length})`);
  await context.close();
}

/**
 * Record lists (UX3): the URL is the view (system views, filters, sort, columns, density, keyset
 * pages), keyboard row navigation, row preview, empty/error states, axe, and the table scrolling
 * inside its region (never the page) at 390 px.
 */
async function listChecks(browser: Browser) {
  const scan = async (page: Page, what: string) => {
    // The row preview and filter panel are popovers that fade in: scan them settled.
    await animationsSettled(page);
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const bad = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    for (const v of bad)
      failures.push(
        `axe ${what}: ${v.id} (${v.impact}) ${v.help} — ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(' '))
          .join(', ')}`,
      );
    log(`${bad.length ? 'FAIL' : 'ok  '} axe ${what}`);
  };
  const ok = (cond: boolean, what: string) => {
    log(`${cond ? 'ok  ' : 'FAIL'} lists: ${what}`);
    check(cond, `lists: ${what}`);
  };
  const params = (page: Page) => new URL(page.url()).searchParams;

  for (const scheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    const page = await context.newPage();
    for (const path of ['/jobs', '/companies', '/sources', '/review', '/runs']) {
      await page.goto(`${adminUrl}${path}`, { waitUntil: 'networkidle' });
      await scan(page, `${path} list ${scheme}`);
    }
    if (scheme === 'light') {
      await page.goto(`${adminUrl}/jobs`, { waitUntil: 'networkidle' });
      const table = page.getByRole('region', { name: 'Jobs table' });
      // Row preview (popover): opens, passes axe, Escape returns focus.
      const preview = table.getByRole('button', { name: /^Preview / }).first();
      await preview.click();
      await page.getByRole('dialog', { name: /^Preview: / }).waitFor();
      await scan(page, 'job row preview');
      await page.keyboard.press('Escape');
      await page
        .getByRole('dialog', { name: /^Preview: / })
        .waitFor({ state: 'detached', timeout: 5_000 })
        .catch(() => {});
      // Focus goes back to the row's link (its one Tab stop), not the out-of-Tab-order button.
      ok(
        await preview.evaluate(
          (el) => document.activeElement === el.closest('tr')?.querySelector('[data-row-link]'),
        ),
        "Escape closes the preview and returns focus to the row's link",
      );
      // Keyboard: j focuses the first row link, ↓ the next, Enter opens the record.
      await page.locator('body').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('j');
      const firstHref = await page.evaluate(() => document.activeElement?.getAttribute('href'));
      ok(/^\/jobs\/job_/.test(firstHref ?? ''), 'j focuses the first row link');
      await page.keyboard.press('ArrowDown');
      const secondHref = await page.evaluate(() => document.activeElement?.getAttribute('href'));
      ok(
        !!secondHref && secondHref !== firstHref && secondHref.startsWith('/jobs/job_'),
        'ArrowDown moves to the next row',
      );
      await page.keyboard.press('Enter');
      await page.waitForURL(new RegExp(`${secondHref}$`));
      ok(true, 'Enter opens the focused record');
      // Space on a focused row opens its preview (one Tab stop per row).
      await page.goto(`${adminUrl}/jobs`, { waitUntil: 'networkidle' });
      await table.locator('[data-row-link]').first().focus();
      await page.keyboard.press('Space');
      ok(
        await page.getByRole('dialog', { name: /^Preview: / }).isVisible(),
        'Space previews the focused row',
      );
      await page.keyboard.press('Escape');
      // A view whose defining filter is gone is not current.
      await page.goto(`${adminUrl}/jobs?view=remote`, { waitUntil: 'networkidle' });
      ok(
        (await page.getByRole('link', { name: 'All jobs' }).getAttribute('aria-current')) === 'page' &&
          (await page.getByRole('link', { name: /^Remote/ }).getAttribute('aria-current')) === null,
        'view=remote without its filter falls back to All jobs',
      );
      // Sort by a header: URL + aria-sort.
      await page.goto(`${adminUrl}/jobs`, { waitUntil: 'networkidle' });
      await table.getByRole('columnheader', { name: 'Title' }).getByRole('link').click();
      await page.waitForURL(/sort=title/);
      ok(
        (await table.getByRole('columnheader', { name: /Title/ }).getAttribute('aria-sort')) === 'ascending',
        'header sort sets sort=title and aria-sort',
      );
      // System view, then the filter panel adds a value; the chip removes it.
      await page
        .getByRole('navigation', { name: 'Jobs views' })
        .getByRole('link', { name: 'Remote' })
        .click();
      await page.waitForURL(/workModel=remote/);
      ok(
        (await page.getByRole('link', { name: 'Remote' }).getAttribute('aria-current')) === 'page',
        'system view is the URL and marked current',
      );
      await page.getByRole('button', { name: /^Filter/ }).click();
      const panel = page.getByRole('dialog', { name: 'Filter jobs' });
      await panel.waitFor();
      await scan(page, 'job filter panel');
      await panel
        .getByRole('group', { name: 'Work model' })
        .getByRole('checkbox', { name: 'Hybrid' })
        .check();
      await panel.getByRole('button', { name: 'Apply filters' }).click();
      await page.waitForURL(/workModel=/);
      await page.waitForLoadState('networkidle');
      const wm = params(page).getAll('workModel').join(',');
      ok(wm.includes('remote') && wm.includes('hybrid'), `filter form keeps and adds values (${wm})`);
      const applied = new URL(page.url());
      ok(
        applied.searchParams.getAll('workModel').length === 1 &&
          [...applied.searchParams.values()].every((v) => v !== ''),
        `Apply lands on the canonical URL (${applied.search})`,
      );
      await page.getByRole('link', { name: 'Remove filter Work model' }).click();
      await page.waitForURL((u) => !u.searchParams.has('workModel'));
      ok(true, 'chip × removes the filter');
      // Columns + density persist through a reload (URL only).
      await page.getByRole('button', { name: 'Columns' }).click();
      await page
        .getByRole('dialog', { name: 'Columns' })
        .getByRole('checkbox', { name: 'Seniority' })
        .check();
      await page.getByRole('dialog', { name: 'Columns' }).getByRole('button', { name: 'Apply' }).click();
      await page.waitForURL(/cols=/);
      await page.getByRole('link', { name: 'Comfortable rows' }).click();
      await page.waitForURL(/density=comfortable/);
      await page.reload({ waitUntil: 'networkidle' });
      ok(
        (await table.getByRole('columnheader', { name: 'Seniority' }).count()) === 1 &&
          (await table.getByRole('table').getAttribute('data-density')) === 'comfortable',
        'columns and density come back from the URL after reload',
      );
      // Keyset paging with a small page size: Next, then Previous back to page 1.
      await page.goto(`${adminUrl}/jobs?limit=10`, { waitUntil: 'networkidle' });
      const firstRow = await table.locator('[data-row-link]').first().getAttribute('href');
      const next = page.getByRole('link', { name: 'Next →' });
      if (await next.count()) {
        await next.click();
        await page.waitForURL(/after=/);
        const range = await page.getByRole('navigation', { name: 'Pagination' }).innerText();
        ok(range.includes('11–'), `second keyset page shows rows 11– (${range.split('\n')[0]})`);
        const second = await table.locator('[data-row-link]').first().getAttribute('href');
        ok(second !== firstRow, 'second page has different rows');
        // Client navigation keeps the segment mounted: the new rows must still get one Tab stop
        // each and cut-cell tooltips (TableKeys re-runs per view).
        await page.waitForTimeout(200);
        const rowState = await table.evaluate((t) => ({
          extraStops: [...t.querySelectorAll<HTMLElement>('tbody a[href], tbody button')].filter(
            (el) => !el.hasAttribute('data-row-link') && el.tabIndex >= 0,
          ).length,
          cutWithoutTitle: [...t.querySelectorAll<HTMLElement>('[data-cell]')].filter(
            (c) => c.scrollWidth > c.clientWidth + 1 && !c.title,
          ).length,
        }));
        ok(
          rowState.extraStops === 0 && rowState.cutWithoutTitle === 0,
          `after Next: ${rowState.extraStops} extra Tab stops, ${rowState.cutWithoutTitle} cut cells without a tooltip`,
        );
        await page.getByRole('link', { name: '← Previous' }).click();
        await page.waitForURL((u) => !u.searchParams.has('after'));
        ok(
          (await table.locator('[data-row-link]').first().getAttribute('href')) === firstRow,
          'Previous returns to page 1',
        );
      } else ok(false, 'fewer than 11 demo jobs: keyset paging not exercised');
      // Review (UX3f): a decided-items view is the URL and uses the API's order.
      const reviewTable = page.getByRole('region', { name: 'Review items table' });
      await page.goto(`${adminUrl}/review`, { waitUntil: 'networkidle' });
      await page
        .getByRole('navigation', { name: 'Review items views' })
        .getByRole('link', { name: 'All' })
        .click();
      await page.waitForURL(/status=all/);
      ok(
        (await reviewTable.locator('[data-row-link]').count()) > 0,
        'review "All" view lists items (status=all)',
      );
      await page.goto(`${adminUrl}/review?view=dismissed&status=dismissed`, { waitUntil: 'networkidle' });
      ok(
        (await reviewTable.locator('[data-row-link]').count()) >= 3,
        'review Dismissed view lists the dismissed items',
      );
      // Review keyset paging at 10 (open queue, priority order): Next, Previous.
      await page.goto(`${adminUrl}/review?limit=10`, { waitUntil: 'networkidle' });
      const reviewPage1 = await reviewTable
        .locator('[data-row-link]')
        .evaluateAll((as) => as.map((a) => a.getAttribute('href')));
      ok(reviewPage1.length === 10, `review page 1 at limit=10 has 10 rows (${reviewPage1.length})`);
      const sortButton = await page.getByRole('button', { name: /^Sort/ }).innerText();
      ok(/highest first/.test(sortButton), `review default sort says highest first (${sortButton})`);
      await page.getByRole('link', { name: 'Next →' }).click();
      await page.waitForURL(/after=/);
      await page.waitForLoadState('networkidle');
      const reviewPage2 = await reviewTable
        .locator('[data-row-link]')
        .evaluateAll((as) => as.map((a) => a.getAttribute('href')));
      const range =
        (await page.getByRole('navigation', { name: 'Pagination' }).innerText()).split('\n')[0] ?? '';
      ok(
        reviewPage2.length > 0 && reviewPage2.every((h) => !reviewPage1.includes(h)) && range.includes('11–'),
        `review keyset page 2: ${reviewPage2.length} new rows (${range})`,
      );
      ok(params(page).getAll('prev').join('|') === '', 'review page 2 URL keeps the trail to page 1');
      await page.getByRole('link', { name: '← Previous' }).click();
      await page.waitForURL((u) => !u.searchParams.has('after'));
      ok(
        (await reviewTable.locator('[data-row-link]').first().getAttribute('href')) === reviewPage1[0],
        'review Previous returns to page 1',
      );
      // Runs (UX3f): offset paging at 10 with the runtime's total; the source names each row.
      const runsTable = page.getByRole('region', { name: 'Runs table' });
      await page.goto(`${adminUrl}/runs?limit=10`, { waitUntil: 'networkidle' });
      const runsPage1 = await runsTable
        .locator('[data-row-link]')
        .evaluateAll((as) => as.map((a) => a.getAttribute('href')));
      ok(runsPage1.length === 10, `runs page 1 at limit=10 has 10 rows (${runsPage1.length})`);
      ok(
        (await runsTable.getByRole('link', { name: 'Board without a token (e2e fixture)' }).count()) > 0,
        'runs name their source (Source column)',
      );
      await page.getByRole('link', { name: 'Next →' }).click();
      await page.waitForURL(/offset=10/);
      await page.waitForLoadState('networkidle');
      const runsRange = (await page.getByRole('navigation', { name: 'Pagination' }).innerText()).split(
        '\n',
      )[0]!;
      const runsPage2 = await runsTable
        .locator('[data-row-link]')
        .evaluateAll((as) => as.map((a) => a.getAttribute('href')));
      ok(
        /^11–\d+ of \d+/.test(runsRange.trim()) &&
          runsPage2.length > 0 &&
          runsPage2.every((h) => !runsPage1.includes(h)),
        `runs offset page 2: ${runsPage2.length} new rows (${runsRange})`,
      );
      await page.getByRole('link', { name: '← Previous' }).click();
      await page.waitForURL((u) => !u.searchParams.has('offset'));
      ok(true, 'runs Previous returns to the first page');
      ok(
        (await page.getByRole('button', { name: /^Sort/ }).count()) === 0,
        'runs offer no sort (fixed order)',
      );
      // An offset past the end says how many there are and links to the last page.
      await page.goto(`${adminUrl}/runs?limit=10&offset=500`, { waitUntil: 'networkidle' });
      ok(
        (await page.getByText(/No rows at this offset/).isVisible()) &&
          (await page.getByRole('link', { name: 'Last page' }).count()) === 1,
        'an offset past the end offers the last page',
      );
      await page.goto(`${adminUrl}/runs?all=false`, { waitUntil: 'networkidle' });
      ok(
        new URL(page.url()).search === '' &&
          (await page.getByRole('link', { name: 'Top-level runs' }).getAttribute('aria-current')) === 'page',
        'runs?all=false is the unmodified top-level view',
      );
      await page.goto(`${adminUrl}/runs?view=children&all=true`, { waitUntil: 'networkidle' });
      ok((await runsTable.getByText(/child of/).count()) > 0, 'child runs view shows lineage');
      await page.goto(`${adminUrl}/review?q=acme`, { waitUntil: 'networkidle' });
      ok(
        (await page
          .locator('main')
          .getByText(/no search/)
          .count()) > 0 && (await page.locator('main').getByRole('alert').count()) === 0,
        'review ?q= is reported as ignored, not an API error',
      );

      // Empty (filtered) and error states.
      await page.goto(`${adminUrl}/jobs?q=zzqqxxnomatch`, { waitUntil: 'networkidle' });
      ok(await page.getByText('No jobs match these filters.').isVisible(), 'filtered empty state');
      await page.goto(`${adminUrl}/jobs?after=not-a-cursor`, { waitUntil: 'networkidle' });
      ok(
        (await page.locator('main').getByRole('alert').count()) > 0 &&
          (await page.getByRole('link', { name: 'Back to the first page' }).isVisible()),
        'a bad cursor shows the API error with a way back',
      );
    }
    await context.close();
  }

  // The header stays visible while the table scrolls (sticky inside its own scroll region).
  {
    const short = await browser.newContext({ viewport: { width: 1440, height: 520 } });
    const p = await short.newPage();
    await p.goto(`${adminUrl}/jobs`, { waitUntil: 'networkidle' });
    const region = p.getByRole('region', { name: 'Jobs table' });
    await region.evaluate((el) => el.scrollBy(0, 200));
    await p.waitForTimeout(100);
    const [regionBox, headBox] = await Promise.all([
      region.boundingBox(),
      region.getByRole('columnheader').first().boundingBox(),
    ]);
    const scrolled = await region.evaluate((el) => el.scrollTop);
    ok(
      scrolled > 0 && !!regionBox && !!headBox && Math.abs(headBox.y - regionBox.y) <= 2,
      `header sticks after scrolling ${scrolled}px (header y ${headBox?.y}, region y ${regionBox?.y})`,
    );
    await short.close();
  }

  // Phone: the page never scrolls sideways; the table scrolls inside its region.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobile = await phone.newPage();
  for (const [path, name] of [
    ['/jobs', 'Jobs table'],
    ['/companies', 'Companies table'],
    ['/sources', 'Sources table'],
    ['/review?status=all', 'Review items table'],
    ['/runs', 'Runs table'],
  ] as const) {
    await mobile.goto(`${adminUrl}${path}`, { waitUntil: 'networkidle' });
    const pageOverflow = await mobile.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    const region = mobile.getByRole('region', { name });
    const inner = await region.evaluate((el) => el.scrollWidth - el.clientWidth);
    ok(
      pageOverflow <= 0 && inner > 0,
      `${path} @390: page overflow ${pageOverflow}px, table scrolls ${inner}px inside`,
    );
  }
  // Phone: a failed run is recognisable without scrolling sideways (State before Source).
  await mobile.goto(`${adminUrl}/runs`, { waitUntil: 'networkidle' });
  {
    const failedRow = mobile
      .getByRole('region', { name: 'Runs table' })
      .locator('tbody tr')
      .filter({ hasText: 'Failed' })
      .first();
    const stateBox = (await failedRow.count())
      ? await failedRow.getByText('Failed', { exact: true }).first().boundingBox()
      : null;
    ok(
      !!stateBox && stateBox.x >= 0 && stateBox.x + stateBox.width <= 390,
      `/runs @390: a failed row's State is on screen (${stateBox ? `x ${Math.round(stateBox.x)}–${Math.round(stateBox.x + stateBox.width)}` : 'no failed row'})`,
    );
  }
  // Phone: the filter panel (axe incl. target size) and the row preview stay on screen.
  await mobile.goto(`${adminUrl}/jobs`, { waitUntil: 'networkidle' });
  await mobile.getByRole('button', { name: /^Filter/ }).click();
  await mobile.getByRole('dialog', { name: 'Filter jobs' }).waitFor();
  await scan(mobile, 'job filter panel @390px');
  await mobile.keyboard.press('Escape');
  await mobile
    .getByRole('button', { name: /^Preview / })
    .nth(3)
    .click();
  const preview = mobile.getByRole('dialog', { name: /^Preview: / });
  await preview.waitFor();
  // Measure and scan once the fade-in (opacity + translateY) has finished.
  await animationsSettled(mobile);
  const box = await preview.boundingBox();
  ok(
    !!box && box.y >= 0 && box.x >= 0 && box.y + box.height <= 844 && box.x + box.width <= 390,
    `row preview on screen at 390 (${box ? `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}` : 'none'})`,
  );
  await scan(mobile, 'job row preview @390px');
  await phone.close();
}

// -------------------------------------------------------------------------------------- teardown

// Memoised: Ctrl-C reaches this process both directly and relayed by its parent.
let tearingDown: Promise<void> | undefined;
const teardown = () => (tearingDown ??= cleanup());

let browser: Browser | undefined;
let cleanupFailed = false;

/**
 * Stops every process (SIGTERM, up to 10 s each, then SIGKILL of the group) and only then drops
 * the throwaway database, queue keys and bucket via the worker's dev drop-env script.
 */
async function cleanup() {
  log('tearing down');
  await browser?.close().catch(() => {});
  const running = children.filter((c) => c.exitCode === null && c.signalCode === null);
  for (const c of running) killGroup(c, 'SIGTERM');
  await Promise.all(
    running.map(async (c) => {
      if ((await exited(c, 10_000)) === null) {
        killGroup(c, 'SIGKILL');
        await exited(c, 5_000);
      }
    }),
  );
  try {
    await runToCompletion(
      'drop-env',
      ['apps/worker/src/dev/drop-env.ts', `--confirm=${env.MONGODB_DB}`],
      60_000,
    );
    log(`removed ${env.MONGODB_DB} (database, queue keys, bucket)`);
  } catch (err) {
    cleanupFailed = true;
    console.error(`[admin-e2e] cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

for (const [sig, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const) {
  process.on(sig, () => {
    void teardown().finally(() => process.exit(code));
  });
}

// ------------------------------------------------------------------------------------------ main

let exitCode = 0;
try {
  if (!existsSync(path.join(adminDir, '.next/BUILD_ID')))
    throw new Error(
      'No admin production build: run `pnpm build` (or `pnpm --filter @aptamind/admin build`) first.',
    );
  log(`db ${env.MONGODB_DB} · api ${apiUrl} · admin ${adminUrl} · logs ${logDir}`);

  await runToCompletion('migrate', ['apps/worker/src/migrate.ts']);
  start('worker', tsx, ['apps/worker/src/main.ts']);
  await runToCompletion('seed', ['apps/worker/src/seed.ts', '--demo']);
  await waitForRunsToSettle();
  await seedLists();
  log('seeded demo data settled');

  // `next start` expects production; the dev-only UI catalogue is enabled for the a11y checks.
  const adminEnv: NodeJS.ProcessEnv = { ...env, NODE_ENV: 'production', ADMIN_UI_CATALOGUE: '1' };
  start('admin', next, ['start', '-p', String(adminPort), '-H', '127.0.0.1'], {
    cwd: adminDir,
    env: adminEnv,
  });
  await waitFor('admin server', async () => ((await fetch(adminUrl)).status ? true : undefined), 60_000);
  await waitFor('API readiness', () => getJson(`${apiUrl}/ready`), 60_000);

  browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined,
    // Sandboxed wherever possible (CI runs non-root); a root dev container cannot use the
    // Chromium sandbox. The browser only ever loads this local admin.
    chromiumSandbox: process.getuid?.() !== 0,
    // Our own signal handlers close the browser as part of the full teardown.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  await smoke(browser);
  await shellChecks(browser).catch((err: Error) => failures.push(`shell checks: ${err.message}`));
  await a11yChecks(browser).catch((err: Error) => failures.push(`a11y checks: ${err.message}`));
  await layerChecks(browser).catch((err: Error) => failures.push(`layer checks: ${err.message}`));
  await listChecks(browser).catch((err: Error) => failures.push(`list checks: ${err.message}`));

  if (failures.length) {
    exitCode = 1;
    console.error(`\n[admin-e2e] ${failures.length} failure(s):\n- ${failures.join('\n- ')}`);
  } else {
    log(`all ${visited} routes passed`);
  }
  if (keep) {
    log(`stack kept running: ${adminUrl} (api ${apiUrl}); Ctrl-C to tear down`);
    await new Promise(() => {});
  }
} catch (err) {
  exitCode = 1;
  console.error(`[admin-e2e] ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await teardown();
}
// A leaked environment fails CI; locally it is reported but does not mask the smoke result.
if (cleanupFailed && process.env.CI) exitCode = 1;
if (exitCode !== 0) {
  for (const name of ['admin', 'api', 'worker'])
    console.error(`\n[admin-e2e] --- ${name}.log (tail) ---\n${logTail(name, 60)}`);
  console.error(`[admin-e2e] full logs: ${logDir}`);
} else if (!process.env.ADMIN_E2E_LOG_DIR) {
  rmSync(logDir, { recursive: true, force: true });
}
process.exit(exitCode);
