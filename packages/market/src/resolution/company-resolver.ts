import {
  companyDomain,
  firstSignificantToken,
  jaroWinkler,
  looseNameKey,
  looseNameKeysForLookup,
  strictNameKey,
  strictNameKeysForLookup,
} from '../companies/normalize';
import { idsContradict, isRegisterIdNamespace } from '../companies/external-ids';

/**
 * Deterministic company entity resolution.
 *
 * Order of evidence (context doc §11.2): external/source id → official domain → exact
 * legal name (strict key) → aliases → legal-form-insensitive name → fuzzy similarity.
 * Only the first three can auto-match with high confidence; weaker signals produce a review
 * decision instead of a merge. The resolver is pure over a lookup port so it is unit-testable.
 */

export const COMPANY_RESOLVER_VERSION = 'company-resolver/2';

export interface CompanyCandidate {
  name: string;
  /** The row's legal name, when it differs from `name` (directory rows: the Legal name column). */
  legalName?: string | null;
  aliases?: string[];
  domain?: string | null;
  externalIds?: Array<{ namespace: string; id: string }>;
  country?: string | null;
  /** The HQ or registered-office country only (seeds a created company; never a job or licence country). */
  hqCountry?: string | null;
  town?: string | null;
  /**
   * A company directory row (DECISION_LOG "Company directory imports", "… hardening" and
   * "Company directory identity is structural"):
   *  - a bare name (see `isBareName`) never auto-resolves: it goes to review, whatever it would
   *    otherwise match or create (a bare name may be a sole trader's personal name);
   *  - a domain or external-id hit auto-matches only when the row's own v2 strict or loose name
   *    key equals one of the company's own keys (`ownsName`); any other hit goes to review.
   */
  directoryRow?: boolean;
  /**
   * Resolve to a high-severity review whatever the evidence says (e.g. rows of one directory file
   * that share a name but carry different register ids). The reason is shown on the review.
   */
  forceReview?: string;
}

export interface CompanySummary {
  id: string;
  displayName: string;
  strictKeys: string[];
  looseKey: string;
  domain: string | null;
  hqCountry: string | null;
  registeredTowns: string[];
  /**
   * The company's primary names (display name, legal name). Its own name keys are computed from
   * these (and `aliases`) — never taken from `identityKeys`, which may hold legacy (name-norm/1)
   * keys. Defaults to `[displayName]`.
   */
  names?: string[];
  /** The company's alias names (trading names, merged companies' names). */
  aliases?: string[];
  /** The company's external ids (canonical `identity.externalIds`). */
  externalIds?: Array<{ namespace: string; id: string }>;
}

/**
 * The company's own v2 strict and loose name keys (from its names, not its identity keys); with
 * `aliases: false`, from its display and legal names only.
 */
export function ownNameKeys(
  m: CompanySummary,
  opts: { aliases?: boolean } = {},
): { strict: Set<string>; loose: Set<string> } {
  const names = [
    ...(m.names?.length ? m.names : [m.displayName]),
    ...(opts.aliases === false ? [] : (m.aliases ?? [])),
  ].filter(Boolean);
  return {
    strict: new Set(names.map(strictNameKey).filter(Boolean)),
    loose: new Set(names.map(looseNameKey).filter(Boolean)),
  };
}

/** The candidate's own names: its name and its legal name. */
function candidateNames(c: CompanyCandidate): string[] {
  return [c.name, ...(c.legalName ? [c.legalName] : [])];
}

/**
 * How the candidate's own v2 keys (from its name or legal name) meet the company's own keys:
 * `strict` or `loose` on the company's primary names, `alias` only on an alias, else null.
 */
export function nameOwnership(c: CompanyCandidate, m: CompanySummary): 'strict' | 'loose' | 'alias' | null {
  const primary = ownNameKeys(m, { aliases: false });
  const all = ownNameKeys(m);
  const strict = candidateNames(c).map(strictNameKey).filter(Boolean);
  const loose = candidateNames(c).map(looseNameKey).filter(Boolean);
  if (strict.some((k) => primary.strict.has(k))) return 'strict';
  if (loose.some((k) => primary.loose.has(k))) return 'loose';
  if (strict.some((k) => all.strict.has(k)) || loose.some((k) => all.loose.has(k))) return 'alias';
  return null;
}

/** Whether the candidate's own v2 strict or loose name key is one of the company's own keys. */
export function ownsName(c: CompanyCandidate, m: CompanySummary): boolean {
  return nameOwnership(c, m) !== null;
}

