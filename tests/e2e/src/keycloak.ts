import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { e2eConfig, ORG, type E2eConfig } from './env';

/**
 * Real tokens from the real identity provider.
 *
 * These tests do not mint their own JWTs. A hand-signed token proves that the
 * guard accepts the shape somebody wrote for it; a Keycloak token proves the
 * platform accepts what Keycloak actually issues — the audience mapper, the
 * `org_id` claim, the realm-role placement and the RS256 key are all part of
 * what is being verified (AGENTS.md S-04).
 */

/** The seeded development users, by the role each one exists to exercise. */
export const E2E_USERS = {
  /** Platform scope. Reads the trial balance and any journal. */
  platformAdmin: 'union.admin',
  /** Tenant A's financial administrator — the payer side of the critical path. */
  tenantA: 'dehyari.admin',
  /** Tenant B's financial administrator — the payee, and the cross-tenant probe. */
  tenantB: 'dehyari.admin.b',
  /** Province oversight. Must reach nothing in economic-service (docs/10 § 10.13). */
  auditor: 'province.auditor',
} as const;

export type E2eUser = (typeof E2E_USERS)[keyof typeof E2E_USERS];

interface RealmCredential {
  type?: string;
  value?: string;
  temporary?: boolean;
}

interface RealmUser {
  username?: string;
  credentials?: RealmCredential[];
}

interface RealmExport {
  users?: RealmUser[];
}

/**
 * The development password, read from the realm fixture rather than repeated.
 *
 * `infrastructure/docker/keycloak/rasta-realm.json` is the source of truth for
 * the local identity fixture and already carries this throwaway value. Copying
 * it into a test file would create a second place to change and a second thing
 * for a secret scanner to find, so it is read from the one place that owns it.
 * `E2E_USER_PASSWORD` overrides it for an environment whose realm was
 * provisioned differently.
 */
export function seedPassword(): string {
  const override = process.env.E2E_USER_PASSWORD?.trim();
  if (override) return override;

  const realmPath = resolve(__dirname, '../../../infrastructure/docker/keycloak/rasta-realm.json');
  const realm = JSON.parse(readFileSync(realmPath, 'utf8')) as RealmExport;

  const credential = realm.users
    ?.find((user) => user.username === E2E_USERS.tenantA)
    ?.credentials?.find((entry) => entry.type === 'password');

  if (!credential?.value) {
    throw new Error(
      `No password for ${E2E_USERS.tenantA} in ${realmPath}. ` +
        'Set E2E_USER_PASSWORD if this environment provisions users elsewhere.',
    );
  }
  return credential.value;
}

/**
 * Obtains an access token with the resource-owner password grant.
 *
 * The grant is enabled on `rasta-web` in the development realm only. It is the
 * one flow a headless test can drive without a browser, and it produces exactly
 * the token the authorization-code flow produces — same mappers, same audience,
 * same signature.
 */
