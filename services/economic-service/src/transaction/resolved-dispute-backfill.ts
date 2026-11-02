import type { ExtendedPrismaClient } from '../prisma/prisma.service';

/**
 * Attributes the resolutions recorded before `resolved_dispute_id` existed, in
 * bounded batches (migration 20261022120000_transaction_resolved_dispute;
 * Codex on #352, finding 1; docs/23 D-060).
 *
 * The migration only changes the catalogue. The rows it cannot be sure of
 * stay NULL; the ones it can — PENDING_SETTLEMENT or SETTLED after a dispute —
 * the trigger attributes on their next write. This writes the rest, so a
 * settled row, which is never written again, is attributed too. Not a
 * migration: it changes data, and a migration is one transaction, whose locks
 * last as long as the table is large.
 *
 * Each batch is its own short transaction over the next `batchSize` rows by
 * primary key, holding the locks of only those it attributes, with its own
 * `lock_timeout` and `statement_timeout`: a move of one of those rows waits
 * at most one batch, and a batch that would wait on one fails instead and the
 * run stops, resumable with `after`. The value written is not this code's:
 * the trigger replaces whatever the UPDATE sets with the attribution it
 * derives from the row as it stands under the lock, so a dispute, resolution,
 * settlement or refund committed between batches, or waited for by one,
 * cannot be mis-attributed.
 */

export interface ResolvedDisputeBackfillOptions {
  /** Write. Without it the run counts the unattributed rows and changes nothing. */
  apply: boolean;
  /** Rows read per batch, by primary key. */
  batchSize: number;
  /** Stop after this many batches — a bounded, resumable slice. Null: to the end. */
  maxBatches: number | null;
  /** Start after this transaction id: the `lastId` a stopped run reported. */
  after: string;
  /** Each batch's `statement_timeout`. */
  statementTimeoutMs: number;
  /** Each batch's `lock_timeout`: how long it may wait on a row a move holds. */
  lockTimeoutMs: number;
}

export const RESOLVED_DISPUTE_BACKFILL_DEFAULTS: ResolvedDisputeBackfillOptions = {
  apply: false,
  batchSize: 500,
  maxBatches: null,
  after: '',
  statementTimeoutMs: 2_000,
  lockTimeoutMs: 1_000,
};

export type ResolvedDisputeBackfillEvent =
  | { event: 'plan'; unattributed: number }
  | { event: 'batch'; batch: number; scanned: number; attributed: number; lastId: string }
  | { event: 'failed'; batch: number; after: string; code: string | null }
  | {
      event: 'summary';
      status: 'planned' | 'done' | 'incomplete' | 'failed';
      batches: number;
      attributed: number;
      unattributed: number;
      lastId: string;
    };

const BOUNDS = {
  batchSize: [1, 5_000],
  maxBatches: [1, 1_000_000],
  statementTimeoutMs: [100, 60_000],
  lockTimeoutMs: [100, 10_000],
} as const;

const FLAGS: Record<string, keyof ResolvedDisputeBackfillOptions> = {
  '--batch-size': 'batchSize',
  '--max-batches': 'maxBatches',
  '--after': 'after',
  '--statement-timeout-ms': 'statementTimeoutMs',
  '--lock-timeout-ms': 'lockTimeoutMs',
};

