import { z } from 'zod';
import { AppError } from '@aptamind/contracts';
import { ATS_PROVIDERS, type AtsProvider } from '../../contracts/common';
import { boardSourceIdentity, getAdapter } from '../../connectors';
import { companyDomain } from '../../companies/normalize';
import { type AtsBoardRef, detectAtsFromUrl } from '../../discovery/ats-detect';
import {
  checkCsvHeader,
  checkCsvUpload,
  DIRECTORY_MAX_BYTES,
  type DirectoryUploadProblem,
  isPersonalDataColumn,
  personalColumnProblems,
  MAX_VALUE_CHARS,
  readCsv,
} from './company-directory';
import { beginRow, endRow } from './contact-grammar';
import {
  canonicalText,
  contactValueVerdict,
  directoryDomain,
  isPlaceholder,
  urlHasContactValue,
} from './directory-values';

/**
 * Known ATS board file (M8.2): one row per board. Since OPS-1b a live board can also anchor a new
 * company (DECISION_LOG "A live ATS board is company identity evidence").
 */
export const ATS_BOARD_DIRECTORY_PROVIDER = 'ats_board_directory';
export const ATS_BOARD_DIRECTORY_WORKFLOW = 'market.ats_boards.import';
/** v2 (OPS-1b): the row observation carries the board's `ats` external id. */
export const ATS_BOARD_DIRECTORY_PARSER = { name: 'ats-board-directory-row', version: '2' } as const;
/** The M8.2 parser, still stamped by runs pinned to the first workflow version. */
export const ATS_BOARD_DIRECTORY_PARSER_V1 = { name: 'ats-board-directory-row', version: '1' } as const;

/** A board file is small (one row per board); a lower ceiling than M8.1 bounds the fan-out output. */
export const BOARD_DIRECTORY_MAX_ROWS = 20_000;

export const atsBoardDirectoryConfigSchema = z.strictObject({
  columns: z
    .strictObject({
      // Optional when `url` is mapped: the server reads provider and token from a board or job URL.
      provider: z.string().min(1).optional(),
      token: z.string().min(1).optional(),
      company: z.string().min(1).optional(),
      domain: z.string().min(1).optional(),
      url: z.string().min(1).optional(),
    })
    .refine((c) => (!!c.provider && !!c.token) || !!c.url, { message: 'map provider and token, or url' })
    .refine((c) => !!c.company || !!c.domain, { message: 'map at least one of company or domain' }),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(DIRECTORY_MAX_BYTES)
    .default(5 * 1024 * 1024),
  maxRows: z.number().int().positive().max(BOARD_DIRECTORY_MAX_ROWS).default(5_000),
});
export type AtsBoardDirectoryConfig = z.infer<typeof atsBoardDirectoryConfigSchema>;

export function boardDirectoryColumns(config: AtsBoardDirectoryConfig): string[] {
  const c = config.columns;
  return [c.provider, c.token, c.company, c.domain, c.url].filter((x): x is string => !!x);
}

/** Board hosts of Greenhouse, Lever and Ashby (pages, embeds and public APIs; EU hosts too). */
const ATS_BOARD_HOST =
  /^((job-)?boards(\.eu)?\.greenhouse\.io|boards-api(\.eu)?\.greenhouse\.io|(jobs|api)(\.eu)?\.lever\.co|(jobs|api)\.ashbyhq\.com)$/;

/**
 * The board named by a board or job URL (OPS-1b). `invalid`: a board host, but no readable
 * token. `not_ats`: any other URL (another ATS, a careers page, an aggregator, not a URL).
 * A trailing-dot host (`boards.greenhouse.io.`) is the same host.
 */
