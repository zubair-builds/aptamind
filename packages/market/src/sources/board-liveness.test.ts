import { describe, expect, it, vi } from 'vitest';
import type { ArtifactRef } from '@aptamind/contracts';
import type { SafeRequest } from '@aptamind/net';
import { probeBoardLiveness } from './board-liveness';

type Reply = { status: number; body?: string; retryAfterMs?: number } | { error: string; retryable: boolean };

function client(replies: Reply[]) {
  const urls: string[] = [];
  const request = vi.fn(async (req: SafeRequest) => {
    urls.push(req.url);
    const r = replies.shift();
    if (!r) throw new Error('no more replies');
    if ('error' in r) throw Object.assign(new Error(r.error), { retryable: r.retryable, retryAfterMs: 0 });
    return {
      url: req.url,
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      body: new TextEncoder().encode(r.body ?? ''),
      contentType: 'application/json',
      // Zero keeps the one retry instant in tests.
      retryAfterMs: r.retryAfterMs ?? 0,
    };
  });
  const putArtifact = vi.fn(
    async (body: Uint8Array): Promise<ArtifactRef> =>
      ({ artifactId: 'art_1', size: body.length }) as unknown as ArtifactRef,
  );
  return { deps: { http: { request } as never, putArtifact }, request, putArtifact, urls };
}

const GH = {
  provider: 'greenhouse' as const,
  boardToken: 'acme',
  apiBase: 'https://boards-api.greenhouse.io/v1/boards',
};

describe('probeBoardLiveness', () => {
  it('is live on HTTP 200 with a listing that parses, even with no jobs, and stores the bytes', async () => {
    const c = client([{ status: 200, body: '{"jobs":[]}' }]);
    const r = await probeBoardLiveness(c.deps, GH);
    expect(r).toMatchObject({ state: 'live', jobs: 0, httpStatus: 200, artifact: { artifactId: 'art_1' } });
    expect(c.urls).toEqual(['https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true']);
    expect(c.putArtifact).toHaveBeenCalledOnce();
  });

  it.each([
    ['lever', '[]'],
    ['ashby', '{"jobs":[]}'],
  ] as const)('reads an empty %s listing as live', async (provider, body) => {
    const c = client([{ status: 200, body }]);
    const apiBase =
      provider === 'lever'
        ? 'https://api.lever.co/v0/postings'
        : 'https://api.ashbyhq.com/posting-api/job-board';
    expect(await probeBoardLiveness(c.deps, { provider, boardToken: 'acme', apiBase })).toMatchObject({
      state: 'live',
      jobs: 0,
    });
  });

  it.each([404, 410])('is not live on HTTP %i, without a retry', async (status) => {
    const c = client([{ status }]);
    expect(await probeBoardLiveness(c.deps, GH)).toMatchObject({ state: 'not_live' });
    expect(c.request).toHaveBeenCalledOnce();
    expect(c.putArtifact).not.toHaveBeenCalled();
  });

  it('is not live when the JSON is not a listing', async () => {
    const c = client([{ status: 200, body: '{"error":"not found"}' }]);
    expect(await probeBoardLiveness(c.deps, GH)).toMatchObject({ state: 'not_live' });
    expect(c.putArtifact).not.toHaveBeenCalled();
  });

  it('reads a 200 HTML error page as unreachable (often temporary), after one retry', async () => {
    const c = client([
      { status: 200, body: '<html>maintenance</html>' },
      { status: 200, body: '<html>maintenance</html>' },
    ]);
    expect(await probeBoardLiveness(c.deps, GH)).toMatchObject({ state: 'unreachable' });
    expect(c.request).toHaveBeenCalledTimes(2);
    expect(c.putArtifact).not.toHaveBeenCalled();
  });

  it("scopes every hop to the provider's API hosts", async () => {
    const c = client([{ status: 200, body: '{"jobs":[]}' }]);
    await probeBoardLiveness(c.deps, GH);
    expect(c.request.mock.calls[0]![0].scope).toEqual({
      allowedHosts: ['boards-api.greenhouse.io', 'boards-api.eu.greenhouse.io'],
      allowSubdomains: false,
    });
  });

  it('reads a redirect off the API hosts as unreachable, never live', async () => {
    const c = client([
      { error: 'Redirect to https://evil.example/x leaves the allowed scope', retryable: false },
    ]);
    expect(await probeBoardLiveness(c.deps, GH)).toMatchObject({
      state: 'unreachable',
      reason: expect.stringContaining('leaves the allowed scope'),
    });
    expect(c.request).toHaveBeenCalledTimes(1);
    expect(c.putArtifact).not.toHaveBeenCalled();
  });

  it.each([429, 500, 503])('retries HTTP %i once, then reports unreachable', async (status) => {
    const c = client([{ status }, { status }]);
    expect(await probeBoardLiveness(c.deps, GH)).toMatchObject({ state: 'unreachable' });
    expect(c.request).toHaveBeenCalledTimes(2);
  });

  it('is live when the retry succeeds', async () => {
    const c = client([{ status: 503 }, { status: 200, body: '{"jobs":[]}' }]);
    expect(await probeBoardLiveness(c.deps, GH)).toMatchObject({ state: 'live' });
  });

  it('retries a retryable client error (timeout) once', async () => {
    const c = client([
      { error: 'timeout', retryable: true },
      { error: 'timeout', retryable: true },
    ]);
    expect(await probeBoardLiveness(c.deps, GH)).toEqual({ state: 'unreachable', reason: 'timeout' });
    expect(c.request).toHaveBeenCalledTimes(2);
  });

  it('does not retry a refused request or an unexpected status', async () => {
    const refused = client([{ error: 'host not allowed', retryable: false }]);
    expect(await probeBoardLiveness(refused.deps, GH)).toMatchObject({ state: 'unreachable' });
    expect(refused.request).toHaveBeenCalledOnce();
    const forbidden = client([{ status: 403 }]);
    expect(await probeBoardLiveness(forbidden.deps, GH)).toMatchObject({ state: 'unreachable' });
    expect(forbidden.request).toHaveBeenCalledOnce();
  });

  it('rethrows when the run is cancelled', async () => {
    const ac = new AbortController();
    const c = client([]);
    c.request.mockImplementationOnce(async () => {
      ac.abort(new Error('cancelled'));
      throw new Error('aborted');
    });
    await expect(probeBoardLiveness({ ...c.deps, signal: ac.signal }, GH)).rejects.toThrow('cancelled');
  });
});
