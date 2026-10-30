import { describe, expect, it } from 'vitest';
import { normalizeLocations } from './locations';
import { findWorkModelStatements, interpretWorkModel, workModelFromLabel } from './work-model';
import type { WorkModelInput } from './work-model';

function run(description: string, extra: Partial<WorkModelInput> = {}) {
  const locationTexts = extra.locationTexts ?? [];
  return interpretWorkModel({
    title: extra.title ?? 'Engineer',
    description,
    locationTexts,
    locations: normalizeLocations(locationTexts),
    providerWorkplaceType: extra.providerWorkplaceType ?? null,
  });
}

describe('findWorkModelStatements', () => {
  it('extracts office days for hybrid roles', () => {
    const [s] = findWorkModelStatements("You'll be in our London office 3 days a week.");
    expect(s).toMatchObject({ model: 'hybrid', strength: 3, daysPerWeek: 3 });
    expect(findWorkModelStatements('Three days per week in the office.')[0]).toMatchObject({
      daysPerWeek: 3,
    });
    expect(findWorkModelStatements('We ask everyone to be in-office 2 days per week.')[0]).toMatchObject({
      daysPerWeek: 2,
    });
  });

  it('treats five office days as onsite', () => {
    expect(findWorkModelStatements('This role requires 5 days a week in the office.')[0]).toMatchObject({
      model: 'onsite',
    });
  });

  it('recognises negated remote', () => {
    expect(findWorkModelStatements('Please note this is not a remote role.')[0]).toMatchObject({
      model: 'onsite',
      rule: 'not_remote',
    });
  });

  it('reads partly-remote weeks as hybrid', () => {
    expect(findWorkModelStatements('You can work from home two days a week.')[0]).toMatchObject({
      model: 'hybrid',
    });
  });
});

