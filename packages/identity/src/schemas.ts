import { z } from 'zod';

/**
 * Aptamind identity records (ADR-0022). Better Auth owns its own collections (user, session,
 * account, verification); these are ours and link to Better Auth's user by `authUserId`.
 */
export const ROLES = ['admin', 'user'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const USER_STATUSES = ['pre_approved', 'pending_approval', 'active', 'suspended'] as const;
export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

/** Area/feature permissions (plan D9). Admin always has every permission. */
export const PERMISSIONS = [
  'market.view',
  'market.jobs.view',
  'market.sources.manage',
  'market.imports.create',
  'professional.view',
  'users.manage',
  'settings.manage',
  'tokens.manage',
] as const;
export const permissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof permissionSchema>;

export const permissionOverridesSchema = z.object({
  grant: z.array(permissionSchema),
  revoke: z.array(permissionSchema),
});
export type PermissionOverrides = z.infer<typeof permissionOverridesSchema>;

export const IDENTITY_SCHEMA_VERSION = 1;

export const userDocSchema = z.object({
  _id: z.string(),
  schemaVersion: z.number().int(),
  /** Always lower-cased and trimmed (`normaliseEmail`). */
  email: z.string().min(3),
  /** Better Auth `user` id; absent until the first Google sign-in. */
  authUserId: z.string().optional(),
  workspaceId: z.string(),
  role: roleSchema,
  status: userStatusSchema,
  displayName: z.string().optional(),
  permissionOverrides: permissionOverridesSchema,
  /** Set only on the `ADMIN_EMAIL` bootstrap admin; a unique index allows one per workspace. */
  bootstrap: z.literal('first_admin').optional(),
  approvedBy: z.string().optional(),
  approvedAt: z.date().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type UserDoc = z.infer<typeof userDocSchema>;

export const workspaceDocSchema = z.object({
  _id: z.string(),
  schemaVersion: z.number().int(),
  name: z.string(),
  isDefault: z.boolean(),
  /** Bumped on every admin-set change; serialises concurrent last-admin checks. */
  adminRev: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type WorkspaceDoc = z.infer<typeof workspaceDocSchema>;

export const membershipDocSchema = z.object({
  _id: z.string(),
  schemaVersion: z.number().int(),
  userId: z.string(),
  workspaceId: z.string(),
  role: roleSchema,
  createdAt: z.date(),
});
export type MembershipDoc = z.infer<typeof membershipDocSchema>;

export const apiTokenDocSchema = z.object({
  _id: z.string(),
  schemaVersion: z.number().int(),
  userId: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  /** SHA-256 of the token; the plaintext is shown once and never stored. */
  hash: z.string(),
  scopes: z.array(permissionSchema),
  createdAt: z.date(),
  lastUsedAt: z.date().optional(),
  revokedAt: z.date().optional(),
});
export type ApiTokenDoc = z.infer<typeof apiTokenDocSchema>;

export const DEFAULT_WORKSPACE_ID = 'ws_default';

export function normaliseEmail(email: string): string {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new IdentityError('invalid_email', 'Invalid email');
  return e;
}

export type IdentityErrorCode =
  'invalid_email' | 'not_found' | 'last_admin' | 'already_exists' | 'invalid_transition';

export class IdentityError extends Error {
  constructor(
    readonly code: IdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}
