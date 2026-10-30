import { createHash } from 'node:crypto';
import { strictNameKey } from '../../../companies/normalize';
import { subdivisionCode } from '../../../resolution/history-attachment';
import {
  classifyRoute,
  type ParsedRegister,
  RegisterFormatError,
  type RegisterAdapter,
  type RegisterRow,
  type RouteDefinition,
} from './adapter';
import { decodeText, findColumn, headerKey, looksLikeHtml, readDelimited } from './tabular';

/**
 * USCIS H-1B Employer Data Hub (M11.5): H-1B petitions decided per employer and fiscal year.
 * **Hiring history, not capability**: an approval says the employer petitioned for and received
 * H-1B workers in that year; it says nothing about whether it sponsors now, and nothing about a
 * role. Its rows are evidence for US jobs only (`historical_evidence`), never `company_capable`
 * and never a role verdict. The register creates no companies: a row attaches only to an existing
 * company on a high-confidence match (the row's employer identity key, or the company's own exact
 * name plus a known US state); an ambiguous match goes to review; anything else is skipped.
 *
 * Formats (one file per fiscal year, detected from the header): the legacy export
 * (`Fiscal Year, Employer, Initial Approval, Initial Denial, Continuing Approval, Continuing
 * Denial, NAICS, Tax ID, State, City, ZIP`) and the current "Employer Information" export
 * (`Fiscal Year, Employer (Petitioner) Name, Tax ID, Industry (NAICS) Code, Petitioner City,
 * Petitioner State, Petitioner Zip Code`, then approval/denial pairs for New Employment,
 * Continuation, Change with Same Employer, New Concurrent, Change of Employer, Amended), comma- or
 * tab-separated, UTF-8 or UTF-16. In the current export, "initial" = New Employment and
 * "continuing" = the other five categories (the legacy export's definitions).
 */
export const US_H1B_REGISTER = 'us_uscis_h1b_employer_data_hub';
export const US_H1B_PROVIDER = 'us_uscis_h1b_employer_data_hub';
export const US_H1B_PUBLICATION_URL =
  'https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub';

export const US_H1B_ROUTES: readonly RouteDefinition[] = [
  { id: 'h1b', label: 'H-1B', meaning: 'history', aliases: ['H1B', 'H-1B specialty occupation'] },
];

/** Two-letter US state code of a state code or name (DC and territories kept as given); else null. */
export function usStateCode(raw: string | null | undefined): string | null {
  return subdivisionCode('US', raw);
}

const COL = {
  fiscalYear: [/^fiscal year$/],
  employer: [/^employer( petitioner)? name$/, /^employer$/, /^petitioner name$/],
  taxId: [/^tax id$/],
  naics: [/^industry naics code$/, /^naics( code)?$/],
  state: [/^petitioner state$/, /^state$/],
  city: [/^petitioner city$/, /^city$/],
  zip: [/^petitioner zip code$/, /^zip( code)?$/],
  // Legacy export.
  initialApproval: [/^initial approvals?$/],
  initialDenial: [/^initial denials?$/],
  continuingApproval: [/^continuing approvals?$/],
  continuingDenial: [/^continuing denials?$/],
} as const;
const CURRENT_INITIAL = ['new employment'];
const CURRENT_CONTINUING = [
  'continuation',
  'change with same employer',
  'new concurrent',
  'change of employer',
  'amended',
];

/** A count cell: digits with optional thousands separators; blank is 0; anything else invalid. */
function count(cell: string | undefined): number | null {
  const v = (cell ?? '').replace(/[,\s]/g, '');
  if (v === '') return 0;
  return /^\d+$/.test(v) ? Number(v) : null;
}

/** A short stable hash of a row key (sha256, 24 hex). */
function hashKey(v: string): string {
  return createHash('sha256').update(v).digest('hex').slice(0, 24);
}

