import type { ExtendedPrismaClient } from './prisma.service';

/**
 * Takes a transaction lock, for a read that follows it, only under READ COMMITTED (FU-268).
 *
 * The read after a lock sees what a writer holding the same lock just committed only when each
 * statement takes a new snapshot: REPEATABLE READ and SERIALIZABLE read from before the wait, and
 * the lock protects nothing. So the lock is the schema's gate, `read_committed_xact_lock` (migration
 * 20261109120000_guards_read_committed), which refuses every other level once it holds the lock,
 * with `restrict_violation`, in the same call: the gate every database guard takes its lock
 * through. Nothing in this service takes an advisory lock any other way
 * (`read-committed-lock.spec.ts`).
 */
export async function lockReadCommitted(
  tx: ExtendedPrismaClient,
  key: bigint,
  guard: string,
  mode: 'exclusive' | 'shared' = 'exclusive',
): Promise<void> {
  const refusal = `${guard} is taken only under READ COMMITTED`;
  if (mode === 'shared') {
    await tx.$queryRaw`SELECT read_committed_xact_lock_shared(${key}::bigint, ${refusal}, ${guard})::text`;
  } else {
    await tx.$queryRaw`SELECT read_committed_xact_lock(${key}::bigint, ${refusal}, ${guard})::text`;
  }
}
