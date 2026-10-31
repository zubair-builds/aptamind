import type { SignInResult, UsersService } from './users.service';

/**
 * Bridges Better Auth to Aptamind identity (ADR-0022). Kept free of Better Auth imports so it
 * can be tested with a mocked Google profile and a real UsersService.
 *
 * - user created (first Google sign-in): resolve the Aptamind user — pre-approved → active,
 *   unknown → pending_approval, `ADMIN_EMAIL` → first admin when none exists.
 * - session create: only an `active` Aptamind user gets a session; pending, suspended and
 *   unlinked accounts are refused.
 */
export interface AuthProfile {
  id: string;
  email: string;
  name?: string | null;
}

export function createAuthHooks(users: () => Promise<UsersService>) {
  return {
    async onUserCreated(profile: AuthProfile): Promise<SignInResult> {
      return (await users()).resolveSignIn({
        authUserId: profile.id,
        email: profile.email,
        displayName: profile.name ?? undefined,
      });
    },
    /** `false` blocks the session (Better Auth `databaseHooks.session.create.before`). */
    async allowSession(authUserId: string): Promise<boolean> {
      const user = await (await users()).findByAuthUserId(authUserId);
      return user?.status === 'active';
    },
  };
}
