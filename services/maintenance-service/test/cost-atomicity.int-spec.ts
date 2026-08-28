import { MaintenanceRepository } from '../src/maintenance/maintenance.repository';
import { RequestService } from '../src/maintenance/request.service';
import { RepairOrderService } from '../src/maintenance/repair-order.service';
import { UnverifiedWorkshopDirectory } from '../src/maintenance/workshop.directory';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, cleanup, id, newPrisma, seedAsset, tenants } from './helpers';

/**
 * Cost, and the invariant docs/03 § 3.3 states in one sentence: "هزینه کل باید
 * با اجزایش اتمیک بماند" — the total must stay atomic with its parts.
 *
 * This is the suite that could not exist without a real database. The failure
 * it guards against is a lost update: two mechanics entering parts on the same
 * job read the same starting total, and one of their lines vanishes from it.
 * A single-threaded unit test cannot produce that, and a mock cannot lose it.
 *
 * The figure at stake is not academic. It is what the owner approves and what
 * `MAINTENANCE_APPROVED` carries to economic-service, so a total that quietly
 * disagrees with its lines is a workshop underpaid or an organization
 * overcharged.
 */
describe('cost atomicity', () => {
  let prisma: PrismaService;
  let repository: MaintenanceRepository;
  let requests: RequestService;
  let repairOrders: RepairOrderService;

  const org = tenants();
  const workshop = 'ORG-ITEST-WORKSHOP';

  beforeAll(async () => {
    prisma = newPrisma();
    repository = new MaintenanceRepository(prisma);
    requests = new RequestService(repository);
    repairOrders = new RepairOrderService(repository, new UnverifiedWorkshopDirectory());
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  /** A machine with a request already referred to a workshop and started. */
  async function liveRepair(): Promise<{ requestId: string; orderId: string }> {
    const assetId = id('AST-ITEST');
    await seedAsset(prisma, assetId, org.a);

    const request = await asActor({ organizationId: org.a }, () =>
      requests.create({ assetId, type: 'CORRECTIVE', severity: 'HIGH', title: 'تعمیر' }),
    );
    const order = await asActor({ organizationId: org.a }, () =>
      repairOrders.assign(request.id, { workshopOrganizationId: workshop }),
    );
    await asActor({ organizationId: org.a }, () => repairOrders.start(order.id, {}));

    return { requestId: request.id, orderId: order.id };
  }

  it('keeps the totals equal to the sum of the lines', async () => {
    const { requestId, orderId } = await liveRepair();

    await asActor({ organizationId: org.a }, () =>
      repairOrders.recordPart(orderId, {
        partName: 'شیلنگ هیدرولیک',
        quantity: '1',
        unit: 'عدد',
        unitCostMinor: '4800000',
        source: 'MARKETPLACE',
      }),
    );
    await asActor({ organizationId: org.a }, () =>
      repairOrders.recordLabour(orderId, {
        description: 'تعویض شیلنگ',
        hours: '6.50',
        hourlyRateMinor: '900000',
      }),
    );
    await asActor({ organizationId: org.a }, () =>
      repairOrders.recordCost(orderId, {
        category: 'SERVICE',
        amountMinor: '1200000',
        currency: 'IRR',
        description: 'ایاب و ذهاب',
      }),
    );

    const order = await asActor({ organizationId: org.a }, () => repairOrders.get(orderId));

    expect(order.partsCostMinor).toBe('4800000');
    expect(order.labourCostMinor).toBe('5850000');
    expect(order.otherCostMinor).toBe('1200000');
    expect(order.totalCostMinor).toBe('11850000');

    const request = await asActor({ organizationId: org.a }, () => requests.get(requestId));
    expect(request.totalCostMinor).toBe('11850000');
  });

  it('loses nothing when several parts are entered at the same moment', async () => {
    // The lost-update test. Ten concurrent entries of 100 000 rial must total
    // exactly one million: an implementation that increments a stored total
    // instead of recomputing from the lines reliably comes out short here.
    const { requestId, orderId } = await liveRepair();

    const entries = Array.from({ length: 10 }, (_, index) =>
      asActor({ organizationId: org.a }, () =>
        repairOrders.recordPart(orderId, {
          partName: `قطعه ${index + 1}`,
          quantity: '1',
          unit: 'عدد',
          unitCostMinor: '100000',
        }),
      ),
    );

    const results = await Promise.allSettled(entries);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);

    const order = await asActor({ organizationId: org.a }, () => repairOrders.get(orderId));
    expect(order.parts).toHaveLength(10);
    expect(order.partsCostMinor).toBe('1000000');
    expect(order.totalCostMinor).toBe('1000000');

    // And the sum the database itself computes agrees, which is the check that
    // would catch a total written correctly but from the wrong rows.
    const [{ total }] = await asActor(
      { organizationId: org.a },
      () =>
        repository.client.$queryRaw<{ total: string }[]>`
        SELECT COALESCE(SUM(amount_minor), 0)::text AS total
        FROM maintenance_cost
        WHERE repair_order_id = ${orderId}
      `,
    );
    expect(total).toBe('1000000');

    const request = await asActor({ organizationId: org.a }, () => requests.get(requestId));
    expect(request.totalCostMinor).toBe('1000000');
  });

  it('writes a cost line with its provenance for every part and every hour', async () => {
    // The property economic-service will audit against: a total that
    // decomposes into lines, each naming the work that produced it (ADR-028).
    const { orderId } = await liveRepair();

    const part = await asActor({ organizationId: org.a }, () =>
      repairOrders.recordPart(orderId, {
        partName: 'فیلتر روغن',
        quantity: '2',
        unit: 'عدد',
        unitCostMinor: '250000',
      }),
    );
    const labour = await asActor({ organizationId: org.a }, () =>
      repairOrders.recordLabour(orderId, {
        description: 'تعویض فیلتر',
        hours: '1.50',
        hourlyRateMinor: '900000',
      }),
    );

    const order = await asActor({ organizationId: org.a }, () => repairOrders.get(orderId));

    const partLine = order.costs.find((cost) => cost.category === 'PART');
    const labourLine = order.costs.find((cost) => cost.category === 'LABOUR');
    const direct = order.costs.filter((cost) => cost.category === 'SERVICE');

    expect(partLine?.partUsageId).toBe(part.id);
    expect(partLine?.amountMinor).toBe('500000');
    expect(labourLine?.laborEntryId).toBe(labour.id);
    expect(labourLine?.amountMinor).toBe('1350000');
    expect(direct).toHaveLength(0);
  });

  it('refuses at the database a PART cost that names no part', async () => {
    // The provenance constraint, tested where it lives. The service can only
    // write these lines alongside the work; this proves a corrective script or
    // a future code path cannot get round it either.
    const { requestId, orderId } = await liveRepair();

    await expect(
      asActor({ organizationId: org.a }, () =>
        repository.client.maintenanceCost.create({
          data: {
            id: id('MCS-ITEST'),
            organizationId: org.a,
            repairOrderId: orderId,
            maintenanceRequestId: requestId,
            category: 'PART',
            amountMinor: 500_000n,
            currency: 'IRR',
            recordedAt: new Date(),
            recordedBy: 'ITEST',
          },
        }),
      ),
    ).rejects.toThrow(/ck_cost_provenance/);
  });

  it('refuses a repair order whose total disagrees with its own categories', async () => {
    const { orderId } = await liveRepair();

    await expect(
      asActor({ organizationId: org.a }, () =>
        repository.client.repairOrder.update({
          where: { id: orderId },
          data: { totalCostMinor: 999_999n },
        }),
      ),
    ).rejects.toThrow(/ck_repair_order_totals/);
  });

  it('refuses cost on a repair order that is already finished', async () => {
    const { orderId } = await liveRepair();

    await asActor({ organizationId: org.a }, () =>
      repairOrders.complete(orderId, { workPerformed: 'انجام شد' }),
    );

    await expect(
      asActor({ organizationId: org.a }, () =>
        repairOrders.recordCost(orderId, {
          category: 'OTHER',
          amountMinor: '100000',
          currency: 'IRR',
          description: 'دیرهنگام',
        }),
      ),
    ).rejects.toMatchObject({
      internalContext: expect.objectContaining({ rule: 'REPAIR_ORDER_NOT_COSTABLE' }),
    });
  });

  it('holds a part line total to the product of its own quantity and price', async () => {
    const { orderId } = await liveRepair();

    const part = await asActor({ organizationId: org.a }, () =>
      repairOrders.recordPart(orderId, {
        partName: 'روغن هیدرولیک',
        quantity: '12.5',
        unit: 'لیتر',
        unitCostMinor: '320000',
        source: 'INVENTORY',
      }),
    );
    expect(part.totalCostMinor).toBe('4000000');

    await expect(
      asActor({ organizationId: org.a }, () =>
        repository.client.partUsage.update({
          where: { id: part.id },
          data: { totalCostMinor: 1n },
        }),
      ),
    ).rejects.toThrow(/ck_part_usage_amounts/);
  });
});
