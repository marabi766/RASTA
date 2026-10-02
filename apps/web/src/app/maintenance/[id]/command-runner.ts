import { redirect } from 'next/navigation';

import { FLASH_PARAM } from '@/lib/form-fields';
import type { RequestCommandNotice } from '@/lib/maintenance-fields';
import type { RepairCommandNotice } from '@/lib/repair-order-fields';
import { verifyCsrf } from '@/server/csrf';
import { currentSession } from '@/server/current-session';
import { mintFlash } from '@/server/flash';
import { commandRequestId } from '@/server/maintenance-commands';
import type { WebSession } from '@/server/session';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import type { WriteResult } from '@/server/write';

import type { RequestCommandFormState } from './form-state';

/**
 * The one path every command on `/maintenance/[id]` takes, whether it is about
 * the request (`actions.ts`) or about a repair order on it (`repair-actions.ts`).
 *
 * Same order as every write in this portal (ADR-059 § 3, § 5): session, CSRF,
 * the submission id, the request the command is about, what the command
 * confirms, the form, and only then the gateway. Each refusal is decided before
 * the next step runs, so a refused post never reaches it — which the specs
 * beside these files assert for each command.
 *
 * Not a `'use server'` module: that directive turns every export into a
 * network-callable action, and this is a helper two action files share.
 */

export type Parsed<B, F extends string> =
  | { readonly ok: true; readonly body: B }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<F, string>> };

export type CommandNotice = RequestCommandNotice | RepairCommandNotice;

/** What a confirmed command carries on to `send`: what the page signed, not what the form says. */
export interface Confirmed<C> {
  /** The form to read the person's own fields from. */
  readonly form: FormData;
  readonly context: C;
}

export interface Command<V, B, F extends string, C = undefined> {
  readonly notice: CommandNotice;
  /**
   * For a command that confirms something the person was shown: what was shown,
   * put back from what this server signed — or null when the form carries no
   * proof of it. Runs after the request id is known and before anything is
   * parsed, and a null refuses the post.
   */
  readonly confirmed?: (
    session: WebSession,
    form: FormData,
    requestId: string,
  ) => Confirmed<C> | null;
  readonly valuesOf: (form: FormData) => V;
  readonly parse: (values: V) => Parsed<B, F>;
  readonly send: (
    session: WebSession,
    requestId: string,
    body: B,
    submissionId: string,
    context: C,
  ) => Promise<WriteResult<{ id: string }, F>>;
  /** Where to send the person when the service's answer means "look again". */
  readonly lookAgain?: (message: string | null) => CommandNotice | undefined;
}

export async function run<V, B, F extends string, C = undefined>(
  command: Command<V, B, F, C>,
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

  const confirmed = command.confirmed
    ? command.confirmed(session, form, requestId)
    : { form, context: undefined as C };
  if (confirmed === null) return { kind: 'REFUSED', reason: 'BASELINE' };

  const values = command.valuesOf(confirmed.form);
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

  const result = await command.send(
    session,
    requestId,
    parsed.body,
    submissionId,
    confirmed.context,
  );

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
