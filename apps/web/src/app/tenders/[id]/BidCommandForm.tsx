'use client';

import { useActionState, useCallback } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import {
  BID_ANSWER_MAX,
  BID_COMMAND_CONSEQUENCES,
  BID_COMMAND_LABELS,
  BID_NOTE_MAX,
  BID_REFUSAL_TEXT,
  NOTE_FIELD,
  PRICE_FIELD,
  UNREPEATABLE_BID_COMMANDS,
  answerField,
  criterionField,
  type BidCommand,
} from '@/lib/bid-fields';
import { bidFormValues, parseBid, type BidFormValues } from '@/lib/bid-input';
import { CSRF_FIELD, REPLAY_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { toPersianDigits } from '@/lib/format';
import { isRedirect, sessionHasEnded, SESSION_REFUSAL_MESSAGES } from '@/lib/session-refusal';
import {
  answerUnresolvedBid,
  clearUnresolvedBid,
  restoreUnresolvedBid,
  saveUnresolvedBid,
  settleUnresolvedBid,
  type ReplayStamp,
  type UnresolvedBid,
  bidQuarantine,
} from '@/lib/unresolved-bid';

import { submitBidCommand } from './bid-actions';
import {
  IDLE_BID_FORM,
  withRetryNote,
  type BidFormState,
  type UnconfirmedBid,
} from './bid-form-state';
import type { Binding } from '@/lib/unresolved-tenancy';
import { QuarantineGate } from '@/app/UnresolvedQuarantine';

/**
 * One bid command this contractor may issue on a tender — submitting the
 * organization's bid, replacing it, or withdrawing it. The page draws one per
 * command `server/tender-bids.ts` says the service would accept, so this
 * component never decides whether the command is allowed, only what its form
 * looks like. Each has its own submission id (the `Idempotency-Key`) and its
 * own signed replay stamp.
 *
 * ## Sent and not confirmed
 *
 * The statement forms' pattern, with nothing of the bid stored: before the
 * request leaves, `lib/unresolved-bid.ts` records **that** it was sent — the
 * command and the key, never the price, the answers or the note — and the form
 * is replaced by a view that never says "nothing changed". In this page,
 * "send the same request again" re-sends what the first send carried, held in
 * memory, under the same key; a submission is then answered with its stored
 * receipt. After a reload the content is gone with the page, so the record is
 * only shown, beside the receipt the page read, until the person sets it aside.
 *
 * ## One unresolved command per tender
 *
 * The submit, replace and withdraw forms share one slot: while another
 * submission's outcome is unknown (`heldBy`), this form draws no button, and a
 * send is refused here, before anything leaves, whenever the slot holds
 * another submission. A record is cleared only by the submission it belongs to.
 */

export interface CriterionOption {
  readonly code: string;
  readonly label: string;
}

export interface BidCommandFormProps {
  readonly tenderId: string;
  readonly command: BidCommand;
  /** The tender's frozen criteria, in order; a submission and a replacement answer them. */
  readonly criteria: readonly CriterionOption[];
  readonly csrfToken: string;
  readonly submissionId: string;
  /** That submission id's signed replay deadline; null for a restored record. */
  readonly replay: ReplayStamp | null;
  /** This person's one-way tags for this organization (`submissionBinding`). */
  readonly account: Binding;
  /** The page that shows the outcome — reloaded to read the bid's receipt. */
  readonly pageHref: string;
  readonly initial?: BidFormState;
  /** The submission whose outcome is unknown on this tender, if any (`BidCommands`). */
  readonly heldBy?: string | null;
}

/**
 * Why a replacement or a withdrawal whose outcome is unknown is not sent again
 * (`UNREPEATABLE_BID_COMMANDS`).
 */
export const UNREPEATABLE_BID_TEXT =
  'جایگزینی یا انصرافی که نتیجه‌اش معلوم نیست دوباره فرستاده نمی‌شود: ارسال دوباره روی پیشنهاد سازمان آن‌طور که در آن لحظه است عمل می‌کند، که ممکن است از صفحهٔ دیگری تغییر کرده باشد. رسید پیشنهاد را با تازه‌کردن صفحه ببینید و اگر لازم بود از نو اقدام کنید.';

/** A record restored after a reload, as the form's starting state: view-only. */
export function unconfirmedFrom(restored: UnresolvedBid): UnconfirmedBid {
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

/** What the action will send, or null for a form it would refuse unsent (a content that does not parse). */
function sendable(form: FormData, command: BidCommand): BidFormValues | 'WITHDRAW' | null {
  if (command === 'WITHDRAW') return 'WITHDRAW';
  const values = bidFormValues(form);
  return parseBid(values).ok ? values : null;
}

/**
 * The form, held behind the device's quarantine of this kind
 * (`app/UnresolvedQuarantine.tsx`): while an earlier request this person
 * cannot be shown has an unknown outcome, the form is replaced by the fixed
 * warning until they accept the duplicate risk.
 */
export function BidCommandForm(props: BidCommandFormProps) {
  return (
    <QuarantineGate source={bidQuarantine} account={props.account}>
      <BidCommandFormBody {...props} />
    </QuarantineGate>
  );
}

function BidCommandFormBody({
  tenderId,
  command,
  criteria,
  csrfToken,
  submissionId,
  replay,
  account,
  pageHref,
  initial = IDLE_BID_FORM,
  heldBy = null,
}: BidCommandFormProps) {
  const send = useCallback(
    async (previous: BidFormState, form: FormData): Promise<BidFormState> => {
      const firstSend = previous.kind !== 'UNCONFIRMED';
      const sent = form.get(SUBMISSION_FIELD);
      const sentId = firstSend ? (typeof sent === 'string' ? sent : '') : previous.submissionId;
      if (firstSend) {
        // Another submission's outcome is unknown here: nothing is sent, and its
        // record is not touched.
        const holder = restoreUnresolvedBid(tenderId, account);
        if (holder && holder.submissionId !== sentId) return { kind: 'HELD' };
      } else if (previous.viewOnly || previous.restored) {
        return previous;
      } else if (restoreUnresolvedBid(tenderId, account)?.submissionId !== previous.submissionId) {
        // The record was set aside elsewhere: this view no longer re-sends.
        return { ...previous, viewOnly: true };
      }

      // Remembered BEFORE it is sent; not sent if it cannot be remembered.
      const unsent = firstSend ? sendable(form, command) : null;
      const saved = unsent
        ? saveUnresolvedBid(
            tenderId,
            { command, submissionId: sentId, correlationId: null },
            account,
          )
        : null;
      if (saved === 'HELD') return { kind: 'HELD' };
      if (saved === 'UNAVAILABLE') return { kind: 'STORAGE_UNAVAILABLE' };

      let next: BidFormState;
      try {
        next = await submitBidCommand(tenderId, previous, form);
      } catch (error) {
        // Done: the action redirects to the tender.
        if (isRedirect(error)) {
          settleUnresolvedBid(tenderId, sentId, account);
          throw error;
        }
        const ended = await sessionHasEnded();
        if (!firstSend) return withRetryNote(previous, ended ? 'sessionEnded' : 'retryUnknown');
        if (unsent) {
          const values = unsent === 'WITHDRAW' ? null : unsent;
          return UNREPEATABLE_BID_COMMANDS.includes(command)
            ? {
                kind: 'UNCONFIRMED',
                command,
                correlationId: null,
                submissionId: sentId,
                values,
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
                values,
                replay,
                ...(ended ? { sessionEnded: true as const } : {}),
              };
        }
        throw error;
      }

      // Still in doubt: kept. A definite answer to THIS submission's first send:
      // its own record is dropped — never another's.
      if (next.kind === 'UNCONFIRMED') {
        answerUnresolvedBid(
          tenderId,
          { command, submissionId: next.submissionId, correlationId: next.correlationId },
          account,
        );
      } else if (firstSend) {
        settleUnresolvedBid(tenderId, sentId, account);
      }
      return next;
    },
    [tenderId, command, replay, account],
  );
  const [state, action, pending] = useActionState(send, initial);
  const headingId = `bid-command-${command}`;

  if (state.kind === 'UNCONFIRMED') {
    return (
      <UnconfirmedCommand
        state={state}
        action={action}
        pending={pending}
        csrfToken={csrfToken}
        headingId={headingId}
        pageHref={pageHref}
        onForget={() => clearUnresolvedBid(tenderId, state.submissionId, account)}
      />
    );
  }

  const invalid = state.kind === 'INVALID';
  const currentSubmissionId = invalid ? state.submissionId : submissionId;

  if (heldBy !== null && heldBy !== currentSubmissionId) {
    return <HeldCommand command={command} headingId={headingId} pageHref={pageHref} />;
  }

  const values = invalid ? state.values : null;

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
        {BID_COMMAND_LABELS[command]}
      </h3>
      <p className="text-sm text-content-muted">{BID_COMMAND_CONSEQUENCES[command]}</p>

      <CommandBanner state={state} />

      {command === 'WITHDRAW' ? null : (
        <ContentFields
          // A new answer redraws the fields with what came back.
          key={JSON.stringify(values)}
          criteria={criteria}
          values={values}
          fieldErrors={invalid ? state.fieldErrors : {}}
        />
      )}

      <div>
        <Button
          type="submit"
          tone={command === 'WITHDRAW' ? 'secondary' : 'primary'}
          disabled={pending}
        >
          {pending ? 'در حال ارسال…' : BID_COMMAND_LABELS[command]}
        </Button>
      </div>
    </form>
  );
}

function ContentFields({
  criteria,
  values,
  fieldErrors,
}: {
  criteria: readonly CriterionOption[];
  values: BidFormValues | null;
  fieldErrors: Partial<Record<string, string>>;
}) {
  const answerOf = (code: string): string =>
    values?.answers.find((answer) => answer.criterionCode === code)?.response ?? '';
  return (
    <>
      <Field
        label="مبلغ پیشنهاد (ریال)"
        hint="عدد صحیح به ریال؛ ارقام فارسی یا لاتین."
        error={fieldErrors[PRICE_FIELD]}
        required
      >
        {(control) => (
          <input
            {...control}
            name={PRICE_FIELD}
            inputMode="numeric"
            autoComplete="off"
            dir="ltr"
            defaultValue={values?.priceMinor ?? ''}
            className={controlClassName}
          />
        )}
      </Field>

      {criteria.length > 0 ? (
        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">پاسخ به معیارهای ارزیابی</legend>
          <p className="text-sm text-content-muted">
            پاسخ به هر معیار اختیاری است؛ پاسخ خالی فرستاده نمی‌شود.
          </p>
          {criteria.map((criterion, row) => (
            <Field
              key={criterion.code}
              label={criterion.label}
              hint={`حداکثر ${toPersianDigits(String(BID_ANSWER_MAX))} نویسه.`}
              error={fieldErrors[answerField(row)]}
            >
              {(control) => (
                <>
                  <input type="hidden" name={criterionField(row)} value={criterion.code} />
                  <textarea
                    {...control}
                    name={answerField(row)}
                    rows={3}
                    maxLength={BID_ANSWER_MAX}
                    defaultValue={answerOf(criterion.code)}
                    className={controlClassName}
                  />
                </>
              )}
            </Field>
          ))}
        </fieldset>
      ) : null}

      <Field label="یادداشت" hint="اختیاری." error={fieldErrors[NOTE_FIELD]}>
        {(control) => (
          <textarea
            {...control}
            name={NOTE_FIELD}
            rows={3}
            maxLength={BID_NOTE_MAX}
            defaultValue={values?.note ?? ''}
            className={controlClassName}
          />
        )}
      </Field>
    </>
  );
}

/** Nothing was sent in any of these. */
const REFUSAL_MESSAGES: Record<Extract<BidFormState, { kind: 'REFUSED' }>['reason'], string> = {
  ...SESSION_REFUSAL_MESSAGES,
  REPLAY: 'مهلت این فرم گذشته است و درخواست ارسال نشد. صفحه را تازه کنید و دوباره تلاش کنید.',
  CSRF: 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.',
  SUBMISSION: 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.',
  COMMAND: 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.',
};

/** A 403's closed reasons in fixed words; the first one this portal has words for. */
export function forbiddenText(reasons: readonly string[]): string | null {
  for (const reason of reasons) {
    const text = BID_REFUSAL_TEXT[reason];
    if (text) return text;
  }
  return null;
}

const HELD_MESSAGE =
  'درخواست دیگری روی پیشنهاد همین مناقصه فرستاده شده و نتیجه‌اش هنوز معلوم نیست؛ ممکن است انجام شده باشد. تا روشن‌شدن نتیجهٔ آن، این فرم فرستاده نمی‌شود. وضعیت را با تازه‌کردن صفحه ببینید.';

function HeldCommand({
  command,
  headingId,
  pageHref,
}: {
  command: BidCommand;
  headingId: string;
  pageHref: string;
}) {
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4"
    >
      <h3 id={headingId} className="text-base font-medium">
        {BID_COMMAND_LABELS[command]}
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

function CommandBanner({ state }: { state: BidFormState }) {
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
        {forbiddenText(state.reasons) ?? 'ثبت یا تغییر پیشنهاد در اختیار شما نیست.'} کد پیگیری:{' '}
        {state.correlationId}
      </Alert>
    );
  }
  if (state.kind === 'NOT_FOUND') {
    return (
      <Alert tone="warning">
        این مناقصه یا پیشنهاد دیگر برای شما در دسترس نیست. صفحه را تازه کنید.
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

/** The hidden fields that make a retry the same request as the first send. */
function SentValues({ values }: { values: BidFormValues }) {
  return (
    <span hidden>
      <input type="hidden" name={PRICE_FIELD} value={values.priceMinor} />
      <input type="hidden" name={NOTE_FIELD} value={values.note} />
      {values.answers.map((answer, row) => (
        <span key={row}>
          <input type="hidden" name={criterionField(row)} value={answer.criterionCode} />
          <input type="hidden" name={answerField(row)} value={answer.response} />
        </span>
      ))}
    </span>
  );
}

/**
 * Sent, maybe done, not confirmed. The retry re-sends the kept request under
 * the kept submission id; the bid's receipt, read again, is the reference.
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
  state: UnconfirmedBid;
  action: (form: FormData) => void;
  pending: boolean;
  csrfToken: string;
  headingId: string;
  pageHref: string;
  onForget: () => void;
}) {
  const canRetry =
    !state.viewOnly &&
    !state.sessionEnded &&
    (state.command === 'WITHDRAW' || state.values !== null);
  const canForget = (state.viewOnly || state.retryRefused) && !state.sessionEnded;
  const what = BID_COMMAND_LABELS[state.command];

  return (
    <form
      action={action}
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4"
    >
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={state.submissionId} />
      <input type="hidden" name={REPLAY_FIELD} value={state.replay?.token ?? ''} />
      {state.values ? <SentValues values={state.values} /> : null}

      <h3 id={headingId} className="text-base font-medium">
        {what}
      </h3>
      <Alert tone="warning">
        نتوانستیم تأیید کنیم که «{what}» انجام شد یا نه؛ ممکن است انجام شده باشد. پیش از هر کار
        دیگر،{' '}
        <a href={pageHref} className="underline">
          این صفحه را تازه کنید
        </a>{' '}
        و رسید پیشنهاد سازمان خود را ببینید.
        {state.correlationId ? ` کد پیگیری: ${state.correlationId}` : ''}
      </Alert>
      {state.retryRefused ? (
        <Alert tone="warning">
          ارسال دوباره رد شد و این دربارهٔ درخواست نخست چیزی نمی‌گوید: اگر آن انجام شده باشد، تکرارش
          پذیرفته نمی‌شود. با تازه‌کردن صفحه رسید پیشنهاد را ببینید.
        </Alert>
      ) : null}
      {state.retryUnknown ? (
        <Alert tone="warning">
          ارسال دوباره نیز نتیجهٔ روشنی نداشت و وضعیت درخواست نخست همچنان معلوم نیست؛ ممکن است انجام
          شده باشد. با تازه‌کردن صفحه رسید پیشنهاد را ببینید.
        </Alert>
      ) : null}
      {state.sessionEnded ? (
        <Alert tone="danger">
          نشست شما پایان یافته است. دوباره وارد شوید و پیش از هر اقدام تازه رسید پیشنهاد را ببینید؛
          ممکن است درخواست انجام شده باشد.
        </Alert>
      ) : null}
      {state.unrepeatable ? (
        <Alert tone="warning">{UNREPEATABLE_BID_TEXT}</Alert>
      ) : state.restored ? (
        <Alert tone="warning">
          این درخواست پیش از تازه‌شدن صفحه فرستاده شد و نتیجه‌اش تأیید نشد. محتوای پیشنهاد در این
          مرورگر نگه داشته نمی‌شود و همان درخواست دوباره فرستاده نمی‌شود؛ آنچه سرویس اکنون از
          پیشنهاد سازمان شما نگه می‌دارد در همین صفحه آمده است.
        </Alert>
      ) : state.replayExpired ? (
        <Alert tone="warning">
          مهلت ارسال دوبارهٔ همین درخواست گذشته است و چیزی فرستاده نشد؛ نتیجهٔ درخواست نخست همچنان
          معلوم نیست و ممکن است انجام شده باشد. رسید پیشنهاد را ببینید.
        </Alert>
      ) : state.viewOnly ? (
        <Alert tone="warning">
          این درخواست دیگر با اطمینان دوباره فرستاده نمی‌شود؛ ممکن است انجام شده باشد. رسید پیشنهاد
          را ببینید.
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
          {/* A full navigation: the page reads the bid again and offers what it allows. */}
          <a href={pageHref} onClick={onForget} onAuxClick={onForget} className="text-sm underline">
            رسید پیشنهاد را دیدم؛ این درخواست را کنار بگذار
          </a>
        </div>
      ) : null}
      <p className="text-sm text-content-muted">
        {canRetry
          ? '«ارسال دوباره» همان درخواست را با همان شناسهٔ ارسال و همان محتوا می‌فرستد؛ پیشنهادی که ثبت شده باشد دوباره ثبت نمی‌شود. رسید پیشنهاد مرجع است. تا روشن‌شدن نتیجه، اقدام تازه‌ای اینجا عرضه نمی‌شود.'
          : 'رسید پیشنهاد، آن‌طور که سرویس نگه می‌دارد، مرجع است.'}
      </p>
    </form>
  );
}
