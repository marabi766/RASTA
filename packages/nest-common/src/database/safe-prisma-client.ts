import type { DATABASE_SERVICES } from '@rasta/config';
import { clientFailureCode } from './client-failure';

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
    if (!connectionOnly && !connectionAcquisitionFailed(error)) throw error;
    throw new DatabaseConnectionError(setting, clientFailureCode(error));
  }
}

/**
 * One boundary for every service's client, from construction to disconnect.
 * The query extension keeps PrismaPromise laziness and tenant/admission extensions intact.
 * The proxy covers lifecycle methods and transaction-begin failures (which query extensions
 * do not see), and carries that protection through subsequent `$extends` calls.
 * No retries, altered SQL, or changed transaction options.
 */
export function createSafePrismaClient<T extends object>(
  open: () => T,
  setting: RuntimeDatabaseSetting,
): T {
  try {
    const raw = open();
    const extension = {
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
    const protect = (target: T): T =>
      new Proxy(target, {
        get(client, key, receiver) {
          const value: unknown = Reflect.get(client, key, receiver);
          if (key === '$extends' && typeof value === 'function') {
            return (...args: unknown[]) => protect(Reflect.apply(value, client, args) as T);
          }
          if (
            typeof value === 'function' &&
            (key === '$connect' || key === '$disconnect' || key === '$transaction')
          ) {
            return (...args: unknown[]) =>
              databaseOperation(
                () => Reflect.apply(value, client, args) as PromiseLike<unknown>,
                setting,
                key !== '$transaction',
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
    // The extension changes diagnostics only; the generated model/method shape stays T.
    return protect(
      Reflect.apply(Reflect.get(raw, '$extends') as (...args: unknown[]) => unknown, raw, [
        extension,
      ]) as T,
    );
  } catch (error) {
    throw new DatabaseConnectionError(setting, clientFailureCode(error));
  }
}
