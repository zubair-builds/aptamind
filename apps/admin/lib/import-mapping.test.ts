import { describe, expect, it } from 'vitest';
import { readCsv } from './csv';
import {
  columnsConfig,
  hasIdentityColumn,
  IMPORT_KINDS,
  listNameFromFile,
  reduceCsv,
  sameColumns,
  suggestMapping,
  validateMapping,
} from './import-mapping';

function parsed(text: string) {
  const r = readCsv(text);
  if (!r.ok) throw new Error(r.error);
  return r;
}

describe('validateMapping', () => {
  it('accepts a minimal companies mapping', () => {
    expect(validateMapping('companies', ['Company', 'Owner'], ['name', null])).toEqual([]);
  });

  it('requires the name column for companies', () => {
    expect(validateMapping('companies', ['Domain'], ['domain']).map((i) => i.message)).toEqual([
      'Choose a column for Name.',
    ]);
  });

  it('refuses a field chosen twice and two imported columns with the same name', () => {
    const issues = validateMapping('companies', ['Name', 'Name', 'Site'], ['name', 'legalName', 'name']);
    expect(issues.map((i) => i.column)).toEqual([2, 1]);
    expect(issues[0]!.message).toMatch(/Name is chosen for more than one column/);
    expect(issues[1]!.message).toMatch(/both named "Name"/);
  });

  it('refuses a mapped column without a header name', () => {
    expect(validateMapping('companies', ['Name', ''], ['name', 'domain'])[0]).toEqual({
      column: 1,
      message: 'Column 2 has no header name, so it cannot be imported.',
    });
  });

  it('needs a company or domain and a board for ATS boards', () => {
    const msgs = validateMapping('ats_boards', ['ATS', 'Token'], ['provider', 'token']).map((i) => i.message);
    expect(msgs).toEqual(['Choose a column for Company name or Company domain (at least one).']);
    expect(
      validateMapping('ats_boards', ['ATS', 'Token', 'Domain'], ['provider', 'token', 'domain']),
    ).toEqual([]);
    expect(validateMapping('ats_boards', ['Domain'], ['domain'])).toHaveLength(1);
  });

  it('accepts a board from provider and token, or from a URL, as the server does', () => {
    const msgs = (header: string[], mapping: (string | null)[]) =>
      validateMapping('ats_boards', header, mapping).map((i) => i.message);
    const noBoard = 'Choose a column for Board or job URL, or columns for both ATS provider and Board token.';
    expect(msgs(['Company', 'Job Link'], ['company', 'url'])).toEqual([]);
    expect(msgs(['Domain', 'URL', 'ATS', 'Token'], ['domain', 'url', 'provider', 'token'])).toEqual([]);
    expect(msgs(['Company', 'ATS', 'URL'], ['company', 'provider', 'url'])).toEqual([]);
    expect(msgs(['Company', 'ATS', 'Token'], ['company', 'provider', 'token'])).toEqual([]);
    expect(msgs(['Company', 'ATS'], ['company', 'provider'])).toEqual([noBoard]);
    expect(msgs(['Company', 'Token'], ['company', 'token'])).toEqual([noBoard]);
    expect(msgs(['Company'], ['company'])).toEqual([noBoard]);
    expect(msgs(['Job Link'], ['url'])).toEqual([
      'Choose a column for Company name or Company domain (at least one).',
    ]);
  });

  it('requires a url column for job links and does not offer provider or token', () => {
    expect(IMPORT_KINDS.jobs.fields.map((f) => f.key)).toEqual(['url', 'company', 'domain']);
    expect(validateMapping('jobs', ['Job link'], ['url'])).toEqual([]);
    expect(validateMapping('jobs', ['URL', 'Company', 'Domain'], ['url', 'company', 'domain'])).toEqual([]);
    expect(validateMapping('jobs', ['Company'], ['company']).map((i) => i.message)).toEqual([
      'Choose a column for Job link.',
    ]);
    expect(validateMapping('jobs', ['Domain'], ['domain']).map((i) => i.message)).toEqual([
      'Choose a column for Job link.',
    ]);
  });
});

describe('columnsConfig', () => {
  it('maps fields to exact header names and nests register ids', () => {
    expect(
      columnsConfig(
        ['Company', 'Notes', 'LEI code', 'CH number'],
        ['name', null, 'registerIds.lei', 'registerIds.gb_companies_house'],
      ),
    ).toEqual({ name: 'Company', registerIds: { lei: 'LEI code', gb_companies_house: 'CH number' } });
  });
});

