import { describe, expect, it } from 'vitest';
import { csvField, decodeUtf8, lineCount, MAX_COLUMNS, readCsv } from './csv';

function ok(text: string) {
  const r = readCsv(text);
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r;
}

describe('decodeUtf8', () => {
  it('decodes UTF-8 and strips the BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('name\nZürich AG')]);
    expect(decodeUtf8(bytes)).toBe('name\nZürich AG');
  });

  it('returns null for bytes that are not UTF-8 (a Latin-1 export)', () => {
    expect(decodeUtf8(new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x5a, 0xfc, 0x72]))).toBeNull();
  });
});

describe('readCsv', () => {
  it('reads a simple file with line numbers', () => {
    const r = ok('name,domain\nAcme,acme.com\nBeta,beta.io\n');
    expect(r.header).toEqual(['name', 'domain']);
    expect(r.headerLine).toBe(1);
    expect(r.rows).toEqual([
      { line: 2, fields: ['Acme', 'acme.com'] },
      { line: 3, fields: ['Beta', 'beta.io'] },
    ]);
    expect(r.malformed).toEqual([]);
  });

  it('handles quoted fields, escaped quotes and commas', () => {
    const r = ok('name,note\n"Acme, Inc.","He said ""hi"""\n');
    expect(r.rows[0]!.fields).toEqual(['Acme, Inc.', 'He said "hi"']);
  });

  it('keeps line breaks inside quotes and counts physical lines', () => {
    const r = ok('name,address\n"Acme","1 Main St\nLondon"\nBeta,x\n');
    expect(r.rows[0]).toEqual({ line: 2, fields: ['Acme', '1 Main St\nLondon'] });
    expect(r.rows[1]!.line).toBe(4);
  });

  it('accepts CRLF and lone CR line endings', () => {
    expect(ok('a,b\r\n1,2\r\n3,4').rows.map((x) => x.fields)).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(ok('a,b\r1,2\r3,4\r').rows.map((x) => x.line)).toEqual([2, 3]);
  });

  it('keeps a CRLF inside quotes as one line break in the value', () => {
    const r = ok('a,b\r\n"x\r\ny",2\r\n3,4\r\n');
    expect(r.rows[0]!.fields).toEqual(['x\r\ny', '2']);
    expect(r.rows[1]!.line).toBe(4);
  });

  it('strips a leading BOM from the text and trims header names', () => {
    expect(ok('﻿ name , domain\n1,2').header).toEqual(['name', 'domain']);
  });

  it('skips blank lines but keeps later line numbers', () => {
    const r = ok('\n\nname\n\nAcme\n\n');
    expect(r.headerLine).toBe(3);
    expect(r.rows).toEqual([{ line: 5, fields: ['Acme'] }]);
  });

  it('reports ragged rows and keeps reading', () => {
    const r = ok('a,b\n1\n1,2,3\n4,5\n');
    expect(r.rows).toEqual([{ line: 4, fields: ['4', '5'] }]);
    expect(r.malformed).toEqual([
      { line: 2, problem: 'field_count' },
      { line: 3, problem: 'field_count' },
    ]);
  });

  it('reports a stray quote and text after a closing quote', () => {
    const r = ok('a,b\nab"c,1\n"x"y,2\nok,3\n');
    expect(r.malformed).toEqual([
      { line: 2, problem: 'stray_quote' },
      { line: 3, problem: 'text_after_quote' },
    ]);
    expect(r.rows).toEqual([{ line: 4, fields: ['ok', '3'] }]);
  });

  it('reports an unterminated quote at the end of the file', () => {
    const r = ok('a,b\n1,2\n"open,3\n');
    expect(r.rows).toHaveLength(1);
    expect(r.malformed).toEqual([{ line: 3, problem: 'unterminated_quote' }]);
  });

  it('refuses empty files, bad headers and too many columns', () => {
    expect(readCsv('')).toEqual({ ok: false, error: 'empty' });
    expect(readCsv('\n\r\n').ok).toBe(false);
    expect(readCsv('"a,b\n')).toEqual({ ok: false, error: 'malformed_header' });
    expect(readCsv(`${Array.from({ length: MAX_COLUMNS + 1 }, (_, i) => `c${i}`).join(',')}\n`)).toEqual({
      ok: false,
      error: 'too_many_columns',
    });
  });
});

describe('csvField / lineCount', () => {
  it('quotes only when needed', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
  });

  it('counts physical lines across CRLF, LF and CR', () => {
    expect(lineCount(['a', 'b'])).toBe(1);
    expect(lineCount(['a\r\nb', 'c\nd\re'])).toBe(4);
  });
});

/*
 * Parity with the server reader: these are the fixtures of `readCsv` in
 * packages/market/src/sources/providers/company-directory.test.ts. Keep them in step.
 */
describe('readCsv parity with the server reader', () => {
  it('quotes, escaped quotes, CRLF, a BOM and newlines inside quotes; blank lines are no records', () => {
    const r = ok('\ufeffa,b\r\n"x, y","he said ""hi"""\r\n\r\n"multi\nline",2\n');
    expect(r.header).toEqual(['a', 'b']);
    expect(r.rows).toEqual([
      { line: 2, fields: ['x, y', 'he said "hi"'] },
      { line: 4, fields: ['multi\nline', '2'] },
    ]);
    expect(r.malformed).toEqual([]);
  });

  it('wrong field count, text after a closing quote and an unterminated quote are listed, never read', () => {
    const r = ok('a,b\n1,2,3\n"x"y,2\nok,1\n"open,2\n');
    expect(r.rows).toEqual([{ line: 4, fields: ['ok', '1'] }]);
    expect(r.malformed.map((m) => m.line)).toEqual([2, 3, 5]);
  });

  it('a quote inside an unquoted field (a"b) or after leading spaces ( "x") is malformed', () => {
    for (const text of ['h\na"b\n', 'h,i\n "x",1\n']) {
      const r = ok(text);
      expect(r.rows).toEqual([]);
      expect(r.malformed).toEqual([{ line: 2, problem: 'stray_quote' }]);
    }
    expect(ok('h\n"a""b"\n').rows).toEqual([{ line: 2, fields: ['a"b'] }]);
  });

  it('a malformed header and too many header columns refuse the file', () => {
    expect(readCsv('Com"pany,Domain\nA,b.com\n')).toEqual({ ok: false, error: 'malformed_header' });
    expect(readCsv(`${Array.from({ length: MAX_COLUMNS + 1 }, (_, k) => `c${k}`).join(',')}\n`)).toEqual({
      ok: false,
      error: 'too_many_columns',
    });
  });

  it('a wide row is one field_count problem', () => {
    expect(ok(`a,b\n${','.repeat(1000)}\n`).malformed).toEqual([{ line: 2, problem: 'field_count' }]);
  });

  it('counts records, not lines', () => {
    expect(ok('h1,h2\n"a\nb",c\nd,e\n').rows.map((x) => x.line)).toEqual([2, 4]);
  });

  it('keeps reading after a stray quote, so a quoted line break later in that row stays in it', () => {
    const r = ok('name,note\nAcme,1\nBe"ta,"two\nlines"\nAsana,2\n');
    expect(r.malformed).toEqual([{ line: 3, problem: 'stray_quote' }]);
    expect(r.rows).toEqual([
      { line: 2, fields: ['Acme', '1'] },
      { line: 5, fields: ['Asana', '2'] },
    ]);
  });

  it('a line of only spaces is blank, as on the server', () => {
    expect(ok('a,b\n   \n1,2\n').rows).toEqual([{ line: 3, fields: ['1', '2'] }]);
  });
});