export function boardRefFromUrl(url: string): { ref: AtsBoardRef } | { error: 'invalid' | 'not_ats' } {
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`);
  } catch {
    return { error: 'not_ats' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { error: 'not_ats' };
  parsed.hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  const host = parsed.hostname;
  const ashby = host === 'jobs.ashbyhq.com' || host === 'api.ashbyhq.com';
  const ref = ashby ? null : detectAtsFromUrl(parsed.href);
  if (ref) return { ref };
  // Ashby board names may hold single spaces (`jobs.ashbyhq.com/blackpoint%20cyber`), which
  // discovery's token rule refuses, and discovery trims `%20lead` to `lead`, another board. A
  // board file reads Ashby URLs with its own rule (`boardTokenOf`).
  const segments = parsed.pathname.split('/').filter(Boolean);
  const raw =
    host === 'jobs.ashbyhq.com'
      ? segments[0]
      : host === 'api.ashbyhq.com' && segments[0] === 'posting-api' && segments[1] === 'job-board'
        ? segments[2]
        : undefined;
  const token = raw ? boardTokenOf('ashby', raw) : null;
  if (token)
    return { ref: { provider: 'ashby', boardToken: token, apiBase: getAdapter('ashby').apiBases.default } };
  return { error: ATS_BOARD_HOST.test(host) ? 'invalid' : 'not_ats' };
}

const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Ashby serves a board whose name has single spaces (checked live, OPS-1b repair). */
const ASHBY_TOKEN_PATTERN = /^(?=.{1,100}$)[A-Za-z0-9][A-Za-z0-9._-]*(?: [A-Za-z0-9._-]+)*$/;

/**
 * A board token as written in a file or URL, or null when no board can have it. An Ashby token is
 * percent-decoded first (`blackpoint%20cyber` is the board `blackpoint cyber`); other providers'
 * tokens are taken as written. A decoded token is never trimmed or collapsed: an outer or double
 * space names another board, so it is refused.
 */
export function boardTokenOf(provider: AtsProvider, raw: string): string | null {
  if (provider !== 'ashby') return TOKEN_PATTERN.test(raw) ? raw : null;
  let token: string;
  try {
    token = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return ASHBY_TOKEN_PATTERN.test(token) ? token : null;
}

/**
 * The source key of a board (`provider:token`, or `provider:region:token` off the default host),
 * token lowercased: providers treat tokens case-insensitively. The board's `ats` external id is
 * this key, so the two always agree on the region.
 *
 * @throws Error when `apiBase` is not one of the provider's known API hosts.
 */
export function boardKeyOf(provider: AtsProvider, boardToken: string, apiBase?: string | null): string {
  return boardSourceIdentity(getAdapter(provider), boardToken, apiBase).key;
}

/**
 * A board file names companies: it is never official evidence (OPS-1b repair M1). Only
 * `third_party` is accepted; the company reconciler also reads its rows as `third_party`.
 *
 * @throws AppError validation_failed for any other tier.
 */
export function assertBoardFileAuthority(tier: string): void {
  if (tier !== BOARD_FILE_AUTHORITY)
    throw new AppError(
      'validation_failed',
      `An ATS board file cannot have ${tier} authority: it names companies and boards, but it is never the employer or a register (use ${BOARD_FILE_AUTHORITY})`,
      { param: 'authority.tier', allowed: [BOARD_FILE_AUTHORITY] },
    );
}
export const BOARD_FILE_AUTHORITY = 'third_party' as const;

/** The source's stored config (defaults applied). Strict, and no mapped column may name personal data. */
export function parseBoardDirectoryConfig(config: unknown): AtsBoardDirectoryConfig {
  const r = atsBoardDirectoryConfigSchema.safeParse(config);
  if (!r.success)
    throw new AppError(
      'validation_failed',
      `Invalid ATS board file configuration: ${r.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    );
  const personal = boardDirectoryColumns(r.data).filter(isPersonalDataColumn);
  if (personal.length)
    throw new AppError(
      'validation_failed',
      `Invalid ATS board file configuration: ${personal.length} mapped column(s) name personal data`,
      { problems: personalColumnProblems(personal) },
    );
  return r.data;
}

export function boardDirectoryConfigOf(source: {
  provider: string;
  acquisition: { config: unknown };
}): AtsBoardDirectoryConfig {
  if (source.provider !== ATS_BOARD_DIRECTORY_PROVIDER)
    throw new AppError('validation_failed', `Source provider ${source.provider} is not an ATS board file`);
  return parseBoardDirectoryConfig(source.acquisition.config);
}

