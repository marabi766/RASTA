import { AsyncLocalStorage } from 'node:async_hooks';

import type { UnconfirmedWriteState } from '@/lib/unconfirmed-write';

/**
 * A retry of a write whose outcome is not known stays **unconfirmed** until it is
 * confirmed (FU-173, PR-830 r2 F1; checklist A1, A2).
 *
 * A form whose send came back `UNCONFIRMED` (the answer was lost: the first send
 * may have committed) still offers the same button, under the same submission id.
 * The retry is either answered with the first send's own result — the service
 * replays the key, the action redirects, confirmed — or with something that is
 * about **this** attempt only: a `429 RATE_LIMIT_EXCEEDED` from the gateway, a
 * refusal any guard in front of the service can give before it looks at the key,
 * a version conflict that the first send itself may have caused, an ended
 * session, a form that no longer parses. None of these says what happened to the
 * first send, so none may replace "we do not know" with "nothing changed, you can
 * resend". Before this, every form did exactly that on its second answer.
 *
 * ## The rule, in one place
 *
 * Every write action in scope runs its attempt through {@link keepUnconfirmed}
 * with the state its form held before the post (`useActionState`'s previous
 * state, which belongs to that one form, so another form on the page is not
 * affected). When that state is unresolved — `UNCONFIRMED`, or `IN_PROGRESS`
 * (another request with this key is still being processed) — then:
 *
 *   - a success still redirects: that is the confirmation (a replay included);
 *   - `IN_PROGRESS` comes back as it is: still unresolved, with its timed retry;
 *   - `EDITING` comes back as it is: the person chose "edit and send as new"
 *     (a new key), the one explicit step a form offers past an unresolved send;
 *   - **everything else** comes back as `UNCONFIRMED`, under the first send's
 *     correlation id (a retry that is itself unconfirmed included: support looks
 *     for the first send) — fail closed: a state not listed above is never taken
 *     as proof about the first send.
 *
 * And while the attempt runs, every write it sends answers anything but a
 * success or "in progress" as `UNKNOWN_OUTCOME` ({@link inheritUnconfirmed},
 * applied by `writeThroughGateway`). So a runner that redirects on a refusal (a
 * stale-version notice, a conflict notice) cannot redirect past the rule either:
 * it sees an unknown outcome and says so.
 *
 * The page read after a refresh is the reconciliation step: it draws a fresh
 * form (a new key) from what the service now holds.
 *
 * ## Why the previous state may be trusted for this
 *
 * It is the browser's, so it is only ever used to make the answer *less*
 * certain, never more: a forged `UNCONFIRMED` makes that browser's own form say
 * "we do not know". Nothing is sent or skipped because of it, and the
 * correlation id taken from it is shown back only to the same form, and only
 * when it looks like one.
 *
 * `unconfirmed-retry-guard.spec.ts` (beside `app/`) finds every write action and fails
 * when one does not apply this.
 */

const retrying = new AsyncLocalStorage<true>();

const UNRESOLVED = new Set(['UNCONFIRMED', 'IN_PROGRESS']);
/** What may come back unchanged from a retry of an unresolved send. */
const PASSED = new Set(['IN_PROGRESS', 'EDITING']);
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function kindOf(state: unknown): string | null {
  if (typeof state !== 'object' || state === null) return null;
  const kind = (state as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : null;
}

function correlationOf(state: unknown): string | null {
  if (typeof state !== 'object' || state === null) return null;
  const id = (state as { correlationId?: unknown }).correlationId;
  return typeof id === 'string' && CORRELATION_ID.test(id) ? id : null;
}

/** Whether `previous` — the form's state before this post — is a send whose outcome is not known. */
export function isUnresolvedState(previous: unknown): boolean {
  const kind = kindOf(previous);
  return kind !== null && UNRESOLVED.has(kind);
}

/**
 * Runs `attempt`; when `previous` is unresolved, holds its answer to the rule
 * above, building the `UNCONFIRMED` state with `unconfirmed` (for a form whose
 * unconfirmed state carries more than the correlation id).
 */
export async function keepUnconfirmedWith<S extends { readonly kind: string }>(
  previous: S,
  attempt: () => Promise<S>,
  unconfirmed: (correlationId: string, state: S, previous: S) => S,
): Promise<S> {
  if (!isUnresolvedState(previous)) return attempt();
  const state = await retrying.run(true, attempt);
  if (PASSED.has(state.kind)) return state;
  return unconfirmed(correlationOf(previous) ?? correlationOf(state) ?? '-', state, previous);
}

/** {@link keepUnconfirmedWith} for a form whose unconfirmed state is the shared one. */
export function keepUnconfirmed<S extends { readonly kind: string }>(
  previous: S,
  attempt: () => Promise<S>,
): Promise<S | UnconfirmedWriteState> {
  return keepUnconfirmedWith<S | UnconfirmedWriteState>(previous, attempt, (correlationId) => ({
    kind: 'UNCONFIRMED',
    correlationId,
  }));
}

/**
 * What a write sent during a retry of an unresolved send answers: a success and
 * "in progress" as they are, anything else as `UNKNOWN_OUTCOME`. Outside such a
 * retry, `result` unchanged.
 */
export function inheritUnconfirmed<
  R extends { readonly kind: string; readonly correlationId: string },
>(result: R): R | { readonly kind: 'UNKNOWN_OUTCOME'; readonly correlationId: string } {
  if (retrying.getStore() !== true) return result;
  if (result.kind === 'CREATED' || result.kind === 'IN_PROGRESS') return result;
  return { kind: 'UNKNOWN_OUTCOME', correlationId: result.correlationId };
}
