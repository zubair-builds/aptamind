import { describe, expect, it } from 'vitest';
import { titleTokens } from './title-tokens';

describe('titleTokens', () => {
  it('lower-cases, strips diacritics and splits on punctuation', () => {
    expect(titleTokens('Senior Backend Engineer (Remote)')).toEqual([
      'senior',
      'backend',
      'engineer',
      'remote',
    ]);
    expect(titleTokens('Développeur Full-Stack')).toEqual(['developpeur', 'full', 'stack']);
    expect(titleTokens('Data Engineer / Data Analyst')).toEqual(['data', 'engineer', 'analyst']);
  });

  it('keeps single characters, stop words and language names with symbols', () => {
    expect(titleTokens('Head of IT')).toEqual(['head', 'of', 'it']);
    expect(titleTokens('C++ / C# Developer')).toEqual(['c++', 'c#', 'developer']);
    expect(titleTokens('C Programmer')).toEqual(['c', 'programmer']);
    expect(titleTokens('.NET Engineer')).toEqual(['.net', 'net', 'engineer']);
    expect(titleTokens('Node.js Developer')).toEqual(['node', 'js', 'developer']);
  });

  it('is empty for no title and bounded', () => {
    expect(titleTokens(null)).toEqual([]);
    expect(titleTokens(Array.from({ length: 100 }, (_, i) => `w${i}`).join(' '))).toHaveLength(64);
  });
});
