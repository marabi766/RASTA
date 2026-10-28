import type { IdentityRepository } from '../src/identity/identity.repository';
import type { KeycloakAdminClient } from '../src/keycloak/keycloak.client';
import { KeycloakProjector } from '../src/keycloak/keycloak.projector';
import { fenceCounts, KeycloakWriteFences } from '../src/keycloak/keycloak-write-fence';
import { isClean, runProjectionCommand } from '../src/keycloak/projection.command';
import type { ExtendedPrismaClient, PrismaService } from '../src/prisma/prisma.service';
import { newPrisma } from './helpers';

/**
 * #458 r1 F4, against a real PostgreSQL: the fence aggregate outer-joins its
 * one clock row to `keycloak_write_attempt`, so on an **empty** table that
 * row is all there is — and a `COUNT(*)` counted it as a fence: one
 * outstanding, a report never clean, a rollback never ready.
 *
 * The table is made truly empty for the aggregate, whatever other runs left
 * in a shared database: a REPEATABLE READ transaction deletes every row and
 * reads in that one snapshot — no row another session commits meanwhile is
 * visible to it — then rolls back, touching nothing. The aggregate and the
 * backfill and reconcile reports are the real ones, read in that snapshot
 * (the fences built on the transaction's client).
 */

const ROLLBACK = new Error('rolled back: the test touched nothing');

describe('#458 r1 F4: an empty fence table counts zero fences', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.stop();
  });

  /** Runs `read` on a truly empty `keycloak_write_attempt`, then rolls everything back. */
  async function onAnEmptyTable<T>(read: (tx: ExtendedPrismaClient) => Promise<T>): Promise<T> {
    let result: T | undefined;
    await expect(
      prisma.client.$transaction(
        async (tx) => {
          await tx.$executeRaw`DELETE FROM keycloak_write_attempt`;
          const [{ rows }] = await tx.$queryRaw<
            Array<{ rows: bigint }>
          >`SELECT COUNT(*) AS rows FROM keycloak_write_attempt`;
          expect(rows).toBe(0n);
          result = await read(tx as unknown as ExtendedPrismaClient);
          throw ROLLBACK;
        },
        { isolationLevel: 'RepeatableRead', timeout: 30_000 },
      ),
    ).rejects.toBe(ROLLBACK);
    return result as T;
  }

  it('the aggregate: every count zero, its instant still read', async () => {
    const counts = await onAnEmptyTable((tx) => fenceCounts(tx));
    expect(counts).toEqual({
      live: 0,
      due: 0,
      accountMissing: 0,
      overdue: 0,
      expired: 0,
      total: 0,
      at: expect.any(Date),
    });
    expect(Number.isNaN(counts.at.getTime())).toBe(false);
  });

  it.each(['backfill', 'reconcile'] as const)(
    '%s of a realm with no accounts and no fences reports clean',
    async (mode) => {
      const report = await onAnEmptyTable(async (tx) => {
        // The fences on the snapshot's client: counts, owners and the
        // owed flush all read that one empty table.
        const fences = new KeycloakWriteFences({ client: tx } as unknown as PrismaService);
        const keycloak = {} as KeycloakAdminClient;
        return runProjectionCommand(mode, {
          repository: {
            listUserIdsWithAccount: async () => [],
            listUsersWithoutAccount: async () => [],
          } as Pick<IdentityRepository, 'listUserIdsWithAccount' | 'listUsersWithoutAccount'>,
          projector: new KeycloakProjector({} as IdentityRepository, keycloak, fences),
          keycloak,
          fences,
        });
      });
      expect(report.fences).toEqual({
        drained: 0,
        owed: 0,
        recoveriesAbandoned: 0,
        outstanding: 0,
        live: 0,
        due: 0,
        accountMissing: 0,
      });
      expect(isClean(report)).toBe(true);
    },
  );
});
