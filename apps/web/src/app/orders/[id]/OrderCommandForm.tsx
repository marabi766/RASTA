'use client';

import { useActionState } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { toPersianDigits } from '@/lib/format';
import {
  COMMAND_CONSEQUENCES,
  COMMAND_FIELD,
  COMMAND_LABELS,
  DISPUTE_OUTCOMES,
  DISPUTE_OUTCOME_LABELS,
  EMPTY_ORDER_COMMAND_FORM,
  IRREVERSIBLE_COMMANDS,
  ORDER_FIELD_LIMITS as LIMITS,
  RESPONSIBILITIES,
  RESPONSIBILITY_LABELS,
  type OrderCommand,
  type OrderCommandField,
  type OrderCommandFormValues,
} from '@/lib/order-fields';

import { submitOrderCommand } from './actions';
import { IDLE_ORDER_COMMAND_FORM, type OrderCommandFormState } from './form-state';

/**
 * One command the current viewer may issue on this order.
 *
 * The page renders one of these per entry in `availableActions` — which the
 * service computed for this viewer — so this component never decides whether
 * a command is allowed. It decides only what the command's form looks like.
 *
 * Each instance gets its own submission id (`submission.ts`: one per form). On
 * `orders` that id is a real idempotency key the service replays on, so two
 * forms sharing one would make the second command answer with the first's
 * result.
 *
 * The limits on every field are copied from marketplace-service's DTOs and
 * enforced here as `minLength`/`maxLength` so a person hears about them before
 * posting. The service enforces them again; these only make the form honest.
 */

