import request from 'supertest';
import { runUnscoped } from '@rasta/nest-common';
import { platformAttributesFor } from '../src/keycloak/platform-attributes';
import { startIdentityApi, userToken, type IdentityApiHarness } from './api-helpers';
import { id, tenants } from './helpers';
import { KeycloakHttpStub } from './keycloak-http-stub';

/**
 * D-064 through the HTTP surface: the real `AppModule` — auth and roles
 * guards, the controllers, `zodPipe`, the refusal filter — over a real
 * PostgreSQL, with Keycloak stubbed at the HTTP boundary only
 * (`keycloak-http-stub.ts`, the real `KeycloakAdminClient`).
 *
 * What a caller sees: a demotion or revocation Keycloak cannot take answers
 * `503` with the fixed code `KEYCLOAK_UNAVAILABLE` and nothing about Keycloak's
 * answer, and nothing changed; another organization's administrator is
 * refused before Keycloak is called; and a request repeated because its
 * answer never arrived — the gateway gives up after 3 s
 * (`GATEWAY_UPSTREAM_TIMEOUT_MS`), while identity may take up to the Keycloak
 * client's 10 s per call to finish — answers the same, with one event.
 */
describe('narrowing over HTTP (D-064)', () => {
  let harness: IdentityApiHarness;
  let stub: KeycloakHttpStub;

  beforeAll(async () => {
    stub = new KeycloakHttpStub();
    await stub.start();
    harness = await startIdentityApi({ keycloak: { url: stub.url, requestTimeoutMs: 5_000 } });
  });

  afterAll(async () => {
    await harness?.close();
    await stub?.close();
  });

  async function seed(roles: string[]) {
    const org = tenants();
    const userId = id('USR-WAH');
    const membershipId = id('MBR-WAH');
    const keycloakId = `kc-${userId.slice(-16).toLowerCase()}`;
    const user = {
      id: userId,
      keycloakId,
      username: `wah-${userId.slice(-12)}`.toLowerCase(),
      email: `wah-${userId.slice(-12)}@example.test`.toLowerCase(),
      firstName: 'آزمون',
      lastName: 'درگاه',
      status: 'ACTIVE' as const,
      activeOrganizationId: org.a,
      createdBy: 'ITEST',
      updatedBy: 'ITEST',
    };
    await runUnscoped('test fixture', async () => {
      await harness.prisma.client.user.create({ data: user });
      await harness.prisma.client.membership.create({
        data: {
          id: membershipId,
          userId,
          organizationId: org.a,
          roles,
          validFrom: new Date(Date.now() - 60_000),
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
        },
      });
    });
    stub.add({
      id: keycloakId,
      username: user.username,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      attributes: platformAttributesFor(
        user,
        [
          {
            organizationId: org.a,
            roles,
            status: 'ACTIVE',
            validFrom: new Date(0),
            validUntil: null,
          },
        ],
        new Date(),
      ),
    });
    return { org, userId, membershipId, keycloakId };
  }

  const admin = (organizationId: string) =>
    `Bearer ${userToken({ userId: 'USR-WAH-ADMIN', organizationId, roles: ['ORGANIZATION_ADMIN'] })}`;

  const roles = (membershipId: string, organizationId: string, next: string[]) =>
    request(harness.app.getHttpServer())
      .post(`/v1/memberships/${membershipId}/roles`)
      .set('authorization', admin(organizationId))
      .send({ roles: next, reason: 'write-ahead over http' });

  const revoke = (membershipId: string, organizationId: string) =>
    request(harness.app.getHttpServer())
      .post(`/v1/memberships/${membershipId}/revoke`)
      .set('authorization', admin(organizationId))
      .send({ reason: 'write-ahead over http' });

  const membership = (membershipId: string) =>
    runUnscoped('test reads what committed', () =>
      harness.prisma.client.membership.findFirst({ where: { id: membershipId } }),
    );

  const eventNames = async (aggregateId: string) =>
    (
      await runUnscoped('test reads the outbox', () =>
        harness.prisma.client.outboxMessage.findMany({
          where: { aggregateId },
          orderBy: { createdAt: 'asc' },
        }),
      )
    ).map((event) => event.eventName);

  /** The fixed 503, and nothing of what Keycloak answered. */
  function expectKeycloakUnavailable(response: request.Response): void {
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('KEYCLOAK_UNAVAILABLE');
    expect(response.body.details).toBeUndefined();
    const text = JSON.stringify(response.body);
    expect(text).not.toMatch(/keycloak(?!_unavailable)/i);
    expect(text).not.toMatch(/stub|403|refused|ECONN|127\.0\.0\.1/i);
  }

  it('a demotion while Keycloak refuses: 503 KEYCLOAK_UNAVAILABLE, the roles unchanged, no event', async () => {
    const s = await seed(['ORGANIZATION_ADMIN', 'OPERATOR']);
    stub.nextPut('refuse', 403);

    const response = await roles(s.membershipId, s.org.a, ['OPERATOR']);

    expectKeycloakUnavailable(response);
    expect((await membership(s.membershipId))?.roles).toEqual(['ORGANIZATION_ADMIN', 'OPERATOR']);
    expect(await eventNames(s.membershipId)).toEqual([]);
  });

  it('a revocation while Keycloak is down: 503 KEYCLOAK_UNAVAILABLE, still live, no event', async () => {
    const s = await seed(['OPERATOR']);
    await stub.down();
    let response: request.Response;
    try {
      response = await revoke(s.membershipId, s.org.a);
    } finally {
      await stub.up();
    }

    expectKeycloakUnavailable(response);
    expect(await membership(s.membershipId)).toMatchObject({ status: 'ACTIVE', deletedAt: null });
    expect(await eventNames(s.membershipId)).toEqual([]);
  });

  it('another organization’s administrator: 404 for either command, and Keycloak is never called', async () => {
    const s = await seed(['OPERATOR', 'DRIVER']);
    const before = stub.requests.length;

    expect((await roles(s.membershipId, s.org.b, ['OPERATOR'])).status).toBe(404);
    expect((await revoke(s.membershipId, s.org.b)).status).toBe(404);

    expect(stub.requests).toHaveLength(before);
    expect((await membership(s.membershipId))?.roles).toEqual(['OPERATOR', 'DRIVER']);
  });

  it('a demotion and a revocation that Keycloak takes: 200 and 204, written ahead, one event each', async () => {
    const s = await seed(['ORGANIZATION_ADMIN', 'OPERATOR']);

    const demoted = await roles(s.membershipId, s.org.a, ['OPERATOR']);
    expect(demoted.status).toBe(200);
    expect(demoted.body.roles).toEqual(['OPERATOR']);
    expect(stub.platform(s.keycloakId).organization_roles).toEqual([`${s.org.a}:OPERATOR`]);

    expect((await revoke(s.membershipId, s.org.a)).status).toBe(204);
    expect(stub.platform(s.keycloakId).organization_ids).toEqual([]);
    expect(await eventNames(s.membershipId)).toEqual(['ROLE_REVOKED', 'MEMBERSHIP_REVOKED']);
  });

  it('the caller gives up first — as the gateway does after 3 s — and identity finishes; the retry answers the same, with one event', async () => {
    const s = await seed(['ORGANIZATION_ADMIN', 'OPERATOR']);
    // Keycloak is slow: the write-ahead takes longer than the caller waits.
    stub.nextPut('delay', 1_500);

    const abandoned = await roles(s.membershipId, s.org.a, ['OPERATOR'])
      .timeout(300)
      .then(
        () => 'answered',
        (error: { timeout?: number }) => (error.timeout ? 'timed out' : 'failed'),
      );
    expect(abandoned).toBe('timed out');

    // Repeated at once: it waits on the user lock the first still holds, then
    // reads what the first committed, and changes nothing more.
    const retried = await roles(s.membershipId, s.org.a, ['OPERATOR']);
    expect(retried.status).toBe(200);
    expect(retried.body.roles).toEqual(['OPERATOR']);
    expect(await eventNames(s.membershipId)).toEqual(['ROLE_REVOKED']);

    // And a revocation sent twice: 204 both times, one event.
    expect((await revoke(s.membershipId, s.org.a)).status).toBe(204);
    expect((await revoke(s.membershipId, s.org.a)).status).toBe(204);
    expect(await eventNames(s.membershipId)).toEqual(['ROLE_REVOKED', 'MEMBERSHIP_REVOKED']);
  });
});
