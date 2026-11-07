import { AsyncLocalStorage } from 'node:async_hooks';

import { SUBMISSION_FIELD } from '@/lib/form-fields';
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
 * ## Which request is unresolved (PR-880 r1 F1)
 *
 * An unresolved state names its request: every unresolved state this returns
 * carries the `submissionId` it was sent under (stamped from the post when the
 * action's own state does not say), and a retry turned `UNCONFIRMED` carries the
 * held request's `submissionId` and `values` — not the retry's, and not the
 * page's. A form whose key changed mid-way ("edit and send as new", a document
 * started afresh) therefore resends **that** request, not the page's first one.
 *
 * And only that request can settle it: a retry whose posted `submissionId` is
 * not the held one — or of a held state that names none — sends **nothing** and
 * stays `UNCONFIRMED` (fail closed). A success under another key confirms
 * another request, never this one. The body under the held key is the service's
 * to compare (a changed body is `IDEMPOTENCY_KEY_REUSED`, which a retry answers
 * as `UNCONFIRMED` like any refusal).
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

/** The request an unresolved state is about: its key and, where the form keeps them, its values. */
function heldRequestOf(state: unknown): { submissionId: string; values?: unknown } | null {
  if (typeof state !== 'object' || state === null) return null;
  const { submissionId, values } = state as { submissionId?: unknown; values?: unknown };
  if (typeof submissionId !== 'string' || submissionId === '') return null;
  return values === undefined ? { submissionId } : { submissionId, values };
}

/** An unresolved `state` names the key it was sent under: its own, else the posted one. */
function namingItsRequest<S>(state: S, posted: FormDataEntryValue | null): S {
  if (!isUnresolvedState(state) || heldRequestOf(state) !== null) return state;
  return typeof posted === 'string' && posted !== '' ? { ...state, submissionId: posted } : state;
}

/**
 * Runs `attempt` for the post `form`; when `previous` is unresolved, holds its
 * answer to the rules above, building the `UNCONFIRMED` state with `unconfirmed`
 * (for a form whose unconfirmed state carries more than the correlation id).
 */
export async function keepUnconfirmedWith<S extends { readonly kind: string }>(
  previous: S,
  form: FormData,
  attempt: () => Promise<S>,
  unconfirmed: (correlationId: string, state: S, previous: S) => S,
): Promise<S> {
  const posted = form.get(SUBMISSION_FIELD);
  if (!isUnresolvedState(previous)) return namingItsRequest(await attempt(), posted);
  const held = heldRequestOf(previous);
  const firstCorrelation = correlationOf(previous);
  if (held === null || posted !== held.submissionId) {
    // Not the held request: nothing is sent, nothing it answers could settle this one.
    return { ...unconfirmed(firstCorrelation ?? '-', previous, previous), ...held };
  }
  const state = namingItsRequest(await retrying.run(true, attempt), posted);
  if (PASSED.has(state.kind)) return state;
  return {
    ...unconfirmed(firstCorrelation ?? correlationOf(state) ?? '-', state, previous),
    ...held,
  };
}

/** {@link keepUnconfirmedWith} for a form whose unconfirmed state is the shared one. */
export function keepUnconfirmed<S extends { readonly kind: string }>(
  previous: S,
  form: FormData,
  attempt: () => Promise<S>,
): Promise<S | UnconfirmedWriteState> {
  return keepUnconfirmedWith<S | UnconfirmedWriteState>(
    previous,
    form,
    attempt,
    (correlationId) => ({
      kind: 'UNCONFIRMED',
      correlationId,
    }),
  );
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
