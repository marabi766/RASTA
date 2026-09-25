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
  /**
   * Platform operator. The only role that may read audit evidence across
   * tenants (ADR-053 § 10) — a union administrator is confined to its own
   * subtree, which is a different scenario.
   */
  systemAdmin: 'system.admin',
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
    // All four platform attributes, as the realm declares them. The role is
    // `organization_roles`, not a realm role: the guard reads a user's roles
    // from the organization they act for and ignores every realm role but
    // SYSTEM_ADMIN (ADR-060 § 4).
    attributes: {
      active_organization_id: [ORG.b],
      rasta_user_id: ['USR-SEED-DEHYARI-ADMIN-B'],
      organization_ids: [ORG.b],
      organization_roles: [`${ORG.b}:ORGANIZATION_ADMIN`],
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
 * account if it is absent, and otherwise repairs only what makes an account
 * unusable — a missing profile field, or a token without the organization and
 * its role. In CI the realm import has already created the user correctly and
 * this is a GET and a token request that find it.
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
    if (incomplete) {
      await writeRepresentation(config, userId);
      outcome = 'repaired';
    }
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
        `${E2E_USERS.tenantB} authenticates but its token lacks the org_id or org_roles claim. ` +
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

/** Whether this user's token carries the organization and its admin role in it. */
async function tokenCarriesOrganization(config: E2eConfig): Promise<boolean> {
  const token = await accessToken(E2E_USERS.tenantB, config);
  const segment = token.split('.')[1];
  if (!segment) return false;
  const claims = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as {
    org_id?: string;
    org_roles?: string[] | string;
  };
  const roles = Array.isArray(claims.org_roles) ? claims.org_roles : [claims.org_roles];
  return claims.org_id === ORG.b && roles.includes(`${ORG.b}:ORGANIZATION_ADMIN`);
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
