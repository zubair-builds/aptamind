import * as cheerio from 'cheerio';
import type { CompanyObservationPayload } from '../../contracts/observations';
import { splitTradingName, strictNameKey } from '../../companies/normalize';

/**
 * UK Home Office "Register of licensed sponsors: workers".
 *
 * Semantics (context §26): presence on the register means the organisation holds a sponsor
 * licence for the listed route. It is company-level capability evidence and must never be
 * projected onto individual roles as "this job sponsors".
 */

export const UK_SPONSOR_REGISTER = 'uk_home_office_licensed_sponsors_workers';
export const UK_SPONSOR_PARSER = { name: 'uk-sponsor-register-row', version: '1' } as const;
export const UK_SPONSOR_PUBLICATION_URL =
  'https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers';

export interface SponsorRow {
  name?: string | null;
  town?: string | null;
  county?: string | null;
  typeRating?: string | null;
  route?: string | null;
}

/** Column mapping used by the import workflow's Map Fields node. */
export const SPONSOR_COLUMN_MAPPING = {
  name: { path: 'Organisation Name', transforms: ['collapse_whitespace', 'null_if_empty'] },
  town: { path: 'Town/City', transforms: ['collapse_whitespace', 'null_if_empty'] },
  county: { path: 'County', transforms: ['collapse_whitespace', 'null_if_empty'] },
  typeRating: { path: 'Type & Rating', transforms: ['collapse_whitespace', 'null_if_empty'] },
  route: { path: 'Route', transforms: ['collapse_whitespace', 'null_if_empty'] },
} as const;

function titleCaseTown(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/** Map one register row to a company observation payload. Returns null for unusable rows. */
export function sponsorRowToPayload(
  row: SponsorRow,
): { payload: CompanyObservationPayload; externalId: string } | null {
  const name = row.name?.trim();
  if (!name || !row.route?.trim()) return null;
  const town = row.town?.trim() ? titleCaseTown(row.town.trim()) : null;
  const { legal, tradingAs } = splitTradingName(name);
  const rowIdentity = `${strictNameKey(legal)}|${(town ?? '').toLowerCase()}`;
  return {
    externalId: `${rowIdentity}|${row.route.trim().toLowerCase()}`,
    payload: {
      name,
      legalName: legal,
      aliases: tradingAs ? [tradingAs] : [],
      externalIds: [{ namespace: 'uk_sponsor_register', id: rowIdentity }],
      locations: town
        ? [{ city: town, region: row.county?.trim() || null, country: 'GB', kind: 'registered' }]
        : [],
      industries: [],
      sponsorLicence: {
        register: UK_SPONSOR_REGISTER,
        country: 'GB',
        route: row.route.trim(),
        typeRating: row.typeRating?.trim() || null,
        town,
        county: row.county?.trim() || null,
      },
    },
  };
}

/** Find the CSV download link on the gov.uk publication page. */
export function findRegisterCsvLink(html: string, pageUrl: string): string | null {
  const $ = cheerio.load(html);
  const links: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      const u = new URL(href, pageUrl);
      if (/\.csv($|\?)/i.test(u.pathname) && /worker/i.test(u.pathname + $(el).text())) links.push(u.href);
    } catch {
      /* ignore */
    }
  });
  return links[0] ?? null;
}
