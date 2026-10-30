import { canonicalJson } from '@aptamind/contracts';
import type { ClaimType } from '../contracts/claims';

/**
 * Compatibility rules (domain doc §3.3, R-15). Pure: no I/O.
 *
 * Two values of one item are **compatible** when both can be true together; compatible values
 * merge to the most precise one, incompatible values are conflicts. Comparison is **per
 * attribute**: a composite value (a role, a degree) is a record of attributes, and a title
 * disagreement makes only the title conflicting, never the dates.
 *
 * Every relaxation of strict equality is a **named rule** so that the policy can be mutation-
 * tested: dropping any rule from the active set makes at least one named golden case fail
 * (`reconciliation/mutation.test.ts`).
 */
export const COMPATIBILITY_RULES = [
  /** Text is compared case-, accent-, punctuation- and whitespace-insensitively. */
  'text_normalization',
  /** An optional attribute absent on one side is compatible (the present side is more precise). */
  'optional_absent',
  /** Dates are equal at the coarser precision: `2019` ~ `2019-03`. */
  'date_precision',
  /** `present (asOf)` ~ a dated end on or after the `asOf` month (old CV "present", new CV ended later). */
  'present_vs_end',
  /** Titles compare by normalized title key: abbreviations and seniority spellings (`Sr.` ~ `Senior`). */
  'title_normalization',
  /** Organization keys compare after legal-form stripping (`Acme Ltd` ~ `ACME Limited`). */
  'organization_legal_form',
  /** Organization keys recorded as aliases of each other (by resolution) are equal. */
  'organization_alias',
  /** Places: same country and (same city or one city absent). */
  'place_partial',
  /** A tri-state `unknown` (and education status `unknown`) is absence, not a value. */
  'tri_state_unknown',
  /** Education `in_progress` ~ `completed` (the older source was written before completion). */
  'education_progress',
  /** Open lists of a historical record (technologies, metrics) are compatible when one contains the other. */
  'list_subset',
] as const;
export type CompatibilityRule = (typeof COMPATIBILITY_RULES)[number];

export const ALL_COMPATIBILITY_RULES: ReadonlySet<CompatibilityRule> = new Set(COMPATIBILITY_RULES);

export interface CompatibilityContext {
  rules: ReadonlySet<CompatibilityRule>;
  /** Organization key groups recorded as aliases of one organization (resolution output). */
  organizationAliases?: readonly (readonly string[])[];
}

/** How one attribute is compared. */
export type AttributeKind =
  | 'text'
  | 'exact'
  | 'set'
  | 'subset'
  | 'date'
  | 'end'
  | 'title'
  | 'organization'
  | 'labelled'
  | 'place'
  | 'tri'
  | 'progress'
  | 'context';

export interface AttributeSpec {
  name: string;
  kind: AttributeKind;
  /** Several top-level fields compared as one attribute (e.g. title + titleKey + seniority). */
  fields?: readonly string[];
  /** A (nested) path; defaults to `[name]`. */
  path?: readonly string[];
  /** Whether a conflict on this attribute is material (§7.2); defaults to true. */
  material?: boolean;
}

const a = (
  name: string,
  kind: AttributeKind,
  extra: Omit<AttributeSpec, 'name' | 'kind'> = {},
): AttributeSpec => Object.freeze({ name, kind, ...extra });
const immaterial = { material: false } as const;

