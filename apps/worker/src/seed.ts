import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { UNAUTHENTICATED_INTERNAL_OPERATOR } from '@aptamind/contracts';
import { MARKET_FIXTURES_DIR, uploadSnapshot, UK_SPONSOR_PUBLICATION_URL } from '@aptamind/market';
import { createPlatform } from '@aptamind/platform';

/**
 * Development seed.
 *
 *   pnpm seed:dev            register the UK sponsor register source (live gov.uk data)
 *   pnpm seed:dev --demo     also load committed fixtures offline (sponsor register CSV,
 *                            Greenhouse/Lever/Ashby boards, a third-party feed) as uploaded
 *                            snapshots and start the processing workflows
 *
 * Fixture-backed data is labelled as such; it never claims to be a live integration.
 */
const demo = process.argv.includes('--demo');
const platform = await createPlatform('script');
await platform.init();
const { market } = platform;
const actor = UNAUTHENTICATED_INTERNAL_OPERATOR;

const { source: sponsor } = await market.sources.register(
  {
    key: 'uk-sponsor-register',
    name: 'UK Register of Licensed Sponsors (Workers)',
    category: 'company_universe',
    provider: 'uk_home_office_sponsor_register',
    endpoint: { url: UK_SPONSOR_PUBLICATION_URL },
    acquisition: { workflowKey: 'market.uk_sponsor_register.import' },
    schedule: { cron: '15 6 * * *', timezone: 'Europe/London' },
    freshness: { policyClass: 'source.sponsor_register', maxAgeMinutes: 3 * 24 * 60 },
    authority: {
      tier: 'official_registry',
      authoritativeFor: ['UK sponsor licence presence', 'legal name'],
      listingIsComplete: true,
    },
    governance: {
      accessMethod: 'public_download',
      termsNotes: 'Published by the Home Office on GOV.UK under the Open Government Licence v3.0.',
      redistributionRestrictions: 'OGL v3.0 attribution required',
    },
    enabled: true,
  },
  actor,
);
platform.logger.info({ sourceId: sponsor._id }, 'UK sponsor register source ready');

if (demo) {
  const fx = (...p: string[]) => readFile(path.join(MARKET_FIXTURES_DIR, ...p));
  const snap = await uploadSnapshot(
    market,
    sponsor._id,
    await fx('uk-sponsor', 'register-t1.csv'),
    'text/csv',
    actor,
  );
  const r1 = await market.sources.runNow(sponsor._id, actor, { snapshotId: snap.snapshotId });
  platform.logger.info({ runId: r1.runId }, 'fixture sponsor import started');

  // Company directory used to attach official domains/ATS boards to demo companies.
  const { source: directory } = await market.sources.register(
    {
      key: 'demo:company-directory',
      name: 'Demo company directory (fixture)',
      category: 'manual_import',
      provider: 'fixture',
      acquisition: { workflowKey: 'market.noop' },
      freshness: { policyClass: 'company.firmographics', maxAgeMinutes: 525_600 },
      authority: { tier: 'official_site' },
      governance: {
        accessMethod: 'manual_upload',
        termsNotes: 'Synthetic fixture data for local development',
      },
      labels: { fixture: 'true' },
    },
    actor,
  );
  const boards = [
    {
      company: 'Acme Ltd',
      domain: 'acme.example',
      provider: 'greenhouse' as const,
      token: 'acme',
      file: ['ats', 'greenhouse', 'acme-listing-t1.json'],
    },
    {
      company: 'Beta Co Ltd',
      domain: 'beta-co.example',
      provider: 'lever' as const,
      token: 'beta-co',
      file: ['ats', 'lever', 'beta-co-postings.json'],
    },
    {
      company: 'Gamma Health Limited',
      domain: 'gamma.example',
      provider: 'ashby' as const,
      token: 'gamma',
      file: ['ats', 'ashby', 'gamma-job-board.json'],
    },
  ];
  for (const b of boards) {
    const res = await market.companyPipeline.process({
      sourceId: directory._id,
      externalId: b.domain,
      payload: {
        name: b.company,
        domain: b.domain,
        website: `https://${b.domain}/`,
        aliases: [],
        externalIds: [],
        locations: [],
        industries: [],
        ats: { provider: b.provider, boardToken: b.token },
      },
      parser: { name: 'fixture-directory', version: '1' },
    });
    if (res.outcome === 'review') {
      platform.logger.warn({ company: b.company }, 'demo company went to review; skipping its board');
      continue;
    }
    const companyId = res.companyId;
    const { source } = await market.sources.register(
      {
        key: `${b.provider}:${b.token}`,
        name: `${b.company} (${b.provider}, fixture)`,
        category: 'job_source',
        provider: b.provider,
        endpoint: { boardToken: b.token },
        acquisition: { workflowKey: 'market.ats.refresh' },
        companyId,
        freshness: { policyClass: 'source.ats_listing', maxAgeMinutes: 36 * 60 },
        authority: {
          tier: 'official_ats',
          authoritativeFor: ['job existence', 'job content'],
          listingIsComplete: true,
        },
        governance: {
          accessMethod: 'public_api',
          termsNotes: 'Fixture snapshot of the public job board API',
        },
        labels: { fixture: 'true' },
      },
      actor,
    );
    const s = await uploadSnapshot(market, source._id, await fx(...b.file), 'application/json', actor);
    const run = await market.sources.runNow(source._id, actor, { snapshotId: s.snapshotId });
    platform.logger.info({ source: source.key, runId: run.runId }, 'fixture job board refresh started');
  }
  const { source: feed } = await market.sources.register(
    {
      key: 'aggregator:jobhub',
      name: 'JobHub Global feed (third-party, fixture)',
      category: 'job_source',
      provider: 'aggregator',
      endpoint: { url: 'https://jobhub.example.com/feed.json' },
      acquisition: { workflowKey: 'market.ats.refresh' },
      freshness: { policyClass: 'source.third_party_feed', maxAgeMinutes: 3 * 24 * 60 },
      authority: { tier: 'third_party', listingIsComplete: false },
      governance: { accessMethod: 'licensed_feed', termsNotes: 'Synthetic fixture' },
      labels: { fixture: 'true' },
    },
    actor,
  );
  const s = await uploadSnapshot(
    market,
    feed._id,
    await fx('ats', 'aggregator', 'jobs-feed.json'),
    'application/json',
    actor,
  );
  // Give the official boards a head start so the feed resolves against existing jobs.
  await new Promise((r) => setTimeout(r, 3_000));
  const run = await market.sources.runNow(feed._id, actor, { snapshotId: s.snapshotId });
  platform.logger.info({ runId: run.runId }, 'fixture third-party feed refresh started');
}
await platform.close();
