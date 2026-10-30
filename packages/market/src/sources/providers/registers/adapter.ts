import type { CompanyObservationPayload } from '../../../contracts/observations';
import type { IdentityNamespace } from '../../../companies/external-ids';
import { basicNormalize } from '../../../companies/normalize';

/**
 * Public sponsor registers as adapters (M8.4, DECISION_LOG "Owner request: add the Netherlands
 * and US H-1B sponsor datasets"). A register is described entirely by one adapter: its id, the
 * source provider it is registered under, a parser per file format, a route taxonomy that gives
 * every route a meaning, its identity namespace, its evidence tier and its scope. The import
 * workflow (`market.sponsor_register.import`), the row capability and finalisation (delisting and
 * the anomaly guard) are shared, so adding a register means adding one adapter to the registry.
 *
 * Semantics shared by every register: a listing is COMPANY-level evidence for the register's
 * country only. It is never a role statement and never evidence for another country.
 */

/**
 * What a route of a register means for sponsorship:
 *  - `labour`: the company may sponsor workers on this route: capability evidence
 *    (`company_capable` for jobs in the register's country);
 *  - `history`: past sponsorship activity (hiring history, `historical_evidence`), never capability;
 *  - `ignored`: not employment sponsorship (study, au pair, exchange): no evidence at all.
 */
export const ROUTE_MEANINGS = ['labour', 'history', 'ignored'] as const;
export type RouteMeaning = (typeof ROUTE_MEANINGS)[number];

/** The evidence tier a register's listings enter the evidence hierarchy at (M11). */
export const REGISTER_EVIDENCE_TIERS = ['capability', 'history'] as const;
export type RegisterEvidenceTier = (typeof REGISTER_EVIDENCE_TIERS)[number];

export interface RouteDefinition {
  /** Stable id of the route within its register. */
  id: string;
  /** Canonical label, stored as the licence `route`. */
  label: string;
  meaning: RouteMeaning;
  /** Published spellings (compared after {@link routeKey}). */
  aliases: readonly string[];
  /**
   * Keywords (compared on {@link routeKey} word boundaries): a published route that matches no
   * alias but contains a keyword only RESEMBLES this route, so it is `ignored` and reported as
   * unlisted. Keywords never give a route its meaning.
   */
  keywords?: readonly string[];
}

/** A route as the importer classified it. */
export interface ClassifiedRoute {
  /** Route id, or null when the taxonomy does not list the published route. */
  id: string | null;
  label: string;
  meaning: RouteMeaning;
}

/**
 * One register row in the adapter-neutral shape the parse step writes to the record set (JSON,
 * one per line). `route` is the route as published; `locator` points back into the snapshot.
 */
export interface RegisterRow {
  locator: string;
  name: string;
  route: string;
  town?: string | null;
  county?: string | null;
  typeRating?: string | null;
  /** The register-listed identifier as published (e.g. a KvK number), before normalisation. */
  identity?: string | null;
  /** History registers: the row's fiscal year and petition counts (M11.5). */
  history?: RegisterHistoryCounts | null;
}

export interface RegisterHistoryCounts {
  fiscalYear: number;
  initialApprovals: number;
  initialDenials: number;
  continuingApprovals: number;
  continuingDenials: number;
  /** Extra row keys that tell the register's rows apart (e.g. ZIP, tax-id suffix). Never shown. */
  rowKey?: string | null;
}

export interface ParsedRegister {
  /** The file format the parser recognised, e.g. `csv`, `html_table`. */
  format: string;
  rows: RegisterRow[];
  /** Rows the parser could not use (no name, no route), with their locators. Codes only. */
  skipped: Array<{ locator: string; reason: string }>;
  /** File rows summed into an earlier row with the same row key (history registers). */
  summedRows?: number;
}

export interface RegisterObservation {
  /** The record key of the observation within its source (stable across imports). */
  externalId: string;
  payload: CompanyObservationPayload;
}

