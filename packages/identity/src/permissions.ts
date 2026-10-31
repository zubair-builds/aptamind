import { PERMISSIONS, type Permission, type PermissionOverrides, type Role } from './schemas';

/** Defaults for the `user` role until an admin sets workspace user defaults (M-U4). */
export const DEFAULT_USER_PERMISSIONS: readonly Permission[] = ['market.view', 'market.jobs.view'];

export interface PermissionSubject {
  role: Role;
  permissionOverrides: PermissionOverrides;
}

/** Effective = role defaults + grants − revokes; admin always has every permission. */
export function effectivePermissions(
  subject: PermissionSubject,
  userDefaults: readonly Permission[] = DEFAULT_USER_PERMISSIONS,
): Set<Permission> {
  if (subject.role === 'admin') return new Set(PERMISSIONS);
  const out = new Set<Permission>([...userDefaults, ...subject.permissionOverrides.grant]);
  for (const p of subject.permissionOverrides.revoke) out.delete(p);
  return out;
}

export function hasPermission(
  subject: PermissionSubject,
  permission: Permission,
  userDefaults?: readonly Permission[],
): boolean {
  return effectivePermissions(subject, userDefaults).has(permission);
}

/** Token scopes are clipped to what the user can do (plan D4). */
export function clipScopes(
  requested: readonly Permission[],
  subject: PermissionSubject,
  userDefaults?: readonly Permission[],
): Permission[] {
  const allowed = effectivePermissions(subject, userDefaults);
  return [...new Set(requested)].filter((p) => allowed.has(p));
}
