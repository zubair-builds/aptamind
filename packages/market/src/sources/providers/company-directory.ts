import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '@aptamind/contracts';
import { normalizeCountry } from '@aptamind/taxonomy';
import type { CompanyObservationPayload } from '../../contracts/observations';
import { companyObservationPayloadSchema } from '../../contracts/observations';
import {
  EXTERNAL_ID_NAMESPACES,
  idsContradict,
  normalizeExternalId,
  ROW_IDENTITY_NAMESPACES,
  ATS_ID_NAMESPACE,
} from '../../companies/external-ids';
import { splitTradingName, strictNameKey } from '../../companies/normalize';
import { beginRow, endRow } from './contact-grammar';
import { isPersonalDataColumn } from './directory-headers';
import {
  directoryDomain,
  contactValueVerdict,
  hasContactValue,
  hasDigit,
  hasInvisibleCodePoint,
  canonicalText,
  isPlaceholder,
  isProfileUrl,
  isRegistrableHost,
  isPlaceholderId,
  isPlaceholderTown,
  type RefusedDomainReason,
  reduceUrlCell,
  storedValueHasContact,
  urlHasContactValue,
} from './directory-values';

/**
 * Company directory import (M8.1): an operator-supplied CSV of companies (name, domain, website,
 * country, register ids, careers URL) with a configurable column map. Every row goes through
 * source → snapshot → observation → resolution → reconciliation with provenance (`row:<n>`
 * locators into the stored snapshot); the source's authority tier is the evidence authority.
 *
 * Privacy: only company fields are read. The upload is refused BEFORE storage when its header
 * has a column outside the column map (unless explicitly allowed) or a column that names
 * personal data (contacts, emails, phones, people), so no personal data reaches the snapshot.
 */

export const COMPANY_DIRECTORY_PROVIDER = 'company_directory';
/** The only workflow a company-directory source runs (it is upload-only). */
export const COMPANY_DIRECTORY_WORKFLOW = 'market.company_directory.import';

/**
 * Authority of a directory source (DECISION_LOG "Company directory imports"): `third_party` by
 * default. `operator` and `inferred` are refused (a bulk upload must never tie with a human
 * decision, and it is a statement, not an inference); `official_registry` is deferred to the
 * register providers (M8.4) and refused here for now.
 */
export const DIRECTORY_DEFAULT_AUTHORITY = 'third_party' as const;
export const DIRECTORY_REFUSED_AUTHORITIES = ['operator', 'inferred', 'official_registry'] as const;

export function assertDirectoryAuthority(tier: string): void {
  if ((DIRECTORY_REFUSED_AUTHORITIES as readonly string[]).includes(tier))
    throw new AppError(
      'validation_failed',
      tier === 'official_registry'
        ? 'A company directory cannot have official_registry authority (register exports are the register providers, M8.4)'
        : `A company directory cannot have ${tier} authority (use third_party, official_site or official_ats)`,
      { param: 'authority.tier', refused: [...DIRECTORY_REFUSED_AUTHORITIES] },
    );
}
export const COMPANY_DIRECTORY_PARSER = { name: 'company-directory-row', version: '1' } as const;

/**
 * External-id namespaces other providers own, with their own id formats: a directory can never
 * assert identifiers in them (it would claim another source's identity keys). `ats` is asserted
 * only by the known-board import, after a successful fetch of the board (OPS-1b).
 */
export const RESERVED_ID_NAMESPACES = [...ROW_IDENTITY_NAMESPACES, ATS_ID_NAMESPACE] as const;

/** Hard ceilings; a source may configure lower limits. */
export const DIRECTORY_MAX_BYTES = 50 * 1024 * 1024;
export const DIRECTORY_MAX_ROWS = 200_000;

export const companyDirectoryConfigSchema = z.strictObject({
  /** CSV header name per company field. `name` is required; the others are optional. */
  columns: z.strictObject({
    name: z.string().min(1),
    legalName: z.string().min(1).optional(),
    domain: z.string().min(1).optional(),
    website: z.string().min(1).optional(),
    country: z.string().min(1).optional(),
    careersUrl: z.string().min(1).optional(),
    /** The company's town or city (its head-office location with `country`). */
    town: z.string().min(1).optional(),
    /** A stable row id in the file (preferred record key). */
    id: z.string().min(1).optional(),
    /**
     * Register identifiers: namespace → column. Namespaces come from the Market registry
     * (`EXTERNAL_ID_NAMESPACES`, e.g. `gb_companies_house`, `lei`); any other is refused.
     */
    registerIds: z
      .record(z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), z.string().min(1))
      .default({})
      .refine(
        (ids) => !Object.keys(ids).some((ns) => (RESERVED_ID_NAMESPACES as readonly string[]).includes(ns)),
        {
          message: `a register-id namespace belongs to another provider (${RESERVED_ID_NAMESPACES.join(', ')})`,
        },
      )
      .refine((ids) => Object.keys(ids).every((ns) => Object.hasOwn(EXTERNAL_ID_NAMESPACES, ns)), {
        message: `unknown register-id namespace (known: ${Object.keys(EXTERNAL_ID_NAMESPACES).join(', ')})`,
      }),
  }),
  /** ISO-2 country for rows without a country column/value (`UK` is stored as `GB`). */
  defaultCountry: z
    .string()
    .length(2)
    .transform((v, ctx) => {
      const code = normalizeCountry(v);
      if (!code) ctx.addIssue({ code: 'custom', message: `"${v}" is not an ISO 3166-1 alpha-2 country` });
      return code ?? v;
    })
    .optional(),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(DIRECTORY_MAX_BYTES)
    .default(10 * 1024 * 1024),
  maxRows: z.number().int().positive().max(DIRECTORY_MAX_ROWS).default(50_000),
});
export type CompanyDirectoryConfig = z.infer<typeof companyDirectoryConfigSchema>;

