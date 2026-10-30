/**
 * Optional, read-only, bounded live smoke checks against the real public sources:
 *   GOV.UK sponsor register · Greenhouse (stripe) · Ashby (ashby) · Lever (palantir)
 *
 *   pnpm smoke:live            (needs outbound HTTPS to those hosts; never run in CI)
 *
 * Only GET requests through the SSRF-safe client; nothing is written anywhere. Each check prints
 * LIVE VERIFIED, LIVE FAILED (reachable but wrong) or NOT REACHABLE. Exit code: 0 all verified,
 * 1 any failure, 2 nothing failed but something was unreachable.
 *
 * The Ashby check re-runs the audit's H-2 regression on live data: a remote posting whose text
 * says "You prefer an in-person role over remote (Ashby operates remotely)" must be remote.
 */
import { connectors, enrichment, findRegisterCsvLink } from '@aptamind/market';
import { HttpError, SafeHttpClient } from '@aptamind/net';

const http = new SafeHttpClient({
  allowPrivateNetwork: false,
  userAgent: 'aptamind-live-smoke/1 (+read-only)',
  defaultTimeoutMs: 30_000,
  maxResponseBytes: 40 * 1024 * 1024,
  perHostConcurrency: 1,
  perHostMinIntervalMs: 500,
});

type Outcome = 'LIVE VERIFIED' | 'LIVE FAILED' | 'NOT REACHABLE';
const results: Array<{ name: string; outcome: Outcome; detail: string }> = [];

function unreachable(err: unknown): boolean {
  const msg = (err as Error).message ?? '';
  return (
    (err instanceof HttpError && err.status === undefined) ||
    /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|timeout|aborted|403/i.test(msg)
  );
}

async function check(name: string, fn: () => Promise<string>) {
  try {
    results.push({ name, outcome: 'LIVE VERIFIED', detail: await fn() });
  } catch (err) {
    results.push({
      name,
      outcome: unreachable(err) ? 'NOT REACHABLE' : 'LIVE FAILED',
      detail: (err as Error).message,
    });
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function json(url: string): Promise<unknown> {
  const res = await http.request({ url, headers: { accept: 'application/json' } });
  assert(res.ok, `${url} responded ${res.status}`);
  return JSON.parse(new TextDecoder().decode(res.body));
}

async function board(provider: 'greenhouse' | 'ashby' | 'lever', token: string, limit: number) {
  const adapter = connectors.getAdapter(provider);
  const listing = adapter.parseListing(await json(adapter.listingUrl(token)), { boardToken: token });
  assert(listing.jobs.length > 0, `${provider}/${token}: no jobs parsed`);
  const interpreted = listing.jobs.slice(0, limit).map(({ payload }) => ({
    payload,
    interpretation: enrichment.interpretJob({
      title: payload.title,
      descriptionText:
        payload.descriptionText?.trim() ||
        (payload.descriptionHtml ? enrichment.htmlToText(payload.descriptionHtml) : ''),
      locationTexts: payload.locations.map((l) => l.text),
      provider: {
        workplaceType: payload.workplaceType ?? null,
        employmentTypeText: payload.employmentTypeText ?? null,
        department: payload.department ?? null,
        compensation: payload.compensation ?? null,
      },
      company: null,
    }),
  }));
  return { listing, interpreted };
}

await check('GOV.UK sponsor register', async () => {
  const page = 'https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers';
  const res = await http.request({ url: page });
  assert(res.ok, `publication page responded ${res.status}`);
  const csv = findRegisterCsvLink(new TextDecoder().decode(res.body), page);
  assert(csv, 'register CSV link not found on the publication page');
  // Bounded: only the first 64 KiB of the register.
  const head = await http.request({ url: csv, headers: { range: 'bytes=0-65535' }, maxBytes: 70_000 });
  assert(head.status === 206 || head.ok, `register CSV responded ${head.status}`);
  const lines = new TextDecoder().decode(head.body).split(/\r?\n/);
  assert(/Organisation Name/i.test(lines[0] ?? ''), `unexpected CSV header: ${lines[0]}`);
  return `CSV ${csv} — header ok, ${lines.length - 2} rows in the first 64 KiB`;
});

await check('Greenhouse (stripe)', async () => {
  const { listing, interpreted } = await board('greenhouse', 'stripe', 25);
  const models = interpreted.map((j) => j.interpretation.workModel.value);
  return `${listing.jobs.length} jobs; first ${interpreted.length} interpreted (work models: ${[...new Set(models)].join(', ')})`;
});

await check('Ashby (ashby) + H-2 regression', async () => {
  const { listing, interpreted } = await board('ashby', 'ashby', 200);
  const all = listing.jobs.length;
  const hits = interpreted.filter((j) =>
    /Ashby operates remotely/i.test(j.payload.descriptionText ?? j.payload.descriptionHtml ?? ''),
  );
  const wrong = interpreted.filter(
    (j) => j.payload.workplaceType === 'remote' && j.interpretation.workModel.value === 'onsite',
  );
  assert(
    !wrong.length,
    `remote postings interpreted onsite: ${wrong.map((j) => j.payload.title).join('; ')}`,
  );
  for (const j of hits) {
    assert(
      j.interpretation.workModel.value === 'remote',
      `"${j.payload.title}" interpreted ${j.interpretation.workModel.value}`,
    );
  }
  return `${all} jobs; ${hits.length} contain the audited sentence, all remote; no provider-remote posting interpreted onsite`;
});

await check('Lever (palantir, bounded)', async () => {
  const { listing, interpreted } = await board('lever', 'palantir', 25);
  return `${listing.jobs.length} jobs; first ${interpreted.length} interpreted`;
});

for (const r of results) console.log(`${r.outcome.padEnd(14)} ${r.name} — ${r.detail}`);
process.exit(
  results.some((r) => r.outcome === 'LIVE FAILED')
    ? 1
    : results.some((r) => r.outcome === 'NOT REACHABLE')
      ? 2
      : 0,
);
