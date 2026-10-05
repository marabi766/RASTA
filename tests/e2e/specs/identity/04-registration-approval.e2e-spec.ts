import { randomUUID } from 'node:crypto';
import { test, expect } from '../../src/api';
import { ORG } from '../../src/env';
import {
  enableSignIn,
  freshToken,
  membershipClaims,
  readAccount,
  updateAccount,
} from '../../src/keycloak-accounts';

/**
 * A self-registration, approved through the gateway, signs in (#219 r3).
 *
 * Black-box, against the real stack: what the race tests prove against a
 * Keycloak stand-in (`registration-approval-race.int-spec.ts`), here proven
 * against Keycloak itself — that an approval's account is enabled only after
 * the approval commits, carries the one-shot activation marker
 * (`rasta_activation`, which the realm's user profile must declare or
 * Keycloak drops it), and that an administrator's later disable survives a
 * projection.
 *
 * Gateway budget: the `registration-requests` prefix allows 5 calls per caller
 * per hour (`services/api-gateway/src/config/routes.ts`). This file makes one
 * anonymous call (the submission) and one as `system.admin` (the approval);
 * no other scenario uses either budget on that prefix.
 */
test.describe.serial('Self-registration approved through the gateway (#219)', () => {
  const username = `e2e.registration.${randomUUID().slice(0, 8)}`;
  let registrationId = '';
  let userId = '';

  test('an anonymous submission is accepted and creates no account', async ({
    request,
    config,
  }) => {
    const submitted = await request.fetch(`${config.gatewayUrl}/v1/registration-requests`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-correlation-id': `e2e-${randomUUID()}`,
      },
      data: {
        username,
        email: `${username}@example.test`,
        firstName: 'متقاضی',
        lastName: 'آزمون',
        requestedOrganizationId: ORG.a,
        requestedRoles: ['FLEET_MANAGER'],
      },
      failOnStatusCode: false,
    });
    expect(submitted.status()).toBe(201);
    registrationId = ((await submitted.json()) as { registrationId: string }).registrationId;
    expect(registrationId).not.toBe('');

    // Nothing in Keycloak until a reviewer decides.
    await expect(readAccount(username)).rejects.toThrow(/No Keycloak account/);
  });

  test('the approval commits, then enables the account once, marked with the request', async ({
    systemAdmin,
  }) => {
    const approved = await systemAdmin.post(`/v1/registration-requests/${registrationId}/approve`, {
      idempotencyKey: `e2e-registration-approve-${username}`,
      body: {},
    });
    expect(approved.status).toBe(200);
    const view = approved.body as { status: string; userId: string };
    expect(view.status).toBe('APPROVED');
    userId = view.userId;

    // The projection after commit ran in the request: enabled, with the
    // activation marker naming this request and the grants of the approval.
    const account = await readAccount(username);
    expect(account.enabled).toBe(true);
    expect(account.attributes?.rasta_activation).toEqual([registrationId]);
    expect(account.attributes?.rasta_user_id).toEqual([userId]);
  });

  test('the approved person signs in, and the gateway answers as them', async ({
    request,
    config,
  }) => {
    await enableSignIn(username);
    const token = await freshToken(username);
    expect(membershipClaims(token)).toEqual({
      rasta_uid: userId,
      org_id: ORG.a,
      org_ids: [ORG.a],
      org_roles: [`${ORG.a}:FLEET_MANAGER`],
    });

    const me = await request.fetch(`${config.gatewayUrl}/v1/users/me`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      failOnStatusCode: false,
    });
    expect(me.status()).toBe(200);
    const body = (await me.json()) as {
      id: string;
      memberships: { organizationId: string; roles: string[] }[];
    };
    expect(body.id).toBe(userId);
    expect(body.memberships).toEqual([
      expect.objectContaining({ organizationId: ORG.a, roles: ['FLEET_MANAGER'] }),
    ]);
  });

  test('an administrator’s disable survives the next projection: activation never runs twice', async ({
    systemAdmin,
  }) => {
    await updateAccount(username, { enabled: false });

    // A membership change projects the user again.
    const added = await systemAdmin.post(`/v1/users/${userId}/memberships`, {
      idempotencyKey: `e2e-registration-add-${username}`,
      body: { organizationId: ORG.b, roles: ['DRIVER'] },
    });
    expect(added.status).toBe(201);

    const account = await readAccount(username);
    expect(account.enabled).toBe(false);
    // The projection still wrote the grants it owns.
    expect(account.attributes?.organization_ids?.sort()).toEqual([ORG.a, ORG.b].sort());
  });
});
