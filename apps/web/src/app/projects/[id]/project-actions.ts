'use server';

import {
  cancelFormValues,
  grantFormValues,
  noFormValues,
  parseCancelForm,
  parseEditForm,
  parseGrantForm,
  parseNoForm,
  parseRejectForm,
  projectFormValues,
  rejectFormValues,
  type CancelField,
  type CancelFormValues,
  type GrantField,
  type GrantFormValues,
  type NoFormValues,
  type ProjectField,
  type ProjectFormValues,
  type RejectField,
  type RejectFormValues,
} from '@/lib/project-commands';
import {
  cancelProject,
  completeProject,
  grantApproval,
  rejectApproval,
  requestApproval,
  startProject,
  unchangedFields,
  updateProject,
} from '@/server/project-commands';

import type { ProjectFormState } from './project-form-state';
import { runProjectCommand, type ProjectPlace } from './project-runner';

/**
 * The commands on a project and an authority's decision. They run through
 * `project-runner.ts`.
 *
 * None of them reads a project id, an approval id or a version from the form.
 * The target is the page's own, bound to the action by the form
 * (`action.bind(null, targetId, place)`); the version comes from the baseline
 * the page signed for **that command**, and a baseline minted for another
 * command, another person, an earlier login or another target opens as nothing
 * and refuses the post before anything is parsed (`REFUSED/BASELINE`). Whether
 * the command is allowed is not decided here: construction-service decides —
 * role, tenant, lifecycle state, the approval policy — and its refusal is said
 * in fixed words.
 */

type State<V, F extends string> = ProjectFormState<V, F>;

export async function submitEditProject(
  projectId: string,
  place: ProjectPlace,
  _previous: State<ProjectFormValues, ProjectField>,
  form: FormData,
): Promise<State<ProjectFormValues, ProjectField>> {
  return runProjectCommand(
    {
      command: 'edit',
      notice: 'updated',
      valuesOf: projectFormValues,
      parse: (values, baseline) => parseEditForm(values, unchangedFields(baseline, values)),
      send: (session, baseline, body) =>
        updateProject(session, baseline.projectId, body, baseline.version),
    },
    projectId,
    place,
    form,
  );
}

export async function submitRequestApproval(
  projectId: string,
  place: ProjectPlace,
  _previous: State<NoFormValues, never>,
  form: FormData,
): Promise<State<NoFormValues, never>> {
  return runProjectCommand(
    {
      command: 'requestApproval',
      notice: 'approvalRequested',
      valuesOf: noFormValues,
      parse: parseNoForm,
      send: (session, baseline) => requestApproval(session, baseline.projectId, baseline.version),
    },
    projectId,
    place,
    form,
  );
}

export async function submitStartProject(
  projectId: string,
  place: ProjectPlace,
  _previous: State<NoFormValues, never>,
  form: FormData,
): Promise<State<NoFormValues, never>> {
  return runProjectCommand(
    {
      command: 'start',
      notice: 'started',
      valuesOf: noFormValues,
      parse: parseNoForm,
      send: (session, baseline) => startProject(session, baseline.projectId, baseline.version),
    },
    projectId,
    place,
    form,
  );
}

export async function submitCompleteProject(
  projectId: string,
  place: ProjectPlace,
  _previous: State<NoFormValues, never>,
  form: FormData,
): Promise<State<NoFormValues, never>> {
  return runProjectCommand(
    {
      command: 'complete',
      notice: 'completionRequested',
      valuesOf: noFormValues,
      parse: parseNoForm,
      send: (session, baseline) => completeProject(session, baseline.projectId, baseline.version),
    },
    projectId,
    place,
    form,
  );
}

export async function submitCancelProject(
  projectId: string,
  place: ProjectPlace,
  _previous: State<CancelFormValues, CancelField>,
  form: FormData,
): Promise<State<CancelFormValues, CancelField>> {
  return runProjectCommand(
    {
      command: 'cancel',
      notice: 'cancelled',
      valuesOf: cancelFormValues,
      parse: parseCancelForm,
      send: (session, baseline, body) =>
        cancelProject(session, baseline.projectId, body, baseline.version),
    },
    projectId,
    place,
    form,
  );
}

export async function submitGrantApproval(
  approvalId: string,
  place: ProjectPlace,
  _previous: State<GrantFormValues, GrantField>,
  form: FormData,
): Promise<State<GrantFormValues, GrantField>> {
  return runProjectCommand(
    {
      command: 'grant',
      notice: 'granted',
      valuesOf: grantFormValues,
      parse: parseGrantForm,
      send: (session, baseline, body) =>
        grantApproval(session, baseline.targetId, body, baseline.version),
    },
    approvalId,
    place,
    form,
  );
}

export async function submitRejectApproval(
  approvalId: string,
  place: ProjectPlace,
  _previous: State<RejectFormValues, RejectField>,
  form: FormData,
): Promise<State<RejectFormValues, RejectField>> {
  return runProjectCommand(
    {
      command: 'reject',
      notice: 'rejected',
      valuesOf: rejectFormValues,
      parse: parseRejectForm,
      send: (session, baseline, body) =>
        rejectApproval(session, baseline.targetId, body, baseline.version),
    },
    approvalId,
    place,
    form,
  );
}
