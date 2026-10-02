import 'reflect-metadata';
import { ALLOW_SERVICE_KEY, runWithContext, type RequestContext } from '@rasta/nest-common';
import { IdentityService } from './identity.service';
import { UserController } from './identity.controller';

/**
 * `GET /v1/users/:id/organizations` is for construction-service alone, with a token signed
 * for no tenant: the conflict-of-interest re-check at the approval of a bid opening
 * (CON-002 PR 8, Q-91). A person, another service and a tenant-signed token are refused.
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
  const asked: { userId: string; at?: Date }[] = [];
  const dbNow = new Date('2026-10-02T10:00:00.000Z');
  const service = new IdentityService(
    {
      // The instant is the database's: the service passes none and takes the one it is given.
      findLiveOrganizationIds: async (userId: string) => {
        asked.push({ userId });
        return { organizationIds: ['ORG_A', 'ORG_B'], asOf: dbNow };
      },
      findOrganizationIdsAt: async (userId: string, at: Date) => {
        asked.push({ userId, at });
        return ['ORG_B'];
      },
    } as never,
    {} as never,
    {} as never,
  );
  beforeEach(() => {
    asked.length = 0;
  });

  it('answers construction-service with a tenant-less token: ids only, at the database’s instant', async () => {
    const answer = await runWithContext(context({}), () => service.getLiveOrganizationIds('USR_1'));

    expect(answer).toEqual({
      userId: 'USR_1',
      organizationIds: ['ORG_A', 'ORG_B'],
      asOf: dbNow.toISOString(),
    });
  });

  it('answers the history at an instant when asked for one', async () => {
    const at = new Date('2026-10-01T00:00:00.000Z');
    const answer = await runWithContext(context({}), () =>
      service.getLiveOrganizationIds('USR_1', at),
    );

    expect(answer).toEqual({ userId: 'USR_1', organizationIds: ['ORG_B'], asOf: at.toISOString() });
    expect(asked).toEqual([{ userId: 'USR_1', at }]);
  });

  it.each([
    ['another service', { callerService: 'notification-service' }],
    ['a token signed for a tenant', { organizationId: 'ORG_A' }],
    ['a person', { authType: 'USER', callerService: undefined, roles: ['SYSTEM_ADMIN'] }],
  ])('refuses %s with 403 and reads nothing', async (_name, overrides) => {
    await expect(
      runWithContext(context(overrides as Partial<RequestContext>), () =>
        service.getLiveOrganizationIds('USR_1'),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(asked).toHaveLength(0);
  });

  it('is declared callable by construction-service only', () => {
    const allowed = Reflect.getMetadata(
      ALLOW_SERVICE_KEY,
      UserController.prototype.liveOrganizations,
    );
    expect(allowed).toEqual(['construction-service']);
  });
});
