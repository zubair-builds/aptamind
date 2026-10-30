import { describe, expect, it } from 'vitest';
import { looseNameKey, strictNameKey } from '../companies/normalize';
import {
  type CompanyLookup,
  type CompanySummary,
  isBareName,
  resolveCompanyCandidate,
} from './company-resolver';

function company(
  id: string,
  name: string,
  extra: Partial<CompanySummary> & { keys?: string[] } = {},
): CompanySummary & { keys: string[] } {
  return {
    id,
    displayName: name,
    strictKeys: [strictNameKey(name)],
    looseKey: looseNameKey(name),
    domain: extra.domain ?? null,
    hqCountry: extra.hqCountry ?? null,
    registeredTowns: extra.registeredTowns ?? [],
    keys: [
      `name:${strictNameKey(name)}`,
      ...(extra.domain ? [`domain:${extra.domain}`] : []),
      ...(extra.keys ?? []),
    ],
  };
}

function lookupOf(companies: Array<CompanySummary & { keys: string[] }>): CompanyLookup {
  return {
    byIdentityKey: async (k) => companies.find((c) => c.keys.includes(k)) ?? null,
    byStrictName: async (k) => companies.filter((c) => c.strictKeys.includes(k)),
    byLooseKey: async (k) => companies.filter((c) => c.looseKey === k),
    byFirstToken: async (t) => companies.filter((c) => c.looseKey.startsWith(t)),
  };
}

