import { ERROR_CODES } from '@rasta/contracts';
import { runUnscoped } from '@rasta/nest-common';
import { IdentityRepository } from '../src/identity/identity.repository';
import { IdentityService } from '../src/identity/identity.service';
import { IDENTITY_EVENTS } from '../src/identity/events';
import type { KeycloakAdminClient } from '../src/keycloak/keycloak.client';
import { KeycloakProjector } from '../src/keycloak/keycloak.projector';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, id, newPrisma, tenants } from './helpers';

/**
 * One live membership per (user, organization), against a real database.
 *
 * `addMembership` checks for an existing membership and then inserts. Two
 * concurrent calls both passed the check, and the only unique index —
 * (user_id, organization_id, deleted_at) — accepted both rows, because NULL
 * deleted_at values are distinct: two live memberships, two MEMBERSHIP_CREATED
 * events. `ux_membership_live_user_org` (UNIQUE (organization_id, user_id)
 * WHERE deleted_at IS NULL) now refuses the second, and the caller that loses
 * the race gets the answer an existing membership always got: ALREADY_EXISTS.
 */
describe('one live membership per user and organization', () => {
  const org = tenants();
  let prisma: PrismaService;
  let service: IdentityService;
  const users: string[] = [];

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    const repository = new IdentityRepository(prisma);
    // Keycloak is the one stand-in: it is called after the commit and has no
    // part in what is proven here.
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
    await runUnscoped('the suite removes its own fixtures', async () => {
      await prisma.client.outboxMessage.deleteMany({
        where: { organizationId: { in: [org.a, org.b] } },
      });
      await prisma.client.membership.deleteMany({ where: { userId: { in: users } } });
      await prisma.client.user.deleteMany({ where: { id: { in: users } } });
    });
    await prisma.onModuleDestroy();
  });

  async function newUser(): Promise<string> {
    const userId = id('USR-ONELIVE');
    users.push(userId);
    await prisma.client.user.create({
      data: {
        id: userId,
        keycloakId: `kc-${userId}`,
        username: `one-${userId.slice(-12)}`.toLowerCase(),
        email: `one-${userId.slice(-12)}@example.test`.toLowerCase(),
        firstName: 'آزمون',
        lastName: 'عضویت',
        status: 'ACTIVE',
        createdBy: 'ITEST',
        updatedBy: 'ITEST',
      },
    });
    return userId;
  }

  const add = (userId: string, organizationId: string) =>
    asActor({ organizationId, roles: ['SYSTEM_ADMIN'] }, () =>
      service.addMembership(userId, { organizationId, roles: ['FLEET_MANAGER'] }),
    );

  const liveRows = (userId: string, organizationId: string) =>
    runUnscoped('the suite counts the rows it wrote', () =>
      prisma.client.membership.count({ where: { userId, organizationId, deletedAt: null } }),
    );

  const createdEvents = async (userId: string, organizationId: string) => {
    const rows = await runUnscoped('the suite reads the outbox', () =>
      prisma.client.outboxMessage.findMany({
        where: { organizationId, eventName: IDENTITY_EVENTS.MEMBERSHIP_CREATED },
      }),
    );
    return rows.filter(
      (row) => (row.payload as { payload: { userId?: string } }).payload.userId === userId,
    );
  };

  it('lets one of two concurrent adds win: one row, one event, and ALREADY_EXISTS for the other', async () => {
    // Several rounds, each a fresh user, so the race is actually run rather
    // than won by whichever call happens to start first.
    for (let round = 0; round < 8; round += 1) {
      const userId = await newUser();
      const outcomes = await Promise.allSettled([add(userId, org.a), add(userId, org.a)]);

      const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const lost = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]?.reason).toMatchObject({ code: ERROR_CODES.ALREADY_EXISTS });
      expect(await liveRows(userId, org.a)).toBe(1);
      expect(await createdEvents(userId, org.a)).toHaveLength(1);
    }
  });

  it('answers a second add after the first committed exactly as before: ALREADY_EXISTS', async () => {
    const userId = await newUser();
    await add(userId, org.a);
    await expect(add(userId, org.a)).rejects.toMatchObject({ code: ERROR_CODES.ALREADY_EXISTS });
    expect(await liveRows(userId, org.a)).toBe(1);
  });

  it('refuses a second live row at the database, whoever writes it', async () => {
    const userId = await newUser();
    await add(userId, org.a);
    await expect(
      runUnscoped('the suite writes a duplicate live membership directly', () =>
        prisma.client.$executeRawUnsafe(
          `INSERT INTO membership (id, user_id, organization_id, roles, status, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, ARRAY['FLEET_MANAGER'], 'ACTIVE', 'ITEST', 'ITEST', now())`,
          id('MBR-DUP'),
          userId,
          org.a,
        ),
      ),
    ).rejects.toThrow(/ux_membership_live_user_org|23505|Unique constraint/);
  });

  it('does not block re-adding a person whose membership was revoked', async () => {
    const userId = await newUser();
    const first = await add(userId, org.a);
    await runUnscoped('the suite revokes the membership it made', () =>
      prisma.client.membership.update({
        where: { id: first.id },
        data: { deletedAt: new Date(), status: 'REVOKED' },
      }),
    );
    await add(userId, org.a);
    expect(await liveRows(userId, org.a)).toBe(1);
    expect(
      await runUnscoped('the suite counts every row', () =>
        prisma.client.membership.count({ where: { userId, organizationId: org.a } }),
      ),
    ).toBe(2);
  });

  it('keeps memberships per organization: the same user may be live in two tenants', async () => {
    const userId = await newUser();
    await Promise.all([add(userId, org.a), add(userId, org.b)]);
    expect(await liveRows(userId, org.a)).toBe(1);
    expect(await liveRows(userId, org.b)).toBe(1);
  });
});
