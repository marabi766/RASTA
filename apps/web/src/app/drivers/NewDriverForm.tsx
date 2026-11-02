'use client';

import { useActionState } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { withoutBidiControls } from '@/lib/format';
import { UnconfirmedWriteAlert } from '@/app/UnconfirmedWriteAlert';
import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import {
  EMPTY_CREATE_DRIVER_FORM,
  type CreateDriverField,
  type CreateDriverFormValues,
  type DriverPicker,
  type DriverPickerOption,
} from '@/lib/driver-fields';
import { isSessionRefusal, SESSION_REFUSAL_MESSAGES } from '@/lib/session-refusal';

import { submitCreateDriver } from './actions';
import { IDLE_CREATE_DRIVER_FORM, type CreateDriverFormState } from './form-state';

/**
 * The driver registration form (ثبت راننده) — the same shape as `UsageForm`,
 * the portal's first write. A plain `<form>` around a server action, so it
 * works before any bundle has loaded (docs/16 § ۱۶٫۲).
 */

const LABELS: Record<CreateDriverField, string> = {
  userId: 'شناسهٔ کاربر',
  employeeNo: 'شمارهٔ پرسنلی',
  licenceNumber: 'شمارهٔ گواهینامه',
  licenceClass: 'پایهٔ گواهینامه',
  licenceValidTo: 'اعتبار گواهینامه تا',
  notes: 'یادداشت',
};

function valuesOf(state: CreateDriverFormState): CreateDriverFormValues {
  return state.kind === 'INVALID' ? state.values : EMPTY_CREATE_DRIVER_FORM;
}

function errorsOf(state: CreateDriverFormState): Partial<Record<CreateDriverField, string>> {
  return state.kind === 'INVALID' ? state.fieldErrors : {};
}

/** What the picker says for one member: their name, then their username. */
export function pickerLabel(option: DriverPickerOption): string {
  return `${withoutBidiControls(option.name)} — ${withoutBidiControls(option.username)}`;
}

const ID_HINTS: Record<Extract<DriverPicker, { kind: 'ID' }>['reason'], string> = {
  NOT_ALLOWED: 'شناسه کاربری عضو این سازمان، مانند USR_01J… را از مدیر سازمان بگیرید.',
  INCOMPLETE:
    'فهرست اعضای این سازمان بلندتر از آن است که اینجا کامل نشان داده شود؛ شناسه کاربر را وارد کنید.',
  UNAVAILABLE: 'فهرست اعضای این سازمان اکنون خوانده نشد؛ شناسه کاربر را وارد کنید.',
};

export function NewDriverForm({
  csrfToken,
  submissionId,
  picker,
}: {
  csrfToken: string;
  /** Minted for this render; reused on a retry so a retry is not a second record. */
  submissionId: string;
  /** Who may be picked, or the id field (`server/driver-roster.ts`). */
  picker: DriverPicker;
}) {
  const [state, action, pending] = useActionState(submitCreateDriver, IDLE_CREATE_DRIVER_FORM);

  const values = valuesOf(state);
  const errors = errorsOf(state);
  const currentSubmissionId = state.kind === 'INVALID' ? state.submissionId : submissionId;

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={currentSubmissionId} />

      <FormBanner state={state} />

      {picker.kind === 'PICK' ? (
        <Field
          label="عضو سازمان"
          required
          error={errors.userId}
          hint="تنها اعضای این سازمان که هنوز راننده نیستند."
        >
          {(control) => (
            <select
              // Keyed by its default: a select reads `defaultValue` only at
              // mount, and a refused attempt must not lose the member picked
              // (docs/16 § ۱۶٫۱, `select-reset.spec.tsx`).
              key={values.userId}
              {...control}
              name="userId"
              defaultValue={values.userId}
              className={controlClassName}
            >
              <option value="">یک عضو را برگزینید</option>
              {picker.candidates.map((option) => (
                <option key={option.userId} value={option.userId}>
                  {pickerLabel(option)}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : (
        <Field label={LABELS.userId} required error={errors.userId} hint={ID_HINTS[picker.reason]}>
          {(control) => (
            <input
              {...control}
              name="userId"
              defaultValue={values.userId}
              dir="ltr"
              autoComplete="off"
              className={controlClassName}
            />
          )}
        </Field>
      )}

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
        <Button type="submit" disabled={pending}>
          {pending ? 'در حال ثبت…' : 'ثبت راننده'}
        </Button>
      </div>
    </form>
  );
}

function FormBanner({ state }: { state: CreateDriverFormState }) {
  if (state.kind === 'INVALID' && state.message) {
    return <Alert tone="warning">{state.message}</Alert>;
  }

  if (state.kind === 'REFUSED') {
    return (
      <Alert tone="danger">
        {isSessionRefusal(state.reason)
          ? SESSION_REFUSAL_MESSAGES[state.reason]
          : 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.'}
      </Alert>
    );
  }

  if (state.kind === 'FORBIDDEN') {
    return (
      <Alert tone="danger">
        اجازهٔ ثبت راننده به شما داده نشده است. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  if (state.kind === 'UNCONFIRMED') {
    return <UnconfirmedWriteAlert correlationId={state.correlationId} />;
  }

  if (state.kind === 'FAILED') {
    return (
      <Alert tone="danger">
        ثبت انجام نشد و چیزی ذخیره نشد. می‌توانید دوباره بفرستید. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  return null;
}