/** Same checks as M8.1 before storage: size, type, UTF-8, row count, header and personal-data guard. */
export function checkBoardDirectoryUpload(
  config: AtsBoardDirectoryConfig,
  body: Uint8Array | string,
  mimeType: string,
): DirectoryUploadProblem[] {
  return checkCsvUpload(
    { mapped: boardDirectoryColumns(config), maxBytes: config.maxBytes, maxRows: config.maxRows },
    body,
    mimeType,
  );
}

export interface BoardRow {
  line: number;
  locator: string;
  provider: AtsProvider;
  boardToken: string;
  apiBase: string;
  region: string;
  /** Source key of the board (`provider:token` or `provider:region:token`). */
  key: string;
  company: string | null;
  domain: string | null;
  /** A dropped URL cell (the row kept its board from provider and token). */
  warning?: BoardRowWarning;
}

export interface BoardRowError {
  line: number;
  code:
    | 'malformed_row'
    | 'missing_board'
    | 'missing_provider'
    | 'unknown_provider'
    | 'missing_token'
    | 'invalid_token'
    | 'missing_company'
    | 'invalid_company'
    | 'contact_value'
    | 'invalid_domain'
    | 'invalid_url'
    | 'url_mismatch'
    | 'value_too_long'
    | 'duplicate_row_key';
  column?: string;
  /** A fixed explanation: never cell text (the raw snapshot holds the file). */
  message: string;
}

/**
 * A row problem that does not fail the row. `not_an_ats_url`: the URL is not a Greenhouse, Ashby
 * or Lever board (discovery evidence only; the raw snapshot keeps it). `skipped`: the row had no
 * other board, so nothing was imported from it.
 */
export interface BoardRowWarning {
  line: number;
  code: 'not_an_ats_url';
  column?: string;
  message: string;
  skipped: boolean;
}

export interface BoardDirectoryPlan {
  rowCount: number;
  rows: BoardRow[];
  errors: BoardRowError[];
  warnings: BoardRowWarning[];
  headerProblems: DirectoryUploadProblem[];
}

/** `legacy`: the M8.2 rules (runs pinned to the first workflow version). */
export interface BoardPlanOptions {
  legacy?: boolean;
}

const ROW_BUDGET = 100_000;

const cell = (row: Record<string, string>, column: string | undefined): string | null => {
  if (!column) return null;
  const v = (row[column] ?? '').replace(/\s+/g, ' ').trim();
  return v && !isPlaceholder(v) ? v : null;
};

