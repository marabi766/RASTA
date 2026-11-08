/**
 * Runs production statements in a session outside UTC, with a zone switch at any
 * point (FU-188), and leaves nothing behind.
 *
 * Everything happens on one connection, inside one transaction that always rolls
 * back: `SET LOCAL` cannot reach another test, and a suite's rows are its own. The
 * session check of `createSafePrismaClient` runs at the start of a transaction, so it
 * sees UTC and the code under test runs past it: this exercises the SECOND line of
 * defence, the SQL itself. The check has its own spec (identity utc-session.int-spec).
 */

/** The raw client a transaction hands out, loosely: each service generates its own. */
interface SessionClient {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface SessionZone<P> {
  /** The service's prisma as production uses it, bound to this session. */
  db: P;
  tx: SessionClient;
  zone(name: string): Promise<void>;
  /**
   * Seconds from this transaction's clock, in UTC wall time and floored to the
   * millisecond, to a `timestamp` value read by `expression` from `from`.
   */
  secondsFromNow(expression: string, from: string, ...values: unknown[]): Promise<number>;
}

class RolledBack extends Error {}

export async function inSessionZone<P extends { client: object }, T>(
  prisma: P,
  work: (session: SessionZone<P>) => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    const { $transaction } = prisma.client as unknown as {
      $transaction(
        work: (tx: SessionClient) => Promise<unknown>,
        options: object,
      ): Promise<unknown>;
    };
    await $transaction.call(
      prisma.client,
      async (tx: SessionClient) => {
        const bound = new Proxy(tx as object, {
          get(target, key, receiver) {
            if (key === '$transaction') {
              return async (inner: unknown) => {
                if (typeof inner === 'function') return inner(bound);
                const results: unknown[] = [];
                for (const statement of inner as unknown[]) results.push(await statement);
                return results;
              };
            }
            return Reflect.get(target, key, receiver) as unknown;
          },
        });
        const db = new Proxy(prisma as object, {
          get(target, key, receiver) {
            if (key === 'client') return bound;
            if (key === 'transaction') {
              return (run: (client: unknown) => unknown) => run(bound);
            }
            return Reflect.get(target, key, receiver) as unknown;
          },
        });
        result = await work({
          db: db as P,
          tx,
          zone: async (name) => {
            await tx.$queryRawUnsafe(`SELECT set_config('TimeZone', $1, true)`, name);
            const [row] = await tx.$queryRawUnsafe<{ zone: string }[]>(
              `SELECT current_setting('TimeZone') AS zone`,
            );
            // Or every spec on this helper would keep passing in UTC.
            if (row?.zone !== name) throw new Error(`the session is in ${row?.zone}, not ${name}`);
          },
          secondsFromNow: async (expression, from, ...values) => {
            const rows = await tx.$queryRawUnsafe<{ seconds: number }[]>(
              `SELECT EXTRACT(EPOCH FROM ${expression}
                  - date_trunc('milliseconds', now() AT TIME ZONE 'UTC'))::float8 AS seconds
                 FROM ${from}`,
              ...values,
            );
            if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
            return rows[0]!.seconds;
          },
        });
        throw new RolledBack();
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  } catch (error) {
    if (!(error instanceof RolledBack)) throw error;
  }
  return result!;
}

/** A zone east of UTC and one west of it, against UTC, in both orders of a lease. */
export const ZONE_SWITCHES: ReadonlyArray<readonly [string, string]> = [
  ['Asia/Tehran', 'UTC'],
  ['UTC', 'Asia/Tehran'],
  ['America/Los_Angeles', 'UTC'],
  ['UTC', 'America/Los_Angeles'],
];
