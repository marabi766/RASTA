'use client';

import { useActionState, useCallback } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { normalizePersianText, toPersianDigits } from '@/lib/format';
import {
  clearUnresolvedDispute,
  restoreUnresolvedDispute,
  saveUnresolvedDispute,
  type RestoredDispute,
} from '@/lib/unresolved-dispute';
import type { Binding } from '@/lib/unresolved-order';
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
 * never says "nothing changed" and re-sends the kept body under the kept key
 * ("send the same request again"). Like an order, the submission is
 * **remembered across a reload** (`lib/unresolved-dispute.ts`): the state
 * machine does not make a second command under a fresh key harmless —
 * `PENDING_SETTLEMENT → DISPUTED → PENDING_SETTLEMENT` is legal, so a resolution
 * that committed unseen and was sent again with a new key after the payer opened
 * a new dispute would resolve the new one (PR 319 review 1, finding 2). The entry
 * is written before the request leaves; a confirmed answer drops it, and
 * otherwise only the person does, once the same request has been tried again or
 * can no longer be.
 *
 * ## When the call itself fails
 *
 * Next rejects a dropped response and the request gate's `401` to an action
 * POST the same way. Only `/auth/session` answering `401` lets the view say the
 * session has ended; any other failure is "no answer came back" and the same
 * request may still be sent again (PR 319 review 1, finding 4).
 */

export interface DisputeCommandFormProps {
  readonly transactionId: string;
  readonly command: DisputeCommand;
  readonly csrfToken: string;
  readonly submissionId: string;
  /** Whose login this page was drawn for (`submissionBinding`); one-way tags, not session values. */
  readonly binding: Binding;
  /** How long a remembered submission outlives its login at most: the session's lifetime. */
  readonly sessionMaxAgeSeconds: number;
  /** A remembered submission this form starts from (`DisputeCommands`); idle otherwise. */
  readonly initial?: DisputeFormState;
}

/** The remembered submission as the form's starting state. */
export function unconfirmedFrom(restored: RestoredDispute): UnconfirmedDispute {
  const { command, correlationId, submissionId, values } = restored.dispute;
  return {
    kind: 'UNCONFIRMED',
    command,
    correlationId,
    submissionId,
    values,
    ...(restored.kind === 'VIEW_ONLY' ? { viewOnly: true as const } : {}),
  };
}

/**
 * Whether the portal says, authoritatively, that this browser's session has
 * ended (`/auth/session` → `401`). Anything else — `204`, another status, no
 * answer — is not that.
 */
