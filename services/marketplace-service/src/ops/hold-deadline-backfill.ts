import { randomUUID } from 'node:crypto';
import { runUnscoped } from '@rasta/nest-common';
import { Prisma } from '../generated/prisma';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { HOLD_FENCE } from '../temporal/economic-refusal';

/**
 * FU-234: a deadline for the order rows from before the hold's fence. Such a row counts a
 * send and has no deadline, so every send its saga makes carries none and economic-service
 * refuses it (D-150, `HOLD_DEADLINE_REQUIRED`): the saga waits for good. A row this
 * build's sends left the same way (a saga from before protocol 10) is the same case.
 *
 * The rule. A row with no deadline, sends open and at least one counted gets
 * `hold_not_after = now() + HOLD_FENCE.sendWindowMs` (the database's clock, as a first send
 * would get), only once economic-service has refused every send without a deadline, on
 * every replica, for at least the margin (`economicRuleSince`, refused otherwise). Why it
 * shortens no hold window: the sends that row counted carried no deadline, so from that
 * instant none of them can land (an answer already stored is a hold that exists, and the
 * lookup finds it). The row is then proof of absence only past the new deadline plus the
 * margin, more than a day after any of them could land, and only while economic-service
 * still says it enforces D-150 (FU-233). Every later send carries the new deadline.
 *
 * Classified by the row alone. No obligation recorded and PENDING, CANCELLING, CANCELLED
 * or FAILED: given a deadline. An obligation recorded: the hold landed, nothing to fence,
 * left alone. No send counted: its first send fixes its own. Anything else (another status
 * with no obligation, which `ck_order_held_has_transaction` forbids today, or a count below
 * zero) cannot follow from the order's life: refused, reported, never written.
 */
const ASSIGNABLE = ['PENDING', 'CANCELLING', 'CANCELLED', 'FAILED'];
const OPEN = Prisma.sql`o.hold_not_after IS NULL AND o.hold_sends_closed_at IS NULL
  AND o.hold_send_claims <> 0`;
const HELD = Prisma.sql`o.hold_send_claims > 0 AND o.economic_transaction_id IS NOT NULL`;
const UNHELD = Prisma.sql`o.hold_send_claims > 0 AND o.economic_transaction_id IS NULL
  AND o.status::text IN (${Prisma.join(ASSIGNABLE)})`;
const ASSIGN = Prisma.sql`${OPEN} AND ${UNHELD}`;
/** Everything else with no deadline and a send count: never guessed. */
const REFUSE = Prisma.sql`${OPEN} AND NOT (${HELD}) AND NOT (${UNHELD})`;
const REFUSED_LISTED = 200;

export interface BackfillOptions {
  apply: boolean;
  economicRuleSince: string;
  batchSize: number;
  maxBatches: number;
  statementTimeoutMs?: number;
}

export interface BackfillRow {
  orderId: string;
  organizationId: string;
  status: string;
}

export interface BackfillReport {
  runId: string;
  mode: 'dry-run' | 'apply';
  plan: { assignable: number; held: number; refused: number };
  refused: BackfillRow[];
  refusedMore: boolean;
  assigned: (BackfillRow & { holdNotAfter: string })[];
  remaining: number;
  /** Nothing left to assign and nothing refused. A dry run converges only on an empty plan. */
  converged: boolean;
}

export class BackfillRefused extends Error {}

type Tx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

const unscoped = <T>(fn: () => Promise<T>): Promise<T> =>
  runUnscoped('the hold-deadline backfill reads and fences legacy orders of every tenant', fn);

