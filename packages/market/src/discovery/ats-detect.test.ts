import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AtsDetectionSet, detectAts, detectAtsFromUrl } from './ats-detect';

const GH_US = 'https://boards-api.greenhouse.io/v1/boards';
const GH_EU = 'https://boards-api.eu.greenhouse.io/v1/boards';
const LEVER_US = 'https://api.lever.co/v0/postings';
const LEVER_EU = 'https://api.eu.lever.co/v0/postings';
const ASHBY = 'https://api.ashbyhq.com/posting-api/job-board';

const html = (name: string) =>
  readFileSync(new URL(`../../fixtures/careers/${name}`, import.meta.url), 'utf8');

describe('detectAtsFromUrl', () => {
  it.each([
    ['https://boards.greenhouse.io/acme', 'greenhouse', 'acme'],
    ['https://boards.greenhouse.io/acme/jobs/4012345001', 'greenhouse', 'acme'],
    ['https://job-boards.greenhouse.io/acme', 'greenhouse', 'acme'],
    ['https://job-boards.eu.greenhouse.io/acme-eu/jobs/1', 'greenhouse', 'acme-eu'],
    ['https://boards.eu.greenhouse.io/acme', 'greenhouse', 'acme'],
    ['https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true', 'greenhouse', 'acme'],
    ['https://boards.greenhouse.io/embed/job_board?for=acme', 'greenhouse', 'acme'],
    ['https://boards.greenhouse.io/embed/job_board/js?for=acme', 'greenhouse', 'acme'],
    ['//boards.greenhouse.io/embed/job_app?for=acme&token=4012345001', 'greenhouse', 'acme'],
    ['https://jobs.lever.co/beta-co', 'lever', 'beta-co'],
    ['https://jobs.lever.co/beta-co/6f1c2a3b-4d5e/apply', 'lever', 'beta-co'],
    ['https://jobs.eu.lever.co/beta-eu', 'lever', 'beta-eu'],
    ['https://api.lever.co/v0/postings/beta-co?mode=json', 'lever', 'beta-co'],
    ['https://jobs.ashbyhq.com/gamma', 'ashby', 'gamma'],
    ['https://jobs.ashbyhq.com/gamma/embed?version=2', 'ashby', 'gamma'],
    ['https://api.ashbyhq.com/posting-api/job-board/gamma?includeCompensation=true', 'ashby', 'gamma'],
    ['boards.greenhouse.io/acme/', 'greenhouse', 'acme'],
  ])('%s', (url, provider, boardToken) => {
    expect(detectAtsFromUrl(url)).toMatchObject({ provider, boardToken });
  });

  // M6.3: the region is part of the detection, so registration, fetch and verification target the
  // board's own API host (an EU board does not exist on the US host: a 404 there is not absence).
  it.each([
    ['https://boards.greenhouse.io/acme', GH_US],
    ['https://job-boards.greenhouse.io/acme', GH_US],
    ['https://boards-api.greenhouse.io/v1/boards/acme/jobs', GH_US],
    ['https://boards.greenhouse.io/embed/job_board?for=acme', GH_US],
    ['https://boards.eu.greenhouse.io/acme', GH_EU],
    ['https://job-boards.eu.greenhouse.io/acme-eu/jobs/1', GH_EU],
    ['https://boards-api.eu.greenhouse.io/v1/boards/acme/jobs?content=true', GH_EU],
    ['https://boards.eu.greenhouse.io/embed/job_board/js?for=acme', GH_EU],
    ['https://job-boards.eu.greenhouse.io/embed/job_app?for=acme&token=1', GH_EU],
    ['https://jobs.lever.co/beta-co', LEVER_US],
    ['https://api.lever.co/v0/postings/beta-co?mode=json', LEVER_US],
    ['https://jobs.eu.lever.co/beta-eu', LEVER_EU],
    ['https://api.eu.lever.co/v0/postings/beta-eu?mode=json', LEVER_EU],
    ['https://jobs.ashbyhq.com/gamma', ASHBY],
  ])('%s → API base %s', (url, apiBase) => {
    expect(detectAtsFromUrl(url)?.apiBase).toBe(apiBase);
  });

  it.each([
    'https://boards.greenhouse.io/embed/job_board',
    'https://boards.greenhouse.io/',
    'https://boards-api.greenhouse.io/v1/jobs',
    'https://www.greenhouse.io/careers',
    'https://jobs.lever.co/',
    'https://api.lever.co/v1/postings/x',
    'https://jobs.ashbyhq.com/',
    'https://jobs.ashbyhq.com/embed',
    'https://api.ashbyhq.com/other/gamma',
    'https://www.acme.com/jobs',
    'mailto:jobs@lever.co',
    'not a url',
  ])('ignores %s', (url) => {
    expect(detectAtsFromUrl(url)).toBeNull();
  });
});

