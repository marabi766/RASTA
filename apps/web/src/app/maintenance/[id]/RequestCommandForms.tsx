'use client';

import { useActionState } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { UnconfirmedWriteAlert } from '@/app/UnconfirmedWriteAlert';
import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { formatMoney } from '@/lib/format';
import {
  EMPTY_ASSIGN_WORKSHOP_FORM,
  EMPTY_CANCEL_REQUEST_FORM,
  type ApproveRequestField,
  type ApproveRequestFormValues,
  type AssignWorkshopField,
  type AssignWorkshopFormValues,
  type CancelRequestField,
  type CancelRequestFormValues,
} from '@/lib/maintenance-fields';

import { submitApproveRequest, submitAssignWorkshop, submitCancelRequest } from './actions';
import { IDLE_COMMAND_FORM, type RequestCommandFormState } from './form-state';

/**
 * The three commands a manager has on a request: refer it to a workshop,
 * approve what it cost, abandon it. Plain `<form>`s around server actions, so
 * each works before any bundle has loaded (docs/16 § ۱۶٫۲).
 *
 * None of them says what the service will do with a repeated post. The
 * submission id is a reference (`server/submission.ts`); maintenance-service
 * does not dedupe on it, so the honest answer to a write that may or may not
 * have landed is `UnconfirmedWriteAlert`, which tells the person to look at the
 * request before trying again.
 */

interface Identity {
  readonly csrfToken: string;
  /** Minted for this render and bound to this session. */
  readonly submissionId: string;
  readonly requestId: string;
}

function Hidden({ csrfToken, submissionId, requestId }: Identity) {
  return (
    <>
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={submissionId} />
      <input type="hidden" name="requestId" value={requestId} />
    </>
  );
}

/** A retry of the same form carries the same reference. */
function submissionOf(state: { kind: string; submissionId?: string }, minted: string): string {
  return state.kind === 'INVALID' && state.submissionId ? state.submissionId : minted;
}

// ---------------------------------------------------------------------------
// Refer to a workshop
// ---------------------------------------------------------------------------

export function AssignWorkshopForm(identity: Identity) {
  const [state, action, pending] = useActionState<
    RequestCommandFormState<AssignWorkshopFormValues, AssignWorkshopField>,
    FormData
  >(submitAssignWorkshop, IDLE_COMMAND_FORM);

  const values = state.kind === 'INVALID' ? state.values : EMPTY_ASSIGN_WORKSHOP_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};

  return (
    <form action={action} className="flex flex-col gap-4">
      <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
      <CommandBanner state={state} forbidden="اجازهٔ ارجاع کار به شما داده نشده است." />

      <Alert tone="info">
        صلاحیت تعمیرگاه هنوز در سامانه راستی‌آزمایی نمی‌شود؛ ارجاع را فقط به سازمانی بدهید که
        می‌شناسید.
      </Alert>

      <Field
        label="شناسهٔ سازمان تعمیرگاه"
        required
        error={errors.workshopOrganizationId}
        hint="مانند ORG_01J…"
      >
        {(control) => (
          <input
            {...control}
            name="workshopOrganizationId"
            defaultValue={values.workshopOrganizationId}
            dir="ltr"
            autoComplete="off"
            className={controlClassName}
          />
        )}
      </Field>

      <Field label="نام تعمیرگاه" error={errors.workshopName}>
        {(control) => (
          <input
            {...control}
            name="workshopName"
            defaultValue={values.workshopName}
            maxLength={200}
            className={controlClassName}
          />
        )}
      </Field>

      <Field label="شرح کار" error={errors.workSummary}>
        {(control) => (
          <textarea
            {...control}
            name="workSummary"
            rows={3}
            defaultValue={values.workSummary}
            className={controlClassName}
          />
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'در حال ارجاع…' : 'ارجاع به تعمیرگاه'}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Approve the cost
// ---------------------------------------------------------------------------

export function ApproveRequestForm({
  totalCostMinor,
  ...identity
}: Identity & {
  /** The total the screen above shows, echoed back so a moved figure is refused. */
  totalCostMinor: string;
}) {
  const [state, action, pending] = useActionState<
    RequestCommandFormState<ApproveRequestFormValues, ApproveRequestField>,
    FormData
  >(submitApproveRequest, IDLE_COMMAND_FORM);

  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};
  const notes = state.kind === 'INVALID' ? state.values.notes : '';

  return (
    <form action={action} className="flex flex-col gap-4">
      <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
      {/* What the person was shown, not something they type. */}
      <input type="hidden" name="expectedTotalCostMinor" value={totalCostMinor} />

      <CommandBanner state={state} forbidden="اجازهٔ تأیید هزینه به شما داده نشده است." />
      {errors.expectedTotalCostMinor ? (
        <Alert tone="warning">{errors.expectedTotalCostMinor}</Alert>
      ) : null}

      <p className="text-content">
        با تأیید، هزینهٔ <strong>{formatMoney(totalCostMinor)}</strong> برای تسویه مجاز می‌شود.
        تأیید نهایی است و بازگردانده نمی‌شود.
      </p>

      <Field label="یادداشت تأیید" error={errors.notes}>
        {(control) => (
          <textarea
            {...control}
            name="notes"
            rows={2}
            defaultValue={notes}
            className={controlClassName}
          />
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'در حال تأیید…' : 'تأیید هزینه'}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export function CancelRequestForm(identity: Identity) {
  const [state, action, pending] = useActionState<
    RequestCommandFormState<CancelRequestFormValues, CancelRequestField>,
    FormData
  >(submitCancelRequest, IDLE_COMMAND_FORM);

  const values = state.kind === 'INVALID' ? state.values : EMPTY_CANCEL_REQUEST_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};

  // Closed until asked for, because abandoning work is not the thing most
  // people open this page to do — and open again when an attempt came back
  // with something to read.
  return (
    <details open={state.kind !== 'IDLE' ? true : undefined}>
      <summary className="cursor-pointer text-content underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
        لغو این درخواست
      </summary>

      <form action={action} className="mt-4 flex flex-col gap-4">
        <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
        <CommandBanner state={state} forbidden="اجازهٔ لغو درخواست به شما داده نشده است." />

        <p className="text-sm text-content-muted">
          لغو، ارجاع باز به تعمیرگاه را هم می‌بندد. هزینهٔ ثبت‌شده می‌ماند، چون واقعاً انجام شده
          است. لغو نهایی است؛ برای ادامهٔ کار باید درخواست تازه‌ای ثبت کنید.
        </p>

        <Field label="دلیل لغو" required error={errors.reason}>
          {(control) => (
            <textarea
              {...control}
              name="reason"
              rows={2}
              defaultValue={values.reason}
              maxLength={500}
              className={controlClassName}
            />
          )}
        </Field>

        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Button type="submit" tone="secondary" disabled={pending}>
            {pending ? 'در حال لغو…' : 'لغو درخواست'}
          </Button>
        </div>
      </form>
    </details>
  );
}

// ---------------------------------------------------------------------------
// What every attempt can say
// ---------------------------------------------------------------------------

function CommandBanner({
  state,
  forbidden,
}: {
  state: RequestCommandFormState<unknown, string>;
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
      // The platform answers "no such request" and "somebody else's" the same way.
      return <Alert tone="danger">این درخواست پیدا نشد یا در سازمان فعال شما نیست.</Alert>;
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