/**
 * Why a directory row must not auto-match `m` (DECISION_LOG "Directory rows auto-match only
 * without contradicting evidence"), or null. Checked for every match method:
 *  (b) a single-valued register namespace (every Market registry namespace) holds a different id
 *      on the company → high severity;
 *  (a) the row's own v2 key (name or legal name) is not one of the company's own keys;
 *  (d) the hit is alias-only;
 *  (c) countries disagree (both known);
 *  and for a loose-only (brand) key match, a town contradiction with its registered towns.
 */
export function directoryMatchProblem(
  c: CompanyCandidate,
  m: CompanySummary,
  method = '',
): { reason: string; severity: 'low' | 'medium' | 'high' } | null {
  const companyIds = m.externalIds ?? [];
  for (const e of c.externalIds ?? []) {
    const other = companyIds.find((x) => idsContradict(e, x));
    if (other)
      return {
        reason: `${m.displayName} already holds a different ${e.namespace} id; one company has one id per register`,
        severity: 'high',
      };
  }
  // Register ids that found nothing may not attach by name (or domain) to a company that holds
  // register ids only in other namespaces: nothing ties the two identities together (item 5).
  // An ATS board id is not a register id, so it neither triggers nor blocks this rule.
  const mine = (c.externalIds ?? []).filter((e) => isRegisterIdNamespace(e.namespace));
  const theirs = companyIds.filter((e) => isRegisterIdNamespace(e.namespace));
  if (
    method !== 'external_id' &&
    mine.length &&
    theirs.length &&
    !mine.some((e) => theirs.some((x) => x.namespace === e.namespace))
  )
    return {
      reason: `the row's register ids found nothing, and ${m.displayName} holds register ids only in other registers`,
      severity: 'low',
    };
  const ownership = nameOwnership(c, m);
  if (!ownership)
    return { reason: `the row's name differs from ${m.displayName}'s own names`, severity: 'medium' };
  if (ownership === 'alias')
    return { reason: `the row's name matches only an alias of ${m.displayName}`, severity: 'medium' };
  if (c.country && m.hqCountry && norm(c.country) !== norm(m.hqCountry))
    return { reason: `country ${c.country} ≠ ${m.displayName}'s ${m.hqCountry}`, severity: 'medium' };
  if (
    ownership === 'loose' &&
    c.town &&
    m.registeredTowns.length > 0 &&
    !m.registeredTowns.map(norm).includes(norm(c.town))
  )
    return {
      reason: `only the base name matches ${m.displayName}, and town ${c.town} is not among ${m.registeredTowns.join(', ')}`,
      severity: 'medium',
    };
  return null;
}

export interface CompanyLookup {
  byIdentityKey(key: string): Promise<CompanySummary | null>;
  byStrictName(strictKey: string): Promise<CompanySummary[]>;
  byLooseKey(looseKey: string): Promise<CompanySummary[]>;
  byFirstToken(token: string, limit: number): Promise<CompanySummary[]>;
}

export type ResolutionDecision =
  | { kind: 'match'; companyId: string; method: string; confidence: 'high' | 'medium'; reasons: string[] }
  | { kind: 'create'; reasons: string[] }
  | {
      kind: 'review';
      reason: string;
      severity: 'low' | 'medium' | 'high';
      candidates: Array<{ id: string; label: string; score: number; method: string }>;
      dedupeKey: string;
    };

const LEGAL_FORM_TOKENS = /\b(ltd|plc|llp|llc|inc|corp|gmbh|sa|bv|nv|ag|pty|lp|cic)\b/;
export const FUZZY_REVIEW_THRESHOLD = 0.92;

export function hasLegalForm(name: string): boolean {
  return LEGAL_FORM_TOKENS.test(strictNameKey(name));
}

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/** Names share a significant token or are fuzzy-similar (brand vs legal name variants pass). */
export function namesPlausiblySame(c: CompanyCandidate, m: CompanySummary): boolean {
  const stop = new Set([
    'the',
    'and',
    'of',
    'group',
    'holdings',
    'company',
    'uk',
    'global',
    'international',
    'services',
    'solutions',
  ]);
  const tokens = (s: string) =>
    new Set(
      looseNameKey(s)
        .split(' ')
        .filter((t) => t.length > 2 && !stop.has(t)),
    );
  const mine = new Set([...[c.name, ...(c.aliases ?? [])].flatMap((n) => [...tokens(n)])]);
  const theirs = tokens(m.displayName);
  for (const k of m.strictKeys) for (const t of tokens(k)) theirs.add(t);
  for (const t of mine) if (theirs.has(t)) return true;
  return jaroWinkler(looseNameKey(c.name), m.looseKey) >= 0.8;
}

