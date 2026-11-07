import type { DATABASE_SERVICES } from '@rasta/config';
import { clientFailureCode } from './client-failure';
import {
  SessionTimeZoneRefusedError,
  UTC_SESSION_CHECK_SQL,
  isSessionTimeZoneRefusal,
  isZoneFreeOperation,
  runsInTransaction,
} from './utc-session';

export type RuntimeDatabaseSetting = `DATABASE_URL_${(typeof DATABASE_SERVICES)[number]}`;

/** A fresh diagnostic: no driver message, stack, input, metadata or cause survives. */
export class DatabaseConnectionError extends Error {
  override readonly name = 'DatabaseConnectionError';

  constructor(
    readonly setting: RuntimeDatabaseSetting,
    readonly code: string,
  ) {
    super(`${setting}: database connection failed (code ${code}); driver diagnostics withheld`);
  }
}

function connectionAcquisitionFailed(error: unknown): boolean {
  const code = clientFailureCode(error);
  if (code.startsWith('P10') || code === 'P2024' || code === 'P2037') return true;
  try {
    return (error as { name?: unknown } | null)?.name === 'PrismaClientInitializationError';
  } catch {
    return false;
  }
}

/** Preserve domain/query refusals; replace connection failures, including lazy/reconnections. */
async function databaseOperation<T>(
  run: () => PromiseLike<T>,
  setting: RuntimeDatabaseSetting,
  connectionOnly = false,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isSessionTimeZoneRefusal(error)) throw new SessionTimeZoneRefusedError(setting);
    if (!connectionOnly && !connectionAcquisitionFailed(error)) throw error;
    throw new DatabaseConnectionError(setting, clientFailureCode(error));
  }
}

/** The raw method both forms of the session check run through. */
interface SessionCheckClient {
  $queryRawUnsafe(query: string): unknown;
  $transaction(statements: unknown[]): Promise<unknown[]>;
}

/**
 * `$transaction`'s arguments with {@link UTC_SESSION_CHECK_SQL} as the first
 * statement of the transaction, and how to read its result back. An interactive
 * callback gets it before its own first statement, a batch as an extra statement.
 */
function checkingTransaction(
  client: SessionCheckClient,
  [work, ...rest]: unknown[],
): { args: unknown[]; result: (value: unknown) => unknown } {
  if (typeof work === 'function') {
    const checked = async (tx: SessionCheckClient, ...more: unknown[]): Promise<unknown> => {
      await tx.$queryRawUnsafe(UTC_SESSION_CHECK_SQL);
      return (work as (...args: unknown[]) => unknown)(tx, ...more);
    };
    return { args: [checked, ...rest], result: (value) => value };
  }
  if (Array.isArray(work)) {
    return {
      args: [[client.$queryRawUnsafe(UTC_SESSION_CHECK_SQL), ...work], ...rest],
      result: (value) => (value as unknown[]).slice(1),
    };
  }
  return { args: [work, ...rest], result: (value) => value };
}

/**
 * One boundary for every service's client, from construction to disconnect.
 * The query extension keeps PrismaPromise laziness and tenant/admission extensions intact.
 * The proxy covers lifecycle methods and transaction-begin failures (which query extensions
 * do not see), and carries that protection through subsequent `$extends` calls.
 * No retries, altered SQL, or changed transaction options.
 *
 * It is also where a session outside UTC is refused (`utc-session.ts`): every transaction
 * begins with the check, and an autocommit statement that is not a plain model read becomes
 * a two-statement batch, so the check and the work share a transaction, and so a backend,
 * also behind PgBouncer. Refused before the work, so the work never runs.
 */
export function createSafePrismaClient<T extends object>(
  open: () => T,
  setting: RuntimeDatabaseSetting,
): T {
  try {
    const raw = open();
    const bare = raw as unknown as SessionCheckClient;
    const extended = (client: object, extension: unknown): object =>
      Reflect.apply(Reflect.get(client, '$extends') as (...args: unknown[]) => object, client, [
        extension,
      ]);
    const diagnostics = {
      name: 'database-connection-diagnostics',
      query: {
        $allOperations({
          args,
          query,
        }: {
          args: unknown;
          query: (args: unknown) => PromiseLike<unknown>;
        }) {
          return databaseOperation(() => query(args), setting);
        },
      },
    };
    const sessionCheck = {
      name: 'utc-session-check',
      query: {
        $allOperations(params: {
          args: unknown;
          model?: unknown;
          operation?: unknown;
          query: (args: unknown) => PromiseLike<unknown>;
        }) {
          const { args, model, operation, query } = params;
          if (runsInTransaction(params) || isZoneFreeOperation(model, operation)) {
            return query(args);
          }
          return bare
            .$transaction([bare.$queryRawUnsafe(UTC_SESSION_CHECK_SQL), query(args)])
            .then(([, result]) => result);
        },
      },
    };
    // The check stays the LAST extension of every client, right above the engine. Handed to a
    // batch from higher up, `query(args)` runs its statement twice: the extension below has
    // already started the promise it returns, and `requestTransaction` starts it again. So
    // each client is built from its predecessor WITHOUT the check, plus the check.
    const protect = (unchecked: object): T =>
      new Proxy(extended(unchecked, sessionCheck) as T, {
        get(client, key, receiver) {
          const value: unknown = Reflect.get(client, key, receiver);
          if (key === '$extends' && typeof value === 'function') {
            return (extension: unknown) => protect(extended(unchecked, extension));
          }
          if (typeof value === 'function' && key === '$transaction') {
            return (...args: unknown[]) =>
              databaseOperation(async () => {
                const checked = checkingTransaction(client as unknown as SessionCheckClient, args);
                return checked.result(
                  await (Reflect.apply(value, client, checked.args) as PromiseLike<unknown>),
                );
              }, setting);
          }
          if (typeof value === 'function' && (key === '$connect' || key === '$disconnect')) {
            return (...args: unknown[]) =>
              databaseOperation(
                () => Reflect.apply(value, client, args) as PromiseLike<unknown>,
                setting,
                true,
              );
          }
          // Prisma extensions omit $on; retain the original event-registration API.
          if (key === '$on') {
            const on: unknown = Reflect.get(raw, key);
            if (typeof on === 'function') return on.bind(raw);
          }
          return value;
        },
      });
    // The extensions change diagnostics and refusals only; the generated model/method shape stays T.
    return protect(extended(raw, diagnostics));
  } catch (error) {
    throw new DatabaseConnectionError(setting, clientFailureCode(error));
  }
}
