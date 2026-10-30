import { describe, expect, it } from 'vitest';
import { CLAIM_TYPES, CLAIM_VALUE_SCHEMAS } from '../contracts/claims';
import {
  ALL_COMPATIBILITY_RULES,
  ATTRIBUTE_SPECS,
  compareValues,
  materialAttributes,
  mergeValues,
  normalizeText,
  normalizeTitleKey,
  organizationKey,
} from './compatibility';

const ctx = { rules: ALL_COMPATIBILITY_RULES };

describe('attribute specs', () => {
  it('cover every claim type, and every attribute field exists in the value schema', () => {
    for (const t of CLAIM_TYPES) {
      const specs = ATTRIBUTE_SPECS[t];
      expect(specs.length, t).toBeGreaterThan(0);
      const shape = (CLAIM_VALUE_SCHEMAS[t] as unknown as { shape: Record<string, unknown> }).shape;
      const keys = Object.keys(shape);
      for (const s of specs) {
        const top = s.fields ?? [(s.path ?? [s.name])[0] as string];
        for (const f of top) expect(keys, `${t}.${f}`).toContain(f);
      }
      // Every value field is covered by some attribute (nothing is silently ignored).
      const covered = new Set(specs.flatMap((s) => s.fields ?? [(s.path ?? [s.name])[0] as string]));
      for (const k of keys) expect([...covered], `${t}.${k}`).toContain(k);
      expect(new Set(specs.map((s) => s.name)).size, t).toBe(specs.length);
    }
  });

  it('pins materiality v1 of composite attributes (§7.2)', () => {
    expect(
      materialAttributes('experience.role', [
        'organization',
        'title',
        'start',
        'end',
        'employmentType',
        'location',
      ]),
    ).toEqual(['organization', 'title', 'start', 'end']);
    expect(materialAttributes('certification', ['url', 'issued'])).toEqual(['issued']);
  });
});

describe('normalization', () => {
  it('normalizes text for comparison', () => {
    expect(normalizeText('  Data Engineer — Streaming  ')).toBe('data engineer streaming');
    expect(normalizeText('B.Sc. Computer Science')).toBe('bsc computer science');
    expect(normalizeText('München')).toBe(normalizeText('Munchen'));
  });

  it('expands title abbreviations and seniority spellings', () => {
    expect(normalizeTitleKey('sr.-software-eng.')).toBe('senior software engineer');
    expect(normalizeTitleKey('vp-engineering')).toBe('vice president engineering');
    expect(normalizeTitleKey('software-engineer-ii')).toBe('software engineer ii');
  });

  it('strips legal forms (never down to nothing) and a leading "the"', () => {
    expect(organizationKey('Fabrikam Ltd', true)).toBe('fabrikam');
    expect(organizationKey('fabrikam-limited', true)).toBe('fabrikam');
    expect(organizationKey('The Contoso Company', true)).toBe('contoso');
    expect(organizationKey('Acme Pvt. Ltd.', true)).toBe('acme');
    expect(organizationKey('Limited', true)).toBe('limited');
    expect(organizationKey('Fabrikam Ltd', false)).toBe('fabrikam ltd');
  });
});

describe('compareValues / mergeValues', () => {
  it('is per attribute: a title disagreement never makes the dates conflict', () => {
    const base = {
      organization: { name: 'Northwind', key: 'northwind' },
      title: 'Engineer',
      titleKey: 'engineer',
      start: { year: 2019 },
      end: { year: 2021 },
    };
    const r = compareValues(
      'experience.role',
      base,
      { ...base, title: 'Manager', titleKey: 'manager', start: { year: 2019, month: 2 } },
      ctx,
    );
    expect(r).toEqual({
      compatible: false,
      conflicting: ['title'],
      aMorePrecise: false,
      bMorePrecise: false,
    });
  });

  it('merges compatible values to the most precise one, attribute by attribute', () => {
    const merged = mergeValues(
      'location.current',
      [
        { city: 'Munich', country: 'DE' },
        { region: 'Bavaria', country: 'DE' },
      ],
      ctx,
    );
    expect(merged).toEqual({ city: 'Munich', region: 'Bavaria', country: 'DE' });
    const project = mergeValues(
      'project',
      [
        { name: 'Planner', technologies: ['Go'], period: { start: { year: 2020 } } },
        { name: 'Planner', technologies: ['Go', 'Redis'], period: { start: { year: 2020, month: 4 } } },
      ],
      ctx,
    );
    expect(project).toEqual({
      name: 'Planner',
      technologies: ['Go', 'Redis'],
      period: { start: { year: 2020, month: 4 } },
    });
  });

  it('does not mutate its inputs', () => {
    const a = { city: 'Munich', country: 'DE' };
    const b = { region: 'Bavaria', country: 'DE' };
    mergeValues('location.current', [a, b], ctx);
    expect(a).toEqual({ city: 'Munich', country: 'DE' });
  });
});
