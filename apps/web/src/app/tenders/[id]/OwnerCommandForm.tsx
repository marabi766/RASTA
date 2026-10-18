'use client';

import { useActionState, useCallback, type ReactNode } from 'react';

import { Alert, Button, Field, Identifier, IsolatedText, controlClassName } from '@/ui';
import { CSRF_FIELD, REPLAY_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { formatScaledDecimal, toPersianDigits } from '@/lib/format';
import { isRedirect, sessionHasEnded, SESSION_REFUSAL_MESSAGES } from '@/lib/session-refusal';
import {
  DISQUALIFICATION_REASON_LABELS,
  DISQUALIFY_TEXT_MAX,
  JUSTIFICATION_FIELD,
  JUSTIFICATION_MAX,
  REASON_CODE_FIELD,
  REASON_TEXT_FIELD,
  SCORE_SCALE,
  scoreField,
} from '@/lib/tender-evaluation-fields';
import {
  OWNER_COMMAND_CONSEQUENCES,
  OWNER_COMMAND_LABELS,
  OWNER_FORBIDDEN_TEXT,
  REASON_FIELD,
  REJECTION_COMMANDS,
  REJECT_REASON_MAX,
  UNREPEATABLE_OWNER_COMMANDS,
  refusalTextFor,
  type OwnerCommand,
} from '@/lib/tender-owner-fields';
import {
  ownerFields,
  ownerFormContext,
  ownerValuesOf,
  parseOwnerForm,
  scoreMessage,
  type OwnerValues,
  type ScoringCell,
} from '@/lib/tender-owner-input';
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
 * One command the owner's side may issue on a tender — publish, decide a
 * step, one of the opening's three, decide on or score a bid, complete the
 * evaluation, award. The page draws one per command `server/tender-owner.ts`
 * and `server/tender-evaluation.ts` say the service would accept; this
 * component never decides whether it is allowed. Each has its own submission
 * id (the `Idempotency-Key`) and its own signed stamp.
 *
 * Sent and not confirmed: `lib/unresolved-tender-command.ts` records that it
 * was sent — a marker, nothing of what it said — and the form is replaced by a
 * view that never says "nothing changed". In this page the same request may be
 * sent again under the same key, unless the command is one never sent again
 * (`UNREPEATABLE_OWNER_COMMANDS`); after a reload the record is only shown,
 * beside the tender the page read, until the person sets it aside. The owner's
 * commands of a tender share one slot (`heldBy`).
 */

/** One criterion of a scoring form, as the page read it. */
export interface ScoreRow {
  readonly cell: ScoringCell;
  readonly label: string;
  /** The caller's own standing score, × 100; null for a cell not yet scored. */
  readonly current: number | null;
}

/** An award form's terms, as the page read them (`AwardTerms`). */
export interface AwardFormTerms {
  readonly justificationRequired: boolean;
  readonly execution: { readonly justification: string | null } | null;
}

export interface OwnerCommandFormProps {
  readonly tenderId: string;
  readonly command: OwnerCommand;
  /** A publication whose approval is in on this very version: the command executes. */
  readonly execute?: boolean;
  /** What the command is about, said after its label — the bidder of a bid's command. */
  readonly subject?: string;
  /** Makes the form's ids its own where one command is drawn per bid. */
  readonly scope?: string;
  readonly scoreRows?: readonly ScoreRow[];
  readonly award?: AwardFormTerms;
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
    values: null,
    replay: null,
    viewOnly: true,
    restored: true,
  };
}

/** The label a command is drawn with: a gated command approved on this version executes. */
export function ownerLabel(command: OwnerCommand, execute = false): string {
  if (command === 'PUBLISH') return execute ? 'اجرای انتشار (موافقت گرفته شده)' : 'درخواست انتشار';
  if (command === 'AWARD' && execute) return 'اجرای واگذاری (موافقت گرفته شده)';
  return OWNER_COMMAND_LABELS[command];
}

const idPart = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '_');

