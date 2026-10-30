import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { idSchema } from '../contracts/ids';
import { professionalCapabilities } from '../workflow-nodes';
import { codeSchema } from '../documents';
import {
  capabilityIoViolations,
  fieldNameTokens,
  ioCodeSchema,
  ioViolations,
  personalFieldName,
} from './capability-io';

const code = ioCodeSchema;
const paths = (schema: z.ZodType) => ioViolations(schema).map((v) => v.path);

describe('R-34 guard: Professional capability IO carries ids, codes and counts only', () => {
  it('every professional.* capability input, output and config schema passes', () => {
    for (const c of professionalCapabilities) expect(c.type).toMatch(/^professional\./);
    expect(capabilityIoViolations(professionalCapabilities)).toEqual([]);
  });

  it('P1.3 tripwire: the first capability must ship with the canary run (node IO, previews, logs)', () => {
    // Fails loudly once professionalCapabilities is non-empty without the canary-run suite.
    const canaryRun = new URL('../capability-canary.int.test.ts', import.meta.url);
    if (professionalCapabilities.length > 0) expect(existsSync(canaryRun)).toBe(true);
    else expect(professionalCapabilities).toHaveLength(0);
  });

  it('accepts ids, bounded codes, hashes, enums, literals, numbers, booleans and dates', () => {
    const safe = z.strictObject({
      subjectId: idSchema('subject'),
      snapshotIds: z.array(idSchema('snapshot')).max(10),
      reason: code.optional(),
      contentHash: z.string().regex(/^[0-9a-f]{64}$/),
      status: z.enum(['ok', 'skipped']),
      kind: z.literal('text'),
      counts: z.object({ observations: z.number().int(), dropped: z.number() }),
      byKind: z.record(z.enum(['cv', 'github']), z.number()),
      current: z.boolean(),
      at: z.date().nullable(),
      either: z.union([idSchema('source'), z.number()]),
      pair: z.tuple([idSchema('item'), z.number()]),
      piped: z.number().pipe(z.number().int()),
      caught: z.number().catch(0),
    });
    expect(ioViolations(safe)).toEqual([]);
  });

  it('reports free text, unchecked values and unbounded codes', () => {
    const unsafe = z.object({
      note: z.string(),
      bounded: z.string().min(1).max(40),
      anything: z.string().regex(/^.*$/),
      c2: z.email(),
      link: z.url(),
      nested: z.object({ items: z.array(z.object({ quote: z.string().optional() })) }),
      union: z.union([idSchema('subject'), z.string()]),
      map: z.record(z.string(), z.number()),
      payload: z.unknown(),
      any: z.any(),
      unboundedCode: z.string().regex(/^[a-z][a-z0-9_.:-]*$/),
      longCode: z
        .string()
        .max(80)
        .regex(/^[a-z][a-z0-9_.:-]*$/),
    });
    expect(paths(unsafe)).toEqual([
      '$.note',
      '$.bounded',
      '$.anything',
      '$.c2',
      '$.link',
      '$.nested.items[].quote',
      '$.union|1',
      '$.map{key}',
      '$.payload',
      '$.any',
      '$.unboundedCode',
      '$.longCode',
    ]);
  });

  it('walks both sides of a pipe and flags transforms', () => {
    expect(paths(z.object({ t: z.string().transform((s) => s.length) }))).toEqual(['$.t', '$.t>']);
    expect(paths(z.object({ t: idSchema('subject').transform((s) => s) }))).toEqual(['$.t>']);
    expect(paths(z.object({ t: z.number().pipe(z.string() as unknown as z.ZodNumber) }))).toEqual(['$.t>']);
  });

  it('flags loose, passthrough and catchall objects, and tuple rest elements', () => {
    expect(paths(z.looseObject({ a: z.number() }))).toEqual(['$']);
    expect(paths(z.object({ a: z.number() }).passthrough())).toEqual(['$']);
    expect(paths(z.object({ a: z.number() }).catchall(z.number()))).toEqual(['$']);
    expect(paths(z.strictObject({ a: z.number() }))).toEqual([]);
    expect(paths(z.object({ t: z.tuple([z.number()], z.number()) }))).toEqual(['$.t']);
  });

  it('flags regexes with flags and .catch with a string value', () => {
    expect(paths(z.object({ id: z.string().regex(/^psub_[A-Za-z0-9]+$/i) }))).toEqual(['$.id']);
    expect(paths(z.object({ s: z.enum(['a', 'b']).catch('a') }))).toEqual(['$.s']);
    expect(paths(z.object({ s: idSchema('subject').catch('psub_x') }))).toEqual(['$.s']);
    expect(paths(z.object({ o: z.object({ a: z.number() }).catch({ a: 1 }) }))).toEqual(['$.o']);
    expect(paths(z.object({ n: z.number().catch(0) }))).toEqual([]);
  });

  it('flags personal-looking field names whatever their type', () => {
    const named = z.object({
      fullName: z.enum(['a']),
      contactEmail: z.boolean(),
      Phone: z.number(),
      dateOfBirth: z.date(),
      dob: z.date(),
      homeAddress: idSchema('item'),
      postcode: z.number(),
      zipCode: z.number(),
      ssn: z.number(),
      passportNo: z.number(),
      nationality: z.enum(['x']),
      githubHandle: z.literal('x'),
      profileUrl: z.boolean(),
      subjectId: idSchema('subject'),
    });
    expect(paths(named)).toEqual([
      '$.fullName',
      '$.contactEmail',
      '$.Phone',
      '$.dateOfBirth',
      '$.dob',
      '$.homeAddress',
      '$.postcode',
      '$.zipCode',
      '$.ssn',
      '$.passportNo',
      '$.nationality',
      '$.githubHandle',
      '$.profileUrl',
    ]);
  });

  it('the shared IO code schema passes; the document codeSchema (≤ 80) does not', () => {
    expect(paths(z.object({ reason: ioCodeSchema }))).toEqual([]);
    expect(paths(z.object({ reason: codeSchema }))).toEqual(['$.reason']);
  });

  it('matches field-name tokens, not substrings, with a reviewed allowlist', () => {
    expect(fieldNameTokens('profileURL')).toEqual(['profile', 'url']);
    expect(fieldNameTokens('date_of_birth')).toEqual(['date', 'of', 'birth']);
    expect(fieldNameTokens('email2')).toEqual(['email', '2']);
    const schema = z.object({
      renamed: z.boolean(),
      extractorName: z.boolean(),
      extractor: z.object({ name: ioCodeSchema, version: z.number() }),
      urlCount: z.number(),
      username: z.boolean(),
      currentLocation: z.boolean(),
    });
    expect(paths(schema)).toEqual(['$.username', '$.currentLocation']);
    // An allowlisted name is still walked: free text there is still refused.
    expect(paths(z.object({ extractor: z.object({ name: z.string() }) }))).toEqual(['$.extractor.name']);
  });

  it('catches compounds, plurals and acronym plurals the tokenizer alone would miss', () => {
    const keys = [
      'firstname',
      'fullname',
      'surname',
      'emails',
      'urls',
      'emailaddress',
      'phonenumber',
      'birthdate',
      'gmailId',
      'cityOfResidence',
      'profileURLs',
      'URLs',
      'linkedInId',
    ];
    const schema = z.object(Object.fromEntries(keys.map((k) => [k, z.boolean()])));
    expect(paths(schema)).toEqual(keys.map((k) => `$.${k}`));
    expect(fieldNameTokens('profileURLs')).toEqual(['profile', 'urls']);
    // Allowlisted exceptions still apply to stems.
    expect(paths(z.object({ urlCount: z.number(), emailCount: z.number() }))).toEqual([]);
  });

  it('probes .catch with a string input, so an echoing fallback is flagged', () => {
    const echo = z.number().catch((c) => c.input as number);
    expect(paths(z.object({ n: echo }))).toEqual(['$.n']);
  });

  it('catches the further stems and short whole-word tokens, without substring false positives', () => {
    const denied = [
      'postalArea',
      'nationalityCode',
      'salaryBand',
      'genderCode',
      'religiousView',
      'ethnicGroup',
      'compensationTarget',
      'userName',
      'nickname',
      'forename',
      'displayName',
      'handleValue',
      'tel',
      'cellNumber',
      'cityName',
      'countryCode',
      'websiteLink',
      'twitterId',
      'githubUser',
      'citizenshipStatus',
      'age',
      'ageBand',
    ];
    expect(paths(z.object(Object.fromEntries(denied.map((k) => [k, z.boolean()]))))).toEqual(
      denied.map((k) => `$.${k}`),
    );
    const allowed = ['hotelCount', 'cancelled', 'capacity', 'page', 'usage', 'stage', 'extractorName'];
    expect(paths(z.object(Object.fromEntries(allowed.map((k) => [k, z.boolean()]))))).toEqual([]);
  });

  it('`handle` is a whole token; compounds of short tokens (L-7 review)', () => {
    // Not personal: `handle` is no longer a substring stem; durations, counters and run ids.
    const allowed = [
      'handler',
      'unhandled',
      'errorHandled',
      'ageMs',
      'ttlSeconds',
      'cellCount',
      'cityCount',
      'githubRunId',
      'telemetry',
      'cellar',
    ];
    expect(paths(z.object(Object.fromEntries(allowed.map((k) => [k, z.number()]))))).toEqual([]);
    // Still denied: the whole token `handle` cannot be told from a social handle (retryHandle
    // needs a reviewed allowlist entry if a capability ever uses it), and account references.
    const denied = ['handle', 'retryHandle', 'githubHandle', 'github', 'githubId', 'age', 'ageYears', 'tel'];
    expect(paths(z.object(Object.fromEntries(denied.map((k) => [k, z.number()]))))).toEqual(
      denied.map((k) => `$.${k}`),
    );
    // An exempted name is still walked: a free-text string there is still refused.
    expect(paths(z.object({ githubRunId: z.string() }))).toEqual(['$.githubRunId']);
  });

  it('a suffix exemption covers only the token it explains; other denied tokens are still refused', () => {
    const refused = [
      'dobMs',
      'birthdateMs',
      'birthDateSeconds',
      'emailRunId',
      'phoneSeconds',
      'githubHandleRunId',
      'ageEmailMs',
      'githubMs',
    ];
    expect(paths(z.object(Object.fromEntries(refused.map((k) => [k, z.number()]))))).toEqual(
      refused.map((k) => `$.${k}`),
    );
    expect(personalFieldName('dobMs')).toBe('dob');
    expect(personalFieldName('birthDateSeconds')).toBe('birth');
    expect(personalFieldName('emailRunId')).toBe('email');
    expect(personalFieldName('ageEmailMs')).toBe('email');
    for (const k of ['ageMs', 'ttlSeconds', 'githubRunId']) expect(personalFieldName(k)).toBeUndefined();
  });

  it('keys caught only by the plural rules (-s and -ies)', () => {
    const keys = ['dobs', 'zips', 'handles', 'locations', 'genders', 'cities', 'ages'];
    expect(paths(z.object(Object.fromEntries(keys.map((k) => [k, z.boolean()]))))).toEqual(
      keys.map((k) => `$.${k}`),
    );
    expect(personalFieldName('dobs')).toBe('dob');
    expect(personalFieldName('cities')).toBe('city');
    expect(personalFieldName('locations')).toBe('location');
  });
});