export async function backfillLegacyHoldDeadlines(
  client: ExtendedPrismaClient,
  options: BackfillOptions,
): Promise<BackfillReport> {
  const runId = randomUUID();
  const since = options.economicRuleSince;
  const timeout = options.statementTimeoutMs ?? 5000;
  const bounded = <T>(work: (tx: Tx) => Promise<T>): Promise<T> =>
    unscoped(() =>
      client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${timeout}ms`}, true),
          set_config('lock_timeout', '3s', true)`;
        return work(tx);
      }),
    );
  const count = async (tx: Tx, where: Prisma.Sql) =>
    Number(
      (await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "order" o WHERE ${where}`)[0]
        ?.n ?? 0,
    );

  const { plan, refused, ruleLongEnough } = await bounded(async (tx) => {
    const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    const listed = await tx.$queryRaw<BackfillRow[]>`SELECT o.id AS "orderId",
        o.organization_id AS "organizationId", o.status::text AS status
      FROM "order" o WHERE ${REFUSE} ORDER BY o.id LIMIT ${REFUSED_LISTED + 1}`;
    return {
      ruleLongEnough:
        clock !== undefined && clock.now.getTime() >= Date.parse(since) + HOLD_FENCE.clockMarginMs,
      refused: listed,
      plan: {
        assignable: await count(tx, ASSIGN),
        held: await count(tx, Prisma.sql`${OPEN} AND ${HELD}`),
        refused: await count(tx, REFUSE),
      },
    };
  });
  // Fail closed: before D-150 held everywhere for the margin, a send without a deadline
  // may still land, and a deadline would let the row prove absence it cannot.
  if (!ruleLongEnough) {
    throw new BackfillRefused(
      'economic-service must refuse every hold without a deadline since at least ' +
        `${HOLD_FENCE.clockMarginMs / 60_000} min before now (database clock): --economic-rule-since is too recent`,
    );
  }

  const assigned: BackfillReport['assigned'] = [];
  if (options.apply) {
    for (let batch = 0; batch < options.maxBatches; batch += 1) {
      const rows = await bounded(
        (tx) => tx.$queryRaw<BackfillReport['assigned']>`
          WITH candidate AS (
            SELECT o.id, o.organization_id FROM "order" o WHERE ${ASSIGN}
            ORDER BY o.id LIMIT ${options.batchSize} FOR UPDATE OF o
          ), given AS (
            UPDATE "order" o
            SET hold_not_after = now()
              + ${HOLD_FENCE.sendWindowMs}::double precision * interval '1 millisecond'
            FROM candidate c
            WHERE o.id = c.id AND o.organization_id = c.organization_id AND ${ASSIGN}
            RETURNING o.id, o.organization_id, o.status::text AS status, o.hold_send_claims,
              o.hold_not_after
          )
          INSERT INTO order_hold_deadline_backfill AS a (organization_id, order_id, run_id,
            hold_not_after, status, hold_send_claims, economic_rule_since)
          SELECT organization_id, id, ${runId}, hold_not_after, status, hold_send_claims,
            ${since}::timestamptz FROM given
          RETURNING a.order_id AS "orderId", a.organization_id AS "organizationId", a.status,
            to_char(a.hold_not_after AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "holdNotAfter"`,
      );
      assigned.push(...rows);
      if (rows.length < options.batchSize) break;
    }
  }
  const remaining = await bounded((tx) => count(tx, ASSIGN));
  return {
    runId,
    mode: options.apply ? 'apply' : 'dry-run',
    plan,
    refused: refused.slice(0, REFUSED_LISTED),
    refusedMore: refused.length > REFUSED_LISTED,
    assigned,
    remaining,
    converged: remaining === 0 && plan.refused === 0,
  };
}

/** `--economic-rule-since <instant with zone> [--apply] [--batch-size n] [--max-batches n]` */
export function parseBackfillArgs(argv: readonly string[]): BackfillOptions {
  const options: BackfillOptions = {
    apply: false,
    economicRuleSince: '',
    batchSize: 200,
    maxBatches: 100,
  };
  const bounds = { '--batch-size': [1, 1000], '--max-batches': [1, 10_000] } as const;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] as string;
    if (flag === '--apply') options.apply = true;
    else if (flag === '--dry-run') dryRun = true;
    else if (flag === '--economic-rule-since' || Object.hasOwn(bounds, flag)) {
      const value = argv[(i += 1)];
      if (value === undefined) throw new BackfillRefused(`${flag} needs a value`);
      if (flag === '--economic-rule-since') {
        if (
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(value) ||
          Number.isNaN(Date.parse(value))
        ) {
          throw new BackfillRefused(`${flag} must be an ISO-8601 instant with its zone`);
        }
        options.economicRuleSince = new Date(value).toISOString();
      } else {
        const [min, max] = bounds[flag as keyof typeof bounds];
        const n = /^\d+$/.test(value) ? Number(value) : NaN;
        if (!(n >= min && n <= max)) throw new BackfillRefused(`${flag} must be ${min}..${max}`);
        options[flag === '--batch-size' ? 'batchSize' : 'maxBatches'] = n;
      }
    } else throw new BackfillRefused('an option this command does not take was given');
  }
  if (dryRun && options.apply) throw new BackfillRefused('--dry-run contradicts --apply');
  if (!options.economicRuleSince) throw new BackfillRefused('--economic-rule-since is required');
  return options;
}
