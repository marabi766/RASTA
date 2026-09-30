import { ulid } from 'ulid';
import { runWithContext, type RequestContext } from '@rasta/nest-common';
import { AssetWorkStateService } from '../src/maintenance/asset-work-state';
import { MaintenanceRepository } from '../src/maintenance/maintenance.repository';
import { RequestService } from '../src/maintenance/request.service';
import { RepairOrderService } from '../src/maintenance/repair-order.service';
import { UnverifiedWorkshopDirectory } from '../src/maintenance/workshop.directory';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, cleanup, id, newPrisma, seedAsset, tenants } from './helpers';

/**
 * The internal read the fleet and asset replicas refresh their maintenance
 * state from when `MAINTENANCE_STARTED` / `MAINTENANCE_COMPLETED` is replayed
 * on `.retry` (D-039), against PostgreSQL: a repair in progress in the
 * organization signed into the token, seen by no other, asked by fleet-service
 * and asset-service only.
 */
describe('maintenance state (internal)', () => {
  const org = tenants();
  let prisma: PrismaService;
  let requests: RequestService;
  let repairOrders: RepairOrderService;
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
        callerService: 'fleet-service',
        startedAt: Date.now(),
        ...overrides,
      },
      async () => fn(),
    );
  }

  beforeAll(async () => {
    prisma = newPrisma();
    const repository = new MaintenanceRepository(prisma);
    requests = new RequestService(repository);
    repairOrders = new RepairOrderService(repository, new UnverifiedWorkshopDirectory());
    state = new AssetWorkStateService(repository);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  async function repair(assetId: string): Promise<string> {
    const request = await asActor({ organizationId: org.a }, () =>
      requests.create({ assetId, type: 'CORRECTIVE', severity: 'HIGH', title: 'نشتی روغن' }),
    );
    const order = await asActor({ organizationId: org.a }, () =>
      repairOrders.assign(request.id, { workshopOrganizationId: 'ORG-ITEST-WORKSHOP' }),
    );
    return order.id;
  }

  it('follows the repair: not in maintenance when only assigned, in maintenance from start, not after completion', async () => {
    const assetId = id('AST-ITEST');
    await seedAsset(prisma, assetId, org.a);
    const orderId = await repair(assetId);
    const ask = (callerService = 'fleet-service') =>
      asService(() => state.maintenanceState(assetId), { callerService });

    await expect(ask()).resolves.toEqual({ assetId, inMaintenance: false });

    await asActor({ organizationId: org.a }, () => repairOrders.start(orderId, {}));
    await expect(ask()).resolves.toEqual({ assetId, inMaintenance: true });
    await expect(ask('asset-service')).resolves.toEqual({ assetId, inMaintenance: true });

    await asActor({ organizationId: org.a }, () =>
      repairOrders.complete(orderId, { laborCostMinor: '1000', partsCostMinor: '0' } as never),
    );
    await expect(ask()).resolves.toEqual({ assetId, inMaintenance: false });
  });

  it('never shows another organization’s repair', async () => {
    const assetId = id('AST-ITEST');
    await seedAsset(prisma, assetId, org.a);
    const orderId = await repair(assetId);
    await asActor({ organizationId: org.a }, () => repairOrders.start(orderId, {}));

    await expect(
      asService(() => state.maintenanceState(assetId), { organizationId: org.b }),
    ).resolves.toEqual({ assetId, inMaintenance: false });
  });

  it('is closed to user tokens, to other services, and to a token with no organization', async () => {
    const assetId = id('AST-ITEST');
    await expect(
      asService(() => state.maintenanceState(assetId), { authType: 'USER' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      asService(() => state.maintenanceState(assetId), { callerService: 'economic-service' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      asService(() => state.maintenanceState(assetId), { organizationId: undefined }),
    ).rejects.toMatchObject({ code: 'SERVICE_TENANT_CONTEXT_INVALID' });
  });
});
