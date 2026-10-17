'use client';

import { useActionState, useCallback } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { toPersianDigits } from '@/lib/format';
import { CSRF_FIELD, REPLAY_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import {
  REASON_FIELD,
  RETURN_COMMAND_CONSEQUENCES,
  RETURN_COMMAND_LABELS,
  RETURN_REASON_MAX,
  RETURN_REASON_MIN,
  RETURN_REFUSAL_TEXT,
  quantityField,
  type ReturnCommand,
} from '@/lib/return-fields';
import {
  parseReturnRequest,
  returnRequestFormValues,
  valuesOfBody,
  type ReturnRequestValues,
} from '@/lib/return-request';
import { isRedirect, sessionHasEnded, SESSION_REFUSAL_MESSAGES } from '@/lib/session-refusal';
import type { Binding } from '@/lib/unresolved-order';
import {
  clearUnresolvedReturn,
  restoreUnresolvedReturn,
  saveUnresolvedReturn,
  type ReplayStamp,
  type RestoredReturn,
  type ReturnScope,
} from '@/lib/unresolved-return';

import { submitReturnCommand, submitReturnRequest } from './return-actions';
import {
  IDLE_RETURN_FORM,
  withRetryNote,
  type ReturnFormState,
  type UnconfirmedReturn,
} from './return-form-state';

/**
 * One return command this viewer may issue — asking to return goods of an
 * order, or authorizing, rejecting or withdrawing one request. The page draws
 * one per command `server/returns.ts` says the service would accept, so this
 * component never decides whether the command is allowed, only what its form
 * looks like. Each instance has its own submission id — the idempotency key
 * marketplace-service replays on — and its own signed replay stamp.
 *
 * ## Sent and not confirmed
 *
 * The submission is remembered before it leaves (`lib/unresolved-return.ts`),
 * the form is replaced by a view that never says "nothing changed", and "send
 * the same request again" re-sends the kept body under the kept key — a
 * request's reason and lines as they were sent; a decision's or a withdrawal's
 * body is in the stamp. A confirmed answer redirects and drops the entry;
 * otherwise only the person drops it, once the same request has been tried
 * again or can no longer be.
 *
 * ## One unresolved command per order, and per request
 *
 * The authorize, reject and cancel forms of a request share one slot, as the
 * request form of an order has its own. While another submission's outcome is
 * unknown (`heldBy`, kept current by `ReturnCommands`), this form draws no
 * button, only the uncertainty notice; and a send is refused here, before
 * anything leaves, whenever the slot holds another submission — so a
 * rejection can never replace, or clear, a lost authorization's record and
 * key. A record is cleared only for the submission it belongs to.
 *
 * ## When the call itself fails
 *
 * Only `/auth/session` answering `401` lets the view say the session has
 * ended; any other failure — a refresh that is only unavailable for now
 * included — is "no answer came back", and the same request may still be sent.
 */

/** An order line the request form offers. */
export interface ReturnFormLine {
  readonly orderLineId: string;
  readonly productName: string;
  readonly sold: number;
  /** Sold, less what open requests already take; null when unknown. */
  readonly available: number | null;
}

export interface ReturnCommandFormProps {
  readonly scope: ReturnScope;
  readonly command: ReturnCommand;
  readonly csrfToken: string;
  readonly submissionId: string;
  /** That submission id's signed replay deadline; null for a restored entry that has none any more. */
  readonly replay: ReplayStamp | null;
  readonly binding: Binding;
  readonly sessionMaxAgeSeconds: number;
  /** The order's lines a request may name; requests only. */
  readonly lines?: readonly ReturnFormLine[];
  /** The page that shows the outcome — reloaded to see whether the command took. */
  readonly pageHref: string;
  readonly initial?: ReturnFormState;
  /** The submission whose outcome is unknown in this slot, if any (`ReturnCommands`). */
  readonly heldBy?: string | null;
}

/** The remembered submission as the form's starting state. */
export function unconfirmedFrom(restored: RestoredReturn): UnconfirmedReturn {
  const { command, correlationId, submissionId, body, replay, marker } = restored.entry;
  return {
    kind: 'UNCONFIRMED',
    command,
    correlationId,
    submissionId,
    body,
    replay,
    ...(restored.kind === 'VIEW_ONLY' ? { viewOnly: true as const } : {}),
    ...(marker ? { marker: true as const } : {}),
  };
}

/** The submission as the action will send it, or null when the action would refuse it unsent. */
function pendingFrom(
  form: FormData,
  command: ReturnCommand,
  replay: ReplayStamp | null,
): UnconfirmedReturn | null {
  const submissionId = form.get(SUBMISSION_FIELD);
  if (typeof submissionId !== 'string') return null;
  if (command !== 'REQUEST') {
    return { kind: 'UNCONFIRMED', command, correlationId: null, submissionId, body: null, replay };
  }
  // The same reading the action makes, so what is kept is what is sent.
  const parsed = parseReturnRequest(returnRequestFormValues(form), null);
  if (!parsed.ok) return null;
  return {
    kind: 'UNCONFIRMED',
    command,
    correlationId: null,
    submissionId,
    body: parsed.body,
    replay,
  };
}

export function ReturnCommandForm({
  scope,
  command,
  csrfToken,
  submissionId,
  replay,
  binding,
  sessionMaxAgeSeconds,
  lines = [],
  pageHref,
  initial = IDLE_RETURN_FORM,
  heldBy = null,
}: ReturnCommandFormProps) {
  const send = useCallback(
    async (previous: ReturnFormState, form: FormData): Promise<ReturnFormState> => {
      const firstSend = previous.kind !== 'UNCONFIRMED';
      const sent = form.get(SUBMISSION_FIELD);
      const sentId = firstSend ? (typeof sent === 'string' ? sent : '') : previous.submissionId;
      if (firstSend) {
        // A request checked here first, with what the page knows of each line.
        if (command === 'REQUEST') {
          const values = returnRequestFormValues(form);
          const parsed = parseReturnRequest(values, lines);
          if (!parsed.ok) {
            return {
              kind: 'INVALID',
              command,
              submissionId: sentId,
              values,
              fieldErrors: parsed.fieldErrors,
              message: parsed.message,
            };
          }
        }
        // Another submission's outcome is unknown here: nothing is sent, and its
        // record is not touched.
        const holder = restoreUnresolvedReturn(scope, binding, sessionMaxAgeSeconds);
        if (holder && holder.entry.submissionId !== sentId) return { kind: 'HELD' };
      } else {
        // A replay only while the service still holds its key, and only from
        // the login it is bound to. Past that, never re-sent.
        const stored = restoreUnresolvedReturn(scope, binding, sessionMaxAgeSeconds);
        if (stored?.kind !== 'RETRYABLE' || stored.entry.submissionId !== previous.submissionId) {
          return { ...previous, viewOnly: true };
        }
      }

      // Remembered BEFORE it is sent; not sent if it cannot be remembered.
      const unsent = firstSend ? pendingFrom(form, command, replay) : null;
      const saved = unsent ? saveUnresolvedReturn(scope, unsent, binding) : null;
      if (saved === 'HELD') return { kind: 'HELD' };
      if (saved === 'UNAVAILABLE') return { kind: 'STORAGE_UNAVAILABLE' };

      let next: ReturnFormState;
      try {
        next =
          scope.kind === 'ORDER'
            ? await submitReturnRequest(scope.orderId, previous, form)
            : await submitReturnCommand(scope.returnId, previous, form);
      } catch (error) {
        // Done: the action redirects to the request.
        if (isRedirect(error)) {
          clearUnresolvedReturn(scope, sentId);
          throw error;
        }
        const ended = await sessionHasEnded();
        if (!firstSend) return withRetryNote(previous, ended ? 'sessionEnded' : 'retryUnknown');
        if (unsent) return ended ? { ...unsent, sessionEnded: true } : unsent;
        throw error;
      }

      // Still in doubt: kept. A definite answer to THIS submission's first send:
      // its own record is dropped — never another's.
      if (next.kind === 'UNCONFIRMED') saveUnresolvedReturn(scope, next, binding);
      else if (firstSend) clearUnresolvedReturn(scope, sentId);
      return next;
    },
    [scope, command, replay, binding, sessionMaxAgeSeconds, lines],
  );
  const [state, action, pending] = useActionState(send, initial);
  const headingId = `return-command-${command}`;

  if (state.kind === 'UNCONFIRMED') {
    return (
      <UnconfirmedCommand
        state={state}
        action={action}
        pending={pending}
        csrfToken={csrfToken}
        headingId={headingId}
        pageHref={pageHref}
        onForget={() => clearUnresolvedReturn(scope, state.submissionId)}
      />
    );
  }

  const invalid = state.kind === 'INVALID';
  const currentSubmissionId = invalid ? state.submissionId : submissionId;

  if (heldBy !== null && heldBy !== currentSubmissionId) {
    return <HeldCommand command={command} headingId={headingId} pageHref={pageHref} />;
  }

  return (
    <form
      action={action}
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4"
    >
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={currentSubmissionId} />
      <input type="hidden" name={REPLAY_FIELD} value={replay?.token ?? ''} />

      <h3 id={headingId} className="text-base font-medium">
        {RETURN_COMMAND_LABELS[command]}
      </h3>
      <p className="text-sm text-content-muted">{RETURN_COMMAND_CONSEQUENCES[command]}</p>

      <CommandBanner state={state} />

      {command === 'REQUEST' ? (
        <RequestFields
          lines={lines}
          values={invalid ? state.values : null}
          fieldErrors={invalid ? state.fieldErrors : {}}
        />
      ) : null}

      <div>
        <Button
          type="submit"
          tone={command === 'REJECT' ? 'secondary' : undefined}
          disabled={pending}
        >
          {pending ? 'در حال ارسال…' : RETURN_COMMAND_LABELS[command]}
        </Button>
      </div>
    </form>
  );
}

function RequestFields({
  lines,
  values,
  fieldErrors,
}: {
  lines: readonly ReturnFormLine[];
  values: ReturnRequestValues | null;
  fieldErrors: Partial<Record<string, string>>;
}) {
  const typed = (orderLineId: string): string =>
    values?.quantities.find((entry) => entry.orderLineId === orderLineId)?.quantity ?? '';
  return (
    <>
      <Field
        label="دلیل بازگشت"
        hint={`دست‌کم ${toPersianDigits(String(RETURN_REASON_MIN))} و حداکثر ${toPersianDigits(String(RETURN_REASON_MAX))} نویسه؛ برای تأمین‌کننده نمایش داده می‌شود.`}
        error={fieldErrors[REASON_FIELD]}
      >
        {(control) => (
          <textarea
            {...control}
            name={REASON_FIELD}
            rows={3}
            maxLength={RETURN_REASON_MAX}
            defaultValue={values?.reason ?? ''}
            className={controlClassName}
          />
        )}
      </Field>
      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium">چه مقدار از هر ردیف بازگردانده شود؟</legend>
        <p className="text-sm text-content-muted">
          ردیفی را که چیزی از آن بازنمی‌گردد خالی بگذارید.
        </p>
        {lines.map((line) => (
          <Field
            key={line.orderLineId}
            label={`تعداد بازگشتی — ${line.productName}`}
            hint={
              line.available === null
                ? `فروخته‌شده: ${toPersianDigits(String(line.sold))}`
                : `فروخته‌شده: ${toPersianDigits(String(line.sold))} · قابل بازگشت: ${toPersianDigits(String(line.available))}`
            }
            error={fieldErrors[quantityField(line.orderLineId)]}
          >
            {(control) => (
              <input
                {...control}
                name={quantityField(line.orderLineId)}
                inputMode="numeric"
                autoComplete="off"
                dir="ltr"
                defaultValue={typed(line.orderLineId)}
                className={controlClassName}
              />
            )}
          </Field>
        ))}
      </fieldset>
    </>
  );
}

/** Nothing was sent in any of these. */
const REFUSAL_MESSAGES: Record<Extract<ReturnFormState, { kind: 'REFUSED' }>['reason'], string> = {
  ...SESSION_REFUSAL_MESSAGES,
  REPLAY: 'مهلت این فرم گذشته است و درخواست ارسال نشد. صفحه را تازه کنید و دوباره تلاش کنید.',
  CSRF: 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.',
  SUBMISSION: 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.',
  COMMAND: 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.',
  CANCEL_NOT_IN_PORTAL: RETURN_REFUSAL_TEXT.CANCEL_NOT_IN_PORTAL,
  CANCEL_UNCHECKED: RETURN_REFUSAL_TEXT.CANCEL_UNCHECKED,
};

export const HELD_MESSAGE =
  'درخواست دیگری دربارهٔ همین بازگشت فرستاده شده و نتیجه‌اش هنوز معلوم نیست؛ ممکن است انجام شده باشد. تا روشن‌شدن نتیجهٔ آن، این فرم فرستاده نمی‌شود. وضعیت را با تازه‌کردن صفحه ببینید.';

/**
 * Another command of this slot is unresolved: no form, no button — only what
 * this command would be, and why it waits.
 */
function HeldCommand({
  command,
  headingId,
  pageHref,
}: {
  command: ReturnCommand;
  headingId: string;
  pageHref: string;
}) {
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4"
    >
      <h3 id={headingId} className="text-base font-medium">
        {RETURN_COMMAND_LABELS[command]}
      </h3>
      <Alert tone="warning">
        {HELD_MESSAGE}{' '}
        <a href={pageHref} className="underline">
          تازه‌کردن صفحه
        </a>
      </Alert>
    </section>
  );
}