/**
 * A company-directory source's column map and limits (its `acquisition.config`), strict: unknown
 * keys are refused (there is no `ignoreColumns`: every column of a file is mapped), and no mapped
 * column may name personal data. The parsed value
 * (defaults applied) is what the source stores.
 */
export function parseDirectoryConfig(config: unknown): CompanyDirectoryConfig {
  const r = companyDirectoryConfigSchema.safeParse(config);
  if (r.success) {
    const personal = mappedColumns(r.data).filter(isPersonalDataColumn);
    if (personal.length)
      throw new AppError(
        'validation_failed',
        `Invalid company directory configuration: ${personal.length} mapped column(s) name personal data; a directory reads company data only`,
        { problems: personalColumnProblems(personal) },
      );
    return r.data;
  }
  throw new AppError(
    'validation_failed',
    `Invalid company directory configuration: ${r.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')}`,
  );
}

export function directoryConfigOf(source: {
  provider: string;
  acquisition: { config: unknown };
}): CompanyDirectoryConfig {
  if (source.provider !== COMPANY_DIRECTORY_PROVIDER)
    throw new AppError(
      'invalid_state',
      `Source provider ${source.provider} is not ${COMPANY_DIRECTORY_PROVIDER}`,
    );
  return parseDirectoryConfig(source.acquisition.config);
}

export { headerWords, isPersonalDataColumn } from './directory-headers';

export interface DirectoryUploadProblem {
  code:
    | 'too_large'
    | 'too_many_rows'
    | 'not_csv'
    | 'not_utf8'
    | 'malformed_header'
    | 'no_header'
    | 'duplicate_column'
    | 'missing_column'
    | 'unmapped_column'
    | 'personal_data_column';
  message: string;
  /** A configured column name, or `column N` for header text that is not configured. */
  column?: string;
  /** 1-based column number in the header (absent for a missing column). */
  position?: number;
}

const COLUMN_NAME_MAX = 64;

/**
 * Config-level personal-data problems, one per configured column, named by that column (an
 * operator-typed config value, never file content): trimmed, at most 64 code points.
 */
export function personalColumnProblems(columns: string[]) {
  return columns.map((c) => ({
    code: 'personal_data_column' as const,
    column: [...c.trim()].slice(0, COLUMN_NAME_MAX).join(''),
    count: columns.length,
  }));
}

export interface CsvRecord {
  /** Physical 1-based line where the record starts (the header is line 1). */
  line: number;
  fields: string[];
}

export interface CsvProblem {
  line: number;
  message: string;
}

/** Most header columns a file may have. */
export const MAX_CSV_COLUMNS = 1000;

const QUOTE = 34; // "
const COMMA = 44; // ,
const LF = 10;
const CR = 13;
const SPACE = 32;
const TAB = 9;

/** Line breaks in src[from, to): CRLF counts once, a lone CR or LF counts once. */
function lineBreaks(src: string, from: number, to: number): number {
  let n = 0;
  for (let k = from; k < to; k++) {
    const c = src.charCodeAt(k);
    if (c === LF) n++;
    else if (c === CR && src.charCodeAt(k + 1) !== LF) n++;
  }
  return n;
}

/**
 * A strict RFC 4180 reader (comma, `"` quoting, `""` escapes, CRLF/LF/CR line ends, UTF-8 BOM).
 * Records are streamed to `onRecord`; blank lines are skipped. A record that is malformed (a quote
 * inside an unquoted field — `a"b`, ` "x"` —, text after a closing quote, an unterminated quote,
 * a wrong field count) is reported to `onProblem` and not emitted, so it can never be imported
 * with shifted columns. Fields are built from slices of the input (no per-character
 * concatenation); with `materialize: false` data fields are not built at all (counting only).
 * Returns the header, the record count (malformed records included) and the header's own problem.
 */
export function readCsv(
  text: string,
  onRecord: (record: CsvRecord, header: string[]) => void,
  onProblem: (problem: CsvProblem) => void,
  opts: { materialize?: boolean; maxFieldChars?: number } = {},
): { header: string[] | null; records: number; headerProblem: string | null } {
  const materialize = opts.materialize ?? true;
  // A data field longer than this is handed on cut to `maxFieldChars + 1` characters (not
  // unescaped): enough for the caller to see it is too long, without building a huge string.
  const maxField = opts.maxFieldChars ?? Infinity;
  const src = text;
  const n = src.length;
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  let header: string[] | null = null;
  let headerProblem: string | null = null;
  let records = 0;
  let line = 1;
  while (i < n) {
    const startLine = line;
    const build = materialize || header === null;
    // Never more fields than the header has (plus one, to detect the mismatch) or than
    // `MAX_CSV_COLUMNS` in the header: a row of millions of commas costs no array of millions.
    const fieldCap = header === null ? MAX_CSV_COLUMNS + 1 : header.length + 1;
    const fields: string[] = [];
    let count = 0;
    let problem: string | null = null;
    let blank = true;
    for (;;) {
      let value = '';
      if (i < n && src.charCodeAt(i) === QUOTE) {
        blank = false;
        i++;
        const start = i;
        let end = n;
        let escaped = false;
        let closed = false;
        // Find the closing quote (a doubled quote is an escape), then take ONE slice.
        while (i < n) {
          const q = src.indexOf('"', i);
          if (q === -1) break;
          if (src.charCodeAt(q + 1) === QUOTE) {
            escaped = true;
            i = q + 2;
            continue;
          }
          end = q;
          i = q + 1;
          closed = true;
          break;
        }
        line += lineBreaks(src, start, end);
        if (!closed) {
          i = n;
          problem ??= 'unterminated quoted field';
        }
        if (build && fields.length < fieldCap) {
          if (header !== null && end - start > maxField) value = src.slice(start, start + maxField + 1);
          else {
            value = src.slice(start, end);
            if (escaped) value = value.replaceAll('""', '"');
          }
        }
        if (i < n) {
          const c = src.charCodeAt(i);
          if (c !== COMMA && c !== LF && c !== CR) {
            problem ??= 'unexpected text after a closing quote';
            while (i < n) {
              const d = src.charCodeAt(i);
              if (d === COMMA || d === LF || d === CR) break;
              i++;
            }
          }
        }
      } else {
        let j = i;
        while (j < n) {
          const c = src.charCodeAt(j);
          if (c === COMMA || c === LF || c === CR) break;
          if (c === QUOTE) {
            blank = false;
            problem ??= 'a quote inside an unquoted field (quote the whole field and double the quote)';
          } else if (c !== SPACE && c !== TAB) blank = false;
          j++;
        }
        if (build && fields.length < fieldCap)
          value = header !== null && j - i > maxField ? src.slice(i, i + maxField + 1) : src.slice(i, j);
        i = j;
      }
      if (build && fields.length < fieldCap) fields.push(value);
      count++;
      if (i >= n) break;
      const c = src.charCodeAt(i);
      if (c === COMMA) {
        blank = false;
        i++;
        continue;
      }
      // Record end: CRLF, LF or a lone CR.
      i += c === CR && src.charCodeAt(i + 1) === LF ? 2 : 1;
      line++;
      break;
    }
    if (blank && !problem) continue;
    if (header === null) {
      header = fields.map((f) => f.trim());
      if (count > MAX_CSV_COLUMNS) problem ??= `more than ${MAX_CSV_COLUMNS} columns`;
      if (problem) {
        headerProblem = problem;
        onProblem({ line: startLine, message: `header: ${problem}` });
      }
      continue;
    }
    records++;
    if (!problem && count !== header.length) problem = `expected ${header.length} fields, found ${count}`;
    if (problem) onProblem({ line: startLine, message: problem });
    else if (materialize) onRecord({ line: startLine, fields }, header);
  }
  return { header, records, headerProblem };
}

