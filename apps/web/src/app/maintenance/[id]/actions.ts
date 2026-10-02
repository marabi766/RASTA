'use server';

import { redirect } from 'next/navigation';

import { FLASH_PARAM } from '@/lib/form-fields';
import type {
  ApproveRequestField,
  ApproveRequestFormValues,
  AssignWorkshopField,
  AssignWorkshopFormValues,
  CancelRequestField,
  CancelRequestFormValues,
  RequestCommandNotice,
} from '@/lib/maintenance-fields';
import { verifyCsrf } from '@/server/csrf';
import { currentSession } from '@/server/current-session';
import { mintFlash } from '@/server/flash';
import {
  APPROVAL_TOTAL_CHANGED_MESSAGE,
  approveRequest,
  approveRequestFormValues,
  assignWorkshop,
  assignWorkshopFormValues,
  cancelRequest,
  cancelRequestFormValues,
  commandRequestId,
  parseApproveRequestForm,
  parseAssignWorkshopForm,
  parseCancelRequestForm,
} from '@/server/maintenance-commands';
import type { WebSession } from '@/server/session';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import type { WriteResult } from '@/server/write';

import type { RequestCommandFormState } from './form-state';

/**
 * The three commands on `/maintenance/[id]`: refer to a workshop, approve the
 * cost, cancel.
 *
 * Same order as every write in this portal (ADR-059 § 3, § 5): session, CSRF,
 * the submission id, the request the command is about, the form, and only then
 * the gateway. Each refusal is decided before the next step runs, so a refused
 * post never reaches it — which the spec beside this file asserts for each
 * command.
 */

type Parsed<B, F extends string> =
  | { readonly ok: true; readonly body: B }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<F, string>> };

interface Command<V, B, F extends string> {
  readonly notice: RequestCommandNotice;
  readonly valuesOf: (form: FormData) => V;
  readonly parse: (values: V) => Parsed<B, F>;
  readonly send: (
    session: WebSession,
    requestId: string,
    body: B,
    submissionId: string,
  ) => Promise<WriteResult<{ id: string }, F>>;
  /** Where to send the person when the service's answer means "look again". */
  readonly lookAgain?: (message: string | null) => RequestCommandNotice | undefined;
}

async function run<V, B, F extends string>(
  command: Command<V, B, F>,
  form: FormData,
): Promise<RequestCommandFormState<V, F>> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: 'NO_SESSION' };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  // Bound to this session: a well-formed id this server never issued, another
  // person's id, and an id from an earlier login are all refused here.
  if (!isBoundSubmissionId(submissionId, session)) {
    return { kind: 'REFUSED', reason: 'SUBMISSION' };
  }

  const requestId = commandRequestId(form);
  // A request id that is not even shaped like one cannot name a request this
  // person can see; the read side answers it as a missing one.
  if (requestId === null) return { kind: 'NOT_FOUND', correlationId: null };

  const values = command.valuesOf(form);
  const parsed = command.parse(values);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const result = await command.send(session, requestId, parsed.body, submissionId);

  if (result.kind === 'CREATED') {
    // Redirect, not state: a refreshed page must not resubmit, and the page the
    // person lands on reads the request again, so it shows what the command did.
    redirect(
      `/maintenance/${encodeURIComponent(requestId)}?${FLASH_PARAM}=${mintFlash(session, requestId, command.notice)}`,
    );
  }

  switch (result.kind) {
    case 'INVALID': {
      const again = command.lookAgain?.(result.message);
      if (again) {
        redirect(
          `/maintenance/${encodeURIComponent(requestId)}?${FLASH_PARAM}=${mintFlash(session, requestId, again)}`,
        );
      }
      return {
        kind: 'INVALID',
        submissionId,
        values,
        fieldErrors: result.fieldErrors,
        message: result.message,
      };
    }
    case 'FORBIDDEN':
      return { kind: 'FORBIDDEN', correlationId: result.correlationId };
    case 'NOT_FOUND':
      return { kind: 'NOT_FOUND', correlationId: result.correlationId };
    case 'UNAVAILABLE':
      return { kind: 'FAILED', status: result.status, correlationId: result.correlationId };
    case 'IN_PROGRESS':
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe committed, not confirmed: never "nothing was changed". In
      // progress is the same unknown: maintenance-service keeps a submission id
      // for creating a request only, so it never says this for a command; the
      // gateway's answer is handled all the same.
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
  }
}

export async function submitAssignWorkshop(
  _previous: RequestCommandFormState<AssignWorkshopFormValues, AssignWorkshopField>,
  form: FormData,
): Promise<RequestCommandFormState<AssignWorkshopFormValues, AssignWorkshopField>> {
  return run(
    {
      notice: 'assigned',
      valuesOf: assignWorkshopFormValues,
      parse: parseAssignWorkshopForm,
      send: assignWorkshop,
    },
    form,
  );
}

export async function submitApproveRequest(
  _previous: RequestCommandFormState<ApproveRequestFormValues, ApproveRequestField>,
  form: FormData,
): Promise<RequestCommandFormState<ApproveRequestFormValues, ApproveRequestField>> {
  return run(
    {
      notice: 'approved',
      valuesOf: approveRequestFormValues,
      parse: parseApproveRequestForm,
      send: approveRequest,
      // The total moved between the screen and the button: the approval was
      // refused, and the page it sends the person to shows the new figure.
      lookAgain: (message) =>
        message === APPROVAL_TOTAL_CHANGED_MESSAGE ? 'costChanged' : undefined,
    },
    form,
  );
}

export async function submitCancelRequest(
  _previous: RequestCommandFormState<CancelRequestFormValues, CancelRequestField>,
  form: FormData,
): Promise<RequestCommandFormState<CancelRequestFormValues, CancelRequestField>> {
  return run(
    {
      notice: 'cancelled',
      valuesOf: cancelRequestFormValues,
      parse: parseCancelRequestForm,
      send: cancelRequest,
    },
    form,
  );
}
