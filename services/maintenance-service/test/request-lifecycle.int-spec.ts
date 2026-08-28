import { MaintenanceRepository } from '../src/maintenance/maintenance.repository';
import { RequestService } from '../src/maintenance/request.service';
import { RepairOrderService } from '../src/maintenance/repair-order.service';
import { UnverifiedWorkshopDirectory } from '../src/maintenance/workshop.directory';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, cleanup, id, newPrisma, seedAsset, tenants } from './helpers';

/**
 * The maintenance lifecycle, against a real database.
 *
 * Two things here cannot be tested any other way:
 *
 *   **The duplicate-request control.** docs/17 makes it mandatory and docs/05
 *   § 5.5 implements it as a partial unique index. Only PostgreSQL can tell
 *   two concurrent creates apart, and only a real `P2002` shows what Prisma
 *   actually reports in `meta.target` — which is the *columns*, never the
 *   index name. Code that matches on the name silently never matches, and that
 *   exact bug lived undetected in fleet-service until its first real
 *   integration run.
 *
 *   **Guarded status updates.** Two simultaneous completions, two approvals:
 *   the guard is `WHERE status = ...` and the affected-row count, and there is
 *   no way to observe it without two connections.
 */
describe('maintenance request lifecycle', () => {
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

  async function machine(status = 'ACTIVE'): Promise<string> {
    const assetId = id('AST-ITEST');
    await seedAsset(prisma, assetId, org.a, status);
    return assetId;
  }

  describe('the duplicate-request control', () => {
    it('refuses a second open request of the same kind for one machine', async () => {
      const assetId = await machine();

      await asActor({ organizationId: org.a }, () =>
        requests.create({ assetId, type: 'CORRECTIVE', severity: 'HIGH', title: 'نشتی روغن' }),
      );

      await expect(
        asActor({ organizationId: org.a }, () =>
          requests.create({
            assetId,
            type: 'CORRECTIVE',
            severity: 'LOW',
            title: 'همان نشتی، دوباره',
          }),
        ),
      ).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        internalContext: expect.objectContaining({ rule: 'DUPLICATE_OPEN_REQUEST' }),
      });
    });

    it('allows a different kind of work on the same machine', async () => {
      // The index is on `(asset_id, type)`: a machine can be down for a
      // breakdown and still have its oil change raised.
      const assetId = await machine();

      await asActor({ organizationId: org.a }, () =>
        requests.create({ assetId, type: 'CORRECTIVE', severity: 'HIGH', title: 'خرابی' }),
      );

      const preventive = await asActor({ organizationId: org.a }, () =>
        requests.create({ assetId, type: 'PREVENTIVE', title: 'سرویس دوره‌ای' }),
      );

      expect(preventive.status).toBe('OPEN');
    });

    it('refuses a concurrent duplicate the same way as a sequential one', async () => {
      // The race the pre-flight check cannot win. Both callers read "no open
      // request", both insert, and the index refuses one of them — which must
      // arrive as the same named business rule, not as a bare 409, or the
      // caller cannot tell what happened.
      const assetId = await machine();

      const attempts = await Promise.allSettled([
        asActor({ organizationId: org.a }, () =>
          requests.create({ assetId, type: 'CORRECTIVE', severity: 'HIGH', title: 'همزمان الف' }),
        ),
        asActor({ organizationId: org.a }, () =>
          requests.create({ assetId, type: 'CORRECTIVE', severity: 'HIGH', title: 'همزمان ب' }),
        ),
      ]);

      const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
      const rejected = attempts.filter((a) => a.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const reason = (rejected[0] as PromiseRejectedResult).reason;
      expect(reason.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(reason.internalContext.rule).toBe('DUPLICATE_OPEN_REQUEST');
    });

    it('frees the machine once the request is closed', async () => {
      const assetId = await machine();

      const first = await asActor({ organizationId: org.a }, () =>
        requests.create({ assetId, type: 'CORRECTIVE', severity: 'LOW', title: 'اول' }),
      );

      await asActor({ organizationId: org.a }, () =>
        requests.cancel(first.id, { reason: 'اشتباه ثبت شد' }),
      );

      const second = await asActor({ organizationId: org.a }, () =>
        requests.create({ assetId, type: 'CORRECTIVE', severity: 'LOW', title: 'دوم' }),
      );

      expect(second.status).toBe('OPEN');
    });
  });

  describe('state transitions', () => {
    it('carries a request from open to approved through a repair', async () => {
      const assetId = await machine();

      const request = await asActor({ organizationId: org.a }, () =>
        requests.create({
          assetId,
          type: 'CORRECTIVE',
          severity: 'HIGH',
          title: 'نشتی سیستم هیدرولیک',
          outOfServiceAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        }),
      );

      const order = await asActor({ organizationId: org.a }, () =>
        repairOrders.assign(request.id, { workshopOrganizationId: workshop }),
      );
      expect(order.status).toBe('OPEN');

      await asActor({ organizationId: org.a }, () => repairOrders.start(order.id, {}));
      expect(
        (await asActor({ organizationId: org.a }, () => requests.get(request.id))).status,
      ).toBe('IN_PROGRESS');

      await asActor({ organizationId: org.a }, () =>
        repairOrders.complete(order.id, { workPerformed: 'شیلنگ تعویض شد' }),
      );

      const completed = await asActor({ organizationId: org.a }, () => requests.get(request.id));
      expect(completed.status).toBe('COMPLETED');
      // Downtime is measured from when the machine stopped being usable, not
      // from when the workshop got to it — three days, not the minutes this
      // test took.
      expect(completed.downtimeMinutes).toBeGreaterThan(3 * 24 * 60 - 5);

      const approved = await asActor({ organizationId: org.a }, () =>
        requests.approve(request.id, { notes: 'تأیید شد' }),
      );
      expect(approved.status).toBe('APPROVED');
      expect(approved.approvedBy).toBeTruthy();
    });

    it('refuses to approve work that is not finished', async () => {
      const assetId = await machine();
      const request = await asActor({ organizationId: org.a }, () =>
        requests.create({ assetId, type: 'PREVENTIVE', title: 'سرویس' }),
      );

      await expect(
        asActor({ organizationId: org.a }, () => requests.approve(request.id, {})),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    });

    it('refuses to cancel an approved request, because it authorised settlement', async () => {
      const assetId = await machine();
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
      await asActor({ organizationId: org.a }, () => requests.approve(request.id, {}));

      await expect(
        asActor({ organizationId: org.a }, () =>
          requests.cancel(request.id, { reason: 'پشیمان شدیم' }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    });

    it('lets exactly one of two simultaneous approvals through', async () => {
      // Two approvals would publish two MAINTENANCE_APPROVED events and
      // authorise the same settlement twice. The guard is `WHERE status =
      // 'COMPLETED'` and the affected-row count.
      const assetId = await machine();
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

      const attempts = await Promise.allSettled([
        asActor({ organizationId: org.a }, () => requests.approve(request.id, {})),
        asActor({ organizationId: org.a }, () => requests.approve(request.id, {})),
      ]);

      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);

      const events = await asActor({ organizationId: org.a }, () =>
        repository.client.outboxMessage.findMany({
          where: { aggregateId: request.id, eventName: 'MAINTENANCE_APPROVED' },
        }),
      );
      expect(events).toHaveLength(1);
    });

    it('refuses an approval whose stated total no longer matches', async () => {
      // The control the product document makes mandatory is only a control if
      // the figure approved is the figure that was shown.
      const assetId = await machine();
      const request = await asActor({ organizationId: org.a }, () =>
        requests.create({ assetId, type: 'PREVENTIVE', title: 'سرویس' }),
      );
      const order = await asActor({ organizationId: org.a }, () =>
        repairOrders.assign(request.id, { workshopOrganizationId: workshop }),
      );
      await asActor({ organizationId: org.a }, () => repairOrders.start(order.id, {}));
      await asActor({ organizationId: org.a }, () =>
        repairOrders.recordCost(order.id, {
          category: 'SERVICE',
          amountMinor: '1200000',
          currency: 'IRR',
          description: 'هزینه ایاب و ذهاب',
        }),
      );
      await asActor({ organizationId: org.a }, () =>
        repairOrders.complete(order.id, { workPerformed: 'انجام شد' }),
      );

      await expect(
        asActor({ organizationId: org.a }, () =>
          requests.approve(request.id, { expectedTotalCostMinor: '0' }),
        ),
      ).rejects.toMatchObject({
        internalContext: expect.objectContaining({ rule: 'APPROVAL_TOTAL_MISMATCH' }),
      });

      // The correct figure is accepted.
      const approved = await asActor({ organizationId: org.a }, () =>
        requests.approve(request.id, { expectedTotalCostMinor: '1200000' }),
      );
      expect(approved.status).toBe('APPROVED');
    });
  });

  describe('referral', () => {
    it('allows only one live repair order per request', async () => {
      const assetId = await machine();
      const request = await asActor({ organizationId: org.a }, () =>
        requests.create({ assetId, type: 'PREVENTIVE', title: 'سرویس' }),
      );

      await asActor({ organizationId: org.a }, () =>
        repairOrders.assign(request.id, { workshopOrganizationId: workshop }),
      );

      await expect(
        asActor({ organizationId: org.a }, () =>
          repairOrders.assign(request.id, { workshopOrganizationId: 'ORG-ITEST-OTHER' }),
        ),
      ).rejects.toMatchObject({
        internalContext: expect.objectContaining({ rule: 'REPAIR_ORDER_ALREADY_OPEN' }),
      });
    });

    it('lets the work be referred elsewhere once a referral is withdrawn', async () => {
      const assetId = await machine();
      const request = await asActor({ organizationId: org.a }, () =>
        requests.create({ assetId, type: 'PREVENTIVE', title: 'سرویس' }),
      );
      const first = await asActor({ organizationId: org.a }, () =>
        repairOrders.assign(request.id, { workshopOrganizationId: workshop }),
      );

      await asActor({ organizationId: org.a }, () =>
        repairOrders.cancel(first.id, { reason: 'تعمیرگاه ظرفیت نداشت' }),
      );

      const second = await asActor({ organizationId: org.a }, () =>
        repairOrders.assign(request.id, { workshopOrganizationId: 'ORG-ITEST-OTHER' }),
      );

      expect(second.status).toBe('OPEN');
    });

    it('cancels a live referral with the request it was for', async () => {
      const assetId = await machine();
      const request = await asActor({ organizationId: org.a }, () =>
        requests.create({ assetId, type: 'PREVENTIVE', title: 'سرویس' }),
      );
      const order = await asActor({ organizationId: org.a }, () =>
        repairOrders.assign(request.id, { workshopOrganizationId: workshop }),
      );

      await asActor({ organizationId: org.a }, () =>
        requests.cancel(request.id, { reason: 'دستگاه اسقاط شد' }),
      );

      const row = await asActor({ organizationId: org.a }, () =>
        repository.findRepairOrderById(order.id),
      );
      expect(row?.status).toBe('CANCELLED');
    });
  });

  describe('the asset the work is for', () => {
    it('refuses a machine that has been decommissioned', async () => {
      const assetId = await machine('DECOMMISSIONED');

      await expect(
        asActor({ organizationId: org.a }, () =>
          requests.create({ assetId, type: 'CORRECTIVE', severity: 'LOW', title: 'خرابی' }),
        ),
      ).rejects.toMatchObject({
        internalContext: expect.objectContaining({ rule: 'ASSET_NOT_MAINTAINABLE' }),
      });
    });

    it('accepts a machine already withdrawn from service', async () => {
      // The one that would be wrong to refuse: a machine out of service is the
      // one most likely to need repairing.
      const assetId = await machine('OUT_OF_SERVICE');

      const request = await asActor({ organizationId: org.a }, () =>
        requests.create({ assetId, type: 'CORRECTIVE', severity: 'HIGH', title: 'تعمیر اساسی' }),
      );

      expect(request.status).toBe('OPEN');
    });
  });
});
