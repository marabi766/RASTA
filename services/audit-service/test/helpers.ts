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

/**
 * A runtime client with a pool wide enough to hold real concurrent writers.
 *
 * Prisma's default pool is `cpus * 2 + 1`, which is the right default for a
 * service and the wrong one for a suite that has to put many writers on one
 * chain's row lock at the same time: a writer blocked on the lock is holding a
 * connection, so a narrow pool turns contention into pool starvation and the
 * suite measures the pool instead of the chain.
 *
 * `pool_timeout` is widened for the same reason — the queue is expected here,
 * and a timeout would report a test-harness limit as a product failure.
 */
export function newPrismaWithPool(connections: number): PrismaService {
  const url = new URL(runtimeUrl());
  url.searchParams.set('connection_limit', String(connections));
  url.searchParams.set('pool_timeout', '60');
  return new PrismaService(url.toString());
}

/**
 * Runs `tasks` with at most `limit` of them in flight at once.
 *
 * Bounded rather than `Promise.all` over all of them, and the bound is a
 * property of the client rather than of the assertions: `AuditRepository.ingest`
 * opens an interactive transaction with Prisma's default two-second ceiling on
 * *acquiring* one, so launching a thousand at once against a finite pool fails
 * in the pool queue before any of them ever reaches the chain. The limit is set
 * just under the connection count so every in-flight call holds a real
 * connection and contends on the real row lock.
 */
export async function runConcurrently<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= tasks.length) return;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      results[index] = await tasks[index]!();
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/** A client connected as the schema owner. */
export function newMigratorPrisma(): PrismaService {
  return new PrismaService(migratorUrl());
}

export function id(prefix: string): string {
  return `${prefix}_${RUN_TAG}_${ulid()}`;
}

/**
 * A UTC month no other run and no other slot of this run will write into.
 *
 * The tenant chains these suites build are isolated for free: every
 * organization identifier carries `RUN_TAG`, so `(organization, month)` is
 * already unique to the run. The **platform** chain is not — its key is
 * `('PLATFORM', '', month)` and nothing in it carries a tag — so two runs that
 * both wrote a platform row into the same month would share one chain, and
 * `cleanupRun` would have to choose between deleting a head another run's rows
 * still depend on and refusing to clean at all.
 *
 * So the month itself becomes the isolation. Derived deterministically from the
 * tag and a slot number, in a range far outside the eighteen pre-built
 * partitions, so every one of these rows lands in `audit_event_default` — a
 * routing ADR-053 § 11 designs for and `ingestion.int-spec` already asserts.
 * Deterministic rather than random so a failure is reproducible from the tag
 * printed in the failure message.
 *
 * ~10,800 distinct months (900 years × 12) means two runs colliding is
 * remote; and if they ever did, `cleanupRun` refuses rather than corrupting.
 */
