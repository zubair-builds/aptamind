import { normalizeIdentity } from '../../../companies/external-ids';
import { splitTradingName, strictNameKey } from '../../../companies/normalize';
import {
  classifyRoute,
  routeKey,
  type ParsedRegister,
  RegisterFormatError,
  type RegisterAdapter,
  type RegisterRow,
  type RouteDefinition,
} from './adapter';
import { decodeText, findColumn, looksLikeHtml, readDelimited, readHtmlTables } from './tabular';

/**
 * Netherlands IND "Openbaar register erkende referenten" (public register of recognised
 * sponsors), M8.4. The IND publishes one public register per residence purpose on ind.nl, each an
 * HTML table of organisation name and KvK (Chamber of Commerce) number; the purpose is the
 * register's (page or table) heading. Only the labour purposes are sponsorship capability:
 * regular labour and highly skilled migrants, researchers (Directive (EU) 2016/801) and the EU
 * Blue Card where it is listed; study, au pair and exchange are not employment sponsorship and are
 * ignored, as are seasonal labour, trainees, intra-corporate transferees, the orientation year and
 * any heading the taxonomy does not list exactly (reported in `unlistedRoutes`, never capability).
 * A route is labour only by an exact alias (fail closed).
 *
 * Identity: the KvK number (`nl_kvk`) when the register lists one, else the name rules every
 * register row goes through (exact legal name → review on doubt). The register lists no town.
 */
export const NL_IND_REGISTER = 'nl_ind_recognised_sponsors';
export const NL_IND_PROVIDER = 'nl_ind_recognised_sponsors';
export const NL_IND_PUBLICATION_URL = 'https://ind.nl/en/public-register-recognised-sponsors';
/** The live labour register page (the old `…/public-register-regular-labour-and-highly-skilled-migrants` URL redirects here). */
export const NL_IND_LABOUR_REGISTER_URL =
  'https://ind.nl/en/public-register-recognised-sponsors/public-register-work';
export const NL_IND_RESEARCH_REGISTER_URL =
  'https://ind.nl/en/public-register-recognised-sponsors/public-register-research-directive-eu-2016-801';

