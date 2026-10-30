/*
 * Readable text for the upload problem codes (`details.problems[]`, market-sources.md M8.1 and
 * market-imports.md). The server's own message is kept for codes we do not know.
 */

export interface ImportProblem {
  code: string;
  column?: string;
  message?: string;
}

const TEXT: Record<string, string> = {
  too_large: 'The file is larger than this list allows.',
  too_many_rows: 'The file has more rows than this list allows.',
  not_csv: 'The file is not a CSV file.',
  not_utf8: 'The file is not UTF-8 text. Save it again as "CSV UTF-8" and retry.',
  no_header: 'The file has no header row.',
  malformed_header: 'The header row is not valid CSV (a stray quote, or more than 1,000 columns).',
  missing_column: 'A mapped column is missing from the file.',
  duplicate_column: 'A column name appears twice in the file.',
  unmapped_column: 'The file has a column that is not mapped.',
  personal_data_column:
    'A column looks like personal data (a person’s name, email or phone number). Choose "Don’t import" for it.',
  wrong_source_type: 'The chosen source does not match this import type.',
};

/**
 * The column a problem names, as the operator knows it. Older API builds name a column by its
 * position ("column 3"); that position is in the uploaded file, which holds only the mapped
 * columns, so `uploadedHeader` (the header of that file) turns it back into the header name.
 */
function columnName(column: string, uploadedHeader?: readonly string[]): string {
  const m = /^column (\d+)$/i.exec(column.trim());
  if (!m) return `"${column}"`;
  const name = uploadedHeader?.[Number(m[1]) - 1];
  return name ? `"${name}"` : column;
}

export function problemText(p: ImportProblem, uploadedHeader?: readonly string[]): string {
  const text = TEXT[p.code] ?? p.message ?? p.code;
  if (p.column) return `${text} (${columnName(p.column, uploadedHeader)})`;
  // A config-level personal-data refusal names no column; the server message says which.
  if (p.code === 'personal_data_column' && p.message) return `${text} ${p.message}`;
  return text;
}

/** `details.problems[]` from an API error, when it is there and well formed. */
export function problemsOf(details: unknown): ImportProblem[] {
  const list = (details as { problems?: unknown } | null | undefined)?.problems;
  if (!Array.isArray(list)) return [];
  return list.flatMap((p): ImportProblem[] => {
    if (!p || typeof p !== 'object') return [];
    const { code, column, message } = p as Record<string, unknown>;
    if (typeof code !== 'string') return [];
    return [
      {
        code,
        ...(typeof column === 'string' ? { column } : {}),
        ...(typeof message === 'string' ? { message } : {}),
      },
    ];
  });
}
