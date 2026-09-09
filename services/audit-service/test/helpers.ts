import { ulid } from 'ulid';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Integration scaffolding.
 *
 * Deliberately thin. The point of these suites is that they touch the real
 * database: the append-only guarantee lives in PostgreSQL privileges and
 * triggers, and a mock cannot refuse an UPDATE.
 */

/** One tag per test file, so two files can never collide on a row. */
export const RUN_TAG = ulid().slice(-10);

export function runtimeUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_AUDIT;
  if (!url) {
    throw new Error(
      'DATABASE_URL_AUDIT is not set. These tests run against a real PostgreSQL; ' +
        'start it with `pnpm infra:up` and copy .env.example to .env.',
    );
  }
  return url;
}

/**
 * The owner connection.
 *
 * Needed only by the tests that must *undo* an append-only control in order to
 * test the other one in isolation, and by cleanup — the runtime role cannot
 * delete its own rows, which is the entire point of the design.
 */
export function migratorUrl(): string {
  const url = process.env.DATABASE_URL_AUDIT_MIGRATOR;
  if (!url) {
    throw new Error(
      'DATABASE_URL_AUDIT_MIGRATOR is not set. The append-only suites need the owner ' +
        'connection to disable a control and to clean up rows the runtime role cannot delete.',
    );
  }
  return url;
}

export function brokers(): string[] | null {
  const raw = process.env.KAFKA_BROKERS;
  if (!raw) return null;
  return raw
    .split(',')
    .map((broker) => broker.trim())
    .filter(Boolean);
}

export function newPrisma(): PrismaService {
  return new PrismaService(runtimeUrl());
}

/** A client connected as the schema owner. */
export function newMigratorPrisma(): PrismaService {
  return new PrismaService(migratorUrl());
}

export function id(prefix: string): string {
  return `${prefix}_${RUN_TAG}_${ulid()}`;
}

/**
 * Removes only the rows a run created, as the owner.
 *
 * Every identifier this suite writes carries `RUN_TAG`, so the predicate can
 * never reach a concurrent run's rows — and never reaches a row this run did
 * not write. The triggers are suspended for the delete and restored in the same
 * transaction, so there is no exit path that leaves the store mutable:
 * committing re-enables them and dying rolls the catalogue change back.
 *
 * Cleanup runs as the migrator because the runtime role genuinely cannot do
 * this. That asymmetry is the design working.
 */
/**
 * Interactive-transaction bounds for the cleanup above.
 *
 * Prisma defaults to a 5s ceiling, which the five statements clear comfortably
 * in a plain run and do not clear under `--coverage`: istanbul instruments
 * every module in the process, and the suite failed to run at 5490ms with
 * "Transaction already closed". Splitting the work would fit the default, but
 * it would also mean an exit path that leaves `audit_event_append_only`
 * disabled — the one thing this transaction exists to make impossible. So the
 * bound is raised instead of the atomicity being given up.
 *
 * Still a bound and not a removal: a cleanup that genuinely hangs should fail
 * the suite rather than hold the trigger down indefinitely.
 */
const CLEANUP_TRANSACTION = { maxWait: 10_000, timeout: 60_000 } as const;

export async function cleanupRun(migrator: PrismaService, tag: string = RUN_TAG): Promise<void> {
  if (!/^[0-9A-Z]{6,26}$/.test(tag)) {
    throw new Error(`refusing to clean up with a suspicious tag: ${JSON.stringify(tag)}`);
  }
  const like = `%_${tag}_%`;

  await migrator.client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE audit_event DISABLE TRIGGER audit_event_append_only');
    await tx.$executeRawUnsafe(
      `DELETE FROM audit_event WHERE source_event_id LIKE $1 OR resource_id LIKE $1 OR correlation_id LIKE $1`,
      like,
    );
    await tx.$executeRawUnsafe('ALTER TABLE audit_event ENABLE TRIGGER audit_event_append_only');
    await tx.$executeRawUnsafe(`DELETE FROM processed_event WHERE event_id LIKE $1`, like);
    await tx.$executeRawUnsafe(`DELETE FROM organization_ref WHERE organization_id LIKE $1`, like);
  }, CLEANUP_TRANSACTION);
}

/** Waits for `check` to become truthy, or gives up with a readable failure. */
export async function waitFor<T>(
  description: string,
  check: () => Promise<T | null | undefined>,
  timeoutMs = 60_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;

  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${description}` +
      (last ? `; last error: ${String(last)}` : ''),
  );
}
