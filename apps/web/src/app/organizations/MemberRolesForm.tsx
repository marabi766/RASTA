'use client';

import { useActionState } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { UnconfirmedWriteAlert } from '@/app/UnconfirmedWriteAlert';
import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { roleLabel } from '@/lib/organization-fields';

import { submitUpdateMemberRoles } from './actions';
import { IDLE_UPDATE_MEMBER_ROLES_FORM, type UpdateMemberRolesFormState } from './form-state';

/**
 * The roles one member holds.
 *
 * ## Where the options come from
 *
 * `grantableRoles` is the caller's own set, as identity-service computed it
 * from the configured ladder (`docs/24` Q-60) and handed back on
 * `GET /v1/users/me`. This component renders that and nothing else. It does
 * **not** hold a list of platform roles: the ladder is deployment
 * configuration, so a hardcoded list would disagree with the service the
 * moment anyone changed `ROLE_GRANTS_BY_*` — offering a role that gets
 * refused, or hiding one that would have worked.
 *
 * That is a correctness choice, not a security one. The service refuses a
 * role outside the ladder whatever this form sends, and `docs/16` § ۱۶٫۱۱ is
 * explicit that hiding a control is not a control. What this buys is a form
 * that does not lie to the person using it.
 *
 * ## Roles the caller cannot grant, that the member already holds
 *
 * Named on screen and posted as hidden inputs — so saving a change to the
 * roles an administrator *can* set does not silently strip one they cannot.
 * The service checks the whole resulting set, so leaving them out would turn
 * every edit into an attempted removal, and be refused anyway.
 */

export function MemberRolesForm({
  membershipId,
  memberName,
  currentRoles,
  grantableRoles,
  csrfToken,
  submissionId,
}: {
  membershipId: string;
  memberName: string;
  currentRoles: readonly string[];
  grantableRoles: readonly string[];
  csrfToken: string;
  submissionId: string;
}) {
  const [state, action, pending] = useActionState(
    submitUpdateMemberRoles,
    IDLE_UPDATE_MEMBER_ROLES_FORM,
  );

  // No "is this result mine?" check: `useActionState` holds state per
  // component instance, so a page rendering one of these per member gives
  // each its own. Filtering by `membershipId` here would also hide the two
  // refusals that carry no membership — an expired session and a failed CSRF
  // check — which are exactly the ones a person needs to see.
  const invalid = state.kind === 'INVALID';

  const selected = invalid ? state.values.roles : currentRoles;
  const errors = invalid ? state.fieldErrors : {};
  const currentSubmissionId = invalid ? state.submissionId : submissionId;

  /** Held but not grantable by this caller — preserved, not silently dropped. */
  const locked = currentRoles.filter((role) => !grantableRoles.includes(role));

  if (grantableRoles.length === 0) {
    return (
      <p className="text-sm text-muted">
        شما اجازهٔ تغییر نقش‌های اعضا را ندارید. نقش‌های فعلی:{' '}
        {currentRoles.map(roleLabel).join('، ') || '—'}
      </p>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={currentSubmissionId} />
      <input type="hidden" name="membershipId" value={membershipId} />
      {locked.map((role) => (
        <input key={role} type="hidden" name="roles" value={role} />
      ))}

      <RolesBanner state={state} />

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">نقش‌های {memberName}</legend>

        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {grantableRoles.map((role) => {
            // The label both wraps the checkbox and names it by id: the
            // repo's a11y rule asks for both forms of association. The id
            // carries the membership as well as the role, so two members'
            // pickers on one page cannot collide on it.
            const id = `role-${membershipId}-${role}`;
            return (
              <label key={role} htmlFor={id} className="flex items-center gap-2 text-sm">
                <input
                  id={id}
                  type="checkbox"
                  name="roles"
                  value={role}
                  aria-label={roleLabel(role)}
                  defaultChecked={selected.includes(role)}
                />
                {roleLabel(role)}
              </label>
            );
          })}
        </div>

        {locked.length > 0 ? (
          <p className="text-xs text-muted">
            نقش‌های {locked.map(roleLabel).join('، ')} بالاتر از اختیار شماست و بدون تغییر می‌مانند.
          </p>
        ) : null}

        {errors.roles ? (
          <p role="alert" className="text-sm text-danger">
            {errors.roles}
          </p>
        ) : null}
      </fieldset>

      <Field label="دلیل تغییر" error={errors.reason}>
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
          {pending ? 'در حال ذخیره…' : 'ذخیرهٔ نقش‌ها'}
        </Button>
      </div>
    </form>
  );
}

function RolesBanner({ state }: { state: UpdateMemberRolesFormState }) {
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
    // The ladder refused it: either a role above this administrator, or a
    // membership that already holds one. Said plainly — the person did
    // nothing wrong and an unexplained failure would be worse.
    return (
      <Alert tone="danger">
        این تغییر نقش در اختیار شما نیست. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  if (state.kind === 'NOT_FOUND') {
    return <Alert tone="warning">این عضویت دیگر وجود ندارد. صفحه را تازه کنید.</Alert>;
  }

  if (state.kind === 'UNCONFIRMED') {
    return <UnconfirmedWriteAlert correlationId={state.correlationId} />;
  }

  if (state.kind === 'FAILED') {
    return (
      <Alert tone="danger">
        ذخیره انجام نشد و نقشی تغییر نکرد. کد پیگیری: {state.correlationId}
      </Alert>
    );
  }

  return null;
}
