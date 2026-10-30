/**
 * Market-owned registry of external company identifier namespaces (DECISION_LOG "Company
 * directory imports"): the allowlist of namespaces an upload may assert, each with a format
 * normaliser. An identifier from an upload is kept only in its normalised form; a value that does
 * not fit its namespace's format, or a namespace outside the registry, is a row error — an upload
 * never invents an identity-key namespace.
 */

export interface ExternalIdNamespace {
  label: string;
  /**
   * `register_id`: an official identifier (a company number, the Dutch KvK number) — it identifies
   * the legal entity, whoever lists it. `row_identity`: a register's own row key (the UK register's
   * name + town, the H-1B Data Hub's name + state) — meaningful only within that register, never an
   * identifier: two different row keys on one company never contradict (DECISION_LOG "Sponsor
   * register adapters" (2)). `board_id`: a live ATS job board (DECISION_LOG "A live ATS board is
   * company identity evidence"): it identifies the employer, but it is not a register entry.
   */
  kind: 'register_id' | 'row_identity' | 'board_id';
  /** The normalised identifier, or null when `raw` is not a valid identifier of this namespace. */
  normalize(raw: string): string | null;
  example: string;
  /**
   * Whether two different ids of this namespace on one company contradict (DECISION_LOG
   * re-verification #5 item 6 and #6 item 3). Default: always (one company number, one LEI, …).
   */
  contradicts?: (a: string, b: string) => boolean;
}

const compact = (raw: string) => raw.replace(/[\s.-]+/g, '').toUpperCase();

