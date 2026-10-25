import { AsyncLocalStorage } from 'node:async_hooks';

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
 * What it does not stop: a statement already sent, and the **rollback** of a
 * transaction such a refusal ends — Prisma's engine rolls back without
 * passing through the client extension, so cleanup is never refused. A fence
 * whose release or confirmation is refused this way simply stays (live until
 * `takeover_at`, then the sweep re-asserts it): slower, never unsafe (D-069).
 *
 * The scope is the async context (`AsyncLocalStorage`), so it follows the
 * work through every `await`, and nothing outside it — a request — is
 * affected. Nested scopes combine: either signal refuses.
 */
const scope = new AsyncLocalStorage<AbortSignal>();

/** Runs `work` with every database operation it starts refused once `signal` is aborted. */
export function withCancellation<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  const outer = scope.getStore();
  return scope.run(outer ? AbortSignal.any([outer, signal]) : signal, work);
}

/** Throws the stop's reason when the work this runs in was cancelled; a no-op outside any scope. */
export function throwIfCancelled(): void {
  scope.getStore()?.throwIfAborted();
}
