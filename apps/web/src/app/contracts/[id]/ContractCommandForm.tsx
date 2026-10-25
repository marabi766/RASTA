'use client';

import { useActionState, useCallback } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import {
  AMENDMENT_REASON_MAX,
  CANCEL_NOTE_MAX,
  CONTRACT_COMMAND_CONSEQUENCES,
  CONTRACT_COMMAND_LABELS,
  CONTRACT_FIELD_LABELS,
  CONTRACT_REFUSAL_TEXT,
  MILESTONE_TITLE_MAX,
  SIDE_LABELS,
  type ContractCommand,
  type ContractField,
  type ContractSide,
} from '@/lib/contract-command-fields';
import {
  COMMAND_FIELDS,
  commandFormValues,
  parseCommandInput,
  valuesOfInput,
  type ContractFormValues,
} from '@/lib/contract-command-input';
import { CSRF_FIELD, REPLAY_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { isRedirect, sessionHasEnded, SESSION_REFUSAL_MESSAGES } from '@/lib/session-refusal';
import {
  answerUnresolvedContractCommand,
  clearUnresolvedContractCommand,
  restoreUnresolvedContractCommand,
  saveUnresolvedContractCommand,
  settleUnresolvedContractCommand,
  type ContractScope,
  type ReplayStamp,
  type RestoredContractCommand,
  contractCommandQuarantine,
} from '@/lib/unresolved-contract-command';
import type { Binding } from '@/lib/unresolved-order';

import { submitContractCommand } from './contract-actions';
import {
  IDLE_CONTRACT_FORM,
  withRetryNote,
  type ContractFormState,
  type UnconfirmedContractCommand,
} from './contract-form-state';
import { QuarantineGate } from '@/app/UnresolvedQuarantine';

/**
 * One contract command this viewer may issue — signing or cancelling the
 * contract, proposing or signing an amendment, planning or changing a
 * milestone. The page draws one per command `server/contract-commands.ts`
 * says the service would accept, so this component never decides whether the
 * command is allowed, only what its form looks like. Each instance has its own
 * submission id — the idempotency key contract-service replays on — and its
 * own signed replay stamp.
 *
 * ## Sent and not confirmed
 *
 * `StatementCommandForm`'s pattern: the submission is remembered before it
 * leaves (`lib/unresolved-contract-command.ts`), the form is replaced by a
 * view that never says "nothing changed", and "send the same request again"
 * re-sends the kept input under the kept key; what the command acts on is in
 * the stamp. A confirmed answer redirects and drops the entry; otherwise only
 * the person drops it, once the same request has been tried again or can no
 * longer be.
 *
 * ## One unresolved command per object
 *
 * The contract's sign and cancel forms share one slot. While another
 * submission's outcome is unknown (`heldBy`, kept current by
 * `ContractCommands`), this form draws no button, only the uncertainty notice;
 * and a send is refused here, before anything leaves, whenever the slot holds
 * another submission. A record is cleared only for the submission it belongs
 * to.
 *
 * ## When the call itself fails
 *
 * Only `/auth/session` answering `401` lets the view say the session has
 * ended; any other failure — a refresh that is only unavailable for now
 * included — is "no answer came back", and the same request may still be sent.
 */

export interface ReasonOption {
  readonly code: string;
  readonly label: string;
}

export interface ContractCommandFormProps {
  readonly scope: ContractScope;
  readonly command: ContractCommand;
  /** For a signature: the side it is drawn for. */
  readonly side?: ContractSide | null;
  /** What the form acts on, as a person reads it — «الحاقیهٔ ۲», a milestone's title. */
  readonly subjectLabel?: string | null;
  readonly csrfToken: string;
  readonly submissionId: string;
  /** That submission id's signed replay deadline; null for a restored entry that has none any more. */
  readonly replay: ReplayStamp | null;
  readonly binding: Binding;
  readonly sessionMaxAgeSeconds: number;
  /** The reasons a cancellation or an amendment may name (`WEB_CONTRACT_*_REASON_CODES`). */
  readonly reasons?: readonly ReasonOption[];
  /** What the fields start with — a milestone's current values, for a change. */
  readonly defaults?: ContractFormValues;
  /** The page that shows the outcome — reloaded to see whether the command took. */
  readonly pageHref: string;
  readonly initial?: ContractFormState;
  /** The submission whose outcome is unknown in this slot, if any (`ContractCommands`). */
  readonly heldBy?: string | null;
}

/** The remembered submission as the form's starting state. */
export function unconfirmedFrom(restored: RestoredContractCommand): UnconfirmedContractCommand {
  const { command, correlationId, submissionId, input, replay, marker } = restored.entry;
  return {
    kind: 'UNCONFIRMED',
    command,
    correlationId,
    submissionId,
    input,
    replay,
    ...(restored.kind === 'VIEW_ONLY' ? { viewOnly: true as const } : {}),
    ...(marker ? { marker: true as const } : {}),
  };
}

/** The submission as the action will send it, or null when the action would refuse it unsent. */
function pendingFrom(
  form: FormData,
  command: ContractCommand,
  replay: ReplayStamp | null,
): UnconfirmedContractCommand | null {
  const submissionId = form.get(SUBMISSION_FIELD);
  if (typeof submissionId !== 'string') return null;
  const parsed = parseCommandInput(command, commandFormValues(form, command));
  if (!parsed.ok) return null;
  return {
    kind: 'UNCONFIRMED',
    command,
    correlationId: null,
    submissionId,
    input: parsed.input,
    replay,
  };
}

/** The heading of a command's form: what it does, and to what. */
function titleOf(
  command: ContractCommand,
  side: ContractSide | null,
  subjectLabel: string | null,
): string {
  const parts = [CONTRACT_COMMAND_LABELS[command]];
  if (subjectLabel) parts.push(subjectLabel);
  if (side) parts.push(`از سوی ${SIDE_LABELS[side]}`);
  return parts.join(' — ');
}

/**
 * The form, held behind the device's quarantine of this kind
 * (`app/UnresolvedQuarantine.tsx`): while an earlier request this person
 * cannot be shown has an unknown outcome, the form is replaced by the fixed
 * warning until they accept the duplicate risk.
 */
export function ContractCommandForm(props: ContractCommandFormProps) {
  return (
    <QuarantineGate source={contractCommandQuarantine} account={props.binding}>
      <ContractCommandFormBody {...props} />
    </QuarantineGate>
  );
}

function ContractCommandFormBody({
  scope,
  command,
  side = null,
  subjectLabel = null,
  csrfToken,
  submissionId,
  replay,
  binding,
  sessionMaxAgeSeconds,
  reasons = [],
  defaults = {},
  pageHref,
  initial = IDLE_CONTRACT_FORM,
  heldBy = null,
}: ContractCommandFormProps) {
  const send = useCallback(
    async (previous: ContractFormState, form: FormData): Promise<ContractFormState> => {
      const firstSend = previous.kind !== 'UNCONFIRMED';
      const sent = form.get(SUBMISSION_FIELD);
      const sentId = firstSend ? (typeof sent === 'string' ? sent : '') : previous.submissionId;
      if (firstSend) {
        // Another submission's outcome is unknown here: nothing is sent, and its
        // record is not touched.
        const holder = restoreUnresolvedContractCommand(scope, binding, sessionMaxAgeSeconds);
        if (holder && holder.entry.submissionId !== sentId) return { kind: 'HELD' };
      } else {
        // A replay only while the service still holds its key, and only from
        // the login it is bound to. Past that, never re-sent.
        const stored = restoreUnresolvedContractCommand(scope, binding, sessionMaxAgeSeconds);
        if (stored?.kind !== 'RETRYABLE' || stored.entry.submissionId !== previous.submissionId) {
          return { ...previous, viewOnly: true };
        }
      }

      // Remembered BEFORE it is sent; not sent if it cannot be remembered.
      const unsent = firstSend ? pendingFrom(form, command, replay) : null;
      const saved = unsent ? saveUnresolvedContractCommand(scope, unsent, binding) : null;
      if (saved === 'HELD') return { kind: 'HELD' };
      if (saved === 'UNAVAILABLE') return { kind: 'STORAGE_UNAVAILABLE' };

      let next: ContractFormState;
      try {
        next = await submitContractCommand(scope, previous, form);
      } catch (error) {
        // Done: the action redirects to the contract.
        if (isRedirect(error)) {
          settleUnresolvedContractCommand(scope, sentId, binding);
          throw error;
        }
        const ended = await sessionHasEnded();
        if (!firstSend) return withRetryNote(previous, ended ? 'sessionEnded' : 'retryUnknown');
        if (unsent) return ended ? { ...unsent, sessionEnded: true } : unsent;
        throw error;
      }

      // Still in doubt: kept. A definite answer to THIS submission's first send:
      // its own record is dropped — never another's.
      if (next.kind === 'UNCONFIRMED') answerUnresolvedContractCommand(scope, next, binding);
      else if (firstSend) settleUnresolvedContractCommand(scope, sentId, binding);
      return next;
    },
    [scope, command, replay, binding, sessionMaxAgeSeconds],
  );
  const [state, action, pending] = useActionState(send, initial);
  const headingId = `contract-command-${command}-${scope.subjectId ?? 'contract'}`;
  const title = titleOf(command, side, subjectLabel);

  if (state.kind === 'UNCONFIRMED') {
    return (
      <UnconfirmedCommand
        state={state}
        title={title}
        action={action}
        pending={pending}
        csrfToken={csrfToken}
        headingId={headingId}
        pageHref={pageHref}
        onForget={() => clearUnresolvedContractCommand(scope, state.submissionId, binding)}
      />
    );
  }

  const invalid = state.kind === 'INVALID';
  const currentSubmissionId = invalid ? state.submissionId : submissionId;

  if (heldBy !== null && heldBy !== currentSubmissionId) {
    return <HeldCommand title={title} headingId={headingId} pageHref={pageHref} />;
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
        {title}
      </h3>
      <p className="text-sm text-content-muted">{CONTRACT_COMMAND_CONSEQUENCES[command]}</p>

      <CommandBanner state={state} />

      <CommandFields
        // Drawn again from what came back, so every field shows what was typed.
        key={invalid ? JSON.stringify(state.values) : 'defaults'}
        command={command}
        values={invalid ? state.values : defaults}
        fieldErrors={invalid ? state.fieldErrors : {}}
        reasons={reasons}
      />

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'در حال ارسال…' : CONTRACT_COMMAND_LABELS[command]}
        </Button>
      </div>
    </form>
  );
}

