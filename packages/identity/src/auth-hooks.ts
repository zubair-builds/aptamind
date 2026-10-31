import type { SignInResult, UsersService } from './users.service';

/**
 * Bridges Better Auth to Aptamind identity (ADR-0022). Kept free of Better Auth imports so it
 * can be tested with a mocked Google profile and a real UsersService.
 *
 * - user created (first Google sign-in): resolve the Aptamind user — unverified email → refused,
 *   pre-approved → active, unknown → pending_approval, `ADMIN_EMAIL` → first admin when none exists.
 * - session create (every sign-in): only an `active` Aptamind user gets a session. When no
 *   identity is linked yet (the create hook failed, or the email was pre-approved after the first
 *   sign-in) the auth profile is resolved again, so the account can recover instead of being
 *   locked out permanently.
 */
export interface AuthProfile {
  id: string;
  email: string;
  name?: string | null;
  emailVerified: boolean;
}

export function createAuthHooks(users: () => Promise<UsersService>) {
  const resolve = async (profile: AuthProfile): Promise<SignInResult> =>
    (await users()).resolveSignIn({
      authUserId: profile.id,
      email: profile.email,
      displayName: profile.name ?? undefined,
      emailVerified: profile.emailVerified === true,
    });
  return {
    onUserCreated: resolve,
    /**
     * `false` blocks the session (Better Auth `databaseHooks.session.create.before`).
     * `loadProfile` returns the Better Auth user for `authUserId`, used to recover an unlinked account.
     */
    async allowSession(
      authUserId: string,
      loadProfile?: () => Promise<AuthProfile | null>,
    ): Promise<boolean> {
      const user = await (await users()).findByAuthUserId(authUserId);
      if (user) return user.status === 'active';
      const profile = loadProfile ? await loadProfile() : null;
      if (!profile || profile.id !== authUserId) return false;
      return (await resolve(profile)).outcome === 'active';
    },
  };
}
