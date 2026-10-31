/**
 * Next.js startup hook. With `AUTH_ENABLED` on, the server refuses to start unless the auth env
 * (Better Auth secret/URL, Google client, MONGODB_URI) is complete — fail closed (ADR-0022).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { assertAuthConfigAtStartup } = await import('@aptamind/identity/auth-config');
  assertAuthConfigAtStartup(process.env);
}
