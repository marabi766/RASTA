import { randomUUID } from 'node:crypto';
import { test, expect } from '../../src/api';
import { ORG } from '../../src/env';
import {
  enableSignIn,
  freshToken,
  membershipClaims,
  readOwnAccount,
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
});
