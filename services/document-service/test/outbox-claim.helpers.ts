import { releaseWithin, type OutboxReleaseBound } from '@rasta/nest-common';
import { expireClaim } from '@rasta/testing';
import { PrismaService } from '../src/prisma/prisma.service';
import { databaseUrl, ownerDatabaseUrl } from './helpers';
import { readUrl } from '@rasta/config';

/**
 * An isolated `outbox_message` for the ADR-050 protocol suite.
 *
 * Its own schema, for a reason the suite depends on: `claimPending` is
 * deliberately unscoped — it serves every organization, so a tenant filter
 * there would strand another tenant's events — and it returns the **oldest**
 * rows in the table. Against the shared `public` schema, "two claimers get
 * disjoint batches" or "exactly `limit` rows come back" would be assertions
 * about what every other suite happens to have left behind, not about the
 * protocol. AGENTS.md § 5 forbids exactly that dependency.
 *
 * The table is created with `LIKE public.outbox_message INCLUDING ALL`, so it
 * carries the real column types, defaults, the five CHECK constraints and the
 * three partial indexes — whatever the migration actually produced, rather
 * than a hand-copied approximation that could drift from it.
 */
export const PROTOCOL_SCHEMA = 'outbox_claim_protocol_test';

function schemaUrl(schema: string): string {
  const url = readUrl(databaseUrl());
  url.searchParams.set('schema', schema);
  return url.toString();
}

/** A connection to the isolated schema. Each one is an independent "replica". */
export function newProtocolPrisma(): PrismaService {
  return new PrismaService(schemaUrl(PROTOCOL_SCHEMA));
}

/** The role the service — and so every protocol "replica" — connects as. */
const runtimeRole = () => decodeURIComponent(readUrl(databaseUrl()).username);

/**
 * Creates the isolated schema and table, as the owner (D-045: the runtime role
 * can create nothing), and gives the runtime role exactly what it has on
 * `public.outbox_message` — USAGE on the schema and DML on the table — so the
 * replicas run the protocol under the same privileges the service does.
 *
 * Run against `public`, because the schema it creates does not exist yet.
 */
export async function createProtocolSchema(): Promise<void> {
  const admin = new PrismaService(ownerDatabaseUrl());
  const runtime = runtimeRole();
  try {
    await admin.client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${PROTOCOL_SCHEMA}" CASCADE`);
    await admin.client.$executeRawUnsafe(`CREATE SCHEMA "${PROTOCOL_SCHEMA}"`);
    await admin.client.$executeRawUnsafe(
      `CREATE TABLE "${PROTOCOL_SCHEMA}".outbox_message
         (LIKE public.outbox_message INCLUDING ALL)`,
    );
    // Explicit search_path opt-in only: ordinary sessions still resolve pg_catalog.now.
    await admin.client.$executeRawUnsafe(
      `CREATE FUNCTION "${PROTOCOL_SCHEMA}".now() RETURNS timestamptz
         LANGUAGE sql STABLE
         AS 'SELECT pg_catalog.date_trunc(''milliseconds'', pg_catalog.now())'`,
    );
    await admin.client.$executeRawUnsafe(
      `GRANT EXECUTE ON FUNCTION "${PROTOCOL_SCHEMA}".now() TO "${runtime}"`,
    );
    await admin.client.$executeRawUnsafe(
      `GRANT USAGE ON SCHEMA "${PROTOCOL_SCHEMA}" TO "${runtime}"`,
    );
    await admin.client.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON "${PROTOCOL_SCHEMA}".outbox_message TO "${runtime}"`,
    );
  } finally {
    await admin.onModuleDestroy();
  }
}

export async function dropProtocolSchema(): Promise<void> {
  const admin = new PrismaService(ownerDatabaseUrl());
  try {
    await admin.client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${PROTOCOL_SCHEMA}" CASCADE`);
  } finally {
    await admin.onModuleDestroy();
  }
}

export interface SeedOptions {
  organizationId?: string;
  /** Forces `created_at`, so ties and ordering can be constructed on purpose. */
  createdAt?: Date;
  attempts?: number;
}

/**
 * Inserts one unpublished row.
 *
 * Written with raw SQL rather than the Prisma model so the suite can set
 * `created_at` exactly — the tie-break test needs several rows sharing a
 * millisecond, which `@default(now())` cannot produce on demand.
 */
