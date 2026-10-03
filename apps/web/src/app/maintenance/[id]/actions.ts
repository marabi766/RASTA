'use server';

import { BASELINE_FIELD } from '@/lib/form-fields';
import type {
  ApproveRequestField,
  ApproveRequestFormValues,
  AssignWorkshopField,
  AssignWorkshopFormValues,
  CancelRequestField,
  CancelRequestFormValues,
} from '@/lib/maintenance-fields';
import {
  APPROVAL_TOTAL_CHANGED_MESSAGE,
  approveRequest,
  approveRequestFormValues,
  assignWorkshop,
  assignWorkshopFormValues,
  cancelRequest,
  cancelRequestFormValues,
  openApprovalBaseline,
  parseApproveRequestForm,
  parseAssignWorkshopForm,
  parseCancelRequestForm,
} from '@/server/maintenance-commands';

import { run } from './command-runner';
import type { RequestCommandFormState } from './form-state';

/**
 * The three commands on a request: refer to a workshop, approve the cost,
 * cancel. They run through `command-runner.ts` (session, CSRF, bound submission
 * id, request, what the command confirms, form, gateway), which the spec beside
 * this file asserts for each command.
 */

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
      // The request and the total are what the page signed, not what the form
      // says: the hidden fields are not read for either.
      confirmed: (session, posted, requestId) => {
        const baseline = openApprovalBaseline(session, posted.get(BASELINE_FIELD), requestId);
        if (!baseline) return null;
        const shown = new FormData();
        shown.set('requestId', baseline.requestId);
        shown.set('expectedTotalCostMinor', baseline.totalCostMinor);
        const notes = posted.get('notes');
        if (typeof notes === 'string') shown.set('notes', notes);
        return { form: shown, context: undefined };
      },
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
