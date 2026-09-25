import { MaintenanceRepository } from '../src/maintenance/maintenance.repository';
import { RequestService } from '../src/maintenance/request.service';
import { RepairOrderService } from '../src/maintenance/repair-order.service';
import { UnverifiedWorkshopDirectory } from '../src/maintenance/workshop.directory';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, cleanup, id, newPrisma, seedAsset, tenants } from './helpers';

/**
 * The cost-line audit events (L7-14), against a real database.
 *
 * Parts, labour and direct costs each write money into the bill an owner
 * approves. Until these events existed none of them reached the event log, so
 * audit-service — whose only input is that log — could not say who added what
 * to a repair, or when (AGENTS.md S-06). The same held for a repair order
 * cancelled by the cascade from its request.
 *
 * What only a database can show: the line and its outbox row commit together,
 * and a failed outbox write takes the line — and the totals — down with it.
 */
describe('cost-line audit events (L7-14)', () => {
  let prisma: PrismaService;
  let repository: MaintenanceRepository;
  let requests: RequestService;
  let repairOrders: RepairOrderService;

  const org = tenants();
  const workshop = 'ORG-ITEST-WORKSHOP';
  const COST_EVENTS = ['REPAIR_PART_RECORDED', 'REPAIR_LABOUR_RECORDED', 'REPAIR_COST_RECORDED'];

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

  async function liveRepair(): Promise<{ assetId: string; requestId: string; orderId: string }> {
    const assetId = id('AST-ITEST');
    await seedAsset(prisma, assetId, org.a);
    const request = await asActor({ organizationId: org.a }, () =>
      requests.create({ assetId, type: 'CORRECTIVE', severity: 'HIGH', title: 'تعمیر' }),
    );
    const order = await asActor({ organizationId: org.a }, () =>
      repairOrders.assign(request.id, { workshopOrganizationId: workshop }),
    );
    await asActor({ organizationId: org.a }, () => repairOrders.start(order.id, {}));
    return { assetId, requestId: request.id, orderId: order.id };
  }

  function costEvents(orderId: string) {
    return prisma.client.outboxMessage.findMany({
      where: { aggregateId: orderId, eventName: { in: COST_EVENTS } },
      orderBy: { streamSeq: 'asc' },
    });
  }

  type Envelope = {
    tenantId?: string;
    actor?: { type: string; id: string };
    payload: Record<string, string>;
  };

  it('writes one outbox row per line, in the tenant, attributed to the caller', async () => {
    const { assetId, orderId } = await liveRepair();
    const mechanic = { organizationId: org.a, userId: 'USR-ITEST-MECHANIC' };

    const part = await asActor(mechanic, () =>
      repairOrders.recordPart(orderId, {
        partName: 'فیلتر روغن',
        quantity: '2',
        unit: 'عدد',
        unitCostMinor: '250000',
        source: 'WORKSHOP_SUPPLIED',
      }),
    );
    const labour = await asActor(mechanic, () =>
      repairOrders.recordLabour(orderId, {
        description: 'تعویض فیلتر',
        technician: 'نام تکنسین',
        hours: '1.50',
        hourlyRateMinor: '900000',
      }),
    );
    const cost = await asActor(mechanic, () =>
      repairOrders.recordCost(orderId, {
        category: 'SERVICE',
        amountMinor: '1200000',
        currency: 'IRR',
        description: 'ایاب و ذهاب',
      }),
    );

    const rows = await costEvents(orderId);
    expect(rows.map((row) => row.eventName)).toEqual(COST_EVENTS);

    for (const row of rows) {
      expect(row.organizationId).toBe(org.a);
      expect(row.aggregateType).toBe('RepairOrder');
      expect(row.partitionKey).toBe(assetId);
      const envelope = row.payload as Envelope;
      expect(envelope.tenantId).toBe(org.a);
      expect(envelope.actor).toEqual({ type: 'USER', id: 'USR-ITEST-MECHANIC' });
      expect(envelope.payload.recordedBy).toBe('USR-ITEST-MECHANIC');
      // No free text reaches the durable log — least of all a person's name.
      expect(JSON.stringify(envelope.payload)).not.toMatch(/فیلتر|تکنسین|ایاب/);
    }

    const [partEvent, labourEvent, costEvent] = rows.map(
      (row) => (row.payload as Envelope).payload,
    );
    expect(partEvent).toMatchObject({ partUsageId: part.id, totalCostMinor: '500000' });
    expect(partEvent!.orderTotalCostMinor).toBe('500000');
    expect(labourEvent).toMatchObject({ laborEntryId: labour.id, totalCostMinor: '1350000' });
    expect(labourEvent!.orderTotalCostMinor).toBe('1850000');
    expect(costEvent).toMatchObject({ costId: cost.id, amountMinor: '1200000' });
    expect(costEvent!.orderTotalCostMinor).toBe('3050000');
    expect(costEvent!.requestTotalCostMinor).toBe('3050000');

    // Each event names the very cost row its write produced.
    const order = await asActor({ organizationId: org.a }, () => repairOrders.get(orderId));
    expect(order.costs.find((line) => line.partUsageId === part.id)?.id).toBe(partEvent!.costId);
    expect(order.costs.find((line) => line.laborEntryId === labour.id)?.id).toBe(
      labourEvent!.costId,
    );
  });

  it.each([
    ['recordPart', 'PART'],
    ['recordLabour', 'LABOUR'],
    ['recordCost', 'SERVICE'],
  ] as const)(
    '%s rolls the line and the totals back when its event cannot be written',
    async (method, category) => {
      const { requestId, orderId } = await liveRepair();

      const spy = jest
        .spyOn(repository, 'enqueueEvent')
        .mockRejectedValueOnce(new Error('outbox unavailable'));
      const write = () => {
        switch (method) {
          case 'recordPart':
            return repairOrders.recordPart(orderId, {
              partName: 'قطعه',
              quantity: '1',
              unit: 'عدد',
              unitCostMinor: '100000',
              source: 'WORKSHOP_SUPPLIED',
            });
          case 'recordLabour':
            return repairOrders.recordLabour(orderId, {
              description: 'کار',
              hours: '1',
              hourlyRateMinor: '100000',
            });
          case 'recordCost':
            return repairOrders.recordCost(orderId, {
              category: 'SERVICE',
              amountMinor: '100000',
              currency: 'IRR',
              description: 'هزینه',
            });
        }
      };
      await expect(asActor({ organizationId: org.a }, write)).rejects.toThrow('outbox unavailable');
      spy.mockRestore();

      const order = await asActor({ organizationId: org.a }, () => repairOrders.get(orderId));
      expect(order.costs.filter((line) => line.category === category)).toHaveLength(0);
      expect(order.parts).toHaveLength(0);
      expect(order.labour).toHaveLength(0);
      expect(order.totalCostMinor).toBe('0');
      const request = await asActor({ organizationId: org.a }, () => requests.get(requestId));
      expect(request.totalCostMinor).toBe('0');
      expect(await costEvents(orderId)).toHaveLength(0);
    },
  );

  it("cannot add cost to another tenant's repair, and publishes nothing for it", async () => {
    const { orderId } = await liveRepair();

    await expect(
      asActor({ organizationId: org.b }, () =>
        repairOrders.recordPart(orderId, {
          partName: 'قطعه',
          quantity: '1',
          unit: 'عدد',
          unitCostMinor: '100000',
          source: 'WORKSHOP_SUPPLIED',
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      asActor({ organizationId: org.b }, () =>
        repairOrders.recordLabour(orderId, {
          description: 'کار',
          hours: '1',
          hourlyRateMinor: '100000',
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      asActor({ organizationId: org.b }, () =>
        repairOrders.recordCost(orderId, {
          category: 'SERVICE',
          amountMinor: '100000',
          currency: 'IRR',
          description: 'هزینه',
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(await costEvents(orderId)).toHaveLength(0);
    const leaked = await prisma.client.outboxMessage.findMany({
      where: { organizationId: org.b, eventName: { in: COST_EVENTS } },
    });
    expect(leaked).toHaveLength(0);
  });

  it('publishes one event per concurrent line, and the last total is the whole bill', async () => {
    const { orderId } = await liveRepair();

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        asActor({ organizationId: org.a }, () =>
          repairOrders.recordPart(orderId, {
            partName: `قطعه ${index + 1}`,
            quantity: '1',
            unit: 'عدد',
            unitCostMinor: '100000',
            source: 'WORKSHOP_SUPPLIED',
          }),
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5);

    const rows = await costEvents(orderId);
    expect(rows).toHaveLength(5);
    // The row lock orders the writes, so the totals the events carry climb by
    // exactly one line each — none of them was computed from a stale sum.
    expect(rows.map((row) => (row.payload as Envelope).payload.orderTotalCostMinor)).toEqual([
      '100000',
      '200000',
      '300000',
      '400000',
      '500000',
    ]);
  });

  describe('request cancellation cascade', () => {
    it('announces each live repair order it cancels as REPAIR_CANCELLED', async () => {
      const { requestId, orderId, assetId } = await liveRepair();

      await asActor({ organizationId: org.a, userId: 'USR-ITEST-OWNER' }, () =>
        requests.cancel(requestId, { reason: 'دستگاه فروخته شد' }),
      );

      const rows = await prisma.client.outboxMessage.findMany({
        where: { aggregateId: orderId, eventName: 'REPAIR_CANCELLED' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.organizationId).toBe(org.a);
      expect(rows[0]!.partitionKey).toBe(assetId);
      const envelope = rows[0]!.payload as Envelope & { causationId?: string };
      expect(envelope.actor?.id).toBe('USR-ITEST-OWNER');
      expect(envelope.causationId).toBe(requestId);
      expect(envelope.payload).toMatchObject({
        repairOrderId: orderId,
        requestId,
        previousStatus: 'IN_PROGRESS',
      });

      const order = await asActor({ organizationId: org.a }, () => repairOrders.get(orderId));
      expect(order.status).toBe('CANCELLED');
    });

    it('rolls the request and the order back together if the cascade event fails', async () => {
      const { requestId, orderId } = await liveRepair();

      // The first enqueue in `cancel` is the cascade's REPAIR_CANCELLED.
      const spy = jest
        .spyOn(repository, 'enqueueEvent')
        .mockRejectedValueOnce(new Error('outbox unavailable'));
      await expect(
        asActor({ organizationId: org.a }, () =>
          requests.cancel(requestId, { reason: 'دستگاه فروخته شد' }),
        ),
      ).rejects.toThrow('outbox unavailable');
      spy.mockRestore();

      const order = await asActor({ organizationId: org.a }, () => repairOrders.get(orderId));
      expect(order.status).toBe('IN_PROGRESS');
      const request = await asActor({ organizationId: org.a }, () => requests.get(requestId));
      expect(request.status).toBe('IN_PROGRESS');
    });

    it('publishes no cascade event for a request with no live referral', async () => {
      const assetId = id('AST-ITEST');
      await seedAsset(prisma, assetId, org.a);
      const request = await asActor({ organizationId: org.a }, () =>
        requests.create({ assetId, type: 'PREVENTIVE', title: 'سرویس' }),
      );

      await asActor({ organizationId: org.a }, () =>
        requests.cancel(request.id, { reason: 'نیاز نبود' }),
      );

      const rows = await prisma.client.outboxMessage.findMany({
        where: { organizationId: org.a, eventName: 'REPAIR_CANCELLED' },
      });
      expect(
        rows.filter((row) => (row.payload as Envelope).payload.requestId === request.id),
      ).toEqual([]);
    });
  });
});
