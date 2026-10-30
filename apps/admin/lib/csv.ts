/*
 * A small strict CSV reader and writer for the import wizard (runs in the browser). It follows
 * the same rules as the server's directory reader (market-sources.md, M8.1): RFC 4180, comma,
 * `"` quoting with `""` escapes, a UTF-8 BOM skipped, CRLF / LF / lone CR each end a record,
 * blank lines skipped. A broken record is reported, never read with shifted columns.
 */

export interface CsvRow {
  /** Physical file line where the record starts (the header is usually line 1). */
  line: number;
  fields: string[];
}

export type CsvRowProblem = 'stray_quote' | 'text_after_quote' | 'unterminated_quote' | 'field_count';

export interface CsvMalformedRow {
  line: number;
  problem: CsvRowProblem;
}

export type CsvReadError = 'not_utf8' | 'empty' | 'no_header' | 'malformed_header' | 'too_many_columns';

export type CsvReadResult =
  | {
      ok: true;
      /** Header names, trimmed (the server matches trimmed header cells). */
      header: string[];
      headerLine: number;
      rows: CsvRow[];
      malformed: CsvMalformedRow[];
    }
  | { ok: false; error: CsvReadError };

/** The server refuses a header with more columns than this (`malformed_header`). */
export const MAX_COLUMNS = 1000;

/**
 * Decodes UTF-8 strictly. Returns null for invalid bytes, so we can tell the operator to export
 * "CSV UTF-8" instead of uploading text that would be refused (or worse, silently mangled).
 */
export function decodeUtf8(bytes: ArrayBuffer | Uint8Array): string | null {
  try {
    // ignoreBOM: false strips a leading BOM.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

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
 * Reads decoded CSV text: the first non-blank record is the header. This is a port of the
 * server reader (`readCsv` in packages/market company-directory.ts) and must stay in step with
 * it: the same records, the same line numbers and the same malformed rows. `csv.test.ts` runs
 * the server's own fixtures. A malformed row is listed, never read with shifted columns.
 */
export function readCsv(text: string): CsvReadResult {
  const src = text;
  const n = src.length;
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  let header: string[] | null = null;
  let headerLine = 0;
  let headerProblem: CsvRowProblem | null = null;
  let headerWidth = 0;
  const rows: CsvRow[] = [];
  const malformed: CsvMalformedRow[] = [];
  let line = 1;
  while (i < n) {
    const startLine = line;
    const fields: string[] = [];
    let problem: CsvRowProblem | null = null;
    let blank = true;
    for (;;) {
      let value = '';
      if (src.charCodeAt(i) === QUOTE) {
        blank = false;
        i++;
        const start = i;
        let end = n;
        let escaped = false;
        let closed = false;
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
          // Like the server: an unclosed quote swallows the rest of the file into one bad row.
          i = n;
          problem ??= 'unterminated_quote';
        }
        value = src.slice(start, end);
        if (escaped) value = value.replaceAll('""', '"');
        if (i < n) {
          const c = src.charCodeAt(i);
          if (c !== COMMA && c !== LF && c !== CR) {
            problem ??= 'text_after_quote';
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
            problem ??= 'stray_quote';
          } else if (c !== SPACE && c !== TAB) blank = false;
          j++;
        }
        value = src.slice(i, j);
        i = j;
      }
      fields.push(value);
      if (i >= n) break;
      const c = src.charCodeAt(i);
      if (c === COMMA) {
        blank = false;
        i++;
        continue;
      }
      i += c === CR && src.charCodeAt(i + 1) === LF ? 2 : 1;
      line++;
      break;
    }
    // A line of only spaces or tabs is blank, as on the server.
    if (blank && !problem) continue;
    if (header === null) {
      header = fields.map((f) => f.trim());
      headerLine = startLine;
      headerProblem = problem;
      headerWidth = fields.length;
      if (problem || headerWidth > MAX_COLUMNS) break;
      continue;
    }
    if (!problem && fields.length !== header.length) problem = 'field_count';
    if (problem) malformed.push({ line: startLine, problem });
    else rows.push({ line: startLine, fields });
  }
  if (header === null) return { ok: false, error: src.trim() ? 'no_header' : 'empty' };
  if (headerProblem) return { ok: false, error: 'malformed_header' };
  if (headerWidth > MAX_COLUMNS) return { ok: false, error: 'too_many_columns' };
  return { ok: true, header, headerLine, rows, malformed };
}

const NEEDS_QUOTES = /[",\r\n]/;

export function csvField(value: string): string {
  return NEEDS_QUOTES.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Physical lines a written record takes (embedded line breaks add lines). */
export function lineCount(fields: string[]): number {
  let lines = 1;
  for (const f of fields) {
    const breaks = f.match(/\r\n|\r|\n/g);
    if (breaks) lines += breaks.length;
  }
  return lines;
}
