import { FleetRepository } from '../src/fleet/fleet.repository';
import { UsageService } from '../src/fleet/usage.service';
import type { RecordUsageDto } from '../src/fleet/dto';
import { asActor, cleanup, id, newPrisma, tenants } from './helpers';

/** ADR-073 PR 2a: attribution is a fact about the reported interval. */
describe('usage attribution by reported interval', () => {
  const org = tenants();
  const userId = id('USR');
  const prisma = newPrisma();
  const repository = new FleetRepository(prisma);
  const service = new UsageService(repository);
  const start = '2026-08-01T06:00:00.000Z';
  const end = '2026-08-01T14:00:00.000Z';
  const move = '2026-08-02T00:00:00.000Z';
  const asSupervisor = <T>(fn: () => Promise<T>) => asActor({ organizationId: org.a, userId }, fn);

  beforeAll(() => prisma.onModuleInit());
  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.stop();
  });

  async function fixture() {
    const assetId = id('AST');
    const driverA = id('DRV');
    const driverB = id('DRV');
    await asSupervisor(async () => {
      await prisma.client.assetRef.create({
        data: {
          id: assetId,
          organizationId: org.a,
          status: 'ACTIVE',
          syncedAt: new Date(),
          sourceEvent: 'ITEST',
        },
      });
      for (const driverId of [driverA, driverB]) {
        await prisma.client.driver.create({
          data: {
            id: driverId,
            organizationId: org.a,
            userId: driverId,
            createdBy: 'ITEST',
            updatedBy: 'ITEST',
          },
        });
      }
    });
    const assignment = async (
      driverId: string,
      startedAt: string,
      endedAt: string | null,
      organizationId = org.a,
      machine = assetId,
    ) =>
      asActor({ organizationId }, () =>
        prisma.client.assignment.create({
          data: {
            id: id('ASG'),
            organizationId,
            driverId,
            assetId: machine,
            startedAt: new Date(startedAt),
            endedAt: endedAt === null ? null : new Date(endedAt),
            assignedBy: 'ITEST',
          },
        }),
      );
    const reading = (overrides: Partial<RecordUsageDto> = {}): RecordUsageDto => ({
      assetId,
      periodStart: start,
      periodEnd: end,
      hours: '7.5',
      source: 'MANUAL',
      ...overrides,
    });
    return { assetId, driverA, driverB, assignment, reading };
  }

  it('attributes yesterday to A after the machine moved to B', async () => {
    const f = await fixture();
    const a = await f.assignment(f.driverA, start, move);
    await f.assignment(f.driverB, move, null);
    await expect(asSupervisor(() => service.record(f.reading()))).resolves.toMatchObject({
      driverId: f.driverA,
      assignmentId: a.id,
    });
  });

  it('leaves both unknown when the interval spans A and B', async () => {
    const f = await fixture();
    await f.assignment(f.driverA, start, move);
    await f.assignment(f.driverB, move, null);
    await expect(
      asSupervisor(() => service.record(f.reading({ periodEnd: '2026-08-02T01:00:00.000Z' }))),
    ).resolves.toMatchObject({ driverId: null, assignmentId: null });
  });

  it('leaves both unknown when multiple closed assignments cover it', async () => {
    const f = await fixture();
    await f.assignment(f.driverA, start, move);
    await f.assignment(f.driverB, start, move);
    await expect(asSupervisor(() => service.record(f.reading()))).resolves.toMatchObject({
      driverId: null,
      assignmentId: null,
    });
  });

  it.each([
    ['equal start and end', start, end],
    ['open end', start, null],
    ['one millisecond before start', '2026-08-01T05:59:59.999Z', end],
    ['one millisecond after end', start, '2026-08-01T14:00:00.001Z'],
  ])('includes boundaries: %s', async (_name, began, ended) => {
    const f = await fixture();
    const a = await f.assignment(f.driverA, began!, ended!);
    await expect(asSupervisor(() => service.record(f.reading()))).resolves.toMatchObject({
      driverId: f.driverA,
      assignmentId: a.id,
    });
  });

  it.each([
    ['starts too late', '2026-08-01T06:00:00.001Z', move],
    ['ends too early', start, '2026-08-01T13:59:59.999Z'],
  ])('rejects a non-covering assignment that %s', async (_name, began, ended) => {
    const f = await fixture();
    await f.assignment(f.driverA, began, ended);
    await expect(asSupervisor(() => service.record(f.reading()))).resolves.toMatchObject({
      driverId: null,
      assignmentId: null,
    });
  });

  it('keeps a named driver without linking their non-covering active assignment', async () => {
    const f = await fixture();
    await f.assignment(f.driverA, move, null);
    await expect(
      asSupervisor(() => service.record(f.reading({ driverId: f.driverA }))),
    ).resolves.toMatchObject({ driverId: f.driverA, assignmentId: null });
  });

  it('links a named driver to their covering closed assignment, not another driver or machine', async () => {
    const f = await fixture();
    const a = await f.assignment(f.driverA, start, move);
    await f.assignment(f.driverB, start, move);
    await f.assignment(f.driverA, start, move, org.a, id('AST'));
    await expect(
      asSupervisor(() => service.record(f.reading({ driverId: f.driverA }))),
    ).resolves.toMatchObject({ driverId: f.driverA, assignmentId: a.id });
  });

  it('does not choose among multiple covering assignments even for a named driver', async () => {
    const f = await fixture();
    await f.assignment(f.driverA, start, move);
    await f.assignment(f.driverA, start, move);
    await expect(
      asSupervisor(() => service.record(f.reading({ driverId: f.driverA }))),
    ).resolves.toMatchObject({ driverId: f.driverA, assignmentId: null });
  });

  it.each([
    ['does not cover', move, null],
    ['covers at the start boundary', start, 'linked'],
  ])('SELF active assignment %s', async (_name, began, link) => {
    const f = await fixture();
    const a = await f.assignment(f.driverA, began!, null);
    await expect(
      asActor({ organizationId: org.a, userId: f.driverA, roles: ['DRIVER'] }, () =>
        service.record(f.reading()),
      ),
    ).resolves.toMatchObject({ driverId: f.driverA, assignmentId: link ? a.id : null });
  });

  it('still refuses SELF with only a covering closed assignment', async () => {
    const f = await fixture();
    await f.assignment(f.driverA, start, move);
    await expect(
      asActor({ organizationId: org.a, userId: f.driverA, roles: ['DRIVER'] }, () =>
        service.record(f.reading()),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('keeps driver validation and SELF identity/asset restrictions', async () => {
    const f = await fixture();
    const other = await fixture();
    await f.assignment(f.driverA, start, null);
    await expect(
      asSupervisor(() => service.record(f.reading({ driverId: id('DRV') }))),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const asSelf = (request: RecordUsageDto) =>
      asActor({ organizationId: org.a, userId: f.driverA, roles: ['DRIVER'] }, () =>
        service.record(request),
      );
    await expect(asSelf(f.reading({ driverId: f.driverB }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(asSelf(f.reading({ assetId: other.assetId }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('never matches another tenant even for the same asset and period', async () => {
    const f = await fixture();
    const foreign = id('DRV');
    await asActor({ organizationId: org.b }, () =>
      prisma.client.driver.create({
        data: {
          id: foreign,
          organizationId: org.b,
          userId: foreign,
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
        },
      }),
    );
    await f.assignment(foreign, start, move, org.b);
    await expect(asSupervisor(() => service.record(f.reading()))).resolves.toMatchObject({
      driverId: null,
      assignmentId: null,
    });
  });

  it('replays stored attribution after the assignments change', async () => {
    const f = await fixture();
    const a = await f.assignment(f.driverA, start, null);
    const request = f.reading({ clientReference: id('REF') });
    const lookup = jest.spyOn(repository, 'findCoveringAssignment');
    const changedAt = '2026-08-01T07:00:00.000Z';
    const saved = await asSupervisor(() => service.record(request));
    await asSupervisor(() =>
      prisma.client.assignment.updateMany({ where: { id: a.id }, data: { endedAt: changedAt } }),
    );
    await f.assignment(f.driverB, changedAt, null);
    await expect(asSupervisor(() => service.record(request))).resolves.toEqual(saved);
    expect(lookup).toHaveBeenCalledTimes(1);
    lookup.mockRestore();
    expect(saved).toMatchObject({ driverId: f.driverA, assignmentId: a.id });
  });

  it('resolves after an assignment change committed ahead of the asset lock', async () => {
    const f = await fixture();
    const a = await f.assignment(f.driverA, start, null);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const change = asSupervisor(() =>
      repository.transaction(async (tx) => {
        await repository.lockAssetRef(tx, f.assetId);
        locked();
        await gate;
        await tx.assignment.updateMany({
          where: { id: a.id },
          data: { endedAt: new Date('2026-08-01T07:00:00.000Z') },
        });
      }),
    );
    await ready;
    let waiting!: () => void;
    const atLock = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const original = repository.lockAssetRef.bind(repository);
    const spy = jest.spyOn(repository, 'lockAssetRef').mockImplementation(async (tx, assetId) => {
      waiting();
      await original(tx, assetId);
    });
    const record = asSupervisor(() => service.record(f.reading()));
    try {
      await atLock;
      release();
      await change;
      await expect(record).resolves.toMatchObject({ driverId: null, assignmentId: null });
    } finally {
      release();
      await Promise.allSettled([change, record]);
      spy.mockRestore();
    }
  });

  it.each(['supervisor', 'SELF'])(
    'holds the %s assignment stable through commit even when the ending skips the asset lock',
    async (role) => {
      const f = await fixture();
      await f.assignment(f.driverA, start, null);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let writing!: () => void;
      const atEvent = new Promise<void>((resolve) => {
        writing = resolve;
      });
      const original = repository.enqueueEvent.bind(repository);
      const spy = jest
        .spyOn(repository, 'enqueueEvent')
        .mockImplementationOnce(async (tx, event) => {
          writing();
          await gate;
          return original(tx, event);
        });
      const record =
        role === 'SELF'
          ? asActor({ organizationId: org.a, userId: f.driverA, roles: ['DRIVER'] }, () =>
              service.record(f.reading()),
            )
          : asSupervisor(() => service.record(f.reading()));
      try {
        await atEvent;
        // Non-key updates are compatible with the FK's KEY SHARE lock alone:
        // this refusal therefore proves the attribution read took FOR SHARE.
        await expect(
          asSupervisor(() =>
            repository.transaction(async (tx) => {
              await tx.$executeRaw`SET LOCAL lock_timeout = '100ms'`;
              await tx.assignment.updateMany({
                where: { assetId: f.assetId, endedAt: null },
                data: { endedAt: new Date(move) },
              });
            }),
          ),
        ).rejects.toThrow('55P03');
      } finally {
        release();
        await record;
        spy.mockRestore();
      }
    },
  );
});