export const NL_IND_ROUTES: readonly RouteDefinition[] = [
  {
    id: 'regular_labour_highly_skilled',
    label: 'Regular labour and highly skilled migrants',
    meaning: 'labour',
    aliases: [
      'Public register regular labour and highly skilled migrants',
      'Regular labour and highly skilled migrant',
      'Labour and highly skilled migrants',
      'Arbeid regulier en kennismigranten',
      'Openbaar register arbeid regulier en kennismigranten',
      'Openbaar register Arbeid regulier en Kennismigranten',
      'Regular labour',
      'Arbeid regulier',
      'Highly skilled migrants',
      'Highly skilled migrant',
      'Kennismigranten',
      'Kennismigrant',
      // Combined listings that include the EU Blue Card (delta review A-M1).
      'Kennismigranten en Europese blauwe kaart',
      'Regular labour and highly skilled migrants (including EU Blue Card)',
      'Highly skilled migrants and EU Blue Card',
      // The live page since 2026 (real-file gate 2026-10-30): h1 "Public register Work", for the
      // residence purposes work and highly skilled migrant.
      'Public register Work',
      'Openbaar register Arbeid',
      'Openbaar register Werk',
    ],
    keywords: ['labour', 'labor', 'arbeid', 'highly skilled', 'kennismigrant', 'kennismigranten'],
  },
  {
    id: 'research',
    label: 'Researchers (Directive (EU) 2016/801)',
    meaning: 'labour',
    aliases: [
      'Public register research (Directive (EU) 2016/801)',
      'Public register research',
      'Research (Directive (EU) 2016/801)',
      'Researchers',
      'Researcher',
      'Research',
      'Onderzoek (richtlijn (EU) 2016/801)',
      'Openbaar register onderzoek (richtlijn (EU) 2016/801)',
      'Openbaar register onderzoek',
      'Wetenschappelijk onderzoek',
      'Onderzoek',
      'Onderzoekers',
      'Onderzoeker',
      'Wetenschappelijk onderzoekers',
    ],
    keywords: ['research', 'researcher', 'researchers', 'onderzoek', 'onderzoeker', 'onderzoekers'],
  },
  {
    id: 'eu_blue_card',
    label: 'EU Blue Card',
    meaning: 'labour',
    aliases: ['European Blue Card', 'Europese blauwe kaart', 'Blue Card'],
    keywords: ['blue card', 'blauwe kaart'],
  },
  // Not recognised-sponsor labour capability for this register (DECISION_LOG "Sponsor register
  // adapters" (1)): explicit ignored aliases, so these never borrow a labour meaning.
  {
    id: 'seasonal_labour',
    label: 'Seasonal labour',
    meaning: 'ignored',
    aliases: ['Seasonal work', 'Seasonal worker', 'Seasonal workers', 'Seizoensarbeid', 'Seizoenarbeid'],
    keywords: ['seasonal', 'seizoensarbeid', 'seizoenswerk'],
  },
  {
    id: 'trainee',
    label: 'Trainee',
    meaning: 'ignored',
    aliases: ['Trainees', 'Stagiair', 'Stagiairs', 'Stagiair arbeid in loondienst', 'Traineeship'],
    keywords: ['trainee', 'trainees', 'stagiair', 'stagiairs', 'stage'],
  },
  {
    id: 'intra_corporate_transfer',
    label: 'Intra-corporate transferee',
    meaning: 'ignored',
    aliases: [
      'Intra-corporate transferees',
      'Intra-corporate transfer',
      'ICT',
      'Overplaatsing binnen een onderneming',
      'Houder van een ICT-vergunning',
    ],
    keywords: ['intra corporate', 'ict', 'overplaatsing'],
  },
  {
    id: 'orientation_year',
    label: 'Orientation year',
    meaning: 'ignored',
    aliases: [
      'Orientation year for highly educated persons',
      'Search year highly educated persons',
      'Zoekjaar hoogopgeleiden',
      'Zoekjaar',
    ],
    keywords: ['orientation year', 'zoekjaar', 'search year'],
  },
  {
    id: 'study',
    label: 'Study',
    meaning: 'ignored',
    aliases: ['Public register study', 'Openbaar register studie', 'Studie'],
    keywords: ['study', 'studie', 'student', 'students', 'studenten'],
  },
  {
    id: 'au_pair',
    label: 'Au pair',
    meaning: 'ignored',
    aliases: ['Public register au pair', 'Openbaar register au pair'],
    keywords: ['au pair'],
  },
  {
    id: 'exchange',
    label: 'Exchange',
    meaning: 'ignored',
    aliases: [
      'Public register exchange',
      'Openbaar register uitwisseling',
      'Uitwisseling',
      'Au pair and exchange',
      'Au pair en uitwisseling',
      'Cultural exchange',
    ],
    keywords: ['exchange', 'uitwisseling'],
  },
];

const NAME_COLUMN = [
  /^organisation$/,
  /^organization$/,
  /^organisatie$/,
  /^organisation name$/,
  /^naam( organisatie)?$/,
  /^name$/,
];
const KVK_COLUMN = [/^kvk( ?nummer| number)?$/, /kvk/, /chamber of commerce/, /^kamer van koophandel/];
const ROUTE_COLUMN = [
  /^category$/,
  /^categorie$/,
  /^register$/,
  /^residence purpose$/,
  /^verblijfsdoel$/,
  /^route$/,
];

/** Headings that name the register family, not a route (delta review A-M2). */
const GENERIC_HEADINGS = new Set(
  [
    'Recognised sponsors',
    'Erkende referenten',
    'Public register',
    'Openbaar register',
    'Register',
    // Explanatory section headings above the table on the live page (real-file gate 2026-10-30).
    'What is this register used for?',
    'Waarvoor is dit register?',
    'Waarvoor wordt dit register gebruikt?',
  ].map(routeKey),
);
function isGenericHeading(heading: string): boolean {
  return GENERIC_HEADINGS.has(routeKey(heading));
}

/** The route of a table with no heading of its own: unlisted, so ignored and reported. */
export const NO_OWN_HEADING = '(table without its own register heading)';

const clean = (s: string | undefined | null) => s?.replace(/\s+/g, ' ').trim() || null;

