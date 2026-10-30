import { describe, expect, it } from 'vitest';
import { atsExternalId } from '../../companies/external-ids';
import {
  type AtsBoardDirectoryConfig,
  boardKeyOf,
  boardRefFromUrl,
  checkBoardDirectoryUpload,
  parseBoardDirectoryConfig,
  planBoardDirectory,
} from './ats-board-directory';

const config = (columns: Record<string, string> = {}): AtsBoardDirectoryConfig =>
  parseBoardDirectoryConfig({
    columns: {
      provider: 'Provider',
      token: 'Token',
      company: 'Company',
      domain: 'Domain',
      url: 'URL',
      ...columns,
    },
  });

const HEADER = 'Provider,Token,Company,Domain,URL';
const plan = (...rows: string[]) => planBoardDirectory(config(), [HEADER, ...rows].join('\n'));

describe('ATS board file config (M8.2)', () => {
  it('needs company or domain, and refuses personal-data columns', () => {
    expect(() => parseBoardDirectoryConfig({ columns: { provider: 'P', token: 'T' } })).toThrow(
      /company or domain/,
    );
    expect(() =>
      parseBoardDirectoryConfig({ columns: { provider: 'P', token: 'T', company: 'Contact email' } }),
    ).toThrow(/personal data/);
    expect(() =>
      parseBoardDirectoryConfig({ columns: { provider: 'P', token: 'T', domain: 'D', extra: 'X' } }),
    ).toThrow(/Invalid ATS board file configuration/);
    expect(parseBoardDirectoryConfig({ columns: { provider: 'P', token: 'T', domain: 'D' } })).toMatchObject({
      maxRows: 5000,
    });
  });
});

describe('planBoardDirectory', () => {
  it('maps valid rows to board keys (provider case-insensitive)', () => {
    const p = plan('Greenhouse,acme,Acme Ltd,acme.co.uk,', 'lever,beta,,beta.co.uk,');
    expect(p.errors).toEqual([]);
    expect(p.rows).toEqual([
      expect.objectContaining({
        line: 2,
        locator: 'row:2',
        provider: 'greenhouse',
        boardToken: 'acme',
        key: 'greenhouse:acme',
        company: 'Acme Ltd',
        domain: 'acme.co.uk',
      }),
      expect.objectContaining({ provider: 'lever', key: 'lever:beta', company: null, domain: 'beta.co.uk' }),
    ]);
  });

  it('takes the region from a matching board URL', () => {
    const p = plan('greenhouse,acme,,acme.co.uk,https://job-boards.eu.greenhouse.io/acme');
    expect(p.errors).toEqual([]);
    expect(p.rows[0]).toMatchObject({
      key: 'greenhouse:eu:acme',
      apiBase: 'https://boards-api.eu.greenhouse.io/v1/boards',
    });
  });

  it('reports a row error for every invalid row, and ignores duplicates', () => {
    const p = plan(
      'workday,acme,,acme.co.uk,',
      ',acme,,acme.co.uk,',
      'greenhouse,,,acme.co.uk,',
      'greenhouse,bad token!,,acme.co.uk,',
      'greenhouse,acme,,gmail.com,',
      'greenhouse,acme,jane@acme.co.uk,,',
      'greenhouse,acme,,acme.co.uk,https://jobs.lever.co/acme',
      'greenhouse,acme2,,acme.co.uk,https://example.org/careers',
      'greenhouse,ok,,acme.co.uk,',
      'greenhouse,ok,,acme.co.uk,',
    );
    expect(p.rows.map((r) => r.key)).toEqual(['greenhouse:acme2', 'greenhouse:ok']);
    expect(p.errors.map((e) => e.code)).toEqual([
      'unknown_provider',
      'missing_provider',
      'missing_token',
      'invalid_token',
      'invalid_domain',
      'contact_value',
      'url_mismatch',
      'duplicate_row_key',
    ]);
    // A URL on another host is discovery evidence only: a warning, and the row keeps its board.
    expect(p.warnings.map((w) => [w.line, w.code, w.skipped])).toEqual([[9, 'not_an_ats_url', false]]);
    // Messages never quote cell text.
    expect(p.errors.some((e) => e.message.includes('jane@'))).toBe(false);
  });

  it('keys a board by its lowercased token and keeps the first-seen token (all providers)', () => {
    const p = plan(
      'greenhouse,ZZShared,,a.co.uk,',
      'greenhouse,zzshared,,a.co.uk,',
      'lever,LeverCo,,a.co.uk,',
      'lever,leverco,,a.co.uk,',
      'ashby,AshCo,,a.co.uk,',
      'ashby,ASHCO,,a.co.uk,',
    );
    expect(p.rows.map((r) => [r.key, r.boardToken])).toEqual([
      ['greenhouse:zzshared', 'ZZShared'],
      ['lever:leverco', 'LeverCo'],
      ['ashby:ashco', 'AshCo'],
    ]);
    expect(p.errors.map((e) => e.code)).toEqual([
      'duplicate_row_key',
      'duplicate_row_key',
      'duplicate_row_key',
    ]);
  });

  it('refuses a header that does not match the column map', () => {
    expect(
      planBoardDirectory(config(), 'Provider,Token,Company,Domain\ngreenhouse,a,,a.co.uk').headerProblems,
    ).not.toEqual([]);
    expect(
      planBoardDirectory(config(), `${HEADER},Email\ngreenhouse,a,,a.co.uk,,x@a.co.uk`).headerProblems,
    ).not.toEqual([]);
  });

  it('checks an upload before storage like a directory', () => {
    expect(checkBoardDirectoryUpload(config(), `${HEADER}\ngreenhouse,a,,a.co.uk,`, 'text/csv')).toEqual([]);
    expect(
      checkBoardDirectoryUpload(config(), `${HEADER},Phone\ngreenhouse,a,,a.co.uk,,1`, 'text/csv').length,
    ).toBeGreaterThan(0);
    expect(checkBoardDirectoryUpload(config(), `${HEADER}\n`, 'application/pdf').length).toBeGreaterThan(0);
  });
});