export async function seedRow(
  prisma: PrismaService,
  id: string,
  options: SeedOptions = {},
): Promise<string> {
  await prisma.client.$executeRawUnsafe(
    `INSERT INTO outbox_message
       (id, aggregate_type, aggregate_id, event_name, event_version, topic,
        partition_key, payload, headers, organization_id, correlation_id,
        created_at, attempts, claim_count)
     VALUES ($1, 'Probe', $1, 'PROBE', 1, 't.probe', $1,
             '{}'::jsonb, '{}'::jsonb, $2, $3, $4, $5, 0)`,
    id,
    options.organizationId ?? 'ORG-PROTOCOL',
    `COR-${id}`,
    options.createdAt ?? new Date(),
    options.attempts ?? 0,
  );
  return id;
}

/** Everything the suite needs to see about a row, without a Prisma model round-trip. */
export interface RowState {
  id: string;
  published_at: Date | null;
  claim_token: string | null;
  claim_owner: string | null;
  claim_expires_at: Date | null;
  claim_count: number;
  attempts: number;
  next_attempt_at: Date | null;
  last_error: string | null;
}

export async function readRow(prisma: PrismaService, id: string): Promise<RowState> {
  const rows = await prisma.client.$queryRawUnsafe<RowState[]>(
    `SELECT id, published_at, claim_token, claim_owner, claim_expires_at,
            claim_count, attempts, next_attempt_at, last_error
       FROM outbox_message WHERE id = $1`,
    id,
  );
  const row = rows[0];
  if (!row) throw new Error(`no outbox row ${id}`);
  return row;
}

/** Empties the isolated table — DELETE, the right the runtime role has (D-045). */
export async function truncate(prisma: PrismaService): Promise<void> {
  await prisma.client.$executeRawUnsafe(`DELETE FROM outbox_message`);
}

/** A publisher whose completion the test controls, for the long-publish cases. */
export class GatedPublisher {
  private release?: () => void;
  private rejectWith?: (error: Error) => void;
  readonly started: Promise<void>;
  private startedResolve!: () => void;
  calls: string[][] = [];

  constructor() {
    this.started = new Promise<void>((resolve) => {
      this.startedResolve = resolve;
    });
  }

  publish = async (rows: readonly { id: string }[]): Promise<void> => {
    this.calls.push(rows.map((row) => row.id));
    this.startedResolve();
    await new Promise<void>((resolve, reject) => {
      this.release = resolve;
      this.rejectWith = reject;
    });
  };

  finish(): void {
    this.release?.();
  }

  fail(message: string): void {
    this.rejectWith?.(new Error(message));
  }
}

/** Advances a row's lease into the past without waiting for wall-clock time. */
export async function expireLease(prisma: PrismaService, id: string): Promise<void> {
  await expireClaim(prisma, [id]);
}

/** A lock held open on one connection until the test lets it go. */
export interface HeldLock {
  /** The ids this connection has locked and is still holding. */
  ids: string[];
  /** Ends the holding transaction. Await it before the suite tears down. */
  release: () => Promise<unknown>;
}

/**
 * Locks rows on `prisma` and keeps holding them until `release()` is called.
 *
 * This is what makes the contention tests deterministic rather than racy: a
 * real second claimant would hold its locks for an unpredictable window, so
 * instead one connection takes exactly the locks the scenario calls for and
 * holds them while the claim under test runs. No sleeps, no timing.
 *
 * `FOR UPDATE` without `SKIP LOCKED` on purpose — this connection is standing
 * in for the claimant that got there first.
 */
