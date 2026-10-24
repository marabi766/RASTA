'use client';

import { useActionState, useId, type ReactNode } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { UnconfirmedWriteAlert } from '@/app/UnconfirmedWriteAlert';
import { BASELINE_FIELD, CSRF_FIELD, REPLAY_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import {
  EMPTY_WITHDRAW_NEED_FORM,
  EMPTY_NEED_FORM,
  MAX_NEED_DESCRIPTION_LENGTH,
  MAX_NEED_REASON_LENGTH,
  MAX_NEED_TITLE_LENGTH,
  MAX_NEED_UNIT_LENGTH,
  NEED_COMMAND_CONSEQUENCES,
  NEED_EXPIRED_MESSAGE,
  NEED_FORBIDDEN_MESSAGE,
  NEED_HELD_IN_PROGRESS_MESSAGE,
  NEED_HELD_MESSAGE,
  NEED_NOT_FOUND_MESSAGE,
  NEED_PENDING_CAPACITY_MESSAGE,
  NEED_PENDING_UNCHECKED_MESSAGE,
  NEED_STILL_PROCESSING_MESSAGE,
  needFailureText,
  type NeedField,
  type NeedFormValues,
  type WithdrawNeedField,
  type WithdrawNeedFormValues,
} from '@/lib/project-need-commands';
import { isSessionRefusal, SESSION_REFUSAL_MESSAGES } from '@/lib/session-refusal';

import { IDLE_ADD_NEED_FORM, type AddNeedFormState } from './need-form-state';
import {
  submitAddNeed,
  submitEditNeed,
  submitSubmitNeed,
  submitWithdrawNeed,
} from './need-actions';
import { IDLE_PROJECT_FORM, type ProjectFormState } from './project-form-state';

/**
 * The commands on a project's needs, as plain `<form>`s around server actions so
 * each works before any bundle has loaded (docs/16 § ۱۶٫۲).
 *
 * None of them names its project, its need or its version in a field. Editing,
 * submitting and withdrawing carry `baseline`, a token the page signed for this
 * command, this person and this need at the version it showed
 * (`sealNeedBaseline`); the action reads all of that from it, and the form's own
 * fields are only what a person types. Adding carries the submission id minted for
 * the form and the signed stamp that says until when it may be sent
 * (`server/replay-stamp.ts`).
 */

export interface NeedFormIdentity {
  readonly projectId: string;
  readonly needId: string;
  readonly csrfToken: string;
  /** Minted for this render and bound to this session. */
  readonly submissionId: string;
  /** Signed for this command, this need and this person. */
  readonly baseline: string;
}

function Hidden({
  csrfToken,
  submissionId,
  baseline,
}: Pick<NeedFormIdentity, 'csrfToken' | 'submissionId' | 'baseline'>): ReactNode {
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

/** What every need form says for an outcome that is not a success and not a field's own. */
function NeedBanner({ state }: { state: ProjectFormState<unknown, string> }) {
  switch (state.kind) {
    case 'INVALID':
      return state.message ? <Alert tone="warning">{state.message}</Alert> : null;
    case 'REFUSED':
      return (
        <Alert tone="danger">
          {isSessionRefusal(state.reason)
            ? SESSION_REFUSAL_MESSAGES[state.reason]
            : state.reason === 'BASELINE'
              ? 'این فرم منقضی شده است یا با صفحه نمایش‌داده‌شده نمی‌خواند. صفحه را تازه کنید و دوباره تلاش کنید.'
              : 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.'}
        </Alert>
      );
    case 'FORBIDDEN':
      return (
        <Alert tone="danger">
          {NEED_FORBIDDEN_MESSAGE} کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'NOT_FOUND':
      return (
        <Alert tone="danger">
          {NEED_NOT_FOUND_MESSAGE} کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'UNCONFIRMED':
      return <UnconfirmedWriteAlert correlationId={state.correlationId} />;
    case 'FAILED':
      return (
        <Alert tone={state.status === 503 ? 'warning' : 'danger'}>
          {needFailureText(state.status)} کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'IDLE':
      return null;
  }
}

/**
 * Stays closed until asked for — most people open a project's page to read its
 * needs — and opens again when an attempt came back with something to read.
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
// The fields a need has
// ---------------------------------------------------------------------------

const LABELS: Record<NeedField, string> = {
  title: 'عنوان نیاز',
  description: 'شرح نیاز',
  quantity: 'مقدار',
  unit: 'واحد',
  estimatedCost: 'برآورد هزینه (ریال)',
};

function NeedFields({
  values,
  errors,
  disabled = false,
}: {
  values: NeedFormValues;
  errors: Partial<Record<NeedField, string>>;
  disabled?: boolean;
}) {
  return (
    <>
      <Field label={LABELS.title} required error={errors.title}>
        {(control) => (
          <input
            {...control}
            name="title"
            defaultValue={values.title}
            maxLength={MAX_NEED_TITLE_LENGTH}
            className={controlClassName}
            disabled={disabled}
          />
        )}
      </Field>

      <Field label={LABELS.description} required error={errors.description}>
        {(control) => (
          <textarea
            {...control}
            name="description"
            rows={3}
            defaultValue={values.description}
            maxLength={MAX_NEED_DESCRIPTION_LENGTH}
            className={controlClassName}
            disabled={disabled}
          />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label={LABELS.quantity}
          error={errors.quantity}
          hint="اختیاری؛ عدد مثبت تا چهار رقم اعشار."
        >
          {(control) => (
            <input
              {...control}
              name="quantity"
              defaultValue={values.quantity}
              inputMode="decimal"
              dir="ltr"
              autoComplete="off"
              className={controlClassName}
              disabled={disabled}
            />
          )}
        </Field>

        <Field label={LABELS.unit} error={errors.unit} hint="اختیاری؛ مثلا متر مکعب.">
          {(control) => (
            <input
              {...control}
              name="unit"
              defaultValue={values.unit}
              maxLength={MAX_NEED_UNIT_LENGTH}
              autoComplete="off"
              className={controlClassName}
              disabled={disabled}
            />
          )}
        </Field>

        <Field label={LABELS.estimatedCost} error={errors.estimatedCost} hint="اختیاری.">
          {(control) => (
            <input
              {...control}
              name="estimatedCost"
              defaultValue={values.estimatedCost}
              inputMode="numeric"
              dir="ltr"
              autoComplete="off"
              className={controlClassName}
              disabled={disabled}
            />
          )}
        </Field>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

function addValuesOf(state: AddNeedFormState): NeedFormValues {
  if (
    state.kind === 'INVALID' ||
    state.kind === 'HELD' ||
    state.kind === 'NOT_CHECKED' ||
    state.kind === 'CAPACITY' ||
    state.kind === 'EXPIRED'
  ) {
    return state.values;
  }
  return EMPTY_NEED_FORM;
}

export function AddNeedForm({
  projectId,
  csrfToken,
  submission,
}: {
  readonly projectId: string;
  readonly csrfToken: string;
  /**
   * Minted for this render and bound to this session and this project. It is the
   * `Idempotency-Key` of the one request this form sends, and `replay` is the signed
   * deadline after which it is not sent (`server/replay-stamp.ts`). A failed
   * attempt keeps the same pair: nothing was added, and a fixed form is the same
   * request.
   */
  readonly submission: { readonly id: string; readonly replay: string };
}) {
  const [state, action, pending] = useActionState<AddNeedFormState, FormData>(
    submitAddNeed.bind(null, projectId),
    IDLE_ADD_NEED_FORM,
  );

  const values = addValuesOf(state);
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};
  const current =
    state.kind === 'INVALID' ? { id: state.submissionId, replay: state.replay } : submission;
  // Sent and not known to have failed: the request is held and not sent again, so pressing again
  // would only be refused. The person looks at the needs first.
  const settled = state.kind === 'UNCONFIRMED' || state.kind === 'PROCESSING';

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={current.id} />
      <input type="hidden" name={REPLAY_FIELD} value={current.replay} />

      <AddBanner state={state} />
      <p className="text-sm text-content-muted">{NEED_COMMAND_CONSEQUENCES.add}</p>

      <NeedFields values={values} errors={errors} />

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button type="submit" disabled={pending || state.kind === 'EXPIRED' || settled}>
          {pending ? 'در حال ثبت…' : 'افزودن نیاز'}
        </Button>
      </div>
    </form>
  );
}

function AddBanner({ state }: { state: AddNeedFormState }) {
  switch (state.kind) {
    case 'IDLE':
      return null;
    case 'PROCESSING':
      return (
        <Alert tone="info">
          {NEED_STILL_PROCESSING_MESSAGE} کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'EXPIRED':
      return <Alert tone="warning">{NEED_EXPIRED_MESSAGE}</Alert>;
    case 'HELD':
      return (
        <Alert tone="warning">
          {state.reason === 'IN_PROGRESS' ? NEED_HELD_IN_PROGRESS_MESSAGE : NEED_HELD_MESSAGE}
        </Alert>
      );
    case 'NOT_CHECKED':
      return <Alert tone="warning">{NEED_PENDING_UNCHECKED_MESSAGE}</Alert>;
    case 'CAPACITY':
      return <Alert tone="warning">{NEED_PENDING_CAPACITY_MESSAGE}</Alert>;
    case 'INVALID':
    case 'REFUSED':
    case 'FORBIDDEN':
    case 'NOT_FOUND':
    case 'UNCONFIRMED':
    case 'FAILED':
      return <NeedBanner state={state} />;
  }
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export function EditNeedForm({
  initialValues,
  needTitle,
  ...identity
}: NeedFormIdentity & {
  /** The need's current record, as form text. */
  readonly initialValues: NeedFormValues;
  readonly needTitle: string;
}) {
  const [state, action, pending] = useActionState<
    ProjectFormState<NeedFormValues, NeedField>,
    FormData
  >(submitEditNeed.bind(null, identity.projectId, identity.needId), IDLE_PROJECT_FORM);

  const values = state.kind === 'INVALID' ? state.values : initialValues;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};

  return (
    <Disclosure summary={`ویرایش «${needTitle}»`} open={state.kind !== 'IDLE'}>
      <form action={action} className="flex flex-col gap-4">
        <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
        <NeedBanner state={state} />
        <p className="text-sm text-content-muted">{NEED_COMMAND_CONSEQUENCES.edit}</p>
        <NeedFields values={values} errors={errors} />
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Button type="submit" tone="secondary" disabled={pending}>
            {pending ? 'در حال ذخیره…' : 'ذخیره نیاز'}
          </Button>
        </div>
      </form>
    </Disclosure>
  );
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

export function SubmitNeedForm({
  needTitle,
  ...identity
}: NeedFormIdentity & { needTitle: string }) {
  const [state, action, pending] = useActionState<
    ProjectFormState<Readonly<Record<string, never>>, never>,
    FormData
  >(submitSubmitNeed.bind(null, identity.projectId, identity.needId), IDLE_PROJECT_FORM);
  const hintId = useId();

  return (
    <form action={action} className="flex flex-col gap-3">
      <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
      <NeedBanner state={state} />
      <p id={hintId} className="text-sm text-content-muted">
        نیاز پس از ارسال ویرایش نمی‌شود؛ فقط پس گرفته می‌شود.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending} aria-describedby={hintId}>
          {pending ? 'در حال ارسال…' : `ارسال «${needTitle}»`}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Withdraw
// ---------------------------------------------------------------------------

export function WithdrawNeedForm({
  needTitle,
  ...identity
}: NeedFormIdentity & { readonly needTitle: string }) {
  const [state, action, pending] = useActionState<
    ProjectFormState<WithdrawNeedFormValues, WithdrawNeedField>,
    FormData
  >(submitWithdrawNeed.bind(null, identity.projectId, identity.needId), IDLE_PROJECT_FORM);

  const values = state.kind === 'INVALID' ? state.values : EMPTY_WITHDRAW_NEED_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};

  return (
    <Disclosure summary={`پس‌گرفتن «${needTitle}»`} open={state.kind !== 'IDLE'}>
      <form action={action} className="flex flex-col gap-4">
        <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
        <NeedBanner state={state} />
        <p className="text-sm text-content-muted">{NEED_COMMAND_CONSEQUENCES.withdraw}</p>
        <Field
          label="دلیل پس‌گرفتن"
          required
          error={errors.reason}
          hint="دست‌کم ۸ نویسه؛ در پرونده پروژه می‌ماند."
        >
          {(control) => (
            <textarea
              {...control}
              name="reason"
              rows={2}
              defaultValue={values.reason}
              maxLength={MAX_NEED_REASON_LENGTH}
              className={controlClassName}
            />
          )}
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" tone="secondary" disabled={pending}>
            {pending ? 'در حال ثبت…' : 'پس‌گرفتن نیاز'}
          </Button>
        </div>
      </form>
    </Disclosure>
  );
}
