'use client';

import { useActionState, type ReactNode } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { UnconfirmedWriteAlert } from '@/app/UnconfirmedWriteAlert';
import { BASELINE_FIELD, CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import {
  AVAILABILITY_CHOICES,
  EMPTY_DECLARE_AVAILABILITY_FORM,
} from '@/lib/fleet-availability-fields';

import {
  IDLE_AVAILABILITY_FORM,
  type DeclareFormState,
  type RevokeFormState,
} from './availability-form-state';
import { submitDeclareAvailability, submitRevokeAvailability } from './availability-actions';
import type { RecordFormState } from './record-form-state';

/**
 * The two availability commands on a machine's page, as plain `<form>`s around
 * server actions so each works before any bundle has loaded (docs/16 § ۱۶٫۲).
 *
 * Neither names its machine or its window in a field: the action is bound to
 * them (`action.bind(null, assetId[, windowId])`), the signed baseline beside it
 * names the same ones, and what a person types is only the declaration.
 *
 * Each carries the submission id minted for it and keeps it across an attempt
 * that came back with something to read. fleet-service stores a declaration's
 * answer under it, so a second press — or a send after an unconfirmed one — is
 * the first one's response and declares nothing more.
 */

export interface AvailabilityIdentity {
  /** The page's asset, which the action is bound to. */
  readonly assetId: string;
  readonly csrfToken: string;
  /** Minted for this render and bound to this session. */
  readonly submissionId: string;
  /** The asset (and window), signed for this session (`sealAvailabilityBaseline`). */
  readonly baseline: string;
}

export interface RevokeIdentity extends AvailabilityIdentity {
  /** The declaration this control withdraws, which the action is bound to. */
  readonly windowId: string;
}

function Hidden({
  csrfToken,
  submissionId,
  baseline,
}: Omit<AvailabilityIdentity, 'assetId'>): ReactNode {
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
      // The platform answers "no such machine (or declaration)" and "somebody
      // else's" the same way.
      return (
        <Alert tone="danger">
          این دارایی یا اعلام پیدا نشد یا در سازمان فعال شما نیست. کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'UNCONFIRMED':
      return <UnconfirmedWriteAlert correlationId={state.correlationId} />;
    case 'FAILED':
      return (
        <Alert tone="danger">
          انجام نشد و چیزی تغییر نکرد. می‌توانید دوباره بفرستید. کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'IDLE':
      return null;
  }
}

/** Stays closed until asked for, and opens again when an attempt came back with something to read. */
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
// Declare
// ---------------------------------------------------------------------------

export function DeclareAvailabilityForm(identity: AvailabilityIdentity) {
  const [state, action, pending] = useActionState<DeclareFormState, FormData>(
    submitDeclareAvailability.bind(null, identity.assetId),
    IDLE_AVAILABILITY_FORM,
  );

  const values = state.kind === 'INVALID' ? state.values : EMPTY_DECLARE_AVAILABILITY_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};

  return (
    <Disclosure summary="اعلام وضعیت دارایی…" open={state.kind !== 'IDLE'}>
      <form action={action} className="flex flex-col gap-4" aria-label="اعلام وضعیت دارایی">
        <Hidden
          csrfToken={identity.csrfToken}
          submissionId={submissionOf(state, identity.submissionId)}
          baseline={identity.baseline}
        />
        <Banner state={state} forbidden="اجازهٔ اعلام وضعیت به شما داده نشده است." />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="وضعیت اعلام‌شده"
            required
            error={errors.available}
            hint="اعلام جدید جای اعلام پیشینِ همین دارایی را می‌گیرد. اعلام «قابل‌استفاده» مانعی را که سامانه اعمال کرده (بیمه، معاینه، تعمیر) برنمی‌دارد."
          >
            {(control) => (
              <select
                {...control}
                name="available"
                // Keyed by its default: React reads a select's `defaultValue`
                // once, at mount, so without this the reset that follows every
                // action returns the choice to blank (see `AssetDocumentForm`).
                key={values.available}
                defaultValue={values.available}
                className={controlClassName}
              >
                <option value="">انتخاب کنید…</option>
                {AVAILABILITY_CHOICES.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice === 'true' ? 'قابل‌استفاده' : 'غیرقابل‌استفاده'}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="دلیل" required error={errors.reason}>
            {(control) => (
              <input
                {...control}
                name="reason"
                type="text"
                defaultValue={values.reason}
                maxLength={500}
                autoComplete="off"
                className={controlClassName}
              />
            )}
          </Field>
          <Field
            label="از تاریخ"
            error={errors.fromAt}
            hint="اختیاری؛ خالی یعنی از همین اکنون. اگر بنویسید، از آغاز همان روز."
          >
            {(control) => (
              <input
                {...control}
                name="fromAt"
                type="date"
                defaultValue={values.fromAt}
                className={controlClassName}
              />
            )}
          </Field>
          <Field
            label="تا تاریخ"
            error={errors.toAt}
            hint="اختیاری؛ خالی یعنی تا زمانی که ابطال شود. اگر بنویسید، تا آغاز همان روز."
          >
            {(control) => (
              <input
                {...control}
                name="toAt"
                type="date"
                defaultValue={values.toAt}
                className={controlClassName}
              />
            )}
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? 'در حال ثبت…' : 'ثبت اعلام'}
          </Button>
        </div>
      </form>
    </Disclosure>
  );
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

/**
 * One control per declaration still in force or not yet begun. It is drawn only
 * for a declaration — never for a block the platform imposes, which is not a
 * window and has nothing to name here (`AssetAvailability`).
 */
export function RevokeAvailabilityForm(identity: RevokeIdentity) {
  const [state, action, pending] = useActionState<RevokeFormState, FormData>(
    submitRevokeAvailability.bind(null, identity.assetId, identity.windowId),
    IDLE_AVAILABILITY_FORM,
  );

  return (
    <form action={action} className="flex flex-col gap-2" aria-label="ابطال اعلام">
      <Hidden
        csrfToken={identity.csrfToken}
        submissionId={submissionOf(state, identity.submissionId)}
        baseline={identity.baseline}
      />
      <Banner state={state} forbidden="اجازهٔ ابطال اعلام به شما داده نشده است." />
      <div>
        <Button type="submit" tone="secondary" disabled={pending}>
          {pending ? 'در حال ابطال…' : 'ابطال این اعلام'}
        </Button>
      </div>
    </form>
  );
}
