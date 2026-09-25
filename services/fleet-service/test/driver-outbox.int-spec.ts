import { PrismaService } from '../src/prisma/prisma.service';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { DriverService } from '../src/fleet/driver.service';
import { asActor, cleanup, id, newPrisma, tenants } from './helpers';

/**
 * Driver profile edits, against a real database.
 *
 * Before L3-11, `DriverService.update` wrote the row and nothing else — no
 * outbox row, no way for audit-service (whose only input is events) to ever
 * learn a licence number had changed. This is the proof the audit asked for:
 * the update and its event commit in the same transaction, and a rollback of
 * one is a rollback of both.
 */
describe('driver profile updates', () => {
  const org = tenants();
  let prisma: PrismaService;
  let repository: FleetRepository;
  let service: DriverService;

  const userId = `USR-ITEST-${id('X').slice(-8)}`;
  let driverId: string;

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new FleetRepository(prisma);
    service = new DriverService(repository);
    await cleanup(prisma, [org.a, org.b]);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    const created = await asActor({ organizationId: org.a }, () =>
      service.create({ userId: `${userId}-${id('U').slice(-6)}`, employeeNo: 'EMP-1' }),
    );
    driverId = created.id;
  });

  it('writes the update and its outbox row in one transaction', async () => {
    const updated = await asActor({ organizationId: org.a }, () =>
      service.update(driverId, { licenceNumber: 'LIC-9911' }),
    );
    expect(updated.licenceNumber).toBe('LIC-9911');

    const outbox = await prisma.client.outboxMessage.findMany({
      where: { organizationId: org.a, aggregateId: driverId, eventName: 'DRIVER_UPDATED' },
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.partitionKey).toBe(driverId);
  });

  it('records who made the change and when', async () => {
    await asActor({ organizationId: org.a, userId: 'USR-ITEST-EDITOR' }, () =>
      service.update(driverId, { licenceClass: 'C' }),
    );

    const outbox = await prisma.client.outboxMessage.findFirstOrThrow({
      where: { organizationId: org.a, aggregateId: driverId, eventName: 'DRIVER_UPDATED' },
    });
    const envelope = outbox.payload as { actor?: { id: string }; occurredAt: string };
    expect(envelope.actor?.id).toBe('USR-ITEST-EDITOR');
    expect(Date.parse(envelope.occurredAt)).not.toBeNaN();
  });

  it('rolls the edit back when its event cannot be written', async () => {
    const spy = jest
      .spyOn(repository, 'enqueueEvent')
      .mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(
      asActor({ organizationId: org.a }, () =>
        service.update(driverId, { licenceNumber: 'LIC-NEVER' }),
      ),
    ).rejects.toThrow('outbox unavailable');
    spy.mockRestore();

    const row = await asActor({ organizationId: org.a }, () =>
      prisma.client.driver.findFirstOrThrow({ where: { id: driverId } }),
    );
    expect(row.licenceNumber).not.toBe('LIC-NEVER');
  });

  it("cannot edit another tenant's driver, and publishes nothing for it", async () => {
    await expect(
      asActor({ organizationId: org.b }, () =>
        service.update(driverId, { licenceNumber: 'LIC-CROSS' }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const outbox = await prisma.client.outboxMessage.findMany({
      where: { aggregateId: driverId, eventName: 'DRIVER_UPDATED' },
    });
    expect(outbox).toHaveLength(0);
  });

  it('carries only the changed field names, never their values', async () => {
    await asActor({ organizationId: org.a }, () =>
      service.update(driverId, { licenceNumber: 'LIC-SECRET-7788', notes: 'یادداشت' }),
    );

    const outbox = await prisma.client.outboxMessage.findFirstOrThrow({
      where: { organizationId: org.a, aggregateId: driverId, eventName: 'DRIVER_UPDATED' },
    });
    const envelope = outbox.payload as { payload: { changedFields: string[] } };

    expect(envelope.payload.changedFields.sort()).toEqual(['licenceNumber', 'notes']);
    // The value itself must never reach the log this event lives on.
    expect(JSON.stringify(outbox.payload)).not.toContain('LIC-SECRET-7788');
  });

  it('writes no event for an edit refused on a stale version', async () => {
    // Deterministic, not a race: a Promise.allSettled pair only collides when
    // both calls happen to read the row before either writes, and when they
    // do not, both succeed legitimately — which made the earlier version of
    // this test fail about one run in several. Here the second writer is
    // handed the row as it was before the first edit.
    const stale = await asActor({ organizationId: org.a }, () =>
      repository.findDriverById(driverId),
    );
    await asActor({ organizationId: org.a }, () =>
      service.update(driverId, { employeeNo: 'EMP-RACE-A' }),
    );

    jest.spyOn(repository, 'findDriverById').mockResolvedValueOnce(stale);
    await expect(
      asActor({ organizationId: org.a }, () =>
        service.update(driverId, { employeeNo: 'EMP-RACE-B' }),
      ),
    ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });

    const outbox = await prisma.client.outboxMessage.findMany({
      where: { organizationId: org.a, aggregateId: driverId, eventName: 'DRIVER_UPDATED' },
    });
    expect(outbox).toHaveLength(1);
  });

  it('writes one event per edit that commits when two edits run at once', async () => {
    // Whichever way the two interleave, an event exists exactly for each
    // edit that committed — never for one that was refused.
    const results = await asActor({ organizationId: org.a }, () =>
      Promise.allSettled([
        service.update(driverId, { employeeNo: 'EMP-CONC-A' }),
        service.update(driverId, { employeeNo: 'EMP-CONC-B' }),
      ]),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const rejected of results.filter((r) => r.status === 'rejected')) {
      expect((rejected as PromiseRejectedResult).reason).toMatchObject({
        code: 'OPTIMISTIC_LOCK_FAILED',
      });
    }

    const outbox = await prisma.client.outboxMessage.findMany({
      where: { organizationId: org.a, aggregateId: driverId, eventName: 'DRIVER_UPDATED' },
    });
    expect(outbox).toHaveLength(fulfilled.length);
  });
});