/** Header and record count of a CSV text, without building the data fields (see `readCsv`). */
export function csvShape(text: string): {
  header: string[];
  records: number;
  malformed: number;
  headerProblem: string | null;
} {
  let malformed = 0;
  const { header, records, headerProblem } = readCsv(
    text,
    () => undefined,
    () => void malformed++,
    { materialize: false },
  );
  return { header: header ?? [], records, malformed: malformed - (headerProblem ? 1 : 0), headerProblem };
}

/** The columns a config reads. */
export function mappedColumns(config: CompanyDirectoryConfig): string[] {
  const c = config.columns;
  return [
    c.name,
    c.legalName,
    c.domain,
    c.website,
    c.country,
    c.careersUrl,
    c.town,
    c.id,
    ...Object.values(c.registerIds),
  ].filter((x): x is string => !!x);
}

/**
 * Header problems: required columns, duplicates, unmapped columns and personal-data columns.
 * The refusal (a 400 body) never echoes header text that is not a configured mapped or ignored
 * column name: unmapped and personal-data columns are named by position only (`column 3`) — a
 * header cell may be a person's name or email (a file without a header row).
 */
export function checkDirectoryHeader(
  config: CompanyDirectoryConfig,
  header: string[],
  headerProblem: string | null = null,
): DirectoryUploadProblem[] {
  return checkCsvHeader(mappedColumns(config), header, headerProblem);
}

/** `checkDirectoryHeader` for any strict CSV provider: `mapped` is every column the file may hold. */
export function checkCsvHeader(
  mapped: string[],
  header: string[],
  headerProblem: string | null = null,
): DirectoryUploadProblem[] {
  if (!header.some((h) => h)) return [{ code: 'no_header', message: 'the file has no header row' }];
  const problems: DirectoryUploadProblem[] = [];
  if (headerProblem)
    problems.push({ code: 'malformed_header', message: `the header row is malformed: ${headerProblem}` });
  // Every column of an accepted file is mapped (no ignoreColumns, DECISION_LOG re-verification #5),
  // so every cell passes the value policy; the header guard is defence in depth.
  const configured = new Set(mapped);
  const position = new Map<string, number>();
  header.forEach((column, k) => {
    if (!position.has(column)) position.set(column, k + 1);
  });
  const byPosition = (column: string) => `column ${position.get(column)}`;
  const seen = new Set<string>();
  header.forEach((column, k) => {
    if (seen.has(column)) {
      const label = configured.has(column) ? column : `column ${k + 1}`;
      problems.push({
        code: 'duplicate_column',
        column: label,
        position: k + 1,
        message: `${label} appears more than once`,
      });
    }
    seen.add(column);
  });
  for (const column of mapped)
    if (!seen.has(column))
      problems.push({
        code: 'missing_column',
        column,
        message: `mapped column "${column}" is not in the header`,
      });
  for (const column of seen) {
    if (isPersonalDataColumn(column) || hasContactValue(column))
      problems.push({
        code: 'personal_data_column',
        column: byPosition(column),
        position: position.get(column),
        message: `${byPosition(column)} looks like personal data; remove it before uploading`,
      });
    else if (!configured.has(column))
      problems.push({
        code: 'unmapped_column',
        column: byPosition(column),
        position: position.get(column),
        message: `${byPosition(column)} is not mapped; remove it from the file (every column must be mapped)`,
      });
  }
  return problems;
}

const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });

/**
 * Checks an upload BEFORE it is stored: size first (without decoding), then content type, row
 * count and header. Returns every problem found (empty = accept).
 */
export function checkDirectoryUpload(
  config: CompanyDirectoryConfig,
  body: Uint8Array | string,
  mimeType: string,
): DirectoryUploadProblem[] {
  return checkCsvUpload(
    { mapped: mappedColumns(config), maxBytes: config.maxBytes, maxRows: config.maxRows },
    body,
    mimeType,
  );
}

