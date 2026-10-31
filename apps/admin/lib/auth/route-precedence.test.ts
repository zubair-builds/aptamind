import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as authRoute from '../../app/api/auth/[...all]/route';

const appDir = path.resolve(import.meta.dirname, '../../app/api');

afterEach(() => vi.unstubAllEnvs());

describe('/api/auth route (ADR-0022)', () => {
  it('is a static `auth` segment beside the `[...path]` catch-all, so Next routes it first', () => {
    expect(existsSync(path.join(appDir, 'auth/[...all]/route.ts'))).toBe(true);
    expect(existsSync(path.join(appDir, '[...path]/route.ts'))).toBe(true);
  });
  it('answers 404 without loading Better Auth when AUTH_ENABLED is off', async () => {
    vi.stubEnv('AUTH_ENABLED', 'false');
    const res = await authRoute.GET(new Request('https://admin.test/api/auth/get-session'));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
    expect((await authRoute.POST(new Request('https://admin.test/api/auth/sign-in/social'))).status).toBe(
      404,
    );
  });
});
