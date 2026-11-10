import { ZONE_SWITCHES, inSessionZone } from '@rasta/testing';
import { withUtcSession } from '@rasta/config';
import { ulid } from 'ulid';
import { PolicyReconciliationRepository } from '../src/approval/policy-reconciliation.repository';
import { ContractorStandingRepository } from '../src/tender/contractor-standing.repository';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * `enqueue` writes through Prisma, UTC wall time; the sweeper's raw SQL compared that
 * with the session's wall time, so a deferred task came due an offset early (FU-188).
 */
describe('policy_reconciliation_task deadlines in any session zone (real database)', () => {
  // The owner, on purpose: the transaction lifts the foreign key to the policy, so a task
  // needs no policy tree, and always rolls back.
  const url = process.env.DATABASE_URL_CONSTRUCTION_MIGRATOR;
  if (!url) throw new Error('DATABASE_URL_CONSTRUCTION_MIGRATOR is required');
  const prisma = new PrismaService(withUtcSession(url), 30_000);
  const row = 'policy_reconciliation_task WHERE policy_id = $1';

  afterAll(() => prisma.stop());

  const lifted = async (tx: { $executeRawUnsafe(sql: string): Promise<number> }) => {
    await tx.$executeRawUnsafe(
      `ALTER TABLE policy_reconciliation_task
         DROP CONSTRAINT policy_reconciliation_task_organization_id_policy_id_fkey`,
    );
    await tx.$executeRawUnsafe('DELETE FROM policy_reconciliation_task');
  };
  const newTask = (id: string) => ({
    id: `PRT_${id}`,
    organizationId: `ORG_${id}`,
    policyId: id,
    unionId: `U_${id}`,
    sourceEventId: `E_${id}`,
    movedOrganizationId: `M_${id}`,
    correlationId: `C_${id}`,
  });

  it.each(ZONE_SWITCHES)(
    'a task due later, written in %s and read in %s',
    async (first, second) => {
      await inSessionZone(prisma, async ({ db, tx, zone }) => {
        const repository = new PolicyReconciliationRepository(db);
        const id = ulid();
        await lifted(tx);
        await zone(first);
        // Prisma writes "ten minutes from now" as UTC wall time: not due, in any zone.
        await repository.enqueue(tx as never, [newTask(id)], new Date(Date.now() + 600_000));
        expect(await repository.claimDue(1000, 60, 'TOKEN')).toEqual([]);
        expect((await repository.backlog()).due).toBe(0);
        await zone(second);
        expect(await repository.claimDue(1000, 60, 'TOKEN')).toEqual([]);
        expect((await repository.backlog()).due).toBe(0);
      });
    },
  );

  it.each(ZONE_SWITCHES)('a lease written in %s and read in %s', async (first, second) => {
    await inSessionZone(prisma, async ({ db, tx, zone, secondsFromNow }) => {
      const repository = new PolicyReconciliationRepository(db);
      const id = ulid();
      await lifted(tx);
      await zone(first);
      await repository.enqueue(tx as never, [newTask(id)], new Date(Date.now() - 100_000));

      // Overdue by the wait, whichever zone reads the gauge.
      const backlog = await repository.backlog();
      expect(backlog.due).toBe(1);
      expect(Math.abs(backlog.oldestDueAgeSeconds - 100)).toBeLessThan(10);

      // Leased for exactly what was asked.
      const [claimed] = await repository.claimDue(1000, 60, 'TOKEN_A');
      expect(claimed?.policyId).toBe(id);
      expect(await secondsFromNow('lease_until', row, id)).toBe(60);

      // Mid-lease, in the other zone: still leased.
      await zone(second);
      expect(await repository.claimDue(1000, 60, 'TOKEN_B')).toEqual([]);

      // Parked for exactly the backoff, in either zone.
      await zone(first);
      expect(await repository.retryLater(claimed!, 'INTERNAL', 300)).toBe(1);
      expect(await secondsFromNow('next_attempt_at', row, id)).toBe(300);
      await zone(second);
      expect(await repository.claimDue(1000, 60, 'TOKEN_B')).toEqual([]);
    });
  });

  it.each(ZONE_SWITCHES)(
    'a lapsed lease, written in %s and retaken in %s',
    async (first, second) => {
      await inSessionZone(prisma, async ({ db, tx, zone, secondsFromNow }) => {
        const repository = new PolicyReconciliationRepository(db);
        const id = ulid();
        await lifted(tx);
        await zone(first);
        await repository.enqueue(tx as never, [newTask(id)], new Date(Date.now() - 100_000));
        const [lapsed] = await repository.claimDue(1000, -60, 'TOKEN_A');
        expect(lapsed?.policyId).toBe(id);
        await zone(second);
        const [retaken] = await repository.claimDue(1000, 60, 'TOKEN_B');
        expect(retaken?.leaseToken).toBe('TOKEN_B');
        // The closing stamps.
        expect(await repository.markDone(retaken!)).toBe(true);
        expect(await secondsFromNow('done_at', row, id)).toBeCloseTo(0, 2);
        expect(await secondsFromNow('updated_at', row, id)).toBeCloseTo(0, 2);
      });
    },
  );

  it.each(ZONE_SWITCHES)('the suspension transaction, %s then %s', async (first, second) => {
    await inSessionZone(prisma, async ({ db, tx, zone, secondsFromNow }) => {
      const repository = new PolicyReconciliationRepository(db);
      const [completed, released] = [ulid(), ulid()];
      await lifted(tx);
      await zone(first);
      await repository.enqueue(
        tx as never,
        [newTask(completed), newTask(released)],
        new Date(Date.now() - 100_000),
      );
      const claimed = await repository.claimDue(1000, 60, 'TOKEN');
      const of = (id: string) => claimed.find((task) => task.policyId === id)!;
      await zone(second);
      expect(
        await repository.complete(tx as never, of(completed), { currentGeneration: true }),
      ).toBe(1);
      expect(await secondsFromNow('done_at', row, completed)).toBeCloseTo(0, 2);
      await zone(first);
      expect(await repository.release(of(released))).toBe(1);
      expect(await secondsFromNow('updated_at', row, released)).toBeCloseTo(0, 2);
    });
  });

  it.each(['Asia/Tehran', 'America/Los_Angeles'])(
    'the standing stamps written in %s',
    async (name) => {
      await inSessionZone(prisma, async ({ db, tx, zone, secondsFromNow }) => {
        const standing = new ContractorStandingRepository(db);
        const organizationId = ulid();
        // The marker is never deleted, and an earlier suite may have left one: not in here.
        await tx.$executeRawUnsafe('ALTER TABLE standing_bootstrap DISABLE TRIGGER ALL');
        await tx.$executeRawUnsafe('DELETE FROM standing_bootstrap');
        await zone(name);
        await standing.recordQualified(organizationId, new Date(), tx as never);
        expect(
          await secondsFromNow(
            'updated_at',
            'contractor_standing WHERE organization_id = $1',
            organizationId,
          ),
        ).toBeCloseTo(0, 2);
        await standing.beginBootstrap(tx as never);
        const marker = 'standing_bootstrap WHERE id = $1';
        expect(await secondsFromNow('started_at', marker, 1)).toBeCloseTo(0, 2);
        expect(await secondsFromNow('updated_at', marker, 1)).toBeCloseTo(0, 2);
      });
    },
  );
});
