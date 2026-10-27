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
 * the stop aborts after the callback resolved — and the **rollback** of a
 * transaction such a refusal ends: Prisma's engine rolls back without
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
 * **A deadline is part of the boundary** (#458 r1 F2). A stop's own last
 * step — the flush of owed fences — runs outside the scope it cancelled, but
 * not unbounded: {@link untilDeadline} runs it in a scope of its own that
 * carries the shutdown's deadline, so every check above — before each
 * operation, each transaction's setup and each COMMIT — also refuses once
 * that deadline has passed, and {@link remainingMs} bounds each transaction
 * it starts (its connection wait included) by what is left, less a margin
 * ({@link transactionBudgetMs}). Should the stop
 * give up on it at the deadline, that scope is aborted before the stop
 * returns: nothing of the flush begins, inserts or commits afterwards — but
 * the rollback of the transaction it was in.
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
}

const scope = new AsyncLocalStorage<Scope>();

/**
 * Runs `work` with every database operation it starts refused once `signal`
 * is aborted — or, given `deadlineAt`, once that instant has passed.
 */
export function withCancellation<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
  options: { deadlineAt?: number } = {},
): Promise<T> {
  const outer = scope.getStore();
  const deadlines = [outer?.deadlineAt, options.deadlineAt].filter(
    (at): at is number => at !== undefined,
  );
  return scope.run(
    {
      signal: outer ? AbortSignal.any([outer.signal, signal]) : signal,
      deadlineAt: deadlines.length > 0 ? Math.min(...deadlines) : undefined,
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
 * How much earlier than a scope's deadline a transaction's own bounds end
 * ({@link transactionBudgetMs}): Prisma's engine enforces `maxWait` on its
 * own clock, so a connection wait bounded to the very instant of the deadline
 * could still begin a moment after the stop gave up and returned.
 */
export const DEADLINE_MARGIN_MS = 20;

/**
 * The bound of one transaction started in this scope, in whole milliseconds:
 * `capMs`, or what is left of the scope's deadline less
 * {@link DEADLINE_MARGIN_MS} if that is less — its connection wait, its
 * statements and its own timeout all end before the deadline. Below 1, no
 * transaction should begin at all.
 */
export function transactionBudgetMs(capMs: number): number {
  const left = remainingMs();
  return Math.floor(
    Math.min(capMs, left === Number.POSITIVE_INFINITY ? capMs : left - DEADLINE_MARGIN_MS),
  );
}

/**
 * A stop's last step, bounded by its deadline (#458 r1 F2): `work` runs in a
 * scope of its own that refuses every database operation past `deadlineAt`
 * (see the header), and is waited for until then. Past it, the scope is
 * aborted **before** this returns `'abandoned'`, so nothing of `work` reaches
 * the database afterwards. Without a deadline it is simply waited for.
 */
export async function untilDeadline<T>(
  work: () => Promise<T>,
  deadlineAt: number | undefined,
): Promise<{ outcome: 'finished'; value: T } | { outcome: 'abandoned' }> {
  const stop = new AbortController();
  const running = withCancellation(stop.signal, work, { deadlineAt });
  if (deadlineAt === undefined) return { outcome: 'finished', value: await running };
  if ((await withinDeadline(running, deadlineAt - Date.now())) === 'abandoned') {
    stop.abort(new CancelledError('deadline'));
    void running.catch(() => undefined);
    return { outcome: 'abandoned' };
  }
  return { outcome: 'finished', value: await running };
}
