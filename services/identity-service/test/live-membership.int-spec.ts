import { runUnscoped, runWithContext, type RequestContext } from '@rasta/nest-common';
import { IdentityRepository } from '../src/identity/identity.repository';
import { IdentityService } from '../src/identity/identity.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { id, newPrisma, tenants } from './helpers';
import { dateMembershipWindow, type MembershipWindow } from './identity-fixtures';

/**
 * `GET /v1/users/:id/live-membership` — fleet-service's one-bit question before it
 * registers a driver (task 095) — against a real database.
 *
 * Live is `liveMembershipWhere`, the one definition: ACTIVE, not deleted, and the
 * validity window holding the **database's** clock; and the person is an ACTIVE, not
 * deleted user. The organization is the one the token is signed for, applied by the
 * tenant guard: a membership elsewhere is not seen. Every way of not being a member —
 * no such user included — is the same `live: false`.
 */
describe('is this user a live member of the organization fleet acts for (task 095)', () => {
  const org = tenants();
  let prisma: PrismaService;
  let service: IdentityService;

  const asFleet = <T>(organizationId: string, fn: () => Promise<T>): Promise<T> =>
    runWithContext(
      {
        correlationId: 'COR-ITEST',
        requestId: 'REQ-ITEST',
        authType: 'SERVICE',
        callerService: 'fleet-service',
        organizationId,
        roles: ['SERVICE'],
        organizationIds: [],
        startedAt: Date.now(),
      } as RequestContext,
      fn,
    );

  const user = async (extra: Record<string, unknown> = {}): Promise<string> => {
    const userId = id('USR-LM');
    await runUnscoped('test fixture', () =>
      prisma.client.user.create({
        data: {
          id: userId,
          keycloakId: `kc-${userId}`,
          username: `lm-${userId.slice(-12)}`.toLowerCase(),
          email: `lm-${userId.slice(-12)}@example.test`.toLowerCase(),
          firstName: 'آزمون',
          lastName: 'عضو',
          status: 'ACTIVE',
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
          ...extra,
        },
      }),
    );
    return userId;
  };

  /**
   * A membership; its validity window, when not the default (from the
   * database's now(), open-ended), dated by the database clock that judges it.
   */
  const member = async (
    userId: string,
    organizationId: string,
    extra: Record<string, unknown> = {},
    window?: MembershipWindow,
  ) => {
    const created = await runUnscoped('test fixture spans organizations', () =>
      prisma.client.membership.create({
        data: {
          id: id('MBR-LM'),
          userId,
          organizationId,
          roles: ['OPERATOR'],
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
          ...extra,
        },
      }),
    );
    if (window) await dateMembershipWindow(prisma, created.id, window);
    return created;
  };

  const ask = (organizationId: string, userId: string) =>
    asFleet(organizationId, () => service.getLiveMembership(userId));

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    service = new IdentityService(new IdentityRepository(prisma), {} as never, {} as never);
  });

  afterAll(async () => {
    jest.useRealTimers();
    await prisma.stop();
  });

  it('answers live: true for a live member, naming the user, the signed organization and the database instant', async () => {
    const userId = await user();
    await member(userId, org.a);
    const answer = await ask(org.a, userId);
    expect(answer).toEqual({
      userId,
      organizationId: org.a,
      live: true,
      asOf: expect.any(String),
    });
    expect(Math.abs(new Date(answer.asOf).getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('answers live: false for a member of ANOTHER organization — the signed one is the only one seen', async () => {
    const userId = await user();
    await member(userId, org.b);
    expect(await ask(org.a, userId)).toMatchObject({ organizationId: org.a, live: false });
    // And the same person is a member where they are one.
    expect(await ask(org.b, userId)).toMatchObject({ organizationId: org.b, live: true });
  });

  it('answers a user who does not exist exactly as one who belongs elsewhere', async () => {
    const elsewhere = await user();
    await member(elsewhere, org.b);
    const nobody = id('USR-LM-NOBODY');
    const a = await ask(org.a, nobody);
    const b = await ask(org.a, elsewhere);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(a).toMatchObject({ userId: nobody, organizationId: org.a, live: false });
    expect(b).toMatchObject({ userId: elsewhere, organizationId: org.a, live: false });
  });

  it.each<[string, Record<string, unknown>, MembershipWindow | undefined]>([
    ['revoked', { status: 'REVOKED', deletedAt: new Date() }, undefined],
    ['suspended', { status: 'SUSPENDED' }, undefined],
    ['not yet valid', {}, { fromMs: 3_600_000, untilMs: null }],
    ['lapsed', {}, { fromMs: -3_600_000, untilMs: -60_000 }],
    ['deleted but still marked ACTIVE', { deletedAt: new Date() }, undefined],
  ])('answers live: false for a %s membership', async (_label, extra, window) => {
    const userId = await user();
    await member(userId, org.a, extra, window);
    expect(await ask(org.a, userId)).toMatchObject({ live: false });
  });

  it.each([
    ['suspended', { status: 'SUSPENDED' }],
    ['deactivated', { status: 'DEACTIVATED' }],
    ['pending', { status: 'PENDING' }],
    ['deleted', { deletedAt: new Date() }],
  ])('answers live: false for a %s user, whatever their membership says', async (_label, extra) => {
    const userId = await user(extra);
    await member(userId, org.a);
    expect(await ask(org.a, userId)).toMatchObject({ live: false });
  });

  it('sees a membership created just now although the application clock lags by an hour', async () => {
    const userId = await user();
    jest.useFakeTimers({
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    jest.setSystemTime(new Date(Date.now() - 3_600_000));
    try {
      // validFrom is the database's now(), an hour AHEAD of this process's clock.
      await member(userId, org.a);
      const answer = await ask(org.a, userId);
      expect(answer.live).toBe(true);
      expect(new Date(answer.asOf).getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    } finally {
      jest.useRealTimers();
    }
  });

  it('judges the end of a window on the database clock: lapsed a moment ago is lapsed', async () => {
    const userId = await user();
    // An application clock an hour ahead would still call this live; the database does not.
    await member(userId, org.a, {}, { fromMs: -3_600_000, untilMs: -1_000 });
    expect(await ask(org.a, userId)).toMatchObject({ live: false });
  });
});