const HINTS: Partial<Record<ContractField, string>> = {
  deltaMinor: 'عدد صحیح مثبت به ریال؛ ارقام فارسی یا لاتین',
  plannedShareBp: 'مثلاً ۲۵ یا ۱۲٫۵؛ خالی یعنی بدون سهم',
};

/** The fields `command` takes, in its order; a signature has none. */
function CommandFields({
  command,
  values,
  fieldErrors,
  reasons,
}: {
  command: ContractCommand;
  values: ContractFormValues;
  fieldErrors: Partial<Record<ContractField, string>>;
  reasons: readonly ReasonOption[];
}) {
  const fields = COMMAND_FIELDS[command];
  if (fields.length === 0) return null;
  const required: readonly ContractField[] = [
    'reasonCode',
    'deltaMinor',
    'reasonText',
    'title',
    'plannedDate',
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map((field) => {
        const wide = field === 'note' || field === 'reasonText' || field === 'title';
        return (
          <Field
            key={field}
            label={CONTRACT_FIELD_LABELS[field]}
            hint={HINTS[field]}
            error={fieldErrors[field]}
            required={required.includes(field)}
            className={wide ? 'sm:col-span-2' : undefined}
          >
            {(control) => {
              const value = values[field] ?? '';
              if (field === 'reasonCode') {
                return (
                  <select
                    {...control}
                    name={field}
                    defaultValue={value}
                    className={controlClassName}
                  >
                    <option value="">انتخاب کنید</option>
                    {reasons.map((reason) => (
                      <option key={reason.code} value={reason.code}>
                        {reason.label}
                      </option>
                    ))}
                  </select>
                );
              }
              if (field === 'note' || field === 'reasonText') {
                return (
                  <textarea
                    {...control}
                    name={field}
                    rows={3}
                    maxLength={field === 'note' ? CANCEL_NOTE_MAX : AMENDMENT_REASON_MAX}
                    defaultValue={value}
                    className={controlClassName}
                  />
                );
              }
              if (field === 'plannedDate') {
                return (
                  <input
                    {...control}
                    type="date"
                    name={field}
                    dir="ltr"
                    defaultValue={value}
                    className={controlClassName}
                  />
                );
              }
              return (
                <input
                  {...control}
                  name={field}
                  autoComplete="off"
                  {...(field === 'title'
                    ? { maxLength: MILESTONE_TITLE_MAX }
                    : { inputMode: field === 'deltaMinor' ? 'numeric' : 'decimal', dir: 'ltr' })}
                  defaultValue={value}
                  className={controlClassName}
                />
              );
            }}
          </Field>
        );
      })}
    </div>
  );
}

