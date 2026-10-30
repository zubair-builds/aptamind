import { z } from 'zod';
import type { AnyCapability } from '@aptamind/workflow-sdk';
import { PROFESSIONAL_ID_PREFIX } from '../contracts/ids';

/**
 * R-34 mechanical guard. Professional capability inputs, outputs and configs are persisted and
 * shown by generic run views (`/api/runs`, `/api/node-runs/:id`, output previews), which do not
 * know about subjects, so they may carry opaque ids, enums, bounded codes, hashes, numbers,
 * booleans and dates only — never free text or personal values. This walks a Zod schema and
 * reports every place that admits anything else, plus every field whose name suggests personal
 * data whatever its type. A test runs it over every `professional.*` capability
 * (`capability-io.test.ts`).
 */

const CODE_PATTERN = '^[a-z][a-z0-9_.:-]*$';
/** Codes must be length-bounded; enums and literals are preferred. */
export const MAX_IO_CODE_LENGTH = 64;

/**
 * The code schema capability IO uses (bounded ≤ 64; the document `codeSchema` allows 80 and is
 * therefore not accepted in IO). Enums and literals are preferred where the values are known.
 */
export const ioCodeSchema = z.string().min(1).max(MAX_IO_CODE_LENGTH).regex(new RegExp(CODE_PATTERN));

/** The only string patterns allowed: Professional ids, (bounded) codes and SHA-256 digests. */
export const ALLOWED_IO_STRING_PATTERNS: readonly string[] = [
  ...Object.values(PROFESSIONAL_ID_PREFIX).map((p) => `^${p}_[A-Za-z0-9]+$`),
  CODE_PATTERN,
  '^[0-9a-f]{64}$',
];

/**
 * Field-name tokens that suggest personal data, whatever the field's type. Keys are split into
 * camelCase / snake_case / kebab-case / digit tokens and each token is compared exactly
 * (case-insensitive): `githubHandle` → `github`, `handle` (denied); `renamed` has no `name`
 * token (allowed). `location` stays denied.
 */
export const PERSONAL_FIELD_NAME_TOKENS: readonly string[] = [
  'name',
  'names',
  'username',
  'email',
  'mail',
  'phone',
  'mobile',
  'telephone',
  'birth',
  'birthday',
  'dob',
  'address',
  'street',
  'postcode',
  'postal',
  'zip',
  'zipcode',
  'ssn',
  'passport',
  'nationality',
  'handle',
  'url',
  'uri',
  'gender',
  'religion',
  'ethnic',
  'ethnicity',
  'salary',
  'compensation',
  'location',
  'linkedin',
  // Short words matched only as whole tokens (as substrings they would hit hotel, cancelled,
  // capacity, page …).
  'tel',
  'cell',
  'city',
  'age',
];

/**
 * Strong stems matched as substrings of the whole key (lower-cased, separators removed), so
 * compounds the tokenizer cannot split (`firstname`, `emailaddress`, `gmailId`, `linkedInId`,
 * `profileURLs`, `cityOfResidence`) are caught too.
 */
export const PERSONAL_FIELD_NAME_STEMS: readonly string[] = [
  'email',
  'mail',
  'phone',
  'birth',
  'surname',
  'firstname',
  'fullname',
  'lastname',
  'linkedin',
  'url',
  'address',
  'postcode',
  'passport',
  'residence',
  'postal',
  'nationality',
  'salary',
  'gender',
  'religio',
  'ethnic',
  'compensation',
  'username',
  'nickname',
  'forename',
  'displayname',
  // `handle` is a whole token only (TOKENS): as a stem it hit handler, unhandled, errorHandled.
  'website',
  'twitter',
  'github',
  'citizenship',
  'country',
];

/**
 * Reviewed exceptions to the field-name denylist (the field's schema is still walked, so a
 * string there must still be an id, code or hash). Each carries its rationale.
 */
export const IO_FIELD_NAME_ALLOWLIST: ReadonlyArray<{
  matches: (path: string, key: string) => boolean;
  rationale: string;
}> = [
  {
    matches: (path, key) => path.endsWith('.extractor.name') || key === 'extractorName',
    rationale: 'names the extractor (a code such as structured_form), never a person',
  },
  {
    matches: (_path, key) => /Count$/.test(key),
    rationale: 'a counter (e.g. urlCount) holds a number of things, not the things',
  },
];

