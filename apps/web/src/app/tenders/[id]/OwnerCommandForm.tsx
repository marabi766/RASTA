'use client';

import { useActionState, useCallback } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { CSRF_FIELD, REPLAY_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { isRedirect, sessionHasEnded, SESSION_REFUSAL_MESSAGES } from '@/lib/session-refusal';
import {
  APPROVAL_REFUSAL_TEXT,
  OPENING_REFUSAL_TEXT,
  OWNER_COMMAND_CONSEQUENCES,
  OWNER_COMMAND_LABELS,
  OWNER_FORBIDDEN_TEXT,
  REASON_FIELD,
  REJECT_REASON_MAX,
  type OwnerCommand,
} from '@/lib/tender-owner-fields';
import { parseRejectReason } from '@/lib/tender-owner-input';
import {
  clearUnresolvedOwnerCommand,
  restoreUnresolvedOwnerCommand,
  saveUnresolvedOwnerCommand,
  type ReplayStamp,
  type UnresolvedOwnerCommand,
} from '@/lib/unresolved-tender-command';

import { submitOwnerCommand } from './owner-actions';
import {
  IDLE_OWNER_FORM,
  withRetryNote,
  type OwnerFormState,
  type UnconfirmedOwnerCommand,
} from './owner-form-state';

/**
 * One command the owner's side may issue on a tender — publish, decide the
 * publication's step, or one of the opening's three. The page draws one per
 * command `server/tender-owner.ts` says the service would accept; this
 * component never decides whether it is allowed. Each has its own submission
 * id (the `Idempotency-Key`) and its own signed stamp.
 *
 * Sent and not confirmed: `lib/unresolved-tender-command.ts` records that it
 * was sent — a marker, nothing of what it said — and the form is replaced by a
 * view that never says "nothing changed". In this page the same request may be
 * sent again under the same key; after a reload the record is only shown,
 * beside the tender the page read, until the person sets it aside. The owner's
 * commands of a tender share one slot (`heldBy`).
 */

export interface OwnerCommandFormProps {
  readonly tenderId: string;
  readonly command: OwnerCommand;
  /** A publication whose approval is in on this very version: the command executes. */
  readonly execute?: boolean;
  readonly csrfToken: string;
  readonly submissionId: string;
  readonly replay: ReplayStamp | null;
  readonly owner: string;
  readonly pageHref: string;
  readonly initial?: OwnerFormState;
  readonly heldBy?: string | null;
}

export function unconfirmedFrom(restored: UnresolvedOwnerCommand): UnconfirmedOwnerCommand {
  return {
    kind: 'UNCONFIRMED',
    command: restored.command,
    correlationId: restored.correlationId,
    submissionId: restored.submissionId,
    reason: null,
    replay: null,
    viewOnly: true,
    restored: true,
  };
}

/** The label a command is drawn with: a publication approved on this version executes. */
export function ownerLabel(command: OwnerCommand, execute = false): string {
  if (command === 'PUBLISH') return execute ? 'اجرای انتشار (موافقت گرفته شده)' : 'درخواست انتشار';
  return OWNER_COMMAND_LABELS[command];
}

export function OwnerCommandForm({
  tenderId,
  command,
  execute = false,
  csrfToken,
  submissionId,
  replay,
  owner,
  pageHref,
  initial = IDLE_OWNER_FORM,
  heldBy = null,
}: OwnerCommandFormProps) {
  const send = useCallback(
    async (previous: OwnerFormState, form: FormData): Promise<OwnerFormState> => {
      const firstSend = previous.kind !== 'UNCONFIRMED';
      const sent = form.get(SUBMISSION_FIELD);
      const sentId = firstSend ? (typeof sent === 'string' ? sent : '') : previous.submissionId;
      if (firstSend) {
        const holder = restoreUnresolvedOwnerCommand(tenderId, owner);
        if (holder && holder.submissionId !== sentId) return { kind: 'HELD' };
      } else if (previous.viewOnly || previous.restored) {
        return previous;
      } else if (
        restoreUnresolvedOwnerCommand(tenderId, owner)?.submissionId !== previous.submissionId
      ) {
        return { ...previous, viewOnly: true };
      }

      // A rejection whose reason the action would refuse unsent is not remembered.
      const raw = form.get(REASON_FIELD);
      const reason =
        command === 'REJECT'
          ? (() => {
              const parsed = parseRejectReason(typeof raw === 'string' ? raw : '');
              return parsed.ok ? parsed.reason : undefined;
            })()
          : null;
      const sendable = firstSend && reason !== undefined;
      const saved = sendable
        ? saveUnresolvedOwnerCommand(
            tenderId,
            { command, submissionId: sentId, correlationId: null },
            owner,
          )
        : null;
      if (saved === 'HELD') return { kind: 'HELD' };
      if (saved === 'UNAVAILABLE') return { kind: 'STORAGE_UNAVAILABLE' };

      let next: OwnerFormState;
      try {
        next = await submitOwnerCommand(tenderId, previous, form);
      } catch (error) {
        if (isRedirect(error)) {
          clearUnresolvedOwnerCommand(tenderId, sentId);
          throw error;
        }
        const ended = await sessionHasEnded();
        if (!firstSend) return withRetryNote(previous, ended ? 'sessionEnded' : 'retryUnknown');
        if (sendable) {
          return {
            kind: 'UNCONFIRMED',
            command,
            correlationId: null,
            submissionId: sentId,
            reason: reason ?? null,
            replay,
            ...(ended ? { sessionEnded: true as const } : {}),
          };
        }
        throw error;
      }

      if (next.kind === 'UNCONFIRMED') {
        saveUnresolvedOwnerCommand(
          tenderId,
          { command, submissionId: next.submissionId, correlationId: next.correlationId },
          owner,
        );
      } else if (firstSend) {
        clearUnresolvedOwnerCommand(tenderId, sentId);
      }
      return next;
    },
    [tenderId, command, replay, owner],
  );
  const [state, action, pending] = useActionState(send, initial);
  const headingId = `owner-command-${command}`;
  const label = ownerLabel(command, execute);

  if (state.kind === 'UNCONFIRMED') {
    return (
      <UnconfirmedCommand
        state={state}
        label={state.restored ? ownerLabel(state.command) : label}
        action={action}
        pending={pending}
        csrfToken={csrfToken}
        headingId={headingId}
        pageHref={pageHref}
        onForget={() => clearUnresolvedOwnerCommand(tenderId, state.submissionId)}
      />
    );
  }

  const invalid = state.kind === 'INVALID';
  const currentSubmissionId = invalid ? state.submissionId : submissionId;

  if (heldBy !== null && heldBy !== currentSubmissionId) {
    return (
      <section
        aria-labelledby={headingId}
        className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4"
      >
        <h3 id={headingId} className="text-base font-medium">
          {label}
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
        {label}
      </h3>
      <p className="text-sm text-content-muted">{OWNER_COMMAND_CONSEQUENCES[command]}</p>

      <CommandBanner state={state} />

      {command === 'REJECT' ? (
        <Field
          key={invalid ? (state.reason ?? '') : ''}
          label="دلیل رد"
          hint="دست‌کم ۸ نویسه؛ در سابقهٔ موافقت ثبت می‌شود."
          error={invalid ? state.fieldErrors[REASON_FIELD] : undefined}
          required
        >
          {(control) => (
            <textarea
              {...control}
              name={REASON_FIELD}
              rows={3}
              maxLength={REJECT_REASON_MAX}
              defaultValue={invalid ? (state.reason ?? '') : ''}
              className={controlClassName}
            />
          )}
        </Field>
      ) : null}

      <div>
        <Button
          type="submit"
          tone={command === 'REJECT' || command === 'WITHDRAW_PROPOSAL' ? 'secondary' : 'primary'}
          disabled={pending}
        >
          {pending ? 'در حال ارسال…' : label}
        </Button>
      </div>
    </form>
  );
}

const REFUSAL_MESSAGES: Record<Extract<OwnerFormState, { kind: 'REFUSED' }>['reason'], string> = {
  ...SESSION_REFUSAL_MESSAGES,
  REPLAY: 'مهلت این فرم گذشته است و درخواست ارسال نشد. صفحه را تازه کنید و دوباره تلاش کنید.',
  CSRF: 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.',
  SUBMISSION: 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.',
  COMMAND: 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.',
};

/** A 403: its closed reason in fixed words if it named one, else the command's own sentence. */
export function forbiddenText(command: OwnerCommand, reasons: readonly string[]): string {
  for (const reason of reasons) {
    const text = OPENING_REFUSAL_TEXT[reason] ?? APPROVAL_REFUSAL_TEXT[reason];
    if (text) return text;
  }
  return OWNER_FORBIDDEN_TEXT[command];
}

const HELD_MESSAGE =
  'درخواست دیگری روی همین مناقصه فرستاده شده و نتیجه‌اش هنوز معلوم نیست؛ ممکن است انجام شده باشد. تا روشن‌شدن نتیجهٔ آن، این فرم فرستاده نمی‌شود. وضعیت را با تازه‌کردن صفحه ببینید.';

function CommandBanner({ state }: { state: OwnerFormState }) {
  if (state.kind === 'HELD') return <Alert tone="warning">{HELD_MESSAGE}</Alert>;
  if (state.kind === 'INVALID' && state.message) {
    return <Alert tone="warning">{state.message}</Alert>;
  }
  if (state.kind === 'REFUSED') {
    return <Alert tone="danger">{REFUSAL_MESSAGES[state.reason]}</Alert>;
  }
  if (state.kind === 'FORBIDDEN') {
    return (
      <Alert tone="danger">
        {forbiddenText(state.command, state.reasons)} کد پیگیری: {state.correlationId}
      </Alert>
    );
  }
  if (state.kind === 'NOT_FOUND') {
    return (
      <Alert tone="warning">
        این مناقصه یا مرحله دیگر برای شما در دسترس نیست. صفحه را تازه کنید.
      </Alert>
    );
  }
  if (state.kind === 'STORAGE_UNAVAILABLE') {
    return (
      <Alert tone="danger">
        درخواست ارسال نشد: این مرورگر نمی‌تواند ارسال آن را تا روشن‌شدن نتیجه‌اش به خاطر بسپارد
        (مثلاً حالت خصوصی یا حافظهٔ پر). از مرورگر دیگری استفاده کنید یا فضا را آزاد کنید و دوباره
        تلاش کنید.
      </Alert>
    );
  }
  return null;
}

function UnconfirmedCommand({
  state,
  label,
  action,
  pending,
  csrfToken,
  headingId,
  pageHref,
  onForget,
}: {
  state: UnconfirmedOwnerCommand;
  label: string;
  action: (form: FormData) => void;
  pending: boolean;
  csrfToken: string;
  headingId: string;
  pageHref: string;
  onForget: () => void;
}) {
  const canRetry =
    !state.viewOnly && !state.sessionEnded && (state.command !== 'REJECT' || state.reason !== null);
  const canForget = (state.viewOnly || state.retryRefused) && !state.sessionEnded;

  return (
    <form
      action={action}
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4"
    >
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={state.submissionId} />
      <input type="hidden" name={REPLAY_FIELD} value={state.replay?.token ?? ''} />
      {state.reason !== null ? (
        <input type="hidden" name={REASON_FIELD} value={state.reason} />
      ) : null}

      <h3 id={headingId} className="text-base font-medium">
        {label}
      </h3>
      <Alert tone="warning">
        نتوانستیم تأیید کنیم که «{label}» انجام شد یا نه؛ ممکن است انجام شده باشد. پیش از هر کار
        دیگر،{' '}
        <a href={pageHref} className="underline">
          این صفحه را تازه کنید
        </a>{' '}
        و وضعیت مناقصه را ببینید.
        {state.correlationId ? ` کد پیگیری: ${state.correlationId}` : ''}
      </Alert>
      {state.retryRefused ? (
        <Alert tone="warning">
          ارسال دوباره رد شد و این دربارهٔ درخواست نخست چیزی نمی‌گوید: اگر آن انجام شده باشد، تکرارش
          پذیرفته نمی‌شود. با تازه‌کردن صفحه وضعیت مناقصه را ببینید.
        </Alert>
      ) : null}
      {state.retryUnknown ? (
        <Alert tone="warning">
          ارسال دوباره نیز نتیجهٔ روشنی نداشت و وضعیت درخواست نخست همچنان معلوم نیست؛ ممکن است انجام
          شده باشد. با تازه‌کردن صفحه وضعیت مناقصه را ببینید.
        </Alert>
      ) : null}
      {state.sessionEnded ? (
        <Alert tone="danger">
          نشست شما پایان یافته است. دوباره وارد شوید و پیش از هر اقدام تازه وضعیت مناقصه را ببینید؛
          ممکن است درخواست انجام شده باشد.
        </Alert>
      ) : null}
      {state.restored ? (
        <Alert tone="warning">
          این درخواست پیش از تازه‌شدن صفحه فرستاده شد و نتیجه‌اش تأیید نشد. محتوای آن در این مرورگر
          نگه داشته نمی‌شود و همان درخواست دوباره فرستاده نمی‌شود؛ آنچه سرویس اکنون از مناقصه نگه
          می‌دارد در همین صفحه آمده است.
        </Alert>
      ) : state.replayExpired ? (
        <Alert tone="warning">
          مهلت ارسال دوبارهٔ همین درخواست گذشته است و چیزی فرستاده نشد؛ نتیجهٔ درخواست نخست همچنان
          معلوم نیست و ممکن است انجام شده باشد.
        </Alert>
      ) : state.viewOnly ? (
        <Alert tone="warning">
          این درخواست دیگر با اطمینان دوباره فرستاده نمی‌شود؛ ممکن است انجام شده باشد.
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
          <a href={pageHref} onClick={onForget} onAuxClick={onForget} className="text-sm underline">
            وضعیت مناقصه را دیدم؛ این درخواست را کنار بگذار
          </a>
        </div>
      ) : null}
      <p className="text-sm text-content-muted">
        {canRetry
          ? '«ارسال دوباره» همان درخواست را با همان شناسهٔ ارسال می‌فرستد؛ کاری که انجام شده باشد دوباره انجام نمی‌شود. وضعیت ثبت‌شدهٔ مناقصه مرجع است. تا روشن‌شدن نتیجه، اقدام تازه‌ای اینجا عرضه نمی‌شود.'
          : 'وضعیت ثبت‌شدهٔ مناقصه مرجع است.'}
      </p>
    </form>
  );
}
