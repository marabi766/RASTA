'use client';

import { useActionState } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { EMPTY_ASSIGN_DRIVER_FORM, type AssignDriverField } from '@/lib/driver-fields';

import { submitAssign } from './actions';
import { IDLE_ASSIGN_FORM, type AssignFormState } from './form-state';

/**
 * Putting this driver in charge of a machine — shown only when the driver
 * holds no active assignment (`DriverDetailScreen` decides that; this
 * component only renders the form).
 *
 * `assetId` is free text with a hint, the same choice `UsageForm` makes for
 * the same reason: there is no machine picker in this portal yet, and asking
 * for the id directly is honest about that rather than pretending otherwise.
 */

const LABELS: Record<AssignDriverField, string> = {
  assetId: 'شناسهٔ ماشین',
  startedAt: 'آغاز تخصیص',
  purpose: 'هدف',
};

export function AssignDriverForm({
  driverId,
  csrfToken,
  submissionId,
}: {
  driverId: string;
  csrfToken: string;
  submissionId: string;
}) {
  const [state, action, pending] = useActionState(
    submitAssign.bind(null, driverId),
    IDLE_ASSIGN_FORM,
  );

  const values =
    state.kind === 'INVALID' || state.kind === 'NOT_FOUND'
      ? state.values
      : EMPTY_ASSIGN_DRIVER_FORM;
  const errors =
    state.kind === 'INVALID'
      ? state.fieldErrors
      : state.kind === 'NOT_FOUND'
        ? { assetId: 'این ماشین در دسترس شما نیست یا وجود ندارد' }
        : {};
  const currentSubmissionId =
    state.kind === 'INVALID' || state.kind === 'NOT_FOUND' ? state.submissionId : submissionId;

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={currentSubmissionId} />

      <FormBanner state={state} />

      <Field label={LABELS.assetId} required error={errors.assetId} hint="مانند AST_01J…">
        {(control) => (
          <input
            {...control}
            name="assetId"
            defaultValue={values.assetId}
            dir="ltr"
            autoComplete="off"
            className={controlClassName}
          />
        )}
      </Field>

      <Field label={LABELS.startedAt} error={errors.startedAt} hint="خالی بگذارید برای همین لحظه">
        {(control) => (
          <input
            {...control}
            type="datetime-local"
            name="startedAt"
            defaultValue={values.startedAt}
            className={controlClassName}
          />
        )}
      </Field>

      <Field label={LABELS.purpose} error={errors.purpose}>
        {(control) => (
          <input
            {...control}
            name="purpose"
            defaultValue={values.purpose}
            className={controlClassName}
          />
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'در حال تخصیص…' : 'تخصیص به این ماشین'}
        </Button>
      </div>
    </form>
  );
}

function FormBanner({ state }: { state: AssignFormState }) {
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
        اجازهٔ تخصیص برای این راننده به شما داده نشده است. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  if (state.kind === 'FAILED') {
    return (
      <Alert tone="danger">
        تخصیص انجام نشد. می‌توانید دوباره بفرستید. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  return null;
}
