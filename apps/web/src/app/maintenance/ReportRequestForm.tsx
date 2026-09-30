'use client';

import { useActionState } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { UnconfirmedWriteAlert } from '@/app/UnconfirmedWriteAlert';
import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { maintenanceTypeOptions, severityOptions } from '@/lib/labels';
import {
  EMPTY_REPORT_REQUEST_FORM,
  type ReportRequestField,
  type ReportRequestFormValues,
} from '@/lib/maintenance-fields';

import { submitReportRequest } from './actions';
import { IDLE_REPORT_REQUEST_FORM, type ReportRequestFormState } from './form-state';

/**
 * The report form (ثبت درخواست) — a breakdown somebody is standing next to, or
 * planned work somebody noticed. A plain `<form>` around a server action, so
 * it works before any bundle has loaded (docs/16 § ۱۶٫۲).
 *
 * `severity` is always offered and only required for a breakdown, because the
 * choice of type and the choice of severity are made in one sitting and a
 * field that appears after the first is a field a screen reader user finds
 * late. The service's two rules about it are worded in the field's own error.
 */

const LABELS: Record<ReportRequestField, string> = {
  assetId: 'شناسهٔ ماشین',
  type: 'نوع کار',
  title: 'عنوان',
  description: 'شرح',
  severity: 'شدت خرابی',
  outOfServiceAt: 'روزی که ماشین از کار افتاد',
  dueDate: 'مهلت انجام',
};

function valuesOf(state: ReportRequestFormState, initialAssetId: string): ReportRequestFormValues {
  if (state.kind === 'INVALID' || state.kind === 'NOT_FOUND') return state.values;
  return { ...EMPTY_REPORT_REQUEST_FORM, assetId: initialAssetId };
}

function errorsOf(state: ReportRequestFormState): Partial<Record<ReportRequestField, string>> {
  if (state.kind === 'INVALID') return state.fieldErrors;
  // The platform answers "no such machine" and "somebody else's machine" the
  // same way, so the field says only that — never which of the two it was.
  if (state.kind === 'NOT_FOUND') return { assetId: 'این ماشین در دسترس شما نیست یا وجود ندارد' };
  return {};
}

export function ReportRequestForm({
  csrfToken,
  submissionId,
  initialAssetId = '',
}: {
  csrfToken: string;
  /**
   * Minted for this render and bound to this session. A retry of the same form
   * carries the same reference as its `Idempotency-Key`, which
   * maintenance-service honours on create since #157: the same key and body
   * answer the original 201 rather than raising the work again (see
   * `server/submission.ts`).
   */
  submissionId: string;
  /** From `?assetId=`, when the person arrived from a machine's dossier. */
  initialAssetId?: string;
}) {
  const [state, action, pending] = useActionState(submitReportRequest, IDLE_REPORT_REQUEST_FORM);

  const values = valuesOf(state, initialAssetId);
  const errors = errorsOf(state);
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
        <Field label={LABELS.type} required error={errors.type}>
          {(control) => (
            <select
              {...control}
              name="type"
              defaultValue={values.type}
              className={controlClassName}
            >
              {maintenanceTypeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field
          label={LABELS.severity}
          error={errors.severity}
          hint="برای خرابی لازم است؛ برای کار برنامه‌ای خالی بماند"
        >
          {(control) => (
            <select
              {...control}
              name="severity"
              defaultValue={values.severity}
              className={controlClassName}
            >
              <option value="">—</option>
              {severityOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>

      <Field label={LABELS.title} required error={errors.title}>
        {(control) => (
          <input
            {...control}
            name="title"
            defaultValue={values.title}
            maxLength={200}
            className={controlClassName}
          />
        )}
      </Field>

      <Field label={LABELS.description} error={errors.description}>
        {(control) => (
          <textarea
            {...control}
            name="description"
            rows={3}
            defaultValue={values.description}
            className={controlClassName}
          />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={LABELS.outOfServiceAt}
          error={errors.outOfServiceAt}
          hint="اگر پیش از گزارش از کار افتاده بود؛ زمان از کار افتادگی از همین روز حساب می‌شود"
        >
          {(control) => (
            <input
              {...control}
              type="date"
              name="outOfServiceAt"
              defaultValue={values.outOfServiceAt}
              className={controlClassName}
            />
          )}
        </Field>

        <Field label={LABELS.dueDate} error={errors.dueDate}>
          {(control) => (
            <input
              {...control}
              type="date"
              name="dueDate"
              defaultValue={values.dueDate}
              className={controlClassName}
            />
          )}
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'در حال ثبت…' : 'ثبت درخواست'}
        </Button>
      </div>
    </form>
  );
}

function FormBanner({ state }: { state: ReportRequestFormState }) {
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
        اجازهٔ ثبت درخواست نگهداری به شما داده نشده است. کد پیگیری: {state.correlationId}
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
