import { redirect } from 'next/navigation';

import { BASELINE_FIELD, FLASH_PARAM } from '@/lib/form-fields';
import {
  isProvenRefusalStatus,
  STALE_MESSAGE,
  type ParsedProjectForm,
} from '@/lib/project-commands';
import type { NeedCommand, NeedNotice } from '@/lib/project-need-commands';
import { verifyCsrf } from '@/server/csrf';
import { currentSession, missingSessionReason } from '@/server/current-session';
import { mintFlash } from '@/server/flash';
import {
  openNeedBaseline,
  type NeedBaseline,
  type WrittenNeed,
} from '@/server/project-need-commands';
import type { WebSession } from '@/server/session';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import type { WriteResult } from '@/server/write';

import type { ProjectFormState } from './project-form-state';

/**
 * The one path every command on an existing need takes (edit, submit, withdraw).
 *
 * Same order as every write in this portal (ADR-059 § 3, § 5): session, CSRF,
 * the submission id, what the command was drawn from, the form, and only then
 * the gateway. Each refusal is decided before the next step runs, so a refused
 * post never reaches it — which `need-actions.spec.ts` asserts for each command.
 * Adding a need is not here: it is keyed and has its own path (`need-actions.ts`).
 *
 * Not a `'use server'` module: that directive turns every export into a
 * network-callable action, and this is a helper the actions share.
 *
 * ## Which need, and where the person goes afterwards
 *
 * The project and the need are the page's own, bound to the action by the form
 * (`action.bind(null, projectId, needId)`), and the signed baseline must name
 * both. The person always lands on the project's own page, which reads the needs
 * again.
 *
 * ## Why a second press is not a second write
 *
 * Every command is sent with the version its page was drawn at. The first press
 * moves the version, so a second send of the same form is a `409` from
 * construction-service, which this runner sends to a fresh read with a sentence
 * saying nothing was written this time (`stale`). The result is the same family of
 * states as the project's commands (`ProjectFormState`), so a lost answer is
 * `UNCONFIRMED` and never "nothing changed": none of these calls takes a key, and
 * the portal does not send them again for the person.
 */

export interface NeedCommandSpec<V, B, F extends string> {
  readonly command: NeedCommand;
  readonly notice: NeedNotice;
  readonly valuesOf: (form: FormData) => V;
  readonly parse: (values: V, baseline: NeedBaseline) => ParsedProjectForm<B, F>;
  readonly send: (
    session: WebSession,
    baseline: NeedBaseline,
    body: B,
  ) => Promise<WriteResult<WrittenNeed, F>>;
}

const landing = (projectId: string, flash: string): string =>
  `/projects/${encodeURIComponent(projectId)}?${FLASH_PARAM}=${flash}`;

export async function runNeedCommand<V, B, F extends string>(
  command: NeedCommandSpec<V, B, F>,
  /** The page's own project and need, bound by the form — never fields of it. */
  projectId: string,
  needId: string,
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

  // The need, its version and its status come from here and from nowhere else.
  const baseline = openNeedBaseline(session, form.get(BASELINE_FIELD), command.command);
  if (!baseline) return { kind: 'REFUSED', reason: 'BASELINE' };

  // A baseline is valid for **its** need and project, and this form belongs to the page's.
  if (baseline.needId !== needId || baseline.projectId !== projectId) {
    return { kind: 'REFUSED', reason: 'BASELINE' };
  }

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
    // person lands on reads the needs again, so it shows what the command did.
    redirect(landing(projectId, mintFlash(session, projectId, command.notice)));
  }

  switch (result.kind) {
    case 'INVALID':
      if (result.message === STALE_MESSAGE) {
        // The same stale baseline would conflict again, so the typed values are
        // not offered back for another try: the person sees the page as it is.
        redirect(landing(projectId, mintFlash(session, projectId, 'stale')));
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
      // The request provably never left this portal (connection refused, DNS): nothing was changed.
      if (result.neverSent) {
        return { kind: 'FAILED', status: result.status, correlationId: result.correlationId };
      }
      // "Nothing was changed" otherwise only for a refusal that proves it (4xx). A 5xx may
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