/** Nothing was sent in any of these. */
const REFUSAL_MESSAGES: Record<Extract<ContractFormState, { kind: 'REFUSED' }>['reason'], string> =
  {
    ...SESSION_REFUSAL_MESSAGES,
    REPLAY: 'مهلت این فرم گذشته است و درخواست ارسال نشد. صفحه را تازه کنید و دوباره تلاش کنید.',
    CSRF: 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.',
    SUBMISSION: 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.',
    COMMAND: 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.',
  };

/** A 403's closed reasons in fixed words; the first one this portal has words for. */
export function forbiddenText(reasons: readonly string[]): string | null {
  for (const reason of reasons) {
    const text = CONTRACT_REFUSAL_TEXT[reason];
    if (text) return text;
  }
  return null;
}

const HELD_MESSAGE =
  'درخواست دیگری روی همین مورد فرستاده شده و نتیجه‌اش هنوز معلوم نیست؛ ممکن است انجام شده باشد. تا روشن‌شدن نتیجهٔ آن، این فرم فرستاده نمی‌شود. وضعیت را با تازه‌کردن صفحه ببینید.';

/**
 * Another command of this object is unresolved: no form, no button — only
 * what this command would be, and why it waits.
 */
function HeldCommand({
  title,
  headingId,
  pageHref,
}: {
  title: string;
  headingId: string;
  pageHref: string;
}) {
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4"
    >
      <h3 id={headingId} className="text-base font-medium">
        {title}
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

function CommandBanner({ state }: { state: ContractFormState }) {
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
        {forbiddenText(state.reasons) ?? 'این اقدام در اختیار شما نیست.'} کد پیگیری:{' '}
        {state.correlationId}
      </Alert>
    );
  }
  if (state.kind === 'NOT_FOUND') {
    return <Alert tone="warning">این مورد یا قرارداد دیگر در دسترس نیست. صفحه را تازه کنید.</Alert>;
  }
  if (state.kind === 'STORAGE_UNAVAILABLE') {
    return (
      <Alert tone="danger">
        درخواست ارسال نشد: این مرورگر نمی‌تواند درخواست را تا روشن‌شدن نتیجه‌اش به خاطر بسپارد
        (مثلاً حالت خصوصی یا حافظهٔ پر)، و بی آن ممکن است یک الحاقیه یا Milestone دو بار ثبت شود. از
        مرورگر دیگری استفاده کنید یا فضا را آزاد کنید و دوباره تلاش کنید.
      </Alert>
    );
  }
  return null;
}

