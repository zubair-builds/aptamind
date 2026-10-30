import { describe, expect, it } from 'vitest';
import {
  checkDirectoryUpload,
  csvShape,
  headerWords,
  isPersonalDataColumn,
  mapDirectoryRow,
  MAX_CSV_COLUMNS,
  fileIdKey,
  NO_ID_COLUMN_WARNING,
  MAX_VALUE_CHARS,
  parseDirectoryConfig,
  planDirectoryImport,
  readCsv,
} from './company-directory';

/** The row's problem: its error, else its first dropped-cell warning (re-verification #6). */
const problemOf = (r: ReturnType<typeof mapDirectoryRow>) => ('error' in r ? r.error : r.warnings[0]);

const config = parseDirectoryConfig({
  columns: {
    name: 'Company',
    domain: 'Domain',
    country: 'Country',
    careersUrl: 'Careers',
    registerIds: { gb_companies_house: 'Company number' },
  },
});
const HEADER = 'Company,Domain,Country,Careers,Company number';

describe('readCsv (strict RFC 4180)', () => {
  it('handles quotes, escaped quotes, CRLF, a BOM and newlines inside quotes; blank lines are no records', () => {
    const records: Array<{ line: number; fields: string[] }> = [];
    const problems: unknown[] = [];
    const { header, records: n } = readCsv(
      '\ufeffa,b\r\n"x, y","he said ""hi"""\r\n\r\n"multi\nline",2\n',
      (r) => records.push(r),
      (p) => problems.push(p),
    );
    expect(header).toEqual(['a', 'b']);
    expect(n).toBe(2);
    expect(records).toEqual([
      { line: 2, fields: ['x, y', 'he said "hi"'] },
      { line: 4, fields: ['multi\nline', '2'] },
    ]);
    expect(problems).toEqual([]);
  });

  it('reports malformed records (wrong field count, text after a closing quote, unterminated quote) and never emits them', () => {
    const records: unknown[] = [];
    const problems: Array<{ line: number; message: string }> = [];
    readCsv(
      'a,b\n1,2,3\n"x"y,2\nok,1\n"open,2\n',
      (r) => records.push(r),
      (p) => problems.push(p),
    );
    expect(records).toEqual([{ line: 4, fields: ['ok', '1'] }]);
    expect(problems.map((p) => p.line)).toEqual([2, 3, 5]);
  });

  it('csvShape counts records, not lines', () => {
    expect(csvShape('h1,h2\n"a\nb",c\nd,e\n')).toMatchObject({ header: ['h1', 'h2'], records: 2 });
  });
});

describe('checkDirectoryUpload (before storage)', () => {
  const csv = (rows: string[], header = HEADER) => [header, ...rows].join('\n');

  it('accepts a company-only file with the mapped columns', () => {
    expect(checkDirectoryUpload(config, csv(['Acme Ltd,acme.com,GB,,00445790']), 'text/csv')).toEqual([]);
  });

  it('refuses a file over the size limit without reading it', () => {
    const small = parseDirectoryConfig({ ...config, maxBytes: 10 });
    expect(checkDirectoryUpload(small, csv(['Acme Ltd,acme.com,GB,,1']), 'text/csv')).toMatchObject([
      { code: 'too_large' },
    ]);
  });

  it('refuses more rows than the source accepts (records, not lines)', () => {
    const few = parseDirectoryConfig({ ...config, maxRows: 1 });
    expect(checkDirectoryUpload(few, csv(['A,a.com,GB,,1', 'B,b.com,GB,,2']), 'text/csv')).toMatchObject([
      { code: 'too_many_rows' },
    ]);
    expect(checkDirectoryUpload(few, csv(['"A\nLtd",a.com,GB,,1']), 'text/csv')).toEqual([]);
  });

  it('refuses personal-data columns, unmapped columns, missing or duplicate mapped columns', () => {
    const problems = checkDirectoryUpload(
      config,
      csv([], 'Company,Domain,Domain,Contact email,First name,Notes,Careers'),
      'text/csv',
    );
    expect(problems.map((p) => [p.code, p.column])).toEqual(
      expect.arrayContaining([
        ['duplicate_column', 'Domain'],
        ['missing_column', 'Country'],
        ['missing_column', 'Company number'],
        // Unmapped and personal-data columns are named by position only (never their text).
        ['personal_data_column', 'column 4'],
        ['personal_data_column', 'column 5'],
        ['unmapped_column', 'column 6'],
      ]),
    );
    expect(JSON.stringify(problems)).not.toMatch(/Contact email|First name|Notes/);
  });

  it('there is no ignoreColumns: every column must be mapped (re-verification #5)', () => {
    expect(() => parseDirectoryConfig({ columns: { name: 'Company' }, ignoreColumns: ['Notes'] })).toThrow(
      /ignoreColumns|Unrecognized/,
    );
    const problems = checkDirectoryUpload(config, csv([], `${HEADER},Notes`), 'text/csv');
    expect(problems).toEqual([expect.objectContaining({ code: 'unmapped_column', column: 'column 6' })]);
  });

  it('refuses a non-CSV content type', () => {
    expect(checkDirectoryUpload(config, csv([]), 'application/pdf')).toMatchObject([{ code: 'not_csv' }]);
  });
});

