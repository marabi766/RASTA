import { AsyncLocalStorage } from 'node:async_hooks';
import { withinDeadline } from '@rasta/nest-common';

/**
 * The one cancellation boundary of every database operation (#402 r2 F2).
 *
 * A background worker — the expiry and re-assertion sweep, the Keycloak
 * projection consumer — runs its work inside {@link withCancellation}, with
 * the signal its stop aborts. From then on, **every** database operation
 * started anywhere below it — a model call, raw SQL, a transaction's setup
 * (`PrismaService.transaction`), a fence insert, release, confirmation or
 * terminal marking, on the business pool or the fence pool — checks that
 * signal first, in `PrismaService`'s client extension, and refuses to start
 * once it is aborted. So work that resumes after its stop gave up on it — a
 * query that was already running when the stop returned, then its
 * continuation — starts nothing more on the database: not a check each call
 * site has to remember, but one boundary every call goes through.
 *
 * A transaction's **COMMIT** is refused too (#402 r3 R3-1). Prisma's engine
 * issues it when the callback resolves, without passing through the client
 * extension, so `PrismaService.transaction` checks the signal again at that
 * point: a callback that resumes after the stop — its last statement's reply
 * held past it — throws instead of returning, and the transaction rolls back.
 * Nothing it did commits, on either pool. If it had already sent a Keycloak
 * PUT, that PUT carried the state read under the user lock; its fence row,
 * committed on the fence pool before the PUT, survives the rollback (the
 * rollback undoes only the business transaction's delete of it), stays live
 * until `takeover_at`, holds every narrowing back meanwhile, and is then
 * re-asserted by the sweep from the rows as they are: no stale write.
 *
 * What it does not stop: a statement already sent — a COMMIT included, when
 * the stop aborts after the callback resolved; that one is **waited for**
 * instead, by the deadline, and counted (#458 r2 F2): by the scope's owner
 * ({@link settleWithin}) before its stop returns, and by the pool before it
 * closes (`PrismaService.stop`) — and the **rollback** of a transaction such
 * a refusal ends: Prisma's engine rolls back without
 * passing through the client extension, so cleanup is never refused. A fence
 * whose release or confirmation is refused this way simply stays (live until
 * `takeover_at`, then the sweep re-asserts it): slower, never unsafe (D-069).
 *
 * **A late sender in a stopped scope (D-070 option D).** A sender that hears
 * back only after its deadline owes a fresh fence for its user
 * (`KeycloakWriteFences.recoverLate`). Resumed after its worker's stop, it
 * cannot write one here — this boundary refuses it like anything else, and
 * is not weakened for it. The fence is kept as owed in the process and
 * written by the stop itself, before it returns and **outside** this scope
 * (`recoverOwed`, called by the sweep's and the consumer's stop; the flush
 * also fences every write still unanswered past its deadline). The stop's
 * flush is a short transaction of its own on the fence pool, under no user
 * lock: nothing of the stopped work commits. What that does not cover: a
 * sender that hears back after the stop's flush and before the process
 * exits, or a process that dies without a stop, with a fence owed — that
 * fresh fence is lost, and the old one stands only if not yet taken over;
 * and, beyond any sender, a request delayed in the network, a proxy or
 * Keycloak after the sender's last check, which leaves no trace on its clock
 * — that stays the deployment assumption F (D-070) until option A (a
 * projection version in the token, after #381 PR 2). ADR-060 D-069 addendum
 * § 7.
 *
 * **A deadline is part of the boundary** (#458 r1 F2, r2 F2). A stop's own
 * last step — the flush of owed fences — runs outside the scope it
 * cancelled, but not unbounded: {@link untilDeadline} runs it in a scope of
 * its own whose deadline is the stop's less {@link COMMIT_RESERVE_MS}, so
 * every check above — before each operation, each transaction's setup and
 * each COMMIT — refuses once that has passed. Each transaction it starts gets
 * what is left **once**, its connection wait and its execution together
 * (`PrismaService.transaction`, {@link transactionBounds}): the two can never
 * add up past it. A transaction whose COMMIT was handed to the engine before
 * then is **waited for** — the reserve is its time — and counted: the stop
 * returns once it settled, or at its deadline with how many had not
 * (`unsettled`), for the caller to report; it never says "drained" with a
 * COMMIT still pending. Past that scope's deadline it is aborted, so nothing
 * of the flush begins, inserts or commits afterwards — but the rollback of
 * the transaction it was in. The pools close only after every worker has
 * returned (`OutboxShutdown`'s `databases`), and refuse everything once
 * closed: nothing runs after a disconnect, nor reconnects.
 *
 * The scope is the async context (`AsyncLocalStorage`), so it follows the
 * work through every `await`, and nothing outside it — a request — is
 * affected. Nested scopes combine: either signal refuses, and the earlier
 * deadline holds.
 */
