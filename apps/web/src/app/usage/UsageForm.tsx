'use client';

import { useActionState } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { UnconfirmedWriteAlert } from '@/app/UnconfirmedWriteAlert';
import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { EMPTY_USAGE_FORM, type UsageField, type UsageFormValues } from '@/lib/usage-fields';

import { submitUsage } from './actions';
import { IDLE_USAGE_FORM, type UsageFormState } from './form-state';

/**
 * The usage form (ثبت کارکرد).
 *
 * A plain `<form action={...}>` around a server action. With JavaScript it
 * posts without a navigation and re-renders in place; without it, the browser
 * submits normally and the same server action runs — which is why the CSRF
 * token and the submission id are hidden **inputs** rather than values a
 * script attaches. A control that only works once a bundle has loaded is a
 * control a person on a slow rural connection does not have (docs/16 § ۱۶٫۲).
 *
 * Everything the form needs to be trusted comes from the server: the CSRF
 * token out of the sealed session, the submission id minted for this render.
 * Neither is secret to the person; both are meaningless to another origin.
 */

const LABELS: Record<UsageField, string> = {
  assetId: 'شناسهٔ ماشین',
  periodStart: 'شروع بازه',
  periodEnd: 'پایان بازه',
  hours: 'ساعت کارکرد',
  kilometres: 'کیلومتر',
  hourMeter: 'عدد ساعت‌شمار',
  odometer: 'عدد کیلومترشمار',
  notes: 'یادداشت',
};

function valuesOf(state: UsageFormState): UsageFormValues {
  return state.kind === 'INVALID' || state.kind === 'NOT_FOUND' ? state.values : EMPTY_USAGE_FORM;
}

function errorsOf(state: UsageFormState): Partial<Record<UsageField, string>> {
  if (state.kind === 'INVALID') return state.fieldErrors;
  // The service answered "absent" for the machine. That is about one field,
  // and saying so there is more use than a banner about the whole form.
  if (state.kind === 'NOT_FOUND') {
    return { assetId: 'این ماشین در دسترس شما نیست یا وجود ندارد' };
  }
  return {};
}

export function UsageForm({
  csrfToken,
  submissionId,
}: {
  csrfToken: string;
  /** Minted for this render; reused on a retry so a retry is not a second record. */
  submissionId: string;
}) {
  const [state, action, pending] = useActionState(submitUsage, IDLE_USAGE_FORM);

  const values = valuesOf(state);
  const errors = errorsOf(state);
  // A retry keeps the id the failed attempt carried; only a fresh page mints
  // a new one. Without this a double-submit after a validation error would
  // reach the service as two different submissions.
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

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={LABELS.periodStart} required error={errors.periodStart}>
          {(control) => (
            <input
              {...control}
              type="datetime-local"
              name="periodStart"
              defaultValue={values.periodStart}
              className={controlClassName}
            />
          )}
        </Field>

        <Field label={LABELS.periodEnd} required error={errors.periodEnd}>
          {(control) => (
            <input
              {...control}
              type="datetime-local"
              name="periodEnd"
              defaultValue={values.periodEnd}
              className={controlClassName}
            />
          )}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={LABELS.hours}
          error={errors.hours}
          hint="دست‌کم یکی از ساعت کارکرد یا کیلومتر لازم است"
        >
          {(control) => (
            <input
              {...control}
              // `text` with `inputMode`, not `type="number"`: a number input
              // rejects Persian digits outright and silently empties itself,
              // so a value typed on a Persian keyboard would vanish instead
              // of being normalised.
              inputMode="decimal"
              name="hours"
              defaultValue={values.hours}
              dir="ltr"
              className={controlClassName}
            />
          )}
        </Field>

        <Field label={LABELS.kilometres} error={errors.kilometres}>
          {(control) => (
            <input
              {...control}
              inputMode="decimal"
              name="kilometres"
              defaultValue={values.kilometres}
              dir="ltr"
              className={controlClassName}
            />
          )}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={LABELS.hourMeter} error={errors.hourMeter} hint="عدد روی دستگاه، اختیاری">
          {(control) => (
            <input
              {...control}
              inputMode="decimal"
              name="hourMeter"
              defaultValue={values.hourMeter}
              dir="ltr"
              className={controlClassName}
            />
          )}
        </Field>

        <Field label={LABELS.odometer} error={errors.odometer}>
          {(control) => (
            <input
              {...control}
              inputMode="decimal"
              name="odometer"
              defaultValue={values.odometer}
              dir="ltr"
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
          {pending ? 'در حال ثبت…' : 'ثبت کارکرد'}
        </Button>
      </div>
    </form>
  );
}

/**
 * What went wrong at the level of the whole form.
 *
 * Field problems are rendered on their fields; this is for the rest — a
 * business rule the service stated without naming a field, a refusal, an
 * outage. Each keeps its own words, and the outage keeps its correlation id
 * so support can find the request (docs/16 § ۱۶٫۱۱).
 */
function FormBanner({ state }: { state: UsageFormState }) {
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
        اجازهٔ ثبت کارکرد برای این ماشین به شما داده نشده است. کد پیگیری: {state.correlationId}
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
