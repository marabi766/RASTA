'use client';

import { useActionState } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import type { UpdateDriverField, UpdateDriverFormValues } from '@/lib/driver-fields';

import { submitUpdateDriver } from './actions';
import { IDLE_UPDATE_DRIVER_FORM, type UpdateDriverFormState } from './form-state';

/**
 * Editing a driver's record. Same shape as `UsageForm`, bound to this one
 * driver (`actions.ts`'s comment on why binding rather than a hidden field).
 *
 * Pre-filled with the driver's current values, always — this is an edit
 * form, not a blank one, so `initialValues` is required rather than falling
 * back to an empty record the way `NewDriverForm` does.
 */

const LABELS: Record<UpdateDriverField, string> = {
  employeeNo: 'شمارهٔ پرسنلی',
  licenceNumber: 'شمارهٔ گواهینامه',
  licenceClass: 'پایهٔ گواهینامه',
  licenceValidTo: 'اعتبار گواهینامه تا',
  notes: 'یادداشت',
};

function valuesOf(
  state: UpdateDriverFormState,
  initialValues: UpdateDriverFormValues,
): UpdateDriverFormValues {
  return state.kind === 'INVALID' ? state.values : initialValues;
}

function errorsOf(state: UpdateDriverFormState): Partial<Record<UpdateDriverField, string>> {
  return state.kind === 'INVALID' ? state.fieldErrors : {};
}

export function UpdateDriverForm({
  driverId,
  csrfToken,
  submissionId,
  initialValues,
}: {
  driverId: string;
  csrfToken: string;
  submissionId: string;
  initialValues: UpdateDriverFormValues;
}) {
  const [state, action, pending] = useActionState(
    submitUpdateDriver.bind(null, driverId),
    IDLE_UPDATE_DRIVER_FORM,
  );

  const values = valuesOf(state, initialValues);
  const errors = errorsOf(state);
  const currentSubmissionId = state.kind === 'INVALID' ? state.submissionId : submissionId;

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={currentSubmissionId} />

      <FormBanner state={state} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={LABELS.employeeNo} error={errors.employeeNo}>
          {(control) => (
            <input
              {...control}
              name="employeeNo"
              defaultValue={values.employeeNo}
              dir="ltr"
              className={controlClassName}
            />
          )}
        </Field>

        <Field label={LABELS.licenceNumber} error={errors.licenceNumber}>
          {(control) => (
            <input
              {...control}
              name="licenceNumber"
              defaultValue={values.licenceNumber}
              dir="ltr"
              className={controlClassName}
            />
          )}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={LABELS.licenceClass} error={errors.licenceClass}>
          {(control) => (
            <input
              {...control}
              name="licenceClass"
              defaultValue={values.licenceClass}
              dir="ltr"
              className={controlClassName}
            />
          )}
        </Field>

        <Field label={LABELS.licenceValidTo} error={errors.licenceValidTo}>
          {(control) => (
            <input
              {...control}
              type="date"
              name="licenceValidTo"
              defaultValue={values.licenceValidTo}
              className={controlClassName}
            />
          )}
        </Field>
      </div>

      <Field label={LABELS.notes} error={errors.notes}>
        {(control) => (
          <textarea
            {...control}
            name="notes"
            rows={3}
            defaultValue={values.notes}
            className={controlClassName}
          />
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button type="submit" tone="secondary" disabled={pending}>
          {pending ? 'در حال ذخیره…' : 'ذخیرهٔ تغییرات'}
        </Button>
      </div>
    </form>
  );
}

function FormBanner({ state }: { state: UpdateDriverFormState }) {
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
        اجازهٔ ویرایش این راننده به شما داده نشده است. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  if (state.kind === 'FAILED') {
    return (
      <Alert tone="danger">
        ذخیره انجام نشد و چیزی تغییر نکرد. می‌توانید دوباره بفرستید. کد پیگیری:{' '}
        {state.correlationId}
      </Alert>
    );
  }

  return null;
}
