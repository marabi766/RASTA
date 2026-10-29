import { randomUUID } from 'node:crypto';
import { test, expect, Actor, SessionToken, until } from '../../src/api';
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
 * The submission's answer carries no id (task 117, F5: it is the same
 * acknowledgement whether or not the username or email was already held), so
 * the reviewer finds the request in the review queue,
 * `GET /v1/registration-requests`, by the applicant's username — once the
 * registration worker has recorded it: the submission only writes an intake
 * row (task 130, R5), and the worker runs every
 * `REGISTRATION_INTAKE_INTERVAL_SECONDS` (default 5), so the queue is polled.
 *
 * Gateway budget: the submission, `POST /v1/registration-requests`, allows 5
 * calls per caller per hour (`services/api-gateway/src/config/routes.ts`);
 * this file makes one, anonymously. The queue reads and the approval are on
 * the platform default, in a bucket of their own (task 130, R6).
 *
 * The submission's audit record (`GET /v1/audit-events`, path A) is
 * `ANONYMOUS` with no id: an unauthenticated request, recorded as such, not as
 * `SYSTEM / identity-service` background work (PR #483 r3 F1).
 */
/** Several registration worker intervals (default 5 s): the queue is polled until then. */
const QUEUE_WAIT_MS = 30_000;

test.describe.serial('Self-registration approved through the gateway (#219)', () => {
  const username = `e2e.registration.${randomUUID().slice(0, 8)}`;
  let registrationId = '';
  let userId = '';
  /** The correlation id the submission was answered under (the gateway echoes it). */
  let submittedCorrelationId = '';

  test('an anonymous submission is acknowledged, and creates no account', async ({
    request,
    config,
  }) => {
    const submitted = await request.fetch(`${config.gatewayUrl}/v1/registration-requests`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-correlation-id': randomUUID(),
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
    // The one acknowledgement every valid submission gets, byte for byte.
    expect(submitted.status()).toBe(202);
    expect(await submitted.text()).toBe('{"status":"RECEIVED"}');
    submittedCorrelationId = submitted.headers()['x-correlation-id'] ?? '';
    expect(submittedCorrelationId).not.toBe('');

    // Nothing in Keycloak until a reviewer decides.
    await expect(readAccount(username)).rejects.toThrow(/No Keycloak account/);
  });

  test('the reviewer finds it in the review queue, once the worker has recorded it', async ({
    systemAdmin,
  }) => {
    type Item = { id: string; username: string; status: string };
    const items = await until(
      'the registration in the review queue',
      async () => {
        const queue = await systemAdmin.get(
          `/v1/registration-requests?status=PENDING&username=${encodeURIComponent(username)}`,
        );
        expect(queue.status).toBe(200);
        const found = (queue.body as { items: Item[] }).items;
        return found.length > 0 ? found : undefined;
      },
      QUEUE_WAIT_MS,
    );
    expect(items).toEqual([expect.objectContaining({ username, status: 'PENDING' })]);
    registrationId = items[0]!.id;
  });

  test('its audit record says the submission was anonymous — not the service’s own work (PR #483 r3 F1)', async ({
    systemAdmin,
  }) => {
    // REGISTRATION_SUBMITTED, built by the worker after the request ended,
    // relayed to rasta.identity.v1 and projected by audit-service (path A).
    // Without an explicit anonymous origin it read as SYSTEM / identity-service.
    type AuditRow = {
      actorType: string;
      actorId: string | null;
      sourceService: string;
      sourceTopic: string;
      correlationId: string;
    };
    const to = new Date(Date.now() + 60_000);
    const parameters = new URLSearchParams({
      from: new Date(to.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      to: to.toISOString(),
      organizationId: ORG.a,
      resourceType: 'RegistrationRequest',
      resourceId: registrationId,
      limit: '10',
    }).toString();
    const records = await until(
      `the audit record of registration ${registrationId}`,
      async () => {
        const page = await systemAdmin.get(`/v1/audit-events?${parameters}`);
        expect(page.status).toBe(200);
        const items = (page.body as { items: AuditRow[] }).items;
        return items.length > 0 ? items : undefined;
      },
      // The relay's poll, then audit-service's consumer transaction.
      QUEUE_WAIT_MS + 60_000,
    );
    expect(records).toEqual([
      expect.objectContaining({
        actorType: 'ANONYMOUS',
        actorId: null,
        sourceService: 'identity-service',
        sourceTopic: 'rasta.identity.v1',
        correlationId: submittedCorrelationId,
      }),
    ]);
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

  test('the approved person signs in, and the gateway answers as them', async ({ config }) => {
    await enableSignIn(username);
    const token = await freshToken(username);
    expect(membershipClaims(token)).toEqual({
      rasta_uid: userId,
      org_id: ORG.a,
      org_ids: [ORG.a],
      org_roles: [`${ORG.a}:FLEET_MANAGER`],
    });

    // As an `Actor`, so the bearer token never passes through Playwright's request context.
    const person = new Actor(username, new SessionToken(token, () => freshToken(username)), config);
    const me = await person.get('/v1/users/me');
    expect(me.status).toBe(200);
    const body = me.body as {
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
