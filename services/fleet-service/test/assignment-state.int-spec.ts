import { ulid } from 'ulid';
import { runWithContext, type RequestContext } from '@rasta/nest-common';
import { AssetWorkStateService } from '../src/fleet/asset-work-state';
import { AssignmentService } from '../src/fleet/assignment.service';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { AssetSyncConsumer } from '../src/consumers/asset-sync.consumer';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, cleanup, id, newPrisma, tenants } from './helpers';

/**
 * The internal read asset-service derives an `ASSIGNED` status from when
 * `ASSET_ASSIGNED` / `ASSIGNMENT_ENDED` is replayed on `.retry` (D-039),
 * against PostgreSQL: an open assignment in the organization signed into the
 * token, seen by no other, asked by asset-service only.
 */
describe('assignment state (internal)', () => {
  const org = tenants();
  let prisma: PrismaService;
  let repository: FleetRepository;
  let assignments: AssignmentService;
  let state: AssetWorkStateService;

  function asService<T>(
    fn: () => Promise<T>,
    overrides: Partial<RequestContext> & { organizationId?: string | undefined } = {},
  ): Promise<T> {
    return runWithContext(
      {
        correlationId: `itest-${ulid()}`,
        requestId: `itest-${ulid()}`,
        organizationId: org.a,
        roles: [],
        organizationIds: [],
        authType: 'SERVICE',
        callerService: 'asset-service',
        startedAt: Date.now(),
        ...overrides,
      },
      async () => fn(),
    );
  }

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new FleetRepository(prisma);
    assignments = new AssignmentService(repository);
    state = new AssetWorkStateService(repository);
    await cleanup(prisma, [org.a, org.b]);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  async function assignedMachine(): Promise<{ assetId: string; assignmentId: string }> {
    const assetId = id('AST');
    await new AssetSyncConsumer(null, repository).handle({
      eventId: id('EVT'),
      eventName: 'ASSET_CREATED',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'asset-service',
      producerVersion: '0.1.0',
      aggregateType: 'Asset',
      aggregateId: assetId,
      tenantId: org.a,
      correlationId: id('COR'),
      payload: { assetId, organizationId: org.a, status: 'ACTIVE', name: 'لودر' },
    });
    const driverId = id('DRV');
    await asActor({ organizationId: org.a }, () =>
      prisma.client.driver.create({
        data: {
          organizationId: org.a,
          id: driverId,
          userId: `USR-${driverId}`,
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
        },
      }),
    );
    const assignment = await asActor({ organizationId: org.a }, () =>
      assignments.create({ driverId, assetId }),
    );
    return { assetId, assignmentId: assignment.id };
  }

  it('says whether an assignment is open, for the organization signed into the token', async () => {
    const { assetId, assignmentId } = await assignedMachine();

    await expect(asService(() => state.assignmentState(assetId))).resolves.toEqual({
      assetId,
      activeAssignment: true,
    });

    await asActor({ organizationId: org.a }, () =>
      assignments.end(assignmentId, { reason: 'COMPLETED' }),
    );
    await expect(asService(() => state.assignmentState(assetId))).resolves.toEqual({
      assetId,
      activeAssignment: false,
    });
  });

  it('never shows another organization’s assignment', async () => {
    const { assetId } = await assignedMachine();

    await expect(
      asService(() => state.assignmentState(assetId), { organizationId: org.b }),
    ).resolves.toEqual({ assetId, activeAssignment: false });
  });

  it('is closed to user tokens, to other services, and to a token with no organization', async () => {
    const assetId = id('AST');
    await expect(
      asService(() => state.assignmentState(assetId), { authType: 'USER' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      asService(() => state.assignmentState(assetId), { callerService: 'maintenance-service' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      asService(() => state.assignmentState(assetId), { organizationId: undefined }),
    ).rejects.toMatchObject({ code: 'SERVICE_TENANT_CONTEXT_INVALID' });
  });
});
