import { createPlatform, type Platform } from '@aptamind/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app';
import { apiStartup, handleApiRequest, resetApiStartupForTests } from './handler';

vi.mock('@aptamind/platform', () => ({
  createPlatform: vi.fn(),
}));

vi.mock('./app', () => ({
  buildApp: vi.fn(),
}));

type BuiltApp = Awaited<ReturnType<typeof buildApp>>;

function fakePlatform() {
  return {
    init: vi.fn(),
    close: vi.fn(),
    logger: { error: vi.fn() },
  };
}

function asPlatform(platform: ReturnType<typeof fakePlatform>): Platform {
  return platform as unknown as Platform;
}

function fakeApp() {
  return {
    inject: vi.fn(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'text/plain' },
      payload: 'ok',
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function call(path = '/api/health', search = '') {
  return handleApiRequest(new Request(`https://admin.test${path}${search}`), path);
}

describe('admin API startup gate', () => {
  let app: ReturnType<typeof fakeApp>;
  let consoleError: ReturnType<typeof vi.spyOn>;
  let consoleWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetApiStartupForTests();
    app = fakeApp();
    vi.mocked(createPlatform).mockReset();
    vi.mocked(buildApp).mockReset();
    vi.mocked(buildApp).mockResolvedValue(app as unknown as BuiltApp);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    consoleWarn.mockRestore();
    vi.useRealTimers();
  });

  it('does not cache a rejected createPlatform and fails fast inside the cooldown', async () => {
    const err = new Error('mongo down');
    vi.mocked(createPlatform).mockRejectedValue(err);

    await expect(call()).rejects.toBe(err);
    expect(createPlatform).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);

    await expect(call()).rejects.toBe(err);
    expect(createPlatform).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(buildApp).not.toHaveBeenCalled();
    expect(app.inject).not.toHaveBeenCalled();
  });

  it('shares one retry across overlapping callers after the cooldown', async () => {
    const err = new Error('mongo down');
    vi.mocked(createPlatform).mockRejectedValueOnce(err);
    await expect(call()).rejects.toBe(err);
    expect(createPlatform).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(apiStartup.cooldownMs);

    const platform = fakePlatform();
    const gate = deferred<Platform>();
    vi.mocked(createPlatform).mockReturnValue(gate.promise);

    const first = call('/api/one');
    const second = call('/api/two');
    expect(createPlatform).toHaveBeenCalledTimes(2);
    const third = call('/api/three');
    expect(createPlatform).toHaveBeenCalledTimes(2);
    expect(buildApp).not.toHaveBeenCalled();

    gate.resolve(asPlatform(platform));
    const responses = await Promise.all([first, second, third]);

    expect(platform.init).toHaveBeenCalledTimes(1);
    expect(buildApp).toHaveBeenCalledTimes(1);
    expect(app.inject).toHaveBeenCalledTimes(3);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('ok');
    }
  });

  it('closes the platform when init fails and does not surface a close error', async () => {
    const initErr = new Error('init failed');
    const closeErr = new Error('close failed');
    const platform = fakePlatform();
    platform.init.mockRejectedValue(initErr);
    platform.close.mockRejectedValue(closeErr);
    vi.mocked(createPlatform).mockResolvedValue(asPlatform(platform));

    await expect(call()).rejects.toBe(initErr);
    expect(platform.close).toHaveBeenCalledTimes(1);
    expect(buildApp).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(platform.logger.error).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();

    vi.advanceTimersByTime(apiStartup.cooldownMs);
    const retry = fakePlatform();
    vi.mocked(createPlatform).mockResolvedValue(asPlatform(retry));

    expect((await call()).status).toBe(200);
    expect(createPlatform).toHaveBeenCalledTimes(2);
    expect(retry.init).toHaveBeenCalledTimes(1);
    expect(buildApp).toHaveBeenCalledTimes(1);
  });

  it('closes the platform when buildApp fails, then caches a successful retry', async () => {
    const err = new Error('build failed');
    const first = fakePlatform();
    vi.mocked(createPlatform).mockResolvedValue(asPlatform(first));
    vi.mocked(buildApp).mockRejectedValueOnce(err);

    await expect(call()).rejects.toBe(err);
    expect(first.init).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(buildApp).toHaveBeenCalledTimes(1);
    expect(first.logger.error).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(apiStartup.cooldownMs);
    const second = fakePlatform();
    vi.mocked(createPlatform).mockResolvedValue(asPlatform(second));
    vi.mocked(buildApp).mockResolvedValue(app as unknown as BuiltApp);

    expect((await call()).status).toBe(200);
    expect(createPlatform).toHaveBeenCalledTimes(2);
    expect(second.init).toHaveBeenCalledTimes(1);
    expect(second.close).not.toHaveBeenCalled();
    expect(buildApp).toHaveBeenCalledTimes(2);

    expect((await call()).status).toBe(200);
    expect((await call('/api/later')).status).toBe(200);
    expect(createPlatform).toHaveBeenCalledTimes(2);
    expect(second.init).toHaveBeenCalledTimes(1);
    expect(buildApp).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalledTimes(1);
  });

  it('shares one successful startup and maps inject onto the Response', async () => {
    const platform = fakePlatform();
    const gate = deferred<Platform>();
    vi.mocked(createPlatform).mockReturnValue(gate.promise);

    const first = call('/api/a');
    const second = call('/api/b', '?x=1');
    expect(createPlatform).toHaveBeenCalledTimes(1);
    expect(createPlatform).toHaveBeenCalledWith('api');

    gate.resolve(asPlatform(platform));
    const [a, b] = await Promise.all([first, second]);

    expect(platform.init).toHaveBeenCalledTimes(1);
    expect(buildApp).toHaveBeenCalledTimes(1);
    expect(app.inject).toHaveBeenCalledTimes(2);
    expect(app.inject).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', url: '/api/a', payload: undefined }),
    );
    expect(app.inject).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', url: '/api/b?x=1' }));

    expect(a.status).toBe(200);
    expect(a.headers.get('content-type')).toBe('text/plain');
    expect(await a.text()).toBe('ok');
    expect(b.status).toBe(200);
    expect(b.headers.get('content-type')).toBe('text/plain');
    expect(await b.text()).toBe('ok');
    expect(platform.close).not.toHaveBeenCalled();
  });

  it('does not log or close again during the cooldown', async () => {
    const err = new Error('init failed');
    const platform = fakePlatform();
    platform.init.mockRejectedValue(err);
    vi.mocked(createPlatform).mockResolvedValue(asPlatform(platform));

    await expect(call()).rejects.toBe(err);
    expect(platform.close).toHaveBeenCalledTimes(1);
    expect(platform.logger.error).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();

    await expect(call()).rejects.toBe(err);
    await expect(call()).rejects.toBe(err);
    expect(createPlatform).toHaveBeenCalledTimes(1);
    expect(platform.close).toHaveBeenCalledTimes(1);
    expect(platform.logger.error).toHaveBeenCalledTimes(1);
    expect(platform.init).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(buildApp).not.toHaveBeenCalled();
  });

  it('rejects just before retryAt and starts a retry at exactly the cooldown', async () => {
    const err = new Error('redis down');
    vi.mocked(createPlatform).mockRejectedValue(err);
    await expect(call()).rejects.toBe(err);
    expect(createPlatform).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(apiStartup.cooldownMs - 1);
    await expect(call()).rejects.toBe(err);
    expect(createPlatform).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await expect(call()).rejects.toBe(err);
    expect(createPlatform).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledTimes(2);
  });

  it('still surfaces the init error and arms the cooldown when logger.error throws', async () => {
    const initErr = new Error('init failed');
    const platform = fakePlatform();
    platform.init.mockRejectedValue(initErr);
    platform.logger.error.mockImplementation(() => {
      throw new Error('logger down');
    });
    vi.mocked(createPlatform).mockResolvedValue(asPlatform(platform));

    await expect(call()).rejects.toBe(initErr);
    expect(platform.close).toHaveBeenCalledTimes(1);
    expect(platform.logger.error).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(createPlatform).toHaveBeenCalledTimes(1);

    await expect(call()).rejects.toBe(initErr);
    expect(createPlatform).toHaveBeenCalledTimes(1);
    expect(platform.close).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it('does not start another platform while close is still pending', async () => {
    const initErr = new Error('init failed');
    const platform = fakePlatform();
    platform.init.mockRejectedValue(initErr);
    const closeGate = deferred<void>();
    platform.close.mockReturnValue(closeGate.promise);
    vi.mocked(createPlatform).mockResolvedValue(asPlatform(platform));

    const first = call();
    for (let i = 0; i < 50 && platform.close.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    expect(platform.close).toHaveBeenCalledTimes(1);
    expect(createPlatform).toHaveBeenCalledTimes(1);

    const second = call();
    expect(createPlatform).toHaveBeenCalledTimes(1);
    expect(platform.logger.error).not.toHaveBeenCalled();

    closeGate.resolve();
    await expect(first).rejects.toBe(initErr);
    await expect(second).rejects.toBe(initErr);
    expect(platform.logger.error).toHaveBeenCalledTimes(1);
    expect(consoleWarn).not.toHaveBeenCalled();

    await expect(call()).rejects.toBe(initErr);
    expect(createPlatform).toHaveBeenCalledTimes(1);
  });

  it('does not cache a synchronous createPlatform throw and retries after the cooldown', async () => {
    const err = new Error('sync throw');
    vi.mocked(createPlatform).mockImplementation(() => {
      throw err;
    });

    await expect(call()).rejects.toBe(err);
    expect(createPlatform).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(buildApp).not.toHaveBeenCalled();

    await expect(call()).rejects.toBe(err);
    expect(createPlatform).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(apiStartup.cooldownMs);
    await expect(call()).rejects.toBe(err);
    expect(createPlatform).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledTimes(2);
  });

  it('times out a hanging platform.close and retries after the cooldown', async () => {
    const initErr = new Error('init failed');
    const platform = fakePlatform();
    platform.init.mockRejectedValue(initErr);
    platform.close.mockImplementation(() => new Promise<void>(() => {}));
    vi.mocked(createPlatform).mockResolvedValueOnce(asPlatform(platform));

    const first = call();
    // Attach the rejection handler before the clock jumps. The close timeout rejects `first`
    // inside `advanceTimersByTimeAsync`; listening afterwards is an unhandled rejection.
    const rejected = expect(first).rejects.toBe(initErr);
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(platform.logger.error).toHaveBeenCalledTimes(1);
    expect(createPlatform).toHaveBeenCalledTimes(1);

    await expect(call()).rejects.toBe(initErr);
    expect(createPlatform).toHaveBeenCalledTimes(1);

    const retry = fakePlatform();
    vi.mocked(createPlatform).mockResolvedValue(asPlatform(retry));
    await vi.advanceTimersByTimeAsync(apiStartup.cooldownMs);
    expect((await call()).status).toBe(200);
    expect(createPlatform).toHaveBeenCalledTimes(2);
    expect(retry.init).toHaveBeenCalledTimes(1);
    expect(retry.close).not.toHaveBeenCalled();
  });

  it('surfaces the startup error when platform.close throws synchronously', async () => {
    const initErr = new Error('init failed');
    const platform = fakePlatform();
    platform.init.mockRejectedValue(initErr);
    platform.close.mockImplementation(() => {
      throw new Error('close exploded');
    });
    vi.mocked(createPlatform).mockResolvedValue(asPlatform(platform));

    await expect(call()).rejects.toBe(initErr);
    expect(platform.close).toHaveBeenCalledTimes(1);
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(platform.logger.error).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();

    await expect(call()).rejects.toBe(initErr);
    expect(createPlatform).toHaveBeenCalledTimes(1);
    expect(platform.close).toHaveBeenCalledTimes(1);
    expect(consoleWarn).toHaveBeenCalledTimes(1);
  });
});