describe('boardRefFromUrl (OPS-1b)', () => {
  const ref = (url: string) => {
    const r = boardRefFromUrl(url);
    return 'ref' in r ? [r.ref.provider, r.ref.boardToken, r.ref.apiBase] : r.error;
  };
  const GH = 'https://boards-api.greenhouse.io/v1/boards';
  const GH_EU = 'https://boards-api.eu.greenhouse.io/v1/boards';
  const LEVER = 'https://api.lever.co/v0/postings';
  const LEVER_EU = 'https://api.eu.lever.co/v0/postings';
  const ASHBY = 'https://api.ashbyhq.com/posting-api/job-board';

  it.each([
    ['https://boards.greenhouse.io/acme', 'greenhouse', 'acme', GH],
    ['https://boards.greenhouse.io/acme/jobs/4012345?gh_jid=4012345', 'greenhouse', 'acme', GH],
    ['https://job-boards.greenhouse.io/acme/jobs/123', 'greenhouse', 'acme', GH],
    ['https://job-boards.eu.greenhouse.io/acme/jobs/123', 'greenhouse', 'acme', GH_EU],
    ['https://boards.eu.greenhouse.io/acme', 'greenhouse', 'acme', GH_EU],
    ['https://boards.greenhouse.io/embed/job_board?for=acme', 'greenhouse', 'acme', GH],
    ['https://boards.greenhouse.io/embed/job_app?for=acme&token=123', 'greenhouse', 'acme', GH],
    ['https://job-boards.greenhouse.io/embed/job_board?for=Acme&b=x', 'greenhouse', 'Acme', GH],
    ['https://jobs.ashbyhq.com/acme', 'ashby', 'acme', ASHBY],
    [
      'https://jobs.ashbyhq.com/Acme/0c6b1a2e-1111-2222-3333-444455556666/application',
      'ashby',
      'Acme',
      ASHBY,
    ],
    ['https://jobs.ashbyhq.com/acme?utm_source=x', 'ashby', 'acme', ASHBY],
    ['https://jobs.lever.co/acme', 'lever', 'acme', LEVER],
    ['https://jobs.lever.co/acme/5a2b-uuid/apply?lever-source=x', 'lever', 'acme', LEVER],
    ['https://jobs.eu.lever.co/acme/5a2b-uuid', 'lever', 'acme', LEVER_EU],
    ['HTTPS://JOBS.LEVER.CO/ACME/', 'lever', 'ACME', LEVER],
    ['jobs.lever.co/acme/123', 'lever', 'acme', LEVER],
    ['http://boards.greenhouse.io/acme#top', 'greenhouse', 'acme', GH],
    // A trailing-dot host is the same host (OPS-1b repair).
    ['https://boards.greenhouse.io./acme', 'greenhouse', 'acme', GH],
    ['https://JOBS.EU.LEVER.CO./acme/1', 'lever', 'acme', LEVER_EU],
    // Ashby serves a board whose name has a space (checked live, OPS-1b repair).
    ['https://jobs.ashbyhq.com/blackpoint%20cyber', 'ashby', 'blackpoint cyber', ASHBY],
    ['https://jobs.ashbyhq.com/Blackpoint%20Cyber/0c6b1a2e/application', 'ashby', 'Blackpoint Cyber', ASHBY],
  ])('%s', (url, provider, token, apiBase) => {
    expect(ref(url)).toEqual([provider, token, apiBase]);
  });

  it.each([
    'https://boards.greenhouse.io/',
    'https://boards.greenhouse.io/embed/job_board',
    'https://jobs.lever.co/',
    'https://jobs.ashbyhq.com/',
    'https://jobs.ashbyhq.com/bad%20token!',
    'https://jobs.ashbyhq.com/two%20%20spaces',
  ])('an ATS board host without a readable token is invalid: %s', (url) => {
    expect(ref(url)).toBe('invalid');
  });

  it.each([
    'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/123',
    'https://www.workatastartup.com/jobs/123',
    'https://www.linkedin.com/jobs/view/123',
    'https://www.greenhouse.io/blog',
    'https://example.org/careers?gh_jid=1',
    'https://evil.example/boards.greenhouse.io/acme',
    'not a url',
    'mailto:jobs@acme.co.uk',
    'ftp://jobs.lever.co/acme',
  ])('anything else is not an ATS URL: %s', (url) => {
    expect(ref(url)).toBe('not_ats');
  });
});

