import { describe, expect, it } from 'vitest';
import { clipScopes, effectivePermissions, hasPermission } from './permissions';
import { IdentityError, normaliseEmail, PERMISSIONS } from './schemas';
import { wouldRemoveLastAdmin } from './users.service';

const none = { grant: [], revoke: [] };

describe('permissions', () => {
  it('admin has every permission regardless of overrides', () => {
    const p = effectivePermissions({
      role: 'admin',
      permissionOverrides: { grant: [], revoke: ['users.manage'] },
    });
    expect([...p].sort()).toEqual([...PERMISSIONS].sort());
  });
  it('user = defaults + grants - revokes', () => {
    const p = effectivePermissions({
      role: 'user',
      permissionOverrides: { grant: ['professional.view'], revoke: ['market.jobs.view'] },
    });
    expect([...p].sort()).toEqual(['market.view', 'professional.view']);
    expect(hasPermission({ role: 'user', permissionOverrides: none }, 'professional.view')).toBe(false);
    expect(hasPermission({ role: 'user', permissionOverrides: none }, 'users.manage', ['users.manage'])).toBe(
      true,
    );
  });
  it('revoke wins over grant', () => {
    const s = {
      role: 'user' as const,
      permissionOverrides: { grant: ['users.manage' as const], revoke: ['users.manage' as const] },
    };
    expect(hasPermission(s, 'users.manage')).toBe(false);
  });
  it('token scopes are clipped to user permissions', () => {
    expect(
      clipScopes(['market.view', 'users.manage', 'market.view'], { role: 'user', permissionOverrides: none }),
    ).toEqual(['market.view']);
  });
});

describe('last-admin rule', () => {
  const admin = { role: 'admin' as const, status: 'active' as const };
  it('blocks demoting or suspending the only active admin', () => {
    expect(wouldRemoveLastAdmin(admin, 1, { role: 'user' })).toBe(true);
    expect(wouldRemoveLastAdmin(admin, 1, { status: 'suspended' })).toBe(true);
  });
  it('allows it when another active admin remains, or for non-admins', () => {
    expect(wouldRemoveLastAdmin(admin, 2, { role: 'user' })).toBe(false);
    expect(wouldRemoveLastAdmin({ role: 'user', status: 'active' }, 1, { status: 'suspended' })).toBe(false);
    expect(wouldRemoveLastAdmin(admin, 1, { role: 'admin' })).toBe(false);
  });
});

describe('normaliseEmail', () => {
  it('trims and lower-cases', () => {
    expect(normaliseEmail('  Zubair@Example.COM ')).toBe('zubair@example.com');
  });
  it('rejects invalid emails', () => {
    expect(() => normaliseEmail('not-an-email')).toThrow(IdentityError);
    expect(() => normaliseEmail('a b@c.d')).toThrow(IdentityError);
  });
});