/** ISO 7064 MOD 97-10 (LEI check digits). */
function mod97(s: string): number {
  let r = 0;
  for (const ch of s) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) r = (r * 10 + Number(d)) % 97;
  }
  return r;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let k = 0; k < digits.length; k++) {
    let d = Number(digits[digits.length - 1 - k]);
    if (k % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Companies House company-number prefixes (Companies House register guidance). */
const COMPANIES_HOUSE_PREFIXES = new Set([
  'AC',
  'BR',
  'CE',
  'CS',
  'FC',
  'FE',
  'GE',
  'GN',
  'GS',
  'IC',
  'IP',
  'LP',
  'NA',
  'NC',
  'NF',
  'NI',
  'NL',
  'NO',
  'NP',
  'NR',
  'NV',
  'NZ',
  'OC',
  'OE',
  'PC',
  'RC',
  'SA',
  'SC',
  'SE',
  'SF',
  'SG',
  'SI',
  'SL',
  'SO',
  'SP',
  'SR',
  'SZ',
  'ZC',
]);

/**
 * The Netherlands KvK number: one definition, shared by the upload registry and the register
 * providers (the NL IND register lists it). Exactly 8 digits; one repeated digit (00000000,
 * 11111111) is a placeholder, not an id (DECISION_LOG "Sponsor register adapters" (10)).
 */
const NL_KVK: ExternalIdNamespace = {
  label: 'Netherlands KvK number (Chamber of Commerce)',
  kind: 'register_id',
  example: '33011433',
  normalize(raw) {
    const v = compact(raw);
    return /^\d{8}$/.test(v) && !/^(\d)\1+$/.test(v) ? v : null;
  },
};

/**
 * The ATS board namespace (OPS-1b): the board's source key, lowercased (`greenhouse:acme`, or
 * `greenhouse:eu:acme` for a regional board: the EU and default hosts are different boards, A-L3).
 */
export const ATS_ID_NAMESPACE = 'ats';
const ATS_ID_PATTERN = /^(greenhouse|ashby|lever):(?:[a-z]{2,10}:)?[a-z0-9][a-z0-9._-]*(?: [a-z0-9._-]+)*$/;

/**
 * The `ats` external id of a board. `boardKey` is the board's source key (`boardKeyOf`), so the
 * id and the source key can never disagree on the region. Tokens are case-insensitive.
 */
export function atsExternalId(boardKey: string): { namespace: string; id: string } {
  return { namespace: ATS_ID_NAMESPACE, id: boardKey.toLowerCase() };
}

const ATS_BOARD: ExternalIdNamespace = {
  label: 'ATS job board (provider:token, or provider:region:token)',
  kind: 'board_id',
  // A company may hire through several boards (two providers, or an EU and a default host).
  contradicts: () => false,
  example: 'greenhouse:acme',
  normalize(raw) {
    const v = raw.trim().toLowerCase();
    return v.length <= 130 && ATS_ID_PATTERN.test(v) ? v : null;
  },
};

export const EXTERNAL_ID_NAMESPACES: Readonly<Record<string, ExternalIdNamespace>> = {
  [ATS_ID_NAMESPACE]: ATS_BOARD,
  gb_companies_house: {
    label: 'UK Companies House company number',
    kind: 'register_id',
    // BR numbers register UK establishments of an overseas company: several BR numbers may sit on
    // one company, and only beside its FC number. BR plus any other company number, two FC
    // numbers, or two ordinary numbers contradict.
    contradicts: (a, b) => {
      const kind = (id: string) => (id.startsWith('BR') ? 'BR' : id.startsWith('FC') ? 'FC' : 'CO');
      const [x, y] = [kind(a), kind(b)].sort();
      return !((x === 'BR' && y === 'BR') || (x === 'BR' && y === 'FC'));
    },
    example: '00445790 or SC123456',
    normalize(raw) {
      const v = compact(raw);
      // England and Wales: up to 8 digits, zero-padded.
      if (/^\d{1,8}$/.test(v)) return v.padStart(8, '0');
      // Old Northern Ireland numbers: R0 + 6 digits.
      if (/^R0\d{6}$/.test(v)) return v;
      // A published two-letter prefix + up to 6 digits (zero-padded): SC, NI, OC, SO, NC, LP, …
      const m = /^([A-Z]{2})(\d{1,6})$/.exec(v);
      return m && COMPANIES_HOUSE_PREFIXES.has(m[1]!) ? `${m[1]}${m[2]!.padStart(6, '0')}` : null;
    },
  },
  ie_cro: {
    label: 'Ireland CRO company number',
    kind: 'register_id',
    example: '123456',
    normalize(raw) {
      const v = compact(raw);
      return /^\d{1,7}$/.test(v) ? String(Number(v)) : null;
    },
  },
  lei: {
    label: 'Legal Entity Identifier (ISO 17442)',
    kind: 'register_id',
    example: '5493001KJTIIGC8Y1R12',
    normalize(raw) {
      const v = compact(raw);
      return /^[A-Z0-9]{18}\d{2}$/.test(v) && mod97(v) === 1 ? v : null;
    },
  },
  duns: {
    label: 'D-U-N-S number',
    kind: 'register_id',
    // One D-U-N-S number per site: a company has many.
    contradicts: () => false,
    example: '150483782',
    normalize(raw) {
      const v = compact(raw);
      return /^\d{9}$/.test(v) ? v : null;
    },
  },
  fr_siren: {
    label: 'France SIREN',
    kind: 'register_id',
    example: '552100554',
    normalize(raw) {
      const v = compact(raw);
      return /^\d{9}$/.test(v) && luhn(v) ? v : null;
    },
  },
  nl_kvk: NL_KVK,
  us_ein: {
    label: 'US Employer Identification Number',
    kind: 'register_id',
    example: '12-3456789',
    normalize(raw) {
      const v = compact(raw);
      return /^\d{9}$/.test(v) ? `${v.slice(0, 2)}-${v.slice(2)}` : null;
    },
  },
  wikidata: {
    label: 'Wikidata item',
    kind: 'register_id',
    example: 'Q95',
    normalize(raw) {
      const v = raw.trim().toUpperCase();
      return /^Q[1-9]\d{0,11}$/.test(v) ? v : null;
    },
  },
};

export function isKnownExternalIdNamespace(namespace: string): boolean {
  return Object.hasOwn(EXTERNAL_ID_NAMESPACES, namespace);
}

/** A register namespace (a company number, an LEI, …): not a board id. */
export function isRegisterIdNamespace(namespace: string): boolean {
  return isKnownExternalIdNamespace(namespace) && EXTERNAL_ID_NAMESPACES[namespace]!.kind === 'register_id';
}

/** `{ id }` normalised, `{ error: 'unknown_namespace' | 'invalid_format' }` otherwise. */
export function normalizeExternalId(
  namespace: string,
  raw: string,
): { id: string } | { error: 'unknown_namespace' | 'invalid_format' } {
  if (!isKnownExternalIdNamespace(namespace)) return { error: 'unknown_namespace' };
  const id = EXTERNAL_ID_NAMESPACES[namespace]!.normalize(raw);
  return id ? { id } : { error: 'invalid_format' };
}

/**
 * Whether two external ids contradict: the same Market registry namespace, different ids, and the
 * namespace does not allow both on one company (see `ExternalIdNamespace.contradicts`).
 */
export function idsContradict(
  a: { namespace: string; id: string },
  b: { namespace: string; id: string },
): boolean {
  if (a.namespace !== b.namespace || a.id === b.id || !isKnownExternalIdNamespace(a.namespace)) return false;
  const rule = EXTERNAL_ID_NAMESPACES[a.namespace]!.contradicts;
  return rule ? rule(a.id, b.id) : true;
}

/**
 * External ids of a company observation with known registry namespaces normalised (`445790` →
 * `gb_companies_house:00445790`), for every provider; an id that does not fit its namespace, or an
 * unknown namespace, is kept as given. Order is kept (a payload that needs no normalisation is
 * unchanged, so its observation id is too).
 */
export function normalizeObservationExternalIds(
  ids: Array<{ namespace: string; id: string }>,
): Array<{ namespace: string; id: string }> {
  return ids.map((e) => {
    const r = isKnownExternalIdNamespace(e.namespace) ? normalizeExternalId(e.namespace, e.id) : null;
    return r && 'id' in r && r.id !== e.id ? { namespace: e.namespace, id: r.id } : e;
  });
}

/**
 * Identity namespaces the Market's own register providers assert on company observations
 * (`payload.externalIds[].namespace`, M8.4 / M11.5; folded here from `identity-namespaces.ts` —
 * DECISION_LOG "Sponsor register adapters" (10): one registry, one `nl_kvk`). Every one becomes a
 * company identity key `ext:<namespace>:<id>` once an observation carrying it resolves to a
 * company, so a namespace is only ever written in its normalised form and only by the provider
 * that owns it. The `row_identity` namespaces are not in `EXTERNAL_ID_NAMESPACES` (an upload can
 * never assert them, and they are never normalised or checked for contradictions as identifiers).
 * Accepted exception (supervisor, delta review L4): the UK `uk_sponsor_register` row key keeps
 * auto-attaching through the unchanged M2 resolver in v0.1 — it embeds the exact legal name and
 * town, so its match equals an exact name + town match, and it predates M8.4.
 */
export const IDENTITY_NAMESPACES = ['uk_sponsor_register', 'nl_kvk', 'us_h1b_employer', 'ats'] as const;
export type IdentityNamespace = (typeof IDENTITY_NAMESPACES)[number];
export type IdentityNamespaceDefinition = ExternalIdNamespace;

export const IDENTITY_NAMESPACE_DEFINITIONS: Readonly<
  Record<IdentityNamespace, IdentityNamespaceDefinition>
> = {
  uk_sponsor_register: {
    label: 'UK sponsor register row (name + town)',
    kind: 'row_identity',
    example: 'acme ltd|london',
    normalize: (raw) => raw.trim().toLowerCase() || null,
  },
  nl_kvk: NL_KVK,
  ats: ATS_BOARD,
  us_h1b_employer: {
    label: 'USCIS H-1B employer (name + state)',
    kind: 'row_identity',
    example: 'acme analytics inc|CA',
    normalize(raw) {
      // `<strict name key>|<two-letter state>`: the Data Hub's own employer key (it publishes only
      // the last four digits of the tax id, which identify nothing).
      const m = /^(.+)\|([A-Za-z]{2})$/.exec(raw.trim());
      return m ? `${m[1]!.trim().toLowerCase()}|${m[2]!.toUpperCase()}` : null;
    },
  },
};

/** The row-key namespaces (never uploadable, never identifiers). */
export const ROW_IDENTITY_NAMESPACES = IDENTITY_NAMESPACES.filter(
  (n) => IDENTITY_NAMESPACE_DEFINITIONS[n].kind === 'row_identity',
);

export function normalizeIdentity(
  namespace: IdentityNamespace,
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  return IDENTITY_NAMESPACE_DEFINITIONS[namespace].normalize(raw);
}
