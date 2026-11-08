import { OutboxPurgeScheduler, runUnscoped } from '@rasta/nest-common';
import { KeycloakFenceSampler } from '../src/keycloak/keycloak-fence-sampler';
import { MembershipExpiryScanner } from '../src/identity/membership-expiry.scanner';
import { OutboxGauges } from '../src/observability/outbox-gauges';
import { PrismaService } from '../src/prisma/prisma.service';
import type { IdentityApiHarness } from './api-helpers';
import { databaseUrl } from './helpers';

/**
 * What a piece of work did to the tables, as the DATABASE counted it — not as
 * the service's client reported it. A property such as "this request reads no
 * identity table" is only as strong as the place it is observed: a probe on
 * one client sees that client, and a read made through a client saved before
 * the probe, or through a pool of its own, never reaches it. PostgreSQL counts
 * every scan, tuple and write of every backend, whoever opened it
 * (`pg_stat_user_tables`), so this is read from there, through a pool of its own
 * that the code under test cannot reach.
 */

export const TABLE_COUNTERS = [
  'seq_scan',
  'seq_tup_read',
  'idx_scan',
  'idx_tup_fetch',
  'n_tup_ins',
  'n_tup_upd',
  'n_tup_del',
  'n_tup_hot_upd',
] as const;
export type TableCounter = (typeof TABLE_COUNTERS)[number];
/** Every table of the schema → its counters. */
export type TableActivity = Record<string, Record<TableCounter, number>>;

/**
 * A backend sends its counters to the shared statistics when it goes idle, but
 * not more than once a second, and a send that was too early is retried only
 * `PGSTAT_IDLE_INTERVAL` (10 s) later; a busy backend defers it further, and an
 * idle-in-transaction one never sends (`pgstat_report_stat`, PostgreSQL 15+).
 * Nothing can make another session send, so the counters are final only when
 * every other backend of the database has been idle for longer than that.
 */
export const COUNTERS_FLUSHED_AFTER_IDLE_MS = 11_500;

export interface DatabaseObserver {
  /** The counters now, once every other backend has been idle long enough for them to be final. */
  activity(): Promise<TableActivity>;
  /**
   * Reads `table` through the observer's own session and sends its counters
   * at once (`pg_stat_force_next_flush`, its own backend only): the proof that
   * a read does move what {@link activity} reads.
   */
  control(table: string): Promise<void>;
  /** The tables whose counters moved between two readings, with how much. */
  moved(before: TableActivity, after: TableActivity): TableActivity;
  stop(): Promise<void>;
}

/** A pool of one connection of its own on the service's database. */
export async function observeDatabase(): Promise<DatabaseObserver> {
  const pool = new PrismaService(databaseUrl(), { connections: 1 });
  await pool.onModuleInit();
  const query = <T>(run: () => Promise<T>) => runUnscoped('test observes the database', run);

  const settled = async (): Promise<void> => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      // `state` is NULL for a backend of another role that this role may not see.
      const busy = await query(
        () =>
          pool.client.$queryRaw<Array<{ pid: number; state: string; idle_ms: number }>>`
          SELECT pid::int AS pid, state::text AS state,
                 (EXTRACT(EPOCH FROM clock_timestamp() - state_change) * 1000)::float8 AS idle_ms
            FROM pg_stat_activity
           WHERE datname = current_database() AND pid <> pg_backend_pid()
             AND backend_type = 'client backend' AND state IS NOT NULL
             AND (state <> 'idle'
                  OR clock_timestamp() - state_change < ${COUNTERS_FLUSHED_AFTER_IDLE_MS} * interval '1 millisecond')`,
      );
      if (busy.length === 0) return;
      if (Date.now() > deadline) {
        throw new Error(
          `the database did not go quiet within 60 s; still busy: ${JSON.stringify(busy)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  return {
    async activity() {
      await settled();
      await query(() => pool.client.$queryRaw`SELECT pg_stat_clear_snapshot()::text AS cleared`);
      const rows = await query(
        () =>
          pool.client.$queryRaw<Array<{ table: string } & Record<TableCounter, number>>>`
          SELECT relname::text AS "table",
                 seq_scan::float8 AS seq_scan, seq_tup_read::float8 AS seq_tup_read,
                 COALESCE(idx_scan, 0)::float8 AS idx_scan,
                 COALESCE(idx_tup_fetch, 0)::float8 AS idx_tup_fetch,
                 n_tup_ins::float8 AS n_tup_ins, n_tup_upd::float8 AS n_tup_upd,
                 n_tup_del::float8 AS n_tup_del, n_tup_hot_upd::float8 AS n_tup_hot_upd
            FROM pg_stat_user_tables WHERE schemaname = current_schema() ORDER BY relname`,
      );
      return Object.fromEntries(
        rows.map((row) => [
          row.table,
          Object.fromEntries(TABLE_COUNTERS.map((counter) => [counter, row[counter]])),
        ]),
      ) as TableActivity;
    },
    async control(table) {
      await query(() =>
        pool.client.$queryRawUnsafe(`SELECT count(*)::text AS n FROM ${JSON.stringify(table)}`),
      );
      await query(() => pool.client.$queryRaw`SELECT pg_stat_force_next_flush()::text AS sent`);
    },
    moved(before, after) {
      const out: TableActivity = {};
      for (const [table, counters] of Object.entries(after)) {
        const delta = Object.fromEntries(
          TABLE_COUNTERS.map((counter) => [
            counter,
            counters[counter] - (before[table]?.[counter] ?? 0),
          ]),
        ) as Record<TableCounter, number>;
        if (TABLE_COUNTERS.some((counter) => delta[counter] !== 0)) out[table] = delta;
      }
      return out;
    },
    async stop() {
      await pool.stop();
    },
  };
}

/**
 * The service's own timers read (and purge) its tables on their own schedule:
 * the outbox purge, membership expiry, the fence samples, the outbox gauges.
 * A measurement of what a request did to the tables needs them off; one pass
 * of the purge that landed inside a window of a loaded run read `outbox_message`
 * and failed it. Stopped for good: nothing is asked of them afterwards. Not
 * stopped, because nothing of them runs here: the registration worker (no
 * timer, `REGISTRATION_INTAKE_INTERVAL_SECONDS`, `api-helpers.ts`, and the
 * suite drives its passes), both relays (inert), the Keycloak consumer (sync
 * is off, so it is never built).
 */
export async function pauseBackgroundWorkers(harness: IdentityApiHarness): Promise<void> {
  await Promise.all([
    harness.moduleRef.get(OutboxPurgeScheduler).stop(),
    harness.moduleRef.get(MembershipExpiryScanner).stop(),
    harness.moduleRef.get(KeycloakFenceSampler).stop(),
    harness.moduleRef.get(OutboxGauges).stop(),
  ]);
}
