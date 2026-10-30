import { createPlatform, type Platform } from '@aptamind/platform';
import { buildApp } from './app';

let platformPromise: Promise<Platform> | undefined;
let appPromise: ReturnType<typeof createApiApp> | undefined;

async function createApiApp() {
  const platform = await getPlatform();
  await platform.init();
  return buildApp(platform);
}

function getPlatform(): Promise<Platform> {
  platformPromise ??= createPlatform('api');
  return platformPromise;
}

function getApp() {
  appPromise ??= createApiApp();
  return appPromise;
}

export async function handleApiRequest(request: Request, path: string): Promise<Response> {
  const app = await getApp();
  const url = new URL(request.url);
  const headers = Object.fromEntries(request.headers.entries());
  const payload =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : Buffer.from(await request.arrayBuffer());
  const response = (await app.inject({
    method: request.method as 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: `${path}${url.search}`,
    headers,
    payload,
  })) as unknown as {
    statusCode: number;
    headers: Record<string, string | number | undefined>;
    payload: string;
    rawPayload?: Uint8Array;
  };
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value !== undefined) responseHeaders.set(name, String(value));
  }
  return new Response((response.rawPayload ?? response.payload) as BodyInit, {
    status: response.statusCode,
    headers: responseHeaders,
  });
}