describe('parseDirectoryConfig', () => {
  it('requires a name column and refuses another provider’s id namespace or limits over the ceiling', () => {
    expect(() => parseDirectoryConfig({ columns: {} })).toThrow(/columns.name/);
    expect(() =>
      parseDirectoryConfig({ columns: { name: 'n', registerIds: { uk_sponsor_register: 'x' } } }),
    ).toThrow(/belongs to another provider/);
    expect(() => parseDirectoryConfig({ columns: { name: 'n' }, maxRows: 10_000_000 })).toThrow();
  });

  it('register-id namespaces come from the Market registry; any other is refused (B-M2)', () => {
    expect(() =>
      parseDirectoryConfig({ columns: { name: 'n', registerIds: { acme_internal: 'x' } } }),
    ).toThrow(/unknown register-id namespace/);
    expect(
      parseDirectoryConfig({ columns: { name: 'n', registerIds: { lei: 'LEI', fr_siren: 'SIREN' } } }).columns
        .registerIds,
    ).toEqual({ lei: 'LEI', fr_siren: 'SIREN' });
  });

  it('validates defaultCountry and stores it normalised', () => {
    expect(parseDirectoryConfig({ columns: { name: 'n' }, defaultCountry: 'gb' }).defaultCountry).toBe('GB');
    expect(parseDirectoryConfig({ columns: { name: 'n' }, defaultCountry: 'UK' }).defaultCountry).toBe('GB');
    expect(() => parseDirectoryConfig({ columns: { name: 'n' }, defaultCountry: 'ZZ' })).toThrow(
      /defaultCountry/,
    );
  });
});