/** Attribute specs per claim type (pinned to domain doc §3.2/§3.3 by `compatibility.test.ts`). */
export const ATTRIBUTE_SPECS: Readonly<Record<ClaimType, readonly AttributeSpec[]>> = Object.freeze({
  'identity.name': [a('display', 'text'), a('preferred', 'text', immaterial)],
  'identity.link': [a('kind', 'exact'), a('url', 'exact')],
  'positioning.headline': [a('text', 'text')],
  'experience.role': [
    a('organization', 'organization'),
    a('title', 'title', { fields: ['title', 'titleKey', 'roleFamily', 'seniority'] }),
    a('employmentType', 'exact', immaterial),
    a('start', 'date'),
    a('end', 'end'),
    a('location', 'place', immaterial),
  ],
  skill: [
    a('skill', 'labelled', { fields: ['label', 'concept'] }),
    a('kind', 'exact'),
    a('category', 'exact', immaterial),
    a('proficiency', 'exact'),
    a('context', 'context', immaterial),
  ],
  education: [
    a('institution', 'organization'),
    a('qualification', 'text'),
    a('field', 'text', immaterial),
    a('level', 'exact'),
    a('start', 'date'),
    a('end', 'date'),
    a('status', 'progress'),
  ],
  certification: [
    a('name', 'text'),
    a('issuer', 'organization'),
    a('issued', 'date'),
    a('expires', 'date'),
    a('url', 'exact', immaterial),
  ],
  language: [a('language', 'labelled', { fields: ['label', 'language'] }), a('proficiency', 'exact')],
  'location.current': [a('place', 'place', { fields: ['city', 'region', 'country'] })],
  work_authorization: [
    a('jurisdiction', 'exact'),
    a('status', 'exact'),
    a('visaType', 'text'),
    // §3.3: a differing validUntil is a conflict (no precision relaxation); absent is still absence.
    a('validUntil', 'exact'),
    a('sponsorshipRequired', 'tri'),
  ],
  'mobility.relocation': [a('willing', 'exact'), a('destinations', 'set')],
  'preference.remote': [a('acceptable', 'set'), a('preferred', 'exact'), a('timezoneWindow', 'exact')],
  project: [
    a('name', 'text'),
    a('role', 'text'),
    a('start', 'date', { path: ['period', 'start'] }),
    a('end', 'end', { path: ['period', 'end'] }),
    a('url', 'exact'),
    a('technologies', 'subset'),
    a('summaryRef', 'context', immaterial),
  ],
  achievement: [a('text', 'text'), a('metrics', 'subset')],
  'portfolio.evidence': [
    a('kind', 'exact'),
    a('title', 'text'),
    a('url', 'exact'),
    a('relatesTo', 'subset', immaterial),
  ],
  industry: [a('industry', 'labelled', { fields: ['label', 'code'] })],
  'preference.compensation': [
    a('currency', 'exact'),
    a('period', 'exact'),
    a('basis', 'exact'),
    a('min', 'exact'),
    a('target', 'exact'),
  ],
  'preference.career': [a('statementRef', 'exact')],
});

/**
 * Result of comparing one attribute: `equal`; `a` / `b` — compatible and that side is more
 * precise; `union` — compatible, each side adds something (merge takes both); `conflict`.
 */
export type AttributeComparison = 'equal' | 'a' | 'b' | 'union' | 'conflict';

// ---------------------------------------------------------------------------------------------
// Normalization helpers (pure, deterministic).

