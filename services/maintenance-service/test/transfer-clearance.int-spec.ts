import { ulid } from 'ulid';
import type { EventEnvelope } from '@rasta/contracts';
import { runWithContext, type RequestContext } from '@rasta/nest-common';
import { MaintenanceRepository } from '../src/maintenance/maintenance.repository';
import { RequestService } from '../src/maintenance/request.service';
import { RepairOrderService } from '../src/maintenance/repair-order.service';
import { UnverifiedWorkshopDirectory } from '../src/maintenance/workshop.directory';
import { AssetSyncConsumer } from '../src/consumers/asset-sync.consumer';
import { CLEARANCE_CALLER, TransferClearanceService } from '../src/maintenance/transfer-clearance';
import { transferOpenWorkTotal } from '../src/observability/metrics';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, cleanup, id, newPrisma, seedAsset, tenants } from './helpers';

/**
 * The transfer clearance and its fence (ADR-062, docs/23 D-033), against
 * PostgreSQL.
 *
 * Codex's scenario: maintenance commits work for A, and before asset-service
 * hears of it A transfers the machine to B. Here the transfer asks first. A
 * reported breakdown, a started repair: each is counted, and a clear answer
 * fences the machine so no request can be raised under A until the transfer
 * lands. The race is made deterministic by holding the `asset-work` lock
 * while both contenders queue behind it.
 */