interface Scope {
  signal: AbortSignal;
  /** Wall clock (`Date.now`), like every shutdown deadline (D-052); none when absent. */
  deadlineAt?: number;
  /** The transactions started in this scope (or one nested in it) and not settled yet. */
  transactions: Set<Promise<unknown>>;
  parent?: Scope;
}

const scope = new AsyncLocalStorage<Scope>();

/**
 * Runs `work` with every database operation it starts refused once `signal`
 * is aborted — or, given `deadlineAt`, once that instant has passed. Every
 * transaction it starts is added to `transactions`, when given, until it
 * settles: what its owner waits for before saying it stopped
 * ({@link settleWithin}).
 */
export function withCancellation<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
  options: { deadlineAt?: number; transactions?: Set<Promise<unknown>> } = {},
): Promise<T> {
  const outer = scope.getStore();
  const deadlines = [outer?.deadlineAt, options.deadlineAt].filter(
    (at): at is number => at !== undefined,
  );
  return scope.run(
    {
      signal: outer ? AbortSignal.any([outer.signal, signal]) : signal,
      deadlineAt: deadlines.length > 0 ? Math.min(...deadlines) : undefined,
      transactions: options.transactions ?? new Set(),
      parent: outer,
    },
    work,
  );
}

/** The work this runs in was cancelled, or its deadline passed. */
export class CancelledError extends Error {
  constructor(reason: 'stopped' | 'deadline') {
    super(
      `refused: the work this runs in was ${reason === 'stopped' ? 'stopped' : 'past its deadline'}`,
    );
    this.name = 'CancelledError';
  }
}

/**
 * Throws when the work this runs in was cancelled — the stop's reason — or
 * its deadline passed; a no-op outside any scope.
 */
export function throwIfCancelled(): void {
  const current = scope.getStore();
  if (!current) return;
  current.signal.throwIfAborted();
  if (current.deadlineAt !== undefined && Date.now() >= current.deadlineAt) {
    throw new CancelledError('deadline');
  }
}

/** Milliseconds left before this scope's deadline: infinite outside one, 0 once cancelled. */
export function remainingMs(): number {
  const current = scope.getStore();
  if (!current) return Number.POSITIVE_INFINITY;
  if (current.signal.aborted) return 0;
  if (current.deadlineAt === undefined) return Number.POSITIVE_INFINITY;
  return Math.max(0, current.deadlineAt - Date.now());
}

/**
 * How long before a stop's deadline the work it waits for must have handed
 * its last COMMIT to the engine ({@link untilDeadline}): the time that COMMIT
 * has to come back before the stop returns. A COMMIT cannot be taken back once
 * sent, so it is waited for, not cut off.
 */
export const COMMIT_RESERVE_MS = 250;

/** Prisma's own defaults for an interactive transaction (`maxWait`, `timeout`). */
const PRISMA_MAX_WAIT_MS = 2_000;
const PRISMA_TIMEOUT_MS = 5_000;

/**
 * One budget for a transaction's connection wait **and** its execution
 * (#458 r2 F2): `maxWait` and `timeout` together never exceed `budgetMs`, so a
 * connection acquired late cannot then run a full budget of its own. Below 2
 * ms, none: no transaction begins.
 */
export function splitBudget(budgetMs: number): { maxWait: number; timeout: number } | null {
  const whole = Math.floor(budgetMs);
  if (!(whole >= 2)) return null;
  const maxWait = Math.floor(whole / 2);
  return { maxWait, timeout: whole - maxWait };
}

