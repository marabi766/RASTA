import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { BrowserContext } from '@playwright/test';
import { decodeJwt } from 'jose';
import { z } from 'zod';

import { SESSION_COOKIE, newCsrfToken, sealSession } from '../src/server/session';

/**
 * A real portal session for the live-stack browser scenario.
 *
 * This helper runs in Playwright's Node process, never in the page. It asks the
 * development Keycloak realm for the same token pair used by the portal's
 * authorization-code flow, seals it with the production ADR-059 session code,
 * and gives the browser only the opaque HttpOnly cookie. No token is exposed to
 * browser JavaScript, and there is deliberately no test-only HTTP route that
 * could become a session-minting surface in a deployment.
 *
 * The authorization-code/PKCE login UI is a separate concern. This scenario
 * starts after authentication so it can isolate the session -> CSRF -> gateway
 * -> fleet write path without making Keycloak's own HTML part of the test.
 */

/**
 * The people the live-stack scenarios can sign in as, by what they are *for*.
 *
 * Every one is a user in the throwaway development realm
 * (`infrastructure/docker/keycloak/rasta-realm.json`), which is also where the
 * password and the expected claims are read from — one source of truth, so a
 * scenario cannot drift from the realm it runs against.
 *
 * - `operator` — `operator.one`, ORG-DEH-0001; holds the assignment the usage
 *   scenario writes against.
 * - `orgAdmin` — `dehyari.admin`, ORG-DEH-0001; may manage assets, drivers and
 *   members of that organization.
 * - `orgAdminB` — `dehyari.admin.b`, ORG-DEH-0002: **the other tenant**. The
 *   seeds give it a machine, a driver and a schedule of its own, so a
 *   scenario can show that what it owns is invisible to `orgAdmin` and the
 *   reverse.
 */
export const LIVE_PERSONAS = {
  operator: 'operator.one',
  orgAdmin: 'dehyari.admin',
  orgAdminB: 'dehyari.admin.b',
} as const;

export type LivePersona = keyof typeof LIVE_PERSONAS;

const PORTAL_ORIGIN = 'http://localhost:3200';
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

interface RealmCredential {
  readonly type?: string;
  readonly value?: string;
}

interface RealmUser {
  readonly username?: string;
  readonly attributes?: Readonly<Record<string, readonly string[]>>;
  readonly credentials?: readonly RealmCredential[];
}

interface RealmExport {
  readonly users?: readonly RealmUser[];
}

export interface LiveSession {
  readonly accessToken: string;
  readonly organizationId: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`The live portal browser test requires ${name}`);
  return value;
}

interface Fixture {
  readonly username: string;
  readonly password: string;
  /** The organization and platform user the realm says this person is. */
  readonly organizationId: string;
  readonly userId: string;
}

/** Reads the throwaway fixture from its one source of truth. */
function fixtureFor(persona: LivePersona): Fixture {
  const username = LIVE_PERSONAS[persona];
  const realmPath = resolve(__dirname, '../../../infrastructure/docker/keycloak/rasta-realm.json');
  const realm = JSON.parse(readFileSync(realmPath, 'utf8')) as RealmExport;
  const user = realm.users?.find((entry) => entry.username === username);

  const password = user?.credentials?.find((entry) => entry.type === 'password')?.value;
  const organizationId = user?.attributes?.active_organization_id?.[0];
  const userId = user?.attributes?.rasta_user_id?.[0];

  if (!password) throw new Error(`No password for ${username} in the Keycloak realm fixture`);
  if (!organizationId || !userId) {
    throw new Error(`No organization or platform user id for ${username} in the realm fixture`);
  }
  return { username, password, organizationId, userId };
}

/** What Keycloak said, reduced to labels that cannot carry request material. */
async function refusalReason(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const description = z.object({ error_description: z.string() }).safeParse(body);
    const text = description.success ? description.data.error_description : '';
    if (/temporarily disabled/i.test(text)) return 'account temporarily locked';
    if (/invalid user credentials/i.test(text)) return 'credentials not accepted';
    if (/not fully set up/i.test(text)) return 'account not fully set up';
    if (/disabled/i.test(text)) return 'account disabled';
  } catch {
    // An unreadable body is still a refusal; the status below says so.
  }
  return 'no recognised reason';
}

const TOKEN_ATTEMPTS = 3;
const TOKEN_RETRY_DELAY_MS = 750;

/**
 * A 401 from the password grant has been seen once in a while on the shared CI
 * Keycloak while two browser workers sign in at the same moment, and passes on
 * the next try. A bounded retry absorbs that; a real lock-out (which lasts a
 * minute) or a wrong fixture password fails at once or after three tries, with
 * the reason named, instead of being hidden behind a test-level retry.
 */
async function tokensFor(fixture: Fixture): Promise<z.infer<typeof tokenResponseSchema>> {
  const issuer = requiredEnv('OIDC_ISSUER_URL').replace(/\/+$/, '');
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: requiredEnv('OIDC_CLIENT_ID'),
    username: fixture.username,
    password: fixture.password,
    scope: 'openid',
  });

  let refusal = '';
  for (let attempt = 1; attempt <= TOKEN_ATTEMPTS; attempt += 1) {
    const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (response.ok) return tokenResponseSchema.parse(await response.json());

    // Never include the response body: an identity-provider error can echo
    // request material, and this helper handles a password and refresh token.
    const reason = await refusalReason(response);
    refusal = `${response.status}, ${reason}, attempt ${attempt} of ${TOKEN_ATTEMPTS}`;
    if (response.status !== 401 || reason === 'account temporarily locked') break;
    await new Promise((done) => setTimeout(done, TOKEN_RETRY_DELAY_MS * attempt));
  }
  throw new Error(`Keycloak refused the live browser fixture for ${fixture.username} (${refusal})`);
}

/**
 * Signs `persona` in by putting the same sealed cookie the portal's own OIDC
 * flow would set into `context`. Defaults to the operator the usage scenario
 * was written for.
 *
 * The token's own claims are checked against the realm fixture before the
 * session is sealed: a scenario that thinks it is acting as organization B
 * while holding organization A's token would pass a tenant-isolation check for
 * the wrong reason, so this refuses to proceed rather than trust the login.
 */
export async function installLiveSession(
  context: BrowserContext,
  persona: LivePersona = 'operator',
): Promise<LiveSession> {
  const fixture = fixtureFor(persona);
  const tokens = await tokensFor(fixture);
  const claims = z
    .object({
      sub: z.string().min(1),
      preferred_username: z.literal(fixture.username),
      org_id: z.literal(fixture.organizationId),
      rasta_uid: z.literal(fixture.userId),
    })
    .parse(decodeJwt(tokens.access_token));
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + tokens.expires_in;

  const sealed = sealSession(
    {
      subject: claims.sub,
      username: claims.preferred_username,
      organizationId: claims.org_id,
      accessToken: tokens.access_token,
      accessTokenExpiresAt: expiresAt,
      refreshToken: tokens.refresh_token,
      csrfToken: newCsrfToken(),
      issuedAt: now,
    },
    requiredEnv('WEB_SESSION_SECRET'),
  );

  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: sealed,
      url: PORTAL_ORIGIN,
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
      expires: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
    },
  ]);

  return { accessToken: tokens.access_token, organizationId: claims.org_id };
}
