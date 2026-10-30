import { type CsvRow, csvField, lineCount } from './csv';

/*
 * Column mapping for the Companies and Known ATS boards imports (market-imports.md, M8.1/M8.2).
 * The browser maps file columns to fields, then uploads a reduced file with only the mapped
 * columns. The server still runs every check; these rules only stop a mapping it would refuse.
 */

export type MappedImportType = 'companies' | 'ats_boards';

export interface ImportField {
  /** Path in `acquisition.config.columns` (`registerIds.lei` is nested). */
  key: string;
  label: string;
  required?: boolean;
  group?: string;
}

/** Market external-id registry namespaces a directory may map (market-sources.md, M8.1). */
export const REGISTER_NAMESPACES: ReadonlyArray<readonly [string, string]> = [
  ['gb_companies_house', 'Companies House number (UK)'],
  ['ie_cro', 'CRO number (Ireland)'],
  ['lei', 'LEI'],
  ['duns', 'D-U-N-S number'],
  ['fr_siren', 'SIREN (France)'],
  ['nl_kvk', 'KvK number (Netherlands)'],
  ['us_ein', 'EIN (US)'],
  ['wikidata', 'Wikidata id'],
];

const COMPANY_FIELDS: ImportField[] = [
  { key: 'name', label: 'Name', required: true },
  { key: 'legalName', label: 'Legal name' },
  { key: 'domain', label: 'Domain' },
  { key: 'website', label: 'Website' },
  { key: 'country', label: 'Country' },
  { key: 'town', label: 'Town or city' },
  { key: 'careersUrl', label: 'Careers page URL' },
  { key: 'id', label: 'Row id in your file' },
  ...REGISTER_NAMESPACES.map(([ns, label]) => ({ key: `registerIds.${ns}`, label, group: 'Register ids' })),
];

const ATS_FIELDS: ImportField[] = [
  // Provider and token are optional when a URL column is mapped: the server reads both from it.
  { key: 'provider', label: 'ATS provider' },
  { key: 'token', label: 'Board token' },
  { key: 'company', label: 'Company name' },
  { key: 'domain', label: 'Company domain' },
  { key: 'url', label: 'Board or job URL' },
];

export interface ImportKind {
  type: MappedImportType;
  label: string;
  provider: string;
  workflowKey: string;
  /** `freshness` is required by `POST /api/sources`; an upload-only list never goes stale on a clock. */
  policyClass: string;
  fields: ImportField[];
}

export const IMPORT_KINDS: Record<MappedImportType, ImportKind> = {
  companies: {
    type: 'companies',
    label: 'Companies',
    provider: 'company_directory',
    workflowKey: 'market.company_directory.import',
    policyClass: 'company.firmographics',
    fields: COMPANY_FIELDS,
  },
  ats_boards: {
    type: 'ats_boards',
    label: 'Known ATS boards',
    provider: 'ats_board_directory',
    workflowKey: 'market.ats_boards.import',
    policyClass: 'company.careers',
    fields: ATS_FIELDS,
  },
};

/** Column index → field key, or null for "Don't import". */
export type Mapping = Array<string | null>;

export interface MappingIssue {
  message: string;
  /** Column index the issue is about, when there is one. */
  column?: number;
}

const columnName = (header: string[], i: number) => (header[i] ? `"${header[i]}"` : `Column ${i + 1}`);

/** Everything that would make the server refuse this mapping, in plain words. */
export function validateMapping(type: MappedImportType, header: string[], mapping: Mapping): MappingIssue[] {
  const kind = IMPORT_KINDS[type];
  const issues: MappingIssue[] = [];
  const byField = new Map<string, number[]>();
  const byName = new Map<string, number[]>();
  mapping.forEach((field, i) => {
    if (!field) return;
    byField.set(field, [...(byField.get(field) ?? []), i]);
    const name = header[i] ?? '';
    if (!name)
      issues.push({ column: i, message: `Column ${i + 1} has no header name, so it cannot be imported.` });
    else byName.set(name, [...(byName.get(name) ?? []), i]);
  });
  for (const f of kind.fields) {
    if (f.required && !byField.has(f.key)) issues.push({ message: `Choose a column for ${f.label}.` });
  }
  for (const [key, cols] of byField) {
    if (cols.length < 2) continue;
    const label = kind.fields.find((f) => f.key === key)?.label ?? key;
    issues.push({
      column: cols[1],
      message: `${label} is chosen for more than one column (${cols.map((c) => columnName(header, c)).join(', ')}).`,
    });
  }
  for (const [name, cols] of byName) {
    if (cols.length > 1)
      issues.push({
        column: cols[1],
        message: `Two imported columns are both named "${name}". Import only one of them.`,
      });
  }
  if (type === 'ats_boards' && !hasBoardColumns(mapping))
    issues.push({
      message: 'Choose a column for Board or job URL, or columns for both ATS provider and Board token.',
    });
  if (type === 'ats_boards' && !byField.has('company') && !byField.has('domain'))
    issues.push({ message: 'Choose a column for Company name or Company domain (at least one).' });
  return issues;
}

export type ColumnsConfig = Record<string, string | Record<string, string>>;