/**
 * Sent, maybe done, not confirmed. The retry re-sends the kept input under the
 * kept submission id; the page, reloaded, is the reference.
 */
function UnconfirmedCommand({
  state,
  title,
  action,
  pending,
  csrfToken,
  headingId,
  pageHref,
  onForget,
}: {
  state: UnconfirmedContractCommand;
  title: string;
  action: (form: FormData) => void;
  pending: boolean;
  csrfToken: string;
  headingId: string;
  pageHref: string;
  onForget: () => void;
}) {
  const canRetry = !state.viewOnly && !state.sessionEnded;
  const canForget = (state.viewOnly || state.retryRefused) && !state.sessionEnded;
  const what = CONTRACT_COMMAND_LABELS[state.command];
  const kept = Object.entries(valuesOfInput(state.command, state.input));

  return (
    <form
      action={action}
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4"
    >
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={state.submissionId} />
      <input type="hidden" name={REPLAY_FIELD} value={state.replay?.token ?? ''} />
      {kept.map(([field, value]) => (
        <input key={field} type="hidden" name={field} value={value ?? ''} />
      ))}

      <h3 id={headingId} className="text-base font-medium">
        {title}
      </h3>
      <Alert tone="warning">
        نتوانستیم تأیید کنیم که «{what}» انجام شد یا نه؛ ممکن است انجام شده باشد. پیش از هر کار
        دیگر،{' '}
        <a href={pageHref} className="underline">
          این صفحه را تازه کنید
        </a>{' '}
        و وضعیت قرارداد را ببینید.
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
          {/* A full navigation: the page reads the contract again and offers what it allows. */}
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
