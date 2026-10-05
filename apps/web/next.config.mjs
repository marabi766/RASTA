import { createRequire } from 'node:module';

const { uploadMaxBytes } = createRequire(import.meta.url)('./upload-limit.cjs');
const uploadCeiling = uploadMaxBytes(process.env.WEB_UPLOAD_MAX_BYTES);

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
       * default is 1 MB. A **transport** number, not a policy (ADR-069, Q-98):
       * 26 MiB by default, just above document-service's own ceiling so that
       * service refuses an oversize file with a sentence, and configurable with
       * `WEB_UPLOAD_MAX_BYTES` when the portal is built (`upload-limit.cjs`).
       * Global to the portal, which ADR-069 says and does not hide.
       */
      bodySizeLimit: uploadCeiling,
    },
    /**
     * What Next copies of a request body so middleware can see it (default
     * 10 MiB; beyond that the copy is cut and a warning logged). `middleware.ts`
     * never reads a body, but the two ceilings must not disagree, so it follows
     * the one above.
     */
    middlewareClientMaxBodySize: uploadCeiling,
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