export async function accessToken(
  username: E2eUser,
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
        password: seedPassword(),
        scope: 'openid',
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Keycloak refused a token for ${username}: ${response.status} ${await response.text()}`,
    );
  }

  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`Keycloak returned no access_token for ${username}`);
  return body.access_token;
}

// ---------------------------------------------------------------------------
// Reconciling the realm
// ---------------------------------------------------------------------------

/**
 * The complete representation of the second-tenant user.
 *
 * `firstName` and `lastName` are not decoration. Keycloak 26 declares them
 * required in the realm's user profile, and an account missing them
 * authenticates with `invalid_grant: Account is not fully set up` — a message
 * that reads like a wrong password and is not one.
 */
function tenantBRepresentation() {
  return {
    username: E2E_USERS.tenantB,
    email: 'dehyari.admin.b@rasta.local',
    firstName: 'دهیار',
    lastName: 'نمونه دو',
    enabled: true,
    emailVerified: true,
    requiredActions: [],
    attributes: {
      active_organization_id: [ORG.b],
      rasta_user_id: ['USR-SEED-DEHYARI-ADMIN-B'],
    },
  };
}

interface KeycloakUser {
  id: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  requiredActions?: string[];
}

/**
 * Ensures the second-tenant user exists and can actually log in.
 *
 * `rasta-realm.json` is the source of truth and declares this user, but
 * Keycloak imports a realm **only when it does not already exist**. A developer
 * whose stack has been up since before this user was added would otherwise have
 * to destroy their Keycloak database to run these tests, and "reset your local
 * identity provider" is not an acceptable prerequisite for a test suite.
 *
 * Narrow, and confined to one user in a development realm: it creates the
 * account if it is absent, and otherwise repairs only the two things that make
 * an account unusable — a missing profile field and a missing role mapping.
 * Both are the residue of a run that failed between the create call and the
 * role-mapping call, and leaving them means every later run fails with a
 * message that blames authentication. In CI the realm import has already
 * created the user correctly and this is a pair of GETs that find it.
 */
export async function ensureTenantBUser(
  config: E2eConfig = e2eConfig(),
): Promise<'found' | 'created' | 'repaired'> {
  const lookup = await adminRequest(config, `/users?username=${E2E_USERS.tenantB}&exact=true`);
  const [existing] = (await lookup.json()) as KeycloakUser[];

  let outcome: 'found' | 'created' | 'repaired' = 'found';
  let userId: string;

  if (existing) {
    userId = existing.id;
    const incomplete =
      !existing.firstName || !existing.lastName || (existing.requiredActions?.length ?? 0) > 0;
    if (incomplete) await writeRepresentation(config, userId);
    const mapped = await grantOrganizationAdmin(config, userId);
    if (incomplete || mapped) outcome = 'repaired';
  } else {
    await allowAdminEditedAttributes(config);
    const created = await adminRequest(config, '/users', {
      method: 'POST',
      body: JSON.stringify({
        ...tenantBRepresentation(),
        credentials: [{ type: 'password', value: seedPassword(), temporary: false }],
      }),
    });

    const location = created.headers.get('location')?.split('/').pop();
    if (!location) throw new Error('Keycloak created a user but returned no Location header');
    userId = location;

    await grantOrganizationAdmin(config, userId);
    outcome = 'created';
  }

  // The claim the whole tenant boundary rests on, checked positively.
  //
  // `org_id` is what the auth guard resolves the organization from, and the
  // attribute behind it is *unmanaged* in Keycloak 26: the admin API silently
  // drops it unless the realm's user profile permits admin-edited attributes.
  // Realm import writes it regardless, which is why the seeded users work and
  // an API-created one does not — a difference that surfaces as every request
  // by this user returning 500, nowhere near its cause.
  if (!(await tokenCarriesOrganization(config))) {
    await allowAdminEditedAttributes(config);
    await writeRepresentation(config, userId);

    if (!(await tokenCarriesOrganization(config))) {
      throw new Error(
        `${E2E_USERS.tenantB} authenticates but its token carries no org_id claim. ` +
          'Recreate the realm from infrastructure/docker/keycloak/rasta-realm.json ' +
          '(`docker compose down keycloak && pnpm infra:up`).',
      );
    }
    outcome = 'repaired';
  }

  return outcome;
}

async function writeRepresentation(config: E2eConfig, userId: string): Promise<void> {
  await adminRequest(config, `/users/${userId}`, {
    method: 'PUT',
    body: JSON.stringify(tenantBRepresentation()),
  });
}

/** Whether this user's access token actually carries the organization claim. */
async function tokenCarriesOrganization(config: E2eConfig): Promise<boolean> {
  const token = await accessToken(E2E_USERS.tenantB, config);
  const segment = token.split('.')[1];
  if (!segment) return false;
  const claims = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as {
    org_id?: string;
  };
  return claims.org_id === ORG.b;
}

/**
 * Lets the admin API write the platform's own claims.
 *
 * Keycloak 26 declares a user profile with four managed attributes and, by
 * default, refuses every other one written through the admin API — while still
 * honouring the ones a realm import wrote directly. Switching the policy to
 * `ADMIN_EDIT` makes the two paths agree. It touches only the development
 * realm, and only when this harness has had to create or repair a user; a CI
 * run, where the realm import already produced a correct account, never
 * reaches it.
 */
async function allowAdminEditedAttributes(config: E2eConfig): Promise<void> {
  const current = await adminRequest(config, '/users/profile');
  const profile = (await current.json()) as { unmanagedAttributePolicy?: string };
  if (profile.unmanagedAttributePolicy === 'ADMIN_EDIT') return;

  await adminRequest(config, '/users/profile', {
    method: 'PUT',
    body: JSON.stringify({ ...profile, unmanagedAttributePolicy: 'ADMIN_EDIT' }),
  });
}

/**
 * Adds the realm role if it is not already there. Returns whether it had to.
 *
 * Keycloak's create-user endpoint ignores `realmRoles`; the mapping is a
 * separate call, and its absence is what produces a user that authenticates
 * and then fails every authorization check — which would make the
 * cross-tenant assertions pass for entirely the wrong reason.
 */
async function grantOrganizationAdmin(config: E2eConfig, userId: string): Promise<boolean> {
  const current = await adminRequest(config, `/users/${userId}/role-mappings/realm`);
  const assigned = (await current.json()) as { name: string }[];
  if (assigned.some((role) => role.name === 'ORGANIZATION_ADMIN')) return false;

  const roles = await adminRequest(config, '/roles/ORGANIZATION_ADMIN');
  const role = (await roles.json()) as { id: string; name: string };
  await adminRequest(config, `/users/${userId}/role-mappings/realm`, {
    method: 'POST',
    body: JSON.stringify([{ id: role.id, name: role.name }]),
  });
  return true;
}

let adminToken: string | undefined;

async function adminAccessToken(config: E2eConfig): Promise<string> {
  if (adminToken) return adminToken;

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
    throw new Error(
      `Keycloak refused an admin token: ${response.status} ${await response.text()}. ` +
        'Set KEYCLOAK_ADMIN and KEYCLOAK_ADMIN_PASSWORD for this environment.',
    );
  }

  const body = (await response.json()) as { access_token: string };
  adminToken = body.access_token;
  return adminToken;
}

async function adminRequest(
  config: E2eConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await adminAccessToken(config);
  const response = await fetch(`${config.keycloakUrl}/admin/realms/${config.realm}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(
      `Keycloak admin ${init.method ?? 'GET'} ${path} failed: ` +
        `${response.status} ${await response.text()}`,
    );
  }
  return response;
}