describe('mapDirectoryRow', () => {
  const row = (over: Record<string, string> = {}) => ({
    Company: 'Acme Ltd t/a Acme Coffee',
    Domain: 'https://www.Acme.com/',
    Country: 'United Kingdom',
    Careers: 'careers.acme.com/jobs',
    'Company number': '00445790',
    ...over,
  });

  it('maps a row to a company observation payload with provenance locator and a register-id record key', () => {
    const r = mapDirectoryRow(config, row(), 7);
    expect(r).toEqual({
      warnings: [],
      candidate: {
        externalId: 'gb_companies_house:00445790',
        locator: 'row:7',
        payload: expect.objectContaining({
          name: 'Acme Ltd t/a Acme Coffee',
          legalName: 'Acme Ltd',
          aliases: ['Acme Coffee'],
          domain: 'acme.com',
          website: 'https://acme.com/',
          externalIds: [{ namespace: 'gb_companies_house', id: '00445790' }],
          locations: [{ country: 'GB', kind: 'hq' }],
          careersUrl: 'https://careers.acme.com/jobs',
        }),
      },
    });
  });

  it('record key: file id, else register id, else name + country, else domain, else name (B-M5)', () => {
    const key = (cfg: typeof config, over: Record<string, string>) => {
      const r = mapDirectoryRow(cfg, row(over), 2);
      return 'candidate' in r ? r.candidate.externalId : r.error.code;
    };
    const withId = parseDirectoryConfig({ columns: { ...config.columns, id: 'Ref' } });
    // The file's own id is never stored raw: a SHA-256 of source + normalised value.
    expect(key(withId, { Ref: 'R-1' })).toBe(fileIdKey('', 'R-1'));
    expect(key(withId, { Ref: 'R-1' })).toMatch(/^id:[0-9a-f]{32}$/);
    expect(key(config, {})).toBe('gb_companies_house:00445790');
    // Name + country ranks above the domain: sister companies share a domain.
    expect(key(config, { 'Company number': '' })).toBe('name:acme ltd|gb');
    expect(key(config, { 'Company number': '', Country: '' })).toBe('domain:acme.com');
    expect(key(config, { 'Company number': '', Country: '', Domain: '' })).toBe('name:acme ltd|');
    const byDefault = parseDirectoryConfig({ columns: config.columns, defaultCountry: 'DE' });
    expect(key(byDefault, { 'Company number': '', Country: '' })).toBe('name:acme ltd|de');
  });

  it('two companies sharing a domain in one file are two records, not a duplicate key', () => {
    const plan = planDirectoryImport(
      config,
      `${HEADER}\nAcme Holdings Ltd,acme.com,GB,,\nAcme Retail Ltd,acme.com,GB,,\n`,
      'src_test',
    );
    expect(plan.errors).toEqual([]);
    expect(plan.candidates.map((c) => c.externalId)).toEqual([
      'name:acme holdings ltd|gb',
      'name:acme retail ltd|gb',
    ]);
  });

  it('warns when no id column is mapped (the import still runs)', () => {
    expect(planDirectoryImport(config, `${HEADER}\nAcme Ltd,acme.com,GB,,\n`, 'src_test').warnings).toEqual([
      NO_ID_COLUMN_WARNING,
    ]);
    const withId = parseDirectoryConfig({ columns: { ...config.columns, id: 'Ref' } });
    expect(
      planDirectoryImport(withId, `${HEADER},Ref\nAcme Ltd,acme.com,GB,,,R1\n`, 'src_test').warnings,
    ).toEqual([]);
  });

  it('non-Latin names keep their letters in the record key; a name with no letters or digits is a row error', () => {
    const key = (name: string) => {
      const r = mapDirectoryRow(config, row({ Company: name, 'Company number': '', Country: 'JP' }), 2);
      return 'candidate' in r ? r.candidate.externalId : r.error.code;
    };
    expect(key('東京電力')).toBe('name:東京電力|jp');
    expect(key('トヨタ自動車')).toBe('name:トヨタ自動車|jp');
    expect(key('ООО Ромашка')).not.toBe(key('ООО Лютик'));
    expect(key('--- & ---')).not.toBe('invalid_name'); // "and" is a word
    expect(key('— · —')).toBe('missing_name'); // punctuation only: a placeholder
    expect(key('ʹʹ')).toBe('invalid_name');
  });

  it('maps the town column to the head-office location (B-M3)', () => {
    const cfg = parseDirectoryConfig({ columns: { ...config.columns, town: 'Town' } });
    const r = mapDirectoryRow(cfg, { ...row(), Town: 'Leeds' }, 2);
    expect('candidate' in r && r.candidate.payload.locations).toEqual([
      { country: 'GB', city: 'Leeds', kind: 'hq' },
    ]);
    const noCountry = mapDirectoryRow(cfg, { ...row(), Country: '', Town: 'Leeds' }, 2);
    expect('candidate' in noCountry && noCountry.candidate.payload.locations).toEqual([
      { country: null, city: 'Leeds', kind: 'hq' },
    ]);
  });

  it.each([
    [{ Domain: 'jane.doe@acme.com' }, 'Domain'],
    [{ Domain: 'mailto:jane@acme.com' }, 'Domain'],
    [{ Careers: 'https://jane:secret@careers.acme.com/jobs' }, 'Careers'],
    [{ Careers: 'jobs@acme.com' }, 'Careers'],
    [{ Careers: 'tel:+441234567890' }, 'Careers'],
  ])('a contact value %j is a row error that never echoes the value (B-M1)', (over, column) => {
    const r = mapDirectoryRow(config, row(over), 4);
    expect(problemOf(r)).toMatchObject({ line: 4, code: 'contact_value', column });
    const message = 'error' in r ? r.error.message : '';
    expect(message).not.toMatch(/jane|jobs@|secret|1234567890/);
  });

  it('a website with credentials is a contact value; so is an @ in a URL path (a handle)', () => {
    const cfg = parseDirectoryConfig({ columns: { ...config.columns, website: 'Web' } });
    expect(problemOf(mapDirectoryRow(cfg, { ...row(), Web: 'https://jane@acme.com/' }, 2))).toMatchObject({
      code: 'contact_value',
      column: 'Web',
    });
    // An @ in the path is reduced away (DECISION_LOG 29b6592): never stored.
    const handle = mapDirectoryRow(cfg, { ...row(), Web: 'https://medium.com/@acme' }, 2);
    expect(JSON.stringify(handle)).not.toContain('@acme');
  });

  it('register ids are normalised to their namespace format, or a row error (B-M2)', () => {
    const cfg = parseDirectoryConfig({
      columns: { name: 'Company', registerIds: { gb_companies_house: 'CRN', lei: 'LEI' } },
    });
    const ids = (over: Record<string, string>) => {
      const r = mapDirectoryRow(cfg, { Company: 'Acme Ltd', CRN: '', LEI: '', ...over }, 2);
      // An invalid id is dropped with a warning; the row is kept (re-verification #6).
      return 'error' in r ? r.error.code : (r.warnings[0]?.code ?? r.candidate.payload.externalIds);
    };
    expect(ids({ CRN: '445790' })).toEqual([{ namespace: 'gb_companies_house', id: '00445790' }]);
    expect(ids({ CRN: 'sc 204567' })).toEqual([{ namespace: 'gb_companies_house', id: 'SC204567' }]);
    expect(ids({ CRN: '12-34-56-78-9' })).toBe('invalid_external_id');
    expect(ids({ LEI: '5493001kjtiigc8y1r12' })).toEqual([{ namespace: 'lei', id: '5493001KJTIIGC8Y1R12' }]);
    expect(ids({ LEI: '5493001KJTIIGC8Y1R13' })).toBe('invalid_external_id'); // check digits
    // A config built without the parser still cannot assert an unknown namespace.
    const raw = { ...cfg, columns: { ...cfg.columns, registerIds: { acme_internal: 'CRN' } } };
    expect(problemOf(mapDirectoryRow(raw, { Company: 'Acme Ltd', CRN: '42' }, 2))).toMatchObject({
      code: 'unknown_id_namespace',
    });
  });

  it.each([
    [{ Company: '  ' }, 'missing_name'],
    [{ Domain: 'gmail.com' }, 'invalid_domain'],
    [{ Domain: 'not a domain' }, 'invalid_domain'],
    [{ Country: 'Atlantis' }, 'invalid_country'],
    [{ Careers: 'ftp://acme.com/jobs' }, 'invalid_careers_url'],
  ])('a bad value %j is a row error %s, never a silent drop', (over, code) => {
    expect(problemOf(mapDirectoryRow(config, row(over), 3))).toMatchObject({ line: 3, code });
  });
});

