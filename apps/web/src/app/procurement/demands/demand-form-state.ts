import type { DemandField, DemandFormValues } from '@/lib/demand-commands';
import type { InProgressWriteState } from '@/lib/in-progress-write';
import type { SessionRefusal } from '@/lib/session-refusal';
import type { UnconfirmedWriteState } from '@/lib/unconfirmed-write';

/**
 * What the demand form knows after an attempt. A module of its own because
 * `demand-actions.ts` is a `'use server'` file and may export only async
 * functions.
 *
 * The submission takes an `Idempotency-Key`, so it has the states of a keyed
 * create (`projects/form-state.ts`): a retry of an answer that never came carries
 * the same key and is answered with the first request's own result, and a
 * request still being processed is `IN_PROGRESS`. Success has no state: the
 * action redirects to a fresh read of the demand.
 */
export type DemandFormState =
  | { readonly kind: 'IDLE' }
  /** The person's own values, kept with the same key and stamp so a retry is the same request. */
  | {
      readonly kind: 'INVALID';
      readonly submissionId: string;
      readonly replay: string;
      readonly values: DemandFormValues;
      readonly fieldErrors: Partial<Record<DemandField, string>>;
      /** A problem the service did not attach to a field. */
      readonly message: string | null;
    }
  /** The post could not be trusted as this person's own. */
  | { readonly kind: 'REFUSED'; readonly reason: SessionRefusal | 'CSRF' | 'SUBMISSION' }
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  /** Proven refused before it could act: nothing was written. */
  | { readonly kind: 'FAILED'; readonly status: number; readonly correlationId: string }
  | UnconfirmedWriteState
  /** The same submission is still being processed: kept as typed, same key, for a retry. */
  | (InProgressWriteState<DemandFormValues> & { readonly replay: string })
  /**
   * Past the time the service keeps the key (`server/demand-replay.ts`): nothing
   * was sent; an earlier press may have registered the demand, so the list first.
   */
  | { readonly kind: 'EXPIRED'; readonly values: DemandFormValues }
  /**
   * An earlier submission is unresolved and this post is not exactly it: another
   * key, other values under the same key, or it is being dispatched right now.
   * Nothing was sent; only "send as new", with its confirmation, replaces it.
   */
  | {
      readonly kind: 'HELD';
      readonly reason: 'IN_PROGRESS' | 'OTHER_REQUEST' | 'CHANGED_BODY';
      readonly values: DemandFormValues;
    }
  /** The store of unresolved requests could not be checked: nothing was sent (fail closed). */
  | { readonly kind: 'NOT_CHECKED'; readonly values: DemandFormValues }
  /** This login holds the most unresolved requests allowed: nothing was sent. */
  | { readonly kind: 'CAPACITY'; readonly values: DemandFormValues };

export const IDLE_DEMAND_FORM: DemandFormState = { kind: 'IDLE' };

/** The checkbox that lets go of an unresolved submission: the full list was checked, a duplicate is accepted. */
export const CONFIRM_DUPLICATE_FIELD = 'confirmDuplicate';
export const CONFIRM_DUPLICATE_VALUE = 'yes';
/** The hidden field of the release form: the signed name of the record it was drawn for. */
export const RELEASE_FIELD = 'release';
