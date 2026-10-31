import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { authEnabled, isAuthorized, isPublicPath } from '@/lib/basic-auth';

/**
 * Basic auth over every route, including `/api/*`, `/ready`, `/metrics` and `/artifacts/*`.
 * Server Components call the API in-process (lib/api.ts), so nothing loops back over the network.
 */
export async function middleware(request: NextRequest) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return NextResponse.next();
  if (isPublicPath(request.nextUrl.pathname, { authEnabled: authEnabled() })) return NextResponse.next();
  if (await isAuthorized(request.headers.get('authorization'), password)) return NextResponse.next();

  const isApi = request.nextUrl.pathname.startsWith('/api/');
  return new NextResponse(
    isApi
      ? JSON.stringify({ error: { code: 'unauthorized', message: 'Authentication required.' } })
      : 'Unauthorized',
    {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="Aptamind Admin", charset="UTF-8"',
        'content-type': isApi ? 'application/json' : 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  );
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
