import { randomUUID } from 'node:crypto';
import { KeycloakAdminClient } from '../../src/keycloak/keycloak.client';
import type { PlatformAttributes } from '../../src/keycloak/platform-attributes';

/**
 * A projection never undoes a concurrent change to what it does not own —
 * against a **real** Keycloak 26.0 with the platform realm, through the real
 * `KeycloakAdminClient` (ADR-060 § 5; `docs/23` D-037).
 *
 * The projection reads the user, then writes. Before this fix it wrote the
 * whole representation back, so anything changed between its read and its
 * write was reverted: an administrator disabling the account came back
 * enabled, a completed `UPDATE_PASSWORD` came back required (the e2e flake in
 * `03-keycloak-projection`).
 *
 * Driven deterministically, not by luck: `fetch` is wrapped so the
 * projection's `PUT` is held on a gate **after** its `GET` has returned. While
 * it is held, an administrator — the same Admin API the console uses, on a
 * `fetch` the gate never sees — makes the concurrent change. Then the gate
 * opens and the assertion is on what Keycloak holds.
 *
 * Run by the `e2e` CI job, which has the Keycloak (`pnpm --filter
 * @rasta/identity-service test:keycloak-live`). It creates throwaway users in
 * the development realm, so it refuses any Keycloak off loopback.
 */

const realFetch = globalThis.fetch;

function required(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!value) throw new Error(`${name} is not set; this suite needs a running Keycloak`);
  return value;
}

