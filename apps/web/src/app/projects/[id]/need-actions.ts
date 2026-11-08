'use server';

import {
  needFormValues,
  parseEditNeedForm,
  parseSubmitNeedForm,
  parseWithdrawNeedForm,
  withdrawNeedFormValues,
  type NeedField,
  type NeedFormValues,
  type WithdrawNeedField,
  type WithdrawNeedFormValues,
} from '@/lib/project-need-commands';
import {
  fenceOf,
  submitNeed,
  unchangedNeedFields,
  updateNeed,
  withdrawNeed,
} from '@/server/project-need-commands';

import { runNeedCommand } from './need-runner';
import type { ProjectFormState } from './project-form-state';

/**
 * The commands on a project's existing needs: editing, submitting and withdrawing,
 * all through `need-runner.ts` and held to the shared retry rule
 * (`server/unconfirmed-retry.ts`, FU-173). Adding is keyed and store-backed, and
 * lives in `need-add-actions.ts` with its release.
 *
 * None of them reads a project id, a need id or a version from the form. The
 * target is the page's own, bound to the action by the form
 * (`action.bind(null, projectId, needId)`); the need's version and the project's
 * (the editing episode) come from the baseline the page signed for **that command**, and a baseline minted for another
 * command, another person, an earlier login or another need opens as nothing and
 * refuses the post before anything is parsed (`REFUSED/BASELINE`). Whether the
 * command is allowed is not decided here: construction-service decides — role,
 * tenant, the need's and the project's state — and its refusal is said in fixed
 * words.
 */

type State<V, F extends string> = ProjectFormState<V, F>;

export async function submitEditNeed(
  projectId: string,
  needId: string,
  previous: State<NeedFormValues, NeedField>,
  form: FormData,
): Promise<State<NeedFormValues, NeedField>> {
  return runNeedCommand(
    {
      command: 'edit',
      notice: 'needUpdated',
      valuesOf: needFormValues,
      parse: (values, baseline) => parseEditNeedForm(values, unchangedNeedFields(baseline, values)),
      send: (session, baseline, body) =>
        updateNeed(session, baseline.projectId, baseline.needId, body, fenceOf(baseline)),
    },
    projectId,
    needId,
    previous,
    form,
  );
}

export async function submitSubmitNeed(
  projectId: string,
  needId: string,
  previous: State<Readonly<Record<string, never>>, never>,
  form: FormData,
): Promise<State<Readonly<Record<string, never>>, never>> {
  return runNeedCommand(
    {
      command: 'submit',
      notice: 'needSubmitted',
      valuesOf: () => ({}),
      parse: parseSubmitNeedForm,
      send: (session, baseline) =>
        submitNeed(session, baseline.projectId, baseline.needId, fenceOf(baseline)),
    },
    projectId,
    needId,
    previous,
    form,
  );
}

export async function submitWithdrawNeed(
  projectId: string,
  needId: string,
  previous: State<WithdrawNeedFormValues, WithdrawNeedField>,
  form: FormData,
): Promise<State<WithdrawNeedFormValues, WithdrawNeedField>> {
  return runNeedCommand(
    {
      command: 'withdraw',
      notice: 'needWithdrawn',
      valuesOf: withdrawNeedFormValues,
      parse: parseWithdrawNeedForm,
      send: (session, baseline, body) =>
        withdrawNeed(session, baseline.projectId, baseline.needId, body, fenceOf(baseline)),
    },
    projectId,
    needId,
    previous,
    form,
  );
}