/**
 * A directory row with no identifying evidence (DECISION_LOG "Directory rows auto-match only
 * without contradicting evidence"): it is non-bare ONLY with a valid register id or a mapped,
 * non-refused Domain. A legal form, a town or a country never lift bare status: "John Smith Ltd,
 * Leeds, UK" may be a sole trader or one of many same-named businesses.
 */
export function isBareName(c: CompanyCandidate): boolean {
  return !companyDomain(c.domain ?? null) && !(c.externalIds ?? []).length;
}

function dedupeKeyOf(c: CompanyCandidate): string {
  const base = `company_resolution:${strictNameKey(c.name)}:${companyDomain(c.domain ?? null) ?? ''}:${norm(c.town)}`;
  if (!c.directoryRow) return base;
  // Directory rows with different register ids, countries or legal names are different questions
  // (never one review item).
  const ids = (c.externalIds ?? []).map((e) => `${e.namespace}=${e.id}`).sort();
  return `${base}:${norm(c.country)}:${c.legalName ? strictNameKey(c.legalName) : ''}${ids.length ? `:${ids.join(',')}` : ''}`;
}

export async function resolveCompanyCandidate(
  c: CompanyCandidate,
  lookup: CompanyLookup,
): Promise<ResolutionDecision> {
  if (!c.directoryRow) return resolveEvidence(c, lookup);
  // Every company the ordinary resolution looked at, to offer as candidates and to gate a match.
  const seen = new Map<string, CompanySummary>();
  const keep = (m: CompanySummary | null) => (m && seen.set(m.id, m), m);
  const decision = await resolveEvidence(c, {
    byIdentityKey: async (k) => keep(await lookup.byIdentityKey(k)),
    byStrictName: async (k) => (await lookup.byStrictName(k)).map((m) => keep(m) as CompanySummary),
    byLooseKey: async (k) => (await lookup.byLooseKey(k)).map((m) => keep(m) as CompanySummary),
    byFirstToken: async (t, limit) =>
      (await lookup.byFirstToken(t, limit)).map((m) => keep(m) as CompanySummary),
  });
  const matched = decision.kind === 'match' ? seen.get(decision.companyId) : undefined;
  const candidateOf = (m: CompanySummary, method: string, score = 0.8) => ({
    id: m.id,
    label: m.displayName,
    score,
    method,
  });
  if (c.forceReview)
    return {
      kind: 'review',
      reason: c.forceReview,
      severity: 'high',
      candidates:
        decision.kind === 'review'
          ? decision.candidates
          : matched && decision.kind === 'match'
            ? [candidateOf(matched, decision.method)]
            : [],
      dedupeKey: dedupeKeyOf(c),
    };
  if (decision.kind === 'review') {
    // A review whose candidates hold a different single-valued register id is high severity,
    // whichever step raised it (e.g. a fuzzy review seen in the middle of a creation race).
    const contradicted = decision.candidates.some((cand) => {
      const m = seen.get(cand.id);
      return !!m && directoryMatchProblem(c, m)?.severity === 'high';
    });
    return contradicted && decision.severity !== 'high' ? { ...decision, severity: 'high' } : decision;
  }
  if (isBareName(c))
    return {
      kind: 'review',
      reason: matched
        ? `"${c.name}" has no register id and no company domain; it would match ${matched.displayName} by ${decision.kind === 'match' ? decision.method : ''} but a bare name is never matched automatically`
        : `"${c.name}" has no register id and no company domain; a company is never created from a bare name automatically`,
      severity: 'low',
      candidates: matched && decision.kind === 'match' ? [candidateOf(matched, decision.method)] : [],
      dedupeKey: dedupeKeyOf(c),
    };
  if (decision.kind === 'match' && matched) {
    const problem = directoryMatchProblem(c, matched, decision.method);
    if (problem)
      return {
        kind: 'review',
        reason: `Would match ${matched.displayName} by ${decision.method}, but ${problem.reason}`,
        severity: problem.severity,
        candidates: [candidateOf(matched, decision.method)],
        dedupeKey: dedupeKeyOf(c),
      };
  }
  return decision;
}

