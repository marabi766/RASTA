import { e2eConfig, type E2eConfig } from './env.ts';
import { jsonOf } from './http.ts';
import {
  adminRead,
  adminRequest,
  claimsOf,
  keycloakRequest,
  passwordGrant,
  type KeycloakRequest,
  type KeycloakTransport,
} from './keycloak-transport.ts';

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
 * credential. Every call goes through `keycloak-transport.ts`, as that file's do.
 */

/** A password for accounts these tests create. Never a real credential; never logged. */
export const PROVISIONED_ACCOUNT_PASSWORD = 'Projection-Test-Password-2026!';

export interface KeycloakUser {
  id: string;
  enabled?: boolean;
  emailVerified?: boolean;
  requiredActions?: string[];
  attributes?: Record<string, string[]>;
  [field: string]: unknown;
}

/**
 * Lets an API-provisioned account sign in.
 *
 * identity-service creates accounts with no password and `UPDATE_PASSWORD`
 * required, which is right for a person and unusable for a test. This sets a
 * throwaway password and clears the required action — sending **only**
 * `requiredActions`. A body without `attributes` changes nothing else on
 * Keycloak 26 (ADR-060 § 5), and a whole-representation write would race the
 * identity projections that land just after provisioning: whichever wrote
 * last would put back what the other had changed.
 */
export async function enableSignIn(
  username: string,
  config: E2eConfig = e2eConfig(),
): Promise<void> {
  const user = await findAccount(username, config);

  await adminRequest(config, 'PUT', `/users/${user.id}/reset-password`, {
    type: 'password',
    value: PROVISIONED_ACCOUNT_PASSWORD,
    temporary: false,
  });

  await updateAccount(username, { requiredActions: [] }, config);
}

/** What Keycloak holds for a provisioned account, read as its administrator. */
export async function readAccount(
  username: string,
  config: E2eConfig = e2eConfig(),
): Promise<KeycloakUser> {
  const { id } = await findAccount(username, config);
  return adminRead<KeycloakUser>(config, `/users/${id}`);
}

/**
 * Changes an account the way an administrator in the console does — only the
 * fields named, never `attributes` (which would erase what it leaves out).
 */
export async function updateAccount(
  username: string,
  fields: { requiredActions?: string[]; enabled?: boolean; emailVerified?: boolean },
  config: E2eConfig = e2eConfig(),
): Promise<void> {
  const { id } = await findAccount(username, config);
  await adminRequest(config, 'PUT', `/users/${id}`, fields);
}

async function findAccount(username: string, config: E2eConfig): Promise<KeycloakUser> {
  const [user] = await adminRead<KeycloakUser[]>(
    config,
    `/users?username=${encodeURIComponent(username)}&exact=true`,
  );
  if (!user) throw new Error(`No Keycloak account for ${username}; provisioning did not reach it`);
  return user;
}

/**
 * A fresh access token for a provisioned account — never a cached one. Through
 * `keycloak-transport.ts`: bounded by the request timeout, and failing with fixed text.
 */
export async function freshToken(
  username: string,
  config: E2eConfig = e2eConfig(),
  transport?: KeycloakTransport,
): Promise<string> {
  const granted = await passwordGrant(
    config,
    {
      realm: config.realm,
      clientId: config.clientId,
      username,
      password: PROVISIONED_ACCOUNT_PASSWORD,
      scope: 'openid',
    },
    username,
    transport,
  );
  return granted.accessToken;
}

/** The claims ADR-060 builds authorization from. */
export interface MembershipClaims {
  rasta_uid?: string;
  org_id?: string;
  org_ids?: string[];
  org_roles?: string[];
}

export function membershipClaims(token: string): MembershipClaims {
  const claims = claimsOf(token) as MembershipClaims;
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
  const request: KeycloakRequest = {
    method: 'GET',
    path: `/realms/${config.realm}/account/?userProfileMetadata=true`,
    headers: { authorization: `Bearer ${token}` },
  };
  const answer = await keycloakRequest(config, request);
  return {
    status: answer.status,
    body: jsonOf<Record<string, unknown>>(
      'The account console answered unreadably',
      request,
      answer,
    ),
  };
}

/** Tries to write attributes through the account console's own REST API, as the user. */
export async function writeOwnAccount(
  token: string,
  representation: Record<string, unknown>,
  config: E2eConfig = e2eConfig(),
): Promise<{ status: number; body: unknown }> {
  const request: KeycloakRequest = {
    method: 'POST',
    path: `/realms/${config.realm}/account/`,
    headers: { authorization: `Bearer ${token}` },
    body: representation,
  };
  const answer = await keycloakRequest(config, request);
  return {
    status: answer.status,
    body: answer.text
      ? jsonOf<unknown>('The account console answered unreadably', request, answer)
      : null,
  };
}
