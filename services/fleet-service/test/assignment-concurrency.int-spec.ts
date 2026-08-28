import { PrismaService } from '../src/prisma/prisma.service';
import {
  FleetRepository,
  isUniqueViolation,
  violatedConstraint,
} from '../src/fleet/fleet.repository';
import { AssignmentService } from '../src/fleet/assignment.service';
import { identifyExclusivityConstraint } from '../src/fleet/constraints';
import { asActor, cleanup, id, newPrisma, tenants } from './helpers';

/**
 * The exclusivity invariants, under genuine concurrency.
 *
 * These cannot be tested against a mock: the property under test is that
 * PostgreSQL refuses the second of two overlapping inserts. An
 * application-level check would pass both — which is the whole reason the
 * invariant lives in a partial unique index (ADR-025).
 */
/**
 * A fixed instant, so nothing here depends on a clock.
 *
 * `started_at` used to carry a `now()` default, which meant a row could take
 * its start from PostgreSQL's clock and its end from Node's. Those differ —
 * measurably, on a WSL2 stack — and an assignment created and ended inside the
 * gap violated `ck_assignment_period` for no reason a reader could guess. The
 * default is gone now; setting the value explicitly here keeps the test honest
 * about the fact that the application owns this column.
 */
const STARTED_AT = new Date('2026-08-01T06:00:00.000Z');