async function resolveEvidence(c: CompanyCandidate, lookup: CompanyLookup): Promise<ResolutionDecision> {
  const loose = looseNameKey(c.name);
  const domain = companyDomain(c.domain ?? null);
  const dedupeKey = dedupeKeyOf(c);
  const reasons: string[] = [];

  // 1. External ids
  const extMatches = new Map<string, CompanySummary>();
  for (const e of c.externalIds ?? []) {
    const m = await lookup.byIdentityKey(`ext:${e.namespace}:${e.id}`);
    if (m) extMatches.set(m.id, m);
  }
  if (extMatches.size > 1) {
    return {
      kind: 'review',
      reason: 'External identifiers point to different companies',
      severity: 'high',
      candidates: [...extMatches.values()].map((m) => ({
        id: m.id,
        label: m.displayName,
        score: 1,
        method: 'external_id',
      })),
      dedupeKey,
    };
  }
  // 2. Domain
  const domMatch = domain ? await lookup.byIdentityKey(`domain:${domain}`) : null;
  const extMatch = [...extMatches.values()][0] ?? null;
  if (extMatch && domMatch && extMatch.id !== domMatch.id) {
    return {
      kind: 'review',
      reason: `External id and domain ${domain} point to different companies`,
      severity: 'high',
      candidates: [
        { id: extMatch.id, label: extMatch.displayName, score: 1, method: 'external_id' },
        { id: domMatch.id, label: domMatch.displayName, score: 1, method: 'domain' },
      ],
      dedupeKey,
    };
  }
  if (extMatch) {
    if (c.directoryRow && !ownsName(c, extMatch)) {
      return {
        kind: 'review',
        reason: `External id matches ${extMatch.displayName}, whose own name differs from "${c.name}"`,
        severity: 'medium',
        candidates: [{ id: extMatch.id, label: extMatch.displayName, score: 0.8, method: 'external_id' }],
        dedupeKey,
      };
    }
    if (domain && extMatch.domain && extMatch.domain !== domain) {
      return {
        kind: 'review',
        reason: `External id matches ${extMatch.displayName} but its domain ${extMatch.domain} differs from ${domain}`,
        severity: 'medium',
        candidates: [{ id: extMatch.id, label: extMatch.displayName, score: 0.9, method: 'external_id' }],
        dedupeKey,
      };
    }
    return {
      kind: 'match',
      companyId: extMatch.id,
      method: 'external_id',
      confidence: 'high',
      reasons: ['external identifier'],
    };
  }
  if (domMatch) {
    // Safety net: a shared domain with an entirely unrelated name is more likely a data error
    // (shared hosting, parent-company site, wrong website) than the same company.
    // A directory row needs its own name key to equal the company's (a token overlap is not enough).
    if (c.directoryRow ? !ownsName(c, domMatch) : !namesPlausiblySame(c, domMatch)) {
      return {
        kind: 'review',
        reason: `Domain ${domain} belongs to ${domMatch.displayName}, whose name is unrelated to "${c.name}"`,
        severity: 'medium',
        candidates: [{ id: domMatch.id, label: domMatch.displayName, score: 0.6, method: 'domain' }],
        dedupeKey,
      };
    }
    return {
      kind: 'match',
      companyId: domMatch.id,
      method: 'domain',
      confidence: 'high',
      reasons: [`official domain ${domain}`],
    };
  }

  // 3. Exact legal name (and aliases)
  // Lookups use the name-norm/2 keys and the name-norm/1 keys of the same names (a company keyed
  // before name-norm/2 is still found). A hit COUNTS only when one of the candidate's own v2 keys
  // is one of the matched company's own v2 keys (computed from its names). Any other hit — a key
  // the company merely holds (a v1 key: "µTech Ltd" holds `name:tech ltd`) — is a legacy match:
  // a review candidate, never an auto-match.
  const names = [c.name, ...(c.legalName ? [c.legalName] : []), ...(c.aliases ?? [])];
  const v2Keys = new Set(names.map(strictNameKey).filter(Boolean));
  const byName = new Map<string, CompanySummary>();
  const legacyOnly = new Map<string, CompanySummary>();
  for (const k of new Set(names.flatMap(strictNameKeysForLookup)))
    for (const m of await lookup.byStrictName(k)) {
      if (byName.has(m.id)) continue;
      const own = ownNameKeys(m).strict;
      if ([...v2Keys].some((v) => own.has(v))) {
        byName.set(m.id, m);
        legacyOnly.delete(m.id);
      } else legacyOnly.set(m.id, m);
    }
  if (legacyOnly.size) {
    return {
      kind: 'review',
      reason: `"${c.name}" matches ${[...legacyOnly.values()].map((m) => m.displayName).join(', ')} only by a stored name key that is not that company's own (name-norm/1 legacy key)`,
      severity: 'low',
      candidates: [...byName.values(), ...legacyOnly.values()].map((m) => ({
        id: m.id,
        label: m.displayName,
        score: legacyOnly.has(m.id) ? 0.7 : 1,
        method: legacyOnly.has(m.id) ? 'name_legacy_key' : 'name_exact',
      })),
      dedupeKey,
    };
  }
  if (byName.size > 1) {
    return {
      kind: 'review',
      reason: `Several companies share the legal name "${c.name}"`,
      severity: 'medium',
      candidates: [...byName.values()].map((m) => ({
        id: m.id,
        label: m.displayName,
        score: 1,
        method: 'name_exact',
      })),
      dedupeKey,
    };
  }
  const nameMatch = [...byName.values()][0];
  if (nameMatch) {
    const conflicts: string[] = [];
    if (domain && nameMatch.domain && domain !== nameMatch.domain)
      conflicts.push(`domain ${domain} ≠ ${nameMatch.domain}`);
    if (c.country && nameMatch.hqCountry && norm(c.country) !== norm(nameMatch.hqCountry))
      conflicts.push(`country ${c.country} ≠ ${nameMatch.hqCountry}`);
    const legal = hasLegalForm(c.name);
    const townDiffers =
      !!c.town &&
      nameMatch.registeredTowns.length > 0 &&
      !nameMatch.registeredTowns.map(norm).includes(norm(c.town));
    // Registered legal names (Ltd, PLC, ...) are unique within a jurisdiction; bare names are not.
    if (townDiffers && !legal)
      conflicts.push(`town ${c.town} not among ${nameMatch.registeredTowns.join(', ')}`);
    if (conflicts.length) {
      return {
        kind: 'review',
        reason: `Same name as ${nameMatch.displayName} but ${conflicts.join('; ')}`,
        severity: 'medium',
        candidates: [{ id: nameMatch.id, label: nameMatch.displayName, score: 0.8, method: 'name_exact' }],
        dedupeKey,
      };
    }
    reasons.push('exact legal name');
    if (townDiffers) reasons.push(`different town (${c.town}) under a registered legal name`);
    return {
      kind: 'match',
      companyId: nameMatch.id,
      method: 'name_exact',
      confidence: legal ? 'high' : 'medium',
      reasons,
    };
  }

  // 4. Legal-form-insensitive name
  // As for exact names: a loose hit counts only when the candidate's v2 loose key is one of the
  // company's own loose keys; otherwise it is a legacy match (a review candidate, never a brand
  // match).
  const looseById = new Map<string, CompanySummary>();
  let legacyLoose = false;
  for (const k of looseNameKeysForLookup(c.name))
    for (const m of await lookup.byLooseKey(k)) {
      if (looseById.has(m.id)) continue;
      if (!ownNameKeys(m).loose.has(loose)) legacyLoose = true;
      looseById.set(m.id, m);
    }
  const looseMatches = [...looseById.values()];
  if (looseMatches.length === 1 && !legacyLoose && !hasLegalForm(c.name) && !domain) {
    const m = looseMatches[0] as CompanySummary;
    // A brand name ("Acme") against a single registered entity ("Acme Ltd").
    return {
      kind: 'match',
      companyId: m.id,
      method: 'brand_to_legal_name',
      confidence: 'medium',
      reasons: ['single legal entity with this base name'],
    };
  }
  if (looseMatches.length > 0) {
    return {
      kind: 'review',
      reason: looseMatches.some((m) => ownNameKeys(m).strict.has(strictNameKey(c.name)))
        ? `Same name as ${looseMatches.map((m) => m.displayName).join(', ')} (found by its base name; another step or a concurrent import is involved)`
        : `Probable match: same base name "${loose}" with a different legal form`,
      severity: 'low',
      candidates: looseMatches
        .slice(0, 10)
        .map((m) => ({ id: m.id, label: m.displayName, score: 0.85, method: 'name_loose' })),
      dedupeKey,
    };
  }

  // 5. Fuzzy fallback — review only, never auto-merge.
  const token = firstSignificantToken(c.name);
  if (token.length >= 3) {
    const pool = await lookup.byFirstToken(token, 50);
    const scored = pool
      .map((m) => ({ m, score: jaroWinkler(loose, m.looseKey) }))
      .filter((x) => x.score >= FUZZY_REVIEW_THRESHOLD)
      .sort((a, b) => b.score - a.score);
    if (scored.length) {
      return {
        kind: 'review',
        reason: `Similar name to existing compan${scored.length > 1 ? 'ies' : 'y'}`,
        severity: 'low',
        candidates: scored.slice(0, 5).map((x) => ({
          id: x.m.id,
          label: x.m.displayName,
          score: Math.round(x.score * 1000) / 1000,
          method: 'fuzzy',
        })),
        dedupeKey,
      };
    }
  }
  return { kind: 'create', reasons: ['no existing company matched'] };
}