/** `checkDirectoryUpload` for any strict CSV provider (M8.1 and M8.2 share one reader and guard). */
export function checkCsvUpload(
  config: { mapped: string[]; maxBytes: number; maxRows: number },
  body: Uint8Array | string,
  mimeType: string,
): DirectoryUploadProblem[] {
  const bytes = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength;
  if (bytes > config.maxBytes)
    return [
      {
        code: 'too_large',
        message: `the file is ${bytes} bytes; this source accepts at most ${config.maxBytes}`,
      },
    ];
  const mime = mimeType.split(';')[0]!.trim().toLowerCase();
  if (!['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel'].includes(mime))
    return [{ code: 'not_csv', message: `content type ${mimeType} is not CSV (send text/csv)` }];
  let text: string;
  try {
    // Fatal decoding: a byte sequence that is not UTF-8 is refused, never replaced with U+FFFD.
    text = typeof body === 'string' ? body : UTF8_FATAL.decode(body);
  } catch {
    return [{ code: 'not_utf8', message: 'the file is not UTF-8 text (export it as CSV UTF-8)' }];
  }
  const { header, records, headerProblem } = csvShape(text);
  const problems: DirectoryUploadProblem[] = [];
  if (records > config.maxRows)
    problems.push({
      code: 'too_many_rows',
      message: `the file has ${records} rows; this source accepts at most ${config.maxRows}`,
    });
  return [...problems, ...checkCsvHeader(config.mapped, header, headerProblem)];
}

export interface DirectoryRowError {
  /** Physical 1-based line where the row starts (the header is line 1): what a spreadsheet shows. */
  line: number;
  code:
    | 'malformed_row'
    | 'missing_name'
    | 'invalid_name'
    | 'value_too_long'
    | 'contact_value'
    | 'contact_value_undecidable'
    | 'invalid_domain'
    | 'invalid_website'
    | 'invalid_careers_url'
    | 'invalid_country'
    | 'invalid_town'
    | 'unknown_id_namespace'
    | 'invalid_external_id'
    | 'duplicate_row_key'
    | 'conflicting_external_id'
    | 'invalid_payload';
  /** The CSV column (a header name from the column map), when the error is about one cell. */
  column?: string;
  /**
   * A fixed explanation for the code: it never contains cell text (DECISION_LOG "Company
   * directory import hardening": only the raw uploaded snapshot holds cell text).
   */
  message: string;
}

/** Longest value a mapped cell may hold (a row error beyond it). */
export const MAX_VALUE_CHARS = 2000;

export interface DirectoryCandidate {
  externalId: string;
  locator: string;
  payload: CompanyObservationPayload;
  /** Resolve this row to a high-severity review (see `DIRECTORY_REVIEW_REASONS`). */
  review?: keyof typeof DIRECTORY_REVIEW_REASONS;
}

/** Why a directory row goes to review whatever the evidence (the review's reason). */
export const DIRECTORY_REVIEW_REASONS = {
  conflicting_ids_in_file:
    'Rows of this file share this company name and country but carry different ids in one register: one company has one id per register, so they are not resolved automatically',
} as const;

/** A mapped cell's text (whitespace collapsed), or null when empty or a placeholder (`-`, `n/a`, …). */
const str = (row: Record<string, unknown>, column: string | undefined): string | null => {
  if (!column) return null;
  const v = row[column];
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s && !isPlaceholder(s) ? s : null;
};

const REFUSED_DOMAIN_MESSAGE: Record<RefusedDomainReason, string> = {
  personal_email: 'the domain is a personal email provider, not a company domain',
  shared_hosting:
    'the domain is a shared hosting, site-builder or social platform host, not a company domain',
  reserved: 'the domain is a reserved, example or test domain',
  platform: 'the domain is a platform (job board, social network), not a company domain',
  not_a_domain: 'the value is not a domain',
};

/**
 * The record key of a row's own id cell: `id:` + SHA-256 (hex, 128 bits) of the source id and the
 * normalised value (NFKC, whitespace collapsed; not case-folded: `R-1` and `r-1` differ). The raw id is never stored
 * (DECISION_LOG re-verification #5 item 3); the row number stays the operator's trace.
 */
export function fileIdKey(sourceId: string, value: string): string {
  const normalised = value.normalize('NFKC').replace(/\s+/g, ' ').trim(); // not case-folded
  return `id:${createHash('sha256').update(`${sourceId}\u0000${normalised}`).digest('hex').slice(0, 32)}`;
}

/**
 * A cell of an OPTIONAL column dropped from an imported row (DECISION_LOG re-verification #6): the
 * row is kept without it. Carries the code, the column and the row number only — never cell text.
 */
export interface DirectoryRowWarning {
  line: number;
  code:
    | 'contact_value'
    | 'value_too_long'
    | 'invalid_name'
    | 'invalid_domain'
    | 'invalid_website'
    | 'invalid_careers_url'
    | 'url_reduced_to_origin'
    | 'value_normalised'
    | 'profile_url'
    | 'invalid_country'
    | 'invalid_town'
    | 'unknown_id_namespace'
    | 'invalid_external_id';
  column: string;
  message: string;
}

/**
 * The work budget of one row, in grammar units (DECISION_LOG 47c0f5c): shared by every detector
 * call while the row is mapped; once it is spent, the rest of the row is undecidable (optional
 * cells dropped, a name refuses the row with `contact_value_undecidable`). Sized so the costliest
 * row stays well within 100 ms; the wall-clock perf tests are a regression check on top.
 */
export const DIRECTORY_ROW_BUDGET = 100_000;

