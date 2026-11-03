import type { BrowserContext } from '../expect';
import { LAYOUT_ORIGIN, layoutSessionSecret } from './constants';
import { SESSION_COOKIE, newCsrfToken, sealSession } from '../../src/server/session';

/**
 * The throwaway portal and gateway behind the phone-layout suite.
 *
 * `playwright.config.ts` starts a second copy of the portal on `LAYOUT_PORT`,
 * pointed at `mock-gateway.mjs` on `LAYOUT_GATEWAY_PORT`, so a page can be
 * rendered **populated** without a live stack: the portal reads its data on the
 * server, where a browser test cannot intercept it. The session is sealed here
 * with the layout portal's own secret (random per run, passed to both through
 * the environment — never a repository value) and holds a token this file
 * forges. The token is unsigned: the portal only decodes it to choose what to
 * draw, and the gateway it talks to is the fixture server above.
 */
export const LAYOUT_ORGANIZATION = 'ORG-LAYOUT-0001';

/**
 * Every role that draws a navigation entry, so the menu is as long as the
 * longest a person sees (the demo run's was sixteen items).
 */
const ROLES = [
  'ORGANIZATION_ADMIN',
  'FLEET_MANAGER',
  'PROCUREMENT_USER',
  'CONTRACTOR',
  'UNION_ADMIN',
  'SUPPLIER',
  'WORKSHOP',
];

function unsignedToken(): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    part({ alg: 'none', typ: 'JWT' }),
    part({
      sub: 'layout-subject',
      preferred_username: 'layout.admin',
      org_id: LAYOUT_ORGANIZATION,
      org_ids: [LAYOUT_ORGANIZATION],
      org_roles: ROLES.map((role) => `${LAYOUT_ORGANIZATION}:${role}`),
    }),
    'x',
  ].join('.');
}

/** Signs `context` in to the layout portal with a long-lived session. */
export async function installLayoutSession(context: BrowserContext): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const token = unsignedToken();
  const sealed = sealSession(
    {
      subject: 'layout-subject',
      username: 'layout.admin',
      organizationId: LAYOUT_ORGANIZATION,
      accessToken: token,
      accessTokenExpiresAt: now + 6 * 60 * 60,
      refreshToken: 'layout-refresh',
      csrfToken: newCsrfToken(),
      issuedAt: now,
    },
    layoutSessionSecret(),
  );
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: sealed,
      url: LAYOUT_ORIGIN,
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
      expires: now + 6 * 60 * 60,
    },
  ]);
}