export function runMonth(slot: number, tag: string = RUN_TAG): string {
  // FNV-1a over `tag:slot`. A named, fixed hash rather than `Math.random`,
  // because the value has to be the same for the writer and for the reader in
  // a later `it` of the same file.
  let hash = 0x811c9dc5;
  for (const char of `${tag}:${slot}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const year = 2100 + (hash % 900);
  const month = 1 + ((hash >>> 16) % 12);
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

/** An instant `minutes` into a `YYYY-MM-01` month. */
export function instantIn(chainMonth: string, minutes: number): Date {
  return new Date(new Date(`${chainMonth}T00:00:00.000Z`).getTime() + minutes * 60_000);
}

/**
 * Interactive-transaction bounds for the cleanup below.
 *
 * Prisma defaults to a 5s ceiling, which the statements clear comfortably in a
 * plain run and do not clear under `--coverage`: istanbul instruments every
 * module in the process, and the suite failed to run at 5490ms with
 * "Transaction already closed". Splitting the work would fit the default, but
 * it would also mean an exit path that leaves `audit_event_append_only`
 * disabled — the one thing this transaction exists to make impossible. So the
 * bound is raised instead of the atomicity being given up.
 *
 * Still a bound and not a removal: a cleanup that genuinely hangs should fail
 * the suite rather than hold the trigger down indefinitely.
 */
const CLEANUP_TRANSACTION = { maxWait: 10_000, timeout: 120_000 } as const;

/** Every trigger that has to be enabled before and after a cleanup. */
export const PROTECTIVE_TRIGGERS = [
  'audit_event_append_only',
  'audit_event_append_only_truncate',
  'audit_chain_head_forward_only',
  'audit_chain_head_no_truncate',
] as const;

/** One `(chain_scope, organization_id, chain_month)` a run wrote into. */
export interface AffectedChain {
  readonly chainScope: 'ORGANIZATION' | 'PLATFORM';
  readonly organizationId: string;
  readonly chainMonth: string;
  /** Evidence rows in this chain that carry the run tag. */
  readonly taggedRows: number;
  /** Evidence rows in this chain that do **not**. Must be zero to clean. */
  readonly foreignRows: number;
}

/** What one cleanup removed, so a test can assert it was exact. */
export interface CleanupReport {
  readonly chains: AffectedChain[];
  readonly headsDeleted: number;
}

interface AffectedChainRow {
  chain_scope: 'ORGANIZATION' | 'PLATFORM';
  organization_id: string;
  chain_month: string;
  tagged_rows: bigint;
  foreign_rows: bigint;
}

/**
 * Which chains a run's evidence touches, and whether it owns them outright.
 *
 * The key is computed the same way `chainKeyOf`/`utcMonthOf` compute it —
 * scope from `organization_id IS NULL`, month from the UTC month of
 * `occurred_at` — because a cleanup that derived the key differently from the
 * writer would delete the wrong head, or none.
 *
 * `foreign_rows` is the exclusivity proof: rows sitting in the same chain that
 * this run did not write. It is counted per chain and never platform-wide, so
 * a run that shares nothing with anyone reads zero even in a database full of
 * other runs' data.
 *
 * ## Two sources of keys, and why the evidence alone is not enough
 *
 * A tenant chain's key *contains* the tag — `organization_id` is minted by
 * `id()` — so a head whose organization carries this run's tag is this run's
 * head whether or not any evidence still names it. That case is real: a suite
 * that deletes the records it wrote (the `CHAIN_TAIL_MISSING` probe deletes
 * one, and nothing stops a future one deleting all of them) would leave a head
 * with no tagged evidence behind it, and an evidence-only discovery would walk
 * straight past it. So tag-owned heads are unioned in.
 *
 * The platform chain cannot be discovered that way and must not be: its key is
 * `('PLATFORM', '', month)` and carries nothing tag-shaped, so matching on it
 * would reach every run's platform head. It is discovered from evidence only,
 * which is exactly what `runMonth` makes safe by giving each run its own month.
 */
async function affectedChains(
  tx: Pick<PrismaService['client'], '$queryRawUnsafe'>,
  like: string,
): Promise<AffectedChain[]> {
  const rows = await tx.$queryRawUnsafe<AffectedChainRow[]>(
    `
    WITH tagged AS (
      SELECT (CASE WHEN organization_id IS NULL THEN 'PLATFORM' ELSE 'ORGANIZATION' END) AS chain_scope,
             COALESCE(organization_id, '')                                              AS organization_id,
             date_trunc('month', occurred_at AT TIME ZONE 'UTC')::date                   AS chain_month
        FROM audit_event
       WHERE source_event_id LIKE $1 OR resource_id LIKE $1 OR correlation_id LIKE $1
    ),
    keys AS (
      SELECT DISTINCT chain_scope, organization_id, chain_month FROM tagged
      UNION
      SELECT h.chain_scope::text, h.organization_id, h.chain_month
        FROM audit_chain_head h
       WHERE h.chain_scope = 'ORGANIZATION'::audit_chain_scope
         AND h.organization_id LIKE $1
    )
    SELECT k.chain_scope,
           k.organization_id,
           to_char(k.chain_month, 'YYYY-MM-DD') AS chain_month,
           (SELECT count(*) FROM tagged t
             WHERE t.chain_scope     = k.chain_scope
               AND t.organization_id = k.organization_id
               AND t.chain_month     = k.chain_month) AS tagged_rows,
           (SELECT count(*) FROM audit_event e
             WHERE (CASE WHEN e.organization_id IS NULL THEN 'PLATFORM' ELSE 'ORGANIZATION' END)
                   = k.chain_scope
               AND COALESCE(e.organization_id, '') = k.organization_id
               AND e.occurred_at >= (k.chain_month::timestamp AT TIME ZONE 'UTC')
               AND e.occurred_at <  ((k.chain_month + INTERVAL '1 month')::timestamp AT TIME ZONE 'UTC')
               AND NOT (e.source_event_id LIKE $1 OR e.resource_id LIKE $1 OR e.correlation_id LIKE $1)
           ) AS foreign_rows
      FROM keys k
     ORDER BY k.chain_scope, k.organization_id, k.chain_month
    `,
    like,
  );

  return rows.map((row) => ({
    chainScope: row.chain_scope,
    organizationId: row.organization_id,
    chainMonth: row.chain_month,
    taggedRows: Number(row.tagged_rows),
    foreignRows: Number(row.foreign_rows),
  }));
}

/**
 * Removes only the rows a run created — and the chain heads that describe
 * exactly those rows — as the owner.
 *
 * Every identifier a suite writes carries `RUN_TAG`, so the predicate can never
 * reach a concurrent run's rows and never reaches a row this run did not write.
 *
 * ## Why the head has to go with the evidence, and only with it
 *
 * AUD-003 gave every chain a head row that names its tip. Deleting the evidence
 * and leaving the head behind is not "leftover state": the head still claims a
 * length, a tip hash and a segment start over records that no longer exist, and
 * the next writer in that `(organization, month)` links its record to a hash
 * nothing can produce. A later suite verifying that chain reads a divergence
 * this cleanup manufactured. So the head is deleted in the same transaction as
 * the evidence, and never before it is known that the run owns the chain.
 *
 * Refused rather than forced when it does not. If a chain still holds a row
 * this run did not write, deleting its head would fork *that* row's chain, so
 * the cleanup raises and says which chain. `runMonth` exists so the platform
 * chain — the one key with nothing tag-shaped in it — is isolated by
 * construction rather than by hope.
 *
 * Both row-level protections are suspended for the two deletes and restored
 * before the transaction commits, so there is no exit path that leaves the
 * store mutable: committing re-enables them and dying rolls the catalogue
 * change back. The TRUNCATE triggers are never touched, because nothing here
 * truncates.
 *
 * Cleanup runs as the migrator because the runtime role genuinely cannot do
 * this. That asymmetry is the design working.
 */
export async function cleanupRun(
  migrator: PrismaService,
  tag: string = RUN_TAG,
): Promise<CleanupReport> {
  if (!/^[0-9A-Z]{6,26}$/.test(tag)) {
    throw new Error(`refusing to clean up with a suspicious tag: ${JSON.stringify(tag)}`);
  }
  const like = `%_${tag}_%`;

  const report = await migrator.client.$transaction(async (tx) => {
    const chains = await affectedChains(tx, like);

    const contested = chains.filter((chain) => chain.foreignRows > 0);
    if (contested.length > 0) {
      // Raised before a single row is deleted, so a refusal changes nothing.
      throw new Error(
        `refusing to clean up run ${tag}: it does not own ${contested.length} of the ` +
          `${chains.length} chains it wrote into, and deleting their heads would fork ` +
          `another run's records — ` +
          contested
            .map(
              (chain) =>
                `${chain.chainScope}/${chain.organizationId || '(platform)'}/${chain.chainMonth} ` +
                `holds ${chain.foreignRows} untagged row(s)`,
            )
            .join('; '),
      );
    }

    await tx.$executeRawUnsafe('ALTER TABLE audit_event DISABLE TRIGGER audit_event_append_only');
    await tx.$executeRawUnsafe(
      'ALTER TABLE audit_chain_head DISABLE TRIGGER audit_chain_head_forward_only',
    );

    await tx.$executeRawUnsafe(
      `DELETE FROM audit_event WHERE source_event_id LIKE $1 OR resource_id LIKE $1 OR correlation_id LIKE $1`,
      like,
    );

    // Exactly the keys the evidence above belonged to, as a tuple list — never
    // a predicate that could widen. Nothing at all when the run wrote nothing.
    let headsDeleted = 0;
    if (chains.length > 0) {
      const tuples = chains
        .map(
          (_, index) =>
            `($${index * 3 + 1}::audit_chain_scope, $${index * 3 + 2}, $${index * 3 + 3}::date)`,
        )
        .join(', ');
      headsDeleted = await tx.$executeRawUnsafe(
        `DELETE FROM audit_chain_head
          WHERE (chain_scope, organization_id, chain_month) IN (${tuples})`,
        ...chains.flatMap((chain) => [chain.chainScope, chain.organizationId, chain.chainMonth]),
      );
    }

    await tx.$executeRawUnsafe(
      'ALTER TABLE audit_chain_head ENABLE TRIGGER audit_chain_head_forward_only',
    );
    await tx.$executeRawUnsafe('ALTER TABLE audit_event ENABLE TRIGGER audit_event_append_only');

    await tx.$executeRawUnsafe(`DELETE FROM processed_event WHERE event_id LIKE $1`, like);
    await tx.$executeRawUnsafe(`DELETE FROM organization_ref WHERE organization_id LIKE $1`, like);

    return { chains, headsDeleted };
  }, CLEANUP_TRANSACTION);

  await assertRunRemoved(migrator, report.chains, tag);
  return report;
}