export interface RegisterAdapter {
  /** Register id, stored as `sponsorLicence.register` / `licences[].register`. */
  id: string;
  /** The Market source `provider` this adapter is registered under. */
  provider: string;
  title: string;
  publisher: string;
  /** Where the register is published (the default endpoint; also recorded in the contract). */
  publicationUrl: string;
  /** Licence / attribution text for the data. */
  attribution: string;
  /** Country whose immigration system the register belongs to. Evidence applies to it only. */
  scope: { country: string };
  evidenceTier: RegisterEvidenceTier;
  /** Namespace of the register-listed identifier (null: the register lists none). */
  identityNamespace: IdentityNamespace | null;
  parser: { name: string; version: string };
  routes: readonly RouteDefinition[];
  /**
   * The meaning of a route the taxonomy does not list. UK: `labour` (every route of the workers
   * register was capability before M8.4, unchanged). Others: `ignored` — an unrecognised route
   * never becomes evidence; it is reported in the parse output.
   */
  unlistedRouteMeaning: RouteMeaning;
  /** Finds the current download on a publication page (registers whose file URL changes). */
  locateDownload?(html: string, pageUrl: string): string | null;
  /**
   * The URL fetched when the source has no `endpoint.url` (and the run no `url`); null: the source
   * must name its file. NL: the labour register page, never the register index.
   */
  defaultEndpoint: string | null;
  /** Parses a snapshot's bytes (format detected from the content). Throws {@link RegisterFormatError}. */
  parse(bytes: Uint8Array): ParsedRegister;
  /** One row → one company observation; null for an unusable row or a route that is not evidence. */
  toObservation(row: RegisterRow): RegisterObservation | null;
}

/** The snapshot is not in a format the adapter knows (wrong file, changed publication format). */
export class RegisterFormatError extends Error {
  override name = 'RegisterFormatError';
}

/** Route labels compared case-, accent- and punctuation-insensitively. */
export function routeKey(label: string): string {
  // "Public register …" / "Openbaar register …" and a trailing directive reference ("(Directive
  // (EU) 2016/801)", "in de zin van richtlijn (EU) 2016/801") are presentation, not the route
  // (delta review A-M1). What remains must still equal an alias exactly.
  return basicNormalize(label)
    .replace(/^(the )?(public register|openbaar register)( of| van)?( the| de| het)? ?/, '')
    .replace(/ ?(in de zin van |under |according to )?(directive|richtlijn)( eu)? \d{4} \d+$/, '')
    .trim();
}

/**
 * Classify a published route with a register's taxonomy. Fails closed (DECISION_LOG "Sponsor
 * register adapters" (1)): a route gets its taxonomy meaning only by an EXACT alias; a route that
 * only resembles a taxonomy route (keywords: "Public register seasonal labour pilot", "Stagiair
 * arbeid in loondienst") is `ignored` and reported as unlisted (id null), never labour or history.
 * A route matching neither gets the adapter's `unlistedRouteMeaning`.
 */
export function classifyRoute(adapter: RegisterAdapter, published: string): ClassifiedRoute {
  const key = routeKey(published);
  const byAlias = adapter.routes.find((r) => [r.label, ...r.aliases].some((a) => routeKey(a) === key));
  if (byAlias) return { id: byAlias.id, label: byAlias.label, meaning: byAlias.meaning };
  const padded = ` ${key} `;
  const resembles = adapter.routes.some((r) =>
    (r.keywords ?? []).some((k) => padded.includes(` ${routeKey(k)} `)),
  );
  return { id: null, label: published.trim(), meaning: resembles ? 'ignored' : adapter.unlistedRouteMeaning };
}

export interface RouteCount {
  route: string;
  id: string | null;
  meaning: RouteMeaning;
  rows: number;
}

/**
 * The rows of a parsed register that are evidence (every route but `ignored`), with per-route
 * counts. The one filter the import (`market.parse_register_snapshot`) and the register golden
 * suite share.
 */
export function keepEvidenceRows(
  adapter: RegisterAdapter,
  rows: readonly RegisterRow[],
): { kept: RegisterRow[]; routes: RouteCount[] } {
  const counts = new Map<string, RouteCount>();
  const kept: RegisterRow[] = [];
  for (const row of rows) {
    const route = classifyRoute(adapter, row.route);
    const key = `${route.id ?? ''}|${route.label}`;
    const c = counts.get(key) ?? { route: route.label, id: route.id, meaning: route.meaning, rows: 0 };
    c.rows += 1;
    counts.set(key, c);
    if (route.meaning !== 'ignored') kept.push(row);
  }
  return { kept, routes: [...counts.values()].sort((a, b) => a.route.localeCompare(b.route)) };
}
