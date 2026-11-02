import { runWithContext, type RequestContext } from '@rasta/nest-common';
import type { PrismaService } from '../prisma/prisma.service';
import { PROJECT_STATES } from './project.state-machine';
import { ProjectCompletionService, projectCompletionFactSchema } from './completion-fact';

const at = new Date('2026-11-02T10:00:00.123Z');
const as = <T>(overrides: Partial<RequestContext>, fn: () => T): T =>
  runWithContext(
    {
      requestId: 'r',
      correlationId: 'c',
      startedAt: Date.now(),
      authType: 'SERVICE',
      callerService: 'contract-service',
      organizationId: 'ORG_1',
      roles: ['SERVICE'],
      ...overrides,
    } as RequestContext,
    fn,
  );

describe('project completion source fact (D-081)', () => {
  const findFirst = jest.fn();
  const service = new ProjectCompletionService({
    client: { project: { findFirst } },
  } as unknown as PrismaService);
  beforeEach(() => findFirst.mockReset());

  it.each(PROJECT_STATES)('states %s without reconstructing approval policy', async (status) => {
    findFirst.mockResolvedValue({
      id: 'PRJ_1',
      organizationId: 'ORG_1',
      status,
      version: 7,
      statusChangedAt: at,
      statusChangedBy: 'USR_1',
      title: 'private',
      estimatedCostMinor: 12n,
    });
    const fact = await as({}, () => service.fact('PRJ_1'));
    expect(fact).toEqual({
      projectId: 'PRJ_1',
      organizationId: 'ORG_1',
      status,
      version: 7,
      completedAt: status === 'COMPLETED' ? at.toISOString() : null,
      completedBy: status === 'COMPLETED' ? 'USR_1' : null,
    });
    expect(projectCompletionFactSchema.safeParse(fact).success).toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'ORG_1', id: 'PRJ_1' },
      select: {
        id: true,
        organizationId: true,
        status: true,
        version: true,
        statusChangedAt: true,
        statusChangedBy: true,
      },
    });
  });

  it.each([
    { authType: 'USER', callerService: undefined, roles: ['ORGANIZATION_ADMIN'] },
    { authType: 'USER', callerService: 'contract-service', roles: ['SYSTEM_ADMIN'] },
    { callerService: 'economic-service' },
    { callerService: undefined },
  ] as Partial<RequestContext>[])(
    'refuses unauthorized callers before querying: %j',
    async (context) => {
      await expect(as(context, () => service.fact('PRJ_1'))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(findFirst).not.toHaveBeenCalled();
    },
  );

  it('refuses a missing tenant before querying', async () => {
    await expect(
      as({ organizationId: undefined }, () => service.fact('PRJ_1')),
    ).rejects.toMatchObject({ code: 'SERVICE_TENANT_CONTEXT_INVALID' });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('returns the same absence for a project outside the signed tenant', async () => {
    findFirst.mockResolvedValue(null);
    await expect(as({}, () => service.fact('PRJ_1'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Project not found',
    });
  });

  it('propagates database unavailability instead of returning a negative fact', async () => {
    findFirst.mockRejectedValue(new Error('database unavailable'));
    await expect(as({}, () => service.fact('PRJ_1'))).rejects.toThrow('database unavailable');
  });
});
