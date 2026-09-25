import { runUnscoped } from '@rasta/nest-common';
import { IdentityRepository } from '../src/identity/identity.repository';
import { IdentityService } from '../src/identity/identity.service';
import { MembershipExpiryScanner } from '../src/identity/membership-expiry.scanner';
import type { KeycloakAdminClient } from '../src/keycloak/keycloak.client';
import { KeycloakProjector } from '../src/keycloak/keycloak.projector';
import type { PlatformAttributes } from '../src/keycloak/platform-attributes';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, id, newPrisma, tenants } from './helpers';

/**
 * ADR-060 § 5 — a membership's validUntil is enforced, against a real
 * database and with a controlled clock.
 *
 * Only `Date` is faked: Prisma's own timers and the pool keep real time, while
 * every `new Date()` the service reads — the switch, the projection — is the
 * instant the test chooses. Keycloak is the one stand-in: a recorder of the
 * attribute sets the projector writes, which is exactly what reaches the token.
 *
 * The same membership is observed on both sides of its validUntil: before,
 * switching to it works and org_ids carries it; after, the switch is refused,
 * the sweep records the expiry once and moves the user off it, and the
 * projection no longer names it.
 */
describe('membership validUntil (ADR-060 § 5)', () => {
  const org = tenants();
  let prisma: PrismaService;
  let repository: IdentityRepository;
  let service: IdentityService;
  let scanner: MembershipExpiryScanner;
  const written: Array<{ keycloakId: string; attributes: PlatformAttributes }> = [];

  const userId = id('USR-EXP');
  const inA = id('MBR-EXP-A');
  const inB = id('MBR-EXP-B');

  // A validUntil far enough ahead of the real clock that nothing else in the
  // database can have seen it pass.
  const validUntil = new Date(Date.now() + 24 * 3600 * 1000);
  const before = new Date(validUntil.getTime() - 60_000);
  const after = new Date(validUntil.getTime() + 60_000);

  const setClock = (now: Date) => jest.setSystemTime(now);

  beforeAll(async () => {
    jest.useFakeTimers({
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    setClock(before);

    prisma = newPrisma();
    await prisma.onModuleInit();
    await prisma.client.$queryRawUnsafe('SELECT 1');
    repository = new IdentityRepository(prisma);

    const keycloak = {
      enabled: true,
      replacePlatformAttributes: jest.fn(
        async (keycloakId: string, attributes: PlatformAttributes) => {
          written.push({ keycloakId, attributes });
        },
      ),
    } as unknown as KeycloakAdminClient;
    const projector = new KeycloakProjector(repository, keycloak);
    service = new IdentityService(repository, keycloak, projector);
    scanner = new MembershipExpiryScanner(repository, service, {
      enabled: false,
      intervalSeconds: 60,
      batchSize: 500,
    });

    await runUnscoped('test fixture spans two organizations', async () => {
      await prisma.client.user.create({
        data: {
          id: userId,
          keycloakId: `kc-${userId}`,
          username: `exp-${userId.slice(-10)}`.toLowerCase(),
          email: `exp-${userId.slice(-10)}@example.test`.toLowerCase(),
          firstName: 'آزمون',
          lastName: 'انقضا',
          status: 'ACTIVE',
          activeOrganizationId: org.a,
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
        },
      });
      await prisma.client.membership.createMany({
        data: [
          {
            id: inA,
            userId,
            organizationId: org.a,
            roles: ['OPERATOR'],
            validFrom: new Date(before.getTime() - 3600_000),
            createdBy: 'ITEST',
            updatedBy: 'ITEST',
          },
          {
            id: inB,
            userId,
            organizationId: org.b,
            roles: ['DRIVER'],
            validFrom: new Date(before.getTime() - 3600_000),
            validUntil,
            createdBy: 'ITEST',
            updatedBy: 'ITEST',
          },
        ],
      });
    });
  });

  afterAll(async () => {
    jest.useRealTimers();
    await prisma.onModuleDestroy();
  });

  const asUser = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.a, userId, roles: ['OPERATOR'] }, fn);

  const latest = () => written.at(-1)?.attributes;

  const expiredEvents = () =>
    runUnscoped('the outbox is platform plumbing', () =>
      prisma.client.outboxMessage.findMany({
        where: { aggregateId: inB, eventName: 'MEMBERSHIP_EXPIRED' },
      }),
    );

  it('before validUntil: the switch works and org_ids carries the organization', async () => {
    setClock(before);

    await expect(
      asUser(() => service.switchActiveOrganization({ organizationId: org.b })),
    ).resolves.toMatchObject({ activeOrganizationId: org.b });

    expect(latest()).toEqual({
      rasta_user_id: [userId],
      organization_ids: [org.a, org.b].sort(),
      organization_roles: [`${org.a}:OPERATOR`, `${org.b}:DRIVER`].sort(),
      active_organization_id: [org.b],
    });

    // Nothing has lapsed yet, so the sweep leaves it alone.
    await scanner.scan(before);
    expect(await expiredEvents()).toHaveLength(0);
  });

  it('after validUntil: the sweep records the expiry once, moves the user, and the token drops it', async () => {
    setClock(after);

    await scanner.scan(after);

    const events = await expiredEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.organizationId).toBe(org.b);
    expect((events[0]!.payload as { payload: unknown }).payload).toEqual({
      membershipId: inB,
      userId,
      organizationId: org.b,
      validUntil: validUntil.toISOString(),
    });

    const user = await prisma.client.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.activeOrganizationId).toBe(org.a);
    expect(latest()).toEqual({
      rasta_user_id: [userId],
      organization_ids: [org.a],
      organization_roles: [`${org.a}:OPERATOR`],
      active_organization_id: [org.a],
    });

    // Handled once: a second pass — another replica, or a restart — finds nothing.
    const writes = written.length;
    await scanner.scan(new Date(after.getTime() + 60_000));
    expect(await expiredEvents()).toHaveLength(1);
    expect(written).toHaveLength(writes);

    // The row itself is unchanged apart from the bookkeeping.
    const row = await runUnscoped('read back the fixture', () =>
      prisma.client.membership.findUniqueOrThrow({ where: { id: inB } }),
    );
    expect(row).toMatchObject({ status: 'ACTIVE', deletedAt: null, lapseHandledAt: after });
  });

  it('after validUntil: switching back to the organization is refused', async () => {
    setClock(after);

    await expect(
      asUser(() => service.switchActiveOrganization({ organizationId: org.b })),
    ).rejects.toMatchObject({ status: 403, code: 'TENANT_MISMATCH' });

    const user = await prisma.client.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.activeOrganizationId).toBe(org.a);
  });
});