/**
 * Reviewed token exemptions: a suffix explains exactly one denied token and exempts only that
 * one — every other denied token or stem in the key is still refused (`dobMs`,
 * `birthDateSeconds`, `emailRunId` are refused; `ageMs`, `githubRunId` pass).
 */
export const IO_FIELD_NAME_TOKEN_EXEMPTIONS: ReadonlyArray<{
  applies: (key: string) => boolean;
  exempt: readonly string[];
  rationale: string;
}> = [
  {
    applies: (key) => /[a-z](Ms|Seconds)$/.test(key),
    exempt: ['age'],
    rationale: "a duration's age (ageMs) is a machine measure, not a person's age",
  },
  {
    applies: (key) => /[a-z]RunId$/.test(key),
    exempt: ['github'],
    rationale: 'a GitHub workflow run id (githubRunId) is an opaque run reference, not an account',
  },
];

/** A token and its singular forms: `cities` → `city`; `zips` → `zip`; `dobs` → `dob`. */
function tokenForms(t: string): string[] {
  const out = [t];
  if (t.length > 3 && t.endsWith('ies')) out.push(`${t.slice(0, -3)}y`);
  if (t.length > 3 && t.endsWith('s')) out.push(t.slice(0, -1));
  return out;
}

/** The denylist entry a key matches (token, singular of a plural token, or strong stem), if any. */
export function personalFieldName(key: string): string | undefined {
  const exempt = new Set(
    IO_FIELD_NAME_TOKEN_EXEMPTIONS.filter((e) => e.applies(key)).flatMap((e) => e.exempt),
  );
  const forms = fieldNameTokens(key).flatMap(tokenForms);
  const token = forms.find((t) => PERSONAL_FIELD_NAME_TOKENS.includes(t) && !exempt.has(t));
  if (token) return token;
  const joined = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return PERSONAL_FIELD_NAME_STEMS.find((stem) => joined.includes(stem) && !exempt.has(stem));
}

/**
 * A key's tokens: `profileURL` → `profile`, `url`; `date_of_birth` → `date`, `of`, `birth`;
 * an acronym plural stays one token (`profileURLs` → `profile`, `urls`).
 */