function mapBoardRow(
  config: AtsBoardDirectoryConfig,
  row: Record<string, string>,
  line: number,
): BoardRow | BoardRowError | BoardRowWarning {
  const c = config.columns;
  const fail = (code: BoardRowError['code'], message: string, column?: string): BoardRowError => ({
    line,
    code,
    message,
    ...(column ? { column } : {}),
  });
  for (const column of boardDirectoryColumns(config))
    if ((row[column] ?? '').length > MAX_VALUE_CHARS)
      return fail('value_too_long', `the value is longer than ${MAX_VALUE_CHARS} characters`, column);

  // The URL first: it may supply the provider and token (OPS-1b).
  let fromUrl: AtsBoardRef | null = null;
  let warning: BoardRowWarning | null = null;
  const url = cell(row, c.url);
  if (url) {
    if (urlHasContactValue(url)) return fail('contact_value', 'the URL holds a contact value', c.url);
    const r = boardRefFromUrl(url);
    if ('ref' in r) fromUrl = r.ref;
    else if (r.error === 'invalid')
      return fail('invalid_url', 'the URL is not a Greenhouse, Ashby or Lever board URL', c.url);
    else
      warning = {
        line,
        code: 'not_an_ats_url',
        message:
          'the URL is not a Greenhouse, Ashby or Lever board or job URL (kept as discovery evidence only)',
        skipped: false,
        ...(c.url ? { column: c.url } : {}),
      };
  }

  const providerCell = cell(row, c.provider);
  const tokenCell = cell(row, c.token);
  // The token as written: `cell` collapses inner spaces, which would change an Ashby board name.
  const tokenRaw = c.token ? (row[c.token] ?? '').trim() : '';
  if (!providerCell && !tokenCell && !fromUrl) {
    // Only a URL on another host: nothing to import, and not an error.
    if (warning) return { ...warning, skipped: true };
    if (!c.provider && !c.token) return fail('missing_board', 'the row has no board URL', c.url);
  }

  let ats: AtsProvider;
  if (providerCell) {
    const provider = providerCell.toLowerCase();
    if (!(ATS_PROVIDERS as readonly string[]).includes(provider))
      return fail('unknown_provider', `the provider must be one of ${ATS_PROVIDERS.join(', ')}`, c.provider);
    ats = provider as AtsProvider;
  } else if (fromUrl) ats = fromUrl.provider;
  else return fail('missing_provider', 'the provider is empty', c.provider);

  let token: string;
  if (tokenCell) {
    const t = boardTokenOf(ats, tokenRaw);
    if (!t) return fail('invalid_token', 'the board token has characters a board token cannot have', c.token);
    token = t;
  } else if (fromUrl) token = fromUrl.boardToken;
  else return fail('missing_token', 'the board token is empty', c.token);

  let apiBase: string | null = null;
  if (fromUrl) {
    if (fromUrl.provider !== ats || fromUrl.boardToken.toLowerCase() !== token.toLowerCase())
      return fail('url_mismatch', 'the URL names a different provider or board token than the row', c.url);
    apiBase = fromUrl.apiBase;
  }

  let domain: string | null = null;
  const domainCell = cell(row, c.domain);
  if (domainCell) {
    const d = directoryDomain(domainCell);
    domain = 'domain' in d ? companyDomain(d.domain) : null;
    if (!domain) return fail('invalid_domain', 'the domain is not a company domain', c.domain);
  }

  let company: string | null = null;
  const companyCell = cell(row, c.company);
  if (companyCell) {
    const v = canonicalText(companyCell);
    if (v === null || v.length > MAX_VALUE_CHARS)
      return fail('invalid_company', 'the company name could not be read', c.company);
    // Same fail-closed contact rule as an M8.1 name cell.
    if (contactValueVerdict([v, companyCell], { digitRuns: true, handles: true }) !== 'none')
      return fail(
        'contact_value',
        'the cell holds a contact value (an email address or phone number)',
        c.company,
      );
    company = v;
  }
  // Since OPS-1b a row with neither is still read: a known board needs no company, and
  // processing fails any other such row with `no_identity`.

  const identity = boardSourceIdentity(getAdapter(ats), token, apiBase);
  return {
    line,
    locator: `row:${line}`,
    provider: ats,
    boardToken: token,
    apiBase: identity.apiBase,
    region: identity.region,
    // Providers treat board tokens case-insensitively, so ZZShared and zzshared are one board.
    key: boardKeyOf(ats, token, apiBase),
    company,
    domain,
    ...(warning ? { warning } : {}),
  };
}

