import { ulid } from 'ulid';
import { RastaError, runUnscoped, runWithContext, type RequestContext } from '@rasta/nest-common';
import { MaintenanceRepository } from '../src/maintenance/maintenance.repository';
import { RequestService } from '../src/maintenance/request.service';
import { RepairOrderService } from '../src/maintenance/repair-order.service';
import { UnverifiedWorkshopDirectory } from '../src/maintenance/workshop.directory';
import { MaintenanceFactService, SOURCE_FACT_CALLER } from '../src/maintenance/source-fact';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, cleanup, id, newPrisma, seedAsset, tenants } from './helpers';

/**
 * The internal read economic-service checks `MAINTENANCE_APPROVED` against
 * (ADR-061 § 4), against a real PostgreSQL.
 *
 * Two properties, and both are about money:
 *
 *   - **It says what the event said.** An approval driven through the real
 *     lifecycle is read back and compared with the `MAINTENANCE_APPROVED`
 *     row in the outbox, field for field. If the two ever disagree, every
 *     genuine approval dead-letters, so the workshop rule is shared rather
 *     than copied (`findSettlingWorkshop`).
 *   - **It answers only economic-service, only inside the signed tenant.**
 *     Another organization's request is not found; another service, a user,
 *     and a service token with no organization are refused.
 */
describe('maintenance source fact', () => {
  let prisma: PrismaService;
  let repository: MaintenanceRepository;
  let requests: RequestService;
  let repairOrders: RepairOrderService;
  let facts: MaintenanceFactService;

  const org = tenants();
  const workshop = 'ORG-ITEST-FACT-WORKSHOP';
  let approvedId: string;

  /** A service-to-service call as the auth guard records it (ADR-035). */
  function asService<T>(
    callerService: string,
    organizationId: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const context: RequestContext = {
      correlationId: `itest-${ulid()}`,
      requestId: `itest-${ulid()}`,
      organizationId,
      roles: ['SERVICE'],
      organizationIds: [],
      authType: 'SERVICE',
      callerService,
      startedAt: Date.now(),
    };
    return runWithContext(context, async () => fn());
  }

  beforeAll(async () => {
    prisma = newPrisma();
    repository = new MaintenanceRepository(prisma);
    requests = new RequestService(repository);
    repairOrders = new RepairOrderService(repository, new UnverifiedWorkshopDirectory());
    facts = new MaintenanceFactService(repository);

    const assetId = id('AST-ITEST-FACT');
    await seedAsset(prisma, assetId, org.a);
    await seedAsset(prisma, id('AST-ITEST-FACT-B'), org.b);

    const request = await asActor({ organizationId: org.a }, () =>
      requests.create({ assetId, type: 'CORRECTIVE', severity: 'HIGH', title: 'نشتی روغن' }),
    );
    const order = await asActor({ organizationId: org.a }, () =>
      repairOrders.assign(request.id, { workshopOrganizationId: workshop }),
    );
    await asActor({ organizationId: org.a }, () => repairOrders.start(order.id, {}));
    await asActor({ organizationId: org.a }, () =>
      repairOrders.recordLabour(order.id, {
        description: 'تعویض کاسه‌نمد',
        hours: '2.50',
        hourlyRateMinor: '900000',
      }),
    );
    await asActor({ organizationId: org.a }, () =>
      repairOrders.complete(order.id, { workPerformed: 'کاسه‌نمد تعویض شد' }),
    );
    await asActor({ organizationId: org.a }, () => requests.approve(request.id, {}));
    approvedId = request.id;
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  it('states the approval exactly as MAINTENANCE_APPROVED announced it', async () => {
    const fact = await asService(SOURCE_FACT_CALLER, org.a, () => facts.requestFact(approvedId));

    const published = await runUnscoped('the suite reads the outbox it just wrote', () =>
      prisma.client.outboxMessage.findFirstOrThrow({
        where: { aggregateId: approvedId, eventName: 'MAINTENANCE_APPROVED' },
      }),
    );
    // The outbox row holds the whole envelope; the event's fields are its payload.
    const event = (published.payload as { payload: Record<string, unknown> }).payload;

    expect(fact.status).toBe('APPROVED');
    expect(fact.organizationId).toBe(event.organizationId);
    expect(fact.assetId).toBe(event.assetId);
    expect(fact.totalCostMinor).toBe(event.totalCostMinor);
    expect(fact.totalCostMinor).toBe('2250000');
    expect(fact.currency).toBe(event.currency);
    expect(fact.workshopOrganizationId).toBe(event.workshopOrganizationId);
    expect(fact.workshopOrganizationId).toBe(workshop);
    expect(fact.approvedBy).toBe(event.approvedBy);
    expect(fact.approvedAt).toBe(event.approvedAt);
    // Nothing a financial consumer does not compare.
    for (const field of ['title', 'description', 'reportedBy', 'approvalNotes']) {
      expect(fact).not.toHaveProperty(field);
    }
  });

  it('does not find a request in another organization — the tenant is the signed one', async () => {
    await expect(
      asService(SOURCE_FACT_CALLER, org.b, () => facts.requestFact(approvedId)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses every other service, and every user', async () => {
    await expect(
      asService('fleet-service', org.a, () => facts.requestFact(approvedId)),
    ).rejects.toBeInstanceOf(RastaError);
    await expect(
      asService('fleet-service', org.a, () => facts.requestFact(approvedId)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // An organization administrator, with every role that could approve:
    // still not a service, so still refused. The general read is theirs.
    await expect(
      asActor({ organizationId: org.a, roles: ['ORGANIZATION_ADMIN', 'SYSTEM_ADMIN'] }, () =>
        facts.requestFact(approvedId),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a service token that names no organization, before any query', async () => {
    await expect(
      asService(SOURCE_FACT_CALLER, undefined, () => facts.requestFact(approvedId)),
    ).rejects.toMatchObject({ code: 'SERVICE_TENANT_CONTEXT_INVALID' });
  });
});
