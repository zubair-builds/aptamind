import { handleApiRequest } from '@/lib/api-server/handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function proxy(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  return handleApiRequest(req, `/api/${path.map(encodeURIComponent).join('/')}`);
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
