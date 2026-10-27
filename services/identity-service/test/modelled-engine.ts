import { Logger } from '@nestjs/common';
import { throwIfCancelled } from '../src/prisma/cancellation';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * A model of Prisma's engine under the **real** `PrismaService` — its
 * `transaction` (the checks before BEGIN and COMMIT, the one budget) and its
 * `stop` (the pool's close) — for interleavings a real database cannot be
 * made to produce on demand (#458 r1/r2 F2).
 *
 * A transaction waits for a connection at most `maxWait`, then BEGIN, its
 * callback's statements (each through the client extension's cancellation
 * check, as in `PrismaService`), then COMMIT — handed to the engine when the
 * callback resolved within `timeout`, logged when its answer comes back — or
 * ROLLBACK when the callback throws or outlasts `timeout`. The pool's close
 * is logged as DISCONNECT (with the pool's name, if it has one). Every step is
 * logged, so a test can say exactly what reached the "database" and when;
 * pools given one `shared` log write to it in order.
 */
export interface Step {
  /** Resolves when the connection is free; at most `maxWait` is waited. */
  connection?: Promise<void>;
  /** Fails the statement (the database failed, or the scope refused it). */
  fail?: boolean;
  /** Resolves when the COMMIT's answer comes back. */
  commit?: Promise<void>;
}

/** What the model was given for each transaction, in order. */
export interface Bounds {
  maxWait?: number;
  timeout?: number;
}

export function modelledPool(name?: string, shared?: string[]) {
  const log: string[] = shared ?? [];
  const steps: Step[] = [];
  const tag = name ? ` ${name}` : '';
  const bounds: Bounds[] = [];
  let transactions = 0;
  const statement = (sql: string) => {
    // The client extension's check (`PrismaService.buildClient`).
    throwIfCancelled();
    log.push(sql);
    return Promise.resolve(1);
  };
  const tx = {
    $executeRaw: (strings: TemplateStringsArray) =>
      statement(strings.join('?').includes('INSERT') ? 'INSERT' : 'STATEMENT'),
    $executeRawUnsafe: (sql: string) => statement(sql.startsWith('SET LOCAL') ? 'SET' : sql),
  };
  const client = {
    async $transaction<T>(
      callback: (client: unknown) => Promise<T>,
      options: { maxWait?: number; timeout?: number } = {},
    ): Promise<T> {
      const number = ++transactions;
      bounds.push({ maxWait: options.maxWait, timeout: options.timeout });
      const step = steps.shift() ?? {};
      if (step.connection) {
        let timer: NodeJS.Timeout | undefined;
        const waited = await Promise.race([
          step.connection.then(() => 'connected' as const),
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), options.maxWait ?? 2_000);
          }),
        ]);
        clearTimeout(timer);
        if (waited === 'timeout') throw new Error(`transaction ${number}: no connection in time`);
      }
      log.push(`BEGIN ${number}`);
      try {
        if (step.fail) throw new Error(`transaction ${number}: refused`);
        // The engine's own `timeout`: a callback that has not resolved by
        // then is rolled back; one that has, has its COMMIT sent.
        let expiry: NodeJS.Timeout | undefined;
        const result = await Promise.race([
          callback(tx),
          new Promise<never>((_, reject) => {
            expiry = setTimeout(
              () => reject(new Error(`transaction ${number}: expired`)),
              options.timeout ?? 5_000,
            );
          }),
        ]).finally(() => clearTimeout(expiry));
        await step.commit;
        log.push(`COMMIT ${number}`);
        return result;
      } catch (error) {
        log.push(`ROLLBACK ${number}`);
        throw error;
      }
    },
  };
  const base = {
    $connect: async () => undefined,
    $disconnect: async () => void log.push(`DISCONNECT${tag}`),
  };
  const pool = Object.create(PrismaService.prototype) as PrismaService;
  // The fields the constructor would set, with the model as its client.
  Object.assign(pool, {
    client,
    base,
    logger: new Logger(PrismaService.name),
    transactions: new Set(),
    closed: false,
  });
  return { pool, log, steps, bounds };
}

export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}