export function fieldNameTokens(key: string): string[] {
  return key
    .replace(/([A-Z]{2,})s(?=[A-Z0-9_-]|$)/g, (_m, a: string) => `${a[0]}${a.slice(1).toLowerCase()}s`)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

export interface IoViolation {
  path: string;
  reason: string;
}

type Check = { _zod: { def: { check?: string; format?: string; pattern?: RegExp; maximum?: number } } };
interface ZodInternals {
  _zod: {
    def: {
      type: string;
      checks?: Check[];
      shape?: Record<string, z.ZodType>;
      catchall?: z.ZodType;
      element?: z.ZodType;
      innerType?: z.ZodType;
      options?: z.ZodType[];
      keyType?: z.ZodType;
      valueType?: z.ZodType;
      items?: z.ZodType[];
      rest?: z.ZodType | null;
      in?: z.ZodType;
      out?: z.ZodType;
      left?: z.ZodType;
      right?: z.ZodType;
      getter?: () => z.ZodType;
      catchValue?: (ctx: unknown) => unknown;
    };
  };
}

const PASS_THROUGH = new Set(['optional', 'nullable', 'default', 'prefault', 'readonly', 'nonoptional']);
const SCALARS = new Set([
  'number',
  'int',
  'boolean',
  'date',
  'null',
  'undefined',
  'enum',
  'literal',
  'nan',
  'bigint',
  'void',
  'never',
]);

const CATCH_SENTINEL = 'r34-catch-sentinel';
const defOf = (s: z.ZodType) => (s as unknown as ZodInternals)._zod.def;

function stringViolation(checks: Check[] | undefined): string | undefined {
  const defs = (checks ?? []).map((c) => c._zod.def);
  const regexes = defs.filter((c) => c.check === 'string_format' && c.format === 'regex' && c.pattern);
  if (regexes.some((c) => c.pattern!.flags !== '')) return 'regex with flags';
  const allowed = regexes.map((c) => c.pattern!.source).filter((p) => ALLOWED_IO_STRING_PATTERNS.includes(p));
  if (!allowed.length) return 'free-text string (not an id, code or hash)';
  if (allowed.every((p) => p === CODE_PATTERN)) {
    const max = Math.min(
      ...defs.filter((c) => c.check === 'max_length').map((c) => c.maximum ?? Infinity),
      Infinity,
    );
    if (max > MAX_IO_CODE_LENGTH) return `code without a length bound ≤ ${MAX_IO_CODE_LENGTH}`;
  }
  return undefined;
}

/** Every place in `schema` that admits free text, unchecked values or personal-looking fields. */
export function ioViolations(schema: z.ZodType, path = '$', seen = new Set<unknown>()): IoViolation[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const def = defOf(schema);
  const walk = (s: z.ZodType | undefined | null, p: string) => (s ? ioViolations(s, p, seen) : []);
  const bad = (reason: string): IoViolation[] => [{ path, reason }];
  if (PASS_THROUGH.has(def.type)) return walk(def.innerType, path);
  if (SCALARS.has(def.type)) return [];
  switch (def.type) {
    case 'string': {
      const reason = stringViolation(def.checks);
      return reason ? bad(reason) : [];
    }
    case 'object': {
      const out: IoViolation[] = [];
      for (const [k, v] of Object.entries(def.shape ?? {})) {
        const at = `${path}.${k}`;
        const token = personalFieldName(k);
        if (token && !IO_FIELD_NAME_ALLOWLIST.some((a) => a.matches(at, k)))
          out.push({ path: at, reason: `personal-looking field name (${token})` });
        out.push(...walk(v, `${path}.${k}`));
      }
      // Loose / passthrough / catchall objects admit arbitrary extra keys and values.
      if (def.catchall && defOf(def.catchall).type !== 'never')
        out.push({ path, reason: 'object admits unknown keys (catchall/loose/passthrough)' });
      return out;
    }
    case 'array':
      return walk(def.element, `${path}[]`);
    case 'tuple':
      return [
        ...(def.items ?? []).flatMap((s, i) => walk(s, `${path}[${i}]`)),
        ...(def.rest ? bad('tuple with a rest element') : []),
      ];
    case 'union':
      return (def.options ?? []).flatMap((s, i) => walk(s, `${path}|${i}`));
    case 'intersection':
      return [...walk(def.left, path), ...walk(def.right, path)];
    case 'record':
      return [...walk(def.keyType, `${path}{key}`), ...walk(def.valueType, `${path}{}`)];
    case 'pipe':
      return [...walk(def.in, path), ...walk(def.out, `${path}>`)];
    case 'lazy':
      return walk(def.getter?.(), path);
    case 'catch': {
      let fallback: unknown;
      try {
        // A string sentinel as the failed input: `.catch((c) => c.input)` echoes it back.
        fallback = def.catchValue?.({
          value: CATCH_SENTINEL,
          input: CATCH_SENTINEL,
          issues: [],
          error: { issues: [] },
        });
      } catch {
        fallback = undefined;
      }
      return [
        ...(typeof fallback === 'string' || (typeof fallback === 'object' && fallback !== null)
          ? bad('.catch with a string or object fallback')
          : []),
        ...walk(def.innerType, path),
      ];
    }
    default:
      // any, unknown, custom, transform, …: not inspectable, so not provably safe.
      return bad(`admits unchecked values (${def.type})`);
  }
}

/** Violations of every input, output and config schema of the given capabilities. */
export function capabilityIoViolations(capabilities: readonly AnyCapability[]): IoViolation[] {
  return capabilities.flatMap((c) => {
    const id = `${c.type}@${c.version}`;
    return [
      ...ioViolations(c.inputSchema, `${id}:input`),
      ...ioViolations(c.outputSchema, `${id}:output`),
      ...ioViolations(c.configSchema, `${id}:config`),
    ];
  });
}