/** The mapping as `acquisition.config.columns`: field → header name (exact). */
export function columnsConfig(header: string[], mapping: Mapping): ColumnsConfig {
  const out: ColumnsConfig = {};
  mapping.forEach((field, i) => {
    if (!field) return;
    const name = header[i] ?? '';
    if (field.startsWith('registerIds.')) {
      const ids = (out.registerIds as Record<string, string> | undefined) ?? {};
      ids[field.slice('registerIds.'.length)] = name;
      out.registerIds = ids;
    } else out[field] = name;
  });
  return out;
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      // The server stores `registerIds: {}` by default: same as absent.
      .filter(([, x]) => x !== undefined && !(x && typeof x === 'object' && !Object.keys(x).length))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, x]) => [k, canonical(x)]));
  }
  return v;
}

/** True when two column configs say the same thing (key order and empty `registerIds` ignored). */
export function sameColumns(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a ?? {})) === JSON.stringify(canonical(b ?? {}));
}

/** A field → header map read back from a source's saved config, flattened like `Mapping` keys. */
function savedFields(columns: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!columns || typeof columns !== 'object') return out;
  for (const [k, v] of Object.entries(columns as Record<string, unknown>)) {
    if (typeof v === 'string') out.set(k, v);
    else if (k === 'registerIds' && v && typeof v === 'object')
      for (const [ns, col] of Object.entries(v as Record<string, unknown>))
        if (typeof col === 'string') out.set(`registerIds.${ns}`, col);
  }
  return out;
}

/** Header spellings we pre-select a field for. The operator always confirms the mapping. */
const ALIASES: Record<MappedImportType, Record<string, string>> = {
  companies: {
    name: 'name',
    company: 'name',
    companyname: 'name',
    legalname: 'legalName',
    domain: 'domain',
    website: 'website',
    websiteurl: 'website',
    country: 'country',
    town: 'town',
    city: 'town',
    careersurl: 'careersUrl',
    careerspage: 'careersUrl',
    careers: 'careersUrl',
    id: 'id',
    lei: 'registerIds.lei',
    duns: 'registerIds.duns',
    companynumber: 'registerIds.gb_companies_house',
    wikidata: 'registerIds.wikidata',
  },
  ats_boards: {
    provider: 'provider',
    ats: 'provider',
    token: 'token',
    boardtoken: 'token',
    company: 'company',
    companyname: 'company',
    name: 'company',
    domain: 'domain',
    url: 'url',
    boardurl: 'url',
    link: 'url',
    joblink: 'url',
    joburl: 'url',
    boardlink: 'url',
    careersurl: 'url',
    careerslink: 'url',
    careerspage: 'url',
  },
};

const squash = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * A starting mapping. With a saved config (an existing list), columns whose header exactly
 * matches a saved column get that field first; other columns get a field from common header
 * spellings, when that field is still free.
 */
export function suggestMapping(type: MappedImportType, header: string[], savedColumns?: unknown): Mapping {
  const byHeader = new Map([...savedFields(savedColumns)].map(([field, col]) => [col, field]));
  const taken = new Set<string>();
  const out: Mapping = header.map((h) => {
    const field = byHeader.get(h);
    if (!field || taken.has(field)) return null;
    taken.add(field);
    return field;
  });
  return out.map((field, i) => {
    if (field) return field;
    const alias = ALIASES[type][squash(header[i] ?? '')];
    if (!alias || taken.has(alias)) return null;
    taken.add(alias);
    return alias;
  });
}

/** The server's rule for a board file: provider and token, or a URL it reads them from. */
export function hasBoardColumns(mapping: Mapping): boolean {
  return mapping.includes('url') || (mapping.includes('provider') && mapping.includes('token'));
}

/**
 * True when a companies mapping has a column that can identify a company (domain or register id).
 * ATS boards need no such column: the server creates a company from a live board and a name.
 */
export function hasIdentityColumn(mapping: Mapping): boolean {
  return mapping.some((f) => f === 'domain' || !!f?.startsWith('registerIds.'));
}

/**
 * The file to upload: the header and the rows with only the mapped columns, in file order,
 * header names exactly as mapped. Blank lines stand in for dropped lines (blank lines before
 * the header, unreadable rows, line breaks inside dropped cells) so every row keeps its line
 * number: the server skips blank lines and reports rows by line.
 */
export function reduceCsv(
  parsed: { header: string[]; headerLine: number; rows: CsvRow[] },
  mapping: Mapping,
): string {
  const keep = mapping.flatMap((field, i) => (field ? [i] : []));
  const parts: string[] = [];
  let line = 1;
  const write = (line_: number, fields: string[]) => {
    while (line < line_) {
      parts.push('\r\n');
      line++;
    }
    // The server skips a blank line, so a lone empty (or all-space) cell is written quoted to
    // keep its row counted.
    const lone = fields.length === 1 && /^[ \t]*$/.test(fields[0]!);
    parts.push(lone ? `"${fields[0]}"` : fields.map(csvField).join(','), '\r\n');
    line += lineCount(fields);
  };
  write(
    parsed.headerLine,
    keep.map((i) => parsed.header[i] ?? ''),
  );
  for (const row of parsed.rows)
    write(
      row.line,
      keep.map((i) => row.fields[i] ?? ''),
    );
  return parts.join('');
}

/** A list name from a file name: "UK fintechs.csv" → "UK fintechs". */
export function listNameFromFile(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').trim() || fileName;
}
