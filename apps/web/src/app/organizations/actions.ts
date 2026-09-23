'use server';

import { redirect } from 'next/navigation';

import { currentSession } from '@/server/current-session';
import { verifyCsrf } from '@/server/csrf';
import { isSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import {
  parseUpdateOrganizationForm,
  updateOrganization,
  updateOrganizationFormValues,
} from '@/server/organizations';
import {
  parseRevokeMembershipForm,
  parseUpdateMemberRolesForm,
  revokeMembership,
  revokeMembershipFormValues,
  updateMemberRoles,
  updateMemberRolesFormValues,
} from '@/server/members';

import type {
  RevokeMembershipFormState,
  UpdateMemberRolesFormState,
  UpdateOrganizationFormState,
} from './form-state';

/**
 * The `/organizations` server actions.
 *
 * Same order as `usage/actions.ts` and `drivers/actions.ts` (ADR-059 § 3,
 * § 5), because it is the rule every write in this portal follows: session,
 * then CSRF, then the submission id, then the form, then the gateway. Each
 * gate returns before the next runs, so a refused post never reaches a
 * service.
 *
 * All three redirect on success, as every write in this portal does: a
 * refreshed page must not repeat the write, and a fresh form must carry a
 * fresh submission id. The flag in the query is what the page turns into a
 * confirmation — the form's own state cannot say "saved", because after a
 * redirect there is no form instance left to say it in.
 */

/** Everything the three actions check before they differ. */
async function gate(form: FormData) {
  const session = await currentSession();
  if (!session) return { ok: false, state: { kind: 'REFUSED', reason: 'NO_SESSION' } } as const;

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { ok: false, state: { kind: 'REFUSED', reason: 'CSRF' } } as const;

  const submissionId = form.get(SUBMISSION_FIELD);
  if (!isSubmissionId(submissionId)) {
    return { ok: false, state: { kind: 'REFUSED', reason: 'SUBMISSION' } } as const;
  }

  return { ok: true, session, submissionId } as const;
}

export async function submitUpdateOrganization(
  _previous: UpdateOrganizationFormState,
  form: FormData,
): Promise<UpdateOrganizationFormState> {
  const gated = await gate(form);
  if (!gated.ok) return gated.state;

  const organizationId = form.get('organizationId');
  if (typeof organizationId !== 'string' || organizationId.length === 0) {
    return { kind: 'REFUSED', reason: 'SUBMISSION' };
  }

  const values = updateOrganizationFormValues(form);
  const parsed = parseUpdateOrganizationForm(values);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId: gated.submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const result = await updateOrganization(
    gated.session,
    organizationId,
    parsed.request,
    gated.submissionId,
  );

  switch (result.kind) {
    case 'CREATED':
      redirect('/organizations?saved=profile');
      break;
    case 'INVALID':
      return {
        kind: 'INVALID',
        submissionId: gated.submissionId,
        values,
        fieldErrors: result.fieldErrors,
        message: result.message,
      };
    case 'FORBIDDEN':
      return { kind: 'FORBIDDEN', correlationId: result.correlationId };
    case 'NOT_FOUND':
      return { kind: 'FAILED', status: 404, correlationId: result.correlationId };
    case 'UNAVAILABLE':
      return { kind: 'FAILED', status: result.status, correlationId: result.correlationId };
    case 'MALFORMED':
      return { kind: 'FAILED', status: 502, correlationId: result.correlationId };
  }
}

export async function submitUpdateMemberRoles(
  _previous: UpdateMemberRolesFormState,
  form: FormData,
): Promise<UpdateMemberRolesFormState> {
  const gated = await gate(form);
  if (!gated.ok) return gated.state;

  const values = updateMemberRolesFormValues(form);
  const parsed = parseUpdateMemberRolesForm(values);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId: gated.submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const result = await updateMemberRoles(gated.session, parsed.request, gated.submissionId);

  switch (result.kind) {
    case 'CREATED':
      redirect('/organizations?saved=roles');
      break;
    case 'INVALID':
      return {
        kind: 'INVALID',
        submissionId: gated.submissionId,
        values,
        fieldErrors: result.fieldErrors,
        message: result.message,
      };
    case 'FORBIDDEN':
      // The role ladder refused this grant, or this membership is above the
      // caller. Rendered as itself — see `form-state.ts`.
      return { kind: 'FORBIDDEN', correlationId: result.correlationId };
    case 'NOT_FOUND':
      return { kind: 'NOT_FOUND' };
    case 'UNAVAILABLE':
      return { kind: 'FAILED', status: result.status, correlationId: result.correlationId };
    case 'MALFORMED':
      return { kind: 'FAILED', status: 502, correlationId: result.correlationId };
  }
}

export async function submitRevokeMembership(
  _previous: RevokeMembershipFormState,
  form: FormData,
): Promise<RevokeMembershipFormState> {
  const gated = await gate(form);
  if (!gated.ok) return gated.state;

  const values = revokeMembershipFormValues(form);
  const parsed = parseRevokeMembershipForm(values);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId: gated.submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const result = await revokeMembership(gated.session, parsed.request, gated.submissionId);

  switch (result.kind) {
    case 'CREATED':
      redirect('/organizations?revoked=1');
      break;
    case 'INVALID':
      return {
        kind: 'INVALID',
        submissionId: gated.submissionId,
        values,
        fieldErrors: result.fieldErrors,
        message: result.message,
      };
    case 'FORBIDDEN':
      return { kind: 'FORBIDDEN', correlationId: result.correlationId };
    case 'NOT_FOUND':
      return { kind: 'NOT_FOUND' };
    case 'UNAVAILABLE':
      return { kind: 'FAILED', status: result.status, correlationId: result.correlationId };
    case 'MALFORMED':
      return { kind: 'FAILED', status: 502, correlationId: result.correlationId };
  }
}
