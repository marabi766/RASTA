'use server';

import type {
  RecordInspectionField,
  RecordInspectionFormValues,
  RecordPolicyField,
  RecordPolicyFormValues,
} from '@/lib/asset-record-fields';
import {
  parseRecordInspectionForm,
  parseRecordPolicyForm,
  recordInspection,
  recordInspectionFormValues,
  recordInsurancePolicy,
  recordPolicyFormValues,
} from '@/server/asset-records';

import type { RecordFormState } from './record-form-state';
import { runRecord } from './record-runner';

/**
 * The two records a machine's page takes: an insurance policy and a technical
 * inspection. They run through `record-runner.ts`.
 *
 * Neither reads an asset id from the form: the asset is the page's own, bound to
 * the action by the form (`action.bind(null, assetId)`) and named by the signed
 * baseline the page minted for that form.
 */

type State<V, F extends string> = RecordFormState<V, F>;

export async function submitRecordPolicy(
  assetId: string,
  _previous: State<RecordPolicyFormValues, RecordPolicyField>,
  form: FormData,
): Promise<State<RecordPolicyFormValues, RecordPolicyField>> {
  return runRecord(
    {
      record: 'policy',
      notice: 'policyRecorded',
      valuesOf: recordPolicyFormValues,
      parse: parseRecordPolicyForm,
      send: recordInsurancePolicy,
    },
    assetId,
    form,
  );
}

export async function submitRecordInspection(
  assetId: string,
  _previous: State<RecordInspectionFormValues, RecordInspectionField>,
  form: FormData,
): Promise<State<RecordInspectionFormValues, RecordInspectionField>> {
  return runRecord(
    {
      record: 'inspection',
      notice: 'inspectionRecorded',
      valuesOf: recordInspectionFormValues,
      parse: parseRecordInspectionForm,
      send: recordInspection,
    },
    assetId,
    form,
  );
}