async function sessionHasEnded(): Promise<boolean> {
  try {
    const response = await fetch('/auth/session', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    return response.status === 401;
  } catch {
    return false;
  }
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
  binding,
  sessionMaxAgeSeconds,
  initial = IDLE_DISPUTE_FORM,
}: DisputeCommandFormProps) {
  const send = useCallback(
    async (previous: DisputeFormState, form: FormData): Promise<DisputeFormState> => {
      const firstSend = previous.kind !== 'UNCONFIRMED';
      if (!firstSend) {
        // The same request is a replay only while the service still holds its
        // key, and only from the login it is bound to. Past that, never re-sent.
        const stored = restoreUnresolvedDispute(transactionId, binding, sessionMaxAgeSeconds);
        if (stored?.kind !== 'RETRYABLE' || stored.dispute.submissionId !== previous.submissionId) {
          return { ...previous, viewOnly: true };
        }
      }

      // Remembered BEFORE it is sent: from here until an answer, a reload or a
      // lost response must find the same key, not mint another. Not sent if it
      // cannot be remembered.
      const unsent = firstSend ? pendingFrom(form, command) : null;
      if (unsent && !saveUnresolvedDispute(transactionId, unsent, binding)) {
        return { kind: 'STORAGE_UNAVAILABLE' };
      }

      let next: DisputeFormState;
      try {
        next = await submitDisputeCommand(transactionId, previous, form);
      } catch (error) {
        // Done: the action redirects to the transaction. Nothing is unresolved now.
        if (isRedirect(error)) {
          clearUnresolvedDispute(transactionId);
          throw error;
        }
        // The call itself failed. A lost response after the command may have
        // committed; only an authoritative "the session has ended" says more.
        const ended = await sessionHasEnded();
        if (!firstSend) {
          return withRetryNote(previous, ended ? 'sessionEnded' : 'retryUnknown');
        }
        if (unsent) return ended ? { ...unsent, sessionEnded: true } : unsent;
        throw error;
      }

      if (firstSend) {
        // Answered: still in doubt (kept, now with its tracking code), or a
        // definite refusal of a request that was never in doubt (dropped).
        if (next.kind === 'UNCONFIRMED') saveUnresolvedDispute(transactionId, next, binding);
        else clearUnresolvedDispute(transactionId);
      }
      return next;
    },
    [transactionId, command, binding, sessionMaxAgeSeconds],
  );
  const [state, action, pending] = useActionState(send, initial);
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
        onForget={() => clearUnresolvedDispute(transactionId)}
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

  if (state.kind === 'STORAGE_UNAVAILABLE') {
    return (
      <Alert tone="danger">
        درخواست ارسال نشد: این مرورگر نمی‌تواند درخواست را تا روشن‌شدن نتیجه‌اش به خاطر بسپارد
        (مثلاً حالت خصوصی یا حافظهٔ پر)، و بی آن ممکن است یک اقدام دو بار انجام شود. از مرورگر دیگری
        استفاده کنید یا فضا را آزاد کنید و دوباره تلاش کنید.
      </Alert>
    );
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
  onForget,
}: {
  state: UnconfirmedDispute;
  action: (form: FormData) => void;
  pending: boolean;
  csrfToken: string;
  headingId: string;
  transactionHref: string;
  /** Forgets the remembered submission: the one action allowed to. */
  onForget: () => void;
}) {
  const field = DISPUTE_COMMAND_FIELDS[state.command];
  // Not re-sent from another login, past the replay window, or with the session
  // ended (its id is bound to the old login).
  const canRetry = !state.viewOnly && !state.sessionEnded;
  // Put aside only once the same request has been tried again and refused, or
  // can no longer be sent: never before the original key had its chance.
  const canForget = (state.viewOnly || state.retryRefused) && !state.sessionEnded;
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
      {state.viewOnly ? (
        <Alert tone="warning">
          این درخواست در نشست پیشین یا بیش از یک ساعت پیش فرستاده شده است و دیگر نمی‌توان همان را با
          اطمینان دوباره فرستاد؛ ممکن است انجام شده باشد. وضعیت تراکنش را ببینید.
        </Alert>
      ) : null}
      {canRetry ? (
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? 'در حال ارسال…' : 'ارسال دوبارهٔ همین درخواست'}
          </Button>
        </div>
      ) : null}
      {canForget ? (
        <div>
          {/* A full navigation: the page reads the transaction again and offers what it allows. */}
          <a
            href={transactionHref}
            onClick={onForget}
            onAuxClick={onForget}
            className="text-sm underline"
          >
            وضعیت تراکنش را دیدم؛ این درخواست را کنار بگذار
          </a>
        </div>
      ) : null}
      <p className="text-sm text-content-muted">
        {canRetry
          ? '«ارسال دوباره» همان درخواست را با همان شناسهٔ ارسال و همان متن می‌فرستد و ممکن است نتیجهٔ درخواست نخست را برگرداند، اما این تضمین نیست؛ وضعیت تراکنش مرجع است. تا روشن‌شدن نتیجه، اقدام تازه‌ای روی این تراکنش عرضه نمی‌شود.'
          : 'وضعیت تراکنش مرجع است.'}
      </p>
    </form>
  );
}