/** Case-, accent-, punctuation- and whitespace-insensitive text key. */
export function normalizeText(s: string): string {
  return (
    s
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      // `C++` ≠ `C#` ≠ `C`: symbols that carry meaning in names become words before stripping.
      .replace(/\+/g, ' plus ')
      .replace(/#/g, ' sharp ')
      // Dots and apostrophes join (`B.Sc.` → `bsc`, `O'Neil` → `oneil`); other punctuation separates.
      .replace(/[.'’]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
  );
}

/** Abbreviations and seniority-word spellings in job titles (`Sr.` ~ `Senior`). */
const TITLE_ABBREVIATIONS: Readonly<Record<string, string>> = Object.freeze({
  sr: 'senior',
  snr: 'senior',
  jr: 'junior',
  jnr: 'junior',
  eng: 'engineer',
  engr: 'engineer',
  dev: 'developer',
  mgr: 'manager',
  mngr: 'manager',
  dir: 'director',
  assoc: 'associate',
  asst: 'assistant',
  vp: 'vice president',
  svp: 'senior vice president',
  evp: 'executive vice president',
  swe: 'software engineer',
  sw: 'software',
  ops: 'operations',
  admin: 'administrator',
  mktg: 'marketing',
  tech: 'technical',
  intl: 'international',
  '&': 'and',
});

/** Normalized title key: tokens with abbreviations expanded. `Sr.-Software-Eng` → `senior software engineer`. */
export function normalizeTitleKey(key: string): string {
  return normalizeText(key)
    .split(' ')
    .filter(Boolean)
    .map((t) => TITLE_ABBREVIATIONS[t] ?? t)
    .join(' ');
}

/** Legal-form tokens stripped from the end of organization keys. */
const LEGAL_FORMS: ReadonlySet<string> = new Set([
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'ltd',
  'limited',
  'llc',
  'llp',
  'lp',
  'plc',
  'gmbh',
  'mbh',
  'ag',
  'kg',
  'se',
  'sa',
  'sas',
  'sarl',
  'srl',
  'spa',
  'bv',
  'nv',
  'oy',
  'oyj',
  'ab',
  'as',
  'asa',
  'aps',
  'kk',
  'pty',
  'pte',
  'pvt',
  'private',
  'and',
]);

/** Organization comparison key: normalized tokens, leading `the` and trailing legal forms removed. */
export function organizationKey(s: string, stripLegalForms: boolean): string {
  const tokens = normalizeText(s).split(' ').filter(Boolean);
  if (!stripLegalForms) return tokens.join(' ');
  if (tokens.length > 1 && tokens[0] === 'the') tokens.shift();
  while (tokens.length > 1 && LEGAL_FORMS.has(tokens[tokens.length - 1] as string)) tokens.pop();
  return tokens.join(' ');
}

// ---------------------------------------------------------------------------------------------
// Attribute access.

type Rec = Record<string, unknown>;

function isAbsent(v: unknown): boolean {
  return v === undefined || v === null;
}

/** The attribute's value in a record, or `undefined` when absent. */
export function getAttribute(value: unknown, spec: AttributeSpec): unknown {
  const rec = value as Rec;
  if (spec.fields) {
    const out: Rec = {};
    let any = false;
    for (const f of spec.fields) {
      if (!isAbsent(rec?.[f])) {
        out[f] = rec[f];
        any = true;
      }
    }
    return any ? out : undefined;
  }
  let cur: unknown = rec;
  for (const p of spec.path ?? [spec.name]) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Rec)[p];
  }
  return isAbsent(cur) ? undefined : cur;
}

/** Writes an attribute into a (cloned) record; `undefined` removes it. */
function setAttribute(target: Rec, spec: AttributeSpec, v: unknown): void {
  if (spec.fields) {
    for (const f of spec.fields) {
      const fv = v === undefined ? undefined : (v as Rec)[f];
      if (fv === undefined) delete target[f];
      else target[f] = fv;
    }
    return;
  }
  const path = spec.path ?? [spec.name];
  let cur = target;
  for (const p of path.slice(0, -1)) {
    const next = cur[p];
    if (next === null || typeof next !== 'object') {
      if (v === undefined) return;
      cur[p] = {};
    } else cur[p] = { ...(next as Rec) };
    cur = cur[p] as Rec;
  }
  const last = path[path.length - 1] as string;
  if (v === undefined) delete cur[last];
  else cur[last] = v;
}

// ---------------------------------------------------------------------------------------------
// Attribute comparison.

const same = (x: unknown, y: unknown) => canonicalJson(x) === canonicalJson(y);

function text(x: unknown, ctx: CompatibilityContext): string {
  const s = String(x);
  return ctx.rules.has('text_normalization') ? normalizeText(s) : s;
}

function cmpDate(x: unknown, y: unknown, ctx: CompatibilityContext): AttributeComparison {
  const dx = x as { year: number; month?: number };
  const dy = y as { year: number; month?: number };
  if (dx.year !== dy.year) return 'conflict';
  if (dx.month === dy.month) return 'equal';
  if (!ctx.rules.has('date_precision')) return 'conflict';
  if (dx.month === undefined) return 'b';
  if (dy.month === undefined) return 'a';
  return 'conflict';
}

function isOpen(x: unknown): x is { open: true; asOf: Date } {
  return typeof x === 'object' && x !== null && (x as Rec).open === true;
}

function asOfMonth(d: Date): { year: number; month: number } {
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

/** Whether a dated end is on or after the `present` observation's `asOf` month. */
function endCoversPresent(end: { year: number; month?: number }, asOf: Date): boolean {
  const m = asOfMonth(asOf);
  if (end.month === undefined) return end.year >= m.year;
  return end.year > m.year || (end.year === m.year && end.month >= m.month);
}

function cmpEnd(x: unknown, y: unknown, ctx: CompatibilityContext): AttributeComparison {
  const ox = isOpen(x);
  const oy = isOpen(y);
  if (!ox && !oy) return cmpDate(x, y, ctx);
  if (ox && oy) {
    const tx = new Date(x.asOf).getTime();
    const ty = new Date((y as { asOf: Date }).asOf).getTime();
    return tx === ty ? 'equal' : tx > ty ? 'a' : 'b';
  }
  if (!ctx.rules.has('present_vs_end')) return 'conflict';
  // One side still open when its source was written; the dated side says when it ended.
  if (ox) return endCoversPresent(y as { year: number; month?: number }, new Date(x.asOf)) ? 'b' : 'conflict';
  return endCoversPresent(x as { year: number; month?: number }, new Date((y as { asOf: Date }).asOf))
    ? 'a'
    : 'conflict';
}

function presentCount(v: Rec, fields: readonly string[]): number {
  return fields.filter((f) => !isAbsent(v[f])).length;
}

function cmpTitle(x: unknown, y: unknown, ctx: CompatibilityContext): AttributeComparison {
  const tx = x as Rec;
  const ty = y as Rec;
  const kx = String(tx.titleKey ?? tx.title ?? '');
  const ky = String(ty.titleKey ?? ty.title ?? '');
  const equalKeys = ctx.rules.has('title_normalization')
    ? normalizeTitleKey(kx) === normalizeTitleKey(ky)
    : kx === ky;
  if (!equalKeys) return 'conflict';
  // An explicit classification that differs is a disagreement even when the keys are equal.
  for (const f of ['seniority', 'roleFamily'])
    if (!isAbsent(tx[f]) && !isAbsent(ty[f]) && tx[f] !== ty[f]) return 'conflict';
  // Same title; the side carrying more classification (role family, seniority) is more precise.
  const px = presentCount(tx, ['roleFamily', 'seniority']);
  const py = presentCount(ty, ['roleFamily', 'seniority']);
  return px === py ? 'equal' : px > py ? 'a' : 'b';
}

function orgKeyOf(v: unknown): string {
  if (typeof v === 'string') return v;
  const r = v as Rec;
  return String(r.key ?? r.name ?? '');
}

function cmpOrganization(x: unknown, y: unknown, ctx: CompatibilityContext): AttributeComparison {
  const strip = ctx.rules.has('organization_legal_form');
  const kx = organizationKey(orgKeyOf(x), strip);
  const ky = organizationKey(orgKeyOf(y), strip);
  let equal = kx === ky;
  if (!equal && ctx.rules.has('organization_alias')) {
    for (const group of ctx.organizationAliases ?? []) {
      const keys = group.map((g) => organizationKey(g, strip));
      if (keys.includes(kx) && keys.includes(ky)) equal = true;
    }
  }
  if (!equal) return 'conflict';
  if (typeof x === 'object' && typeof y === 'object') {
    const ux = !isAbsent((x as Rec).url);
    const uy = !isAbsent((y as Rec).url);
    if (ux !== uy) return ux ? 'a' : 'b';
  }
  return 'equal';
}

function cmpLabelled(
  x: unknown,
  y: unknown,
  ctx: CompatibilityContext,
  codeField: string,
): AttributeComparison {
  const lx = x as Rec;
  const ly = y as Rec;
  const cx = lx[codeField];
  const cy = ly[codeField];
  if (!isAbsent(cx) && !isAbsent(cy)) return cx === cy ? 'equal' : 'conflict';
  if (text(lx.label ?? '', ctx) !== text(ly.label ?? '', ctx)) return 'conflict';
  if (isAbsent(cx) === isAbsent(cy)) return 'equal';
  return isAbsent(cx) ? 'b' : 'a';
}

function cmpPlace(x: unknown, y: unknown, ctx: CompatibilityContext): AttributeComparison {
  const px = x as Rec;
  const py = y as Rec;
  if (!ctx.rules.has('place_partial'))
    return same(normPlace(px, ctx), normPlace(py, ctx)) ? 'equal' : 'conflict';
  let aMore = false;
  let bMore = false;
  for (const f of ['country', 'region', 'city']) {
    const vx = px[f];
    const vy = py[f];
    if (isAbsent(vx) && isAbsent(vy)) continue;
    if (isAbsent(vx)) bMore = true;
    else if (isAbsent(vy)) aMore = true;
    else if (text(vx, ctx) !== text(vy, ctx)) return 'conflict';
  }
  return aMore && bMore ? 'union' : aMore ? 'a' : bMore ? 'b' : 'equal';
}

function normPlace(p: Rec, ctx: CompatibilityContext): Rec {
  const out: Rec = {};
  for (const f of ['country', 'region', 'city']) if (!isAbsent(p[f])) out[f] = text(p[f], ctx);
  return out;
}

function elementKeys(list: unknown, ctx: CompatibilityContext): string[] {
  return [
    ...new Set((list as unknown[]).map((e) => (typeof e === 'string' ? text(e, ctx) : canonicalJson(e)))),
  ];
}

function cmpSet(x: unknown, y: unknown, ctx: CompatibilityContext, subset: boolean): AttributeComparison {
  const sx = elementKeys(x, ctx);
  const sy = elementKeys(y, ctx);
  const xInY = sx.every((e) => sy.includes(e));
  const yInX = sy.every((e) => sx.includes(e));
  if (xInY && yInX) return 'equal';
  if (!subset || !ctx.rules.has('list_subset')) return 'conflict';
  if (xInY) return 'b';
  if (yInX) return 'a';
  return 'conflict';
}

/**
 * Source chronology of the two compared values (newest supporting `sourceAsOf`, epoch ms), for
 * the rules that depend on which side was written later (education progress).
 */
export interface ComparisonChronology {
  a: number;
  b: number;
}

/** Compares two present attribute values. */
function comparePresent(
  spec: AttributeSpec,
  x: unknown,
  y: unknown,
  ctx: CompatibilityContext,
  chron?: ComparisonChronology,
): AttributeComparison {
  switch (spec.kind) {
    case 'text':
      return text(x, ctx) === text(y, ctx) ? 'equal' : 'conflict';
    case 'exact':
      return same(x, y) ? 'equal' : 'conflict';
    case 'set':
      return cmpSet(x, y, ctx, false);
    case 'subset':
      return cmpSet(x, y, ctx, true);
    case 'date':
      return cmpDate(x, y, ctx);
    case 'end':
      return cmpEnd(x, y, ctx);
    case 'title':
      return cmpTitle(x, y, ctx);
    case 'organization':
      return cmpOrganization(x, y, ctx);
    case 'labelled':
      return cmpLabelled(x, y, ctx, (spec.fields ?? [])[1] ?? 'code');
    case 'place':
      return cmpPlace(x, y, ctx);
    case 'tri':
      return same(x, y) ? 'equal' : 'conflict';
    case 'progress':
      if (x === y) return 'equal';
      if (ctx.rules.has('education_progress')) {
        // In progress, then later completed: compatible. Completed, then later in progress: not.
        if (x === 'completed' && y === 'in_progress') return !chron || chron.b <= chron.a ? 'a' : 'conflict';
        if (x === 'in_progress' && y === 'completed') return !chron || chron.a <= chron.b ? 'b' : 'conflict';
      }
      return 'conflict';
    case 'context':
      // Where a value was seen (listed / used in a role / repository) is never a disagreement.
      return 'equal';
  }
}

/** `unknown` of a tri-state or education status counts as absent under `tri_state_unknown`. */
function effective(spec: AttributeSpec, v: unknown, ctx: CompatibilityContext): unknown {
  if (
    (spec.kind === 'tri' || spec.kind === 'progress') &&
    v === 'unknown' &&
    ctx.rules.has('tri_state_unknown')
  )
    return undefined;
  return v;
}

export function compareAttribute(
  spec: AttributeSpec,
  x: unknown,
  y: unknown,
  ctx: CompatibilityContext,
  chron?: ComparisonChronology,
): AttributeComparison {
  const ex = effective(spec, x, ctx);
  const ey = effective(spec, y, ctx);
  if (ex === undefined && ey === undefined) return 'equal';
  if (ex === undefined || ey === undefined) {
    if (spec.kind === 'context') return 'equal';
    if (!ctx.rules.has('optional_absent')) return 'conflict';
    return ex === undefined ? 'b' : 'a';
  }
  return comparePresent(spec, ex, ey, ctx, chron);
}

export interface ValueComparison {
  compatible: boolean;
  /** Attributes that conflict (names from `ATTRIBUTE_SPECS`), sorted. */
  conflicting: string[];
  /** `a` adds precision somewhere (compatible values only). */
  aMorePrecise: boolean;
  /** `b` adds precision somewhere (compatible values only). */
  bMorePrecise: boolean;
}

/** Compares two normalized values of one claim type, attribute by attribute. */
export function compareValues(
  claimType: ClaimType,
  x: unknown,
  y: unknown,
  ctx: CompatibilityContext,
  chron?: ComparisonChronology,
): ValueComparison {
  const conflicting: string[] = [];
  let aMore = false;
  let bMore = false;
  for (const spec of ATTRIBUTE_SPECS[claimType]) {
    const r = compareAttribute(spec, getAttribute(x, spec), getAttribute(y, spec), ctx, chron);
    if (r === 'conflict') conflicting.push(spec.name);
    if (r === 'a' || r === 'union') aMore = true;
    if (r === 'b' || r === 'union') bMore = true;
  }
  conflicting.sort();
  const compatible = conflicting.length === 0;
  return { compatible, conflicting, aMorePrecise: compatible && aMore, bMorePrecise: compatible && bMore };
}

function unionPlace(x: Rec, y: Rec): Rec {
  const out: Rec = { ...y, ...x };
  for (const k of Object.keys(out)) if (isAbsent(out[k])) delete out[k];
  return out;
}

/**
 * Merges compatible values into the most precise one: starts from `values[0]` (the
 * representative) and, attribute by attribute, takes the more precise side. Attributes that
 * conflict are left as the representative has them (callers only merge compatible values).
 */
export function mergeValues(
  claimType: ClaimType,
  values: readonly unknown[],
  ctx: CompatibilityContext,
): unknown {
  const [first, ...rest] = values;
  const out = structuredClone(first) as Rec;
  for (const spec of ATTRIBUTE_SPECS[claimType]) {
    let cur = getAttribute(out, spec);
    for (const v of rest) {
      const other = getAttribute(v, spec);
      const r = compareAttribute(spec, cur, other, ctx);
      if (r === 'b') cur = other;
      else if (r === 'union') cur = unionPlace(cur as Rec, other as Rec);
    }
    setAttribute(out, spec, cur === undefined ? undefined : structuredClone(cur));
  }
  return out;
}

/** Names of the material attributes among `names` for a claim type (§7.2). */
export function materialAttributes(claimType: ClaimType, names: readonly string[]): string[] {
  const specs = ATTRIBUTE_SPECS[claimType];
  return names.filter((n) => specs.find((s) => s.name === n)?.material !== false);
}
