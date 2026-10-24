import type { SessionRefusal } from '@/lib/session-refusal';
import type { NeedField, NeedFormValues } from '@/lib/project-need-commands';
import type { UnconfirmedWriteState } from '@/lib/unconfirmed-write';

/**
 * What the add-need form knows after an attempt.
 *
 * Adding a need is the one need call that takes an `Idempotency-Key`, so it has the
 * states of a keyed create. It is **never sent again** when its answer was lost
 * (`project-need-create` is `retry: false`: the endpoint takes no replay deadline,
 * so the service cannot refuse a resend past its own retention), so there is no
 * "retry after the wait" state: a request the service is still processing is
 * `PROCESSING`, an unresolved one is held until the person has looked at the
 * project's needs. A module of its own because `need-actions.ts` is a `'use server'`
 * file and may export only async functions.
 *
 * Success has no state to render: the action redirects to a fresh read (a signed
 * `?flash=`), which is also what makes a refresh unable to resubmit.
 */
export type AddNeedFormState =
  | { readonly kind: 'IDLE' }
  /** The person's own values, kept so the form is not emptied under them. */
  | {
      readonly kind: 'INVALID';
      readonly submissionId: string;
      readonly replay: string;
      readonly values: NeedFormValues;
      readonly fieldErrors: Partial<Record<NeedField, string>>;
      /** A problem the service did not attach to a field. */
      readonly message: string | null;
    }
  /** The post could not be trusted as this person's own. */
  | { readonly kind: 'REFUSED'; readonly reason: SessionRefusal | 'CSRF' | 'SUBMISSION' }
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  /** The project is not visible to this person (absent and "not yours" read the same). */
  | { readonly kind: 'NOT_FOUND'; readonly correlationId: string }
  /** Refused before it could act (the gateway or the service was unavailable): nothing was written. */
  | { readonly kind: 'FAILED'; readonly status: number; readonly correlationId: string }
  | UnconfirmedWriteState
  /**
   * The service is still processing the first request of this form (`409 CONFLICT` with `Retry-After`):
   * it may yet commit, and it is not sent again.
   */
  | { readonly kind: 'PROCESSING'; readonly correlationId: string }
  /**
   * The form was left open past the time the service keeps its record of the request's key
   * (`server/replay-stamp.ts`): nothing was sent, and the person is told to check the needs first,
   * because an earlier press of this form may have added the need.
   */
  | { readonly kind: 'EXPIRED'; readonly values: NeedFormValues }
  /** An earlier add is unresolved, or one is being dispatched right now: nothing was sent. */
  | {
      readonly kind: 'HELD';
      readonly reason: 'IN_PROGRESS' | 'OTHER_REQUEST';
      readonly values: NeedFormValues;
    }
  /** The store of unresolved requests could not be reached or read: nothing was sent (fail closed). */
  | { readonly kind: 'NOT_CHECKED'; readonly values: NeedFormValues }
  /** This login already holds the most unresolved requests it may; a new one was not sent. */
  | { readonly kind: 'CAPACITY'; readonly values: NeedFormValues };

export const IDLE_ADD_NEED_FORM: AddNeedFormState = { kind: 'IDLE' };

/** The checkbox that must be ticked to let go of an unresolved add. */
export const CONFIRM_DUPLICATE_NEED_FIELD = 'confirmDuplicate';
export const CONFIRM_DUPLICATE_NEED_VALUE = 'yes';

/** The hidden field of the release form: the signed name of the record it was drawn for. */
export const RELEASE_NEED_FIELD = 'release';
