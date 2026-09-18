/**
 * @type {import('next').NextConfig}
 *
 * `reactStrictMode` is on because the double-invocation it causes in
 * development surfaces effects that are not idempotent. An offline-capable
 * portal (docs/16 § 16.10) cannot afford those.
 *
 * `poweredByHeader` is off: `X-Powered-By` announces the framework to anyone
 * scanning, and gives nothing back.
 */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: {
    // The quality chain runs ESLint as its own task, over `src`, with the
    // repository's configuration. Letting `next build` run a second, differently
    // configured pass would mean two answers to one question.
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Same reasoning: `pnpm typecheck` is the one type gate, and it runs with
    // the repository's strict base config rather than Next's defaults.
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
