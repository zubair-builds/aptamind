import { describe, expect, it } from 'vitest';
import { problemsOf, problemText } from './import-problems';

describe('problemText', () => {
  it('turns known codes into plain words and names the column', () => {
    expect(problemText({ code: 'unmapped_column', column: 'Owner email' })).toBe(
      'The file has a column that is not mapped. ("Owner email")',
    );
    expect(problemText({ code: 'missing_column', column: 'column 2' }, ['Name', 'Domain'])).toBe(
      'A mapped column is missing from the file. ("Domain")',
    );
    expect(problemText({ code: 'missing_column', column: 'column 9' }, ['Name'])).toMatch(/\(column 9\)$/);
    expect(
      problemText({ code: 'personal_data_column', message: '1 mapped column names personal data' }),
    ).toMatch(/Don’t import" for it\. 1 mapped column names personal data$/);
    expect(problemText({ code: 'not_utf8' })).toMatch(/not UTF-8/);
  });

  it('falls back to the server message, then the code', () => {
    expect(problemText({ code: 'new_code', message: 'Server says no' })).toBe('Server says no');
    expect(problemText({ code: 'new_code' })).toBe('new_code');
  });
});

describe('problemsOf', () => {
  it('reads well-formed problems and drops the rest', () => {
    expect(
      problemsOf({
        problems: [
          { code: 'missing_column', column: 'Name' },
          { column: 'x' },
          'junk',
          { code: 'too_large', column: 3 },
        ],
      }),
    ).toEqual([{ code: 'missing_column', column: 'Name' }, { code: 'too_large' }]);
    expect(problemsOf(null)).toEqual([]);
    expect(problemsOf({ problems: 'nope' })).toEqual([]);
  });
});
