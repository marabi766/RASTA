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

const OPERATOR_USERNAME = 'operator.one';
const PORTAL_ORIGIN = 'http://localhost:3200';
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

const tokenClaimsSchema = z.object({
  sub: z.string().min(1),
  preferred_username: z.string().min(1),
  org_id: z.literal('ORG-DEH-0001'),
  rasta_uid: z.literal('USR-SEED-OPERATOR'),
});

interface RealmCredential {
  readonly type?: string;
  readonly value?: string;
}

interface RealmUser {
  readonly username?: string;
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

/** Reads the throwaway fixture password from its one source of truth. */
function operatorPassword(): string {
  const realmPath = resolve(__dirname, '../../../infrastructure/docker/keycloak/rasta-realm.json');
  const realm = JSON.parse(readFileSync(realmPath, 'utf8')) as RealmExport;
  const credential = realm.users
    ?.find((user) => user.username === OPERATOR_USERNAME)
    ?.credentials?.find((entry) => entry.type === 'password');

  if (!credential?.value) {
    throw new Error(`No password for ${OPERATOR_USERNAME} in the Keycloak realm fixture`);
  }
  return credential.value;
}

async function operatorTokens(): Promise<z.infer<typeof tokenResponseSchema>> {
  const issuer = requiredEnv('OIDC_ISSUER_URL').replace(/\/+$/, '');
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: requiredEnv('OIDC_CLIENT_ID'),
      username: OPERATOR_USERNAME,
      password: operatorPassword(),
      scope: 'openid',
    }),
  });

  if (!response.ok) {
    // Never include the response body: an identity-provider error can echo
    // request material, and this helper handles a password and refresh token.
    throw new Error(`Keycloak refused the live browser fixture (${response.status})`);
  }
  return tokenResponseSchema.parse(await response.json());
}

export async function installLiveSession(context: BrowserContext): Promise<LiveSession> {
  const tokens = await operatorTokens();
  const claims = tokenClaimsSchema.parse(decodeJwt(tokens.access_token));
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
