import { describe, expect, it } from 'vitest';
import { FIELD_CLASSES } from '../contracts/sections';
import { canRevive, type RevivalInput, revivalGuard } from './revival';
import { allowedTransition, ASSERTION_STATES } from './transitions';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const base: RevivalInput = {
  state: 'SUPERSEDED',
  fieldClass: 'current_state',
  supersessionCause: 'newer_state',
  itemActive: true,
  supersededAtAsOf: d('2024-01-01'),
  newSupportAsOf: d('2025-01-01'),
};

describe('canRevive (SUPERSEDED → PROPOSED conditions)', () => {
  it('A → B → A: a strictly newer current_state support revives the older value', () => {
    expect(canRevive(base)).toEqual({ revive: true });
    expect(allowedTransition('SUPERSEDED', 'PROPOSED', 'automation')).toBe(true);
  });

  it('(a) historical and set_member values never revive', () => {
    for (const fieldClass of FIELD_CLASSES.filter((c) => c !== 'current_state'))
      expect(canRevive({ ...base, fieldClass })).toEqual({ revive: false, reason: 'not_current_state' });
  });

  it('(a) merge-superseded assertions and assertions on inactive items never revive', () => {
    expect(canRevive({ ...base, supersessionCause: 'merge' })).toEqual({ revive: false, reason: 'merged' });
    expect(canRevive({ ...base, itemActive: false })).toEqual({ revive: false, reason: 'item_inactive' });
  });

  it('(b) replaying an older or equally old snapshot never revives', () => {
    expect(canRevive({ ...base, newSupportAsOf: d('2023-06-01') })).toEqual({
      revive: false,
      reason: 'not_newer',
    });
    expect(canRevive({ ...base, newSupportAsOf: d('2024-01-01') })).toEqual({
      revive: false,
      reason: 'not_newer',
    });
  });

  it('(b) after a subject supersession the threshold is the captured validTo', () => {
    const subject: RevivalInput = {
      ...base,
      supersessionCause: 'subject',
      supersededAtAsOf: d('2024-06-01'),
    };
    expect(
      canRevive({ ...subject, newSupportAsOf: d('2024-07-01'), newDeclaredSupportAsOf: d('2024-07-01') }),
    ).toEqual({ revive: true });
    expect(
      canRevive({ ...subject, newSupportAsOf: d('2024-05-01'), newDeclaredSupportAsOf: d('2024-05-01') }),
    ).toEqual({ revive: false, reason: 'not_newer' });
    expect(canRevive({ ...subject, supersededAtAsOf: undefined })).toEqual({
      revive: false,
      reason: 'no_chronology',
    });
  });

  it("(b') after a subject supersession an undated document (acquisition time only) never revives", () => {
    const subject: RevivalInput = {
      ...base,
      supersessionCause: 'subject',
      supersededAtAsOf: d('2024-06-01'),
    };
    // Uploaded after mark_outdated, but its date is only the acquisition time.
    expect(canRevive({ ...subject, newSupportAsOf: d('2024-07-01') })).toEqual({
      revive: false,
      reason: 'undeclared_date',
    });
    // A declared date that is not later than validTo does not count either.
    expect(
      canRevive({ ...subject, newSupportAsOf: d('2024-07-01'), newDeclaredSupportAsOf: d('2024-03-01') }),
    ).toEqual({ revive: false, reason: 'undeclared_date' });
    // Automation supersession accepts acquisition-time chronology.
    expect(canRevive({ ...base, newDeclaredSupportAsOf: undefined })).toEqual({ revive: true });
  });

  it('(b*) an automation supersession that no longer holds makes the value a candidate regardless of dates', () => {
    const withdrawn = { ...base, supersessionInvalid: true, newSupportAsOf: d('2020-01-01') };
    expect(canRevive(withdrawn)).toEqual({ revive: true });
    expect(canRevive({ ...withdrawn, supersessionCause: 'confirmed_rival' })).toEqual({ revive: true });
    expect(canRevive({ ...withdrawn, supersededAtAsOf: undefined })).toEqual({ revive: true });
    // Never after a subject supersession, never for merges, inactive items or other field classes.
    expect(canRevive({ ...withdrawn, supersessionCause: 'subject' })).toEqual({
      revive: false,
      reason: 'not_newer',
    });
    expect(canRevive({ ...withdrawn, supersessionCause: 'merge' })).toEqual({
      revive: false,
      reason: 'merged',
    });
    expect(canRevive({ ...withdrawn, itemActive: false })).toEqual({
      revive: false,
      reason: 'item_inactive',
    });
    expect(canRevive({ ...withdrawn, fieldClass: 'historical' })).toEqual({
      revive: false,
      reason: 'not_current_state',
    });
  });

  it('without the superseding chronology nothing revives', () => {
    expect(canRevive({ ...base, supersededAtAsOf: undefined })).toEqual({
      revive: false,
      reason: 'no_chronology',
    });
  });

  it('only SUPERSEDED assertions are candidates', () => {
    for (const state of ASSERTION_STATES.filter((s) => s !== 'SUPERSEDED'))
      expect(canRevive({ ...base, state })).toEqual({ revive: false, reason: 'not_superseded' });
  });
});

describe('revivalGuard', () => {
  it('returns the automation write filter only when canRevive allows the revival', () => {
    expect(revivalGuard(base)).toEqual({
      revive: true,
      guard: { state: { $eq: 'SUPERSEDED', $nin: ['CONFIRMED', 'REJECTED'] } },
    });
    expect(revivalGuard({ ...base, fieldClass: 'historical' })).toEqual({
      revive: false,
      reason: 'not_current_state',
    });
    expect(revivalGuard({ ...base, newSupportAsOf: d('2023-01-01') })).toEqual({
      revive: false,
      reason: 'not_newer',
    });
  });
});
