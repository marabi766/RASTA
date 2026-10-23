'use client';

import { useActionState, useEffect, useState } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { UnconfirmedWriteAlert } from '@/app/UnconfirmedWriteAlert';
import { CSRF_FIELD, REPLAY_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { IN_PROGRESS_WRITE_MESSAGE } from '@/lib/in-progress-write';
import {
  EMPTY_PROJECT_FORM,
  MAX_LOCATION_LENGTH,
  MAX_OPERATION_TYPE_LENGTH,
  MAX_SCOPE_LENGTH,
  MAX_TITLE_LENGTH,
  CREATE_EXPIRED_MESSAGE,
  PROJECT_FORBIDDEN_MESSAGE,
  projectFailureText,
  type ProjectField,
  type ProjectFormValues,
} from '@/lib/project-commands';
import { isSessionRefusal, SESSION_REFUSAL_MESSAGES } from '@/lib/session-refusal';

import { submitCreateProject } from './actions';
import {
  CREATE_INTENT_FIELD,
  EDIT_AS_NEW_INTENT,
  IDLE_CREATE_PROJECT_FORM,
  type CreateProjectFormState,
} from './form-state';

/**
 * The create form (ثبت پروژه). A plain `<form>` around a server action, so it
 * works before any bundle has loaded (docs/16 § ۱۶٫۲). It creates a DRAFT; asking
 * for approval is a separate command on the project's own page.
 *
 * The operating area is not drawn: it is a GeoJSON polygon, the portal never reads
 * it back, and a form that wrote what nobody can check would collect a thing the
 * screen cannot show (`lib/project-commands.ts`).
 */

const LABELS: Record<ProjectField, string> = {
  title: 'عنوان',
  operationType: 'نوع عملیات',
  locationDescription: 'محل',
  scopeOfWork: 'شرح کار',
  estimatedCost: 'برآورد هزینه (ریال)',
};

function valuesOf(state: CreateProjectFormState): ProjectFormValues {
  if (
    state.kind === 'INVALID' ||
    state.kind === 'IN_PROGRESS' ||
    state.kind === 'EDITING' ||
    state.kind === 'EXPIRED'
  ) {
    return state.values;
  }
  return EMPTY_PROJECT_FORM;
}

export function CreateProjectForm({
  csrfToken,
  submission,
}: {
  csrfToken: string;
  /**
   * Minted for this render and bound to this session. A retry of the same form
   * carries the same reference as its `Idempotency-Key`, which
   * construction-service honours on create while it keeps the key: the same key
   * and body answer the original 201 rather than creating a second project (see
   * `server/submission.ts`). `replay` is the signed deadline for that
   * (`server/project-create-replay.ts`).
   */
  submission: { readonly id: string; readonly replay: string };
}) {
  const [state, action, pending] = useActionState(submitCreateProject, IDLE_CREATE_PROJECT_FORM);

  const values = valuesOf(state);
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};
  const current =
    state.kind === 'INVALID' || state.kind === 'IN_PROGRESS' || state.kind === 'EDITING'
      ? { id: state.submissionId, replay: state.replay }
      : submission;
  const expired = state.kind === 'EXPIRED';
  const waiting = useRetryAfter(state);
  // While a submission is in flight its retry must send exactly what was sent: a
  // changed body under the same id is refused as IDEMPOTENCY_KEY_REUSED rather
  // than answered with the first result. The controls are disabled — so they post
  // nothing — and the original values travel in hidden fields; changing them is
  // "edit and send as new".
  const locked = state.kind === 'IN_PROGRESS';

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={current.id} />
      <input type="hidden" name={REPLAY_FIELD} value={current.replay} />

      <FormBanner state={state} />
      {locked && <SentValues values={values} />}

      <Field label={LABELS.title} required error={errors.title}>
        {(control) => (
          <input
            {...control}
            name="title"
            defaultValue={values.title}
            maxLength={MAX_TITLE_LENGTH}
            className={controlClassName}
            disabled={locked}
          />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={LABELS.operationType} required error={errors.operationType}>
          {(control) => (
            <input
              {...control}
              name="operationType"
              defaultValue={values.operationType}
              maxLength={MAX_OPERATION_TYPE_LENGTH}
              className={controlClassName}
              disabled={locked}
            />
          )}
        </Field>

        <Field
          label={LABELS.estimatedCost}
          error={errors.estimatedCost}
          hint="اختیاری؛ برای درخواست موافقت لازم می‌شود."
        >
          {(control) => (
            <input
              {...control}
              name="estimatedCost"
              defaultValue={values.estimatedCost}
              inputMode="numeric"
              dir="ltr"
              autoComplete="off"
              className={controlClassName}
              disabled={locked}
            />
          )}
        </Field>
      </div>

      <Field label={LABELS.locationDescription} required error={errors.locationDescription}>
        {(control) => (
          <input
            {...control}
            name="locationDescription"
            defaultValue={values.locationDescription}
            maxLength={MAX_LOCATION_LENGTH}
            className={controlClassName}
            disabled={locked}
          />
        )}
      </Field>

      <Field label={LABELS.scopeOfWork} required error={errors.scopeOfWork}>
        {(control) => (
          <textarea
            {...control}
            name="scopeOfWork"
            rows={4}
            defaultValue={values.scopeOfWork}
            maxLength={MAX_SCOPE_LENGTH}
            className={controlClassName}
            disabled={locked}
          />
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button type="submit" disabled={pending || waiting || expired}>
          {pending ? 'در حال ثبت…' : waiting ? 'کمی صبر کنید…' : 'ثبت پروژه'}
        </Button>
        {locked && (
          <Button
            type="submit"
            tone="secondary"
            name={CREATE_INTENT_FIELD}
            value={EDIT_AS_NEW_INTENT}
            disabled={pending}
          >
            ویرایش و ارسال جدید
          </Button>
        )}
      </div>
    </form>
  );
}

/** The values of a submission still in flight, exactly as they were sent: the only ones its retry may carry. */
function SentValues({ values }: { values: ProjectFormValues }) {
  return (
    <>
      {Object.entries(values).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

/**
 * Holds the button for the `Retry-After` an in-progress answer gave, then offers
 * the same submission again. Each answer is a new state object, so a second
 * in-progress answer starts a fresh wait. Without JavaScript the button is never
 * held: a post too soon is answered in progress again, which is safe.
 */
function useRetryAfter(state: CreateProjectFormState): boolean {
  const [heldFor, setHeldFor] = useState<CreateProjectFormState | null>(null);
  useEffect(() => {
    if (state.kind !== 'IN_PROGRESS') return;
    const timer = setTimeout(() => setHeldFor(state), state.retryAfterSeconds * 1000);
    return () => clearTimeout(timer);
  }, [state]);
  return state.kind === 'IN_PROGRESS' && heldFor !== state;
}

function FormBanner({ state }: { state: CreateProjectFormState }) {
  if (state.kind === 'IN_PROGRESS') {
    return (
      <Alert tone="info">
        {IN_PROGRESS_WRITE_MESSAGE} کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  if (state.kind === 'EXPIRED') {
    return <Alert tone="warning">{CREATE_EXPIRED_MESSAGE}</Alert>;
  }

  if (state.kind === 'EDITING') {
    return (
      <Alert tone="info">
        این یک درخواست تازه است. درخواستی که پیش‌تر فرستادید ممکن است همچنان ثبت شود؛ پیش از ارسال،
        فهرست پروژه‌ها را بررسی کنید.
      </Alert>
    );
  }

  if (state.kind === 'INVALID' && state.message) {
    return <Alert tone="warning">{state.message}</Alert>;
  }

  if (state.kind === 'REFUSED') {
    return (
      <Alert tone="danger">
        {isSessionRefusal(state.reason)
          ? SESSION_REFUSAL_MESSAGES[state.reason]
          : 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.'}
      </Alert>
    );
  }

  if (state.kind === 'FORBIDDEN') {
    return (
      <Alert tone="danger">
        {PROJECT_FORBIDDEN_MESSAGE} کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  if (state.kind === 'UNCONFIRMED') {
    return <UnconfirmedWriteAlert correlationId={state.correlationId} />;
  }

  if (state.kind === 'FAILED') {
    return (
      <Alert tone={state.status === 503 ? 'warning' : 'danger'}>
        {projectFailureText(state.status)} کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  return null;
}
