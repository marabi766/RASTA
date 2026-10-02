import { runUnscoped, runWithContext, type RequestContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { IdentityRepository } from '../src/identity/identity.repository';
import { IdentityService } from '../src/identity/identity.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { id, newPrisma, tenants } from './helpers';

/**
 * `GET /v1/users/:id/organizations` judges a membership on the DATABASE's clock, against a
 * real database (CON-002 PR 8, Codex #184 R4-1, R5): `validFrom` defaults to the database's
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

  const liveIds = (answer: unknown): string[] =>
    (answer as { memberships: { organizationId: string }[] }).memberships.map(
      (membership) => membership.organizationId,
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
      const answer = await asConstruction(() => service.getMemberships(userId));
      expect(answer).toMatchObject({
        memberships: [{ organizationId: org.a, roles: ['OPERATOR'] }],
      });
      // And the instant it names is the database's, not the lagging one.
      expect(new Date(answer.asOf).getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    } finally {
      jest.useRealTimers();
    }
  });

  it('judges the end of a window on the database clock too, and leaves out the revoked', async () => {
    await member(org.b, { validUntil: new Date(Date.now() - 60_000) });
    await member(orgC, { status: 'REVOKED', deletedAt: new Date() });
    const answer = await asConstruction(() => service.getMemberships(userId));
    expect(answer).toMatchObject({ memberships: [{ organizationId: org.a }] });
    expect(liveIds(answer)).toEqual([org.a]);
  });

  it('answers the interval from an instant to the database’s own: wider than live, ended only by a revocation', async () => {
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

    // From an hour ago: everything that held at any point since, ended or not.
    const sinceHourAgo = await asConstruction(() => service.getMemberships(userId, hourAgo));
    expect(sinceHourAgo).toHaveProperty('organizationIds', [org.a, org.b, orgC, orgD, orgE].sort());
    // The upper end is the database's clock as the query ran, not an instant the caller names.
    expect(new Date(sinceHourAgo.asOf).getTime()).toBeGreaterThan(hourAgo.getTime());

    // From now: only the one with no end. B ended a minute ago, D ten, E thirty, C was revoked.
    const sinceNow = await asConstruction(() => service.getMemberships(userId, new Date()));
    expect(sinceNow).toHaveProperty('organizationIds', [org.a]);
  });

  it('counts a membership that starts after the interval began (the window the conflict check watches)', async () => {
    const from = new Date();
    const orgF = `ORG-ITEST-F-${ulid().slice(-10)}`;
    // validFrom is the database's now(): after `from`, before the answer.
    await member(orgF);
    const answer = await asConstruction(() => service.getMemberships(userId, from));
    expect(answer).toHaveProperty('organizationIds', expect.arrayContaining([orgF]));
  });

  it('stamps a revocation with the database’s clock although the application clock lags by an hour', async () => {
    const orgG = `ORG-ITEST-G-${ulid().slice(-10)}`;
    const created = await member(orgG);
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
      const repository = new IdentityRepository(prisma);
      await repository.transaction((tx) => repository.revokeMembership(tx, created.id, 'ITEST'));
    } finally {
      jest.useRealTimers();
    }
    const row = await runUnscoped('test fixture', () =>
      prisma.client.membership.findFirstOrThrow({ where: { id: created.id } }),
    );
    expect(row.status).toBe('REVOKED');
    // Not an hour behind its own validFrom (the app clock), but after it and about now (the database's).
    expect(row.deletedAt!.getTime()).toBeGreaterThanOrEqual(created.validFrom.getTime());
    expect(Math.abs(row.deletedAt!.getTime() - Date.now())).toBeLessThan(60_000);
    // So the history agrees: a read from just before it still sees the membership; one from after, not.
    const before = await asConstruction(() =>
      service.getMemberships(userId, new Date(created.validFrom.getTime())),
    );
    expect(before).toHaveProperty('organizationIds', expect.arrayContaining([orgG]));
    const after = await asConstruction(() =>
      service.getMemberships(userId, new Date(row.deletedAt!.getTime() + 1)),
    );
    expect(after).toHaveProperty('organizationIds', expect.not.arrayContaining([orgG]));
  });
});
