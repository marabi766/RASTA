import { randomUUID } from 'node:crypto';
import { test, expect, Actor, SessionToken } from '../../src/api';
import { ORG } from '../../src/env';
import { enableSignIn, freshToken, membershipClaims } from '../../src/keycloak-accounts';

/**
 * A demoted administrator's old token cannot give them their role back
 * (task 117, audit F1), against the real stack: Keycloak's token, the
 * gateway, identity-service and its database.
 *
 * A token outlives a demotion by up to 905 s (ADR-060 § 7). Every guard
 * authorizes from the token, and until this change identity's administration
 * routes did too — so inside that window the demoted person could
 * `POST /v1/memberships/<own>/roles` with their old role, and keep it for good.
 * Identity now decides on the caller's live membership, read under the
 * write's locks. What is proven here end to end: the old token still passes
 * every token check on the way in (it is valid, signed, unexpired), and the
 * write is refused all the same; nothing changes, and the next token says
 * what the database says.
 */
test.describe.serial('A demoted administrator’s old token (task 117, F1)', () => {
  const username = `e2e.live.${randomUUID().slice(0, 8)}`;
  let oldToken = '';
  let membershipId = '';

  test('an administrator provisioned through the API, with the token they sign in with', async ({
    systemAdmin,
    config,
  }) => {
    const created = await systemAdmin.post('/v1/users', {
      idempotencyKey: `e2e-live-create-${username}`,
      body: {
        username,
        email: `${username}@example.test`,
        firstName: 'آزمون',
        lastName: 'اختیار',
        organizationId: ORG.a,
        roles: ['ORGANIZATION_ADMIN'],
      },
    });
    expect(created.status).toBe(201);

    await enableSignIn(username);
    oldToken = await freshToken(username);
    expect(membershipClaims(oldToken).org_roles).toEqual([`${ORG.a}:ORGANIZATION_ADMIN`]);

    const me = await holder(config).get('/v1/users/me');
    expect(me.status).toBe(200);
    membershipId = (
      me.body as { memberships: { id: string; organizationId: string }[] }
    ).memberships.find((membership) => membership.organizationId === ORG.a)!.id;
  });

  test('demoted by their organization’s administrator', async ({ tenantA }) => {
    const demoted = await tenantA.post(`/v1/memberships/${membershipId}/roles`, {
      idempotencyKey: `e2e-live-demote-${username}`,
      body: { roles: ['OPERATOR'], reason: 'No longer administers the organization.' },
    });
    expect(demoted.status).toBe(200);
  });

  test('the old token, still valid, cannot grant the role back: 403, and nothing changed', async ({
    config,
  }) => {
    const person = holder(config);

    const regrant = await person.post(`/v1/memberships/${membershipId}/roles`, {
      idempotencyKey: `e2e-live-regrant-${username}`,
      body: { roles: ['OPERATOR', 'ORGANIZATION_ADMIN'], reason: 'restore' },
    });

    expect(regrant.status).toBe(403);
    expect((regrant.body as { code: string }).code).toBe('INSUFFICIENT_ROLE');
    // The same token reads their own record: the database says OPERATOR.
    const me = await person.get('/v1/users/me');
    expect(
      (me.body as { memberships: { id: string; roles: string[] }[] }).memberships.find(
        (membership) => membership.id === membershipId,
      )?.roles,
    ).toEqual(['OPERATOR']);
    // And so does the next token.
    expect(membershipClaims(await freshToken(username)).org_roles).toEqual([`${ORG.a}:OPERATOR`]);
  });

  /** An actor that holds on to the token issued before the demotion, and never renews it. */
  function holder(config: ConstructorParameters<typeof Actor>[2]): Actor {
    return new Actor(
      username,
      new SessionToken(oldToken, () =>
        Promise.reject(new Error('this scenario keeps the token issued before the demotion')),
      ),
      config,
    );
  }
});
