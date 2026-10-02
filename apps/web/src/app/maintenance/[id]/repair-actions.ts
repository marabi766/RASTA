'use server';

import { BASELINE_FIELD } from '@/lib/form-fields';
import type {
  CancelRepairField,
  CancelRepairFormValues,
  CompleteRepairField,
  CompleteRepairFormValues,
  RecordCostField,
  RecordCostFormValues,
  RecordLabourField,
  RecordLabourFormValues,
  RecordPartField,
  RecordPartFormValues,
  RepairCommandName,
  StartRepairField,
  StartRepairFormValues,
} from '@/lib/repair-order-fields';
import {
  REPAIR_TOTAL_CHANGED_MESSAGE,
  cancelRepair,
  cancelRepairFormValues,
  completeRepair,
  completeRepairFormValues,
  openRepairOrderBaseline,
  parseCancelRepairForm,
  parseCompleteRepairForm,
  parseRecordCostForm,
  parseRecordLabourForm,
  parseRecordPartForm,
  parseStartRepairForm,
  recordCost,
  recordCostFormValues,
  recordLabour,
  recordLabourFormValues,
  recordPart,
  recordPartFormValues,
  startRepair,
  startRepairFormValues,
  type RepairOrderBaseline,
} from '@/server/repair-order-commands';
import type { WebSession } from '@/server/session';

import { run, type Confirmed } from './command-runner';
import type { RequestCommandFormState } from './form-state';

/**
 * The six commands on a repair order: start, complete, withdraw, and record a
 * part, labour or any other cost. They run through `command-runner.ts`.
 *
 * None of them reads an order id from the form. Each one's `confirmed` step
 * opens the baseline the page signed for **this command under this request**
 * and the order comes out of that: a form with its hidden fields rewritten has
 * no order id to rewrite, and a baseline minted for another command, another
 * request, another person or an earlier login opens as nothing and refuses the
 * post before anything is parsed (`REFUSED/BASELINE`).
 */

/** The form with the person's own fields, and the order the page signed. */
const forOrder =
  (command: RepairCommandName) =>
  (
    session: WebSession,
    posted: FormData,
    requestId: string,
  ): Confirmed<RepairOrderBaseline> | null => {
    const baseline = openRepairOrderBaseline(
      session,
      posted.get(BASELINE_FIELD),
      requestId,
      command,
    );
    return baseline ? { form: posted, context: baseline } : null;
  };

type State<V, F extends string> = RequestCommandFormState<V, F>;

export async function submitStartRepair(
  _previous: State<StartRepairFormValues, StartRepairField>,
  form: FormData,
): Promise<State<StartRepairFormValues, StartRepairField>> {
  return run(
    {
      notice: 'repairStarted',
      confirmed: forOrder('start'),
      valuesOf: startRepairFormValues,
      parse: parseStartRepairForm,
      send: (session, _requestId, body, submissionId, order) =>
        startRepair(session, order.repairOrderId, body, submissionId),
    },
    form,
  );
}

export async function submitCompleteRepair(
  _previous: State<CompleteRepairFormValues, CompleteRepairField>,
  form: FormData,
): Promise<State<CompleteRepairFormValues, CompleteRepairField>> {
  return run(
    {
      notice: 'repairCompleted',
      confirmed: forOrder('complete'),
      valuesOf: completeRepairFormValues,
      parse: parseCompleteRepairForm,
      // The total the page showed goes back with the completion, and the
      // service refuses — atomically — if a part or a charge landed since.
      send: (session, _requestId, body, submissionId, order) =>
        completeRepair(
          session,
          order.repairOrderId,
          { ...body, expectedTotalCostMinor: order.totalCostMinor },
          submissionId,
        ),
      lookAgain: (message) =>
        message === REPAIR_TOTAL_CHANGED_MESSAGE ? 'repairCostChanged' : undefined,
    },
    form,
  );
}

export async function submitCancelRepair(
  _previous: State<CancelRepairFormValues, CancelRepairField>,
  form: FormData,
): Promise<State<CancelRepairFormValues, CancelRepairField>> {
  return run(
    {
      notice: 'repairCancelled',
      confirmed: forOrder('cancel'),
      valuesOf: cancelRepairFormValues,
      parse: parseCancelRepairForm,
      send: (session, _requestId, body, submissionId, order) =>
        cancelRepair(session, order.repairOrderId, body, submissionId),
    },
    form,
  );
}

export async function submitRecordPart(
  _previous: State<RecordPartFormValues, RecordPartField>,
  form: FormData,
): Promise<State<RecordPartFormValues, RecordPartField>> {
  return run(
    {
      notice: 'partRecorded',
      confirmed: forOrder('part'),
      valuesOf: recordPartFormValues,
      parse: parseRecordPartForm,
      send: (session, _requestId, body, submissionId, order) =>
        recordPart(session, order.repairOrderId, body, submissionId),
    },
    form,
  );
}

export async function submitRecordLabour(
  _previous: State<RecordLabourFormValues, RecordLabourField>,
  form: FormData,
): Promise<State<RecordLabourFormValues, RecordLabourField>> {
  return run(
    {
      notice: 'labourRecorded',
      confirmed: forOrder('labour'),
      valuesOf: recordLabourFormValues,
      parse: parseRecordLabourForm,
      send: (session, _requestId, body, submissionId, order) =>
        recordLabour(session, order.repairOrderId, body, submissionId),
    },
    form,
  );
}

export async function submitRecordCost(
  _previous: State<RecordCostFormValues, RecordCostField>,
  form: FormData,
): Promise<State<RecordCostFormValues, RecordCostField>> {
  return run(
    {
      notice: 'costRecorded',
      confirmed: forOrder('cost'),
      valuesOf: recordCostFormValues,
      parse: parseRecordCostForm,
      send: (session, _requestId, body, submissionId, order) =>
        recordCost(session, order.repairOrderId, body, submissionId),
    },
    form,
  );
}
