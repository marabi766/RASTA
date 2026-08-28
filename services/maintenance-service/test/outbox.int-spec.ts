import { eventEnvelopeSchema } from '@rasta/contracts';
import { OutboxRelay, runWithContext, type RequestContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { MaintenanceRepository } from '../src/maintenance/maintenance.repository';
import { RequestService } from '../src/maintenance/request.service';
import { RepairOrderService } from '../src/maintenance/repair-order.service';
import { UnverifiedWorkshopDirectory } from '../src/maintenance/workshop.directory';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { InMemoryEventPublisher } from '../src/outbox/kafka.publisher';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, cleanup, id, newPrisma, seedAsset, tenants } from './helpers';

/**
 * The outbox, against a real database.
 *
 * The property under test is the one ADR-021 exists for: the state change and
 * the event are written in **one transaction**, so the platform can neither
 * lose an event nor invent one. A mock cannot demonstrate that — the whole
 * question is what the database does when a transaction rolls back.
 */
describe('transactional outbox', () => {
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

  async function outboxFor(aggregateId: string) {
    return asActor({ organizationId: org.a }, () =>
      repository.client.outboxMessage.findMany({
        where: { aggregateId },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  it('writes the request and its events in one transaction', async () => {
    const assetId = id('AST-ITEST');
    await seedAsset(prisma, assetId, org.a);

    const request = await asActor({ organizationId: org.a }, () =>
      requests.create({
        assetId,
        type: 'CORRECTIVE',
        severity: 'HIGH',
        title: 'نشتی روغن',
      }),
    );

    const rows = await outboxFor(request.id);
    const names = rows.map((row) => row.eventName);

    // Two events, not one: "something broke" and "a piece of work exists" are
    // different facts with different consumers.
    expect(names).toEqual(['BREAKDOWN_REPORTED', 'MAINTENANCE_CREATED']);
    // Keyed by asset, so a machine's whole maintenance story stays in one
    // partition and in order.
    expect(rows.every((row) => row.partitionKey === assetId)).toBe(true);
    expect(rows.every((row) => row.topic === 'rasta.maintenance.v1')).toBe(true);
    expect(rows.every((row) => row.publishedAt === null)).toBe(true);
  });

  it('publishes a well-formed envelope, validated by the platform schema', async () => {
    const assetId = id('AST-ITEST');
    await seedAsset(prisma, assetId, org.a);

    const context: RequestContext = {
      correlationId: `itest-corr-${ulid()}`,
      requestId: `itest-${ulid()}`,
      organizationId: org.a,
      userId: 'USR-ITEST-ADMIN',
      roles: ['FLEET_MANAGER'],
      authType: 'USER',
      startedAt: Date.now(),
    };

    const request = await runWithContext(context, async () =>
      requests.create({ assetId, type: 'PREVENTIVE', title: 'سرویس دوره‌ای' }),
    );

    const [row] = await outboxFor(request.id);
    const envelope = eventEnvelopeSchema.parse(row?.payload);

    expect(envelope.eventName).toBe('MAINTENANCE_CREATED');
    expect(envelope.producer).toBe('maintenance-service');
    expect(envelope.tenantId).toBe(org.a);
    // The correlation id from the request reaches the event, which is what
    // makes an HTTP call and its downstream effects one story in the logs.
    expect(envelope.correlationId).toBe(context.correlationId);
    expect(row?.correlationId).toBe(context.correlationId);
    // And the actor, so an auditor can say who caused it.
    expect(envelope.actor).toEqual({ type: 'USER', id: 'USR-ITEST-ADMIN' });
  });

  it('loses the event when the state change rolls back', async () => {
    // The point of the pattern, stated as a test. If these were two operations
    // rather than one transaction, a crash between them would leave either a
    // request nobody was told about or an event for work that never existed.
    const assetId = id('AST-ITEST');
    await seedAsset(prisma, assetId, org.a);
    const requestId = id('MNT-ITEST');

    await asActor({ organizationId: org.a }, async () => {
      await expect(
        repository.transaction(async (tx) => {
          await tx.maintenanceRequest.create({
            data: {
              id: requestId,
              organizationId: org.a,
              assetId,
              type: 'PREVENTIVE',
              title: 'کاری که هرگز نبود',
              reportedAt: new Date(),
              reportedBy: 'ITEST',
            },
          });

          await repository.enqueueEvent(tx, {
            aggregateType: 'MaintenanceRequest',
            aggregateId: requestId,
            eventName: 'MAINTENANCE_CREATED',
            topic: 'rasta.maintenance.v1',
            organizationId: org.a,
            partitionKey: assetId,
            payload: { requestId, assetId },
          });

          throw new Error('deliberate rollback');
        }),
      ).rejects.toThrow('deliberate rollback');
    });

    expect(
      await asActor({ organizationId: org.a }, () => repository.findRequestById(requestId)),
    ).toBeNull();
    expect(await outboxFor(requestId)).toHaveLength(0);
  });

  it('carries the cost breakdown on the event that authorises settlement', async () => {
    const assetId = id('AST-ITEST');
    await seedAsset(prisma, assetId, org.a);

    const request = await asActor({ organizationId: org.a }, () =>
      requests.create({ assetId, type: 'PREVENTIVE', title: 'سرویس' }),
    );
    const order = await asActor({ organizationId: org.a }, () =>
      repairOrders.assign(request.id, { workshopOrganizationId: workshop }),
    );
    await asActor({ organizationId: org.a }, () => repairOrders.start(order.id, {}));
    await asActor({ organizationId: org.a }, () =>
      repairOrders.recordPart(order.id, {
        partName: 'فیلتر',
        quantity: '2',
        unit: 'عدد',
        unitCostMinor: '250000',
      }),
    );
    await asActor({ organizationId: org.a }, () =>
      repairOrders.recordLabour(order.id, {
        description: 'تعویض',
        hours: '2.00',
        hourlyRateMinor: '900000',
      }),
    );
    await asActor({ organizationId: org.a }, () =>
      repairOrders.complete(order.id, { workPerformed: 'انجام شد' }),
    );
    await asActor({ organizationId: org.a }, () => requests.approve(request.id, {}));

    const rows = await outboxFor(request.id);
    const approved = rows.find((row) => row.eventName === 'MAINTENANCE_APPROVED');
    const payload = (approved?.payload as { payload: Record<string, unknown> }).payload;

    expect(payload.totalCostMinor).toBe('2300000');
    expect(payload.workshopOrganizationId).toBe(workshop);

    const breakdown = payload.costBreakdown as { category: string; amountMinor: string }[];
    const sum = breakdown.reduce((total, line) => total + BigInt(line.amountMinor), 0n);
    // The breakdown is what makes the total auditable rather than merely
    // trusted, so it has to add up to it (ADR-028).
    expect(sum).toBe(2_300_000n);
    expect(breakdown.map((line) => line.category).sort()).toEqual(['LABOUR', 'PART']);
  });

  it('publishes both the repair and the return to service on completion', async () => {
    const assetId = id('AST-ITEST');
    await seedAsset(prisma, assetId, org.a);

    const request = await asActor({ organizationId: org.a }, () =>
      requests.create({ assetId, type: 'PREVENTIVE', title: 'سرویس' }),
    );
    const order = await asActor({ organizationId: org.a }, () =>
      repairOrders.assign(request.id, { workshopOrganizationId: workshop }),
    );
    await asActor({ organizationId: org.a }, () => repairOrders.start(order.id, {}));
    await asActor({ organizationId: org.a }, () =>
      repairOrders.complete(order.id, { workPerformed: 'انجام شد' }),
    );

    const requestEvents = (await outboxFor(request.id)).map((row) => row.eventName);
    const orderEvents = (await outboxFor(order.id)).map((row) => row.eventName);

    // MAINTENANCE_STARTED withdraws the machine and MAINTENANCE_COMPLETED
    // returns it; without both, a repaired machine stays IN_MAINTENANCE for
    // ever in asset-service and undispatchable in fleet-service.
    expect(requestEvents).toEqual([
      'MAINTENANCE_CREATED',
      'MAINTENANCE_STARTED',
      'MAINTENANCE_COMPLETED',
    ]);
    expect(orderEvents).toEqual(['WORKSHOP_ASSIGNED', 'REPAIR_COMPLETED']);
  });

  it('relays a batch and marks exactly what it published', async () => {
    const store = new PrismaOutboxStore(prisma);
    const publisher = new InMemoryEventPublisher();
    const relay = new OutboxRelay({ store, publisher, batchSize: 100 });

    const pendingBefore = await store.pendingCount();
    expect(pendingBefore).toBeGreaterThan(0);

    const published = await relay.tick();

    expect(published).toBe(pendingBefore);
    expect(publisher.published).toHaveLength(pendingBefore);
    expect(await store.pendingCount()).toBe(0);

    // A second tick has nothing to do: a published row is never republished.
    expect(await relay.tick()).toBe(0);
  });
});
