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
  experimental: {
    serverActions: {
      /**
       * The Server Actions request-body ceiling. A document upload (EXP-002,
       * slice 7) reaches the portal as the action's multipart body, and the
       * default is 1 MB. This is a **transport** number, not a policy: it sits
       * just above document-service's own default ceiling (`DOCUMENT_MAX_BYTES`,
       * 25 MiB) so that service, not this setting, is what refuses an
       * oversize file with a sentence. A deployment that raises that ceiling
       * raises this with it (an open question, asked on #225).
       */
      bodySizeLimit: '26mb',
    },
  },
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