/** Maps one row (starting at file `line`) to a company candidate (with dropped-cell warnings), or a row error. */
export function mapDirectoryRow(
  config: CompanyDirectoryConfig,
  row: Record<string, unknown>,
  line: number,
  sourceId = '',
  rowBudget = DIRECTORY_ROW_BUDGET,
): { candidate: DirectoryCandidate; warnings: DirectoryRowWarning[] } | { error: DirectoryRowError } {
  beginRow(rowBudget);
  try {
    return mapRow(config, row, line, sourceId);
  } finally {
    endRow();
  }
}

function mapRow(
  config: CompanyDirectoryConfig,
  row: Record<string, unknown>,
  line: number,
  sourceId: string,
): { candidate: DirectoryCandidate; warnings: DirectoryRowWarning[] } | { error: DirectoryRowError } {
  const c = config.columns;
  const fail = (code: DirectoryRowError['code'], message: string, column?: string) => ({
    error: { line, code, message, ...(column ? { column } : {}) },
  });
  const warnings: DirectoryRowWarning[] = [];
  /** Kept cells stored in a canonical form that differs from the cell as written. */
  const normalisedCells = new Set<string>();
  // Drop an optional cell: the row is kept without it; the warning names the column only.
  const drop = (code: DirectoryRowWarning['code'], message: string, column: string): null => {
    normalisedCells.delete(column); // a dropped cell is reported as dropped, not normalised
    warnings.push({ line, code, column, message: `the cell was dropped: ${message}` });
    return null;
  };
  const tooLong = (column: string | undefined) => {
    const v = column ? row[column] : undefined;
    return typeof v === 'string' && v.length > MAX_VALUE_CHARS;
  };
  const CONTACT = 'it holds a contact value (an email address, phone number, contact URI or URL credentials)';
  /**
   * A text cell in its canonical form (DECISION_LOG 64d97b4): what is checked, stored and keyed.
   * `normalised` reports a kept value whose canonical form differs from the cell as written
   * (whitespace aside) — the row warning `value_normalised`, never the text.
   */
  type CanonicalCell =
    | { kind: 'ok'; v: string; raw: string; changed: boolean }
    | { kind: 'undecidable' } // no fixed point within the round cap (DECISION_LOG d232db7)
    | { kind: 'too_long' }; // the canonical form is over the cell limit (NFKC expands: U+FDFA ×18)
  const canonical = (column: string | undefined): CanonicalCell | null => {
    const collapsed = str(row, column);
    if (!collapsed) return null;
    const v = canonicalText(collapsed);
    if (v === null) return { kind: 'undecidable' };
    if (v.length > MAX_VALUE_CHARS) return { kind: 'too_long' };
    if (!v || isPlaceholder(v)) return null;
    // `raw` is the cell as written: `str` collapses whitespace, and JS whitespace includes the BOM.
    return { kind: 'ok', v, raw: String(row[column!]), changed: v !== collapsed };
  };
  const UNDECIDABLE = 'the cell could not be brought to its canonical form within the round limit';
  const CANONICAL_TOO_LONG = `the value is longer than ${MAX_VALUE_CHARS} characters in its canonical form`;
  /**
   * The contact verdict on a canonical cell: the canonical text, and — failing closed — the cell as
   * written, whose readings with invisible characters removed (`jane a\u200et` → `jane at`) the
   * canonical form (which spaces them) no longer holds. A hit on either counts.
   */
  const verdictOf = (
    cell: { v: string; raw: string },
    opts: { digitRuns?: boolean; town?: boolean; handles?: boolean },
  ) => contactValueVerdict([cell.v, cell.raw], opts);
  const normalised = (column: string) => normalisedCells.add(column);

  // The required name cell: any problem refuses the row.
  if (tooLong(c.name))
    return fail('value_too_long', `the value is longer than ${MAX_VALUE_CHARS} characters`, c.name);
  const nameCell = canonical(c.name);
  if (!nameCell) return fail('missing_name', 'the company name is empty', c.name);
  if (nameCell.kind === 'undecidable') return fail('contact_value_undecidable', UNDECIDABLE, c.name);
  if (nameCell.kind === 'too_long') return fail('invalid_name', CANONICAL_TOO_LONG, c.name);
  const name = nameCell.v;
  // Messaging handles are a text-cell rule (DECISION_LOG 47c0f5c): name, legal name (and its
  // trading-as), town and id — never a URL or Domain cell.
  const nameVerdict = verdictOf(nameCell, { digitRuns: true, handles: true });
  if (nameVerdict === 'contact')
    return fail('contact_value', 'the cell holds a contact value (an email address or phone number)', c.name);
  // The bounded address search could not decide: it fails closed (DECISION_LOG 6bff30e).
  if (nameVerdict === 'undecidable')
    return fail(
      'contact_value_undecidable',
      'the cell could not be checked for a contact value within the detector budget',
      c.name,
    );
  if (nameCell.changed) normalised(c.name);

  // Optional cells: a problem drops the cell (DECISION_LOG re-verification #6).
  const text = (
    column: string | undefined,
    opts: { digitRuns?: boolean; town?: boolean; handles?: boolean } = {},
    invalid: DirectoryRowWarning['code'] = 'value_too_long',
  ): string | null => {
    if (!column) return null;
    if (tooLong(column))
      return drop('value_too_long', `the value is longer than ${MAX_VALUE_CHARS} characters`, column);
    const cell = canonical(column);
    if (!cell) return null;
    if (cell.kind === 'undecidable') return drop('contact_value', UNDECIDABLE, column);
    if (cell.kind === 'too_long') return drop(invalid, CANONICAL_TOO_LONG, column);
    if (verdictOf(cell, opts) !== 'none') return drop('contact_value', CONTACT, column);
    if (cell.changed) normalised(column);
    return cell.v;
  };
  /**
   * A URL cell (Domain, Website, Careers URL), reduced not parsed (DECISION_LOG 29b6592): the URL to
   * store — the origin, plus the path only when it is plain — or null when the cell is empty or
   * dropped (a contact value in the host or the stored URL, or no URL).
   */
  const url = (
    column: string | undefined,
    invalid: 'invalid_domain' | 'invalid_website' | 'invalid_careers_url',
  ): { url: string; origin: string; reduced: boolean } | null => {
    if (!column) return null;
    if (tooLong(column))
      return drop('value_too_long', `the value is longer than ${MAX_VALUE_CHARS} characters`, column);
    const v = str(row, column);
    if (!v) return null;
    // The length limit holds for the normalised cell too (DECISION_LOG d232db7: NFKC expands).
    if (v.normalize('NFKC').length > MAX_VALUE_CHARS) return drop(invalid, CANONICAL_TOO_LONG, column);
    // An invisible code point, as written or decoded, drops the cell (DECISION_LOG bd6ad44). The
    // raw cell is read: trimming would hide a leading or trailing BOM.
    if (hasInvisibleCodePoint(String(row[column])))
      return drop(invalid, 'the value holds an invisible or bidi-control character', column);
    const r = reduceUrlCell(v, { domainCell: column === c.domain });
    // A Domain cell stores only its host, and is also read whole (`jane [at] smith.co.uk`).
    if (r.kind === 'contact' || (column === c.domain && urlHasContactValue(v)))
      return drop('contact_value', CONTACT, column);
    // A Domain cell is a bare host: an optional scheme and an optional trailing `/`, nothing else
    // (DECISION_LOG 64d97b4: `google.com//maps/place`, `google.com/%6Daps` are no domains).
    if (column === c.domain && !/^(?:https?:\/\/)?[^/?#\\\s]+\/?$/i.test(v))
      return drop(invalid, 'a Domain cell must be a bare host (an optional scheme and trailing /)', column);
    if (r.kind === 'invalid') return drop(invalid, 'the value is not an http(s) URL or domain', column);
    // The stored URL itself: host contact values, contact-link hosts, digits and person pages in a
    // kept plain path.
    if (urlHasContactValue(r.url)) return drop('contact_value', CONTACT, column);
    return r;
  };

  let legalName = text(c.legalName, { digitRuns: true, handles: true }, 'invalid_name');
  if (legalName && !strictNameKey(splitTradingName(legalName).legal)) {
    legalName = drop('invalid_name', 'the legal name has no letters or digits', c.legalName!);
  }
  const { legal, tradingAs } = splitTradingName(legalName ?? name);
  const nameKey = strictNameKey(legal);
  if (!nameKey) return fail('invalid_name', 'the company name has no letters or digits', c.name);

  // Identity is structural (DECISION_LOG "Company directory identity is structural"): only the
  // mapped Domain column is domain identity; the Website is a scheme + host attribute. The refusal
  // list still applies to both (defence in depth); a refused cell is dropped.
  // The domain-identity refusals read the raw cell, before origin reduction (DECISION_LOG
  // bd6ad44): `https://www.google.com/maps/place/Acme+Ltd` is a map page, never `google.com`.
  const identity = (column: string, reduced: { origin: string }) => {
    const raw = directoryDomain(str(row, column)!.replace(/\\/g, '/'));
    return 'refused' in raw && raw.refused === 'shared_hosting' ? raw : directoryDomain(reduced.origin);
  };
  const rawDomain = url(c.domain, 'invalid_domain');
  let domain: string | null = null;
  if (rawDomain) {
    const d = identity(c.domain!, rawDomain);
    if ('refused' in d) drop('invalid_domain', REFUSED_DOMAIN_MESSAGE[d.refused], c.domain!);
    // The stored domain itself, in every form of it (check what you store).
    else if (storedValueHasContact(d.domain, d.domain)) drop('contact_value', CONTACT, c.domain!);
    else domain = d.domain;
  }
  const rawWebsite = url(c.website, 'invalid_website');
  let website: string | null = null;
  if (rawWebsite) {
    if (!('domain' in identity(c.website!, rawWebsite)))
      drop('invalid_website', 'the website host is not a company domain', c.website!);
    else website = rawWebsite.origin; // scheme + host only
  }
  const rawCareers = url(c.careersUrl, 'invalid_careers_url');
  let careersUrl: string | null = null;
  if (rawCareers) {
    const u = new URL(rawCareers.url);
    // The host must be a registrable domain (`https://jane/at/gmail.com` has none).
    if (!isRegistrableHost(u.hostname))
      drop('invalid_careers_url', 'the careers URL host is not a registrable domain', c.careersUrl!);
    else if (isProfileUrl(u))
      drop(
        'profile_url',
        'the careers URL is a social or profile page, not an organisation or jobs page',
        c.careersUrl!,
      );
    // Scheme + host + the plain path (the careers page); the query and fragment are never stored,
    // and a path that is not plain is reduced to the origin (reported). Never a domain source.
    else {
      careersUrl = rawCareers.url;
      if (rawCareers.reduced)
        warnings.push({
          line,
          code: 'url_reduced_to_origin',
          column: c.careersUrl!,
          message: 'the careers URL path is not plain; only the origin is kept',
        });
    }
  }
  // A country is at most a short name: a longer cell is no country, before any lookup (DECISION_LOG
  // 64d97b4; the taxonomy lookup is costly on long input).
  const countryTooLong = !!c.country && !tooLong(c.country) && (str(row, c.country)?.length ?? 0) > 64;
  if (countryTooLong) drop('invalid_country', 'the country is not recognised', c.country!);
  const rawCountry = countryTooLong ? null : text(c.country, {}, 'invalid_country');
  let country = rawCountry ? normalizeCountry(rawCountry) : null;
  if (rawCountry && !country) drop('invalid_country', 'the country is not recognised', c.country!);
  // The default applies only to an empty or absent cell: a dropped country stays unknown (no HQ
  // seed, no country in the record key) — DECISION_LOG c1a3500.
  const countryCellEmpty = !c.country || (!tooLong(c.country) && !str(row, c.country));
  if (countryCellEmpty) country ??= config.defaultCountry?.toUpperCase() ?? null;

  // Register ids: normalised first — a value that normalises to a valid id is an id, never read as
  // a phone number; any other value is dropped.
  const externalIds: Array<{ namespace: string; id: string }> = [];
  for (const [namespace, column] of Object.entries(c.registerIds).sort(([a], [b]) => a.localeCompare(b))) {
    if (tooLong(column)) {
      drop('value_too_long', `the value is longer than ${MAX_VALUE_CHARS} characters`, column);
      continue;
    }
    const cell = canonical(column);
    if (!cell) continue;
    if (cell.kind === 'undecidable') {
      drop('contact_value', UNDECIDABLE, column);
      continue;
    }
    if (cell.kind === 'too_long') {
      drop('invalid_external_id', CANONICAL_TOO_LONG, column);
      continue;
    }
    const raw = cell.v;
    const r = normalizeExternalId(namespace, raw);
    if ('error' in r) {
      if (r.error === 'unknown_namespace')
        drop('unknown_id_namespace', 'the register-id namespace is not in the Market registry', column);
      else if (hasContactValue(raw)) drop('contact_value', CONTACT, column);
      else
        drop(
          'invalid_external_id',
          `the value is not a valid ${EXTERNAL_ID_NAMESPACES[namespace]!.label} (e.g. ${EXTERNAL_ID_NAMESPACES[namespace]!.example})`,
          column,
        );
      continue;
    }
    // A placeholder id (all zeros) is absent, not identity.
    if (isPlaceholderId(r.id)) continue;
    if (cell.changed) normalised(column);
    externalIds.push({ namespace, id: r.id });
  }

  const rawTown = text(c.town, { town: true, handles: true }, 'invalid_town');
  let town = rawTown && !isPlaceholderTown(rawTown) ? rawTown : null;
  if (!town && c.town) normalisedCells.delete(c.town);
  // A town holds no digits at all ("Dublin 2", "London EC1": the town is dropped, the row kept).
  if (town && hasDigit(town)) town = drop('invalid_town', 'a town may not contain digits', c.town!);

  const fileId = text(c.id, { handles: true });
  // The record key: the file's own id (hashed), else a register id, else name + country, else the
  // domain, else the name alone. Name + country ranks above the domain: sister companies share a
  // domain, and a company's domain changes more often than its name.
  const externalId = fileId
    ? fileIdKey(sourceId, fileId)
    : externalIds[0]
      ? `${externalIds[0].namespace}:${externalIds[0].id}`
      : country
        ? `name:${nameKey}|${country.toLowerCase()}`
        : domain
          ? `domain:${domain}`
          : `name:${nameKey}|`;
  // The website derived from the domain passes the rules a Website cell does, the stored-value
  // check included (DECISION_LOG 64d97b4): `at-home.co.uk` is kept as a Domain, with no website.
  const derived = domain ? reduceUrlCell(`https://${domain}/`) : null;
  const derivedWebsite = derived?.kind === 'url' ? derived.origin : null;
  const parsed = companyObservationPayloadSchema.safeParse({
    name,
    legalName: legal,
    aliases: tradingAs ? [tradingAs] : [],
    domain,
    website: website ?? derivedWebsite,
    externalIds,
    locations: country || town ? [{ country, ...(town ? { city: town } : {}), kind: 'hq' }] : [],
    industries: [],
    careersUrl,
  });
  if (!parsed.success)
    return fail(
      'invalid_payload',
      `the row does not fit the company observation contract (${parsed.error.issues[0]?.path.join('.') || 'row'})`,
    );
  // `value_normalised`, once per kept cell, after the cell's own drops (DECISION_LOG 64d97b4).
  for (const column of normalisedCells)
    warnings.push({
      line,
      code: 'value_normalised',
      column,
      message:
        'the value was stored in its canonical form (escapes decoded, compatibility characters folded, invisible characters replaced)',
    });
  return { candidate: { externalId, locator: `row:${line}`, payload: parsed.data }, warnings };
}

export interface DirectoryImportPlan {
  header: string[];
  /** Data records in the file (malformed ones included). */
  rowCount: number;
  candidates: DirectoryCandidate[];
  /** Every row that is not imported, with the reason. Never silently dropped. */
  errors: DirectoryRowError[];
  /** Optional cells dropped from imported rows (code, column, row number). */
  rowWarnings: DirectoryRowWarning[];
  headerProblems: DirectoryUploadProblem[];
  /** Import-wide notes for the operator (the import still runs). */
  warnings: string[];
}

/**
 * Why every row of the import will go to review: without a Domain or register-id column no row
 * can be non-bare (DECISION_LOG re-verification #4/#5).
 */
export const NO_IDENTITY_COLUMN_WARNING =
  'neither a Domain column nor any register-id column is mapped: every row is a bare name and goes to review (one company_resolution review per row); map a Domain column or a register-id column (e.g. gb_companies_house) to let rows resolve automatically';

/** Import-wide warnings a column map implies (shown on upload and in the import report). */
export function directoryConfigWarnings(config: CompanyDirectoryConfig): string[] {
  return [
    ...(config.columns.domain || Object.keys(config.columns.registerIds).length
      ? []
      : [NO_IDENTITY_COLUMN_WARNING]),
    ...(config.columns.id ? [] : [NO_ID_COLUMN_WARNING]),
  ];
}

/** Why a directory without an `id` column keys its rows less stably. */
export const NO_ID_COLUMN_WARNING =
  'no id column is mapped: rows are keyed by register id, else name + country, else domain, else name, so renaming a company (or changing its country or domain) in the file makes it a new record';

/**
 * Reads and maps a whole directory file. Malformed rows, invalid rows and a second row with an
 * already-seen record key are all reported as row errors (the first occurrence is imported);
 * nothing is merged or dropped silently. Header problems are returned for the caller to refuse.
 */
export function planDirectoryImport(
  config: CompanyDirectoryConfig,
  text: string,
  sourceId: string,
): DirectoryImportPlan {
  const steps = planSteps(config, text, sourceId);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * `planDirectoryImport` for a long map inside a workflow node: between batches of rows (at most
 * 1 000 rows or 250 ms of mapping) it awaits `pause` — the node yields the event loop and
 * heartbeats its lease there — so a large or slow file never blocks the worker past its lease.
 */
export async function planDirectoryImportAsync(
  config: CompanyDirectoryConfig,
  text: string,
  sourceId: string,
  pause: () => Promise<void>,
): Promise<DirectoryImportPlan> {
  const steps = planSteps(config, text, sourceId);
  let step = steps.next();
  while (!step.done) {
    await pause();
    step = steps.next();
  }
  return step.value;
}

/** Rows mapped between pauses, at most (and at most this long in milliseconds). */
const PLAN_BATCH_ROWS = 1000;
const PLAN_BATCH_MS = 250;

function* planSteps(
  config: CompanyDirectoryConfig,
  text: string,
  sourceId: string,
): Generator<number, DirectoryImportPlan, void> {
  const mapped: DirectoryCandidate[] = [];
  const errors: DirectoryRowError[] = [];
  const rowWarnings: DirectoryRowWarning[] = [];
  const lineOf = new Map<DirectoryCandidate, number>();
  const rows: Array<{ line: number; row: Record<string, string> }> = [];
  const { header, records, headerProblem } = readCsv(
    text,
    (record, columns) => {
      // Past the row limit nothing is collected (the import is refused on the count).
      if (rows.length + errors.length >= config.maxRows) return;
      const row: Record<string, string> = {};
      columns.forEach((h, k) => (row[h] = record.fields[k] ?? ''));
      rows.push({ line: record.line, row });
    },
    (problem) => {
      // The header's own problem is a header problem (`malformed_header`), not a row error.
      if (problem.message.startsWith('header: ') || rows.length + errors.length >= config.maxRows) return;
      errors.push({ line: problem.line, code: 'malformed_row', message: problem.message });
    },
    { maxFieldChars: MAX_VALUE_CHARS },
  );
  yield 0;
  let batchStart = performance.now();
  for (let k = 0; k < rows.length; k++) {
    const { line, row } = rows[k]!;
    const r = mapDirectoryRow(config, row, line, sourceId);
    if ('error' in r) errors.push(r.error);
    else {
      rowWarnings.push(...r.warnings);
      lineOf.set(r.candidate, line);
      mapped.push(r.candidate);
    }
    if ((k + 1) % PLAN_BATCH_ROWS === 0 || performance.now() - batchStart > PLAN_BATCH_MS) {
      yield k + 1;
      batchStart = performance.now();
    }
  }
  // One external id on rows with different names (DECISION_LOG "Company directory identity is
  // structural"): the file contradicts itself, so ALL those rows are errors — none is imported.
  const namesById = new Map<string, Set<string>>();
  for (const cand of mapped)
    for (const e of cand.payload.externalIds) {
      const key = `${e.namespace}:${e.id}`;
      const names = namesById.get(key) ?? new Set<string>();
      names.add(strictNameKey(cand.payload.legalName ?? cand.payload.name));
      namesById.set(key, names);
    }
  // The same name key and country with contradicting ids in one namespace (DECISION_LOG
  // re-verification #4; idsContradict since c1a3500): the file does not say which is the company, so every such row goes to review (never an
  // automatic create or match; not a row error).
  const nameCountry = (cand: DirectoryCandidate) =>
    `${strictNameKey(cand.payload.legalName ?? cand.payload.name)}|${cand.payload.locations[0]?.country ?? ''}`;
  const idsByName = new Map<string, Map<string, Set<string>>>();
  for (const cand of mapped)
    for (const e of cand.payload.externalIds) {
      const byNs = idsByName.get(nameCountry(cand)) ?? new Map<string, Set<string>>();
      byNs.set(e.namespace, (byNs.get(e.namespace) ?? new Set()).add(e.id));
      idsByName.set(nameCountry(cand), byNs);
    }
  const candidates: DirectoryCandidate[] = [];
  const seen = new Map<string, number>();
  for (const cand of mapped) {
    const line = lineOf.get(cand)!;
    const conflicting = cand.payload.externalIds.find(
      (e) => namesById.get(`${e.namespace}:${e.id}`)!.size > 1,
    );
    if (conflicting) {
      errors.push({
        line,
        code: 'conflicting_external_id',
        column: config.columns.registerIds[conflicting.namespace],
        message:
          'the same register id is on rows with different company names in this file; none of them is imported',
      });
      continue;
    }
    const first = seen.get(cand.externalId);
    if (first !== undefined) {
      errors.push({
        line,
        code: 'duplicate_row_key',
        message: `the same record as row ${first} (the first occurrence is imported)`,
      });
      continue;
    }
    seen.set(cand.externalId, line);
    const byNs = idsByName.get(nameCountry(cand));
    // Only contradicting ids split the name (idsContradict): several BR numbers beside an FC
    // number, or several D-U-N-S site numbers, are one company.
    const split = cand.payload.externalIds.some((e) =>
      [...(byNs?.get(e.namespace) ?? [])].some((id) => idsContradict(e, { namespace: e.namespace, id })),
    );
    candidates.push(split ? { ...cand, review: 'conflicting_ids_in_file' } : cand);
  }
  errors.sort((a, b) => a.line - b.line);
  return {
    header: header ?? [],
    rowCount: records,
    candidates,
    errors,
    rowWarnings,
    headerProblems: checkDirectoryHeader(config, header ?? [], headerProblem),
    warnings: directoryConfigWarnings(config),
  };
}
