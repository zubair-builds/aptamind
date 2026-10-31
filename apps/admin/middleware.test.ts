import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, middleware } from './middleware';

const req = (path: string, auth?: string) =>
  new NextRequest(`https://admin.test${path}`, auth ? { headers: { authorization: auth } } : undefined);
const ok = `Basic ${btoa('op:pw-123')}`;
const passes = (r: Response) => r.headers.get('x-middleware-next') === '1';

afterEach(() => vi.unstubAllEnvs());

describe('admin middleware', () => {
  it('protects /api/* with a JSON 401 and a Basic challenge', async () => {
    vi.stubEnv('ADMIN_PASSWORD', 'pw-123');
    const res = await middleware(req('/api/dashboard'));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Basic realm=/);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } });
    expect(passes(await middleware(req('/api/dashboard', ok)))).toBe(true);
    expect((await middleware(req('/api/dashboard', `Basic ${btoa('op:wrong')}`))).status).toBe(401);
  });
  it('protects pages, /ready, /metrics and artifacts but leaves /health public', async () => {
    vi.stubEnv('ADMIN_PASSWORD', 'pw-123');
    for (const p of ['/', '/jobs', '/ready', '/metrics', '/artifacts/a1'])
      expect((await middleware(req(p))).status).toBe(401);
    expect(passes(await middleware(req('/health')))).toBe(true);
  });
  it('is open when ADMIN_PASSWORD is unset (local dev)', async () => {
    vi.stubEnv('ADMIN_PASSWORD', '');
    expect(passes(await middleware(req('/api/dashboard')))).toBe(true);
  });
  it('matcher covers /api but skips Next static assets', () => {
    const re = new RegExp(`^${config.matcher[0]}$`);
    expect(re.test('/api/dashboard')).toBe(true);
    expect(re.test('/')).toBe(true);
    expect(re.test('/_next/static/chunk.js')).toBe(false);
    expect(re.test('/favicon.ico')).toBe(false);
  });
});