describe('transfer clearance', () => {
  const org = tenants();
  const workshop = 'ORG-ITEST-CLEARANCE-WORKSHOP';
  let prisma: PrismaService;
  let repository: MaintenanceRepository;
  let requests: RequestService;
  let repairOrders: RepairOrderService;
  let clearance: TransferClearanceService;
  let consumer: AssetSyncConsumer;

  beforeAll(async () => {
    prisma = newPrisma();
    repository = new MaintenanceRepository(prisma);
    requests = new RequestService(repository);
    repairOrders = new RepairOrderService(repository, new UnverifiedWorkshopDirectory());
    clearance = new TransferClearanceService(repository);
    consumer = new AssetSyncConsumer(null, repository);
    await cleanup(prisma, [org.a, org.b]);
  });

  afterEach(async () => {
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM asset_transfer_fence WHERE organization_id = ANY($1::text[])`,
      [org.a, org.b],
    );
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

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

  const fence = () => `TRF_${ulid()}`;

  const ask = (organizationId: string, assetId: string, fenceId = fence()) =>
    asService(CLEARANCE_CALLER, organizationId, () =>
      clearance.clear(assetId, { fenceId, ttlSeconds: 600 }),
    );

  async function machine(organizationId = org.a): Promise<string> {
    const assetId = id('AST-ITEST-CLR');
    await seedAsset(prisma, assetId, organizationId);
    return assetId;
  }

  const report = (organizationId: string, assetId: string) =>
    asActor({ organizationId }, () =>
      requests.create({ assetId, type: 'CORRECTIVE', severity: 'HIGH', title: 'نشتی روغن' }),
    );

  const transferred = (assetId: string, from = org.a, to = org.b): EventEnvelope => ({
    eventId: id('EVT'),
    eventName: 'ASSET_TRANSFERRED',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: 'asset-service',
    producerVersion: '0.1.0',
    aggregateType: 'Asset',
    aggregateId: assetId,
    tenantId: to,
    correlationId: id('COR'),
    payload: {
      assetId,
      fromOrganizationId: from,
      toOrganizationId: to,
      reason: 'واگذاری',
      referenceNo: null,
      transferredAt: new Date().toISOString(),
    },
  });

  const fenceRow = async (assetId: string) =>
    (
      await prisma.client.$queryRawUnsafe<{ organization_id: string; fence_id: string }[]>(
        `SELECT organization_id, fence_id FROM asset_transfer_fence WHERE asset_id = $1`,
        assetId,
      )
    )[0];

  const requestsOn = async (assetId: string) =>
    (
      await prisma.client.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM maintenance_request WHERE asset_id = $1`,
        assetId,
      )
    )[0]!.n;

  it('clears a machine with no open work, and the fence refuses a new request', async () => {
    const assetId = await machine();
    const fenceId = fence();

    const answer = await ask(org.a, assetId, fenceId);

    expect(answer).toMatchObject({
      assetId,
      fenceId,
      clear: true,
      openRequests: 0,
      openRepairOrders: 0,
    });
    expect(await fenceRow(assetId)).toMatchObject({ organization_id: org.a, fence_id: fenceId });
    await expect(report(org.a, assetId)).rejects.toMatchObject({
      code: 'BUSINESS_RULE_VIOLATION',
      internalContext: expect.objectContaining({ rule: 'ASSET_TRANSFER_IN_PROGRESS' }),
    });
    expect(await requestsOn(assetId)).toBe(0);
  });

  it('counts a reported breakdown that never changed the machine’s status', async () => {
    const assetId = await machine();
    await report(org.a, assetId);

    await expect(ask(org.a, assetId)).resolves.toMatchObject({
      clear: false,
      fencedUntil: null,
      openRequests: 1,
      openRepairOrders: 0,
    });
    expect(await fenceRow(assetId)).toBeUndefined();
  });

  it('counts a repair in the workshop, and answers counts only', async () => {
    const assetId = await machine();
    const request = await report(org.a, assetId);
    const order = await asActor({ organizationId: org.a }, () =>
      repairOrders.assign(request.id, { workshopOrganizationId: workshop }),
    );
    await asActor({ organizationId: org.a }, () => repairOrders.start(order.id, {}));

    const answer = await ask(org.a, assetId);

    expect(answer).toMatchObject({ clear: false, openRequests: 1, openRepairOrders: 1 });
    expect(Object.keys(answer).sort()).toEqual(
      ['assetId', 'clear', 'fenceId', 'fencedUntil', 'openRepairOrders', 'openRequests'].sort(),
    );
  });

  it('does not count finished work awaiting the owner’s approval', async () => {
    const assetId = await machine();
    const request = await report(org.a, assetId);
    const order = await asActor({ organizationId: org.a }, () =>
      repairOrders.assign(request.id, { workshopOrganizationId: workshop }),
    );
    await asActor({ organizationId: org.a }, () => repairOrders.start(order.id, {}));
    await asActor({ organizationId: org.a }, () =>
      repairOrders.complete(order.id, { workPerformed: 'تعویض کاسه‌نمد' }),
    );

    await expect(ask(org.a, assetId)).resolves.toMatchObject({ clear: true });
  });

  it('refuses a second transfer’s fence while one is live', async () => {
    const assetId = await machine();
    await ask(org.a, assetId);

    await expect(ask(org.a, assetId)).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('releases only its own fence', async () => {
    const assetId = await machine();
    const fenceId = fence();
    await ask(org.a, assetId, fenceId);

    await asService(CLEARANCE_CALLER, org.b, () => clearance.release(assetId, fenceId));
    expect(await fenceRow(assetId)).toBeDefined();
    await asService(CLEARANCE_CALLER, org.a, () => clearance.release(assetId, fenceId));
    expect(await fenceRow(assetId)).toBeUndefined();
    await expect(report(org.a, assetId)).resolves.toMatchObject({ assetId });
  });

  describe('when the transfer lands', () => {
    it('lifts the previous owner’s fence, refuses the previous owner, and admits the new one', async () => {
      const assetId = await machine();
      await ask(org.a, assetId);

      await consumer.handle(transferred(assetId));

      expect(await fenceRow(assetId)).toBeUndefined();
      await expect(report(org.a, assetId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // REGISTERED after a transfer is still maintainable; the new owner's
      // own work is not held up by a fence that was never theirs.
      await expect(report(org.b, assetId)).resolves.toMatchObject({ assetId });
    });

    it('counts work left with the previous owner, keeps it, and stops it going ahead (Q-74)', async () => {
      // Work from before this rule: the transfer was never asked about it.
      const assetId = await machine();
      const request = await report(org.a, assetId);
      const order = await asActor({ organizationId: org.a }, () =>
        repairOrders.assign(request.id, { workshopOrganizationId: workshop }),
      );
      const before = (await transferOpenWorkTotal.get()).values[0]?.value ?? 0;

      await consumer.handle(transferred(assetId));

      const after = (await transferOpenWorkTotal.get()).values[0]?.value ?? 0;
      expect(after - before).toBe(1);
      // Kept exactly as it was: not cancelled, not moved.
      const row = (
        await prisma.client.$queryRawUnsafe<{ organization_id: string; status: string }[]>(
          `SELECT organization_id, status FROM maintenance_request WHERE id = $1`,
          request.id,
        )
      )[0]!;
      expect(row).toEqual({ organization_id: org.a, status: 'OPEN' });
      // But it no longer starts under an owner that is not the owner.
      await expect(
        asActor({ organizationId: org.a }, () => repairOrders.start(order.id, {})),
      ).rejects.toMatchObject({
        internalContext: expect.objectContaining({ rule: 'ASSET_OWNER_CHANGED' }),
      });
    });
  });

  describe('tenant isolation', () => {
    it('does not answer about a machine the replica places in another organization', async () => {
      const assetId = await machine(org.a);
      await report(org.a, assetId);

      await expect(ask(org.b, assetId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await fenceRow(assetId)).toBeUndefined();
    });

    it('refuses every other service, every user, and a token with no organization', async () => {
      const assetId = await machine();
      const dto = { fenceId: fence(), ttlSeconds: 600 };

      await expect(
        asService('economic-service', org.a, () => clearance.clear(assetId, dto)),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        asActor({ organizationId: org.a, roles: ['ORGANIZATION_ADMIN', 'SYSTEM_ADMIN'] }, () =>
          clearance.clear(assetId, dto),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        asService(CLEARANCE_CALLER, undefined, () => clearance.clear(assetId, dto)),
      ).rejects.toMatchObject({ code: 'SERVICE_TENANT_CONTEXT_INVALID' });
      expect(await fenceRow(assetId)).toBeUndefined();
    });
  });

  describe('the race the fence closes', () => {
    /** Holds the machine's work lock exclusively until released. */
    async function holdWorkLock(assetId: string) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));

      const done = prisma.client.$transaction(
        async (tx) => {
          await repository.lockAssetForWork(tx as never, assetId, 'EXCLUSIVE');
          locked();
          await released;
        },
        { timeout: 30_000 },
      );

      await isLocked;
      return async () => {
        release();
        await done;
      };
    }

    async function waitForBlocked(n: number) {
      for (let attempt = 0; attempt < 400; attempt++) {
        const rows = await prisma.client.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        if (rows[0]!.n >= n) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`fewer than ${n} sessions ever blocked`);
    }

    it.each([
      ['the request queues first', 'request'],
      ['the clearance queues first', 'clearance'],
    ])('never answers clear while a request slips in: %s', async (_label, first) => {
      const assetId = await machine();

      const release = await holdWorkLock(assetId);
      const attempt = () =>
        report(org.a, assetId).then(
          () => 'REPORTED',
          (error: { code?: string }) => error.code ?? 'ERROR',
        );
      const question = () => ask(org.a, assetId);

      let reported: Promise<string>;
      let answered: ReturnType<typeof question>;
      if (first === 'request') {
        reported = attempt();
        await waitForBlocked(1);
        answered = question();
      } else {
        answered = question();
        await waitForBlocked(1);
        reported = attempt();
      }
      await waitForBlocked(2);
      await release();

      const [outcome, answer] = await Promise.all([reported, answered]);
      if (answer.clear) {
        expect(outcome).toBe('BUSINESS_RULE_VIOLATION');
        expect(await requestsOn(assetId)).toBe(0);
      } else {
        expect(outcome).toBe('REPORTED');
        expect(answer.openRequests).toBe(1);
        expect(await fenceRow(assetId)).toBeUndefined();
      }
      expect(answer.clear).toBe(first === 'clearance');
    });
  });
});
