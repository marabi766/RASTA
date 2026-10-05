'use client';

import { useActionState, type ReactNode } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { UnconfirmedWriteAlert } from '@/app/UnconfirmedWriteAlert';
import { BASELINE_FIELD, CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import {
  EMPTY_RECORD_INSPECTION_FORM,
  EMPTY_RECORD_POLICY_FORM,
  POLICY_COVERAGES,
  type RecordInspectionField,
  type RecordInspectionFormValues,
  type RecordPolicyField,
  type RecordPolicyFormValues,
} from '@/lib/asset-record-fields';
import { INSPECTION_RESULTS } from '@/lib/asset-fields';
import { inspectionResultLabel, policyCoverageLabel } from '@/lib/labels';

import { IDLE_RECORD_FORM, type RecordFormState } from './record-form-state';
import { submitRecordInspection, submitRecordPolicy } from './record-actions';

/**
 * The two record commands on a machine's page, as plain `<form>`s around server
 * actions so each works before any bundle has loaded (docs/16 § ۱۶٫۲).
 *
 * Neither names its asset in a field: the action is bound to the page's asset
 * (`action.bind(null, assetId)`), the signed baseline beside it names the same
 * asset and form, and what a person types is only the record.
 *
 * Each carries the submission id minted for it and keeps it across an attempt
 * that came back with something to read. asset-service stores the answer under
 * it, so what makes a second press — or a send after an unconfirmed one —
 * harmless is that the same id replays the first answer and records nothing.
 */

export interface RecordIdentity {
  /** The page's asset, which the action is bound to. */
  readonly assetId: string;
  readonly csrfToken: string;
  /** Minted for this render and bound to this session. */
  readonly submissionId: string;
  /** The asset and the form, signed for this session (`sealAssetRecordBaseline`). */
  readonly baseline: string;
}

function Hidden({ csrfToken, submissionId, baseline }: Omit<RecordIdentity, 'assetId'>): ReactNode {
  return (
    <>
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={submissionId} />
      <input type="hidden" name={BASELINE_FIELD} value={baseline} />
    </>
  );
}

/** A retry of the same form carries the same reference. */
function submissionOf(state: { kind: string; submissionId?: string }, minted: string): string {
  return state.kind === 'INVALID' && state.submissionId ? state.submissionId : minted;
}

function Banner({
  state,
  forbidden,
}: {
  state: RecordFormState<unknown, string>;
  forbidden: string;
}) {
  switch (state.kind) {
    case 'INVALID':
      return state.message ? <Alert tone="warning">{state.message}</Alert> : null;
    case 'REFUSED':
      return (
        <Alert tone="danger">
          {state.reason === 'NO_SESSION'
            ? 'نشست شما پایان یافته است. دوباره وارد شوید و فرم را بفرستید.'
            : 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.'}
        </Alert>
      );
    case 'FORBIDDEN':
      return (
        <Alert tone="danger">
          {forbidden} کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'NOT_FOUND':
      // The platform answers "no such machine" and "somebody else's" the same way.
      return (
        <Alert tone="danger">
          این دارایی پیدا نشد یا در سازمان فعال شما نیست. کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'UNCONFIRMED':
      return <UnconfirmedWriteAlert correlationId={state.correlationId} />;
    case 'FAILED':
      return (
        <Alert tone="danger">
          انجام نشد و چیزی ثبت نشد. می‌توانید دوباره بفرستید. کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'IDLE':
      return null;
  }
}

/**
 * Stays closed until asked for, and opens again when an attempt came back with
 * something to read.
 */
function Disclosure({
  summary,
  open,
  children,
}: {
  summary: string;
  open: boolean;
  children: ReactNode;
}) {
  return (
    <details open={open ? true : undefined}>
      <summary className="cursor-pointer text-content underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
        {summary}
      </summary>
      <div className="mt-4">{children}</div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Record a policy
// ---------------------------------------------------------------------------

export function RecordPolicyForm(identity: RecordIdentity) {
  const [state, action, pending] = useActionState<
    RecordFormState<RecordPolicyFormValues, RecordPolicyField>,
    FormData
  >(submitRecordPolicy.bind(null, identity.assetId), IDLE_RECORD_FORM);

  const values = state.kind === 'INVALID' ? state.values : EMPTY_RECORD_POLICY_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};

  return (
    <Disclosure summary="ثبت بیمه‌نامه…" open={state.kind !== 'IDLE'}>
      <form action={action} className="flex flex-col gap-4" aria-label="ثبت بیمه‌نامه">
        <Hidden
          csrfToken={identity.csrfToken}
          submissionId={submissionOf(state, identity.submissionId)}
          baseline={identity.baseline}
        />
        <Banner state={state} forbidden="اجازهٔ ثبت بیمه‌نامه به شما داده نشده است." />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="شمارهٔ بیمه‌نامه" required error={errors.policyNumber}>
            {(control) => (
              <input
                {...control}
                name="policyNumber"
                type="text"
                dir="ltr"
                defaultValue={values.policyNumber}
                maxLength={64}
                autoComplete="off"
                className={controlClassName}
              />
            )}
          </Field>
          <Field label="شرکت بیمه" required error={errors.insurerName}>
            {(control) => (
              <input
                {...control}
                name="insurerName"
                type="text"
                defaultValue={values.insurerName}
                maxLength={200}
                autoComplete="off"
                className={controlClassName}
              />
            )}
          </Field>
          <Field label="نوع پوشش" required error={errors.coverage}>
            {(control) => (
              <select
                // Keyed by its default: a select reads `defaultValue` only at mount (docs/16 § ۱۶٫۱).
                key={values.coverage}
                {...control}
                name="coverage"
                defaultValue={values.coverage}
                className={controlClassName}
              >
                <option value="">انتخاب کنید…</option>
                {POLICY_COVERAGES.map((coverage) => (
                  <option key={coverage} value={coverage}>
                    {policyCoverageLabel(coverage)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="hidden sm:block" aria-hidden="true" />
          <Field label="تاریخ شروع" required error={errors.validFrom} hint="از آغاز همین روز.">
            {(control) => (
              <input
                {...control}
                name="validFrom"
                type="date"
                defaultValue={values.validFrom}
                className={controlClassName}
              />
            )}
          </Field>
          <Field
            label="تاریخ پایان"
            required
            error={errors.validTo}
            hint="بیمه‌نامه از آغاز این روز دیگر معتبر شمرده نمی‌شود."
          >
            {(control) => (
              <input
                {...control}
                name="validTo"
                type="date"
                defaultValue={values.validTo}
                className={controlClassName}
              />
            )}
          </Field>
          <Field label="حق بیمه (ریال)" error={errors.premium} hint="اختیاری.">
            {(control) => (
              <input
                {...control}
                name="premium"
                type="text"
                inputMode="numeric"
                dir="ltr"
                defaultValue={values.premium}
                autoComplete="off"
                className={controlClassName}
              />
            )}
          </Field>
          <Field label="سرمایهٔ بیمه (ریال)" error={errors.insuredValue} hint="اختیاری.">
            {(control) => (
              <input
                {...control}
                name="insuredValue"
                type="text"
                inputMode="numeric"
                dir="ltr"
                defaultValue={values.insuredValue}
                autoComplete="off"
                className={controlClassName}
              />
            )}
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? 'در حال ثبت…' : 'ثبت بیمه‌نامه'}
          </Button>
        </div>
      </form>
    </Disclosure>
  );
}

// ---------------------------------------------------------------------------
// Record an inspection
// ---------------------------------------------------------------------------

export function RecordInspectionForm(identity: RecordIdentity) {
  const [state, action, pending] = useActionState<
    RecordFormState<RecordInspectionFormValues, RecordInspectionField>,
    FormData
  >(submitRecordInspection.bind(null, identity.assetId), IDLE_RECORD_FORM);

  const values = state.kind === 'INVALID' ? state.values : EMPTY_RECORD_INSPECTION_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};

  return (
    <Disclosure summary="ثبت معاینهٔ فنی…" open={state.kind !== 'IDLE'}>
      <form action={action} className="flex flex-col gap-4" aria-label="ثبت معاینهٔ فنی">
        <Hidden
          csrfToken={identity.csrfToken}
          submissionId={submissionOf(state, identity.submissionId)}
          baseline={identity.baseline}
        />
        <Banner state={state} forbidden="اجازهٔ ثبت معاینهٔ فنی به شما داده نشده است." />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="شمارهٔ گواهی" required error={errors.certificateNo}>
            {(control) => (
              <input
                {...control}
                name="certificateNo"
                type="text"
                dir="ltr"
                defaultValue={values.certificateNo}
                maxLength={64}
                autoComplete="off"
                className={controlClassName}
              />
            )}
          </Field>
          <Field label="مرکز معاینه" error={errors.centerName} hint="اختیاری.">
            {(control) => (
              <input
                {...control}
                name="centerName"
                type="text"
                defaultValue={values.centerName}
                maxLength={200}
                autoComplete="off"
                className={controlClassName}
              />
            )}
          </Field>
          <Field label="نتیجهٔ معاینه" required error={errors.result}>
            {(control) => (
              <select
                // Keyed by its default: a select reads `defaultValue` only at mount (docs/16 § ۱۶٫۱).
                key={values.result}
                {...control}
                name="result"
                defaultValue={values.result}
                className={controlClassName}
              >
                <option value="">انتخاب کنید…</option>
                {INSPECTION_RESULTS.map((result) => (
                  <option key={result} value={result}>
                    {inspectionResultLabel(result)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="hidden sm:block" aria-hidden="true" />
          <Field label="تاریخ معاینه" required error={errors.inspectedAt}>
            {(control) => (
              <input
                {...control}
                name="inspectedAt"
                type="date"
                defaultValue={values.inspectedAt}
                className={controlClassName}
              />
            )}
          </Field>
          <Field
            label="تاریخ پایان اعتبار"
            required
            error={errors.validTo}
            hint="موعد معاینهٔ بعدی؛ گواهی از آغاز این روز دیگر معتبر شمرده نمی‌شود."
          >
            {(control) => (
              <input
                {...control}
                name="validTo"
                type="date"
                defaultValue={values.validTo}
                className={controlClassName}
              />
            )}
          </Field>
        </div>

        <Field label="یادداشت" error={errors.notes} hint="اختیاری؛ حداکثر ۱۰۰۰ نویسه.">
          {(control) => (
            <textarea
              {...control}
              name="notes"
              rows={2}
              defaultValue={values.notes}
              maxLength={1000}
              className={controlClassName}
            />
          )}
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? 'در حال ثبت…' : 'ثبت معاینهٔ فنی'}
          </Button>
        </div>
      </form>
    </Disclosure>
  );
}