describe('planDirectoryImport', () => {
  it('imports valid rows and reports every other row (malformed, invalid, duplicate key) with its line', () => {
    const text = [
      HEADER,
      'Acme Ltd,acme.com,GB,,00445790',
      'Bad Row,gmail.com,GB,,',
      'Acme Limited,acme.com,GB,,00445790',
      'Short,row',
      'Beta Ltd,beta.io,DE,,',
    ].join('\n');
    const plan = planDirectoryImport(config, text, 'src_test');
    expect(plan.rowCount).toBe(5);
    expect(plan.candidates.map((c) => [c.locator, c.externalId])).toEqual([
      ['row:2', 'gb_companies_house:00445790'],
      ['row:3', 'name:bad row|gb'], // the refused Domain cell is dropped, the row kept
      ['row:6', 'name:beta ltd|de'],
    ]);
    expect(plan.errors.map((e) => [e.line, e.code])).toEqual([
      [4, 'duplicate_row_key'],
      [5, 'malformed_row'],
    ]);
    expect(plan.rowWarnings.map((w) => [w.line, w.code, w.column])).toEqual([
      [3, 'invalid_domain', 'Domain'],
    ]);
    expect(plan.candidates[1]!.payload.domain).toBeNull();
    expect(plan.candidates.length + plan.errors.length).toBe(plan.rowCount);
    expect(plan.headerProblems).toEqual([]);
  });

  it('is deterministic: the same file plans the same candidates (idempotent re-import)', () => {
    const text = `${HEADER}\nAcme Ltd,acme.com,GB,,1\nBeta Ltd,beta.io,DE,,2\n`;
    expect(planDirectoryImport(config, text, 'src_test')).toEqual(
      planDirectoryImport(config, text, 'src_test'),
    );
  });
});