const config = {
  url: required('KEYCLOAK_URL', 'http://localhost:8080').replace(/\/+$/, ''),
  realm: required('KEYCLOAK_REALM', 'rasta'),
  clientId: required('KEYCLOAK_BACKEND_CLIENT_ID', 'rasta-backend'),
  clientSecret: required('KEYCLOAK_BACKEND_CLIENT_SECRET', 'backend_dev_secret_change_me'),
  admin: required('KEYCLOAK_ADMIN', 'admin'),
  adminPassword: required('KEYCLOAK_ADMIN_PASSWORD', 'admin_dev_password'),
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
if (!LOOPBACK.has(new URL(config.url).hostname)) {
  throw new Error(`Refusing to create test users in a Keycloak off loopback: ${config.url}`);
}

interface KeycloakUser {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled: boolean;
  emailVerified: boolean;
  requiredActions: string[];
  attributes?: Record<string, string[]>;
}

let adminToken: { value: string; expiresAt: number } | undefined;

/** The concurrent writer: the realm administrator, on a `fetch` the gate never holds. */
async function admin(path: string, init: RequestInit = {}): Promise<Response> {
  if (!adminToken || adminToken.expiresAt < Date.now() + 10_000) {
    const response = await realFetch(`${config.url}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: config.admin,
        password: config.adminPassword,
      }),
    });
    if (!response.ok) throw new Error(`Keycloak refused an admin token: ${response.status}`);
    const body = (await response.json()) as { access_token: string; expires_in: number };
    adminToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  }
  const response = await realFetch(`${config.url}/admin/realms/${config.realm}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${adminToken.value}`,
      'content-type': 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`Keycloak admin ${init.method ?? 'GET'} ${path} answered ${response.status}`);
  }
  return response;
}

const read = async (id: string) => (await (await admin(`/users/${id}`)).json()) as KeycloakUser;

/** A change the way the console makes it: only the fields it names. */
const change = (id: string, fields: Partial<KeycloakUser>) =>
  admin(`/users/${id}`, { method: 'PUT', body: JSON.stringify(fields) });

function platform(userId: string, roles: string[]): PlatformAttributes {
  return {
    rasta_user_id: [userId],
    active_organization_id: ['ORG_LIVE_A'],
    organization_ids: ['ORG_LIVE_A'],
    organization_roles: roles.map((role) => `ORG_LIVE_A:${role}`),
  };
}

/**
 * Holds the next platform-attribute `PUT` for `keycloakId` until `release`.
 * `reached` resolves once the projection is parked there — its `GET` done.
 */
function holdNextWrite(keycloakId: string) {
  let release!: () => void;
  let reached!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  const parked = new Promise<void>((resolve) => (reached = resolve));
  let held = false;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (!held && init?.method === 'PUT' && url.endsWith(`/users/${keycloakId}`)) {
      held = true;
      reached();
      await open;
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return { reached: parked, release };
}

describe('Keycloak projection vs a concurrent change (live Keycloak, ADR-060 § 5)', () => {
  const client = new KeycloakAdminClient({
    baseUrl: config.url,
    realm: config.realm,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    enabled: true,
  });
  const created: string[] = [];

  /** An account exactly as identity-service provisions one. */
  async function provisioned(): Promise<{ keycloakId: string; userId: string }> {
    const suffix = randomUUID().slice(0, 8);
    const userId = `USR_LIVE_${suffix.toUpperCase()}`;
    const keycloakId = await client.createUser({
      username: `live.race.${suffix}`,
      email: `live.race.${suffix}@example.test`,
      firstName: 'آزمون',
      lastName: 'مسابقه',
      attributes: platform(userId, ['OPERATOR']),
    });
    if (!keycloakId) throw new Error('createUser returned no id');
    created.push(keycloakId);
    return { keycloakId, userId };
  }

  /** Projects new roles, with `concurrently` run while the write is held after its read. */
  async function projectAround(
    keycloakId: string,
    attributes: PlatformAttributes,
    concurrently: () => Promise<unknown>,
  ): Promise<void> {
    const gate = holdNextWrite(keycloakId);
    try {
      const projection = client.replacePlatformAttributes(keycloakId, attributes);
      await gate.reached;
      await concurrently();
      gate.release();
      await projection;
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  afterAll(async () => {
    for (const id of created) await admin(`/users/${id}`, { method: 'DELETE' }).catch(() => {});
  });

  it('provisions the account the way the tests below assume', async () => {
    const { keycloakId, userId } = await provisioned();
    const user = await read(keycloakId);
    expect(user.requiredActions).toEqual(['UPDATE_PASSWORD']);
    expect(user.enabled).toBe(true);
    expect(user.emailVerified).toBe(false);
    expect(user.attributes?.rasta_user_id).toEqual([userId]);
  });

  it('keeps a required action completed while the projection was in flight', async () => {
    const { keycloakId, userId } = await provisioned();

    await projectAround(keycloakId, platform(userId, ['FLEET_MANAGER']), () =>
      change(keycloakId, { requiredActions: [] }),
    );

    const user = await read(keycloakId);
    expect(user.requiredActions).toEqual([]);
    expect(user.attributes?.organization_roles).toEqual(['ORG_LIVE_A:FLEET_MANAGER']);
  });

  it('keeps an account disabled while the projection was in flight disabled', async () => {
    // The security-relevant half of the bug: a projection used to re-enable
    // an account an administrator had just disabled.
    const { keycloakId, userId } = await provisioned();

    await projectAround(keycloakId, platform(userId, ['DRIVER']), () =>
      change(keycloakId, { enabled: false }),
    );

    const user = await read(keycloakId);
    expect(user.enabled).toBe(false);
    expect(user.attributes?.organization_roles).toEqual(['ORG_LIVE_A:DRIVER']);
  });

  it('keeps an email verified while the projection was in flight verified', async () => {
    const { keycloakId, userId } = await provisioned();

    await projectAround(keycloakId, platform(userId, ['OPERATOR', 'DRIVER']), () =>
      change(keycloakId, { emailVerified: true }),
    );

    const user = await read(keycloakId);
    expect(user.emailVerified).toBe(true);
    expect(user.attributes?.organization_roles?.sort()).toEqual(
      ['ORG_LIVE_A:DRIVER', 'ORG_LIVE_A:OPERATOR'].sort(),
    );
  });

  it('keeps all three at once, and leaves the profile as it was', async () => {
    const { keycloakId, userId } = await provisioned();
    const before = await read(keycloakId);

    await projectAround(keycloakId, platform(userId, ['ORGANIZATION_ADMIN']), () =>
      change(keycloakId, { requiredActions: [], enabled: false, emailVerified: true }),
    );

    const user = await read(keycloakId);
    expect(user).toMatchObject({
      requiredActions: [],
      enabled: false,
      emailVerified: true,
      username: before.username,
      email: before.email,
      firstName: before.firstName,
      lastName: before.lastName,
    });
    expect(user.attributes?.organization_roles).toEqual(['ORG_LIVE_A:ORGANIZATION_ADMIN']);
  });

  it('wins over a concurrent write of a platform attribute — it is their only writer', async () => {
    // T3. Someone other than identity-service writing `organization_roles`
    // is exactly what ADR-060 § 5 rules out; the projection is the owner, so
    // what it rebuilt from the database is what stays.
    const { keycloakId, userId } = await provisioned();

    await projectAround(keycloakId, platform(userId, ['OPERATOR']), async () => {
      const current = await read(keycloakId);
      await change(keycloakId, {
        email: current.email,
        firstName: current.firstName,
        lastName: current.lastName,
        attributes: { ...current.attributes, organization_roles: ['ORG_LIVE_A:SYSTEM_ADMIN'] },
      });
    });

    expect((await read(keycloakId)).attributes?.organization_roles).toEqual([
      'ORG_LIVE_A:OPERATOR',
    ]);
  });

  it('D-037: the residual is the profile fields, and only them', async () => {
    // Keycloak erases `email`, `firstName` and `lastName` from a body carrying
    // `attributes` unless they are sent, and it has no version check, so the
    // projection still reads and writes those three. A name changed inside
    // that window is lost. This pins the residual `docs/23` D-037 records: if
    // it ever stops holding, D-037 is wrong and must be revisited.
    const { keycloakId, userId } = await provisioned();

    await projectAround(keycloakId, platform(userId, ['OPERATOR']), () =>
      change(keycloakId, { firstName: 'نام‌تازه', requiredActions: [] }),
    );

    const user = await read(keycloakId);
    expect(user.firstName).toBe('آزمون');
    expect(user.requiredActions).toEqual([]);
  });
});