/** The M8.2 row rules, unchanged: a run pinned to workflow version 1 replays them exactly. */
function mapBoardRowV1(
  config: AtsBoardDirectoryConfig,
  row: Record<string, string>,
  line: number,
): BoardRow | BoardRowError {
  const c = config.columns;
  const fail = (code: BoardRowError['code'], message: string, column?: string): BoardRowError => ({
    line,
    code,
    message,
    ...(column ? { column } : {}),
  });
  for (const column of boardDirectoryColumns(config))
    if ((row[column] ?? '').length > MAX_VALUE_CHARS)
      return fail('value_too_long', `the value is longer than ${MAX_VALUE_CHARS} characters`, column);

  const providerCell = cell(row, c.provider);
  if (!providerCell) return fail('missing_provider', 'the provider is empty', c.provider);
  const provider = providerCell.toLowerCase();
  if (!(ATS_PROVIDERS as readonly string[]).includes(provider))
    return fail('unknown_provider', `the provider must be one of ${ATS_PROVIDERS.join(', ')}`, c.provider);
  const ats = provider as AtsProvider;

  const token = cell(row, c.token);
  if (!token) return fail('missing_token', 'the board token is empty', c.token);
  if (!TOKEN_PATTERN.test(token))
    return fail('invalid_token', 'the board token has characters a board token cannot have', c.token);

  let apiBase: string | null = null;
  const url = cell(row, c.url);
  if (url) {
    if (urlHasContactValue(url)) return fail('contact_value', 'the URL holds a contact value', c.url);
    const ref = detectAtsFromUrl(url);
    if (!ref) return fail('invalid_url', 'the URL is not a Greenhouse, Ashby or Lever board URL', c.url);
    if (ref.provider !== ats || ref.boardToken.toLowerCase() !== token.toLowerCase())
      return fail('url_mismatch', 'the URL names a different provider or board token than the row', c.url);
    apiBase = ref.apiBase;
  }

  let domain: string | null = null;
  const domainCell = cell(row, c.domain);
  if (domainCell) {
    const d = directoryDomain(domainCell);
    domain = 'domain' in d ? companyDomain(d.domain) : null;
    if (!domain) return fail('invalid_domain', 'the domain is not a company domain', c.domain);
  }

  let company: string | null = null;
  const companyCell = cell(row, c.company);
  if (companyCell) {
    const v = canonicalText(companyCell);
    if (v === null || v.length > MAX_VALUE_CHARS)
      return fail('invalid_company', 'the company name could not be read', c.company);
    // Same fail-closed contact rule as an M8.1 name cell.
    if (contactValueVerdict([v, companyCell], { digitRuns: true, handles: true }) !== 'none')
      return fail(
        'contact_value',
        'the cell holds a contact value (an email address or phone number)',
        c.company,
      );
    company = v;
  }
  if (!company && !domain)
    return fail('missing_company', 'the row has neither a company name nor a domain', c.company ?? c.domain);

  const identity = boardSourceIdentity(getAdapter(ats), token, apiBase);
  return {
    line,
    locator: `row:${line}`,
    provider: ats,
    boardToken: token,
    apiBase: identity.apiBase,
    region: identity.region,
    // Providers treat board tokens case-insensitively, so ZZShared and zzshared are one board.
    key: boardKeyOf(ats, token, apiBase),
    company,
    domain,
  };
}

/** Read a board file: one `BoardRow` per valid row, a row error for every other row. */
export function planBoardDirectory(
  config: AtsBoardDirectoryConfig,
  text: string,
  opts: BoardPlanOptions = {},
): BoardDirectoryPlan {
  const errors: BoardRowError[] = [];
  const warnings: BoardRowWarning[] = [];
  const raw: Array<{ line: number; row: Record<string, string> }> = [];
  const { header, records, headerProblem } = readCsv(
    text,
    (record, columns) => {
      if (raw.length + errors.length >= config.maxRows) return;
      const row: Record<string, string> = {};
      columns.forEach((h, k) => (row[h] = record.fields[k] ?? ''));
      raw.push({ line: record.line, row });
    },
    (problem) => {
      if (problem.message.startsWith('header: ') || raw.length + errors.length >= config.maxRows) return;
      errors.push({ line: problem.line, code: 'malformed_row', message: problem.message });
    },
    { maxFieldChars: MAX_VALUE_CHARS },
  );
  const rows: BoardRow[] = [];
  const firstLine = new Map<string, number>();
  for (const { line, row } of raw) {
    beginRow(ROW_BUDGET);
    let r: BoardRow | BoardRowError | BoardRowWarning;
    try {
      r = opts.legacy ? mapBoardRowV1(config, row, line) : mapBoardRow(config, row, line);
    } finally {
      endRow();
    }
    if ('skipped' in r) {
      warnings.push(r);
      continue;
    }
    if (!('key' in r)) {
      errors.push(r);
      continue;
    }
    const { warning, ...board } = r;
    if (warning) warnings.push(warning);
    const first = firstLine.get(r.key);
    if (first !== undefined) {
      errors.push({
        line,
        code: 'duplicate_row_key',
        message: `the same board as row ${first} (the first occurrence is imported)`,
      });
      continue;
    }
    firstLine.set(r.key, line);
    rows.push(board);
  }
  errors.sort((a, b) => a.line - b.line);
  return {
    rowCount: records,
    rows,
    errors,
    warnings,
    headerProblems: checkCsvHeader(boardDirectoryColumns(config), header ?? [], headerProblem),
  };
}
