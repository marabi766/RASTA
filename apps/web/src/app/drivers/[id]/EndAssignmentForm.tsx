'use client';

import { useActionState } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { UnconfirmedWriteAlert } from '@/app/UnconfirmedWriteAlert';
import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { EMPTY_END_ASSIGNMENT_FORM } from '@/lib/driver-fields';
import { assignmentEndReasonOptions } from '@/lib/labels';

import { submitEndAssignment } from './actions';
import { IDLE_END_ASSIGNMENT_FORM, type EndAssignmentFormState } from './form-state';

/**
 * Ending this driver's current assignment — shown only beside the active
 * assignment `DriverDetailScreen` renders, never as a standalone control:
 * there is exactly one to end, and *which* one is bound to the action rather
 * than offered as a choice (`actions.ts`).
 *
 * No `assignmentId` field: the id is exactly the one this form was rendered
 * beside, and there is no second one to pick.
 */
export function EndAssignmentForm({
  driverId,
  assignmentId,
  csrfToken,
  submissionId,
}: {
  driverId: string;
  assignmentId: string;
  csrfToken: string;
  submissionId: string;
}) {
  const [state, action, pending] = useActionState(
    submitEndAssignment.bind(null, driverId, assignmentId),
    IDLE_END_ASSIGNMENT_FORM,
  );

  const values = state.kind === 'INVALID' ? state.values : EMPTY_END_ASSIGNMENT_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};
  const currentSubmissionId = state.kind === 'INVALID' ? state.submissionId : submissionId;

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={currentSubmissionId} />

      <FormBanner state={state} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="دلیل پایان" error={errors.reason}>
          {(control) => (
            <select
              {...control}
              name="reason"
              defaultValue={values.reason}
              className={controlClassName}
            >
              {assignmentEndReasonOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="یادداشت" error={errors.notes}>
          {(control) => (
            <input
              {...control}
              name="notes"
              defaultValue={values.notes}
              className={controlClassName}
            />
          )}
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" tone="secondary" disabled={pending}>
          {pending ? 'در حال پایان‌دادن…' : 'پایان تخصیص'}
        </Button>
      </div>
    </form>
  );
}

function FormBanner({ state }: { state: EndAssignmentFormState }) {
  if (state.kind === 'INVALID' && state.message) {
    return <Alert tone="warning">{state.message}</Alert>;
  }

  if (state.kind === 'REFUSED') {
    return (
      <Alert tone="danger">
        {state.reason === 'NO_SESSION'
          ? 'نشست شما پایان یافته است. دوباره وارد شوید و فرم را بفرستید.'
          : 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.'}
      </Alert>
    );
  }

  if (state.kind === 'FORBIDDEN') {
    return (
      <Alert tone="danger">
        اجازهٔ پایان‌دادن به این تخصیص به شما داده نشده است. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  if (state.kind === 'UNCONFIRMED') {
    return <UnconfirmedWriteAlert correlationId={state.correlationId} />;
  }

  if (state.kind === 'FAILED') {
    return (
      <Alert tone="danger">
        اعمال نشد. می‌توانید دوباره بفرستید. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  return null;
}