function parseH1b(bytes: Uint8Array): ParsedRegister {
  const text = decodeText(bytes);
  if (looksLikeHtml(text))
    throw new RegisterFormatError('an HTML page, not a Data Hub export (download the fiscal-year file)');
  const table = readDelimited(text);
  const col = Object.fromEntries(
    Object.entries(COL).map(([k, p]) => [k, findColumn(table.header, p)]),
  ) as Record<keyof typeof COL, number>;
  if (col.fiscalYear < 0 || col.employer < 0 || col.state < 0)
    throw new RegisterFormatError('missing the "Fiscal Year", "Employer" or "State" column');
  const keys = table.header.map(headerKey);
  const pairs = (names: string[], kind: 'approval' | 'denial') =>
    names.map((n) => keys.findIndex((k) => k === `${n} ${kind}` || k === `${n} ${kind}s`));
  const legacy = col.initialApproval >= 0 && col.continuingApproval >= 0;
  const current = {
    initialApproval: pairs(CURRENT_INITIAL, 'approval'),
    initialDenial: pairs(CURRENT_INITIAL, 'denial'),
    continuingApproval: pairs(CURRENT_CONTINUING, 'approval'),
    continuingDenial: pairs(CURRENT_CONTINUING, 'denial'),
  };
  const currentComplete = Object.values(current).every((idx) => idx.every((i) => i >= 0));
  if (!legacy && !currentComplete)
    throw new RegisterFormatError('approval/denial columns not recognised (legacy or current export)');
  const rows: RegisterRow[] = [];
  const skipped: ParsedRegister['skipped'] = [];
  const cell = (cells: string[], i: number) =>
    i >= 0 ? cells[i]?.replace(/\s+/g, ' ').trim() || null : null;
  const sum = (cells: string[], idx: number[]) =>
    idx.reduce<number | null>((a, i) => {
      const v = count(cells[i]);
      return a === null || v === null ? null : a + v;
    }, 0);
  // Rows of one file with the same row key are summed, never one replacing the other
  // (DECISION_LOG "Sponsor register adapters" (3)).
  const byKey = new Map<string, RegisterRow>();
  let summed = 0;
  for (const r of table.rows) {
    const locator = `row:${r.line}`;
    // Strict: a row whose cell count differs from the header's is not read with shifted columns.
    if (r.cells.length !== table.header.length) {
      skipped.push({ locator, reason: 'column_count_mismatch' });
      continue;
    }
    const name = cell(r.cells, col.employer);
    const fy = Number(cell(r.cells, col.fiscalYear));
    if (!name) {
      skipped.push({ locator, reason: 'no_name' });
      continue;
    }
    if (!Number.isInteger(fy) || fy < 1990 || fy > 2100) {
      skipped.push({ locator, reason: 'no_fiscal_year' });
      continue;
    }
    const counts = legacy
      ? {
          initialApprovals: count(r.cells[col.initialApproval]),
          initialDenials: count(r.cells[col.initialDenial]),
          continuingApprovals: count(r.cells[col.continuingApproval]),
          continuingDenials: count(r.cells[col.continuingDenial]),
        }
      : {
          initialApprovals: sum(r.cells, current.initialApproval),
          initialDenials: sum(r.cells, current.initialDenial),
          continuingApprovals: sum(r.cells, current.continuingApproval),
          continuingDenials: sum(r.cells, current.continuingDenial),
        };
    if (Object.values(counts).some((v) => v === null)) {
      skipped.push({ locator, reason: 'invalid_count' });
      continue;
    }
    const taxId = cell(r.cells, col.taxId)?.replace(/\D/g, '').slice(-4) ?? '';
    const zip = cell(r.cells, col.zip)?.replace(/[^\d]/g, '').slice(0, 5) ?? '';
    const naics = cell(r.cells, col.naics)?.replace(/\s+/g, ' ').toLowerCase() ?? '';
    const town = cell(r.cells, col.city);
    const state = cell(r.cells, col.state);
    // The row key tells rows apart without carrying tax-id or ZIP digits anywhere (hashed).
    const rowKey = hashKey(`${naics}|${zip}|${taxId}`);
    const k = [fy, strictNameKey(name), (state ?? '').toUpperCase(), (town ?? '').toLowerCase(), rowKey].join(
      '|',
    );
    const same = byKey.get(k);
    if (same?.history) {
      summed += 1;
      same.history.initialApprovals += counts.initialApprovals!;
      same.history.initialDenials += counts.initialDenials!;
      same.history.continuingApprovals += counts.continuingApprovals!;
      same.history.continuingDenials += counts.continuingDenials!;
      continue;
    }
    const row: RegisterRow = {
      locator,
      name,
      route: 'H-1B',
      town,
      county: state,
      history: {
        fiscalYear: fy,
        initialApprovals: counts.initialApprovals!,
        initialDenials: counts.initialDenials!,
        continuingApprovals: counts.continuingApprovals!,
        continuingDenials: counts.continuingDenials!,
        rowKey,
      },
    };
    byKey.set(k, row);
    rows.push(row);
  }
  return { format: table.delimiter === '\t' ? 'tsv' : 'csv', rows, skipped, summedRows: summed };
}

export const usH1bEmployerDataHubAdapter: RegisterAdapter = {
  id: US_H1B_REGISTER,
  provider: US_H1B_PROVIDER,
  title: 'H-1B Employer Data Hub',
  publisher: 'U.S. Citizenship and Immigration Services (USCIS)',
  publicationUrl: US_H1B_PUBLICATION_URL,
  // One file per fiscal year: the source names its file (endpoint.url or the run's url).
  defaultEndpoint: null,
  attribution:
    'Source: U.S. Citizenship and Immigration Services, H-1B Employer Data Hub (uscis.gov). U.S. government work, public domain.',
  scope: { country: 'US' },
  evidenceTier: 'history',
  identityNamespace: 'us_h1b_employer',
  parser: { name: 'us-h1b-datahub-row', version: '1' },
  routes: US_H1B_ROUTES,
  unlistedRouteMeaning: 'ignored',
  parse: parseH1b,
  toObservation(row) {
    const name = row.name.trim();
    const h = row.history;
    const state = usStateCode(row.county);
    const route = classifyRoute(usH1bEmployerDataHubAdapter, row.route);
    // History only; a row without a US state cannot meet the attachment rule (name + state).
    if (!name || !h || !state || route.meaning !== 'history') return null;
    const key = strictNameKey(name);
    if (!key) return null;
    const town = row.town?.trim() || null;
    return {
      // One observation per fiscal-year row; the record key is hashed (no tax-id or ZIP digits).
      externalId: `fy${h.fiscalYear}|${hashKey(`${key}|${state}|${(town ?? '').toLowerCase()}|${h.rowKey ?? ''}`)}`,
      payload: {
        name,
        aliases: [],
        externalIds: [{ namespace: 'us_h1b_employer', id: `${key}|${state}` }],
        locations: [],
        industries: [],
        sponsorshipHistory: {
          register: US_H1B_REGISTER,
          country: 'US',
          route: route.label,
          fiscalYear: h.fiscalYear,
          initialApprovals: h.initialApprovals,
          initialDenials: h.initialDenials,
          continuingApprovals: h.continuingApprovals,
          continuingDenials: h.continuingDenials,
          state,
          city: town,
        },
      },
    };
  },
};
