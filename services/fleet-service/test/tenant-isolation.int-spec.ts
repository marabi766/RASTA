import { PrismaService } from '../src/prisma/prisma.service';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { asActor, cleanup, id, newPrisma, tenants } from './helpers';

/**
 * Tenant isolation, against a real database.
 *
 * AGENTS.md § 5 makes this test mandatory for any feature touching tenant
 * data, and a failure here is a data leak rather than a flaky test. It runs
 * against PostgreSQL rather than a mock precisely because the mechanism under
 * test — a Prisma client extension rewriting `where` clauses before they reach
 * the database — is invisible to a mock.
 */
describe('tenant isolation', () => {
  const org = tenants();
  let prisma: PrismaService;
  let repository: FleetRepository;

  const driverA = id('DRV');
  const driverB = id('DRV');
  const assignmentA = id('ASG');
  const assignmentB = id('ASG');
  const usageA = id('USG');
  const usageB = id('USG');
  const assetA = id('AST');
  const assetB = id('AST');

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new FleetRepository(prisma);
    await cleanup(prisma, [org.a, org.b]);

    // One tenant's fleet, then the other's. Both real rows: proving isolation
    // against an empty second tenant would prove nothing.
    for (const [organizationId, driverId, assetId, assignmentId, usageId] of [
      [org.a, driverA, assetA, assignmentA, usageA],
      [org.b, driverB, assetB, assignmentB, usageB],
    ] as const) {
      await asActor({ organizationId }, async () => {
        await prisma.client.driver.create({
          data: {
            id: driverId,
            userId: `USR-${driverId}`,
            createdBy: 'ITEST',
            updatedBy: 'ITEST',
          },
        });
        await prisma.client.assignment.create({
          data: { id: assignmentId, driverId, assetId, assignedBy: 'ITEST' },
        });
        await prisma.client.usageRecord.create({
          data: {
            id: usageId,
            assetId,
            driverId,
            assignmentId,
            periodStart: new Date('2026-08-27T06:00:00Z'),
            periodEnd: new Date('2026-08-27T14:00:00Z'),
            hours: '8',
            recordedBy: 'ITEST',
          },
        });
      });
    }
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  describe('reads', () => {
    it("tenant B cannot read tenant A's driver", async () => {
      const found = await asActor({ organizationId: org.b }, () =>
        repository.findDriverById(driverA),
      );
      // Absent, not forbidden. The repository returns null and the service
      // turns that into a 404, so an identifier probe learns nothing about
      // whether the record exists elsewhere (docs/09).
      expect(found).toBeNull();
    });

    it("tenant B cannot read tenant A's assignment", async () => {
      const found = await asActor({ organizationId: org.b }, () =>
        repository.findAssignmentById(assignmentA),
      );
      expect(found).toBeNull();
    });

    it("tenant B cannot read tenant A's usage record", async () => {
      const found = await asActor({ organizationId: org.b }, () =>
        repository.findUsageById(usageA),
      );
      expect(found).toBeNull();
    });

    it('each tenant sees only its own rows in a list', async () => {
      const listA = await asActor({ organizationId: org.a }, () =>
        repository.listDrivers({ limit: 50 }),
      );
      const listB = await asActor({ organizationId: org.b }, () =>
        repository.listDrivers({ limit: 50 }),
      );

      const idsA = listA.items.map((d) => d.id);
      const idsB = listB.items.map((d) => d.id);

      expect(idsA).toContain(driverA);
      expect(idsA).not.toContain(driverB);
      expect(idsB).toContain(driverB);
      expect(idsB).not.toContain(driverA);
    });

    it('an active-assignment lookup does not cross the boundary', async () => {
      // The exclusivity check runs through this query. If it saw another
      // tenant's rows, one organization could block another's assignments.
      const found = await asActor({ organizationId: org.b }, () =>
        repository.findActiveAssignmentForAsset(assetA),
      );
      expect(found).toBeNull();
    });
  });

  describe('writes', () => {
    it("tenant B cannot modify tenant A's driver", async () => {
      const result = await asActor({ organizationId: org.b }, () =>
        prisma.client.driver.updateMany({
          where: { id: driverA },
          data: { employeeNo: 'HIJACKED' },
        }),
      );

      expect(result.count).toBe(0);

      const untouched = await asActor({ organizationId: org.a }, () =>
        repository.findDriverById(driverA),
      );
      expect(untouched?.employeeNo).toBeNull();
    });

    it("tenant B cannot end tenant A's assignment", async () => {
      const result = await asActor({ organizationId: org.b }, () =>
        prisma.client.assignment.updateMany({
          where: { id: assignmentA, endedAt: null },
          data: { endedAt: new Date(), endedBy: 'ATTACKER' },
        }),
      );

      expect(result.count).toBe(0);

      const stillActive = await asActor({ organizationId: org.a }, () =>
        repository.findAssignmentById(assignmentA),
      );
      expect(stillActive?.endedAt).toBeNull();
    });

    it('refuses an explicit cross-tenant write rather than silently rewriting it', async () => {
      // Overwriting the caller's value would hide the bug; letting it through
      // would be the leak. The guard throws instead.
      await expect(
        asActor({ organizationId: org.b }, () =>
          prisma.client.driver.create({
            data: {
              id: id('DRV'),
              organizationId: org.a,
              userId: `USR-${id('X')}`,
              createdBy: 'ITEST',
              updatedBy: 'ITEST',
            },
          }),
        ),
      ).rejects.toThrow(/Cross-tenant writes are never implicit/);
    });

    it('refuses a query that names another tenant explicitly', async () => {
      await expect(
        asActor({ organizationId: org.b }, () =>
          prisma.client.driver.findMany({ where: { organizationId: org.a } }),
        ),
      ).rejects.toThrow(/Use runUnscoped\(\) if this is intentional/);
    });
  });

  describe('missing context', () => {
    it('throws rather than running unscoped', async () => {
      // The failure mode that matters: a code path with no request context
      // must produce a loud error, never a query that returns every
      // organization's rows (ADR-011).
      await expect(prisma.client.driver.findMany({})).rejects.toThrow(/No RequestContext/);
    });
  });
});
