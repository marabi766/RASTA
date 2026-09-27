import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../../src/api';
import { ORG } from '../../src/env';
import {
  enableSignIn,
  freshToken,
  membershipClaims,
  readAccount,
  readOwnAccount,
  updateAccount,
  writeOwnAccount,
} from '../../src/keycloak-accounts';

/**
 * ADR-060 PR A, against a live Keycloak: membership reaches the token.
 *
 * Every assertion here is one that no unit test can make, because each is a
 * claim about Keycloak itself — its user profile, its protocol mappers, and
 * how its Admin API treats what identity-service writes:
 *
 * - An account provisioned **through the API** carries `rasta_uid`, `org_id`,
 *   `org_ids` and `org_roles`. Before this change Keycloak 26 silently
 *   dropped every attribute identity-service wrote, because the realm
 *   declared none of them, and `rasta_user_id` was never written at all.
 * - A **demotion** is gone from the next token. Roles used to reach Keycloak
 *   only when the account was created.
 * - A **revoked** organization leaves `org_ids`, and when it was the active
 *   one, `org_id` moves to the organization that remains.
 * - The user can neither read nor write `organization_roles` from their own
 *   account console. Authorization will be built from it (PR B).
 * - A projection writes **only what identity-service owns**: a completed
 *   required action, a verified email and — security-relevant — a disabled
 *   account all survive it (ADR-060 § 5, `docs/23` D-037). It used to write
 *   the whole user back, which put `UPDATE_PASSWORD` back after
 *   `enableSignIn` (the flake this file had) and re-enabled disabled accounts.
 *
 * Nothing here depends on the guard reading `org_roles` yet — that is PR B.
 * What is proven is that the token says what the database says.
 */