export function OwnerCommandForm({
  tenderId,
  command,
  execute = false,
  subject,
  scope,
  scoreRows,
  award,
  csrfToken,
  submissionId,
  replay,
  owner,
  pageHref,
  initial = IDLE_OWNER_FORM,
  heldBy = null,
}: OwnerCommandFormProps) {
  const scoring = scoreRows?.map(({ cell }) => cell) ?? null;
  const context = ownerFormContext({ scoring, award: award ?? null });
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

      // A form the action would refuse unsent is not remembered.
      const parsed = parseOwnerForm(command, ownerValuesOf(command, form, context), context);
      const sendable = firstSend && parsed.ok;
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
          return UNREPEATABLE_OWNER_COMMANDS.includes(command)
            ? {
                kind: 'UNCONFIRMED',
                command,
                correlationId: null,
                submissionId: sentId,
                values: null,
                replay: null,
                viewOnly: true,
                unrepeatable: true,
                ...(ended ? { sessionEnded: true as const } : {}),
              }
            : {
                kind: 'UNCONFIRMED',
                command,
                correlationId: null,
                submissionId: sentId,
                values: parsed.ok ? parsed.values : null,
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
    // `context` is the props' own: a new one each render says nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tenderId, command, replay, owner, scoreRows, award],
  );
  const [state, action, pending] = useActionState(send, initial);
  const headingId = `owner-command-${command}${scope ? `-${idPart(scope)}` : ''}`;
  const label = ownerLabel(command, execute);
  const heading = (
    <h3 id={headingId} className="text-base font-medium">
      {label}
      {subject ? (
        <>
          {' — '}
          <Identifier>{subject}</Identifier>
        </>
      ) : null}
    </h3>
  );

  if (state.kind === 'UNCONFIRMED') {
    return (
      <UnconfirmedCommand
        state={state}
        label={state.restored ? ownerLabel(state.command) : label}
        heading={state.restored ? undefined : heading}
        needsValues={ownerFields(state.command, context).length > 0}
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
        {heading}
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

      {heading}
      <p className="text-sm text-content-muted">{OWNER_COMMAND_CONSEQUENCES[command]}</p>

      <CommandBanner state={state} />

      <CommandFields
        key={invalid ? JSON.stringify(state.values) : ''}
        command={command}
        values={invalid ? state.values : null}
        errors={invalid ? state.fieldErrors : {}}
        scoreRows={scoreRows ?? []}
        award={award}
      />

      <div>
        <Button
          type="submit"
          tone={
            REJECTION_COMMANDS.includes(command) ||
            command === 'WITHDRAW_PROPOSAL' ||
            command === 'DISQUALIFY'
              ? 'secondary'
              : 'primary'
          }
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
  const table = refusalTextFor(command);
  for (const reason of reasons) {
    const text = table[reason];
    if (text) return text;
  }
  return OWNER_FORBIDDEN_TEXT[command];
}

/**
 * Why a command whose outcome is unknown is not sent again
 * (`UNREPEATABLE_OWNER_COMMANDS`).
 */
export const UNREPEATABLE_OWNER_TEXT =
  'این درخواست، وقتی نتیجه‌اش معلوم نیست، دوباره فرستاده نمی‌شود: سرویس نتیجهٔ آن را به شناسهٔ ارسال نگه نمی‌دارد و ارسال دوباره روی مناقصه آن‌طور که در آن لحظه است عمل می‌کند — مثلاً دور موافقت تازه‌ای باز می‌کند، یا پیشنهاد گشایش دیگری را پس می‌گیرد یا تأیید می‌کند. وضعیت را با تازه‌کردن صفحه ببینید و اگر لازم بود از نو اقدام کنید.';

/** What a command asks of the person besides the button, as typed so far. */
function CommandFields({
  command,
  values,
  errors,
  scoreRows,
  award,
}: {
  command: OwnerCommand;
  values: OwnerValues | null;
  errors: Partial<Record<string, string>>;
  scoreRows: readonly ScoreRow[];
  award?: AwardFormTerms;
}) {
  const typed = (name: string): string | undefined => values?.[name];
  if (REJECTION_COMMANDS.includes(command)) {
    return (
      <Field
        label="دلیل رد"
        hint="دست‌کم ۸ نویسه؛ در سابقهٔ موافقت ثبت می‌شود."
        error={errors[REASON_FIELD]}
        required
      >
        {(control) => (
          <textarea
            {...control}
            name={REASON_FIELD}
            rows={3}
            maxLength={REJECT_REASON_MAX}
            defaultValue={typed(REASON_FIELD) ?? ''}
            className={controlClassName}
          />
        )}
      </Field>
    );
  }
  if (command === 'DISQUALIFY') {
    return (
      <>
        <Field label="دلیل" error={errors[REASON_CODE_FIELD]} required>
          {(control) => (
            <select
              {...control}
              name={REASON_CODE_FIELD}
              defaultValue={typed(REASON_CODE_FIELD) ?? ''}
              className={controlClassName}
            >
              <option value="">— برگزینید —</option>
              {Object.entries(DISQUALIFICATION_REASON_LABELS).map(([code, text]) => (
                <option key={code} value={code}>
                  {text}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          label="شرح دلیل"
          hint="در سامانه نگه داشته می‌شود و به پیشنهاددهنده نشان داده نمی‌شود."
          error={errors[REASON_TEXT_FIELD]}
          required
        >
          {(control) => (
            <textarea
              {...control}
              name={REASON_TEXT_FIELD}
              rows={3}
              maxLength={DISQUALIFY_TEXT_MAX}
              defaultValue={typed(REASON_TEXT_FIELD) ?? ''}
              className={controlClassName}
            />
          )}
        </Field>
      </>
    );
  }
  if (command === 'SCORE') {
    return (
      <>
        {scoreRows.map(({ cell, label, current }) => {
          const field = scoreField(cell.criterionCode);
          const standing = current === null ? '' : formatScaledDecimal(String(current), 2);
          const hint = `${scoreMessage(cell)} ${
            current === null ? 'هنوز امتیازی نداده‌اید.' : `امتیاز کنونی شما: ${standing}.`
          } خالی بماند، در این ارسال امتیاز نمی‌گیرد.`;
          return (
            <Field
              key={cell.criterionCode}
              label={<IsolatedText>{label}</IsolatedText>}
              hint={hint}
              error={errors[field]}
            >
              {(control) =>
                cell.passFail ? (
                  <select
                    {...control}
                    name={field}
                    defaultValue={
                      typed(field) ?? (current === null ? '' : String(current / SCORE_SCALE))
                    }
                    className={controlClassName}
                  >
                    <option value="">— بی‌امتیاز در این ارسال —</option>
                    <option value="0">رد ({toPersianDigits('0')})</option>
                    <option value={String(cell.maxScore)}>
                      قبول ({formatScaledDecimal(String(cell.maxScore), 0)})
                    </option>
                  </select>
                ) : (
                  <input
                    {...control}
                    name={field}
                    inputMode="decimal"
                    autoComplete="off"
                    defaultValue={typed(field) ?? standing}
                    className={controlClassName}
                  />
                )
              }
            </Field>
          );
        })}
      </>
    );
  }
  if (command === 'AWARD' && award) {
    if (award.execution) {
      return award.execution.justification === null ? (
        <p className="text-sm">درخواستِ موافقت‌شده دلیلی نداشت؛ همان اجرا می‌شود.</p>
      ) : (
        <p className="whitespace-pre-line text-sm">
          دلیل درخواستِ موافقت‌شده، که همان اجرا می‌شود:{' '}
          <IsolatedText>{award.execution.justification}</IsolatedText>
        </p>
      );
    }
    return (
      <Field
        label="دلیل انتخاب"
        hint={
          award.justificationRequired
            ? 'این پیشنهاد تنها رتبهٔ نخست ماتریس نیست؛ انتخاب آن دلیل نوشته لازم دارد. دلیل در سامانه نگه داشته می‌شود و به پیشنهاددهندگان نشان داده نمی‌شود.'
            : 'اختیاری برای تنها رتبهٔ نخست. دلیل در سامانه نگه داشته می‌شود و به پیشنهاددهندگان نشان داده نمی‌شود.'
        }
        error={errors[JUSTIFICATION_FIELD]}
        required={award.justificationRequired}
      >
        {(control) => (
          <textarea
            {...control}
            name={JUSTIFICATION_FIELD}
            rows={3}
            maxLength={JUSTIFICATION_MAX}
            defaultValue={typed(JUSTIFICATION_FIELD) ?? ''}
            className={controlClassName}
          />
        )}
      </Field>
    );
  }
  return null;
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
  heading,
  needsValues,
  action,
  pending,
  csrfToken,
  headingId,
  pageHref,
  onForget,
}: {
  state: UnconfirmedOwnerCommand;
  label: string;
  heading?: ReactNode;
  /** Whether a re-send needs the fields as first sent: without them there is nothing to re-send. */
  needsValues: boolean;
  action: (form: FormData) => void;
  pending: boolean;
  csrfToken: string;
  headingId: string;
  pageHref: string;
  onForget: () => void;
}) {
  const canRetry =
    !state.viewOnly && !state.sessionEnded && (!needsValues || state.values !== null);
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
      {Object.entries(state.values ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      {heading ?? (
        <h3 id={headingId} className="text-base font-medium">
          {label}
        </h3>
      )}
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
      {state.unrepeatable ? (
        <Alert tone="warning">{UNREPEATABLE_OWNER_TEXT}</Alert>
      ) : state.restored ? (
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
