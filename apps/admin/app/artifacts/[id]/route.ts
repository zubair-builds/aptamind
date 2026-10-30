import { API_BASE_URL } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Proxy for raw artifact content. Artifacts are third-party bytes (HTML, CSV, JSON...), so
 * they are ALWAYS returned as text/plain with nosniff and a locked-down CSP: the browser
 * shows the source text and never renders or executes it.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const preview = url.searchParams.get('preview');
  const qs = preview && /^\d{1,7}$/.test(preview) ? `?preview=${preview}` : '';
  const safeHeaders = {
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  };
  let upstream: Response;
  try {
    upstream = await fetch(`${API_BASE_URL}/api/artifacts/${encodeURIComponent(id)}/content${qs}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    return new Response(
      `API unavailable at ${API_BASE_URL}: ${err instanceof Error ? err.message : String(err)}\n`,
      {
        status: 502,
        headers: safeHeaders,
      },
    );
  }
  if (!upstream.ok) {
    const text = await upstream.text();
    return new Response(`Artifact ${id}: upstream HTTP ${upstream.status}\n\n${text}`, {
      status: upstream.status,
      headers: safeHeaders,
    });
  }
  const mime = upstream.headers.get('x-artifact-mime-type') ?? 'application/octet-stream';
  const textual = (upstream.headers.get('content-type') ?? '').startsWith('text/plain');
  const headers: Record<string, string> = { ...safeHeaders, 'x-artifact-mime-type': mime };
  // Binary artifacts are still served as text/plain, but offered as a download.
  if (!textual)
    headers['content-disposition'] = `attachment; filename="${id.replace(/[^A-Za-z0-9_.-]/g, '_')}.bin"`;
  return new Response(upstream.body, { status: 200, headers });
}
