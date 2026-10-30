import type { SafeHttpClient, SafeRequest, SafeResponse } from '@aptamind/net';
import { NET_CLIENT } from '@aptamind/workflow-nodes';
import type { ServiceRegistry } from '@aptamind/workflow-sdk';
import { isLoopbackHost } from './test-egress-guard';

/**
 * A client for tests whose workflows may fetch the public web (careers discovery after an
 * import): every non-loopback request gets a 404 without touching the network, and its URL is
 * recorded. Loopback requests (fixture servers) go to the real client.
 */
export function offlineHttp(real: SafeHttpClient): { http: SafeHttpClient; requests: string[] } {
  const requests: string[] = [];
  const http = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop !== 'request') return Reflect.get(target, prop, receiver) as unknown;
      return async (req: SafeRequest): Promise<SafeResponse> => {
        if (isLoopbackHost(new URL(req.url).hostname)) return target.request(req);
        requests.push(req.url);
        return {
          url: req.url,
          requestedUrl: req.url,
          status: 404,
          ok: false,
          headers: { 'content-type': 'text/plain' },
          contentType: 'text/plain',
          body: new TextEncoder().encode('offline test client'),
          redirects: [],
          fetchedAt: new Date(),
          durationMs: 1,
        };
      };
    },
  });
  return { http, requests };
}

/** Register `offlineHttp` as the runtime's network client; returns the recorded URLs. */
export function installOfflineHttp(runtime: { http: SafeHttpClient; services: ServiceRegistry }): string[] {
  const { http, requests } = offlineHttp(runtime.http);
  runtime.services.register(NET_CLIENT, http);
  return requests;
}