describe('planBoardDirectory with a URL column (OPS-1b)', () => {
  const urlConfig = (columns: Record<string, string>) => parseBoardDirectoryConfig({ columns });

  it('lets a URL stand in for provider and token, and needs one of the two', () => {
    expect(urlConfig({ url: 'URL', company: 'Company' }).columns).toEqual({ url: 'URL', company: 'Company' });
    expect(() => parseBoardDirectoryConfig({ columns: { provider: 'P', company: 'C' } })).toThrow(
      /provider and token, or url/,
    );
  });

  it('derives provider and token from a board or job URL', () => {
    const c = urlConfig({ url: 'URL', company: 'Company' });
    const p = planBoardDirectory(
      c,
      [
        'URL,Company',
        'https://job-boards.greenhouse.io/Acme/jobs/1,Acme',
        'https://jobs.eu.lever.co/beta/x,Beta',
        'https://jobs.ashbyhq.com/gamma,',
      ].join('\n'),
    );
    expect(p.errors).toEqual([]);
    expect(p.rows.map((r) => [r.key, r.boardToken, r.company])).toEqual([
      ['greenhouse:acme', 'Acme', 'Acme'],
      ['lever:eu:beta', 'beta', 'Beta'],
      // No company and no domain: processing decides (a known board, or no_identity).
      ['ashby:gamma', 'gamma', null],
    ]);
  });

  it('warns about a URL on another host and skips a row that has no other board', () => {
    const c = urlConfig({ url: 'URL', company: 'Company' });
    const p = planBoardDirectory(
      c,
      [
        'URL,Company',
        'https://acme.wd1.myworkdayjobs.com/x,Acme',
        ',Beta',
        'https://jobs.lever.co/,Gamma',
      ].join('\n'),
    );
    expect(p.rows).toEqual([]);
    expect(p.warnings).toEqual([
      expect.objectContaining({ line: 2, code: 'not_an_ats_url', column: 'URL', skipped: true }),
    ]);
    expect(p.errors.map((e) => [e.line, e.code])).toEqual([
      [3, 'missing_board'],
      [4, 'invalid_url'],
    ]);
  });

  it('fails a row whose URL and provider or token disagree, and fills a missing one from the URL', () => {
    const p = plan(
      'lever,acme,Acme,,https://jobs.ashbyhq.com/acme',
      'greenhouse,other,Acme,,https://boards.greenhouse.io/acme',
      'greenhouse,ACME,Acme,,https://boards.greenhouse.io/acme/jobs/1',
      ',,Beta,,https://jobs.lever.co/beta',
      'ashby,,Gamma,,https://jobs.ashbyhq.com/gamma',
      ',delta,Delta,,https://jobs.lever.co/delta',
    );
    expect(p.errors.map((e) => [e.line, e.code])).toEqual([
      [2, 'url_mismatch'],
      [3, 'url_mismatch'],
    ]);
    expect(p.rows.map((r) => r.key)).toEqual(['greenhouse:acme', 'lever:beta', 'ashby:gamma', 'lever:delta']);
  });

  it('keeps the first row of a board named twice (URL and token forms, any case)', () => {
    const p = plan(
      'ashby,sevenai,Seven AI,,',
      ',,7AI,,https://jobs.ashbyhq.com/SevenAI/abc',
      'ashby,SEVENAI,Seven Ai,,',
    );
    expect(p.rows.map((r) => [r.key, r.company])).toEqual([['ashby:sevenai', 'Seven AI']]);
    expect(p.errors.map((e) => [e.line, e.code])).toEqual([
      [3, 'duplicate_row_key'],
      [4, 'duplicate_row_key'],
    ]);
  });

  it('reads a percent-encoded Ashby token as the board name, lowercased in the key only', () => {
    const p = plan(
      'ashby,blackpoint%20cyber,BlackPoint,,',
      'ashby,Dominion Dynamics,Dominion,,https://jobs.ashbyhq.com/dominion%20dynamics',
      'greenhouse,two%20words,Gh,,',
      'lever,two words,Lv,,',
    );
    expect(p.rows.map((r) => [r.key, r.boardToken])).toEqual([
      ['ashby:blackpoint cyber', 'blackpoint cyber'],
      ['ashby:dominion dynamics', 'Dominion Dynamics'],
    ]);
    expect(p.errors.map((e) => [e.line, e.code])).toEqual([
      [4, 'invalid_token'],
      [5, 'invalid_token'],
    ]);
  });

  it('refuses an Ashby token with an outer or double space instead of trimming it', () => {
    const p = plan(
      'ashby,%20lead,Lead,,',
      'ashby,lead%20,Lead,,',
      'ashby,dbl  sp2,Dbl,,',
      'ashby,dbl%20%20sp3,Dbl,,',
      ',,Url,,https://jobs.ashbyhq.com/%20lead2',
      'ashby,one sp,One,,',
    );
    expect(p.errors.map((e) => [e.line, e.code])).toEqual([
      [2, 'invalid_token'],
      [3, 'invalid_token'],
      [4, 'invalid_token'],
      [5, 'invalid_token'],
      [6, 'invalid_url'],
    ]);
    expect(p.rows.map((r) => r.key)).toEqual(['ashby:one sp']);
  });

  it('gives the ats id and the source key one region (H1)', () => {
    const p = plan(
      ',,Rv Acme Europe GmbH,,https://job-boards.eu.greenhouse.io/rvacme/jobs/1',
      ',,Rv Acme Incorporated,,https://boards.greenhouse.io/RvAcme',
    );
    expect(p.rows.map((r) => r.key)).toEqual(['greenhouse:eu:rvacme', 'greenhouse:rvacme']);
    for (const r of p.rows) expect(atsExternalId(r.key).id).toBe(r.key);
    expect(boardKeyOf('lever', 'Acme', 'https://api.eu.lever.co/v0/postings')).toBe('lever:eu:acme');
  });

  it('a pinned first-version run checks the provider before the URL, as M8.2 did', () => {
    const p = planBoardDirectory(
      config(),
      [
        HEADER,
        ',acme,Acme,,https://boards.greenhouse.io/acme',
        'workday,acme,Acme,,https://example.org/careers',
        'greenhouse,,Acme,,https://boards.greenhouse.io/acme',
        'ashby,a%20b,Acme,,',
        // The repair's trailing-dot reading is version 2 only: a replay gives the old error.
        'greenhouse,acme,Acme,,https://boards.greenhouse.io./acme',
      ].join('\n'),
      { legacy: true },
    );
    expect(p.errors.map((e) => [e.line, e.code])).toEqual([
      [2, 'missing_provider'],
      [3, 'unknown_provider'],
      [4, 'missing_token'],
      [5, 'invalid_token'],
      [6, 'invalid_url'],
    ]);
  });

  it('keeps the M8.2 rules for runs pinned to the first version (legacy)', () => {
    const p = planBoardDirectory(
      config(),
      [HEADER, 'greenhouse,acme,,,', 'greenhouse,b,,b.co.uk,https://example.org/careers'].join('\n'),
      { legacy: true },
    );
    expect(p.errors.map((e) => e.code)).toEqual(['missing_company', 'invalid_url']);
    expect(p.warnings).toEqual([]);
  });
});