describe('company resolution', () => {
  const acme = company('cmp_acme', 'Acme Ltd', {
    domain: 'acme.com',
    registeredTowns: ['London'],
    keys: ['ext:uk_sponsor:acme ltd|london'],
  });
  const lookup = lookupOf([
    acme,
    company('cmp_acme_inc', 'Acme Analytics Inc'),
    company('cmp_zen', 'Zenith Robotics Ltd'),
  ]);

  it('matches on external id and domain with high confidence', async () => {
    expect(
      await resolveCompanyCandidate(
        { name: 'Whatever', externalIds: [{ namespace: 'uk_sponsor', id: 'acme ltd|london' }] },
        lookup,
      ),
    ).toMatchObject({
      kind: 'match',
      companyId: 'cmp_acme',
      method: 'external_id',
    });
    expect(
      await resolveCompanyCandidate({ name: 'ACME Group', domain: 'https://careers.acme.com' }, lookup),
    ).toMatchObject({
      kind: 'match',
      method: 'domain',
      confidence: 'high',
    });
  });

  it('matches legal-name variants (same company with aliases)', async () => {
    expect(await resolveCompanyCandidate({ name: 'ACME LIMITED', town: 'London' }, lookup)).toMatchObject({
      kind: 'match',
      companyId: 'cmp_acme',
      method: 'name_exact',
    });
    expect(await resolveCompanyCandidate({ name: 'Acme Ltd t/a Acme Coffee' }, lookup)).toMatchObject({
      kind: 'match',
      companyId: 'cmp_acme',
    });
  });

  it('sends same name with a conflicting domain to review instead of merging', async () => {
    const d = await resolveCompanyCandidate({ name: 'Acme Ltd', domain: 'acme-other.co.uk' }, lookup);
    expect(d).toMatchObject({ kind: 'review', severity: 'medium' });
  });

  it('does not auto-merge two similar but distinct companies', async () => {
    const d = await resolveCompanyCandidate({ name: 'Acme Analytics Ltd' }, lookup);
    expect(d.kind).toBe('review'); // same base name, different legal form
    const fuzzy = await resolveCompanyCandidate({ name: 'Zenith Robotic Ltd' }, lookup);
    expect(fuzzy).toMatchObject({
      kind: 'review',
      candidates: [expect.objectContaining({ id: 'cmp_zen', method: 'fuzzy' })],
    });
  });

  it('maps a brand name to a single legal entity with medium confidence', async () => {
    expect(await resolveCompanyCandidate({ name: 'Zenith Robotics' }, lookup)).toMatchObject({
      kind: 'match',
      companyId: 'cmp_zen',
      confidence: 'medium',
    });
  });

  it('reviews bare (non-legal) names in different towns', async () => {
    const l = lookupOf([company('cmp_js', 'Dr J Smith', { registeredTowns: ['Leeds'] })]);
    expect((await resolveCompanyCandidate({ name: 'Dr J Smith', town: 'Bristol' }, l)).kind).toBe('review');
    expect((await resolveCompanyCandidate({ name: 'Dr J Smith', town: 'Leeds' }, l)).kind).toBe('match');
  });

  it('sends a domain match with an unrelated name to review', async () => {
    const d = await resolveCompanyCandidate({ name: 'Gamma Health Limited', domain: 'acme.com' }, lookup);
    expect(d).toMatchObject({
      kind: 'review',
      candidates: [expect.objectContaining({ id: 'cmp_acme', method: 'domain' })],
    });
  });

  it('creates when nothing matches', async () => {
    expect(await resolveCompanyCandidate({ name: 'Quantum Bakery Ltd' }, lookup)).toMatchObject({
      kind: 'create',
    });
  });

  it('flags ids that point at different companies', async () => {
    const l = lookupOf([
      company('a', 'A Ltd', { keys: ['ext:x:1'] }),
      company('b', 'B Ltd', { keys: ['ext:y:2'] }),
    ]);
    const d = await resolveCompanyCandidate(
      {
        name: 'A Ltd',
        externalIds: [
          { namespace: 'x', id: '1' },
          { namespace: 'y', id: '2' },
        ],
      },
      l,
    );
    expect(d).toMatchObject({ kind: 'review', severity: 'high' });
  });

  describe('bare names from a directory never auto-resolve (B-M3)', () => {
    const l = lookupOf([
      company('cmp_smith', 'John Smith'),
      company('cmp_northwind', 'Northwind Freight Ltd', { domain: 'northwind.io' }),
    ]);

    it('a directory row is non-bare only with a register id or a company domain (re-verification #4)', () => {
      expect(isBareName({ name: 'John Smith', country: 'GB' })).toBe(true);
      // A legal form, a town or a country never lift bare status.
      expect(isBareName({ name: 'John Smith Ltd' })).toBe(true);
      expect(isBareName({ name: 'John Smith', town: 'Leeds', country: 'GB' })).toBe(true);
      expect(isBareName({ name: 'John Smith', domain: 'smith.co.uk' })).toBe(false);
      expect(isBareName({ name: 'John Smith', externalIds: [{ namespace: 'lei', id: 'X' }] })).toBe(false);
      // A platform domain is no company domain.
      expect(isBareName({ name: 'John Smith', domain: 'linkedin.com/in/jsmith' })).toBe(true);
    });

    it('an exact-name match becomes a review offering the company, never a match', async () => {
      const candidate = { name: 'John Smith', country: 'GB' };
      expect(await resolveCompanyCandidate(candidate, l)).toMatchObject({ kind: 'match' });
      const d = await resolveCompanyCandidate({ ...candidate, directoryRow: true }, l);
      expect(d).toMatchObject({
        kind: 'review',
        severity: 'low',
        candidates: [{ id: 'cmp_smith', label: 'John Smith', method: 'name_exact' }],
      });
    });

    it('a brand-to-legal-name match becomes a review too', async () => {
      const d = await resolveCompanyCandidate({ name: 'Northwind Freight', directoryRow: true }, l);
      expect(d).toMatchObject({
        kind: 'review',
        candidates: [{ id: 'cmp_northwind', method: 'brand_to_legal_name' }],
      });
    });

    it('no match is a review with no candidates, never a created company', async () => {
      const candidate = { name: 'Jane Doe', country: 'GB' };
      expect(await resolveCompanyCandidate(candidate, l)).toMatchObject({ kind: 'create' });
      expect(await resolveCompanyCandidate({ ...candidate, directoryRow: true }, l)).toMatchObject({
        kind: 'review',
        candidates: [],
      });
    });

    it('identifying evidence (a register id or a domain) resolves as usual; a legal form or town does not', async () => {
      expect(
        await resolveCompanyCandidate({ name: 'Jane Doe Ltd', country: 'GB', directoryRow: true }, l),
      ).toMatchObject({ kind: 'review' });
      expect(
        await resolveCompanyCandidate(
          {
            name: 'Jane Doe Ltd',
            country: 'GB',
            externalIds: [{ namespace: 'gb_companies_house', id: '04821937' }],
            directoryRow: true,
          },
          l,
        ),
      ).toMatchObject({ kind: 'create' });
      expect(
        await resolveCompanyCandidate(
          { name: 'Northwind Freight', domain: 'northwind.io', directoryRow: true },
          l,
        ),
      ).toMatchObject({ kind: 'match', companyId: 'cmp_northwind', method: 'domain' });
      for (const town of ['Leeds', 'UK', 'Nationwide', 'Remote'])
        expect(
          await resolveCompanyCandidate({ name: 'John Smith', town, country: 'GB', directoryRow: true }, l),
        ).toMatchObject({ kind: 'review' });
    });
  });

  describe('name-norm/2 lookups also match name-norm/1 keys (L1)', () => {
    // A company created before name-norm/2: its stored keys are v1 ("cafe ltd").
    const legacy: CompanySummary & { keys: string[] } = {
      id: 'cmp_cafe',
      displayName: 'Café 東京 Ltd',
      strictKeys: ['cafe ltd'],
      looseKey: 'cafe',
      domain: null,
      hqCountry: null,
      registeredTowns: [],
      keys: ['name:cafe ltd'],
    };
    const l = lookupOf([legacy]);

    it('an exact name matches the company by its stored v1 key (no duplicate is created)', async () => {
      expect(await resolveCompanyCandidate({ name: 'Café 東京 Ltd' }, l)).toMatchObject({
        kind: 'match',
        companyId: 'cmp_cafe',
        method: 'name_exact',
      });
    });

    it('a name that differs only in non-Latin letters is a review, never a match (v1 collapsed them)', async () => {
      expect(await resolveCompanyCandidate({ name: 'Café 大阪 Ltd' }, l)).toMatchObject({
        kind: 'review',
        candidates: [{ id: 'cmp_cafe', method: 'name_legacy_key' }],
      });
      expect(await resolveCompanyCandidate({ name: 'Café 大阪' }, l)).toMatchObject({ kind: 'review' });
    });

    it('a brand name matches by the stored v1 loose key', async () => {
      expect(await resolveCompanyCandidate({ name: 'Café 東京' }, l)).toMatchObject({
        kind: 'match',
        companyId: 'cmp_cafe',
      });
    });
  });
});
