import { randomUUID } from 'node:crypto';

import { decodeJwt } from 'jose';
import { z } from 'zod';

import type { ProvisionedPerson } from './live-session';

/**
 * People a live scenario needs and the development realm does not hold —
 * provisioned the way the platform provisions anyone (ADR-060): the platform
 * administrator creates the account through identity-service
 * (`POST /v1/users`, through the gateway), which writes the Keycloak account
 * with its membership claims. The one step the platform leaves to a person —
 * choosing a password — is done here through Keycloak's admin API, as
 * `tests/e2e/src/keycloak-accounts.ts` does: a throwaway password, and the
 * `UPDATE_PASSWORD` action cleared, sending only `requiredActions`.
 *
 * The password is random per person and never logged; nothing here writes a
 * file. Needs `KEYCLOAK_ADMIN_PASSWORD` (the "Portal in a browser" job
 * generates one per run) and the realm's issuer (`OIDC_ISSUER_URL`).
 */

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`The live scenarios require ${name}`);
  return value;
}

function gatewayUrl(path: string): string {
  return `${requiredEnv('API_GATEWAY_URL').replace(/\/+$/, '')}${path}`;
}

/** `http://host/realms/rasta` → `http://host` and `rasta`. */
function realmOf(): { base: string; realm: string } {
  const issuer = requiredEnv('OIDC_ISSUER_URL').replace(/\/+$/, '');
  const match = /^(.*)\/realms\/([^/]+)$/.exec(issuer);
  if (!match) throw new Error('OIDC_ISSUER_URL does not name a Keycloak realm');
  return { base: match[1]!, realm: match[2]! };
}

async function adminToken(): Promise<string> {
  const { base } = realmOf();
  const response = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: process.env.KEYCLOAK_ADMIN_USERNAME?.trim() || 'admin',
      password: requiredEnv('KEYCLOAK_ADMIN_PASSWORD'),
    }),
  });
  if (!response.ok) throw new Error(`Keycloak refused its admin sign-in (${response.status})`);
  return z.object({ access_token: z.string().min(1) }).parse(await response.json()).access_token;
}

async function admin(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const { base, realm } = realmOf();
  return fetch(`${base}/admin/realms/${realm}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** A throwaway password and no pending action, so the account can sign in. */
async function enableSignIn(username: string, password: string): Promise<void> {
  const token = await adminToken();
  const found = await admin(
    token,
    'GET',
    `/users?username=${encodeURIComponent(username)}&exact=true`,
  );
  const [user] = z.array(z.object({ id: z.string() })).parse(await found.json());
  if (!user) throw new Error(`Keycloak has no account ${username}`);
  const reset = await admin(token, 'PUT', `/users/${user.id}/reset-password`, {
    type: 'password',
    value: password,
    temporary: false,
  });
  if (!reset.ok) throw new Error(`Keycloak refused the password of ${username} (${reset.status})`);
  const cleared = await admin(token, 'PUT', `/users/${user.id}`, { requiredActions: [] });
  if (!cleared.ok)
    throw new Error(`Keycloak refused to clear ${username}'s actions (${cleared.status})`);
}

const TOKEN_WAIT_MS = 30_000;

/** One password grant for `person`: its access token, or why there is none. */
async function passwordGrant(person: ProvisionedPerson): Promise<string | number> {
  const issuer = requiredEnv('OIDC_ISSUER_URL').replace(/\/+$/, '');
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: requiredEnv('OIDC_CLIENT_ID'),
      username: person.username,
      password: person.password,
      scope: 'openid',
    }),
  });
  if (!response.ok) return response.status;
  return z.object({ access_token: z.string() }).parse(await response.json()).access_token;
}

/** Until a password grant gives a token naming the person and the organization. */
async function untilSignedIn(person: ProvisionedPerson): Promise<void> {
  const deadline = Date.now() + TOKEN_WAIT_MS;
  let last = 'no answer';
  while (Date.now() < deadline) {
    const token = await passwordGrant(person);
    if (typeof token === 'string') {
      const claims = decodeJwt(token);
      if (claims.rasta_uid === person.userId && claims.org_id === person.organizationId) return;
      last = 'token without the membership yet';
    } else {
      last = `token endpoint ${token}`;
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error(`${person.username} could not sign in with its membership (${last})`);
}

/**
 * A provisioned person's access token, for a scenario's own gateway calls
 * (as `liveAccessToken` is for a realm persona) — no browser session is made.
 */
export async function provisionedAccessToken(person: ProvisionedPerson): Promise<string> {
  const token = await passwordGrant(person);
  if (typeof token !== 'string') {
    throw new Error(`${person.username} could not sign in (token endpoint ${token})`);
  }
  return token;
}

/**
 * A new person in `organizationId` holding `roles`, provisioned by the
 * platform administrator (`systemAdminToken`), able to sign in.
 */
export async function provisionPerson(
  systemAdminToken: string,
  username: string,
  organizationId: string,
  roles: readonly string[],
): Promise<ProvisionedPerson> {
  const created = await fetch(gatewayUrl('/v1/users'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${systemAdminToken}`,
      'content-type': 'application/json',
      'idempotency-key': `e2e-provision-${randomUUID()}`,
    },
    body: JSON.stringify({
      username,
      email: `${username}@example.test`,
      firstName: 'آزمون',
      lastName: 'مرورگر',
      organizationId,
      roles,
    }),
  });
  if (created.status !== 201) {
    throw new Error(`identity-service did not provision ${username} (${created.status})`);
  }
  const { id } = z.object({ id: z.string() }).parse(await created.json());
  const person: ProvisionedPerson = {
    username,
    password: `E2e-${randomUUID()}-Pw!`,
    organizationId,
    userId: id,
  };
  await enableSignIn(username, person.password);
  await untilSignedIn(person);
  return person;
}
