/**
 * Next configuration for the Rasta user portal.
 *
 * Deliberately small. Two things here are load-bearing rather than taste:
 *
 *  - `transpilePackages` for `@rasta/contracts`, because the shared Zod
 *    schemas are a workspace package and the app must use *those* definitions
 *    rather than a second copy that can drift from the services (docs/16 § 16.1).
 *  - the response headers, which are the client half of the security posture in
 *    docs/16 § 16.11. The gateway sets its own; a browser page needs its own set.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@rasta/contracts'],
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