/**
 * The bounds of one transaction started now, in this scope: what it asked
 * for, or — when that would end past its own whole budget (`budgetMs`) or the
 * scope's deadline — what is left of the earlier, given **once** to its
 * connection wait and its execution together ({@link splitBudget}). Neither,
 * and it is what it asked for. Throws when nothing is left: no transaction
 * begins.
 */
export function transactionBounds(requested: {
  maxWait?: number;
  timeout?: number;
  budgetMs?: number;
}): { maxWait?: number; timeout?: number } {
  const underDeadline = scope.getStore()?.deadlineAt !== undefined;
  if (!underDeadline && requested.budgetMs === undefined) {
    return { maxWait: requested.maxWait, timeout: requested.timeout };
  }
  const left = Math.min(
    underDeadline ? remainingMs() : Number.POSITIVE_INFINITY,
    requested.budgetMs ?? Number.POSITIVE_INFINITY,
  );
  const maxWait = requested.maxWait ?? PRISMA_MAX_WAIT_MS;
  const timeout = requested.timeout ?? PRISMA_TIMEOUT_MS;
  if (maxWait + timeout <= left) return { maxWait, timeout };
  const split = splitBudget(left);
  if (!split) throw new CancelledError('deadline');
  const wait = Math.min(maxWait, split.maxWait);
  return { maxWait: wait, timeout: Math.min(timeout, Math.floor(left) - wait) };
}

/**
 * Registers a transaction with the scope it starts in, and every scope around
 * it, until it settles — so the owner of a scope can wait for one whose
 * COMMIT was already handed to the engine ({@link settleWithin}). A no-op
 * outside any scope.
 */
export function trackInScope<T>(transaction: Promise<T>): Promise<T> {
  for (let current = scope.getStore(); current; current = current.parent) {
    const set = current.transactions;
    set.add(transaction);
    const settle = () => void set.delete(transaction);
    transaction.then(settle, settle);
  }
  return transaction;
}

/**
 * Waits for every transaction in `transactions` — those added while it waits
 * too — to settle, at most until `deadlineAt` (none: until they have).
 * Resolves to how many had not by then: transactions that may still commit,
 * for the caller to report — never "drained" with a COMMIT still pending.
 */
export async function settleWithin(
  transactions: Set<Promise<unknown>>,
  deadlineAt: number | undefined,
): Promise<number> {
  while (transactions.size > 0) {
    const all = Promise.allSettled([...transactions]);
    if (deadlineAt === undefined) await all;
    else if ((await withinDeadline(all, deadlineAt - Date.now())) === 'abandoned') break;
  }
  return transactions.size;
}

/**
 * A stop's last step, bounded by its deadline (#458 r1 F2, r2 F2): `work`
 * runs in a scope of its own that refuses every database operation — a
 * transaction's BEGIN and COMMIT included — from {@link COMMIT_RESERVE_MS}
 * before `deadlineAt`, and is waited for until then; if it has not finished,
 * that scope is aborted. Either way, every transaction of it still unsettled
 * — a COMMIT in flight, a rollback — is then waited for until `deadlineAt`,
 * and how many had not settled by then is returned (`unsettled`, 0 when all
 * did): the caller reports a non-zero count loudly, those may still commit.
 * Without a deadline it is simply waited for.
 */
export async function untilDeadline<T>(
  work: () => Promise<T>,
  deadlineAt: number | undefined,
): Promise<
  { outcome: 'finished'; value: T; unsettled: number } | { outcome: 'abandoned'; unsettled: number }
> {
  const stop = new AbortController();
  if (deadlineAt === undefined) {
    return { outcome: 'finished', value: await withCancellation(stop.signal, work), unsettled: 0 };
  }
  const workUntil = deadlineAt - COMMIT_RESERVE_MS;
  const transactions = new Set<Promise<unknown>>();
  const running = withCancellation(stop.signal, work, { deadlineAt: workUntil, transactions });
  const finished = (await withinDeadline(running, workUntil - Date.now())) === 'finished';
  if (!finished) {
    stop.abort(new CancelledError('deadline'));
    void running.catch(() => undefined);
  }
  // Handed to the engine before then: waited for, never cut off.
  const unsettled = await settleWithin(transactions, deadlineAt);
  return finished
    ? { outcome: 'finished', value: await running, unsettled }
    : { outcome: 'abandoned', unsettled };
}
