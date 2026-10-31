import { describe, expect, it } from 'vitest';
import type { ImportCounts } from '@/lib/types';
import { countLabels, countsSummary, importTypeLabel, traceSourcesLabel } from './labels';

const counts = (c: Partial<ImportCounts>): ImportCounts => ({
  rows: null,
  parsed: null,
  accepted: null,
  created: null,
  updated: null,
  unchanged: null,
  ignored: null,
  failed: null,
  reviews: null,
  ...c,
});

describe('countsSummary', () => {
  it('lists known counts and leaves out zeros after rows', () => {
    expect(countsSummary(counts({ rows: 1204, created: 1100, updated: 0, failed: 3, reviews: 1 }))).toBe(
      '1,204 rows · 1,100 created · 3 failed · 1 review',
    );
    expect(countsSummary(counts({ rows: 1 }))).toBe('1 row');
    expect(countsSummary(counts({ rows: 0 }))).toBe('0 rows');
  });

  it('includes warnings when sent, and words ATS board imports as boards registered', () => {
    expect(countsSummary(counts({ rows: 5, created: 4, warnings: 2 }))).toBe(
      '5 rows · 4 created · 2 with warnings',
    );
    expect(countsSummary(counts({ rows: 5, created: 4 }), 'ats_boards')).toBe('5 rows · 4 boards registered');
    expect(countsSummary(counts({ rows: 5, created: 4 }), 'jobs')).toBe('5 rows · 4 boards registered');
  });

  it('is empty when nothing is known', () => {
    expect(countsSummary(counts({}))).toBe('');
    expect(countsSummary(null)).toBe('');
  });
});

describe('importTypeLabel', () => {
  it('falls back to the raw type', () => {
    expect(importTypeLabel('companies')).toBe('Companies');
    expect(importTypeLabel('jobs')).toBe('Job links');
    expect(importTypeLabel('later_type')).toBe('later_type');
  });
});

describe('countLabels', () => {
  it('renames Created and the trace sources for ATS boards only', () => {
    const label = (type: string) => countLabels(type).find(([k]) => k === 'created')![1];
    expect(label('companies')).toBe('Created');
    expect(label('ats_boards')).toBe('Boards registered');
    expect(label('jobs')).toBe('Boards registered');
    expect(traceSourcesLabel('ats_boards')).toBe('Sources linked');
    expect(traceSourcesLabel('jobs')).toBe('Sources linked');
    expect(traceSourcesLabel('companies')).toBe('Sources registered');
  });
});
