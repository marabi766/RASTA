'use client';

import { useActionState, useId, type ReactNode } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { UnconfirmedWriteAlert } from '@/app/UnconfirmedWriteAlert';
import { BASELINE_FIELD, CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import {
  EMPTY_CANCEL_FORM,
  EMPTY_GRANT_FORM,
  EMPTY_REJECT_FORM,
  MAX_CONDITIONS_LENGTH,
  MAX_DECISION_NUMBER_LENGTH,
  MAX_LOCATION_LENGTH,
  MAX_OPERATION_TYPE_LENGTH,
  MAX_REASON_LENGTH,
  MAX_SCOPE_LENGTH,
  MAX_TITLE_LENGTH,
  PROJECT_COMMAND_CONSEQUENCES,
  PROJECT_FORBIDDEN_MESSAGE,
  PROJECT_NOT_FOUND_MESSAGE,
  projectFailureText,
  type CancelField,
  type CancelFormValues,
  type GrantField,
  type GrantFormValues,
  type NoFormValues,
  type ProjectField,
  type ProjectFormValues,
  type RejectField,
  type RejectFormValues,
} from '@/lib/project-commands';
import { isSessionRefusal, SESSION_REFUSAL_MESSAGES } from '@/lib/session-refusal';

import { IDLE_PROJECT_FORM, type ProjectFormState } from './project-form-state';
import {
  submitCancelProject,
  submitCompleteProject,
  submitEditProject,
  submitGrantApproval,
  submitRejectApproval,
  submitRequestApproval,
  submitStartProject,
} from './project-actions';
import type { ProjectPlace } from './project-runner';

/**
 * The commands on a project and an authority's decision, as plain `<form>`s
 * around server actions so each works before any bundle has loaded
 * (docs/16 § ۱۶٫۲).
 *
 * None of them names its target or its version in a field. Each carries
 * `baseline`, a token the page signed for this command, this person and this
 * target at the version it showed (`sealProjectBaseline`), and the action reads
 * all of that from it; the form's own fields are only what a person types.
 *
 * Each carries the submission id minted for it and keeps it across an attempt
 * that came back with something to read. construction-service does not store it
 * for these routes: what makes a second press harmless is the version in the
 * baseline, which the first press moved (`server/project-commands.ts`).
 */

export interface ProjectFormIdentity {
  /** The page's project, or for a decision the approval step: bound to the action. */
  readonly targetId: string;
  /** Which page drew the form; where the person lands afterwards. */
  readonly place: ProjectPlace;
  readonly csrfToken: string;
  /** Minted for this render and bound to this session. */
  readonly submissionId: string;
  /** Signed for this command, this target and this person. */
  readonly baseline: string;
}

function Hidden({
  csrfToken,
  submissionId,
  baseline,
}: Pick<ProjectFormIdentity, 'csrfToken' | 'submissionId' | 'baseline'>): ReactNode {
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

export function ProjectBanner({ state }: { state: ProjectFormState<unknown, string> }) {
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
          {PROJECT_FORBIDDEN_MESSAGE} کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'NOT_FOUND':
      return (
        <Alert tone="danger">
          {PROJECT_NOT_FOUND_MESSAGE} کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'UNCONFIRMED':
      return <UnconfirmedWriteAlert correlationId={state.correlationId} />;
    case 'FAILED':
      return (
        <Alert tone={state.status === 503 ? 'warning' : 'danger'}>
          {projectFailureText(state.status)} کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'IDLE':
      return null;
  }
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

const EDIT_LABELS: Record<ProjectField, string> = {
  title: 'عنوان',
  operationType: 'نوع عملیات',
  locationDescription: 'محل',
  scopeOfWork: 'شرح کار',
  estimatedCost: 'برآورد هزینه (ریال)',
};

export function EditProjectForm({
  initialValues,
  ...identity
}: ProjectFormIdentity & {
  /** The project's current record, as form text. */
  readonly initialValues: ProjectFormValues;
}) {
  const [state, action, pending] = useActionState<
    ProjectFormState<ProjectFormValues, ProjectField>,
    FormData
  >(submitEditProject.bind(null, identity.targetId, identity.place), IDLE_PROJECT_FORM);

  const values = state.kind === 'INVALID' ? state.values : initialValues;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};

  return (
    <form action={action} className="flex flex-col gap-4">
      <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
      <ProjectBanner state={state} />

      <p className="text-sm text-content-muted">{PROJECT_COMMAND_CONSEQUENCES.edit}</p>

      <Field label={EDIT_LABELS.title} required error={errors.title}>
        {(control) => (
          <input
            {...control}
            name="title"
            defaultValue={values.title}
            maxLength={MAX_TITLE_LENGTH}
            className={controlClassName}
          />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={EDIT_LABELS.operationType} required error={errors.operationType}>
          {(control) => (
            <input
              {...control}
              name="operationType"
              defaultValue={values.operationType}
              maxLength={MAX_OPERATION_TYPE_LENGTH}
              className={controlClassName}
            />
          )}
        </Field>

        <Field
          label={EDIT_LABELS.estimatedCost}
          error={errors.estimatedCost}
          hint="خالی بگذارید تا برآورد پاک شود."
        >
          {(control) => (
            <input
              {...control}
              name="estimatedCost"
              defaultValue={values.estimatedCost}
              inputMode="numeric"
              dir="ltr"
              autoComplete="off"
              className={controlClassName}
            />
          )}
        </Field>
      </div>

      <Field label={EDIT_LABELS.locationDescription} required error={errors.locationDescription}>
        {(control) => (
          <input
            {...control}
            name="locationDescription"
            defaultValue={values.locationDescription}
            maxLength={MAX_LOCATION_LENGTH}
            className={controlClassName}
          />
        )}
      </Field>

      <Field label={EDIT_LABELS.scopeOfWork} required error={errors.scopeOfWork}>
        {(control) => (
          <textarea
            {...control}
            name="scopeOfWork"
            rows={5}
            defaultValue={values.scopeOfWork}
            maxLength={MAX_SCOPE_LENGTH}
            className={controlClassName}
          />
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button type="submit" tone="secondary" disabled={pending}>
          {pending ? 'در حال ذخیره…' : 'ذخیره مشخصات'}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// The commands with nothing to type
// ---------------------------------------------------------------------------

function ConfirmOnlyForm({
  identity,
  action,
  explanation,
  submitLabel,
  pendingLabel,
  extra,
}: {
  identity: ProjectFormIdentity;
  action: (
    previous: ProjectFormState<NoFormValues, never>,
    form: FormData,
  ) => Promise<ProjectFormState<NoFormValues, never>>;
  explanation: string;
  submitLabel: string;
  pendingLabel: string;
  extra?: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE_PROJECT_FORM);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
      <ProjectBanner state={state} />
      <p className="text-sm text-content-muted">{explanation}</p>
      {extra}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? pendingLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function RequestApprovalForm(identity: ProjectFormIdentity) {
  return (
    <ConfirmOnlyForm
      identity={identity}
      action={submitRequestApproval.bind(null, identity.targetId, identity.place)}
      explanation={PROJECT_COMMAND_CONSEQUENCES.requestApproval}
      submitLabel="درخواست موافقت"
      pendingLabel="در حال ثبت…"
    />
  );
}

export function StartProjectForm(identity: ProjectFormIdentity) {
  return (
    <ConfirmOnlyForm
      identity={identity}
      action={submitStartProject.bind(null, identity.targetId, identity.place)}
      explanation={PROJECT_COMMAND_CONSEQUENCES.start}
      submitLabel="شروع اجرا"
      pendingLabel="در حال شروع…"
    />
  );
}

export function CompleteProjectForm(identity: ProjectFormIdentity) {
  return (
    <ConfirmOnlyForm
      identity={identity}
      action={submitCompleteProject.bind(null, identity.targetId, identity.place)}
      explanation={PROJECT_COMMAND_CONSEQUENCES.complete}
      submitLabel="تکمیل پروژه"
      pendingLabel="در حال ثبت…"
    />
  );
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

/**
 * Stays closed until asked for — cancelling a project is not what most people
 * open its page for — and opens again when an attempt came back with something
 * to read.
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

function ConfirmTick({
  projectTitle,
  checked,
  error,
}: {
  projectTitle: string;
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
        <span id={textId}>می‌دانم که لغو «{projectTitle}» پایانی و بازگشت‌ناپذیر است.</span>
      </label>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function CancelProjectForm({
  projectTitle,
  ...identity
}: ProjectFormIdentity & { readonly projectTitle: string }) {
  const [state, action, pending] = useActionState<
    ProjectFormState<CancelFormValues, CancelField>,
    FormData
  >(submitCancelProject.bind(null, identity.targetId, identity.place), IDLE_PROJECT_FORM);

  const values = state.kind === 'INVALID' ? state.values : EMPTY_CANCEL_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};

  return (
    <Disclosure summary="لغو این پروژه…" open={state.kind !== 'IDLE'}>
      <form action={action} className="flex flex-col gap-4">
        <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
        <ProjectBanner state={state} />

        {/* Not an `Alert`: that is a live region and this is standing text, read
            once the person opens the form. */}
        <div
          role="note"
          className="flex flex-col gap-2 rounded-lg border-s-4 border-danger bg-danger-surface p-4 text-sm text-danger-text"
        >
          <p className="font-semibold">{`لغو «${projectTitle}»`}</p>
          <p className="leading-relaxed">{PROJECT_COMMAND_CONSEQUENCES.cancel}</p>
        </div>

        <Field
          label="دلیل لغو"
          required
          error={errors.reason}
          hint="دست‌کم ۸ نویسه؛ در پرونده پروژه می‌ماند."
        >
          {(control) => (
            <textarea
              {...control}
              name="reason"
              rows={3}
              defaultValue={values.reason}
              maxLength={MAX_REASON_LENGTH}
              className={controlClassName}
            />
          )}
        </Field>

        <ConfirmTick
          projectTitle={projectTitle}
          checked={values.confirm === 'yes'}
          error={errors.confirm}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" tone="secondary" disabled={pending}>
            {pending ? 'در حال لغو…' : 'لغو قطعی پروژه'}
          </Button>
        </div>
      </form>
    </Disclosure>
  );
}

// ---------------------------------------------------------------------------
// An authority's decision
// ---------------------------------------------------------------------------

export function GrantApprovalForm(identity: ProjectFormIdentity) {
  const [state, action, pending] = useActionState<
    ProjectFormState<GrantFormValues, GrantField>,
    FormData
  >(submitGrantApproval.bind(null, identity.targetId, identity.place), IDLE_PROJECT_FORM);

  const values = state.kind === 'INVALID' ? state.values : EMPTY_GRANT_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};

  return (
    <form action={action} className="flex flex-col gap-3">
      <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
      <ProjectBanner state={state} />
      <p className="text-sm text-content-muted">{PROJECT_COMMAND_CONSEQUENCES.grant}</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="شماره تصمیم"
          error={errors.decisionNumber}
          hint="شماره‌ای که مرجع خودش می‌دهد."
        >
          {(control) => (
            <input
              {...control}
              name="decisionNumber"
              defaultValue={values.decisionNumber}
              maxLength={MAX_DECISION_NUMBER_LENGTH}
              autoComplete="off"
              className={controlClassName}
            />
          )}
        </Field>
      </div>

      <Field label="شرایط موافقت" error={errors.conditions}>
        {(control) => (
          <textarea
            {...control}
            name="conditions"
            rows={2}
            defaultValue={values.conditions}
            maxLength={MAX_CONDITIONS_LENGTH}
            className={controlClassName}
          />
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'در حال ثبت…' : 'ثبت موافقت'}
        </Button>
      </div>
    </form>
  );
}

export function RejectApprovalForm(identity: ProjectFormIdentity) {
  const [state, action, pending] = useActionState<
    ProjectFormState<RejectFormValues, RejectField>,
    FormData
  >(submitRejectApproval.bind(null, identity.targetId, identity.place), IDLE_PROJECT_FORM);

  const values = state.kind === 'INVALID' ? state.values : EMPTY_REJECT_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};

  return (
    <form action={action} className="flex flex-col gap-3">
      <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
      <ProjectBanner state={state} />
      <p className="text-sm text-content-muted">{PROJECT_COMMAND_CONSEQUENCES.reject}</p>

      <Field
        label="دلیل رد"
        required
        error={errors.reason}
        hint="دست‌کم ۸ نویسه؛ صاحب پروژه آن را می‌بیند."
      >
        {(control) => (
          <textarea
            {...control}
            name="reason"
            rows={2}
            defaultValue={values.reason}
            maxLength={MAX_REASON_LENGTH}
            className={controlClassName}
          />
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" tone="secondary" disabled={pending}>
          {pending ? 'در حال ثبت…' : 'ثبت رد'}
        </Button>
      </div>
    </form>
  );
}
