import { afterEach, describe, expect, it, vi } from 'vitest';

const handle = vi.hoisted(() => vi.fn());
vi.mock('./api-server/handler', () => ({ handleApiRequest: handle }));
const { apiRequest } = await import('./api');
import { getApiHealth } from './health';

afterEach(() => {
  handle.mockReset();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('apiRequest (in-process, regression for the false "API unavailable")', () => {
  it('never fetches over the network and dispatches to the API handler in-process', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network must not be used')));
    vi.stubGlobal('fetch', fetchSpy);
    handle.mockResolvedValue(json(200, { total: 3 }));
    const res = await apiRequest<{ total: number }>('/api/review', { query: { status: 'open', limit: 1 } });
    expect(res).toEqual({ ok: true, status: 200, data: { total: 3 } });
    expect(fetchSpy).not.toHaveBeenCalled();
    const [request, path] = handle.mock.calls[0] as [Request, string];
    expect(path).toBe('/api/review');
    expect(new URL(request.url).search).toBe('?status=open&limit=1');
  });
  it('reports ready health from /ready without any auth header', async () => {
    handle.mockResolvedValue(json(200, { status: 'ready', checks: { mongo: true } }));
    expect((await getApiHealth()).state).toBe('ready');
  });
  it('maps a 503 to not_ready and a thrown/timeout handler to unavailable', async () => {
    handle.mockResolvedValueOnce(json(503, { error: { code: 'not_ready', message: 'x', details: { checks: { mongo: false } } } }));
    const r = await apiRequest('/ready');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('http');
    handle.mockImplementationOnce(() => new Promise(() => {}));
    const t = await apiRequest('/ready', { timeoutMs: 20 });
    expect(!t.ok && t.error.kind).toBe('unavailable');
  });
});
