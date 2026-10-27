import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { readUrl } from '@rasta/config';
import { SERVICE_NAME } from '../config/env';
import {
  createTenantGuardExtension,
  assertRuntimeRole as assertConnectedRuntimeRole,
  withinDeadline,
  type OutboxStopOptions,
} from '@rasta/nest-common';
import { PrismaClient } from '../generated/prisma';
import { settleWithin, throwIfCancelled, trackInScope, transactionBounds } from './cancellation';

/**
 * Models in this service that carry an `organizationId` and must therefore be
 * tenant-scoped automatically.
 *
 * Listed explicitly, because the two directions of a mistake are not
 * symmetrical: a model wrongly listed produces an immediate, obvious query
 * error, while a model wrongly omitted produces a silent cross-tenant read.
 * Explicit listing makes the safe direction the default.
 *
 * `User` is absent on purpose — identity spans organizations, and a user is
 * reached through their memberships (see prisma/schema.prisma).
 * `Role`, `Permission` and `OrganizationRef` are platform-wide reference data.
 */
export const TENANT_SCOPED_MODELS = ['Membership', 'IdempotencyKey'] as const;

/**
 * Models that carry an `organization_id` column and are deliberately **not** guarded, each
 * with the reason. Named rather than left out, so `tenant-scope.spec.ts` can hold the
 * guarded list against the Prisma schema exactly: an exemption has to be written down
 * to exist, and one without a reason fails that spec.
 */
export const TENANT_SCOPE_EXEMPTIONS = {
  OutboxMessage:
    'The outbox relay drains this table across every tenant with no request context, and each row names its own organization_id: platform plumbing, filtered by that column rather than by the guard.',
  SecurityEventOutbox:
    'Refusals awaiting delivery to the audit trail (ADR-053 § 4): written by the exception filter in its own short transaction and drained across tenants by a second relay; every row names its own organization_id explicitly.',
} as const satisfies Readonly<Record<string, string>>;

export type ExtendedPrismaClient = ReturnType<PrismaService['buildClient']>;

/**
 * The same database URL, as a pool of at most `connections` connections with
 * a short wait for one (seconds): what the Keycloak write fences run on
 * (D-069), apart from the pool business transactions hold their locks on.
 */
export function separatePoolUrl(databaseUrl: string, connections: number, waitSeconds = 5): string {
  const url = readUrl(databaseUrl, { refusal: 'DATABASE_URL is not a readable URL' });
  url.searchParams.set('connection_limit', String(connections));
  url.searchParams.set('pool_timeout', String(waitSeconds));
  return url.toString();
}

/** This pool is closing or closed (`PrismaService.stop`): it admits no new work. */
export class PoolClosedError extends Error {
  constructor() {
    super('refused: this database pool is closed');
    this.name = 'PoolClosedError';
  }
}

/**
 * What a pool's close reports (#458 r3 F2): `drained` only when every
 * operation it admitted settled **and** its disconnect returned, both by the
 * deadline; otherwise `unsettled` says how many admitted operations had not
 * settled when it stopped waiting — those may still commit.
 */
export interface PoolCloseReport {
  drained: boolean;
  unsettled: number;
}

/**
 * The transaction Prisma runs one operation in, as its query extensions see
 * it (`__internalParams.transaction`): `batch` for a statement of a batch
 * `$transaction` (an array of statements) — every statement of one batch
 * shares its `lock` — and `itx` for a statement of an interactive
 * transaction. Absent: an autocommit statement.
 */
interface OperationTransaction {
  kind?: string;
  lock?: object;
}

/** One batch `$transaction` (an array of statements), admitted or refused as a whole. */
interface BatchAdmission {
  refusal?: unknown;
  /** Settles its tracked entry: the first of its statements to settle. */
  settle?: () => void;
}

function transactionOf(params: unknown): OperationTransaction | undefined {
  const internal = (params as { __internalParams?: { transaction?: OperationTransaction } })
    .__internalParams;
  return internal?.transaction;
}