describe('assignment exclusivity', () => {
  const org = tenants();
  let prisma: PrismaService;
  let repository: FleetRepository;
  let service: AssignmentService;

  const driverOne = id('DRV');
  const driverTwo = id('DRV');
  const assetOne = id('AST');
  const assetTwo = id('AST');

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new FleetRepository(prisma);
    service = new AssignmentService(repository);
    await cleanup(prisma, [org.a, org.b]);

    await asActor({ organizationId: org.a }, async () => {
      for (const driverId of [driverOne, driverTwo]) {
        await prisma.client.driver.create({
          data: { id: driverId, userId: `USR-${driverId}`, createdBy: 'ITEST', updatedBy: 'ITEST' },
        });
      }
      // The replica rows the assignment path checks before writing.
      for (const assetId of [assetOne, assetTwo]) {
        await prisma.client.assetRef.create({
          data: {
            id: assetId,
            organizationId: org.a,
            status: 'ACTIVE',
            syncedAt: new Date(),
            sourceEvent: 'ITEST',
          },
        });
      }
    });
  });

  afterEach(async () => {
    // Assignments only; drivers and asset refs are reused across tests.
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM outbox_message WHERE organization_id = $1`,
      org.a,
    );
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM assignment WHERE organization_id = $1`,
      org.a,
    );
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  describe('one active assignment per driver', () => {
    it('is enforced by the database, not only by the service', async () => {
      // Written straight through Prisma, bypassing every check in the service
      // layer. If the index were missing, this would succeed — which is
      // exactly the hole a corrective script or a future code path would fall
      // through.
      await asActor({ organizationId: org.a }, async () => {
        await prisma.client.assignment.create({
          data: {
            id: id('ASG'),
            driverId: driverOne,
            assetId: assetOne,
            startedAt: STARTED_AT,
            assignedBy: 'ITEST',
          },
        });

        try {
          await prisma.client.assignment.create({
            data: {
              id: id('ASG'),
              driverId: driverOne,
              assetId: assetTwo,
              startedAt: STARTED_AT,
              assignedBy: 'ITEST',
            },
          });
          throw new Error('expected the database to refuse a second active assignment');
        } catch (error) {
          expect(isUniqueViolation(error)).toBe(true);
          // Matched through `identifyExclusivityConstraint`, not against the
          // index name. Prisma reports the indexed *column* in `meta.target`
          // and never the index name — asserting the name here is what let the
          // production translation silently fall through to a generic
          // ALREADY_EXISTS before this suite ran against a real database.
          expect(identifyExclusivityConstraint(violatedConstraint(error))).toBe('driver');
        }
      });
    });

    it('permits a new assignment once the previous one has ended', async () => {
      // The index is partial — `WHERE ended_at IS NULL` — so history does not
      // block the future. A plain unique index would make a driver assignable
      // exactly once, ever.
      await asActor({ organizationId: org.a }, async () => {
        const first = id('ASG');
        await prisma.client.assignment.create({
          data: {
            id: first,
            driverId: driverOne,
            assetId: assetOne,
            startedAt: STARTED_AT,
            assignedBy: 'ITEST',
          },
        });
        await prisma.client.assignment.updateMany({
          where: { id: first },
          data: {
            endedAt: new Date(STARTED_AT.getTime() + 3_600_000),
            endedBy: 'ITEST',
            endReason: 'COMPLETED',
          },
        });

        await expect(
          prisma.client.assignment.create({
            data: {
              id: id('ASG'),
              driverId: driverOne,
              assetId: assetTwo,
              startedAt: STARTED_AT,
              assignedBy: 'ITEST',
            },
          }),
        ).resolves.toBeDefined();
      });
    });
  });

  describe('one active assignment per asset', () => {
    it('is enforced by the database', async () => {
      await asActor({ organizationId: org.a }, async () => {
        await prisma.client.assignment.create({
          data: {
            id: id('ASG'),
            driverId: driverOne,
            assetId: assetOne,
            startedAt: STARTED_AT,
            assignedBy: 'ITEST',
          },
        });

        try {
          await prisma.client.assignment.create({
            data: {
              id: id('ASG'),
              driverId: driverTwo,
              assetId: assetOne,
              startedAt: STARTED_AT,
              assignedBy: 'ITEST',
            },
          });
          throw new Error('expected the database to refuse a second driver on one machine');
        } catch (error) {
          expect(identifyExclusivityConstraint(violatedConstraint(error))).toBe('asset');
        }
      });
    });
  });

  describe('concurrent creation', () => {
    it('lets exactly one of two simultaneous assignments of the same machine win', async () => {
      // Both requests pass the service's pre-flight check — that is the point.
      // Only the index decides, and the loser is translated into the same
      // business error a sequential caller would have received, so a race is
      // indistinguishable from an ordinary conflict.
      const results = await asActor({ organizationId: org.a }, () =>
        Promise.allSettled([
          service.create({ driverId: driverOne, assetId: assetOne }),
          service.create({ driverId: driverTwo, assetId: assetOne }),
        ]),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const reason = (rejected[0] as PromiseRejectedResult).reason;
      expect(reason.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(reason.internalContext.rule).toBe('ASSET_ALREADY_ASSIGNED');

      const active = await asActor({ organizationId: org.a }, () =>
        repository.findActiveAssignments([assetOne]),
      );
      expect(active).toHaveLength(1);
    });

    it('lets exactly one of two simultaneous assignments of the same driver win', async () => {
      const results = await asActor({ organizationId: org.a }, () =>
        Promise.allSettled([
          service.create({ driverId: driverOne, assetId: assetOne }),
          service.create({ driverId: driverOne, assetId: assetTwo }),
        ]),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

      const reason = (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason;
      expect(reason.internalContext.rule).toBe('DRIVER_ALREADY_ASSIGNED');
    });

    it('publishes exactly one event for the assignment that won', async () => {
      // A rejected insert must not leave an outbox row behind. They share a
      // transaction, so a rollback takes both — this is what stops a phantom
      // ASSET_ASSIGNED from moving a machine to ASSIGNED in its dossier for an
      // assignment that never existed (ADR-021).
      await asActor({ organizationId: org.a }, () =>
        Promise.allSettled([
          service.create({ driverId: driverOne, assetId: assetOne }),
          service.create({ driverId: driverTwo, assetId: assetOne }),
        ]),
      );

      const events = await prisma.client.outboxMessage.findMany({
        where: { organizationId: org.a, eventName: 'ASSET_ASSIGNED' },
      });
      expect(events).toHaveLength(1);
    });
  });

  describe('concurrent ending', () => {
    it('lets exactly one of two simultaneous end requests succeed', async () => {
      // The guard is `where: { endedAt: null }` plus a row-count check. No
      // lock is taken; without the guard the second request would overwrite
      // the first one's end time and both would report success.
      const assignmentId = id('ASG');
      await asActor({ organizationId: org.a }, () =>
        prisma.client.assignment.create({
          data: {
            id: assignmentId,
            driverId: driverOne,
            assetId: assetOne,
            startedAt: STARTED_AT,
            assignedBy: 'ITEST',
          },
        }),
      );

      const results = await asActor({ organizationId: org.a }, () =>
        Promise.allSettled([
          service.end(assignmentId, { reason: 'COMPLETED' }),
          service.end(assignmentId, { reason: 'CANCELLED' }),
        ]),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

      const reason = (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason;
      expect(reason.code).toBe('INVALID_STATE_TRANSITION');

      const events = await prisma.client.outboxMessage.findMany({
        where: { organizationId: org.a, eventName: 'ASSIGNMENT_ENDED' },
      });
      expect(events).toHaveLength(1);
    });
  });

  describe('database check constraints', () => {
    it('refuses an assignment that ends before it started', async () => {
      await asActor({ organizationId: org.a }, async () => {
        const assignmentId = id('ASG');
        await prisma.client.assignment.create({
          data: {
            id: assignmentId,
            driverId: driverOne,
            assetId: assetOne,
            startedAt: new Date('2026-08-27T10:00:00Z'),
            assignedBy: 'ITEST',
          },
        });

        await expect(
          prisma.client.assignment.updateMany({
            where: { id: assignmentId },
            data: { endedAt: new Date('2026-08-27T09:00:00Z') },
          }),
        ).rejects.toThrow(/ck_assignment_period/);
      });
    });
  });
});