describe('personal-data header guard (tokenised, singularised)', () => {
  it.each([
    'contact_email',
    'email_address',
    'personal_email',
    'hr_email',
    'phone_number',
    'mobile_phone',
    'PhoneNumber',
    'ContactName',
    'director_name',
    'date_of_birth',
    'DateOfBirth',
    'Emails',
    'Phones',
    'Contacts',
    'Directors',
    'People',
    'E-mail',
    'First name',
    'lastName',
    'Given Name',
    'Owner name',
    'Employee name',
    'Home address',
    'National insurance number',
    'Passport no',
    'LinkedIn profile',
    // Decision: company switchboard numbers are refused too (no field reads phones, and a phone
    // column cannot be told apart from a person's number).
    'Company phone',
    'Company Telephone',
    'Tel',
    'Fax',
  ])('%s is personal data', (column) => {
    expect(isPersonalDataColumn(column)).toBe(true);
  });

  it.each([
    'Company',
    'Company name',
    'Legal name',
    'Domain',
    'Website',
    'Country',
    'Town',
    'Company number',
    'Registered address',
    'Employee count',
    'Careers',
    'Careers URL',
    'Industry',
  ])('%s is company data', (column) => {
    expect(isPersonalDataColumn(column)).toBe(false);
  });

  it('splits camelCase and punctuation and singularises words', () => {
    expect(headerWords('ContactName')).toEqual(['contact', 'name']);
    expect(headerWords('date_of_birth')).toEqual(['date', 'of', 'birth']);
    expect(headerWords('PhoneNumbers')).toEqual(['phone', 'number']);
    expect(headerWords('Directors')).toEqual(['director']);
    expect(headerWords('People')).toEqual(['person']);
  });

  it('the column map can never admit personal data; the header check refuses it anyway', () => {
    expect(() => parseDirectoryConfig({ columns: { name: 'ContactName' } })).toThrow(/personal data/);
    // The config names the column (an operator value, not file content); the upload names it by position.
    try {
      parseDirectoryConfig({ columns: { name: 'ContactName', domain: ` Email ${'x'.repeat(80)} ` } });
      expect.unreachable();
    } catch (err) {
      expect((err as { details: unknown }).details).toEqual({
        problems: [
          { code: 'personal_data_column', column: 'ContactName', count: 2 },
          { code: 'personal_data_column', column: `Email ${'x'.repeat(58)}`, count: 2 },
        ],
      });
    }
    expect(checkDirectoryUpload(config, `${HEADER},hr_email\n`, 'text/csv')).toEqual([
      expect.objectContaining({ code: 'personal_data_column', column: 'column 6', position: 6 }),
    ]);
  });

  it('the configuration is strict: unknown keys are refused', () => {
    expect(() => parseDirectoryConfig({ columns: { name: 'Company' }, csvUrl: 'https://x' })).toThrow(
      /csvUrl|Unrecognized/i,
    );
    expect(() => parseDirectoryConfig({ columns: { name: 'Company', url: 'U' } })).toThrow();
  });
});

