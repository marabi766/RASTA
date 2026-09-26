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

  const userRow = (userId: string) =>
    runUnscoped('read back the fixture', () =>
      prisma.client.user.findUniqueOrThrow({ where: { id: userId } }),
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

  it('writes nothing at all when the organization asked for is already active', async () => {
    // Codex #114 R1-2: not only no event — no update, so no moved timestamp.
    const userId = await memberOfBoth();
    const before = await userRow(userId);

    await switchAs(userId, org.a);

    const after = await userRow(userId);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.updatedBy).toBe(before.updatedBy);
    expect(after.version).toBe(before.version);
    expect(await switchEvents(userId)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // The switch and a revocation of the same membership, racing (Codex #114
  // R1-1). Each test pauses the first transaction at its outbox write — after
  // it has taken the user lock and done its work, before it commits — proves
  // the second is blocked behind it, then lets the first commit.
  // -------------------------------------------------------------------------

  const membershipIn = async (userId: string, organizationId: string) =>
    (
      await runUnscoped('read back the fixture', () =>
        prisma.client.membership.findFirstOrThrow({ where: { userId, organizationId } }),
      )
    ).id;

  const revokeAsAdmin = (membershipId: string) =>
    asActor({ organizationId: org.b, userId: 'USR-SW-ADMIN', roles: ['ORGANIZATION_ADMIN'] }, () =>
      service.revokeMembership(membershipId, { reason: 'left the organization' }),
    );

  /** Holds the first `enqueueEvent` of `eventName` until released. */
  function gateOn(eventName: string) {
    let reached!: () => void;
    let release!: () => void;
    const atGate = new Promise<void>((resolve) => (reached = resolve));
    const open = new Promise<void>((resolve) => (release = resolve));
    const original = repository.enqueueEvent.bind(repository);
    let held = false;
    const spy = jest.spyOn(repository, 'enqueueEvent').mockImplementation(async (tx, input) => {
      if (!held && input.eventName === eventName) {
        held = true;
        reached();
        await open;
      }
      return original(tx, input);
    });
    return { atGate, release, restore: () => spy.mockRestore() };
  }

  /** Whether `promise` is still pending after `ms`. */
  async function stillPending(promise: Promise<unknown>, ms = 400): Promise<boolean> {
    const marker = Symbol('pending');
    const winner = await Promise.race([
      promise.then(
        () => undefined,
        () => undefined,
      ),
      new Promise((resolve) => setTimeout(() => resolve(marker), ms)),
    ]);
    return winner === marker;
  }

  it('refuses a switch that waited behind a revocation of that membership', async () => {
    const userId = await memberOfBoth();
    const inB = await membershipIn(userId, org.b);
    const gate = gateOn(IDENTITY_EVENTS.MEMBERSHIP_REVOKED);

    try {
      const revoking = revokeAsAdmin(inB);
      await gate.atGate; // the revocation holds the user lock, uncommitted

      const switching = switchAs(userId, org.b);
      expect(await stillPending(switching)).toBe(true);

      gate.release();
      await revoking;
      await expect(switching).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
    } finally {
      gate.restore();
    }

    expect(await activeOrganizationOf(userId)).toBe(org.a);
    expect(await switchEvents(userId)).toHaveLength(0);
  });

  it('moves the user off again when a revocation waited behind the switch', async () => {
    const userId = await memberOfBoth();
    const inB = await membershipIn(userId, org.b);
    const gate = gateOn(IDENTITY_EVENTS.ACTIVE_ORGANIZATION_SWITCHED);

    try {
      const switching = switchAs(userId, org.b);
      await gate.atGate; // the switch holds the user lock, uncommitted

      const revoking = revokeAsAdmin(inB);
      expect(await stillPending(revoking)).toBe(true);

      gate.release();
      await switching;
      await revoking;
    } finally {
      gate.restore();
    }

    // The switch committed first and was recorded; the revocation then saw it
    // and moved the user to the membership that is still live.
    expect(await activeOrganizationOf(userId)).toBe(org.a);
    expect(await switchEvents(userId)).toHaveLength(1);
    const revoked = await runUnscoped('read back the fixture', () =>
      prisma.client.membership.findUniqueOrThrow({ where: { id: inB } }),
    );
    expect(revoked.status).toBe('REVOKED');
  });
});
