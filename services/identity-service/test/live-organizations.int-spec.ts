import { runUnscoped, runWithContext, type RequestContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { IdentityRepository } from '../src/identity/identity.repository';
import { IdentityService } from '../src/identity/identity.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { id, newPrisma, tenants } from './helpers';

/**
 * `GET /v1/users/:id/organizations` judges a membership on the DATABASE's clock, against a
 * real database (CON-002 PR 8, Codex #184 R4-1): `validFrom` defaults to the database's
 * `now()`, so an application clock that lags must not hide a membership created a moment ago.
 *
 * Only `Date` is faked here, set an hour behind the real clock; the database keeps its own.
 */
describe('which organizations a user belongs to — on the database clock', () => {
  const org = tenants();
  const orgC = `ORG-ITEST-C-${ulid().slice(-10)}`;
  let prisma: PrismaService;
  let service: IdentityService;

  const userId = id('USR-LIVE');

  const asConstruction = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithContext(
      {
        correlationId: 'COR-ITEST',
        requestId: 'REQ-ITEST',
        authType: 'SERVICE',
        callerService: 'construction-service',
        roles: [],
        organizationIds: [],
        startedAt: Date.now(),
      } as RequestContext,
      fn,
    );

  const member = (organizationId: string, extra: Record<string, unknown> = {}) =>
    runUnscoped('test fixture spans organizations', () =>
      prisma.client.membership.create({
        data: {
          id: id('MBR-LIVE'),
          userId,
          organizationId,
          roles: ['OPERATOR'],
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
          ...extra,
        },
      }),
    );

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    service = new IdentityService(new IdentityRepository(prisma), {} as never, {} as never);
    await runUnscoped('test fixture', () =>
      prisma.client.user.create({
        data: {
          id: userId,
          keycloakId: `kc-${userId}`,
          username: `live-${userId.slice(-10)}`.toLowerCase(),
          email: `live-${userId.slice(-10)}@example.test`.toLowerCase(),
          firstName: 'آزمون',
          lastName: 'زنده',
          status: 'ACTIVE',
          activeOrganizationId: org.a,
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
        },
      }),
    );
  });

  afterAll(async () => {
    jest.useRealTimers();
    await prisma.onModuleDestroy();
  });

  it('sees a membership created just now although the application clock lags by an hour', async () => {
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
      await member(org.a);
      const answer = await asConstruction(() => service.getLiveOrganizationIds(userId));
      expect(answer.organizationIds).toEqual([org.a]);
      // And the instant it names is the database's, not the lagging one.
      expect(new Date(answer.asOf).getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    } finally {
      jest.useRealTimers();
    }
  });

  it('judges the end of a window on the database clock too, and leaves out the revoked', async () => {
    await member(org.b, { validUntil: new Date(Date.now() - 60_000) });
    await member(orgC, { status: 'REVOKED', deletedAt: new Date() });
    const answer = await asConstruction(() => service.getLiveOrganizationIds(userId));
    expect(answer.organizationIds).toEqual([org.a]);
  });

  it('answers the history at an instant: wider than live, and ended by a revocation', async () => {
    const hourAgo = new Date(Date.now() - 3_600_000);
    const longAgo = new Date(Date.now() - 86_400_000);
    // Member of D from two days ago to ten minutes ago; revoked from E half an hour ago.
    const orgD = `ORG-ITEST-D-${ulid().slice(-10)}`;
    const orgE = `ORG-ITEST-E-${ulid().slice(-10)}`;
    await member(orgD, {
      validFrom: new Date(longAgo.getTime() - 86_400_000),
      validUntil: new Date(Date.now() - 600_000),
    });
    await member(orgE, {
      status: 'REVOKED',
      validFrom: longAgo,
      deletedAt: new Date(Date.now() - 1_800_000),
    });

    const atHourAgo = await asConstruction(() => service.getLiveOrganizationIds(userId, hourAgo));
    expect(atHourAgo.organizationIds).toEqual([orgD, orgE].sort());
    expect(atHourAgo.asOf).toBe(hourAgo.toISOString());

    const now = await asConstruction(() => service.getLiveOrganizationIds(userId, new Date()));
    // Neither D (ended) nor E (revoked) any more; A is still a member; B ended a minute ago.
    expect(now.organizationIds).toEqual([org.a]);

    const beforeEverything = await asConstruction(() =>
      service.getLiveOrganizationIds(userId, new Date(longAgo.getTime() - 5 * 86_400_000)),
    );
    expect(beforeEverything.organizationIds).toEqual([]);
  });
});
