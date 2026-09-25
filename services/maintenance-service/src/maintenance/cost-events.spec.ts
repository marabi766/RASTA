import { runWithContext, type RequestContext } from '@rasta/nest-common';
import type { OutboxMessageInput } from '@rasta/nest-common';
import { RepairOrderService } from './repair-order.service';
import { UnverifiedWorkshopDirectory } from './workshop.directory';
import type { MaintenanceRepository } from './maintenance.repository';

/**
 * The cost-line events (L7-14).
 *
 * `recordPart`, `recordLabour` and `recordCost` each put money into the bill an
 * owner later approves, and each used to do it without a single event — so
 * audit-service, whose only input is the event log, never saw any of it.
 *
 * These tests pin the unit-level contract: exactly one event per write, about
 * the repair order, in the caller's tenant, attributed to the caller, with the
 * amounts as minor-unit strings and no free text. That the event commits with
 * the row — and rolls back with it — needs a real database, and is in
 * `test/cost-audit-event.int-spec.ts`.
 */
describe('cost-line events (L7-14)', () => {
  const ORG = 'ORG-UNIT-A';
  const ORDER = {
    id: 'RPO_UNIT',
    organizationId: ORG,
    maintenanceRequestId: 'MNT_UNIT',
    assetId: 'AST-UNIT-1',
    workshopOrganizationId: 'ORG-UNIT-WORKSHOP',
    currency: 'IRR',
    status: 'IN_PROGRESS',
  };

  let enqueued: OutboxMessageInput[];
  let costLines: { category: string; amountMinor: bigint }[];
  let service: RepairOrderService;

  beforeEach(() => {
    enqueued = [];
    costLines = [{ category: 'SERVICE', amountMinor: 1_000n }];

    const echo = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data }));
    const tx = {
      partUsage: { create: echo },
      laborEntry: { create: echo },
      maintenanceCost: {
        create: jest.fn(async ({ data }: { data: { category: string; amountMinor: bigint } }) => {
          costLines.push({ category: data.category, amountMinor: data.amountMinor });
          return { ...data };
        }),
      },
      repairOrder: { update: jest.fn(async () => ({})) },
      maintenanceRequest: { update: jest.fn(async () => ({})) },
    };

    const sum = () => {
      const byCategory = new Map<string, bigint>();
      for (const line of costLines) {
        byCategory.set(line.category, (byCategory.get(line.category) ?? 0n) + line.amountMinor);
      }
      return [...byCategory].map(([category, total]) => ({ category, total }));
    };

    const repository = {
      findRepairOrderById: jest.fn(async () => ORDER),
      transaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(tx)),
      lockRepairOrder: jest.fn(async () => true),
      sumCostsByCategory: jest.fn(async () => sum()),
      enqueueEvent: jest.fn(async (_tx: unknown, input: OutboxMessageInput) => {
        enqueued.push(input);
        return 'OUTBOX_UNIT';
      }),
    } as unknown as MaintenanceRepository;

    service = new RepairOrderService(repository, new UnverifiedWorkshopDirectory());
  });

  function asManager<T>(fn: () => Promise<T>): Promise<T> {
    const context: RequestContext = {
      correlationId: 'corr-unit',
      requestId: 'req-unit',
      organizationId: ORG,
      userId: 'USR-UNIT-MECHANIC',
      roles: ['FLEET_MANAGER'],
      organizationIds: [],
      authType: 'USER',
      startedAt: Date.now(),
    };
    return runWithContext(context, async () => fn());
  }

  function only(): { eventName: string; payload: Record<string, unknown> } & OutboxMessageInput {
    expect(enqueued).toHaveLength(1);
    const [event] = enqueued;
    expect(event!.aggregateType).toBe('RepairOrder');
    expect(event!.aggregateId).toBe(ORDER.id);
    expect(event!.organizationId).toBe(ORG);
    return event as never;
  }

  it('recordPart publishes exactly one REPAIR_PART_RECORDED with the amounts as strings', async () => {
    const part = await asManager(() =>
      service.recordPart(ORDER.id, {
        partName: 'شیلنگ هیدرولیک',
        partReference: 'HX-220',
        quantity: '2',
        unit: 'عدد',
        unitCostMinor: '250000',
        source: 'MARKETPLACE',
      }),
    );

    const event = only();
    expect(event.eventName).toBe('REPAIR_PART_RECORDED');
    expect(event.payload).toMatchObject({
      repairOrderId: ORDER.id,
      requestId: ORDER.maintenanceRequestId,
      assetId: ORDER.assetId,
      organizationId: ORG,
      workshopOrganizationId: ORDER.workshopOrganizationId,
      partUsageId: part.id,
      source: 'MARKETPLACE',
      quantity: '2',
      unitCostMinor: '250000',
      totalCostMinor: '500000',
      currency: 'IRR',
      recordedBy: 'USR-UNIT-MECHANIC',
      orderTotalCostMinor: '501000',
      requestTotalCostMinor: '501000',
    });
    expect(String(event.payload.costId)).toMatch(/^MCS_/);
  });

  it('recordLabour publishes exactly one REPAIR_LABOUR_RECORDED, without the technician', async () => {
    const entry = await asManager(() =>
      service.recordLabour(ORDER.id, {
        description: 'تعویض شیلنگ',
        technician: 'علی رضایی',
        hours: '1.50',
        hourlyRateMinor: '900000',
      }),
    );

    const event = only();
    expect(event.eventName).toBe('REPAIR_LABOUR_RECORDED');
    expect(event.payload).toMatchObject({
      laborEntryId: entry.id,
      hours: '1.50',
      hourlyRateMinor: '900000',
      totalCostMinor: '1350000',
      recordedBy: 'USR-UNIT-MECHANIC',
      orderTotalCostMinor: '1351000',
    });
    // A technician is a person; the event log is durable and read by everyone.
    expect(JSON.stringify(event.payload)).not.toContain('علی رضایی');
    expect(JSON.stringify(event.payload)).not.toContain('تعویض شیلنگ');
  });

  it('recordCost publishes exactly one REPAIR_COST_RECORDED, without the description', async () => {
    await asManager(() =>
      service.recordCost(ORDER.id, {
        category: 'SERVICE',
        amountMinor: '1200000',
        currency: 'IRR',
        description: 'ایاب و ذهاب',
      }),
    );

    const event = only();
    expect(event.eventName).toBe('REPAIR_COST_RECORDED');
    expect(event.payload).toMatchObject({
      category: 'SERVICE',
      amountMinor: '1200000',
      currency: 'IRR',
      orderTotalCostMinor: '1201000',
    });
    expect(JSON.stringify(event.payload)).not.toContain('ایاب و ذهاب');
  });

  it('publishes nothing when the write is refused before the transaction', async () => {
    // A completed repair order no longer accepts cost.
    ORDER.status = 'COMPLETED';
    await expect(
      asManager(() =>
        service.recordCost(ORDER.id, {
          category: 'SERVICE',
          amountMinor: '1',
          currency: 'IRR',
          description: 'پس از تکمیل',
        }),
      ),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    ORDER.status = 'IN_PROGRESS';
    expect(enqueued).toHaveLength(0);
  });
});