test.describe.serial('Keycloak projection of memberships (ADR-060 § 5)', () => {
  const username = `e2e.projection.${randomUUID().slice(0, 8)}`;
  let userId = '';
  let membershipInA = '';
  let membershipInB = '';

  test('an account provisioned through the API gets every claim in its first token', async ({
    systemAdmin,
  }) => {
    const created = await systemAdmin.post('/v1/users', {
      idempotencyKey: `e2e-projection-create-${username}`,
      body: {
        username,
        email: `${username}@example.test`,
        firstName: 'آزمون',
        lastName: 'تصویر',
        organizationId: ORG.a,
        roles: ['FLEET_MANAGER', 'OPERATOR'],
      },
    });
    expect(created.status).toBe(201);
    userId = (created.body as { id: string }).id;

    await enableSignIn(username);
    const claims = membershipClaims(await freshToken(username));

    expect(claims).toEqual({
      rasta_uid: userId,
      org_id: ORG.a,
      org_ids: [ORG.a],
      org_roles: expect.arrayContaining([`${ORG.a}:FLEET_MANAGER`, `${ORG.a}:OPERATOR`]),
    });
    expect(claims.org_roles).toHaveLength(2);
  });

  // Demotion and revocation are done by organization A's own administrator:
  // membership lookups are tenant-scoped, and administering A's members is
  // exactly their job.
  test('a demotion is gone from the next token', async ({ tenantA, request, config }) => {
    const me = await request.fetch(`${config.gatewayUrl}/v1/users/me`, {
      headers: {
        authorization: `Bearer ${await freshToken(username)}`,
        accept: 'application/json',
      },
    });
    expect(me.status()).toBe(200);
    const memberships = (
      (await me.json()) as { memberships: { id: string; organizationId: string }[] }
    ).memberships;
    membershipInA = memberships.find((membership) => membership.organizationId === ORG.a)!.id;

    const demoted = await tenantA.post(`/v1/memberships/${membershipInA}/roles`, {
      idempotencyKey: `e2e-projection-demote-${username}`,
      body: { roles: ['OPERATOR'], reason: 'No longer manages the fleet.' },
    });
    expect(demoted.status).toBe(200);

    expect(membershipClaims(await freshToken(username)).org_roles).toEqual([`${ORG.a}:OPERATOR`]);
  });

  test('a new membership reaches the next token', async ({ systemAdmin }) => {
    const added = await systemAdmin.post(`/v1/users/${userId}/memberships`, {
      idempotencyKey: `e2e-projection-add-${username}`,
      body: { organizationId: ORG.b, roles: ['DRIVER'] },
    });
    expect(added.status).toBe(201);
    membershipInB = (added.body as { id: string }).id;

    const claims = membershipClaims(await freshToken(username));
    expect(claims.org_ids?.sort()).toEqual([ORG.a, ORG.b].sort());
    expect(claims.org_roles?.sort()).toEqual([`${ORG.a}:OPERATOR`, `${ORG.b}:DRIVER`].sort());
    // Still acting for A; adding a membership does not move anyone.
    expect(claims.org_id).toBe(ORG.a);
  });

  test('revoking the active organization removes it and moves org_id to what remains', async ({
    tenantA,
  }) => {
    const revoked = await tenantA.post(`/v1/memberships/${membershipInA}/revoke`, {
      idempotencyKey: `e2e-projection-revoke-${username}`,
      body: { reason: 'Left the organization.' },
    });
    expect(revoked.status).toBe(204);

    expect(membershipClaims(await freshToken(username))).toEqual({
      rasta_uid: userId,
      org_id: ORG.b,
      org_ids: [ORG.b],
      org_roles: [`${ORG.b}:DRIVER`],
    });
    expect(membershipInB).not.toBe('');
  });

  test('the account console can neither show nor change organization_roles', async () => {
    const token = await freshToken(username);

    const own = await readOwnAccount(token);
    expect(own.status).toBe(200);
    // Not in the attributes the user is shown, and not declared to them at all.
    expect(JSON.stringify(own.body.attributes ?? {})).not.toContain('organization_roles');
    const declared = (
      own.body.userProfileMetadata as { attributes: { name: string }[] }
    ).attributes.map((attribute) => attribute.name);
    expect(declared).not.toContain('organization_roles');
    expect(declared).not.toContain('organization_ids');

    const attempt = await writeOwnAccount(token, {
      ...own.body,
      attributes: { organization_roles: [`${ORG.b}:SYSTEM_ADMIN`] },
    });
    expect(attempt.status).toBe(400);

    // And the next token is exactly what it was.
    expect(membershipClaims(await freshToken(username)).org_roles).toEqual([`${ORG.b}:DRIVER`]);
  });

  // No wait for the asynchronous projections of `USER_ACTIVATED` and
  // `MEMBERSHIP_CREATED` anywhere above, and none is needed: they and
  // `enableSignIn` write disjoint fields, so they commute. The role changes
  // below are projected on the request path before their 200.
  test('a projection keeps what it does not own: a completed required action and a verified email', async ({
    tenantB,
  }) => {
    await updateAccount(username, { emailVerified: true });

    const changed = await tenantB.post(`/v1/memberships/${membershipInB}/roles`, {
      idempotencyKey: `e2e-projection-widen-${username}`,
      body: { roles: ['DRIVER', 'OPERATOR'], reason: 'Also operates the site equipment.' },
    });
    expect(changed.status).toBe(200);

    const account = await readAccount(username);
    expect(account.requiredActions).toEqual([]);
    expect(account.emailVerified).toBe(true);
    expect(account.enabled).toBe(true);
    expect(membershipClaims(await freshToken(username)).org_roles?.sort()).toEqual(
      [`${ORG.b}:DRIVER`, `${ORG.b}:OPERATOR`].sort(),
    );
  });

  // Last in this block: the account cannot sign in afterwards.
  test('a projection never re-enables an account an administrator disabled', async ({
    tenantB,
    request,
    config,
  }) => {
    // Security-relevant: the whole-user write used to send `enabled: true`
    // back over an administrator's disable.
    await updateAccount(username, { enabled: false });
    const eventProjectionsBefore = await eventProjections(request, config.identityUrl);

    const narrowed = await tenantB.post(`/v1/memberships/${membershipInB}/roles`, {
      idempotencyKey: `e2e-projection-narrow-${username}`,
      body: { roles: ['DRIVER'], reason: 'No longer operates the site equipment.' },
    });
    expect(narrowed.status).toBe(200);
    // The request-path projection has landed; so has the attribute it wrote.
    expect((await readAccount(username)).attributes?.organization_roles).toEqual([
      `${ORG.b}:DRIVER`,
    ]);

    // And the event-path one, from the `ROLE_REVOKED` the change enqueued.
    // The suite runs on one worker, so the counter moves for this change.
    await expect
      .poll(() => eventProjections(request, config.identityUrl), { timeout: 30_000 })
      .toBeGreaterThan(eventProjectionsBefore);

    expect((await readAccount(username)).enabled).toBe(false);
    await expect(freshToken(username)).rejects.toThrow(/refused a token/);
  });
});

/** Event-path projections that landed, from identity-service's own metrics. */
async function eventProjections(request: APIRequestContext, identityUrl: string): Promise<number> {
  const response = await request.get(`${identityUrl}/metrics`);
  expect(response.status()).toBe(200);
  const line = (await response.text())
    .split('\n')
    .find(
      (row) =>
        row.startsWith('rasta_identity_keycloak_projections_total{') &&
        row.includes('trigger="event"') &&
        row.includes('outcome="projected"'),
    );
  return line ? Number(line.split(' ').pop()) : 0;
}
