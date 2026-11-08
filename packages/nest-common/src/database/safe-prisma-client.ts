import type { DATABASE_SERVICES } from '@rasta/config';
import { clientFailureCode } from './client-failure';
import {
  SessionTimeZoneRefusedError,
  UTC_SESSION_CHECK_SQL,
  isSessionCheck,
  isSessionTimeZoneRefusal,
  isZoneFreeOperation,
  refuseUncheckedPredecessor,
  transactionIdentity,
  uncheckedTransactionRefusal,
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
 * The check as the first statement of a batch. Prisma hands each statement its transaction in
 * order and at once, so this is told before any other statement of the batch reaches the query
 * extension; it records that the batch begins with the check. If the statement has no
 * `requestTransaction`, nothing is recorded and the extension refuses the batch.
 */
function firstOfBatch(check: unknown, prove: (transaction: unknown) => void): unknown {
  const statement = check as { requestTransaction?: (transaction: unknown) => unknown };
  const request = statement.requestTransaction;
  if (typeof request !== 'function') return check;
  statement.requestTransaction = (transaction: unknown) => {
    prove(transaction);
    return Reflect.apply(request, statement, [transaction]);
  };
  return statement;
}

/**
 * `$transaction`'s arguments with {@link UTC_SESSION_CHECK_SQL} as the first
 * statement of the transaction, and how to read its result back. An interactive
 * callback gets it before its own first statement, a batch as an extra statement.
 */
function checkingTransaction(
  client: SessionCheckClient,
  [work, ...rest]: unknown[],
  prove: (transaction: unknown) => void,
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
      args: [
        [firstOfBatch(client.$queryRawUnsafe(UTC_SESSION_CHECK_SQL), prove), ...work],
        ...rest,
      ],
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
 *
 * No exposed path runs without it (PR #906 r1 F1). Each client sits on a predecessor without the
 * check, so no predecessor is handed out: `$parent` and the fields behind it are refused, on a
 * client and on a model, and so is the function form of `$extends`, which receives one. And a
 * statement in a transaction must find that transaction PROVEN to begin with the check: being in
 * a transaction proves nothing.
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
    // Transactions known to begin with the check: one that passed it, or a batch built with it.
    const proven = new WeakSet<object>();
    const prove = (transaction: unknown): void => {
      const identity = transactionIdentity({ __internalParams: { transaction } });
      if (identity) proven.add(identity);
    };
    const sessionCheck = {
      name: 'utc-session-check',
      query: {
        $allOperations(params: {
          args: unknown;
          model?: unknown;
          operation?: unknown;
          query: (args: unknown) => PromiseLike<unknown>;
          __internalParams?: { transaction?: { kind?: unknown; index?: unknown } };
        }) {
          const { args, model, operation, query } = params;
          const identity = transactionIdentity(params);
          if (isZoneFreeOperation(model, operation)) return query(args);
          if (identity) {
            const transaction = params.__internalParams?.transaction;
            const isCheck = isSessionCheck(operation, args);
            // Proven: a batch built with the check, whose first statement must still BE the check,
            // or an interactive transaction whose check passed. Unproven, only the check runs.
            if (proven.has(identity) && (transaction?.index !== 0 || isCheck)) return query(args);
            if (!isCheck) return Promise.reject(uncheckedTransactionRefusal());
            return Promise.resolve(query(args)).then((result) => {
              proven.add(identity);
              return result;
            });
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
    const models = new WeakMap<object, object>();
    const modelWithoutPredecessor = (model: object): object => {
      let guarded = models.get(model);
      if (!guarded) {
        guarded = new Proxy(model, {
          get(target, key, receiver) {
            refuseUncheckedPredecessor(key);
            return Reflect.get(target, key, receiver) as unknown;
          },
        });
        models.set(model, guarded);
      }
      return guarded;
    };
    const protect = (unchecked: object): T =>
      new Proxy(extended(unchecked, sessionCheck) as T, {
        get(client, key, receiver) {
          refuseUncheckedPredecessor(key);
          const value: unknown = Reflect.get(client, key, receiver);
          if (key === '$extends' && typeof value === 'function') {
            return (extension: unknown) => {
              // Prisma calls a function with this client's unchecked predecessor.
              if (typeof extension !== 'object' || extension === null) {
                throw new Error(
                  'refused: $extends takes an extension object here; a function would receive a client without the UTC session check',
                );
              }
              return protect(extended(unchecked, extension));
            };
          }
          if (typeof value === 'function' && key === '$transaction') {
            return (...args: unknown[]) =>
              databaseOperation(async () => {
                const checked = checkingTransaction(
                  client as unknown as SessionCheckClient,
                  args,
                  prove,
                );
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
          // A model delegate: its `$parent`, also through `Prisma.getExtensionContext(this)`.
          if (
            typeof value === 'object' &&
            value !== null &&
            typeof key === 'string' &&
            !/^[$_]/.test(key)
          ) {
            return modelWithoutPredecessor(value);
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
