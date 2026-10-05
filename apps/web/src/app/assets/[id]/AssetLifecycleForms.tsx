'use client';

import { useActionState, useId, type ReactNode } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { UnconfirmedWriteAlert } from '@/app/UnconfirmedWriteAlert';
import { BASELINE_FIELD, CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import {
  EMPTY_CHANGE_STATUS_FORM,
  EMPTY_DECOMMISSION_FORM,
  type ActivateAssetFormValues,
  type ChangeStatusField,
  type ChangeStatusFormValues,
  type ChangeStatusTarget,
  type DecommissionField,
  type DecommissionFormValues,
} from '@/lib/asset-lifecycle-fields';
import { assetStatusLabel } from '@/lib/labels';

import { IDLE_LIFECYCLE_FORM, type LifecycleFormState } from './lifecycle-form-state';
import { submitActivateAsset, submitChangeStatus, submitDecommission } from './lifecycle-actions';

/**
 * The three lifecycle commands on a machine, as plain `<form>`s around server
 * actions so each works before any bundle has loaded (docs/16 § ۱۶٫۲).
 *
 * None of them names its asset or its version in a field. Each carries
 * `baseline`, a token the page signed for this command, this person and this
 * machine at the version and status it showed (`sealAssetLifecycleBaseline`),
 * and the action reads all of that from it; the form's own fields are only what
 * a person types.
 *
 * Each carries the submission id minted for it and keeps it across an attempt
 * that came back with something to read. asset-service does not store it for
 * these routes: what makes a second press harmless is the version in the
 * baseline, which the first press moved (`server/asset-lifecycle-commands.ts`).
 */

export interface LifecycleIdentity {
  /** The page's asset: bound to the action, and the baseline must name the same one. */
  readonly assetId: string;
  readonly csrfToken: string;
  /** Minted for this render and bound to this session. */
  readonly submissionId: string;
  /** Signed for this command, this machine and this person. */
  readonly baseline: string;
}

function Hidden({ csrfToken, submissionId, baseline }: LifecycleIdentity): ReactNode {
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

/**
 * Said for a `503` on a command that asks the owning services about open work
 * (change status, decommission): one of them did not answer, so asset-service
 * cannot say whether the machine is free — and it answers "unavailable" even
 * when the other service reported open work, because a definitive "blocked by
 * open work" from half the picture would be wrong in the other direction too
 * (docs/24 Q-94). Nothing was written.
 */
export const OPEN_WORK_CHECK_UNAVAILABLE_MESSAGE =
  'بررسی کار باز این دارایی ممکن نشد، چون یکی از سرویس‌های ناوگان یا تعمیرات موقتاً پاسخ نمی‌دهد. چیزی تغییر نکرد. کمی بعد دوباره تلاش کنید.';

function Banner({
  state,
  forbidden,
  asksOwners = false,
}: {
  state: LifecycleFormState<unknown, string>;
  forbidden: string;
  /** The command checks open work with the owning services, so a 503 means that check. */
  asksOwners?: boolean;
}) {
  switch (state.kind) {
    case 'INVALID':
      return state.message ? <Alert tone="warning">{state.message}</Alert> : null;
    case 'REFUSED':
      return (
        <Alert tone="danger">
          {state.reason === 'NO_SESSION'
            ? 'نشست شما پایان یافته است. دوباره وارد شوید و فرم را بفرستید.'
            : state.reason === 'BASELINE'
              ? 'این فرم منقضی شده است یا با صفحهٔ نمایش‌داده‌شده نمی‌خواند. صفحه را تازه کنید و دوباره تلاش کنید.'
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
      if (asksOwners && state.status === 503) {
        return (
          <Alert tone="warning">
            {OPEN_WORK_CHECK_UNAVAILABLE_MESSAGE} کد پیگیری: {state.correlationId}
          </Alert>
        );
      }
      return (
        <Alert tone="danger">
          انجام نشد و چیزی تغییر نکرد. می‌توانید دوباره بفرستید. کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'IDLE':
      return null;
  }
}

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------

export function ActivateAssetForm(identity: LifecycleIdentity) {
  const [state, action, pending] = useActionState<
    LifecycleFormState<ActivateAssetFormValues, never>,
    FormData
  >(submitActivateAsset.bind(null, identity.assetId), IDLE_LIFECYCLE_FORM);

  return (
    <form action={action} className="flex flex-col gap-4">
      <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
      <Banner state={state} forbidden="اجازهٔ فعال‌سازی دارایی به شما داده نشده است." />

      <p className="text-sm text-content-muted">
        با فعال‌سازی، دارایی به ناوگان می‌پیوندد و قابل اعزام می‌شود. این کار فقط وقتی انجام می‌شود
        که پرونده کامل باشد: بیمه‌نامهٔ معتبر و سند مالکیت یا کارت ماشین ثبت شده باشد؛ وگرنه
        می‌گوییم چه چیزی کم است.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'در حال فعال‌سازی…' : 'فعال‌سازی دارایی'}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Change status
// ---------------------------------------------------------------------------

export function ChangeStatusForm({
  currentStatus,
  targets,
  ...identity
}: LifecycleIdentity & {
  /** The status the page shows; the choices were drawn from it. */
  currentStatus: string;
  readonly targets: readonly ChangeStatusTarget[];
}) {
  const [state, action, pending] = useActionState<
    LifecycleFormState<ChangeStatusFormValues, ChangeStatusField>,
    FormData
  >(submitChangeStatus.bind(null, identity.assetId), IDLE_LIFECYCLE_FORM);

  const values = state.kind === 'INVALID' ? state.values : EMPTY_CHANGE_STATUS_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};

  return (
    <form action={action} className="flex flex-col gap-4">
      <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
      <Banner
        state={state}
        forbidden="اجازهٔ تغییر وضعیت دارایی به شما داده نشده است."
        asksOwners
      />

      <p className="text-sm text-content-muted">
        وضعیت فعلی: <strong>{assetStatusLabel(currentStatus)}</strong>. «در تخصیص» و «در تعمیر» را
        سرویس ناوگان و سرویس تعمیرات تعیین می‌کنند و از اینجا تغییر نمی‌کنند.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="وضعیت تازه" required error={errors.status}>
          {(control) => (
            <select
              // Keyed by its default: a select reads `defaultValue` only at mount (docs/16 § ۱۶٫۱).
              key={values.status}
              {...control}
              name="status"
              defaultValue={values.status}
              className={controlClassName}
            >
              <option value="">انتخاب کنید…</option>
              {targets.map((target) => (
                <option key={target} value={target}>
                  {assetStatusLabel(target)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>

      <Field
        label="دلیل تغییر"
        required
        error={errors.reason}
        hint="در پروندهٔ دارایی و تاریخچهٔ آن ثبت می‌شود."
      >
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

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" tone="secondary" disabled={pending}>
          {pending ? 'در حال ثبت…' : 'ثبت تغییر وضعیت'}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Decommission
// ---------------------------------------------------------------------------

/**
 * Stays closed until asked for — retiring a machine is not what most people open
 * its page for — and opens again when an attempt came back with something to
 * read.
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

/**
 * The tick that says the person read what decommissioning means, with the
 * machine's name in the sentence they tick. A native `required` checkbox, so
 * the browser stops an unticked post before it is sent; the action refuses it
 * again, because a script posts without a browser.
 */
function ConfirmTick({
  assetName,
  checked,
  error,
}: {
  assetName: string;
  checked: boolean;
  error: string | undefined;
}) {
  const base = useId();
  const tickId = `${base}-tick`;
  const textId = `${base}-text`;
  const errorId = `${base}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={tickId} className="flex items-start gap-2 text-sm text-content">
        <input
          id={tickId}
          aria-labelledby={textId}
          type="checkbox"
          name="confirm"
          value="yes"
          required
          defaultChecked={checked}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="mt-0.5 size-4"
        />
        <span id={textId}>می‌دانم که اسقاط «{assetName}» بازگشت‌ناپذیر است.</span>
      </label>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function DecommissionAssetForm({
  assetName,
  ...identity
}: LifecycleIdentity & {
  /** The name the page shows, which the confirmation names. */
  assetName: string;
}) {
  const [state, action, pending] = useActionState<
    LifecycleFormState<DecommissionFormValues, DecommissionField>,
    FormData
  >(submitDecommission.bind(null, identity.assetId), IDLE_LIFECYCLE_FORM);

  const values = state.kind === 'INVALID' ? state.values : EMPTY_DECOMMISSION_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};

  return (
    <Disclosure summary="اسقاط این دارایی…" open={state.kind !== 'IDLE'}>
      <form action={action} className="flex flex-col gap-4">
        <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
        <Banner state={state} forbidden="اجازهٔ اسقاط دارایی به شما داده نشده است." asksOwners />

        {/* Not an `Alert`: that is a live region and this is standing text, read
            once the person opens the form. A second `role="alert"` beside the
            banner would also announce the warning again after every attempt. */}
        <div
          role="note"
          className="flex flex-col gap-2 rounded-lg border-s-4 border-danger bg-danger-surface p-4 text-sm text-danger-text"
        >
          <p className="font-semibold">{`اسقاط «${assetName}»`}</p>
          <p className="leading-relaxed">
            اسقاط نهایی و بازگشت‌ناپذیر است. دارایی اسقاط‌شده دیگر ویرایش نمی‌شود، وضعیتش تغییر
            نمی‌کند و به راننده سپرده نمی‌شود؛ ردیف آن فقط برای سوابق مالی و حسابرسی می‌ماند. اگر
            می‌خواهید دارایی موقتاً کنار برود، به‌جای اسقاط وضعیت را «خارج از سرویس» کنید.
          </p>
        </div>

        <Field
          label="دلیل اسقاط"
          required
          error={errors.reason}
          hint="دست‌کم ۱۰ نویسه؛ در پروندهٔ دارایی و تاریخچهٔ آن ثبت می‌شود."
        >
          {(control) => (
            <textarea
              {...control}
              name="reason"
              rows={3}
              defaultValue={values.reason}
              maxLength={1000}
              className={controlClassName}
            />
          )}
        </Field>

        <ConfirmTick
          assetName={assetName}
          checked={values.confirm === 'yes'}
          error={errors.confirm}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" tone="secondary" disabled={pending}>
            {pending ? 'در حال اسقاط…' : 'اسقاط قطعی دارایی'}
          </Button>
        </div>
      </form>
    </Disclosure>
  );
}
