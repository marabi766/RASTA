import { redirect } from 'next/navigation';

import { BASELINE_FIELD, FLASH_PARAM } from '@/lib/form-fields';
import {
  INBOX_FLASH_SUBJECT,
  isProvenRefusalStatus,
  STALE_MESSAGE,
  type ParsedProjectForm,
  type ProjectCommand,
  type ProjectNotice,
} from '@/lib/project-commands';
import { verifyCsrf } from '@/server/csrf';
import { currentSession, missingSessionReason } from '@/server/current-session';
import { mintFlash } from '@/server/flash';
import {
  openProjectBaseline,
  type ProjectBaseline,
  type WrittenProject,
} from '@/server/project-commands';
import type { WebSession } from '@/server/session';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import type { WriteResult } from '@/server/write';

import type { ProjectFormState } from './project-form-state';

/**
 * The one path every project command takes.
 *
 * Same order as every write in this portal (ADR-059 § 3, § 5): session, CSRF,
 * the submission id, what the command was drawn from, the form, and only then
 * the gateway. Each refusal is decided before the next step runs, so a refused
 * post never reaches it — which `project-actions.spec.ts` asserts for each
 * command.
 *
 * Not a `'use server'` module: that directive turns every export into a
 * network-callable action, and this is a helper the actions share.
 *
 * ## Which project, and where the person goes afterwards
 *
 * The target — a project, or the approval step of a decision — is the page's
 * own, bound to the action by the form (`action.bind(null, targetId, place)`),
 * and the signed baseline must name the same one. `place` says which page drew
 * the form: a project's own, which reads the project again, or the list, whose
 * authority's inbox reads the steps again — an authority of another
 * organization cannot read the project and is not sent to it.
 *
 * ## Why a second press is not a second write
 *
 * Every command is sent with the version its page was drawn at. The first press
 * moves the version, so a second send of the same form is a `409` from
 * construction-service, which this runner sends to a fresh read with a sentence
 * saying nothing was written this time (`stale`).
 */

export type ProjectPlace = 'project' | 'inbox';

export function isProjectPlace(value: unknown): value is ProjectPlace {
  return value === 'project' || value === 'inbox';
}

export interface ProjectCommandSpec<V, B, F extends string> {
  readonly command: ProjectCommand;
  readonly notice: ProjectNotice;
  readonly valuesOf: (form: FormData) => V;
  readonly parse: (values: V, baseline: ProjectBaseline) => ParsedProjectForm<B, F>;
  readonly send: (
    session: WebSession,
    baseline: ProjectBaseline,
    body: B,
  ) => Promise<WriteResult<WrittenProject, F>>;
}

function subjectOf(baseline: ProjectBaseline, place: ProjectPlace): string {
  return place === 'project' ? baseline.projectId : INBOX_FLASH_SUBJECT;
}

function landing(baseline: ProjectBaseline, place: ProjectPlace, flash: string): string {
  return place === 'project'
    ? `/projects/${encodeURIComponent(baseline.projectId)}?${FLASH_PARAM}=${flash}`
    : `/projects?${FLASH_PARAM}=${flash}`;
}

export async function runProjectCommand<V, B, F extends string>(
  command: ProjectCommandSpec<V, B, F>,
  /** The page's own target, bound by the form — never a field of it. */
  targetId: string,
  place: ProjectPlace,
  form: FormData,
): Promise<ProjectFormState<V, F>> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: await missingSessionReason() };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  // Bound to this session: a well-formed id this server never issued, another
  // person's id, and an id from an earlier login are all refused here.
  if (!isBoundSubmissionId(submissionId, session)) {
    return { kind: 'REFUSED', reason: 'SUBMISSION' };
  }
  if (!isProjectPlace(place)) return { kind: 'REFUSED', reason: 'BASELINE' };

  // The target, its version and its status come from here and from nowhere else.
  const baseline = openProjectBaseline(session, form.get(BASELINE_FIELD), command.command);
  if (!baseline) return { kind: 'REFUSED', reason: 'BASELINE' };

  // A baseline is valid for **its** target, and this form belongs to the page's.
  if (baseline.targetId !== targetId) return { kind: 'REFUSED', reason: 'BASELINE' };

  const values = command.valuesOf(form);
  const parsed = command.parse(values, baseline);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const result = await command.send(session, baseline, parsed.body);

  if (result.kind === 'CREATED') {
    // Redirect, not state: a refreshed page must not resubmit, and the page the
    // person lands on reads the record again, so it shows what the command did.
    redirect(
      landing(baseline, place, mintFlash(session, subjectOf(baseline, place), command.notice)),
    );
  }

  switch (result.kind) {
    case 'INVALID':
      if (result.message === STALE_MESSAGE) {
        // The same stale baseline would conflict again, so the typed values are
        // not offered back for another try: the person sees the page as it is.
        redirect(landing(baseline, place, mintFlash(session, subjectOf(baseline, place), 'stale')));
      }
      return {
        kind: 'INVALID',
        submissionId,
        values,
        fieldErrors: result.fieldErrors,
        message: result.message,
      };
    case 'FORBIDDEN':
      return { kind: 'FORBIDDEN', correlationId: result.correlationId };
    case 'NOT_FOUND':
      return { kind: 'NOT_FOUND', correlationId: result.correlationId };
    case 'UNAVAILABLE':
      // "Nothing was changed" only for a refusal that proves it (4xx). A 5xx may
      // follow the commit (the answer is built by a read after it), so it is as
      // unconfirmed as a dropped connection.
      if (!isProvenRefusalStatus(result.status)) {
        return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
      }
      return { kind: 'FAILED', status: result.status, correlationId: result.correlationId };
    case 'IN_PROGRESS':
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe committed, not confirmed: never "nothing was changed". The
      // portal does not retry for the person; pressing the button again carries
      // the same version, so if the first landed the second is a 409 and
      // changes nothing.
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
  }
}
