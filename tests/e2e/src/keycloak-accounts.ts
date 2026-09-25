import { e2eConfig, type E2eConfig } from './env';

/**
 * Keycloak access for accounts the platform provisions itself (ADR-060).
 *
 * The seed users in `rasta-realm.json` come from a realm import, which writes
 * attributes straight into the database and so never exercised the Admin API
 * path the platform uses for every real account. These helpers exist to drive
 * that path end to end: give an API-provisioned account a password, sign in
 * as it, and read what its token and its own account console actually say.
 *
 * Separate from `keycloak.ts` on purpose: that file reconciles the seed realm,
 * and nothing here changes realm configuration — only one throwaway account's
 * credential.
 */

/** A password for accounts these tests create. Never a real credential; never logged. */
export const PROVISIONED_ACCOUNT_PASSWORD = 'Projection-Test-Password-2026!';

interface KeycloakUser {
  id: string;
  requiredActions?: string[];
  [field: string]: unknown;
}

let adminToken: { value: string; expiresAt: number } | undefined;

async function adminAccessToken(config: E2eConfig): Promise<string> {
  if (adminToken && adminToken.expiresAt > Date.now() + 10_000) return adminToken.value;
  const response = await fetch(
    `${config.keycloakUrl}/realms/master/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: config.keycloakAdmin.username,
        password: config.keycloakAdmin.password,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Keycloak refused an admin token: ${response.status}`);
  }
  const body = (await response.json()) as { access_token: string; expires_in: number };
  adminToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return adminToken.value;
}

async function admin(config: E2eConfig, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${config.keycloakUrl}/admin/realms/${config.realm}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${await adminAccessToken(config)}`,
      'content-type': 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`Keycloak admin ${init.method ?? 'GET'} ${path} answered ${response.status}`);
  }
  return response;
}

/**
 * Lets an API-provisioned account sign in.
 *
 * identity-service creates accounts with no password and `UPDATE_PASSWORD`
 * required, which is right for a person and unusable for a test. This sets a
 * throwaway password and clears the required action — writing the *whole*
 * representation back, because Keycloak 26 treats a partial `PUT` as the whole
 * user and would erase the attributes under test.
 */
export async function enableSignIn(
  username: string,
  config: E2eConfig = e2eConfig(),
): Promise<void> {
  const [user] = (await (
    await admin(config, `/users?username=${encodeURIComponent(username)}&exact=true`)
  ).json()) as KeycloakUser[];
  if (!user) throw new Error(`No Keycloak account for ${username}; provisioning did not reach it`);

  await admin(config, `/users/${user.id}/reset-password`, {
    method: 'PUT',
    body: JSON.stringify({
      type: 'password',
      value: PROVISIONED_ACCOUNT_PASSWORD,
      temporary: false,
    }),
  });

  const current = (await (await admin(config, `/users/${user.id}`)).json()) as KeycloakUser;
  await admin(config, `/users/${user.id}`, {
    method: 'PUT',
    body: JSON.stringify({ ...current, requiredActions: [] }),
  });
}

/** A fresh access token for a provisioned account — never a cached one. */
export async function freshToken(
  username: string,
  config: E2eConfig = e2eConfig(),
): Promise<string> {
  const response = await fetch(
    `${config.keycloakUrl}/realms/${config.realm}/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: config.clientId,
        username,
        password: PROVISIONED_ACCOUNT_PASSWORD,
        scope: 'openid',
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Keycloak refused a token for ${username}: ${response.status}`);
  }
  return ((await response.json()) as { access_token: string }).access_token;
}

/** The claims ADR-060 builds authorization from. */
export interface MembershipClaims {
  rasta_uid?: string;
  org_id?: string;
  org_ids?: string[];
  org_roles?: string[];
}

export function membershipClaims(token: string): MembershipClaims {
  const segment = token.split('.')[1] ?? '';
  const claims = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as MembershipClaims;
  return {
    rasta_uid: claims.rasta_uid,
    org_id: claims.org_id,
    org_ids: claims.org_ids,
    org_roles: claims.org_roles,
  };
}

/** What the account console's own REST API returns to the user. */
export async function readOwnAccount(
  token: string,
  config: E2eConfig = e2eConfig(),
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(
    `${config.keycloakUrl}/realms/${config.realm}/account/?userProfileMetadata=true`,
    {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Tries to write attributes through the account console's own REST API, as the user. */
export async function writeOwnAccount(
  token: string,
  representation: Record<string, unknown>,
  config: E2eConfig = e2eConfig(),
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${config.keycloakUrl}/realms/${config.realm}/account/`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(representation),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
}
