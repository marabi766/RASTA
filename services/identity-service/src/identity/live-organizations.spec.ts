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
  const asked: { userId: string; now: Date }[] = [];
  const service = new IdentityService(
    {
      findLiveOrganizationIds: async (userId: string, now: Date) => {
        asked.push({ userId, now });
        return ['ORG_A', 'ORG_B'];
      },
    } as never,
    {} as never,
    {} as never,
  );
  beforeEach(() => {
    asked.length = 0;
  });

  it('answers construction-service with a tenant-less token: ids only', async () => {
    const answer = await runWithContext(context({}), () => service.getLiveOrganizationIds('USR_1'));

    expect(answer).toEqual({
      userId: 'USR_1',
      organizationIds: ['ORG_A', 'ORG_B'],
      asOf: asked[0]!.now.toISOString(),
    });
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
