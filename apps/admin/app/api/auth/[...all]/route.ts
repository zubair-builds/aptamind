import { authEnabled } from '@/lib/basic-auth';

/**
 * Better Auth endpoints (ADR-0022). This static `auth` segment takes precedence over the
 * `app/api/[...path]` catch-all, so auth requests never reach the internal API. With
 * `AUTH_ENABLED` off it answers 404 and Better Auth is never loaded.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const notFound = () =>
  new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } }), {
    status: 404,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

async function handle(req: Request): Promise<Response> {
  if (!authEnabled()) return notFound();
  const { getAuth } = await import('@aptamind/identity/better-auth');
  return (await getAuth()).handler(req);
}

export const GET = handle;
export const POST = handle;
