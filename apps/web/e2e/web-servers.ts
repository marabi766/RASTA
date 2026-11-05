import {
  LAYOUT_GATEWAY_PORT,
  LAYOUT_ORIGIN,
  LAYOUT_PORT,
  layoutSessionSecret,
} from './layout/constants';
import { serverStart, type ServerStart } from './server-reuse';

const PORTAL_PORT = 3200;

/**
 * The three servers of the browser suite (`playwright.config.ts` passes them as `webServer`). Building
 * them inspects nothing and starts nothing: see `server-reuse.ts` for how each one is proved ready.
 */
export function webServers(ci: boolean): (ServerStart & { timeout: number })[] {
  return [
    {
      // Production mode everywhere, from ONE `next build`. The layout suite's
      // portal below is always `next start`, and `next dev` empties `.next`
      // (BUILD_ID included) when it starts: a dev server here made the second
      // portal unable to start on any local run (PR #574 review, F1). So
      // locally this entry builds first and then starts, and CI, which has
      // already built, only starts. Both portals thus read the same finished
      // build. A hand-run `pnpm dev` beside this suite has the same effect:
      // stop it first, or the layout portal reports a missing production build.
      // The price is a build per local run instead of compile-on-demand; the
      // gain is that the suite checks the code that ships.
      ...serverStart({
        ci,
        port: PORTAL_PORT,
        command: ci ? 'pnpm run start' : 'pnpm run build && pnpm run start',
        url: 'http://localhost:3200',
      }),
      // A cold build is part of a local start.
      timeout: ci ? 120_000 : 360_000,
    },
    {
      // The fixture gateway for the layout suite: populated pages, no live stack.
      ...serverStart({
        ci,
        port: LAYOUT_GATEWAY_PORT,
        command: 'node e2e/layout/mock-gateway.mjs',
        url: `http://127.0.0.1:${LAYOUT_GATEWAY_PORT}/health`,
        env: { LAYOUT_GATEWAY_PORT: String(LAYOUT_GATEWAY_PORT) },
      }),
      timeout: 30_000,
    },
    {
      // A second copy of the portal, pointed at the fixture gateway. Always a
      // production start on the build the entry above provides (CI has already
      // run it; locally that entry builds): it shares `.next` with the first
      // portal, so neither may be a dev server.
      ...serverStart({
        ci,
        port: LAYOUT_PORT,
        command: `pnpm exec next start --port ${LAYOUT_PORT}`,
        url: `${LAYOUT_ORIGIN}/login`,
        env: {
          API_GATEWAY_URL: `http://127.0.0.1:${LAYOUT_GATEWAY_PORT}`,
          OIDC_ISSUER_URL: `http://127.0.0.1:${LAYOUT_GATEWAY_PORT}/realms/layout`,
          OIDC_CLIENT_ID: 'rasta-web',
          WEB_PUBLIC_ORIGIN: LAYOUT_ORIGIN,
          WEB_COOKIE_SECURE: 'false',
          WEB_SESSION_SECRET: layoutSessionSecret(),
          WEB_REDIS_URL: process.env.WEB_REDIS_URL ?? 'redis://localhost:6379',
        },
      }),
      timeout: 120_000,
    },
  ];
}
