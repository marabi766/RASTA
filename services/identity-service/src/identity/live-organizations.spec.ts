import 'reflect-metadata';
import { ALLOW_SERVICE_KEY, runWithContext, type RequestContext } from '@rasta/nest-common';
import { IdentityService, MEMBERSHIP_READ_CALLERS } from './identity.service';
import { UserController } from './identity.controller';

/**
 * `GET /v1/users/:id/organizations` is for construction-service and procurement-service,
 * with a token signed for no tenant: the conflict-of-interest check around a bid opening and
 * the owner-side authorisation (CON-002 PR 8, Q-91), and the same around an RFQ (ADR-070
 * § 7). A person, another service and a tenant-signed token are refused. Over HTTP:
 * `live-organizations.service-access.spec.ts`.
 */

const context = (overrides: Partial<RequestContext>): RequestContext =>
  ({
    requestId: 'req',
    correlationId: 'corr',
    authType: 'SERVICE',
    callerService: 'construction-service',
    roles: [],
    startedAt: Date.now(),
    ...overrides,
  }) as RequestContext;

describe('which organizations a user belongs to (service-only)', () => {
  const asked: { userId: string; from?: Date }[] = [];
  const dbNow = new Date('2026-10-02T10:00:00.000Z');
  const service = new IdentityService(
    {
      // The instant is the database's: the service passes none and takes the one it is given.
      findLiveMemberships: async (userId: string) => {
        asked.push({ userId });
        return {
          memberships: [
            { organizationId: 'ORG_A', roles: ['ORGANIZATION_ADMIN'] },
            { organizationId: 'ORG_B', roles: ['OPERATOR'] },
          ],
          asOf: dbNow,
        };
      },
      findOrganizationIdsSince: async (userId: string, from: Date) => {
        asked.push({ userId, from });
        return { organizationIds: ['ORG_B'], asOf: dbNow };
      },
    } as never,
    {} as never,
    {} as never,
  );
  beforeEach(() => {
    asked.length = 0;
  });

  it('answers construction-service with a tenant-less token: the live memberships and their roles, at the database’s instant', async () => {
    const answer = await runWithContext(context({}), () => service.getMemberships('USR_1'));

    expect(answer).toEqual({
      userId: 'USR_1',
      memberships: [
        { organizationId: 'ORG_A', roles: ['ORGANIZATION_ADMIN'] },
        { organizationId: 'ORG_B', roles: ['OPERATOR'] },
      ],
      asOf: dbNow.toISOString(),
    });
  });

  it('answers the organizations held over an interval when asked from an instant, up to the database’s own', async () => {
    const from = new Date('2026-10-01T00:00:00.000Z');
    const answer = await runWithContext(context({}), () => service.getMemberships('USR_1', from));

    expect(answer).toEqual({
      userId: 'USR_1',
      organizationIds: ['ORG_B'],
      asOf: dbNow.toISOString(),
    });
    expect(asked).toEqual([{ userId: 'USR_1', from }]);
  });

  it('answers procurement-service with a tenant-less token the same way (ADR-070 § 7)', async () => {
    const asProcurement = context({ callerService: 'procurement-service' });
    const live = await runWithContext(asProcurement, () => service.getMemberships('USR_1'));
    expect(live).toEqual({
      userId: 'USR_1',
      memberships: [
        { organizationId: 'ORG_A', roles: ['ORGANIZATION_ADMIN'] },
        { organizationId: 'ORG_B', roles: ['OPERATOR'] },
      ],
      asOf: dbNow.toISOString(),
    });
    const from = new Date('2026-10-01T00:00:00.000Z');
    const since = await runWithContext(asProcurement, () => service.getMemberships('USR_1', from));
    expect(since).toEqual({
      userId: 'USR_1',
      organizationIds: ['ORG_B'],
      asOf: dbNow.toISOString(),
    });
  });

  it.each([
    ['another service', { callerService: 'notification-service' }],
    ['a token signed for a tenant', { organizationId: 'ORG_A' }],
    ['a person', { authType: 'USER', callerService: undefined, roles: ['SYSTEM_ADMIN'] }],
    [
      'procurement-service with a token signed for a tenant',
      { callerService: 'procurement-service', organizationId: 'ORG_A' },
    ],
    [
      'a person whose context names procurement-service',
      { authType: 'USER', callerService: 'procurement-service', roles: ['SYSTEM_ADMIN'] },
    ],
  ])('refuses %s with 403 and reads nothing', async (_name, overrides) => {
    await expect(
      runWithContext(context(overrides as Partial<RequestContext>), () =>
        service.getMemberships('USR_1'),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(asked).toHaveLength(0);
  });

  it('is declared callable by construction-service and procurement-service only, in both layers', () => {
    const allowed = Reflect.getMetadata(
      ALLOW_SERVICE_KEY,
      UserController.prototype.liveOrganizations,
    );
    expect(allowed).toEqual(['construction-service', 'procurement-service']);
    // The service layer checks the same list, so one cannot drift from the other.
    expect(MEMBERSHIP_READ_CALLERS).toEqual(allowed);
  });
});
