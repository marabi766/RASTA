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

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Loads the repository-root `.env`, public variables only.
 *
 * Every service in this monorepo reads `../../.env` (see any service's `dev`
 * script), and `CLAUDE.md` tells a developer to run `cp .env.example .env`
 * once, at the root. Next only looks inside its own project directory, so
 * without this the portal would need a second copy of the same four values and
 * would drift from the gateway and realm the rest of the stack is using.
 *
 * **Only `NEXT_PUBLIC_` keys are copied.** Everything under that prefix is
 * public by definition and ends up in the browser bundle; everything else in
 * that file is a backend secret and must never be in a position to reach it
 * (docs/16 § 16.11). An already-set variable always wins, so CI and container
 * environments override the file rather than the other way round.
 */
function loadPublicRootEnv() {
  const rootEnv = path.resolve(process.cwd(), '..', '..', '.env');
  if (!existsSync(rootEnv)) return;

  for (const line of readFileSync(rootEnv, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(NEXT_PUBLIC_[A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    process.env[key] = rawValue.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}

loadPublicRootEnv();

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