export function OrderCommandForm({
  orderId,
  command,
  csrfToken,
  submissionId,
}: {
  orderId: string;
  command: OrderCommand;
  csrfToken: string;
  submissionId: string;
}) {
  const [state, action, pending] = useActionState(
    submitOrderCommand.bind(null, orderId),
    IDLE_ORDER_COMMAND_FORM,
  );

  const invalid = state.kind === 'INVALID';
  const values: OrderCommandFormValues = invalid ? state.values : EMPTY_ORDER_COMMAND_FORM;
  const errors: Partial<Record<OrderCommandField, string>> = invalid ? state.fieldErrors : {};
  const currentSubmissionId = invalid ? state.submissionId : submissionId;
  const irreversible = IRREVERSIBLE_COMMANDS.has(command);
  const headingId = `command-${command}`;

  return (
    <form
      action={action}
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4"
    >
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={currentSubmissionId} />
      <input type="hidden" name={COMMAND_FIELD} value={command} />

      <h3 id={headingId} className="text-base font-medium">
        {COMMAND_LABELS[command]}
      </h3>
      <p className="text-sm text-content-muted">{COMMAND_CONSEQUENCES[command]}</p>

      <CommandBanner state={state} />

      <CommandFields command={command} values={values} errors={errors} />

      {irreversible ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${headingId}-ack`} className="flex items-start gap-2 text-sm">
            <input
              id={`${headingId}-ack`}
              type="checkbox"
              name="acknowledge"
              value="yes"
              aria-label="می‌دانم این اقدام بازگشت‌پذیر نیست."
              required
              aria-invalid={errors.acknowledge ? true : undefined}
              aria-describedby={errors.acknowledge ? `${headingId}-ack-error` : undefined}
            />
            می‌دانم این اقدام بازگشت‌پذیر نیست.
          </label>
          {errors.acknowledge ? (
            <p id={`${headingId}-ack-error`} role="alert" className="text-sm text-danger">
              {errors.acknowledge}
            </p>
          ) : null}
        </div>
      ) : null}

      <div>
        <Button type="submit" tone={irreversible ? 'primary' : 'secondary'} disabled={pending}>
          {pending ? 'در حال ارسال…' : COMMAND_LABELS[command]}
        </Button>
      </div>
    </form>
  );
}

function CommandFields({
  command,
  values,
  errors,
}: {
  command: OrderCommand;
  values: OrderCommandFormValues;
  errors: Partial<Record<OrderCommandField, string>>;
}) {
  switch (command) {
    case 'CONFIRM':
      return null;

    case 'FULFILL':
      return (
        <>
          <Field label="کد رهگیری ارسال" hint="اختیاری" error={errors.trackingReference}>
            {(control) => (
              <input
                {...control}
                name="trackingReference"
                defaultValue={values.trackingReference}
                maxLength={LIMITS.trackingReference.max}
                className={controlClassName}
              />
            )}
          </Field>
          <NoteField values={values} errors={errors} />
        </>
      );

    case 'CONFIRM_RECEIPT':
      return <NoteField values={values} errors={errors} />;

    case 'RAISE_DISPUTE':
      return (
        <Field
          label="دلیل اختلاف"
          hint={`دست‌کم ${toPersianDigits(String(LIMITS.disputeReason.min))} نویسه؛ کسی که رسیدگی می‌کند باید بداند موضوع چیست`}
          error={errors.reason}
          required
        >
          {(control) => (
            <textarea
              {...control}
              name="reason"
              rows={4}
              defaultValue={values.reason}
              required
              minLength={LIMITS.disputeReason.min}
              maxLength={LIMITS.disputeReason.max}
              className={controlClassName}
            />
          )}
        </Field>
      );

    case 'RESOLVE_DISPUTE':
      return (
        <>
          <Choice
            name="outcome"
            legend="نتیجه"
            options={DISPUTE_OUTCOMES.map((o) => [o, DISPUTE_OUTCOME_LABELS[o]])}
            selected={values.outcome}
            error={errors.outcome}
          />
          <Choice
            name="responsibility"
            legend="مسئول"
            // ADR-052 rule 14: stated by the operator, never inferred from the
            // outcome — so there is no default selection either.
            options={RESPONSIBILITIES.map((r) => [r, RESPONSIBILITY_LABELS[r]])}
            selected={values.responsibility}
            error={errors.responsibility}
          />
          <Field label="شرح تصمیم" error={errors.resolution} required>
            {(control) => (
              <textarea
                {...control}
                name="resolution"
                rows={4}
                defaultValue={values.resolution}
                required
                minLength={LIMITS.resolution.min}
                maxLength={LIMITS.resolution.max}
                className={controlClassName}
              />
            )}
          </Field>
        </>
      );

    case 'CANCEL':
      return (
        <Field label="دلیل لغو" error={errors.reason} required>
          {(control) => (
            <input
              {...control}
              name="reason"
              defaultValue={values.reason}
              required
              minLength={LIMITS.cancelReason.min}
              maxLength={LIMITS.cancelReason.max}
              className={controlClassName}
            />
          )}
        </Field>
      );

    case 'REVIEW':
      return (
        <>
          <Choice
            name="rating"
            legend="امتیاز"
            options={(['1', '2', '3', '4', '5'] as const).map((r) => [
              r,
              ['۱', '۲', '۳', '۴', '۵'][Number(r) - 1]!,
            ])}
            selected={values.rating}
            error={errors.rating}
          />
          <Field label="نظر" hint="اختیاری" error={errors.comment}>
            {(control) => (
              <textarea
                {...control}
                name="comment"
                rows={3}
                defaultValue={values.comment}
                maxLength={LIMITS.reviewComment.max}
                className={controlClassName}
              />
            )}
          </Field>
        </>
      );
  }
}

function NoteField({
  values,
  errors,
}: {
  values: OrderCommandFormValues;
  errors: Partial<Record<OrderCommandField, string>>;
}) {
  return (
    <Field label="یادداشت" hint="اختیاری" error={errors.note}>
      {(control) => (
        <textarea
          {...control}
          name="note"
          rows={2}
          defaultValue={values.note}
          maxLength={LIMITS.note.max}
          className={controlClassName}
        />
      )}
    </Field>
  );
}

/** A required single choice, as a radio group — no pre-selected answer. */
function Choice({
  name,
  legend,
  options,
  selected,
  error,
}: {
  name: string;
  legend: string;
  options: ReadonlyArray<readonly [string, string]>;
  selected: string;
  error: string | undefined;
}) {
  const errorId = `${name}-error`;
  return (
    <fieldset
      className="flex flex-col gap-2"
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
    >
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {options.map(([value, label]) => {
          const id = `${name}-${value}`;
          return (
            <label key={value} htmlFor={id} className="flex items-center gap-2 text-sm">
              <input
                id={id}
                type="radio"
                name={name}
                value={value}
                aria-label={label}
                defaultChecked={selected === value}
                required
              />
              {label}
            </label>
          );
        })}
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

function CommandBanner({ state }: { state: OrderCommandFormState }) {
  if (state.kind === 'INVALID' && state.message) {
    return <Alert tone="warning">{state.message}</Alert>;
  }

  if (state.kind === 'REFUSED') {
    const text =
      state.reason === 'NO_SESSION'
        ? 'نشست شما پایان یافته است. دوباره وارد شوید و فرم را بفرستید.'
        : 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.';
    return <Alert tone="danger">{text}</Alert>;
  }

  if (state.kind === 'FORBIDDEN') {
    return (
      <Alert tone="danger">
        این اقدام روی این سفارش در اختیار شما نیست. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  if (state.kind === 'NOT_FOUND') {
    return <Alert tone="warning">این سفارش دیگر در دسترس نیست. صفحه را تازه کنید.</Alert>;
  }

  if (state.kind === 'FAILED') {
    return (
      <Alert tone="danger">
        اقدام انجام نشد و وضعیت سفارش تغییر نکرد. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  return null;
}
