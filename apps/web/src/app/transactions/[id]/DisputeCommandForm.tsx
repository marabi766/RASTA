'use client';

import { useActionState, useCallback } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { normalizePersianText, toPersianDigits } from '@/lib/format';
import {
  DISPUTE_COMMAND_CONSEQUENCES,
  DISPUTE_COMMAND_FIELD,
  DISPUTE_COMMAND_FIELDS,
  DISPUTE_COMMAND_LABELS,
  DISPUTE_FIELD_LABELS,
  DISPUTE_FIELD_LIMITS as LIMITS,
  EMPTY_DISPUTE_FORM,
  type DisputeCommand,
  type DisputeFormValues,
} from '@/lib/transaction-dispute-fields';

import { submitDisputeCommand } from './actions';
import {
  IDLE_DISPUTE_FORM,
  withRetryNote,
  type DisputeFormState,
  type UnconfirmedDispute,
} from './form-state';

/**
 * One dispute command the current viewer may issue on this transaction.
 *
 * The page draws one of these per entry `disputeCommandsFor` returned, so this
 * component never decides whether the command is allowed — only what its form
 * looks like. Each instance gets its own submission id, which is a real
 * idempotency key economic-service replays on.
 *
 * ## Sent and not confirmed
 *
 * The pattern of `PlaceOrderForm` (PR 245): the form is replaced by a view that
 * never says "nothing changed", that re-sends the kept body under the kept key
 * ("send the same request again"), and whose only other way out is a full
 * reload of the transaction — the record itself is the answer. Unlike an
 * order, nothing is remembered across a reload: the dispute is a state of a
 * transaction this page reads, and the state machine refuses the command a
 * second time from the state the first one led to (`DISPUTED` has no `DISPUTE`
 * edge, `PENDING_SETTLEMENT` no `RESOLVE_DISPUTE`), so a reload shows whether it
 * happened and a fresh key cannot apply it twice.
 */

export interface DisputeCommandFormProps {
  readonly transactionId: string;
  readonly command: DisputeCommand;
  readonly csrfToken: string;
  readonly submissionId: string;
}

/** A redirect from a server action reaches the client as a rejection whose digest says so. */
function isRedirect(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT');
}

/**
 * The submission as the action will send it, or null when the action would
 * refuse it before sending anything.
 */
function pendingFrom(form: FormData, command: DisputeCommand): UnconfirmedDispute | null {
  const submissionId = form.get(SUBMISSION_FIELD);
  const field = DISPUTE_COMMAND_FIELDS[command];
  const raw = form.get(field);
  if (typeof submissionId !== 'string' || typeof raw !== 'string') return null;
  const text = normalizePersianText(raw).trim();
  if (text.length < LIMITS[field].min || text.length > LIMITS[field].max) return null;
  return {
    kind: 'UNCONFIRMED',
    command,
    correlationId: null,
    submissionId,
    values: { ...EMPTY_DISPUTE_FORM, [field]: text },
  };
}

export function DisputeCommandForm({
  transactionId,
  command,
  csrfToken,
  submissionId,
}: DisputeCommandFormProps) {
  const send = useCallback(
    async (previous: DisputeFormState, form: FormData): Promise<DisputeFormState> => {
      try {
        return await submitDisputeCommand(transactionId, previous, form);
      } catch (error) {
        if (isRedirect(error)) throw error;
        // The call itself failed — a lost response after the command may have
        // committed, or the portal's own gate answering 401 JSON to an action
        // POST whose session has ended. Either way the doubt is still there.
        if (previous.kind === 'UNCONFIRMED') return withRetryNote(previous, 'sessionEnded');
        const unsent = pendingFrom(form, command);
        if (unsent) return unsent;
        throw error;
      }
    },
    [transactionId, command],
  );
  const [state, action, pending] = useActionState(send, IDLE_DISPUTE_FORM);
  const headingId = `command-${command}`;

  if (state.kind === 'UNCONFIRMED') {
    return (
      <UnconfirmedCommand
        state={state}
        action={action}
        pending={pending}
        csrfToken={csrfToken}
        headingId={headingId}
        transactionHref={`/transactions/${encodeURIComponent(transactionId)}`}
      />
    );
  }

  const invalid = state.kind === 'INVALID';
  const values: DisputeFormValues = invalid ? state.values : EMPTY_DISPUTE_FORM;
  const field = DISPUTE_COMMAND_FIELDS[command];
  const error = invalid ? state.fieldErrors[field] : undefined;
  const currentSubmissionId = invalid ? state.submissionId : submissionId;

  return (
    <form
      action={action}
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4"
    >
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={currentSubmissionId} />
      <input type="hidden" name={DISPUTE_COMMAND_FIELD} value={command} />

      <h3 id={headingId} className="text-base font-medium">
        {DISPUTE_COMMAND_LABELS[command]}
      </h3>
      <p className="text-sm text-content-muted">{DISPUTE_COMMAND_CONSEQUENCES[command]}</p>

      <CommandBanner state={state} />

      <Field
        label={DISPUTE_FIELD_LABELS[field]}
        hint={`دست‌کم ${toPersianDigits(String(LIMITS[field].min))} و حداکثر ${toPersianDigits(String(LIMITS[field].max))} نویسه`}
        error={error}
        required
      >
        {(control) => (
          <textarea
            {...control}
            name={field}
            rows={4}
            defaultValue={values[field]}
            required
            minLength={LIMITS[field].min}
            maxLength={LIMITS[field].max}
            className={controlClassName}
          />
        )}
      </Field>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'در حال ارسال…' : DISPUTE_COMMAND_LABELS[command]}
        </Button>
      </div>
    </form>
  );
}

