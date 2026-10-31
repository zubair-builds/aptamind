import type { Db, Document } from 'mongodb';
import { defineCollection, ensureCollections, type CollectionSpec } from '@aptamind/db';
import {
  apiTokenDocSchema,
  DEFAULT_WORKSPACE_ID,
  IDENTITY_SCHEMA_VERSION,
  membershipDocSchema,
  userDocSchema,
  workspaceDocSchema,
} from './schemas';

/** Prefixed so they never collide with Better Auth's own `user`/`session`/`account` collections. */
export const IDENTITY_COLLECTIONS = {
  users: 'identity_users',
  workspaces: 'identity_workspaces',
  memberships: 'identity_memberships',
  apiTokens: 'identity_api_tokens',
} as const;

export const usersCollection = defineCollection({
  name: IDENTITY_COLLECTIONS.users,
  schema: userDocSchema,
  schemaVersion: IDENTITY_SCHEMA_VERSION,
  description: 'Aptamind users (status, role, permission overrides), linked to Better Auth by authUserId',
  indexes: [
    {
      key: { email: 1 },
      options: { name: 'email_unique', unique: true },
      rationale: 'One user per (lower-cased) email; pre-approval and sign-in look up by email',
    },
    {
      key: { authUserId: 1 },
      options: {
        name: 'auth_user_unique',
        unique: true,
        partialFilterExpression: { authUserId: { $type: 'string' } },
      },
      rationale: 'One Aptamind user per Better Auth user; absent until first sign-in',
    },
    {
      key: { workspaceId: 1, bootstrap: 1 },
      options: {
        name: 'bootstrap_admin_unique',
        unique: true,
        partialFilterExpression: { bootstrap: { $type: 'string' } },
      },
      rationale: 'ADMIN_EMAIL bootstrap creates at most one admin per workspace, even under races',
    },
    {
      key: { workspaceId: 1, role: 1, status: 1 },
      options: { name: 'workspace_role_status' },
      rationale: 'Active-admin count for the last-admin guard; user lists by status',
    },
  ],
});

export const workspacesCollection = defineCollection({
  name: IDENTITY_COLLECTIONS.workspaces,
  schema: workspaceDocSchema,
  schemaVersion: IDENTITY_SCHEMA_VERSION,
  description: 'Workspaces (one shared default workspace in v1, plan D5)',
  indexes: [],
});

export const membershipsCollection = defineCollection({
  name: IDENTITY_COLLECTIONS.memberships,
  schema: membershipDocSchema,
  schemaVersion: IDENTITY_SCHEMA_VERSION,
  description: 'User membership of a workspace',
  indexes: [
    {
      key: { userId: 1, workspaceId: 1 },
      options: { name: 'user_workspace_unique', unique: true },
      rationale: 'A user belongs to a workspace at most once',
    },
  ],
});

export const apiTokensCollection = defineCollection({
  name: IDENTITY_COLLECTIONS.apiTokens,
  schema: apiTokenDocSchema,
  schemaVersion: IDENTITY_SCHEMA_VERSION,
  description: 'Per-user API tokens (M-U6); hashed, scopes never exceed the user permissions',
  indexes: [
    {
      key: { hash: 1 },
      options: { name: 'hash_unique', unique: true },
      rationale: 'Token lookup by hash; no two tokens share a hash',
    },
    {
      key: { userId: 1, createdAt: -1 },
      options: { name: 'user_created' },
      rationale: 'List a user tokens in Settings',
    },
  ],
});

export const identityCollections = [
  usersCollection,
  workspacesCollection,
  membershipsCollection,
  apiTokensCollection,
] as unknown as CollectionSpec<Document>[];

/** Idempotent: creates collections, validators and indexes. Safe on every boot. */
export async function ensureIdentityCollections(db: Db): Promise<void> {
  await ensureCollections(db, identityCollections);
}

/** Idempotently seeds the single shared workspace (plan D5). */
export async function ensureDefaultWorkspace(db: Db, now: Date = new Date()): Promise<void> {
  await db.collection(IDENTITY_COLLECTIONS.workspaces).updateOne(
    { _id: DEFAULT_WORKSPACE_ID as never },
    {
      $setOnInsert: {
        schemaVersion: IDENTITY_SCHEMA_VERSION,
        name: 'Default workspace',
        isDefault: true,
        adminRev: 0,
        createdAt: now,
        updatedAt: now,
      },
    },
    { upsert: true },
  );
}