/**
 * One database pool. **Its close is not its own** (#458 r2 F2): it has no
 * `onModuleDestroy`, because Nest runs every provider's destroy hook at once,
 * and a pool that disconnected there did so beside the workers still
 * flushing through it. `OutboxShutdown` closes it (`databases`), once every
 * worker and timer that uses it has returned; the projection command, once
 * its projector stopped. See {@link stop}.
 *
 * **One admission point** (#458 r3 F2): every database operation on this
 * pool — an autocommit statement (an outbox claim or acknowledgement, a fence
 * release, confirmation, deferral or terminal marking, a repository or gauge
 * read), every statement of a batch `$transaction` (the security-event
 * outbox's, an array of statements), an interactive transaction ({@link transaction}) and its
 * statements, the readiness probe and the role check — is admitted here, in
 * the client extension or the two methods that use the bare client, and
 * tracked in {@link admitted} until it settles. Once closing starts, nothing
 * new is admitted; what was admitted is waited for, by the deadline.
 */
@Injectable()
export class PrismaService implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);
  private readonly base: PrismaClient;
  /**
   * Every operation admitted on this pool and not settled yet: autocommit
   * statements, batches (one entry each), interactive transactions — their
   * COMMIT included — and the statements in them.
   */
  private readonly admitted = new Set<Promise<unknown>>();
  /** Each batch's one decision, by the `lock` its statements share. */
  private readonly batches = new WeakMap<object, BatchAdmission>();
  /** From the start of {@link stop}: no new work is admitted. */
  private closing?: Promise<PoolCloseReport>;
  /**
   * Once {@link stop} stopped waiting: not even a statement of a transaction
   * admitted before runs any more (no lazy reconnect).
   */
  private closed = false;

  /** The client every repository uses. Tenant scoping is already applied. */
  readonly client: ExtendedPrismaClient;

  /**
   * @param loadedUrl always the loaded `DATABASE_URL` (the repository guard
   *   `scripts/db-pool-config.pg.test.mjs` holds every service to it).
   * @param pool a separate, bounded pool on that same URL — the Keycloak write
   *   fences' (D-069), never the one business transactions hold locks on.
   */
  constructor(loadedUrl: string, pool?: { connections: number; waitSeconds?: number }) {
    const databaseUrl = pool
      ? separatePoolUrl(loadedUrl, pool.connections, pool.waitSeconds)
      : loadedUrl;
    this.base = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
    this.client = this.buildClient();
  }

  private buildClient() {
    const admit = <T>(transaction: OperationTransaction | undefined, run: () => Promise<T>) =>
      this.admit(transaction, run);
    // First, so it runs before anything else — every other extension runs
    // inside it: a cancelled worker starts no database operation at all
    // (`cancellation.ts`, #402 r2 F2), nothing new starts on a closing pool,
    // nothing at all on a closed one — Prisma would otherwise reconnect it —
    // and everything it lets through is tracked until it settles (#458 r3 F2).
    return this.base
      .$extends({
        name: 'admission-boundary',
        query: {
          $allOperations(params) {
            const { args, query } = params;
            return admit(transactionOf(params), () => query(args));
          },
        },
      })
      .$extends(
        createTenantGuardExtension({
          scopedModels: TENANT_SCOPED_MODELS,
          onUnscopedQuery: ({ model, operation, reason }) => {
            // Every deliberate boundary crossing is recorded, so an auditor can
            // enumerate them without reading the whole codebase.
            this.logger.warn(`Unscoped query on ${model}.${operation} — reason: ${reason}`);
          },
        }),
      );
  }

  /**
   * The admission point of every operation (#458 r3 F2). A statement of an
   * interactive transaction belongs to one admitted before the close began,
   * which is drained, not cut off: it is refused only once the pool is
   * closed. Anything else — an autocommit statement, a batch — is new work:
   * refused from the start of the close. A batch is decided once, by its
   * first statement, for all of them — Prisma sends it only once every one
   * reached the engine, so a split decision would leave the rest waiting
   * forever — and tracked as one entry, until the first of its statements
   * settles: then the engine has answered it, or will never be sent it.
   */
  private admit<T>(transaction: OperationTransaction | undefined, run: () => Promise<T>) {
    if (transaction?.kind === 'batch' && transaction.lock) {
      return this.admitBatched(transaction.lock, run);
    }
    if (transaction?.kind === 'itx' ? this.closed : this.closing) throw new PoolClosedError();
    throwIfCancelled();
    return this.track(run());
  }

  private admitBatched<T>(lock: object, run: () => Promise<T>): Promise<T> {
    let batch = this.batches.get(lock);
    if (!batch) {
      const decided: BatchAdmission = {};
      try {
        if (this.closing) throw new PoolClosedError();
        throwIfCancelled();
        this.track(new Promise<void>((resolve) => (decided.settle = resolve)));
      } catch (refusal) {
        decided.refusal = refusal;
      }
      this.batches.set(lock, decided);
      batch = decided;
    }
    if (batch.refusal !== undefined) throw batch.refusal;
    let result: Promise<T>;
    try {
      result = run();
    } catch (error) {
      batch.settle?.();
      throw error;
    }
    result.then(batch.settle, batch.settle);
    return result;
  }

  /** Tracked in {@link admitted} until it settles. */
  private track<T>(operation: Promise<T>): Promise<T> {
    this.admitted.add(operation);
    const settle = () => void this.admitted.delete(operation);
    operation.then(settle, settle);
    return operation;
  }

  /** On the bare client, so admitted here rather than by the extension. */
  private admitDirect<T>(run: () => Promise<T>): Promise<T> {
    if (this.closing) throw new PoolClosedError();
    return this.track(run());
  }

  async onModuleInit(): Promise<void> {
    await this.base.$connect();
    this.logger.log('Database connection established');
  }

  /**
   * Refuses to run as anything but this service's runtime role (D-045): not a
   * superuser, not a migrator, owning nothing and holding no CREATE — what the
   * catalogue says about the role actually connected, so a DATABASE_URL that
   * names an owner is caught even though no *_MIGRATOR variable is set
   * (@rasta/nest-common runtime-role.ts; Codex review of #176).
   *
   * Called first in `AppModule.onModuleInit`. Not in `onModuleInit` here: the
   * integration suites open owner connections through this class on purpose.
   */
  async assertRuntimeRole(): Promise<void> {
    const facts = await this.admitDirect(() =>
      assertConnectedRuntimeRole(this.base, {
        service: SERVICE_NAME,
        runtimeVariable: 'DATABASE_URL_IDENTITY',
      }),
    );
    this.logger.log(
      `Connected as ${facts.role}: not a superuser or a migrator, owns nothing, no CREATE`,
    );
  }

  /**
   * Closes this pool, by the shutdown's deadline (#458 r2/r3 F2): from now on
   * no new work is admitted — no autocommit statement, no batch, no
   * transaction ({@link PoolClosedError}); every operation already admitted —
   * a COMMIT in flight included — is waited for until `deadlineAt`; then
   * nothing runs on it any more, not even a statement of a transaction still
   * open, and it disconnects, **by what is left of the same deadline**:
   * Prisma's disconnect itself waits for the query its engine is executing.
   * Resolves to `drained` only when everything settled and the disconnect
   * returned in time; otherwise it logs, as an error, how many operations
   * were still unsettled — those may still commit — and reports not drained:
   * a close that returns at its deadline never says clean. One close per
   * pool; later calls join it. Named `stop` because that is what
   * `OutboxShutdown` calls.
   */
  stop(options: OutboxStopOptions = {}): Promise<PoolCloseReport> {
    this.closing ??= this.close(options.deadlineAt);
    return this.closing;
  }

  private async close(deadlineAt: number | undefined): Promise<PoolCloseReport> {
    const unsettled = await settleWithin(this.admitted, deadlineAt);
    this.closed = true;
    if (unsettled > 0) {
      this.logger.error(
        `Closing a database pool with ${unsettled} operations unsettled at the shutdown ` +
          'deadline: they may still commit after this process stopped waiting for them',
      );
    }
    // A disconnect that failed is over, but not a clean close.
    const disconnected = this.base.$disconnect().then(
      () => true,
      (error: unknown) => {
        this.logger.error(`Database pool disconnect failed: ${String(error)}`);
        return false;
      },
    );
    const finished =
      deadlineAt === undefined ||
      (await withinDeadline(disconnected, deadlineAt - Date.now())) === 'finished';
    const left = this.admitted.size;
    if (!finished) {
      this.logger.error(
        'Database pool close ABANDONED: its disconnect had not returned by the shutdown ' +
          `deadline, with ${left} operations still unsettled — they may still commit`,
      );
      return { drained: false, unsettled: left };
    }
    return { drained: (await disconnected) && unsettled === 0 && left === 0, unsettled: left };
  }

  /**
   * Liveness of the database dependency, for the readiness probe.
   * Returns false rather than throwing: an unhealthy dependency is a reported
   * state, not an exception.
   */
  async isHealthy(): Promise<boolean> {
    if (this.closing) return false;
    try {
      await this.admitDirect(() => this.base.$queryRaw`SELECT 1`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Runs `fn` inside a transaction — the only way this service opens an
   * interactive one (`transaction-boundary.spec.ts` holds `src/` to it), so the
   * cancellation checks below are on every transaction of every worker.
   *
   * Exposed deliberately: the outbox pattern requires the state change and the
   * outbox insert to share one transaction, and that is the whole reason the
   * platform does not lose or invent events (ADR-021).
   *
   * `statementTimeoutMs` is for a transaction whose statements may wait longer
   * than the session's statement timeout — `DATABASE_STATEMENT_TIMEOUT_MS`, or
   * behind PgBouncer the runtime role's own default (#268): it is set
   * with `SET LOCAL` as the transaction's first statement, so it ends with the
   * transaction and the connection goes back to the pool unchanged.
   */
  transaction<T>(
    fn: (tx: ExtendedPrismaClient) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    // Transaction setup is a database operation too: none begins once the
    // worker this runs in was stopped (`cancellation.ts`), or once this pool
    // is closing (`stop`).
    if (this.closing) throw new PoolClosedError();
    throwIfCancelled();
    // One budget for its connection wait and its execution together, never
    // past the deadline of the scope it runs in (#458 r2 F2); a statement
    // timeout never outlasts it either.
    const { maxWait, timeout } = transactionBounds({
      maxWait: options?.maxWait,
      timeout: options?.timeout,
      budgetMs: options?.budgetMs,
    });
    // And so is its COMMIT, which Prisma issues when the callback resolves,
    // without passing through the client extension (#402 r3 R3-1): a callback
    // that resumes after the stop returned — its last statement's reply held
    // past it — throws here instead, and Prisma rolls the transaction back.
    // Both branches below run `fn` only through this.
    const committable = async (tx: ExtendedPrismaClient): Promise<T> => {
      const result = await fn(tx);
      if (this.closed) throw new PoolClosedError();
      throwIfCancelled();
      return result;
    };
    const statementTimeoutMs =
      options?.statementTimeoutMs === undefined || timeout === undefined
        ? options?.statementTimeoutMs
        : Math.min(options.statementTimeoutMs, timeout);
    const run =
      statementTimeoutMs === undefined
        ? this.client.$transaction((tx) => committable(tx as ExtendedPrismaClient), {
            maxWait,
            timeout,
          })
        : this.client.$transaction(
            async (tx) => {
              await tx.$executeRawUnsafe(
                `SET LOCAL statement_timeout = ${localStatementTimeoutOf(statementTimeoutMs)}`,
              );
              return committable(tx as ExtendedPrismaClient);
            },
            { maxWait, timeout },
          );
    // Until it settles, its worker's stop and this pool's close wait for it:
    // a COMMIT handed to the engine is never left pending behind either.
    return trackInScope(this.track(run));
  }
}

export interface TransactionOptions {
  maxWait?: number;
  timeout?: number;
  /**
   * The whole of this transaction, its connection wait **and** its execution
   * together (#458 r2 F2): `maxWait + timeout` never exceed it.
   */
  budgetMs?: number;
  /** `SET LOCAL statement_timeout` for this transaction only, in milliseconds. */
  statementTimeoutMs?: number;
}

/**
 * A positive whole number of milliseconds for `SET LOCAL statement_timeout`,
 * which takes no bind parameter. Only ever a constant of this service, and
 * checked so nothing but digits reaches the statement (S-05).
 */
function localStatementTimeoutOf(ms: number): number {
  if (!Number.isSafeInteger(ms) || ms < 1) {
    throw new Error('refusing a statement timeout that is not a positive whole number');
  }
  return ms;
}