function CommandBanner({ state }: { state: ReturnFormState }) {
  if (state.kind === 'HELD') {
    return <Alert tone="warning">{HELD_MESSAGE}</Alert>;
  }
  if (state.kind === 'INVALID' && state.message) {
    return <Alert tone="warning">{state.message}</Alert>;
  }
  if (state.kind === 'REFUSED') {
    return <Alert tone="danger">{REFUSAL_MESSAGES[state.reason]}</Alert>;
  }
  if (state.kind === 'FORBIDDEN') {
    return (
      <Alert tone="danger">
        این اقدام در اختیار سازمان یا نقش شما نیست و چیزی ثبت نشد. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }
  if (state.kind === 'NOT_FOUND') {
    return (
      <Alert tone="warning">
        این سفارش یا درخواست بازگشت دیگر در دسترس نیست. صفحه را تازه کنید.
      </Alert>
    );
  }
  if (state.kind === 'STORAGE_UNAVAILABLE') {
    return (
      <Alert tone="danger">
        درخواست ارسال نشد: این مرورگر نمی‌تواند درخواست را تا روشن‌شدن نتیجه‌اش به خاطر بسپارد
        (مثلاً حالت خصوصی یا حافظهٔ پر)، و بی آن ممکن است یک درخواست دو بار ثبت شود. از مرورگر دیگری
        استفاده کنید یا فضا را آزاد کنید و دوباره تلاش کنید.
      </Alert>
    );
  }
  return null;
}

/**
 * Sent, maybe done, not confirmed. The retry re-sends the kept body under the
 * kept submission id; the page, reloaded, is the reference.
 */
function UnconfirmedCommand({
  state,
  action,
  pending,
  csrfToken,
  headingId,
  pageHref,
  onForget,
}: {
  state: UnconfirmedReturn;
  action: (form: FormData) => void;
  pending: boolean;
  csrfToken: string;
  headingId: string;
  pageHref: string;
  onForget: () => void;
}) {
  const canRetry = !state.viewOnly && !state.sessionEnded;
  const canForget = (state.viewOnly || state.retryRefused) && !state.sessionEnded;
  const what = RETURN_COMMAND_LABELS[state.command];
  const kept = state.body ? valuesOfBody(state.body) : null;

  return (
    <form
      action={action}
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4"
    >
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={state.submissionId} />
      <input type="hidden" name={REPLAY_FIELD} value={state.replay?.token ?? ''} />
      {kept ? (
        <span hidden>
          <input type="hidden" name={REASON_FIELD} value={kept.reason} />
          {kept.quantities.map((line) => (
            <input
              key={line.orderLineId}
              type="hidden"
              name={quantityField(line.orderLineId)}
              value={line.quantity}
            />
          ))}
        </span>
      ) : null}

      <h3 id={headingId} className="text-base font-medium">
        {what}
      </h3>
      <Alert tone="warning">
        نتوانستیم تأیید کنیم که «{what}» انجام شد یا نه؛ ممکن است انجام شده باشد. پیش از هر کار
        دیگر،{' '}
        <a href={pageHref} className="underline">
          این صفحه را تازه کنید
        </a>{' '}
        و وضعیت درخواست‌های بازگشت را ببینید.
        {state.correlationId ? ` کد پیگیری: ${state.correlationId}` : ''}
      </Alert>
      {state.retryRefused ? (
        <Alert tone="warning">
          ارسال دوباره رد شد و نتیجهٔ درخواست نخست همچنان معلوم نیست؛ ممکن است انجام شده باشد. با
          تازه‌کردن صفحه وضعیت را ببینید.
        </Alert>
      ) : null}
      {state.retryUnknown ? (
        <Alert tone="warning">
          ارسال دوباره نیز نتیجهٔ روشنی نداشت و وضعیت درخواست نخست همچنان معلوم نیست؛ ممکن است انجام
          شده باشد. با تازه‌کردن صفحه وضعیت را ببینید.
        </Alert>
      ) : null}
      {state.sessionEnded ? (
        <Alert tone="danger">
          نشست شما پایان یافته است. دوباره وارد شوید و پیش از هر اقدام تازه وضعیت را ببینید؛ ممکن
          است درخواست انجام شده باشد.
        </Alert>
      ) : null}
      {state.marker ? (
        <Alert tone="warning">
          نتیجهٔ این درخواست هنوز معلوم نیست و محتوای آن دیگر نگه داشته نمی‌شود؛ ممکن است انجام شده
          باشد. پیش از هر اقدام تازه، وضعیت را ببینید.
        </Alert>
      ) : state.replayExpired ? (
        <Alert tone="warning">
          مهلت ارسال دوبارهٔ همین درخواست گذشته است و چیزی فرستاده نشد؛ نتیجهٔ درخواست نخست همچنان
          معلوم نیست و ممکن است انجام شده باشد. وضعیت را ببینید.
        </Alert>
      ) : state.viewOnly ? (
        <Alert tone="warning">
          این درخواست در نشست پیشین فرستاده شده یا مهلت ارسال دوباره‌اش گذشته است و دیگر نمی‌توان
          همان را با اطمینان دوباره فرستاد؛ ممکن است انجام شده باشد. وضعیت را ببینید.
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
          {/* A full navigation: the page reads the requests again and offers what they allow. */}
          <a href={pageHref} onClick={onForget} onAuxClick={onForget} className="text-sm underline">
            وضعیت را دیدم؛ این درخواست را کنار بگذار
          </a>
        </div>
      ) : null}
      <p className="text-sm text-content-muted">
        {canRetry
          ? '«ارسال دوباره» همان درخواست را با همان شناسهٔ ارسال و همان محتوا می‌فرستد و ممکن است نتیجهٔ درخواست نخست را برگرداند، اما این تضمین نیست؛ وضعیت ثبت‌شده مرجع است. تا روشن‌شدن نتیجه، اقدام تازه‌ای اینجا عرضه نمی‌شود.'
          : 'وضعیت ثبت‌شده مرجع است.'}
      </p>
    </form>
  );
}