/**
 * That the cleanup above actually finished, checked rather than assumed.
 *
 * Every one of these leaving a row behind is a way for the next suite to fail
 * for a reason that has nothing to do with what it tests — and a disabled
 * trigger left behind would make every append-only assertion after it
 * meaningless while still passing.
 */
export async function assertRunRemoved(
  migrator: PrismaService,
  chains: readonly AffectedChain[],
  tag: string = RUN_TAG,
): Promise<void> {
  const like = `%_${tag}_%`;
  const leftovers: string[] = [];

  const [{ count: events }] = await migrator.client.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*) AS count FROM audit_event
      WHERE source_event_id LIKE $1 OR resource_id LIKE $1 OR correlation_id LIKE $1`,
    like,
  );
  if (events > 0n) leftovers.push(`${events} audit_event row(s)`);

  const [{ count: markers }] = await migrator.client.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*) AS count FROM processed_event WHERE event_id LIKE $1`,
    like,
  );
  if (markers > 0n) leftovers.push(`${markers} processed_event row(s)`);

  const [{ count: refs }] = await migrator.client.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*) AS count FROM organization_ref WHERE organization_id LIKE $1`,
    like,
  );
  if (refs > 0n) leftovers.push(`${refs} organization_ref row(s)`);

  for (const chain of chains) {
    const [{ count: heads }] = await migrator.client.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*) AS count FROM audit_chain_head
        WHERE chain_scope = $1::audit_chain_scope AND organization_id = $2 AND chain_month = $3::date`,
      chain.chainScope,
      chain.organizationId,
      chain.chainMonth,
    );
    if (heads > 0n) {
      leftovers.push(
        `the head of ${chain.chainScope}/${chain.organizationId || '(platform)'}/${chain.chainMonth}`,
      );
    }
  }

  // And no tag-owned head anywhere, not merely none among the keys the cleanup
  // happened to discover. This is the check that catches a head whose evidence
  // a suite deleted for itself: the loop above can only look where the report
  // pointed it, and a key missing from the report is exactly the failure that
  // would leave a head claiming a length over records that no longer exist.
  // Scoped to `ORGANIZATION` because the platform key carries nothing
  // tag-shaped — asking the same question of it would answer about every run.
  const [{ count: ownedHeads }] = await migrator.client.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*) AS count FROM audit_chain_head
      WHERE chain_scope = 'ORGANIZATION'::audit_chain_scope AND organization_id LIKE $1`,
    like,
  );
  if (ownedHeads > 0n) leftovers.push(`${ownedHeads} tag-owned audit_chain_head row(s)`);

  const disabled = await disabledProtectiveTriggers(migrator);
  if (disabled.length > 0) leftovers.push(`disabled trigger(s) ${disabled.join(', ')}`);

  if (leftovers.length > 0) {
    throw new Error(`cleanup of run ${tag} left ${leftovers.join(', ')} behind`);
  }
}

/**
 * Any protective trigger that is not enabled, by name.
 *
 * `tgenabled = 'O'` is "fires in origin/local sessions", which is what
 * `ENABLE TRIGGER` restores. The row-level triggers are cloned to every
 * partition, so a partition left disabled is reported under its own name
 * rather than hidden behind the parent's.
 */
export async function disabledProtectiveTriggers(migrator: PrismaService): Promise<string[]> {
  const rows = await migrator.client.$queryRawUnsafe<{ label: string }[]>(
    `SELECT c.relname || '.' || t.tgname AS label
       FROM pg_trigger t
       JOIN pg_class c     ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND NOT t.tgisinternal
        AND t.tgname = ANY($1::text[])
        AND t.tgenabled <> 'O'
      ORDER BY 1`,
    [...PROTECTIVE_TRIGGERS],
  );
  return rows.map((row) => row.label);
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