function CommandBanner({ state }: { state: DisputeFormState }) {
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
        این اقدام روی این تراکنش در اختیار شما نیست. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  if (state.kind === 'NOT_FOUND') {
    return <Alert tone="warning">این تراکنش دیگر در دسترس نیست. صفحه را تازه کنید.</Alert>;
  }

  return null;
}

/**
 * Sent, maybe done, not confirmed. The retry re-sends the kept body under the
 * kept submission id (the service replays or completes the first request); the
 * transaction page, reloaded, is the reference.
 */
function UnconfirmedCommand({
  state,
  action,
  pending,
  csrfToken,
  headingId,
  transactionHref,
}: {
  state: UnconfirmedDispute;
  action: (form: FormData) => void;
  pending: boolean;
  csrfToken: string;
  headingId: string;
  transactionHref: string;
}) {
  const field = DISPUTE_COMMAND_FIELDS[state.command];
  // A call the gate refused because the session ended: its id is bound to the
  // old login and cannot be sent after a new one.
  const canRetry = !state.sessionEnded;
  const what = DISPUTE_COMMAND_LABELS[state.command];

  return (
    <form
      action={action}
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4"
    >
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={state.submissionId} />
      <input type="hidden" name={DISPUTE_COMMAND_FIELD} value={state.command} />
      <input type="hidden" name={field} value={state.values[field]} />

      <h3 id={headingId} className="text-base font-medium">
        {what}
      </h3>
      <Alert tone="warning">
        نتوانستیم تأیید کنیم که «{what}» انجام شد یا نه؛ ممکن است انجام شده باشد. پیش از هر کار
        دیگر،{' '}
        <a href={transactionHref} className="underline">
          این صفحه را تازه کنید
        </a>{' '}
        و وضعیت تراکنش را ببینید.{state.correlationId ? ` کد پیگیری: ${state.correlationId}` : ''}
      </Alert>
      {state.retryRefused ? (
        <Alert tone="warning">
          ارسال دوباره رد شد و نتیجهٔ درخواست نخست همچنان معلوم نیست؛ ممکن است انجام شده باشد. وضعیت
          تراکنش را با تازه‌کردن صفحه ببینید.
        </Alert>
      ) : null}
      {state.retryUnknown ? (
        <Alert tone="warning">
          ارسال دوباره نیز نتیجهٔ روشنی نداشت و وضعیت درخواست نخست همچنان معلوم نیست؛ ممکن است انجام
          شده باشد. وضعیت تراکنش را با تازه‌کردن صفحه ببینید.
        </Alert>
      ) : null}
      {state.sessionEnded ? (
        <Alert tone="danger">
          نشست شما پایان یافته است. دوباره وارد شوید و پیش از هر اقدام تازه، وضعیت تراکنش را ببینید؛
          ممکن است درخواست انجام شده باشد.
        </Alert>
      ) : null}
      {canRetry ? (
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? 'در حال ارسال…' : 'ارسال دوبارهٔ همین درخواست'}
          </Button>
        </div>
      ) : null}
      <p className="text-sm text-content-muted">
        {canRetry
          ? '«ارسال دوباره» همان درخواست را با همان شناسهٔ ارسال و همان متن می‌فرستد و ممکن است نتیجهٔ درخواست نخست را برگرداند، اما این تضمین نیست؛ وضعیت تراکنش مرجع است.'
          : 'وضعیت تراکنش مرجع است.'}
      </p>
    </form>
  );
}
