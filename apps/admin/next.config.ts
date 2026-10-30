import type { NextConfig } from 'next';

/**
 * Internal admin UI and same-origin API. No auth (out of scope).
 * No remote fonts/assets: the build must succeed offline.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: { root: new URL('../..', import.meta.url).pathname },
  experimental: {
    // Snapshot uploads are forwarded through the API gateway (which accepts up to 200 MB).
    serverActions: { bodySizeLimit: '200mb' },
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
};

export default nextConfig;
