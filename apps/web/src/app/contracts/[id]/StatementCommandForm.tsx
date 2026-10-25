'use client';

import { useActionState, useCallback, useState } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { CSRF_FIELD, REPLAY_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { isRedirect, sessionHasEnded, SESSION_REFUSAL_MESSAGES } from '@/lib/session-refusal';
import { draftFormLines, parseDraft, rowsOfLines } from '@/lib/statement-draft';
import {
  EMPTY_LINE,
  FORM_LINE_ROWS,
  LINE_FIELD_LABELS,
  STATEMENT_COMMAND_CONSEQUENCES,
  STATEMENT_COMMAND_LABELS,
  STATEMENT_REFUSAL_TEXT,
  lineField,
  rowLabel,
  type StatementCommand,
  type StatementLineValues,
} from '@/lib/statement-fields';
import {
  clearUnresolvedStatement,
  restoreUnresolvedStatement,
  saveUnresolvedStatement,
  type ReplayStamp,
  type RestoredStatement,
  type StatementScope,
  statementQuarantine,
} from '@/lib/unresolved-statement';
import type { Binding } from '@/lib/unresolved-order';

import { submitStatementCommand, submitStatementDraft } from './statement-actions';
import {
  IDLE_STATEMENT_FORM,
  withRetryNote,
  type StatementFormState,
  type UnconfirmedStatement,
} from './statement-form-state';
import { QuarantineGate } from '@/app/UnresolvedQuarantine';

/**
 * One statement command this viewer may issue — drafting a statement of the
 * contract, or submitting, approving or rejecting one statement. The page
 * draws one per command `server/contract-statements.ts` says the service
 * would accept, so this component never decides whether the command is
 * allowed, only what its form looks like. Each instance has its own submission
 * id — the idempotency key contract-service replays on — and its own signed
 * replay stamp.
 *
 * ## Sent and not confirmed
 *
 * `DisputeCommandForm`'s pattern: the submission is remembered before it
 * leaves (`lib/unresolved-statement.ts`), the form is replaced by a view that
 * never says "nothing changed", and "send the same request again" re-sends the
 * kept body under the kept key — a draft's lines as they were sent; a submit's
 * or a decision's body is in the stamp. A confirmed answer redirects and drops
 * the entry; otherwise only the person drops it, once the same request has
 * been tried again or can no longer be.
 *
 * ## One unresolved command per statement
 *
 * The approve and reject forms of a statement share one slot (PR 332 review
 * 1). While another submission's outcome is unknown (`heldBy`, kept current by
 * `StatementCommands`), this form draws no button, only the uncertainty notice;
 * and a send is refused here, before anything leaves, whenever the slot holds
 * another submission — so a rejection can never replace, or clear, a lost
 * approval's record and key. A record is cleared only for the submission it
 * belongs to.
 *
 * ## When the call itself fails
 *
 * Only `/auth/session` answering `401` lets the view say the session has
 * ended; any other failure — a refresh that is only unavailable for now
 * included — is "no answer came back", and the same request may still be sent.
 */

export interface MilestoneOption {
  readonly id: string;
  readonly title: string;
}

export interface StatementCommandFormProps {
  readonly scope: StatementScope;
  readonly command: StatementCommand;
  readonly csrfToken: string;
  readonly submissionId: string;
  /** That submission id's signed replay deadline; null for a restored entry that has none any more. */
  readonly replay: ReplayStamp | null;
  readonly binding: Binding;
  readonly sessionMaxAgeSeconds: number;
  /** The contract's milestones a draft's line may name; drafts only. */
  readonly milestones?: readonly MilestoneOption[];
  /** The page that shows the outcome — reloaded to see whether the command took. */
  readonly pageHref: string;
  readonly initial?: StatementFormState;
  /** The submission whose outcome is unknown in this scope, if any (`StatementCommands`). */
  readonly heldBy?: string | null;
}

/** The remembered submission as the form's starting state. */
export function unconfirmedFrom(restored: RestoredStatement): UnconfirmedStatement {
  const { command, correlationId, submissionId, lines, replay, marker } = restored.entry;
  return {
    kind: 'UNCONFIRMED',
    command,
    correlationId,
    submissionId,
    lines,
    replay,
    ...(restored.kind === 'VIEW_ONLY' ? { viewOnly: true as const } : {}),
    ...(marker ? { marker: true as const } : {}),
  };
}

/** The submission as the action will send it, or null when the action would refuse it unsent. */
function pendingFrom(
  form: FormData,
  command: StatementCommand,
  replay: ReplayStamp | null,
): UnconfirmedStatement | null {
  const submissionId = form.get(SUBMISSION_FIELD);
  if (typeof submissionId !== 'string') return null;
  if (command !== 'DRAFT') {
    return { kind: 'UNCONFIRMED', command, correlationId: null, submissionId, lines: [], replay };
  }
  const parsed = parseDraft(draftFormLines(form), null);
  if (!parsed.ok) return null;
  return {
    kind: 'UNCONFIRMED',
    command,
    correlationId: null,
    submissionId,
    lines: parsed.lines,
    replay,
  };
}

const FIRST_ROWS = 3;

/** How many rows to draw for these values: the last one holding anything, at least three. */
function rowCount(rows: readonly StatementLineValues[]): number {
  const last = rows.reduce(
    (found, row, index) => (row.description || row.amount || row.milestoneId ? index : found),
    -1,
  );
  return Math.min(FORM_LINE_ROWS, Math.max(FIRST_ROWS, last + 1));
}

/**
 * The form, held behind the device's quarantine of this kind
 * (`app/UnresolvedQuarantine.tsx`): while an earlier request this person
 * cannot be shown has an unknown outcome, the form is replaced by the fixed
 * warning until they accept the duplicate risk.
 */
export function StatementCommandForm(props: StatementCommandFormProps) {
  return (
    <QuarantineGate source={statementQuarantine} account={props.binding}>
      <StatementCommandFormBody {...props} />
    </QuarantineGate>
  );
}

function StatementCommandFormBody({
  scope,
  command,
  csrfToken,
  submissionId,
  replay,
  binding,
  sessionMaxAgeSeconds,
  milestones = [],
  pageHref,
  initial = IDLE_STATEMENT_FORM,
  heldBy = null,
}: StatementCommandFormProps) {
  const send = useCallback(
    async (previous: StatementFormState, form: FormData): Promise<StatementFormState> => {
      const firstSend = previous.kind !== 'UNCONFIRMED';
      const sent = form.get(SUBMISSION_FIELD);
      const sentId = firstSend ? (typeof sent === 'string' ? sent : '') : previous.submissionId;
      if (firstSend) {
        // Another submission's outcome is unknown here: nothing is sent, and its
        // record is not touched.
        const holder = restoreUnresolvedStatement(scope, binding, sessionMaxAgeSeconds);
        if (holder && holder.entry.submissionId !== sentId) return { kind: 'HELD' };
      } else {
        // A replay only while the service still holds its key, and only from
        // the login it is bound to. Past that, never re-sent.
        const stored = restoreUnresolvedStatement(scope, binding, sessionMaxAgeSeconds);
        if (stored?.kind !== 'RETRYABLE' || stored.entry.submissionId !== previous.submissionId) {
          return { ...previous, viewOnly: true };
        }
      }

      // Remembered BEFORE it is sent; not sent if it cannot be remembered.
      const unsent = firstSend ? pendingFrom(form, command, replay) : null;
      const saved = unsent ? saveUnresolvedStatement(scope, unsent, binding) : null;
      if (saved === 'HELD') return { kind: 'HELD' };
      if (saved === 'UNAVAILABLE') return { kind: 'STORAGE_UNAVAILABLE' };

      let next: StatementFormState;
      try {
        next =
          scope.statementId === null
            ? await submitStatementDraft(scope.contractId, previous, form)
            : await submitStatementCommand(scope.contractId, scope.statementId, previous, form);
      } catch (error) {
        // Done: the action redirects to the statement.
        if (isRedirect(error)) {
          clearUnresolvedStatement(scope, sentId, binding);
          throw error;
        }
        const ended = await sessionHasEnded();
        if (!firstSend) return withRetryNote(previous, ended ? 'sessionEnded' : 'retryUnknown');
        if (unsent) return ended ? { ...unsent, sessionEnded: true } : unsent;
        throw error;
      }

      // Still in doubt: kept. A definite answer to THIS submission's first send:
      // its own record is dropped — never another's.
      if (next.kind === 'UNCONFIRMED') saveUnresolvedStatement(scope, next, binding);
      else if (firstSend) clearUnresolvedStatement(scope, sentId, binding);
      return next;
    },
    [scope, command, replay, binding, sessionMaxAgeSeconds],
  );
  const [state, action, pending] = useActionState(send, initial);
  const headingId = `statement-command-${command}`;

  if (state.kind === 'UNCONFIRMED') {
    return (
      <UnconfirmedCommand
        state={state}
        action={action}
        pending={pending}
        csrfToken={csrfToken}
        headingId={headingId}
        pageHref={pageHref}
        onForget={() => clearUnresolvedStatement(scope, state.submissionId, binding)}
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
        {STATEMENT_COMMAND_LABELS[command]}
      </h3>
      <p className="text-sm text-content-muted">{STATEMENT_COMMAND_CONSEQUENCES[command]}</p>

      <CommandBanner state={state} />

      {command === 'DRAFT' ? (
        <DraftLines
          rows={invalid ? state.rows : []}
          fieldErrors={invalid ? state.fieldErrors : {}}
          milestones={milestones}
        />
      ) : null}

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'در حال ارسال…' : STATEMENT_COMMAND_LABELS[command]}
        </Button>
      </div>
    </form>
  );
}

function DraftLines({
  rows,
  fieldErrors,
  milestones,
}: {
  rows: readonly StatementLineValues[];
  fieldErrors: Partial<Record<string, string>>;
  milestones: readonly MilestoneOption[];
}) {
  const [added, setAdded] = useState(0);
  // Every row the last answer came back with stays drawn, errors included.
  const count = Math.min(FORM_LINE_ROWS, rowCount(rows) + added);
  const valueOf = (index: number): StatementLineValues => rows[index] ?? EMPTY_LINE;

  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="text-sm font-medium">ردیف‌های صورت‌وضعیت</legend>
      <p className="text-sm text-content-muted">
        ردیف‌های خالی نادیده گرفته می‌شوند. مبلغ ناخالص جمع ردیف‌هاست و سامانه آن را حساب می‌کند.
        کسورات را کارفرما پیکربندی می‌کند و از این فرم اعمال نمی‌شود.
      </p>
      {Array.from({ length: count }, (_, index) => {
        const values = valueOf(index);
        return (
          <div
            key={index}
            role="group"
            aria-label={rowLabel(index)}
            className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-3"
          >
            <Field
              label={`${LINE_FIELD_LABELS.description} — ${rowLabel(index)}`}
              error={fieldErrors[lineField(index, 'description')]}
              className="sm:col-span-3"
            >
              {(control) => (
                <textarea
                  {...control}
                  name={lineField(index, 'description')}
                  rows={2}
                  maxLength={500}
                  defaultValue={values.description}
                  className={controlClassName}
                />
              )}
            </Field>
            <Field
              label={`${LINE_FIELD_LABELS.amount} — ${rowLabel(index)}`}
              hint="عدد صحیح به ریال؛ ارقام فارسی یا لاتین"
              error={fieldErrors[lineField(index, 'amount')]}
            >
              {(control) => (
                <input
                  {...control}
                  name={lineField(index, 'amount')}
                  inputMode="numeric"
                  autoComplete="off"
                  dir="ltr"
                  defaultValue={values.amount}
                  className={controlClassName}
                />
              )}
            </Field>
            {milestones.length > 0 ? (
              <Field
                label={`${LINE_FIELD_LABELS.milestoneId} — ${rowLabel(index)}`}
                error={fieldErrors[lineField(index, 'milestoneId')]}
                className="sm:col-span-2"
              >
                {(control) => (
                  <select
                    {...control}
                    key={values.milestoneId}
                    name={lineField(index, 'milestoneId')}
                    defaultValue={values.milestoneId}
                    className={controlClassName}
                  >
                    <option value="">بدون Milestone</option>
                    {milestones.map((milestone) => (
                      <option key={milestone.id} value={milestone.id}>
                        {milestone.title}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ) : null}
          </div>
        );
      })}
      {count < FORM_LINE_ROWS ? (
        <div>
          <Button type="button" tone="secondary" onClick={() => setAdded(added + 1)}>
            افزودن ردیف
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}

/** Nothing was sent in any of these. */
const REFUSAL_MESSAGES: Record<Extract<StatementFormState, { kind: 'REFUSED' }>['reason'], string> =
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
    const text = STATEMENT_REFUSAL_TEXT[reason];
    if (text) return text;
  }
  return null;
}

const HELD_MESSAGE =
  'درخواست دیگری روی همین صورت‌وضعیت فرستاده شده و نتیجه‌اش هنوز معلوم نیست؛ ممکن است انجام شده باشد. تا روشن‌شدن نتیجهٔ آن، این فرم فرستاده نمی‌شود. وضعیت را با تازه‌کردن صفحه ببینید.';

/**
 * Another command of this statement is unresolved: no form, no button — only
 * what this command would be, and why it waits.
 */
function HeldCommand({
  command,
  headingId,
  pageHref,
}: {
  command: StatementCommand;
  headingId: string;
  pageHref: string;
}) {
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4"
    >
      <h3 id={headingId} className="text-base font-medium">
        {STATEMENT_COMMAND_LABELS[command]}
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

function CommandBanner({ state }: { state: StatementFormState }) {
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
    return (
      <Alert tone="warning">این صورت‌وضعیت یا قرارداد دیگر در دسترس نیست. صفحه را تازه کنید.</Alert>
    );
  }
  if (state.kind === 'STORAGE_UNAVAILABLE') {
    return (
      <Alert tone="danger">
        درخواست ارسال نشد: این مرورگر نمی‌تواند درخواست را تا روشن‌شدن نتیجه‌اش به خاطر بسپارد
        (مثلاً حالت خصوصی یا حافظهٔ پر)، و بی آن ممکن است یک صورت‌وضعیت دو بار ثبت شود. از مرورگر
        دیگری استفاده کنید یا فضا را آزاد کنید و دوباره تلاش کنید.
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
  state: UnconfirmedStatement;
  action: (form: FormData) => void;
  pending: boolean;
  csrfToken: string;
  headingId: string;
  pageHref: string;
  onForget: () => void;
}) {
  const canRetry = !state.viewOnly && !state.sessionEnded;
  const canForget = (state.viewOnly || state.retryRefused) && !state.sessionEnded;
  const what = STATEMENT_COMMAND_LABELS[state.command];

  return (
    <form
      action={action}
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4"
    >
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={state.submissionId} />
      <input type="hidden" name={REPLAY_FIELD} value={state.replay?.token ?? ''} />
      {rowsOfLines(state.lines).map((row, index) => (
        <span key={index} hidden>
          <input type="hidden" name={lineField(index, 'description')} value={row.description} />
          <input type="hidden" name={lineField(index, 'amount')} value={row.amount} />
          <input type="hidden" name={lineField(index, 'milestoneId')} value={row.milestoneId} />
        </span>
      ))}

      <h3 id={headingId} className="text-base font-medium">
        {what}
      </h3>
      <Alert tone="warning">
        نتوانستیم تأیید کنیم که «{what}» انجام شد یا نه؛ ممکن است انجام شده باشد. پیش از هر کار
        دیگر،{' '}
        <a href={pageHref} className="underline">
          این صفحه را تازه کنید
        </a>{' '}
        و وضعیت صورت‌وضعیت‌ها را ببینید.
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
          {/* A full navigation: the page reads the statements again and offers what they allow. */}
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
