import { useActionState, useSyncExternalStore } from 'react';

import { isRedirect, sessionHasEnded } from '@/lib/session-refusal';
import type { StartOutcome } from '@/lib/unresolved-tenancy';

/**
 * The one submit path of every form whose request is kept in a fenced slot
 * (`lib/unresolved-tenancy.ts` `fencedSlot`): order, dispute, return,
 * statement, contract command, bid and tender owner command (PR 405 review 4).
 *
 * Before anything leaves:
 *
 * - **A first send** is a first send only if the slot does not already keep
 *   that very submission. If it does — a form drawn again blank under a key
 *   whose outcome is unknown — nothing is sent: the kept view is shown, with
 *   its kept body, and nothing it answers can settle the first send (R4).
 *   Another submission's entry holds the slot: `held`, nothing sent.
 * - **A re-send** goes only while its own entry still holds the slot, as the
 *   form decides (`admitRetry`): a withdrawn, unrepeatable or set-aside one
 *   comes back as it is, unsent.
 *
 * Everything returned before the send is an unsent refusal: it finalizes with
 * no `answer` and no new quarantine record (PM addendum D).
 *
 * After the send, **every** completion — the action's answer or its call
 * failing, a first send or a re-send — goes through `finalize`, the one
 * boundary (R5). In doubt: `answer` (its own entry updated while the slot
 * still holds it, else kept aside — the warning shown at once). A definite
 * answer: the entry is settled only when this very send wrote it; a re-send's
 * definite answer settles nothing (a re-send is answered in doubt, and only the
 * redirect below ends it). A redirect is the command done: settled.
 *
 * ## A failed call: kept and shown first, the session asked after (review 5, R6)
 *
 * A call that failed after the send is kept — `answer`, once: its own entry
 * updated, or set aside, or held in memory, and the warning drawn — and its
 * uncertain view returned, **before** anything else is asked of the network.
 * Only then is `/auth/session` asked, with a fixed deadline
 * (`SESSION_PROBE_DEADLINE_MS`, `lib/session-refusal.ts`). Its answer never
 * answers again, never writes, never makes another hold: a `401` only swaps
 * the view this very send returned for its "session ended" view, in memory
 * (`useSlotActionState`); a `204`, a `503`, no answer, or none within the
 * deadline leaves it as it is — uncertain. Nothing of it is stored: the kept
 * records stay exactly what `answer` wrote, the set-aside ones content-free.
 *
 * Unchanged: a redirect is settled, and the unsent refusals above keep no hold.
 */

/** The form state's uncertainty view. */
export type Uncertain<S> = Extract<S, { readonly kind: 'UNCONFIRMED' }>;

export interface SlotSubmission<S extends { readonly kind: string }> {
  /** The key this press goes under: the form's own on a first send, the view's on a re-send. */
  readonly submissionId: string;
  /** The uncertainty view being sent again; null on a first send. */
  readonly retrying: Uncertain<S> | null;
  /** The entry this person's slot keeps now, as this form would show it — or null. */
  readonly stored: () => { readonly submissionId: string; readonly state: S } | null;
  /** A first send the form refuses before anything is remembered (an invalid form). */
  readonly check?: () => S | null;
  /** Remembers a first send before it leaves; null when the action refuses it unsent. */
  readonly remember: () => StartOutcome | null;
  /** A re-send: null when it may go; otherwise what is shown instead, unsent. */
  readonly admitRetry: (retrying: Uncertain<S>) => S | null;
  readonly send: () => Promise<S>;
  /** The view of a send whose call itself failed; `ended` only for `/auth/session` 401. */
  readonly failed: (ended: boolean) => Uncertain<S> | null;
  /** An answer still in doubt: kept (`fencedSlot.answer`). */
  readonly answer: (state: Uncertain<S>) => void;
  /** A definite answer to this submission: its own entry, and only that, goes. */
  readonly settle: () => void;
  readonly held: S;
  readonly unavailable: S;
}

export function isUncertain<S extends { readonly kind: string }>(state: S): state is Uncertain<S> {
  return state.kind === 'UNCONFIRMED';
}

export async function submitThroughSlot<S extends { readonly kind: string }>(
  submission: SlotSubmission<S>,
): Promise<S> {
  const { submissionId, retrying, stored } = submission;
  let wrote = false;

  if (retrying === null) {
    const holder = stored();
    if (holder !== null)
      return holder.submissionId === submissionId ? holder.state : submission.held;
    const refused = submission.check?.() ?? null;
    if (refused !== null) return refused;
    const remembered = submission.remember();
    if (remembered === 'HELD') return submission.held;
    if (remembered === 'UNAVAILABLE') return submission.unavailable;
    if (remembered === 'UNRESOLVED') {
      const again = stored();
      return again !== null && again.submissionId === submissionId ? again.state : submission.held;
    }
    wrote = remembered === 'SAVED';
  } else {
    const refused = submission.admitRetry(retrying);
    if (refused !== null) return refused;
  }

  /** The one boundary every completion goes through. */
  const finalize = (next: S): S => {
    if (isUncertain(next)) submission.answer(next);
    else if (wrote) submission.settle();
    return next;
  };

  let next: S;
  /** For a failed call: its view once `/auth/session` says the session ended. */
  let ended: S | null = null;
  try {
    next = await submission.send();
  } catch (error) {
    // Done: the action redirects to the outcome. Nothing is unresolved now.
    if (isRedirect(error)) {
      submission.settle();
      throw error;
    }
    // Nothing was remembered, so nothing is in doubt to keep: the action refuses
    // such a form before sending.
    if (retrying === null && !wrote) throw error;
    // From what is known now — nothing waits on another answer (R6).
    const failed = submission.failed(false);
    if (failed === null) throw error;
    next = failed;
    ended = submission.failed(true);
  }
  const shown = finalize(next);
  if (ended !== null) probeAfter(shown, ended);
  return shown;
}

// ---------------------------------------------------------------------------
// The session, asked after a failed call has been kept (R6)

/**
 * A view this boundary returned for a failed call → its "session ended" view,
 * once `/auth/session` answered 401. Keyed by that very object: only the form
 * state it became can ever show it — not another person's, organization's or
 * login's form (drawn anew, from other objects), nor a newer submission's
 * state. In memory only, for this document.
 */
const sessionVerdicts = new WeakMap<object, object>();
const verdictWatchers = new Set<() => void>();

function watchVerdicts(listener: () => void): () => void {
  verdictWatchers.add(listener);
  return () => {
    verdictWatchers.delete(listener);
  };
}

function probeAfter<S extends { readonly kind: string }>(shown: S, ended: S): void {
  void sessionHasEnded().then((yes) => {
    if (!yes) return;
    sessionVerdicts.set(shown, ended);
    for (const listener of [...verdictWatchers]) listener();
  });
}

/**
 * The one way a fenced form holds its state: React's `useActionState`, with a
 * failed call's view swapped for its "session ended" view once `/auth/session`
 * said so — only while that very view is the state, and not while a newer
 * press is out (`pending`).
 */
export function useSlotActionState<S extends { readonly kind: string }>(
  send: (previous: S, form: FormData) => Promise<S>,
  initial: S,
): [state: S, dispatch: (form: FormData) => void, pending: boolean] {
  const [state, dispatch, pending] = useActionState<S, FormData>(send, initial as Awaited<S>);
  const ended = useSyncExternalStore(
    watchVerdicts,
    () => sessionVerdicts.get(state) as S | undefined,
    () => undefined,
  );
  return [ended !== undefined && !pending ? ended : (state as S), dispatch, pending];
}