describe('reader strictness and bounds (A-M1, B-M6, Lows)', () => {
  const read = (text: string, opts?: { maxFieldChars?: number }) => {
    const records: Array<{ line: number; fields: string[] }> = [];
    const problems: Array<{ line: number; message: string }> = [];
    const res = readCsv(
      text,
      (r) => records.push(r),
      (p) => problems.push(p),
      opts,
    );
    return { ...res, records, problems };
  };

  it('refuses a quote inside an unquoted field (a"b) and a quote after leading spaces ( "x")', () => {
    for (const text of ['h\na"b\n', 'h,i\n "x",1\n']) {
      const r = read(text);
      expect(r.records).toEqual([]);
      expect(r.problems).toEqual([
        { line: 2, message: expect.stringMatching(/quote inside an unquoted field/) },
      ]);
    }
    // Properly quoted and escaped values are fine.
    expect(read('h\n"a""b"\n').records).toEqual([{ line: 2, fields: ['a"b'] }]);
  });

  it('flags a malformed header (and refuses the upload with malformed_header)', () => {
    expect(read('Com"pany,Domain\nA,b.com\n').headerProblem).toMatch(/quote inside/);
    const problems = checkDirectoryUpload(
      config,
      `Com"pany,Domain,Country,Careers,Company number\n`,
      'text/csv',
    );
    expect(problems.map((p) => p.code)).toContain('malformed_header');
  });

  it('refuses a file that is not UTF-8 before storage (fatal decoding, no U+FFFD)', () => {
    const latin1 = Buffer.from(`${HEADER}\nSoci\xe9t\xe9 Ltd,s.com,FR,,\n`, 'latin1');
    expect(checkDirectoryUpload(config, new Uint8Array(latin1), 'text/csv')).toEqual([
      expect.objectContaining({ code: 'not_utf8' }),
    ]);
  });

  it('bounds memory: fields beyond the header are counted, not built; a header of too many columns is flagged', () => {
    const r = read(`a,b\n${','.repeat(100_000)}\n`);
    expect(r.problems).toEqual([{ line: 2, message: 'expected 2 fields, found 100001' }]);
    expect(
      read(`${Array.from({ length: MAX_CSV_COLUMNS + 1 }, (_, k) => `c${k}`).join(',')}\n`).headerProblem,
    ).toMatch(/more than 1000 columns/);
    // csvShape builds no data fields.
    expect(csvShape(`h\n${'x\n'.repeat(1000)}`)).toMatchObject({
      records: 1000,
      malformed: 0,
      headerProblem: null,
    });
  });

  it('hands a huge field on cut (maxFieldChars), so a mapped value over the limit is a row error', () => {
    const r = read(`h\n"${'""'.repeat(10_000)}"\n`, { maxFieldChars: 10 });
    expect(r.records[0]!.fields[0]).toHaveLength(11);
    const plan = planDirectoryImport(
      config,
      `${HEADER}\n"${'a'.repeat(MAX_VALUE_CHARS + 5)}",a.com,GB,,\n`,
      'src_test',
    );
    expect(plan.errors).toEqual([
      expect.objectContaining({ line: 2, code: 'value_too_long', column: 'Company' }),
    ]);
  });

  it('stops collecting rows past maxRows', () => {
    const few = parseDirectoryConfig({ ...config, maxRows: 2 });
    const plan = planDirectoryImport(few, `${HEADER}\n${'A Ltd,a.com,GB,,\n'.repeat(5)}`, 'src_test');
    expect(plan.rowCount).toBe(5);
    expect(plan.candidates.length + plan.errors.length).toBe(2);
  });
});
