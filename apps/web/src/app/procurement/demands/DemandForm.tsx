'use client';

import { useActionState, useEffect, useState } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { UnconfirmedWriteAlert } from '@/app/UnconfirmedWriteAlert';
import { CSRF_FIELD, REPLAY_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { IN_PROGRESS_WRITE_MESSAGE } from '@/lib/in-progress-write';
import {
  DEMAND_EXPIRED_MESSAGE,
  DEMAND_FORBIDDEN_MESSAGE,
  DEMAND_SUBMIT_CONSEQUENCE,
  EMPTY_DEMAND_FORM,
  HELD_CHANGED_MESSAGE,
  HELD_IN_PROGRESS_MESSAGE,
  HELD_OTHER_MESSAGE,
  MAX_NOTE_LENGTH,
  PENDING_CAPACITY_MESSAGE,
  PENDING_UNCHECKED_MESSAGE,
  demandFailureText,
  type DemandFormValues,
} from '@/lib/demand-commands';
import { toPersianDigits } from '@/lib/format';
import { isSessionRefusal, SESSION_REFUSAL_MESSAGES } from '@/lib/session-refusal';

import { submitDemandRequest } from './demand-actions';
import { IDLE_DEMAND_FORM, type DemandFormState } from './demand-form-state';

/**
 * The demand form (ثبت نیاز). A plain `<form>` around a server action, so it
 * works before any bundle has loaded (docs/16 § ۱۶٫۲). The organization is the
 * session's; no field names it.
 *
 * The note has no `maxLength`: the browser counts UTF-16 units and the service
 * counts code points, so the limit is the action's (`lib/demand-commands.ts`),
 * said in the hint and, past it, on the field.
 */

function valuesOf(state: DemandFormState): DemandFormValues {
  switch (state.kind) {
    case 'INVALID':
    case 'IN_PROGRESS':
    case 'HELD':
    case 'NOT_CHECKED':
    case 'CAPACITY':
    case 'EXPIRED':
      return state.values;
    default:
      return EMPTY_DEMAND_FORM;
  }
}

export function DemandForm({
  csrfToken,
  submission,
}: {
  csrfToken: string;
  /**
   * Minted for this render and bound to this session — or, while a submission
   * is unresolved, that submission's own key and stamp from the server's record,
   * so a retry is the same request (`server/demand-replay.ts`).
   */
  submission: { readonly id: string; readonly replay: string };
}) {
  const [state, action, pending] = useActionState(submitDemandRequest, IDLE_DEMAND_FORM);

  const values = valuesOf(state);
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};
  const current =
    state.kind === 'INVALID' || state.kind === 'IN_PROGRESS'
      ? { id: state.submissionId, replay: state.replay }
      : submission;
  const waiting = useRetryAfter(state);
  // A retry under the same key must carry exactly what was sent: the controls
  // are disabled (so they post nothing) and the sent values travel hidden.
  const locked = state.kind === 'IN_PROGRESS';
  const closed = state.kind === 'EXPIRED' || state.kind === 'UNCONFIRMED';

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={current.id} />
      <input type="hidden" name={REPLAY_FIELD} value={current.replay} />

      <p className="text-sm text-content-muted">{DEMAND_SUBMIT_CONSEQUENCE}</p>
      <FormBanner state={state} />
      {locked
        ? Object.entries(values).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))
        : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="شناسه کالا"
          required
          error={errors.productId}
          hint="شناسه کالا در بازار، به شکل PRD_…"
        >
          {(control) => (
            <input
              {...control}
              name="productId"
              defaultValue={values.productId}
              dir="ltr"
              autoComplete="off"
              className={controlClassName}
              disabled={locked}
            />
          )}
        </Field>

        <Field label="مقدار" required error={errors.quantity} hint="عدد صحیح، به واحد پایه کالا.">
          {(control) => (
            <input
              {...control}
              name="quantity"
              defaultValue={values.quantity}
              inputMode="numeric"
              dir="ltr"
              autoComplete="off"
              className={controlClassName}
              disabled={locked}
            />
          )}
        </Field>
      </div>

      <Field
        label="یادداشت"
        error={errors.note}
        hint={`اختیاری، حداکثر ${toPersianDigits(String(MAX_NOTE_LENGTH))} نویسه؛ فقط سازمان شما آن را می‌بیند.`}
      >
        {(control) => (
          <textarea
            {...control}
            name="note"
            rows={3}
            defaultValue={values.note}
            className={controlClassName}
            disabled={locked}
          />
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button type="submit" disabled={pending || waiting || closed}>
          {pending ? 'در حال ثبت…' : waiting ? 'کمی صبر کنید…' : 'ثبت نیاز'}
        </Button>
      </div>
    </form>
  );
}

/**
 * Holds the button for the `Retry-After` an in-progress answer gave, then offers
 * the same submission again. Without JavaScript the button is never held: a post
 * too soon is answered in progress again, which is safe.
 */
function useRetryAfter(state: DemandFormState): boolean {
  const [heldFor, setHeldFor] = useState<DemandFormState | null>(null);
  useEffect(() => {
    if (state.kind !== 'IN_PROGRESS') return;
    const timer = setTimeout(() => setHeldFor(state), state.retryAfterSeconds * 1000);
    return () => clearTimeout(timer);
  }, [state]);
  return state.kind === 'IN_PROGRESS' && heldFor !== state;
}

function FormBanner({ state }: { state: DemandFormState }) {
  switch (state.kind) {
    case 'IN_PROGRESS':
      return (
        <Alert tone="info">
          {IN_PROGRESS_WRITE_MESSAGE} کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'EXPIRED':
      return <Alert tone="warning">{DEMAND_EXPIRED_MESSAGE}</Alert>;
    case 'HELD':
      return (
        <Alert tone="warning">
          {state.reason === 'CHANGED_BODY'
            ? HELD_CHANGED_MESSAGE
            : state.reason === 'IN_PROGRESS'
              ? HELD_IN_PROGRESS_MESSAGE
              : HELD_OTHER_MESSAGE}
        </Alert>
      );
    case 'NOT_CHECKED':
      return <Alert tone="warning">{PENDING_UNCHECKED_MESSAGE}</Alert>;
    case 'CAPACITY':
      return <Alert tone="warning">{PENDING_CAPACITY_MESSAGE}</Alert>;
    case 'INVALID':
      return state.message ? <Alert tone="warning">{state.message}</Alert> : null;
    case 'REFUSED':
      return (
        <Alert tone="danger">
          {isSessionRefusal(state.reason)
            ? SESSION_REFUSAL_MESSAGES[state.reason]
            : 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.'}
        </Alert>
      );
    case 'FORBIDDEN':
      return (
        <Alert tone="danger">
          {DEMAND_FORBIDDEN_MESSAGE} کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'UNCONFIRMED':
      return <UnconfirmedWriteAlert correlationId={state.correlationId} />;
    case 'FAILED':
      return (
        <Alert tone="danger">
          {demandFailureText(state.status)} کد پیگیری: {state.correlationId}
        </Alert>
      );
    case 'IDLE':
      return null;
  }
}
