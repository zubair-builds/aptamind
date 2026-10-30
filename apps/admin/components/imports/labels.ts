import { fmtNum } from '@/lib/format';
import type { ImportCounts, ImportType } from '@/lib/types';

export const IMPORT_TYPE_LABELS: Record<ImportType, string> = {
  companies: 'Companies',
  ats_boards: 'Known ATS boards',
  snapshot: 'Source snapshot',
  jobs: 'Jobs',
};

export const importTypeLabel = (t: string) => IMPORT_TYPE_LABELS[t as ImportType] ?? t;

type CountLabel = readonly [keyof ImportCounts, string, string];

/** Count labels in reading order (the API's own fields; null = not known yet / not meaningful). */
export const COUNT_LABELS: ReadonlyArray<CountLabel> = [
  ['rows', 'Rows', 'rows'],
  ['parsed', 'Read', 'read'],
  ['accepted', 'Accepted', 'accepted'],
  ['created', 'Created', 'created'],
  ['updated', 'Updated', 'updated'],
  ['unchanged', 'Unchanged', 'unchanged'],
  ['ignored', 'Skipped', 'skipped'],
  ['warnings', 'Warnings', 'with warnings'],
  ['failed', 'Failed', 'failed'],
  ['reviews', 'Reviews opened', 'reviews'],
];

/** An ATS board import creates job sources, not companies. */
const ATS_COUNT_LABELS: Partial<Record<keyof ImportCounts, readonly [string, string]>> = {
  created: ['Boards registered', 'boards registered'],
};

/** The count labels for one import type. */
export function countLabels(type?: string): ReadonlyArray<CountLabel> {
  if (type !== 'ats_boards') return COUNT_LABELS;
  return COUNT_LABELS.map(([key, label, word]) => {
    const own = ATS_COUNT_LABELS[key];
    return own ? ([key, own[0], own[1]] as const) : ([key, label, word] as const);
  });
}

/** Trace label for the sources an import touched. */
export const traceSourcesLabel = (type?: string) =>
  type === 'ats_boards' ? 'Sources linked' : 'Sources registered';

const SUMMARY: ReadonlyArray<keyof ImportCounts> = [
  'rows',
  'created',
  'updated',
  'warnings',
  'failed',
  'reviews',
];
const SINGULAR: Partial<Record<keyof ImportCounts, string>> = { rows: 'row', reviews: 'review' };

/**
 * "1,204 rows · 1,100 created · 3 failed": known counts only; zeros after `rows` are left out, and
 * so is a count an older API build does not send.
 */
export function countsSummary(counts: ImportCounts | null | undefined, type?: string): string {
  if (!counts) return '';
  const labels = countLabels(type);
  const parts: string[] = [];
  for (const key of SUMMARY) {
    const v = counts[key];
    if (v === null || v === undefined || (key !== 'rows' && v === 0)) continue;
    const word = (v === 1 && SINGULAR[key]) || labels.find(([k]) => k === key)![2];
    parts.push(`${fmtNum(v)} ${word}`);
  }
  return parts.join(' · ');
}

/**
 * Row codes an ATS board import report can hold (market-imports.md, OPS-1b), in plain words.
 * The page does not read the report; it explains the codes next to the report link.
 */
export const ATS_REPORT_CODES: ReadonlyArray<readonly [code: string, text: string]> = [
  [
    'not_an_ats_url',
    'Warning. The URL is not a Greenhouse, Ashby or Lever board, so it was not used. Without a provider and token the row is skipped.',
  ],
  ['board_not_live', 'Failed. The board does not exist or has no job listing. Nothing was created.'],
  [
    'board_unreachable',
    'Failed. The board site did not answer in time or sent an error. Import the file again to retry.',
  ],
  ['no_identity', 'Failed. The row has no company name or domain, and the board is not known yet.'],
  ['url_mismatch', 'Failed. The provider or token in the row does not match the URL.'],
  ['missing_board', 'Failed. The row has no provider, token or URL.'],
  ['invalid_url', 'Failed. The URL is on a board site, but no board token can be read from it.'],
];
