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
 * None of them reads an asset id or a version from the form. The asset is the
 * page's own, bound to the action by the form (`action.bind(null, assetId)`, the
 * Next.js way to carry a value a form does not collect); the version comes from
 * the baseline the page signed for **this command**, and a baseline minted for
 * another command, another person, an earlier login or **another asset** opens
 * as nothing and refuses the post before anything is parsed
 * (`REFUSED/BASELINE`).
 */

type State<V, F extends string> = LifecycleFormState<V, F>;

export async function submitActivateAsset(
  assetId: string,
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
    assetId,
    form,
  );
}

export async function submitChangeStatus(
  assetId: string,
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
    assetId,
    form,
  );
}

export async function submitDecommission(
  assetId: string,
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
    assetId,
    form,
  );
}