describe('interpretWorkModel', () => {
  it('lets an explicit role statement override provider and labels, at reduced confidence and for review', () => {
    const r = run('This role is fully on-site at our Austin lab.', {
      providerWorkplaceType: 'remote',
      locationTexts: ['Remote'],
    });
    // Two agreeing structured sources contradict it: kept, but not trusted fully (audit H-2).
    expect(r.workModel).toMatchObject({
      value: 'onsite',
      confidence: 'medium',
      basis: 'description.explicit',
    });
    expect(r.flags.map((f) => f.code)).toEqual(
      expect.arrayContaining(['work_model_structured_conflict', 'work_model_overridden']),
    );
    expect(r.flags.find((f) => f.code === 'work_model_structured_conflict')?.severity).toBe('high');
    expect(r.officeAttendance.value.required).toBe(true);
  });

  it('keeps high confidence when only one structured source disagrees', () => {
    const r = run('This role is fully on-site at our Austin lab.', { providerWorkplaceType: 'remote' });
    expect(r.workModel).toMatchObject({ value: 'onsite', confidence: 'high', basis: 'description.explicit' });
  });

  describe('subject, preference and anti-fit context (audit H-2)', () => {
    const structuredRemote = {
      providerWorkplaceType: 'remote' as const,
      locationTexts: ['Remote - US', 'Remote - Canada'],
    };
    it.each([
      ['You prefer an in-person role over remote (Ashby operates remotely).', structuredRemote, 'remote'],
      [
        'You might not be a fit if:\n- You prefer an in-person role over remote (Ashby operates remotely).',
        structuredRemote,
        'remote',
      ],
      ['You prefer onsite work; this role is remote.', {}, 'remote'],
      ['Candidates who want fully remote work should not apply; role is hybrid.', {}, 'hybrid'],
      ['Although the company is remote-first, this role is onsite.', {}, 'onsite'],
      ['This role is not remote.', {}, 'onsite'],
      ['This role is not remote. Hybrid working is available.', {}, 'hybrid'],
    ])('%s → %s', (text, opts, expected) => {
      expect(run(text, opts).workModel.value).toBe(expected);
    });

    it('classifies whose work model a phrase is about', () => {
      const stances = (text: string) => findWorkModelStatements(text).map((st) => `${st.rule}:${st.stance}`);
      expect(stances('You prefer an in-person role over remote (Ashby operates remotely).')).toEqual([
        'onsite_role:preference',
        'remote_company_operates:company',
      ]);
      expect(stances('Candidates who want fully remote work should not apply.')).toEqual([
        'remote_direct:anti_fit',
      ]);
      expect(stances('We are remote-first.')).toEqual(['remote_company:company']);
      expect(stances('This role is remote.')).toEqual(['remote_role:role']);
    });

    it('never lets a preference statement decide the work model', () => {
      const r = run('If you prefer to work fully remote, you would enjoy our culture.', {});
      expect(r.workModel.value).toBe('unclear');
    });

    it('lowers confidence and flags for review when an anti-fit statement contradicts the decision', () => {
      const r = run('Candidates who want fully remote work should not apply.', structuredRemote);
      expect(r.workModel).toMatchObject({ value: 'remote', confidence: 'low' });
      expect(r.flags.find((f) => f.code === 'work_model_anti_signal')?.severity).toBe('high');
    });
  });

  it('uses provider workplaceType when the description is silent', () => {
    const r = run('Build great things.', {
      providerWorkplaceType: 'hybrid',
      locationTexts: ['Hybrid - Berlin'],
    });
    expect(r.workModel).toMatchObject({
      value: 'hybrid',
      confidence: 'high',
      basis: 'provider.workplaceType',
    });
    expect(r.officeAttendance.value).toEqual({
      required: true,
      daysPerWeek: null,
      officeLocations: ['Berlin'],
    });
  });

  it('falls back to location labels and title decorations', () => {
    expect(run('', { locationTexts: ['Remote - US'] }).workModel).toMatchObject({
      value: 'remote',
      basis: 'location.label',
    });
    expect(run('', { title: 'Engineer (Remote)' }).workModel).toMatchObject({
      value: 'remote',
      basis: 'title.label',
    });
  });

  it('keeps a city-only location unclear', () => {
    const r = run('Build great things.', { locationTexts: ['London, UK'] });
    expect(r.workModel).toEqual({ value: 'unclear', confidence: 'unknown', evidence: [], basis: 'none' });
    expect(r.officeAttendance.value).toEqual({ required: null, daysPerWeek: null, officeLocations: [] });
  });

  it('flags conflicting explicit statements as unclear', () => {
    const r = run('This role is fully remote. This role is fully on-site.');
    expect(r.workModel.value).toBe('unclear');
    expect(r.flags.map((f) => f.code)).toContain('work_model_conflict');
  });

  it('uses weak company-level wording only as a low-confidence last resort', () => {
    const r = run('We are a remote-first company.');
    expect(r.workModel).toMatchObject({ value: 'remote', confidence: 'low', basis: 'description.weak' });
  });

  it('records hybrid days and remote non-attendance', () => {
    const hybrid = run('This is a hybrid role with 2 days per week in the office.', {
      locationTexts: ['Leeds, UK'],
    });
    expect(hybrid.officeAttendance.value).toEqual({
      required: true,
      daysPerWeek: 2,
      officeLocations: ['Leeds'],
    });
    const remote = run('This is a fully remote position.');
    expect(remote.officeAttendance.value).toEqual({
      required: false,
      daysPerWeek: null,
      officeLocations: [],
    });
  });
});

describe('workModelFromLabel', () => {
  it('maps labels', () => {
    expect(workModelFromLabel('Hybrid - Berlin')).toBe('hybrid');
    expect(workModelFromLabel('London (On-site)')).toBe('onsite');
    expect(workModelFromLabel('Anywhere')).toBe('remote');
    expect(workModelFromLabel('Paris')).toBeNull();
  });
});
