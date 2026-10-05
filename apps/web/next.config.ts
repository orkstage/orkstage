import type { NextConfig } from 'next';

/**
 * The browser only ever talks to this origin: `/api/*` is proxied to the control API so the
 * session cookie stays same-origin (httpOnly, SameSite=Lax) and no token touches client code.
 * API_INTERNAL_URL is the API origin (no path), e.g. http://api:4000 inside a cluster.
 */
const apiOrigin = (process.env.API_INTERNAL_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
