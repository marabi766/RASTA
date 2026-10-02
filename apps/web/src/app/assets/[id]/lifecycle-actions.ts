'use server';

import type {
  ActivateAssetFormValues,
  ChangeStatusField,
  ChangeStatusFormValues,
  DecommissionField,
  DecommissionFormValues,
} from '@/lib/asset-lifecycle-fields';
import {
  activateAsset,
  activateFormValues,
  changeAssetStatus,
  changeStatusFormValues,
  decommissionAsset,
  decommissionFormValues,
  parseActivateForm,
  parseChangeStatusForm,
  parseDecommissionForm,
} from '@/server/asset-lifecycle-commands';

import type { LifecycleFormState } from './lifecycle-form-state';
import { runLifecycle } from './lifecycle-runner';

/**
 * The three lifecycle commands on a machine: activate, change status,
 * decommission. They run through `lifecycle-runner.ts`.
 *
 * None of them reads an asset id or a version from the form. Each takes both from
 * the baseline the page signed for **this command**, and a baseline minted for
 * another command, another person or an earlier login opens as nothing and
 * refuses the post before anything is parsed (`REFUSED/BASELINE`).
 */

type State<V, F extends string> = LifecycleFormState<V, F>;

export async function submitActivateAsset(
  _previous: State<ActivateAssetFormValues, never>,
  form: FormData,
): Promise<State<ActivateAssetFormValues, never>> {
  return runLifecycle(
    {
      command: 'activate',
      notice: 'activated',
      valuesOf: activateFormValues,
      parse: parseActivateForm,
      send: (session, baseline, _body, submissionId) =>
        activateAsset(session, baseline.assetId, baseline.version, submissionId),
    },
    form,
  );
}

export async function submitChangeStatus(
  _previous: State<ChangeStatusFormValues, ChangeStatusField>,
  form: FormData,
): Promise<State<ChangeStatusFormValues, ChangeStatusField>> {
  return runLifecycle(
    {
      command: 'status',
      notice: 'statusChanged',
      valuesOf: changeStatusFormValues,
      parse: (values, baseline) => parseChangeStatusForm(values, baseline.status),
      send: (session, baseline, body, submissionId) =>
        changeAssetStatus(session, baseline.assetId, body, baseline.version, submissionId),
    },
    form,
  );
}

export async function submitDecommission(
  _previous: State<DecommissionFormValues, DecommissionField>,
  form: FormData,
): Promise<State<DecommissionFormValues, DecommissionField>> {
  return runLifecycle(
    {
      command: 'decommission',
      notice: 'decommissioned',
      valuesOf: decommissionFormValues,
      parse: parseDecommissionForm,
      send: (session, baseline, body, submissionId) =>
        decommissionAsset(session, baseline.assetId, body, baseline.version, submissionId),
    },
    form,
  );
}
