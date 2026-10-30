import { describe, expect, it } from 'vitest';
import {
  type HistoryCompany,
  type HistoryLookup,
  resolveHistoryAttachment,
  subdivisionCode,
} from './history-attachment';

const acmeCa: HistoryCompany = {
  id: 'cmp_acme',
  label: 'Acme Analytics Inc',
  ownNameKeys: ['acme analytics inc'],
  aliasKeys: [],
  states: ['CA'],
};

function lookup(companies: HistoryCompany[], looseKeys: string[] = []): HistoryLookup {
  return {
    byNameKey: async (k) => companies.filter((c) => c.ownNameKeys.includes(k) || c.aliasKeys.includes(k)),
    hasLooseKey: async (k) => looseKeys.includes(k),
  };
}

const row = (name: string, state: string | null) => ({ name, state, country: 'US' });
const R = 'us_uscis_h1b_employer_data_hub';

describe('attach-only history resolution (never creates a company)', () => {
  it('attaches on the exact own name plus a known location in the state', async () => {
    const d = await resolveHistoryAttachment(row('ACME ANALYTICS INC', 'CA'), lookup([acmeCa]), R);
    expect(d).toMatchObject({ kind: 'match', companyId: 'cmp_acme', method: 'name_exact_state' });
  });

  it('reviews an exact own name whose state is not known to agree', async () => {
    const d = await resolveHistoryAttachment(row('ACME ANALYTICS INC', 'NY'), lookup([acmeCa]), R);
    expect(d).toMatchObject({ kind: 'review', severity: 'medium' });
    const noState = await resolveHistoryAttachment(
      row('ACME ANALYTICS INC', 'CA'),
      lookup([{ ...acmeCa, states: [] }]),
      R,
    );
    expect(noState).toMatchObject({ kind: 'review', severity: 'medium' });
  });

  it('reviews several same-name companies, even when one is in the state', async () => {
    const other = { ...acmeCa, id: 'cmp_other', states: ['TX'] };
    expect(
      await resolveHistoryAttachment(row('Acme Analytics Inc', 'CA'), lookup([acmeCa, other]), R),
    ).toMatchObject({
      kind: 'review',
      severity: 'medium',
    });
    const both = { ...other, states: ['CA'] };
    expect(
      await resolveHistoryAttachment(row('Acme Analytics Inc', 'CA'), lookup([acmeCa, both]), R),
    ).toMatchObject({
      kind: 'review',
      severity: 'high',
    });
  });

  it('reviews an alias-only match, and never matches a legal-form variant or a missing name', async () => {
    const aliasOnly = { ...acmeCa, ownNameKeys: ['acme holdings ltd'], aliasKeys: ['acme analytics inc'] };
    expect(
      await resolveHistoryAttachment(row('ACME ANALYTICS INC', 'CA'), lookup([aliasOnly]), R),
    ).toMatchObject({
      kind: 'review',
      severity: 'low',
    });
    expect(
      await resolveHistoryAttachment(
        row('ACME ANALYTICS LLC', 'CA'),
        lookup([acmeCa], ['acme analytics']),
        R,
      ),
    ).toEqual({ kind: 'unmatched', reason: 'legal_form_variant' });
    expect(await resolveHistoryAttachment(row('UNKNOWN WIDGETS LLC', 'WA'), lookup([acmeCa]), R)).toEqual({
      kind: 'unmatched',
      reason: 'no_exact_name',
    });
    // An unknown state fails closed.
    expect(await resolveHistoryAttachment(row('ACME ANALYTICS INC', null), lookup([acmeCa]), R)).toEqual({
      kind: 'unmatched',
      reason: 'no_state',
    });
  });

  it('dedupes reviews per register, employer and state (one item across fiscal years)', async () => {
    const a = await resolveHistoryAttachment(row('ACME ANALYTICS INC', 'NY'), lookup([acmeCa]), R);
    expect(a.kind === 'review' && a.dedupeKey).toBe(`history_attachment:${R}:acme analytics inc|NY`);
  });

  it('normalises subdivision codes and names; unknown stays unknown', () => {
    expect(subdivisionCode('US', 'California')).toBe('CA');
    expect(subdivisionCode('US', ' tx ')).toBe('TX');
    expect(subdivisionCode('US', 'Greater London')).toBeNull();
    expect(subdivisionCode('US', null)).toBeNull();
  });
});
