import { runUnscoped } from '@rasta/nest-common';
import { IdentityRepository } from '../src/identity/identity.repository';
import { IdentityService } from '../src/identity/identity.service';
import { IDENTITY_EVENTS } from '../src/identity/events';
import type { KeycloakAdminClient } from '../src/keycloak/keycloak.client';
import { KeycloakProjector } from '../src/keycloak/keycloak.projector';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, id, newPrisma, tenants } from './helpers';

/**
 * The active-organization switch is audited (AGENTS.md S-06, global audit
 * L7-14), against a real database.
 *
 * `ACTIVE_ORGANIZATION_SWITCHED` is written by the same transaction that moves
 * `user.active_organization_id`, so the two commit together or not at all
 * (A-08). Keycloak is the one stand-in: it is called after the commit and has
 * no part in what is proven here.
 */
describe('active organization switch audit (L7-14)', () => {
  const org = tenants();
  const outsider = `${org.b}-X`;
  let prisma: PrismaService;
  let repository: IdentityRepository;
  let service: IdentityService;

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    await prisma.client.$queryRawUnsafe('SELECT 1');
    repository = new IdentityRepository(prisma);

    const keycloak = {
      enabled: true,
      replacePlatformAttributes: jest.fn(async () => undefined),
    } as unknown as KeycloakAdminClient;
    service = new IdentityService(
      repository,
      keycloak,
      new KeycloakProjector(repository, keycloak),
    );
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  /** A user active in `org.a`, a member of both `org.a` and `org.b`. */
  async function memberOfBoth(): Promise<string> {
    const userId = id('USR-SW');
    await runUnscoped('test fixture spans two organizations', async () => {
      await prisma.client.user.create({
        data: {
          id: userId,
          keycloakId: `kc-${userId}`,
          username: `sw-${userId.slice(-10)}`.toLowerCase(),
          email: `sw-${userId.slice(-10)}@example.test`.toLowerCase(),
          firstName: 'آزمون',
          lastName: 'تغییر',
          status: 'ACTIVE',
          activeOrganizationId: org.a,
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
        },
      });
      await prisma.client.membership.createMany({
        data: [org.a, org.b].map((organizationId) => ({
          id: id('MBR-SW'),
          userId,
          organizationId,
          roles: ['OPERATOR'],
          validFrom: new Date(Date.now() - 3600_000),
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
        })),
      });
    });
    return userId;
  }

  const switchAs = (userId: string, organizationId: string) =>
    asActor({ organizationId: org.a, userId, roles: ['OPERATOR'] }, () =>
      service.switchActiveOrganization({ organizationId }),
    );

  const switchEvents = (userId: string) =>
    runUnscoped('the outbox audit reads platform plumbing', () =>
      prisma.client.outboxMessage.findMany({
        where: { aggregateId: userId, eventName: IDENTITY_EVENTS.ACTIVE_ORGANIZATION_SWITCHED },
      }),
    );

  const activeOrganizationOf = async (userId: string) =>
    (
      await runUnscoped('read back the fixture', () =>
        prisma.client.user.findUniqueOrThrow({ where: { id: userId } }),
      )
    ).activeOrganizationId;

  it('commits exactly one event with the switching user as actor, filed under the new tenant', async () => {
    const userId = await memberOfBoth();

    await switchAs(userId, org.b);

    expect(await activeOrganizationOf(userId)).toBe(org.b);
    const rows = await switchEvents(userId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    const envelope = row.payload as {
      tenantId?: string;
      actor?: { type: string; id: string };
      aggregateType: string;
      payload: Record<string, unknown>;
    };

    expect(row.topic).toBe('rasta.identity.v1');
    // Tenant: the organization the user now acts for, on the column the relay
    // filters by and on the envelope audit-service stores.
    expect(row.organizationId).toBe(org.b);
    expect(envelope.tenantId).toBe(org.b);
    expect(envelope.actor).toEqual({ type: 'USER', id: userId });
    expect(envelope.aggregateType).toBe('User');
    // Identifiers only — no name, email or token (the events.ts rule).
    expect(envelope.payload).toEqual({
      userId,
      previousOrganizationId: org.a,
      organizationId: org.b,
    });
  });

  it('rolls the switch and its event back together', async () => {
    const userId = await memberOfBoth();
    const original = repository.enqueueEvent.bind(repository);
    // Fails *after* the outbox insert, inside the same transaction: if the two
    // writes were not atomic, one of them would survive.
    const spy = jest.spyOn(repository, 'enqueueEvent').mockImplementationOnce(async (tx, input) => {
      await original(tx, input);
      throw new Error('failure after the outbox insert');
    });

    try {
      await expect(switchAs(userId, org.b)).rejects.toThrow('failure after the outbox insert');
    } finally {
      spy.mockRestore();
    }

    expect(await activeOrganizationOf(userId)).toBe(org.a);
    expect(await switchEvents(userId)).toHaveLength(0);
  });

  it('writes neither a switch nor an event for an organization the user does not belong to', async () => {
    // Tenant isolation: the refusal (recorded on the audit trail by the
    // refusal filter, not here) must not leave a record that files the user
    // under a tenant they have no membership in.
    const userId = await memberOfBoth();

    await expect(switchAs(userId, outsider)).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });

    expect(await activeOrganizationOf(userId)).toBe(org.a);
    expect(await switchEvents(userId)).toHaveLength(0);
    const underOutsider = await runUnscoped('the outbox audit reads platform plumbing', () =>
      prisma.client.outboxMessage.count({ where: { organizationId: outsider } }),
    );
    expect(underOutsider).toBe(0);
  });

  it('records nothing when the organization asked for is already active', async () => {
    const userId = await memberOfBoth();

    await switchAs(userId, org.a);

    expect(await switchEvents(userId)).toHaveLength(0);
  });
});