/** The command line's options; throws on anything it does not know or that is out of range. */
export function parseResolvedDisputeBackfillArgs(
  argv: readonly string[],
): ResolvedDisputeBackfillOptions {
  const options: ResolvedDisputeBackfillOptions = { ...RESOLVED_DISPUTE_BACKFILL_DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = String(argv[i]);
    if (flag === '--apply') {
      options.apply = true;
      continue;
    }
    const name = Object.hasOwn(FLAGS, flag) ? FLAGS[flag] : undefined;
    const value = argv[i + 1];
    // Not repeated: only an option that matched is ever echoed (#385 r6).
    if (!name) throw new Error(`Unknown option at position ${i + 1}; it is not repeated`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    i += 1;
    if (name === 'after') {
      options.after = value;
      continue;
    }
    const [min, max] = BOUNDS[name as keyof typeof BOUNDS];
    const n = Number(value);
    if (!/^[0-9]+$/.test(value) || n < min || n > max) {
      throw new Error(`${flag} must be an integer in ${min}..${max}`);
    }
    (options as unknown as Record<string, number>)[name] = n;
  }
  return options;
}

/** Rows whose attribution is certain and not yet written — the migration's rule. */
async function unattributed(client: ExtendedPrismaClient): Promise<number> {
  const [row] = await client.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "transaction"
     WHERE "status" IN ('PENDING_SETTLEMENT', 'SETTLED')
       AND "disputed_at" IS NOT NULL
       AND "dispute_resolved_at" IS NOT NULL
       AND "dispute_id" IS NOT NULL
       AND "resolved_dispute_id" IS NULL`;
  return row?.n ?? 0;
}

/** One batch: the next `batchSize` rows after `after`, the certain ones among them attributed. */
async function batch(
  client: ExtendedPrismaClient,
  after: string,
  options: ResolvedDisputeBackfillOptions,
): Promise<{ scanned: number; attributed: number; lastId: string | null }> {
  return client.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${options.lockTimeoutMs}ms`}, true),
                                set_config('statement_timeout', ${`${options.statementTimeoutMs}ms`}, true)`;
      // `resolved_dispute_id = "dispute_id"` names the column the trigger
      // fires on; the value it keeps is its own (see the migration).
      const [row] = await tx.$queryRaw<
        { scanned: number; attributed: number; last_id: string | null }[]
      >`
        WITH slice AS (
          SELECT "id" FROM "transaction" WHERE "id" > ${after} ORDER BY "id" LIMIT ${options.batchSize}
        ), attributed AS (
          UPDATE "transaction" t
             SET "resolved_dispute_id" = t."dispute_id"
            FROM slice
           WHERE t."id" = slice."id"
             AND t."status" IN ('PENDING_SETTLEMENT', 'SETTLED')
             AND t."disputed_at" IS NOT NULL
             AND t."dispute_resolved_at" IS NOT NULL
             AND t."dispute_id" IS NOT NULL
             AND t."resolved_dispute_id" IS NULL
          RETURNING t."id"
        )
        SELECT (SELECT count(*)::int FROM slice) AS scanned,
               (SELECT count(*)::int FROM attributed) AS attributed,
               (SELECT max("id") FROM slice) AS last_id`;
      return {
        scanned: row?.scanned ?? 0,
        attributed: row?.attributed ?? 0,
        lastId: row?.last_id ?? null,
      };
    },
    {
      maxWait: options.lockTimeoutMs + options.statementTimeoutMs,
      timeout: options.lockTimeoutMs + 2 * options.statementTimeoutMs + 1_000,
    },
  );
}

/** The PostgreSQL error a raw statement failed with — `55P03` lock, `57014` statement timeout — as Prisma reports it. */
function sqlState(error: unknown): string | null {
  const code = (error as { meta?: { code?: unknown } } | null)?.meta?.code;
  return typeof code === 'string' ? code : null;
}

/** The command's exit status: 0 only for a plan or a run that left nothing to attribute. */
export function backfillExitCode(summary: { status: string }): number {
  return summary.status === 'planned' || summary.status === 'done' ? 0 : 1;
}

/** Runs the backfill; every step is reported through `emit`, and the summary returned. */
export async function backfillResolvedDisputes(
  client: ExtendedPrismaClient,
  options: ResolvedDisputeBackfillOptions,
  emit: (event: ResolvedDisputeBackfillEvent) => void = () => undefined,
): Promise<Extract<ResolvedDisputeBackfillEvent, { event: 'summary' }>> {
  const finish = (
    status: 'planned' | 'done' | 'incomplete' | 'failed',
    batches: number,
    attributed: number,
    remaining: number,
    lastId: string,
  ) => {
    const summary = {
      event: 'summary' as const,
      status,
      batches,
      attributed,
      unattributed: remaining,
      lastId,
    };
    emit(summary);
    return summary;
  };

  const before = await unattributed(client);
  emit({ event: 'plan', unattributed: before });
  if (!options.apply) return finish('planned', 0, 0, before, options.after);

  let after = options.after;
  let batches = 0;
  let attributed = 0;
  for (;;) {
    if (options.maxBatches !== null && batches >= options.maxBatches) {
      return finish('incomplete', batches, attributed, await unattributed(client), after);
    }
    let result: Awaited<ReturnType<typeof batch>>;
    try {
      result = await batch(client, after, options);
    } catch (error) {
      emit({ event: 'failed', batch: batches + 1, after, code: sqlState(error) });
      return finish('failed', batches, attributed, await unattributed(client), after);
    }
    if (result.lastId === null) break;
    batches += 1;
    attributed += result.attributed;
    after = result.lastId;
    emit({ event: 'batch', batch: batches, ...result, lastId: after });
    if (result.scanned < options.batchSize) break;
  }
  const remaining = await unattributed(client);
  // At the end. Rows before a resumed run's `after` it did not read: still counted.
  return finish(remaining === 0 ? 'done' : 'incomplete', batches, attributed, remaining, after);
}