export async function holdLockOnOldest(
  prisma: PrismaService,
  limit: number,
  where = `published_at IS NULL
             AND (claim_expires_at IS NULL OR claim_expires_at <= now())
             AND (next_attempt_at  IS NULL OR next_attempt_at  <= now())`,
): Promise<HeldLock> {
  let letGo!: () => void;
  const gate = new Promise<void>((resolve) => {
    letGo = resolve;
  });

  let publishIds!: (ids: string[]) => void;
  const locked = new Promise<string[]>((resolve) => {
    publishIds = resolve;
  });

  const holding = prisma.client.$transaction(
    async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM outbox_message
          WHERE ${where}
          ORDER BY created_at, id
          LIMIT ${Math.trunc(limit)}
            FOR UPDATE`,
      );
      publishIds(rows.map((row) => row.id));
      await gate;
      return rows.length;
    },
    // Long enough that the claim under test always runs inside the window;
    // the test releases explicitly, so this is a backstop, not a wait.
    { timeout: 120_000, maxWait: 120_000 },
  );

  // Surfaces as a test failure rather than an unhandled rejection if the
  // holding transaction dies early.
  holding.catch(() => undefined);

  return {
    ids: await locked,
    release: () => {
      letGo();
      return holding;
    },
  };
}

// ---------------------------------------------------------------------------
// What a release's budget actually was (FU-048, Codex r1 on #644)
// ---------------------------------------------------------------------------

/** What one release showed at the three places its budget is decided. */
export interface ReleaseObservation {
  /** `released N`, the rejection's text, or `still waiting …` if neither came by the backstop. */
  readonly outcome: string;
  /** The time left that the bound reported to the release, in the order it was asked. */
  readonly reads: readonly number[];
  /** `timeout` and `maxWait` of every transaction start Prisma's engine was handed. */
  readonly starts: readonly { readonly timeout: unknown; readonly maxWait: unknown }[];
  /** UPDATE statements that reached PostgreSQL (the probe's count). */
  readonly updates: number;
  /** `statement_timeout`, in ms, PostgreSQL had in force when the last UPDATE began. */
  readonly statementTimeoutMs: number | null;
}

/** What the refusal of a release blocked on a lock may look like (see the spec). */
export const RELEASE_REFUSAL =
  /57014|statement timeout|expired transaction|Transaction not found\. Transaction ID is invalid/;

/**
 * Whether `seen` is a release refused under a budget of exactly `budgetMs`:
 *
 * - the release was refused, in one of the forms a blocked release has;
 * - the bound reported the whole budget when the release first read it, and
 *   never more;
 * - exactly one transaction started, and Prisma's engine was handed
 *   `timeout` and `maxWait` equal to what the release read first;
 * - exactly one UPDATE reached PostgreSQL, with a `statement_timeout` in force
 *   equal to what the release read second (the `SET LOCAL` is recomputed from
 *   the deadline, never carried over).
 *
 * The refusal alone proves nothing about the budget: a 5 000 ms transaction
 * and statement timeout also end before the backstop, with a message this
 * test accepts. So the budget is read where it is decided — the engine call
 * and the setting PostgreSQL holds — and compared with the deadline.
 */
export function refusedUnderBudget(seen: ReleaseObservation, budgetMs: number): boolean {
  const [first, second] = seen.reads;
  if (first === undefined || second === undefined) return false;
  if (!RELEASE_REFUSAL.test(seen.outcome)) return false;
  if (first !== budgetMs || seen.reads.some((left) => !(left > 0 && left <= budgetMs)))
    return false;
  if (seen.starts.length !== 1) return false;
  const [start] = seen.starts;
  if (start?.timeout !== Math.floor(first) || start?.maxWait !== Math.floor(first)) return false;
  return seen.updates === 1 && seen.statementTimeoutMs === Math.floor(second);
}

/** The side channel that reports the `statement_timeout` an UPDATE ran under. */
export interface ReleaseProbe {
  /** Forgets earlier UPDATEs. */
  reset(): Promise<void>;
  read(): Promise<{ updates: number; statementTimeoutMs: number | null }>;
  /** Drops it. Only once nothing holds a lock on the table (DROP TRIGGER waits for it). */
  remove(): Promise<void>;
}

/**
 * Installs, on the protocol table, a statement-level trigger that records
 * `statement_timeout` as PostgreSQL holds it when an UPDATE begins.
 *
 * Sequences are the record because they are not transactional: a release that
 * is cancelled behind a lock, or rolled back, still leaves what it saw. A
 * statement trigger runs before the UPDATE looks for a row, so it fires even
 * when that UPDATE then waits on a lock. The setting is read from
 * `pg_settings`, in ms, after `SET LOCAL` — the value actually in force.
 */
export async function installReleaseProbe(reader: PrismaService): Promise<ReleaseProbe> {
  const admin = new PrismaService(ownerDatabaseUrl());
  const runtime = runtimeRole();
  const schema = PROTOCOL_SCHEMA;
  const fires = `${schema}.release_probe_fires`;
  const ms = `${schema}.release_probe_ms`;
  try {
    for (const statement of [
      `CREATE SEQUENCE ${fires}`,
      `CREATE SEQUENCE ${ms} MINVALUE 0 START 0`,
      `CREATE FUNCTION ${schema}.release_probe() RETURNS trigger LANGUAGE plpgsql AS $f$
         BEGIN
           PERFORM nextval('${fires}');
           PERFORM setval('${ms}', (SELECT setting::bigint FROM pg_catalog.pg_settings
                                     WHERE name = 'statement_timeout'));
           RETURN NULL;
         END $f$`,
      `CREATE TRIGGER release_probe BEFORE UPDATE ON ${schema}.outbox_message
         FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.release_probe()`,
      `GRANT USAGE, SELECT, UPDATE ON SEQUENCE ${fires}, ${ms} TO "${runtime}"`,
    ]) {
      await admin.client.$executeRawUnsafe(statement);
    }
  } finally {
    await admin.onModuleDestroy();
  }
  return {
    reset: async () => {
      await reader.client.$queryRawUnsafe(
        `SELECT setval('${fires}', 1, false)::text, setval('${ms}', 0)::text`,
      );
    },
    read: async () => {
      const [row] = await reader.client.$queryRawUnsafe<{ updates: number; ms: number }[]>(
        `SELECT (SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM ${fires})::int AS updates,
                (SELECT last_value FROM ${ms})::int AS ms`,
      );
      const updates = row?.updates ?? 0;
      return { updates, statementTimeoutMs: updates > 0 ? (row?.ms ?? null) : null };
    },
    remove: async () => {
      const owner = new PrismaService(ownerDatabaseUrl());
      try {
        await owner.client.$executeRawUnsafe(
          `DROP TRIGGER IF EXISTS release_probe ON ${schema}.outbox_message`,
        );
        await owner.client.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${schema}.release_probe()`);
        await owner.client.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS ${fires}, ${ms}`);
      } finally {
        await owner.onModuleDestroy();
      }
    },
  };
}

/** The one engine call this wraps: Prisma 6's `transaction(action, headers, options)`. */
interface TransactionEngine {
  transaction: (action: string, headers: unknown, options: unknown) => Promise<unknown>;
}

/**
 * Runs a release on `service` under a bound that reports `budgetMs` at every
 * read (its clock is frozen, so the time left is the budget, with no wait for
 * the machine) and returns what it showed at the Prisma engine and at
 * PostgreSQL. The engine is restored afterwards.
 *
 * Fails, rather than records nothing, when Prisma no longer has the engine
 * where this reads it: an unreadable timeout must not look like a pass.
 */
export async function observeRelease(
  service: PrismaService,
  probe: ReleaseProbe,
  release: (bound: OutboxReleaseBound) => Promise<number>,
  budgetMs: number,
  backstopMs = 10_000,
): Promise<ReleaseObservation> {
  const base = (service as unknown as { base?: { _engine?: Partial<TransactionEngine> } }).base;
  const engine = base?._engine;
  if (engine === undefined || typeof engine.transaction !== 'function') {
    throw new Error('Prisma no longer exposes _engine.transaction; the timeout cannot be read');
  }
  const original = engine.transaction;
  const starts: { timeout: unknown; maxWait: unknown }[] = [];
  engine.transaction = function (this: unknown, action, headers, options) {
    if (action === 'start') {
      const { timeout, maxWait } = (options ?? {}) as { timeout?: unknown; maxWait?: unknown };
      starts.push({ timeout, maxWait });
    }
    return original.call(this, action, headers, options);
  };
  const frozen = releaseWithin(budgetMs, () => 0);
  const reads: number[] = [];
  const bound: OutboxReleaseBound = {
    remainingMs: () => {
      const left = frozen.remainingMs();
      reads.push(left);
      return left;
    },
  };
  let backstop: NodeJS.Timeout | undefined;
  try {
    await probe.reset();
    const outcome = await Promise.race([
      release(bound).then(
        (released) => `released ${released}`,
        (error: unknown) => String(error),
      ),
      new Promise<string>((resolve) => {
        backstop = setTimeout(() => resolve(`still waiting after ${backstopMs} ms`), backstopMs);
      }),
    ]);
    return { outcome, reads, starts, ...(await probe.read()) };
  } finally {
    clearTimeout(backstop);
    engine.transaction = original;
  }
}
