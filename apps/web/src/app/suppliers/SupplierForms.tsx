'use client';

import { useActionState, useState, type ReactNode } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { UnconfirmedWriteAlert } from '@/app/UnconfirmedWriteAlert';
import { BASELINE_FIELD, CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { isSessionRefusal, SESSION_REFUSAL_MESSAGES } from '@/lib/session-refusal';
import {
  EMPTY_APPROVE_FORM,
  EMPTY_REASON_FORM,
  EMPTY_REGISTER_FORM,
  EMPTY_REJECT_FORM,
  EMPTY_SUBMIT_FORM,
  EVIDENCE_ID_PREFIX,
  EVIDENCE_LABEL_PREFIX,
  INITIAL_EVIDENCE_ROWS,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_DOCUMENT_ID_LENGTH,
  MAX_EVIDENCE_ITEMS,
  MAX_EVIDENCE_LABEL_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_REASON_LENGTH,
  MAX_STATEMENT_LENGTH,
  MIN_REASON_LENGTH,
  REVIEWER_NOTE_HINT,
  SUPPLIER_COMMAND_CONSEQUENCES,
  SUPPLIER_FORBIDDEN_MESSAGE,
  SUPPLIER_NOT_FOUND_MESSAGE,
  supplierFailureText,
  type ApproveField,
  type ApproveFormValues,
  type ReasonField,
  type ReasonFormValues,
  type RegisterField,
  type RegisterFormValues,
  type RejectField,
  type RejectFormValues,
  type SubmitField,
  type SubmitFormValues,
  type SupplierCommand,
} from '@/lib/supplier-commands';
import {
  SUPPLIER_CAPABILITIES,
  supplierCapabilityLabel,
  type SupplierCapability,
} from '@/lib/supplier-fields';

import {
  submitApproveQualification,
  submitQualificationRequest,
  submitRegisterSupplier,
  submitReinstateSupplier,
  submitRejectQualification,
  submitSuspendSupplier,
} from './supplier-actions';
import { IDLE_SUPPLIER_FORM, type SupplierFormState } from './supplier-form-state';

/**
 * The six supplier commands, as plain `<form>`s around server actions so each
 * works before any bundle has loaded (docs/16 § ۱۶٫۲).
 *
 * None of them names its supplier or qualification in a field. A command on an
 * existing supplier carries `baseline`, a token the page signed for this
 * command, this person and this supplier (`sealSupplierBaseline`), and the
 * action reads everything but what a person types from it.
 *
 * Each carries the submission id minted for it and keeps it across an attempt
 * that came back with something to read. supplier-service takes no key on any
 * of these routes: the id only proves the form was drawn for this session, and
 * what makes a second press harmless is the service's own state rules.
 */

export interface SupplierIdentity {
  readonly csrfToken: string;
  /** Minted for this render and bound to this session. */
  readonly submissionId: string;
  /**
   * An earlier write here is unresolved (`UnresolvedSupplierNotice`): the send
   * is disabled, and the action refuses it as well.
   */
  readonly held?: boolean;
}

export interface SupplierBoundIdentity extends SupplierIdentity {
  /** The page's supplier: bound to the action, and the baseline must name the same one. */
  readonly supplierId: string;
  /** Signed for this command, this supplier and this person. */
  readonly baseline: string;
}

function Hidden({
  csrfToken,
  submissionId,
  baseline,
}: SupplierIdentity & { baseline?: string }): ReactNode {
  return (
    <>
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={submissionId} />
      {baseline === undefined ? null : (
        <input type="hidden" name={BASELINE_FIELD} value={baseline} />
      )}
    </>
  );
}

/** No new send while this form or the page holds a write whose answer was lost. */
function blocked(identity: { readonly held?: boolean }, state: { kind: string }): boolean {
  return identity.held === true || state.kind === 'UNCONFIRMED';
}

/** A retry of the same form carries the same reference. */
function submissionOf(state: { kind: string; submissionId?: string }, minted: string): string {
  return state.kind === 'INVALID' && state.submissionId ? state.submissionId : minted;
}

function Banner({ state }: { state: SupplierFormState<unknown, string> }) {
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
          {SUPPLIER_FORBIDDEN_MESSAGE} کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'NOT_FOUND':
      return (
        <Alert tone="danger">
          {SUPPLIER_NOT_FOUND_MESSAGE} کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'UNCONFIRMED':
      return <UnconfirmedWriteAlert correlationId={state.correlationId} />;
    case 'FAILED':
      return (
        <Alert tone="danger">
          {supplierFailureText(state.status)} کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'IDLE':
      return null;
  }
}

function Consequence({ command }: { command: SupplierCommand }) {
  return <p className="text-sm text-content-muted">{SUPPLIER_COMMAND_CONSEQUENCES[command]}</p>;
}

function CapabilityBoxes({
  idPrefix,
  name,
  capabilities,
  selected,
  error,
}: {
  idPrefix: string;
  name: string;
  capabilities: readonly SupplierCapability[];
  selected: readonly string[];
  error: string | undefined;
}) {
  const errorId = `${idPrefix}-error`;
  return (
    // Keyed by its selection: a form reset after an answer reads `defaultChecked` again.
    <fieldset
      key={selected.join(',')}
      className="flex flex-col gap-2"
      aria-describedby={error ? errorId : undefined}
    >
      <legend className="text-sm font-medium">دسته‌های فعالیت</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {capabilities.map((capability) => {
          const id = `${idPrefix}-${capability}`;
          return (
            <label key={capability} htmlFor={id} className="flex items-center gap-2 text-sm">
              <input
                id={id}
                type="checkbox"
                name={name}
                value={capability}
                aria-label={supplierCapabilityLabel(capability)}
                defaultChecked={selected.includes(capability)}
              />
              {supplierCapabilityLabel(capability)}
            </label>
          );
        })}
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export function RegisterSupplierForm(identity: SupplierIdentity) {
  const [state, action, pending] = useActionState<
    SupplierFormState<RegisterFormValues, RegisterField>,
    FormData
  >(submitRegisterSupplier, IDLE_SUPPLIER_FORM);

  const values = state.kind === 'INVALID' ? state.values : EMPTY_REGISTER_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};

  return (
    <form action={action} className="flex flex-col gap-4">
      <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
      <Banner state={state} />
      <Consequence command="REGISTER" />

      <Field label="نام تامین‌کننده" required error={errors.displayName}>
        {(control) => (
          <input
            {...control}
            name="displayName"
            defaultValue={values.displayName}
            maxLength={MAX_DISPLAY_NAME_LENGTH}
            className={controlClassName}
          />
        )}
      </Field>

      <CapabilityBoxes
        idPrefix="register-capability"
        name="capabilities"
        capabilities={SUPPLIER_CAPABILITIES}
        selected={values.capabilities}
        error={errors.capabilities}
      />

      <div>
        <Button type="submit" disabled={pending || blocked(identity, state)}>
          {pending ? 'در حال ثبت…' : 'ثبت پرونده تامین‌کننده'}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Submit a qualification
// ---------------------------------------------------------------------------

/** How many evidence rows to draw: the last one holding anything, at least the initial few. */
function rowCount(values: SubmitFormValues): number {
  return Math.max(INITIAL_EVIDENCE_ROWS, values.evidence.length);
}

export function SubmitQualificationForm({
  capabilities,
  ...identity
}: SupplierBoundIdentity & {
  /** The capabilities the page found open: none awaiting a decision, none approved. */
  readonly capabilities: readonly SupplierCapability[];
}) {
  const [state, action, pending] = useActionState<
    SupplierFormState<SubmitFormValues, SubmitField>,
    FormData
  >(submitQualificationRequest.bind(null, identity.supplierId), IDLE_SUPPLIER_FORM);
  const [added, setAdded] = useState(0);

  const values = state.kind === 'INVALID' ? state.values : EMPTY_SUBMIT_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};
  const rows = Math.min(MAX_EVIDENCE_ITEMS, rowCount(values) + added);

  return (
    <form action={action} className="flex flex-col gap-4">
      <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
      <Banner state={state} />
      <Consequence command="SUBMIT_QUALIFICATION" />

      <Field label="دسته" required error={errors.capability}>
        {(control) => (
          <select
            // Keyed by its default: a select reads `defaultValue` only at mount (docs/16 § ۱۶٫۱).
            key={values.capability}
            {...control}
            name="capability"
            defaultValue={values.capability}
            className={controlClassName}
          >
            <option value="">انتخاب کنید…</option>
            {capabilities.map((capability) => (
              <option key={capability} value={capability}>
                {supplierCapabilityLabel(capability)}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field
        label="توضیح"
        error={errors.statement}
        hint="اختیاری؛ حرف خود تامین‌کننده است، نه تصمیم."
      >
        {(control) => (
          <textarea
            {...control}
            name="statement"
            rows={3}
            defaultValue={values.statement}
            maxLength={MAX_STATEMENT_LENGTH}
            className={controlClassName}
          />
        )}
      </Field>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium">سند پیوست (اختیاری)</legend>
        <p className="text-xs text-content-muted">
          فقط شناسه سند در سرویس اسناد را بنویسید؛ این صفحه سند را نمی‌گشاید. هیچ سندی اجباری نیست و
          بازبین تصمیم می‌گیرد چه چیزی کافی است. حداکثر {MAX_EVIDENCE_ITEMS} سند.
        </p>
        {Array.from({ length: rows }, (_, index) => {
          const row = values.evidence[index];
          return (
            <div key={`${index}-${row?.documentId ?? ''}`} className="grid gap-3 sm:grid-cols-2">
              <Field label={`شناسه سند ${index + 1}`}>
                {(control) => (
                  <input
                    {...control}
                    name={`${EVIDENCE_ID_PREFIX}${index}`}
                    defaultValue={row?.documentId ?? ''}
                    maxLength={MAX_DOCUMENT_ID_LENGTH}
                    dir="ltr"
                    className={controlClassName}
                  />
                )}
              </Field>
              <Field label={`برچسب سند ${index + 1}`}>
                {(control) => (
                  <input
                    {...control}
                    name={`${EVIDENCE_LABEL_PREFIX}${index}`}
                    defaultValue={row?.label ?? ''}
                    maxLength={MAX_EVIDENCE_LABEL_LENGTH}
                    className={controlClassName}
                  />
                )}
              </Field>
            </div>
          );
        })}
        {errors.evidence ? (
          <p role="alert" className="text-xs text-danger-text">
            {errors.evidence}
          </p>
        ) : null}
        {rows < MAX_EVIDENCE_ITEMS ? (
          <div>
            <Button type="button" tone="quiet" onClick={() => setAdded((count) => count + 1)}>
              افزودن سند
            </Button>
          </div>
        ) : null}
      </fieldset>

      <div>
        <Button type="submit" disabled={pending || blocked(identity, state)}>
          {pending ? 'در حال ارسال…' : 'ارسال درخواست صلاحیت'}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Decide a qualification
// ---------------------------------------------------------------------------

export function ApproveQualificationForm({
  capabilityLabel,
  ...identity
}: SupplierBoundIdentity & { readonly capabilityLabel: string }) {
  const [state, action, pending] = useActionState<
    SupplierFormState<ApproveFormValues, ApproveField>,
    FormData
  >(submitApproveQualification.bind(null, identity.supplierId), IDLE_SUPPLIER_FORM);

  const values = state.kind === 'INVALID' ? state.values : EMPTY_APPROVE_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};

  return (
    <form action={action} className="flex flex-col gap-3">
      <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
      <Banner state={state} />
      <Consequence command="APPROVE_QUALIFICATION" />
      <Field
        label={`یادداشت تایید ${capabilityLabel}`}
        error={errors.note}
        hint={REVIEWER_NOTE_HINT}
      >
        {(control) => (
          <textarea
            {...control}
            name="note"
            rows={2}
            defaultValue={values.note}
            maxLength={MAX_NOTE_LENGTH}
            className={controlClassName}
          />
        )}
      </Field>
      <div>
        <Button type="submit" disabled={pending || blocked(identity, state)}>
          {pending ? 'در حال ثبت…' : `تایید صلاحیت ${capabilityLabel}`}
        </Button>
      </div>
    </form>
  );
}

export function RejectQualificationForm({
  capabilityLabel,
  ...identity
}: SupplierBoundIdentity & { readonly capabilityLabel: string }) {
  const [state, action, pending] = useActionState<
    SupplierFormState<RejectFormValues, RejectField>,
    FormData
  >(submitRejectQualification.bind(null, identity.supplierId), IDLE_SUPPLIER_FORM);

  const values = state.kind === 'INVALID' ? state.values : EMPTY_REJECT_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};

  return (
    <form action={action} className="flex flex-col gap-3">
      <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
      <Banner state={state} />
      <Consequence command="REJECT_QUALIFICATION" />
      <Field
        label={`دلیل رد ${capabilityLabel}`}
        required
        error={errors.reason}
        hint={`دست‌کم ${MIN_REASON_LENGTH} نویسه؛ روی پرونده تامین‌کننده نمایش داده و منتشر می‌شود.`}
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
      <Field label="یادداشت خصوصی بازبین" error={errors.note} hint={REVIEWER_NOTE_HINT}>
        {(control) => (
          <textarea
            {...control}
            name="note"
            rows={2}
            defaultValue={values.note}
            maxLength={MAX_NOTE_LENGTH}
            className={controlClassName}
          />
        )}
      </Field>
      <div>
        <Button type="submit" tone="secondary" disabled={pending || blocked(identity, state)}>
          {pending ? 'در حال ثبت…' : `رد صلاحیت ${capabilityLabel}`}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Suspend and reinstate
// ---------------------------------------------------------------------------

function ReasonForm({
  command,
  label,
  hint,
  submitLabel,
  pendingLabel,
  tone,
  actionFor,
  ...identity
}: SupplierBoundIdentity & {
  readonly command: SupplierCommand;
  readonly label: string;
  readonly hint: string;
  readonly submitLabel: string;
  readonly pendingLabel: string;
  readonly tone: 'primary' | 'secondary';
  readonly actionFor: typeof submitSuspendSupplier;
}) {
  const [state, action, pending] = useActionState<
    SupplierFormState<ReasonFormValues, ReasonField>,
    FormData
  >(actionFor.bind(null, identity.supplierId), IDLE_SUPPLIER_FORM);

  const values = state.kind === 'INVALID' ? state.values : EMPTY_REASON_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};

  return (
    <form action={action} className="flex flex-col gap-3">
      <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
      <Banner state={state} />
      <Consequence command={command} />
      <Field label={label} required error={errors.reason} hint={hint}>
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
      <div>
        <Button type="submit" tone={tone} disabled={pending || blocked(identity, state)}>
          {pending ? pendingLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function SuspendSupplierForm(identity: SupplierBoundIdentity) {
  return (
    <ReasonForm
      {...identity}
      command="SUSPEND"
      label="دلیل تعلیق"
      hint={`دست‌کم ${MIN_REASON_LENGTH} نویسه؛ در سابقه تعلیق و رویداد منتشرشده می‌ماند.`}
      submitLabel="تعلیق تامین‌کننده"
      pendingLabel="در حال تعلیق…"
      tone="secondary"
      actionFor={submitSuspendSupplier}
    />
  );
}

export function ReinstateSupplierForm(identity: SupplierBoundIdentity) {
  return (
    <ReasonForm
      {...identity}
      command="REINSTATE"
      label="دلیل رفع تعلیق"
      hint={`دست‌کم ${MIN_REASON_LENGTH} نویسه؛ روی دوره تعلیقی که بسته می‌شود ثبت می‌ماند.`}
      submitLabel="رفع تعلیق"
      pendingLabel="در حال ثبت…"
      tone="primary"
      actionFor={submitReinstateSupplier}
    />
  );
}