function parseNlRegister(bytes: Uint8Array): ParsedRegister {
  const text = decodeText(bytes);
  const rows: RegisterRow[] = [];
  const skipped: ParsedRegister['skipped'] = [];
  if (looksLikeHtml(text)) {
    const tables = readHtmlTables(text, { isGenericHeading }).filter(
      (t) => findColumn(t.header, NAME_COLUMN) >= 0,
    );
    if (!tables.length)
      throw new RegisterFormatError('no register table with an organisation column in the page');
    for (const t of tables) {
      const name = findColumn(t.header, NAME_COLUMN);
      const kvk = findColumn(t.header, KVK_COLUMN);
      const routeCol = findColumn(t.header, ROUTE_COLUMN);
      t.rows.forEach((cells, i) => {
        const locator = `table:${t.index}/row:${i + 1}`;
        const n = clean(cells[name]);
        // A table without a heading of its own is not a recognised register (fail closed).
        const route = clean(routeCol >= 0 ? cells[routeCol] : (t.heading ?? NO_OWN_HEADING));
        if (!n || !route) {
          skipped.push({ locator, reason: n ? 'no_route' : 'no_name' });
          return;
        }
        rows.push({ locator, name: n, route, identity: kvk >= 0 ? clean(cells[kvk]) : null });
      });
    }
    return { format: 'html_table', rows, skipped };
  }
  // Operator upload: a CSV/TSV with organisation, KvK number and the register (category) column.
  const table = readDelimited(text);
  const name = findColumn(table.header, NAME_COLUMN);
  const kvk = findColumn(table.header, KVK_COLUMN);
  const routeCol = findColumn(table.header, ROUTE_COLUMN);
  if (name < 0 || routeCol < 0)
    throw new RegisterFormatError('missing the "Organisation" or "Category" (register) column');
  for (const r of table.rows) {
    const locator = `row:${r.line}`;
    const n = clean(r.cells[name]);
    const route = clean(r.cells[routeCol]);
    if (!n || !route) {
      skipped.push({ locator, reason: n ? 'no_route' : 'no_name' });
      continue;
    }
    rows.push({ locator, name: n, route, identity: kvk >= 0 ? clean(r.cells[kvk]) : null });
  }
  return { format: table.delimiter === '\t' ? 'tsv' : 'csv', rows, skipped };
}

export const nlIndRegisterAdapter: RegisterAdapter = {
  id: NL_IND_REGISTER,
  provider: NL_IND_PROVIDER,
  title: 'Openbaar register erkende referenten (public register of recognised sponsors)',
  publisher: 'Immigratie- en Naturalisatiedienst (IND), Netherlands',
  publicationUrl: NL_IND_PUBLICATION_URL,
  defaultEndpoint: NL_IND_LABOUR_REGISTER_URL,
  attribution:
    'Source: IND public register of recognised sponsors (ind.nl), public government information (Wet hergebruik overheidsinformatie).',
  scope: { country: 'NL' },
  evidenceTier: 'capability',
  identityNamespace: 'nl_kvk',
  parser: { name: 'nl-ind-register-row', version: '1' },
  routes: NL_IND_ROUTES,
  unlistedRouteMeaning: 'ignored',
  parse: parseNlRegister,
  toObservation(row) {
    const name = row.name.trim();
    if (!name) return null;
    const route = classifyRoute(nlIndRegisterAdapter, row.route);
    // Only labour routes are evidence; study, au pair, exchange and unrecognised routes are not.
    if (route.meaning !== 'labour' || !route.id) return null;
    const { legal, tradingAs } = splitTradingName(name);
    const kvk = normalizeIdentity('nl_kvk', row.identity);
    const record = kvk ? `kvk:${kvk}` : `name:${strictNameKey(legal)}`;
    return {
      externalId: `${record}|${route.id}`,
      payload: {
        name,
        legalName: legal,
        aliases: tradingAs ? [tradingAs] : [],
        externalIds: kvk ? [{ namespace: 'nl_kvk', id: kvk }] : [],
        locations: [],
        industries: [],
        sponsorLicence: {
          register: NL_IND_REGISTER,
          country: 'NL',
          route: route.label,
          typeRating: null,
          town: null,
          county: null,
        },
      },
    };
  },
};