describe('sameColumns', () => {
  it('ignores key order and an empty registerIds', () => {
    expect(sameColumns({ name: 'A', domain: 'B' }, { domain: 'B', name: 'A', registerIds: {} })).toBe(true);
    expect(
      sameColumns({ name: 'A', registerIds: { lei: 'L' } }, { registerIds: { lei: 'L' }, name: 'A' }),
    ).toBe(true);
  });

  it('sees a renamed or extra column', () => {
    expect(sameColumns({ name: 'A' }, { name: 'Company' })).toBe(false);
    expect(sameColumns({ name: 'A' }, { name: 'A', domain: 'D' })).toBe(false);
    expect(sameColumns(undefined, { name: 'A' })).toBe(false);
  });
});

describe('suggestMapping', () => {
  it('recognises common header spellings once each', () => {
    expect(
      suggestMapping('companies', ['Company Name', 'Website URL', 'City', 'Email', 'company_name']),
    ).toEqual(['name', 'website', 'town', null, null]);
    expect(suggestMapping('ats_boards', ['ATS', 'Board token', 'Company'])).toEqual([
      'provider',
      'token',
      'company',
    ]);
  });

  it('suggests the URL field for job and board link headers on ATS board files', () => {
    for (const h of ['Job Link', 'URL', 'Link', 'Careers URL', 'Board URL', 'job_url'])
      expect(suggestMapping('ats_boards', ['Company', h])).toEqual(['company', 'url']);
    // On a companies file a careers URL is still the careers page field.
    expect(suggestMapping('companies', ['Careers URL'])).toEqual(['careersUrl']);
  });

  it('suggests a job link from the URL header and ignores a saved provider or token', () => {
    expect(suggestMapping('jobs', ['Company', 'Job Link'])).toEqual(['company', 'url']);
    expect(
      suggestMapping('jobs', ['ATS', 'Token', 'Link'], { provider: 'ATS', token: 'Token', url: 'Link' }),
    ).toEqual([null, null, 'url']);
  });

  it('uses a saved mapping by exact header when one is given', () => {
    const saved = { name: 'Org', registerIds: { lei: 'LEI' } };
    expect(suggestMapping('companies', ['LEI', 'Org', 'Name'], saved)).toEqual([
      'registerIds.lei',
      'name',
      null,
    ]);
  });
});

describe('suggestMapping with a saved mapping that does not cover the file', () => {
  it('falls back to header spellings for the other columns', () => {
    expect(suggestMapping('companies', ['Org', 'Domain'], { name: 'Org' })).toEqual(['name', 'domain']);
  });
});

describe('hasIdentityColumn', () => {
  it('is true for a domain or any register id, never for website', () => {
    expect(hasIdentityColumn(['name', 'website'])).toBe(false);
    expect(hasIdentityColumn(['name', 'domain'])).toBe(true);
    expect(hasIdentityColumn([null, 'registerIds.lei'])).toBe(true);
  });
});

describe('reduceCsv', () => {
  it('keeps only mapped columns, in file order, with exact header names', () => {
    const p = parsed('Name,Owner email,Domain\nAcme,ceo@acme.com,acme.com\n"Beta, Ltd",x@y.z,beta.io\n');
    const out = reduceCsv(p, ['name', null, 'domain']);
    expect(out).toBe('Name,Domain\r\nAcme,acme.com\r\n"Beta, Ltd",beta.io\r\n');
    expect(out).not.toContain('@');
  });

  it('keeps every row on its original line number', () => {
    // Line 3 is malformed, line 4 holds a two-line note in a dropped column, line 6 is blank.
    const text = '\nName,Note\n"bad"x,1\nAcme,"two\nlines"\n\nBeta,ok\n';
    const p = parsed(text);
    expect(p.malformed).toHaveLength(1);
    const out = reduceCsv(p, ['name', null]);
    const back = parsed(out);
    expect(back.header).toEqual(['Name']);
    expect(back.headerLine).toBe(p.headerLine);
    expect(back.rows).toEqual([
      { line: 4, fields: ['Acme'] },
      { line: 7, fields: ['Beta'] },
    ]);
  });

  it('keeps a multi-line value in a mapped column intact', () => {
    const p = parsed('Name,Town\n"Acme\nGroup",Leeds\nBeta,York\n');
    const back = parsed(reduceCsv(p, ['name', null]));
    expect(back.rows).toEqual([
      { line: 2, fields: ['Acme\nGroup'] },
      { line: 4, fields: ['Beta'] },
    ]);
  });
});

describe('reduceCsv with one kept column', () => {
  it('quotes an empty cell so the server still counts the row', () => {
    const p = parsed('Name,Note\nAcme,x\n,y\n  ,z\n');
    const out = reduceCsv(p, ['name', null]);
    expect(out).toBe('Name\r\nAcme\r\n""\r\n"  "\r\n');
    expect(parsed(out).rows.map((r) => r.line)).toEqual([2, 3, 4]);
  });
});

describe('listNameFromFile', () => {
  it('drops the extension', () => {
    expect(listNameFromFile('UK fintechs.csv')).toBe('UK fintechs');
    expect(listNameFromFile('.csv')).toBe('.csv');
  });
});
