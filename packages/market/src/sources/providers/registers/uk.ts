import {
  findRegisterCsvLink,
  sponsorRowToPayload,
  UK_SPONSOR_PARSER,
  UK_SPONSOR_PUBLICATION_URL,
  UK_SPONSOR_REGISTER,
} from '../uk-sponsor-register';
import { type ParsedRegister, RegisterFormatError, type RegisterAdapter, type RegisterRow } from './adapter';
import { decodeText, findColumn, looksLikeHtml, readDelimited } from './tabular';

/**
 * UK Home Office "Register of licensed sponsors: workers" as a register adapter. Behaviour is the
 * M2 register's, unchanged: the row mapping is `sponsorRowToPayload` (the same function the
 * `market.uk_sponsor_register.import` workflow's `market.process_sponsor_row` uses), identity is
 * the register's own row key (name + town, namespace `uk_sponsor_register`), and EVERY route of
 * the workers register is capability (`unlistedRouteMeaning: 'labour'`, no taxonomy entries): the
 * register lists only Worker and Temporary Worker routes. Classifying individual UK routes (e.g.
 * the Temporary Worker exchange routes) would change UK behaviour and is a separate decision.
 */
export const UK_REGISTER_PROVIDER = 'uk_home_office_sponsor_register';

/** CSV columns of the published register (also the Map Fields mapping of the M2 workflow). */
const COLUMNS = {
  name: [/^organisation name$/, /^organization name$/],
  town: [/^town city$/, /^town$/],
  county: [/^county$/],
  typeRating: [/^type rating$/, /^type and rating$/],
  route: [/^route$/],
} as const;

function parseUkRegister(bytes: Uint8Array): ParsedRegister {
  const text = decodeText(bytes);
  if (looksLikeHtml(text))
    throw new RegisterFormatError('an HTML page, not the register CSV (upload the CSV download)');
  const table = readDelimited(text);
  const col = Object.fromEntries(
    Object.entries(COLUMNS).map(([k, p]) => [k, findColumn(table.header, p)]),
  ) as Record<keyof typeof COLUMNS, number>;
  if (col.name < 0 || col.route < 0)
    throw new RegisterFormatError('missing the "Organisation Name" or "Route" column');
  const rows: RegisterRow[] = [];
  const skipped: ParsedRegister['skipped'] = [];
  const cell = (cells: string[], i: number) =>
    i >= 0 ? cells[i]?.replace(/\s+/g, ' ').trim() || null : null;
  for (const r of table.rows) {
    const locator = `row:${r.line}`;
    const name = cell(r.cells, col.name);
    const route = cell(r.cells, col.route);
    if (!name || !route) {
      skipped.push({ locator, reason: name ? 'no_route' : 'no_name' });
      continue;
    }
    rows.push({
      locator,
      name,
      route,
      town: cell(r.cells, col.town),
      county: cell(r.cells, col.county),
      typeRating: cell(r.cells, col.typeRating),
    });
  }
  return { format: table.delimiter === '\t' ? 'tsv' : 'csv', rows, skipped };
}

export const ukSponsorRegisterAdapter: RegisterAdapter = {
  id: UK_SPONSOR_REGISTER,
  provider: UK_REGISTER_PROVIDER,
  title: 'Register of licensed sponsors: workers',
  publisher: 'UK Home Office (GOV.UK)',
  publicationUrl: UK_SPONSOR_PUBLICATION_URL,
  defaultEndpoint: UK_SPONSOR_PUBLICATION_URL,
  attribution: 'Contains public sector information licensed under the Open Government Licence v3.0.',
  scope: { country: 'GB' },
  evidenceTier: 'capability',
  identityNamespace: 'uk_sponsor_register',
  parser: UK_SPONSOR_PARSER,
  routes: [],
  unlistedRouteMeaning: 'labour',
  locateDownload: findRegisterCsvLink,
  parse: parseUkRegister,
  toObservation(row) {
    return sponsorRowToPayload(row);
  },
};
