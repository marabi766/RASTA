'use client';

import { useActionState } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';

import { submitRevokeMembership } from './actions';
import { IDLE_REVOKE_MEMBERSHIP_FORM, type RevokeMembershipFormState } from './form-state';

/**
 * Ending one person's membership in this organization.
 *
 * The reason is a required text field rather than a confirmation dialog,
 * which is deliberate on two counts: identity-service requires it and carries
 * it into the audit event, and having to write *why* is a better guard
 * against an accidental click than an "are you sure?" people learn to dismiss.
 *
 * There is no `disabled` on the button for a membership the caller may not
 * revoke. Whether they may depends on the roles that membership holds
 * measured against the configured ladder, which identity-service decides —
 * `docs/16` § ۱۶٫۱۱ — so a refusal is rendered rather than pre-empted.
 */

export function RevokeMembershipForm({
  membershipId,
  memberName,
  csrfToken,
  submissionId,
}: {
  membershipId: string;
  memberName: string;
  csrfToken: string;
  submissionId: string;
}) {
  const [state, action, pending] = useActionState(
    submitRevokeMembership,
    IDLE_REVOKE_MEMBERSHIP_FORM,
  );

  const invalid = state.kind === 'INVALID';
  const currentSubmissionId = invalid ? state.submissionId : submissionId;

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={currentSubmissionId} />
      <input type="hidden" name="membershipId" value={membershipId} />

      <RevokeBanner state={state} />

      <Field
        label={`دلیل ابطال عضویت ${memberName}`}
        error={invalid ? state.fieldErrors.reason : undefined}
      >
        {(control) => (
          <input
            {...control}
            name="reason"
            defaultValue={invalid ? state.values.reason : ''}
            required
            minLength={3}
            maxLength={500}
            className={controlClassName}
          />
        )}
      </Field>

      <div>
        <Button type="submit" tone="secondary" disabled={pending}>
          {pending ? 'در حال ابطال…' : 'ابطال عضویت'}
        </Button>
      </div>
    </form>
  );
}

function RevokeBanner({ state }: { state: RevokeMembershipFormState }) {
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
        ابطال این عضویت در اختیار شما نیست. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  if (state.kind === 'NOT_FOUND') {
    return <Alert tone="warning">این عضویت دیگر وجود ندارد. صفحه را تازه کنید.</Alert>;
  }

  if (state.kind === 'FAILED') {
    return (
      <Alert tone="danger">
        ابطال انجام نشد و عضویت پابرجاست. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  return null;
}
