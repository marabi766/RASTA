import type { InProgressWriteState } from '@/lib/in-progress-write';
import type { ProjectField, ProjectFormValues } from '@/lib/project-commands';
import type { SessionRefusal } from '@/lib/session-refusal';
import type { UnconfirmedWriteState } from '@/lib/unconfirmed-write';

/**
 * What the `/projects` create form knows after an attempt.
 *
 * A module of its own for the reason `maintenance/form-state.ts` is:
 * `actions.ts` is a `'use server'` file, which may export only async functions,
 * and the form component needs this type and the initial value without importing
 * the action's runtime.
 *
 * Creating a project is the one project call that takes an `Idempotency-Key`
 * (`POST /v1/projects`), so it has the states of a keyed create: a retry of an
 * answer that never came carries the same key and is answered with the first
 * request's own result, and a request still being processed is `IN_PROGRESS`.
 */
export type CreateProjectFormState =
  | { readonly kind: 'IDLE' }
  /** The person's own values, kept so the form is not emptied under them. */
  | {
      readonly kind: 'INVALID';
      readonly submissionId: string;
      readonly replay: string;
      readonly values: ProjectFormValues;
      readonly fieldErrors: Partial<Record<ProjectField, string>>;
      /** A problem the service did not attach to a field. */
      readonly message: string | null;
    }
  /** The request could not be trusted as this person's own. */
  | { readonly kind: 'REFUSED'; readonly reason: SessionRefusal | 'CSRF' | 'SUBMISSION' }
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  /** Refused before it could act (the gateway or the service was unavailable): nothing was written. */
  | { readonly kind: 'FAILED'; readonly status: number; readonly correlationId: string }
  | UnconfirmedWriteState
  /**
   * The same submission is still being processed: kept as typed, with the same
   * submission id, for a retry after `Retry-After`.
   */
  | (InProgressWriteState<ProjectFormValues> & { readonly replay: string })
  /**
   * The form was left open past the time the service keeps its record of the
   * request's key (`server/project-create-replay.ts`): nothing was sent, and the
   * person is told to check the project list first, because an earlier press of
   * this form may have created the project.
   */
  | { readonly kind: 'EXPIRED'; readonly values: ProjectFormValues }
  /**
   * An earlier request of this form is unresolved (`server/unresolved-request.ts`)
   * and this post is not exactly that request: another key (`OTHER_REQUEST`) or
   * other values under the same key (`CHANGED_BODY`). Nothing was sent. Only
   * "send as new", with its confirmation, replaces the unresolved request.
   */
  | {
      readonly kind: 'HELD';
      readonly reason: 'OTHER_REQUEST' | 'CHANGED_BODY';
      readonly values: ProjectFormValues;
    };

export const IDLE_CREATE_PROJECT_FORM: CreateProjectFormState = { kind: 'IDLE' };

/**
 * The checkbox that must be ticked to let go of an unresolved create: the person
 * checked the full project list and accepts that creating it again may leave two
 * projects.
 */
export const CONFIRM_DUPLICATE_FIELD = 'confirmDuplicate';
export const CONFIRM_DUPLICATE_VALUE = 'yes';