describe('detectAts', () => {
  it('detects a Greenhouse embed script', () => {
    const detections = detectAts(html('acme-careers-greenhouse.html'), 'https://www.acme.com/careers');
    expect(detections).toEqual([
      {
        provider: 'greenhouse',
        boardToken: 'acme',
        apiBase: GH_US,
        confidence: 'high',
        evidence: 'https://boards.greenhouse.io/embed/job_board/js?for=acme',
      },
    ]);
  });

  it('detects a Lever board link, deduping job links to the same board', () => {
    const detections = detectAts(html('beta-careers-lever.html'), 'https://beta.co/careers');
    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({ provider: 'lever', boardToken: 'beta-co', confidence: 'high' });
  });

  it('detects an Ashby embed', () => {
    const detections = detectAts(html('gamma-careers-ashby.html'), 'https://gamma.io/careers');
    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({ provider: 'ashby', boardToken: 'gamma', confidence: 'high' });
  });

  it('finds ATS URLs inside inline scripts with medium confidence', () => {
    const page = `<script>var board = "https://job-boards.greenhouse.io/delta?gh_src=site";</script>`;
    expect(detectAts(page, 'https://delta.com/careers')).toEqual([
      {
        provider: 'greenhouse',
        boardToken: 'delta',
        apiBase: GH_US,
        confidence: 'medium',
        evidence: 'https://job-boards.greenhouse.io/delta?gh_src=site',
      },
    ]);
  });

  it('reads Greenhouse embed settings with low confidence', () => {
    const page = `<div id="grnhse_app"></div><script>Grnhse.Settings = { boardToken: 'omega' };</script>`;
    expect(detectAts(page, 'https://omega.com/careers')).toMatchObject([
      { provider: 'greenhouse', boardToken: 'omega', confidence: 'low' },
    ]);
  });

  it('accepts the page URL itself being an ATS board', () => {
    expect(detectAts('<html></html>', 'https://jobs.lever.co/beta-co')).toEqual([
      {
        provider: 'lever',
        boardToken: 'beta-co',
        apiBase: LEVER_US,
        confidence: 'high',
        evidence: 'https://jobs.lever.co/beta-co',
      },
    ]);
  });

  it('returns nothing for pages without an ATS', () => {
    expect(detectAts(html('delta-careers-listing.html'), 'https://www.deltalogistics.co.uk/careers')).toEqual(
      [],
    );
    expect(detectAts(html('epsilon-misleading.html'), 'https://www.epsilon-analytics.com/')).toEqual([]);
  });

  it('detects regional boards from embeds with their regional API base', () => {
    const page = `<script src="https://boards.eu.greenhouse.io/embed/job_board/js?for=acme-eu"></script>
      <a href="https://jobs.eu.lever.co/beta-eu">Jobs</a>`;
    expect(detectAts(page, 'https://acme.eu/careers')).toMatchObject([
      { provider: 'greenhouse', boardToken: 'acme-eu', apiBase: GH_EU, confidence: 'high' },
      { provider: 'lever', boardToken: 'beta-eu', apiBase: LEVER_EU, confidence: 'high' },
    ]);
  });

  it('a Greenhouse embed setting without a URL has no known region (default host, low confidence)', () => {
    const page = `<script>Grnhse.Settings = { boardToken: 'omega' };</script>`;
    expect(detectAts(page, 'https://omega.com/careers')).toMatchObject([
      { provider: 'greenhouse', boardToken: 'omega', apiBase: GH_US, confidence: 'low' },
    ]);
  });

  it('caps evidence at 200 characters', () => {
    const long = `https://jobs.lever.co/beta-co?x=${'a'.repeat(300)}`;
    const [detection] = detectAts(`<a href="${long}">Jobs</a>`, 'https://beta.co/');
    expect(detection!.evidence.length).toBeLessThanOrEqual(200);
  });

  it('A-L3: the same token on the default and the EU host is two boards (region is part of the dedupe key)', () => {
    const page = `<a href="https://boards.greenhouse.io/acme">US</a><a href="https://boards.eu.greenhouse.io/acme">EU</a>`;
    expect(detectAts(page, 'https://acme.com/careers').map((d) => [d.boardToken, d.apiBase])).toEqual([
      ['acme', GH_US],
      ['acme', GH_EU],
    ]);
  });

  it('A-L3: a region-less embed setting yields to an explicit regional URL of the same board', () => {
    const page = `<script>Grnhse.Settings = { boardToken: 'acme' }</script><script>load("https://boards.eu.greenhouse.io/embed/job_board/js?for=acme")</script>`;
    expect(detectAts(page, 'https://acme.com/careers')).toEqual([
      expect.objectContaining({ boardToken: 'acme', apiBase: GH_EU, confidence: 'medium' }),
    ]);
  });
});

describe('AtsDetectionSet (A-L3: merging detections across pages)', () => {
  const d = (apiBase: string, confidence: 'high' | 'medium' | 'low', evidence = apiBase) => ({
    provider: 'greenhouse' as const,
    boardToken: 'acme',
    apiBase,
    confidence,
    evidence,
  });

  it('keeps the strongest evidence of a board, whatever page came first', () => {
    const set = new AtsDetectionSet();
    set.add(d(GH_EU, 'medium', 'script'));
    set.add(d(GH_EU, 'high', 'link'));
    set.add(d(GH_EU, 'medium', 'later script'));
    expect(set.list()).toEqual([expect.objectContaining({ confidence: 'high', evidence: 'link' })]);
  });

  it.each([
    ['guess first', ['low', 'medium']],
    ['explicit first', ['medium', 'low']],
  ] as const)('prefers an explicit regional URL over a region-less guess (%s)', (_label, order) => {
    const set = new AtsDetectionSet();
    for (const c of order) set.add(c === 'low' ? d(GH_US, 'low') : d(GH_EU, 'medium'));
    expect(set.list()).toEqual([expect.objectContaining({ apiBase: GH_EU, confidence: 'medium' })]);
  });

  it('an explicit default-host board and an explicit EU board of the same token are both kept', () => {
    const set = new AtsDetectionSet();
    set.add(d(GH_US, 'high'));
    set.add(d(GH_EU, 'medium'));
    expect(set.list().map((x) => x.apiBase)).toEqual([GH_US, GH_EU]);
  });
});
