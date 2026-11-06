import { redirect } from 'next/navigation';

import { REPLAY_FIELD } from '@/lib/form-fields';
import { demandFormValues, parseDemandForm } from '@/lib/demand-commands';
import { verifyCsrf } from '@/server/csrf';
import { currentSession, missingSessionReason } from '@/server/current-session';
import { provenUnwritten, submitDemand } from '@/server/demand-commands';
import {
  DEMAND_SUBMIT_UNRESOLVED,
  demandBodyDigest,
  demandStampTerms,
} from '@/server/demand-replay';
import { flashHref } from '@/server/flash';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import { reserveUnresolved, settleUnresolved } from '@/server/unresolved-request';
import { MAX_CLOCK_SKEW_MS } from '@/server/unresolved-request-policy';

import type { DemandFormState } from './demand-form-state';

/**
 * The path a demand submission takes. Not a `'use server'` module: that
 * directive would make every export network-callable.
 *
 * Same order as every write in this portal (ADR-059 § 3, § 5): session, CSRF,
 * the submission id, its signed deadline, the form, the reservation, a last
 * deadline check, and only then the gateway. Each refusal is decided before the
 * next step runs, so a refused post never reaches the gateway
 * (`demand-actions.spec.ts` asserts it per step).
 *
 * ## Why a lost answer cannot become a second demand
 *
 * The request is **reserved on the server before it is sent**
 * (`server/unresolved-request.ts`: one atomic step per organization and login)
 * and kept when the answer is ambiguous — a lost response to the browser loses
 * nothing, because nothing lives in the response. While it is held, the only
 * request that may go out is that very one — its key, its body, inside its
 * deadline — which procurement-service answers with the first result; anything
 * else is `HELD`. A new key needs the person's explicit release, after checking
 * the full list. The store unreachable is not "no hold": nothing is sent.
 *
 * Every send carries the record's deadline as `Idempotency-Replay-Deadline`, and
 * procurement-service refuses it on its own clock once passed (FU-156): the
 * portal's check below and its margin are a second guard, not the guarantee.
 *
 * ## A refused retry keeps the earlier attempt's uncertainty (PR-830 r1 F1)
 *
 * A refusal — or a send that never left — proves only that THIS attempt did
 * nothing. When it was a retry of an unresolved request, the earlier attempt may
 * still have registered the demand: the store keeps the hold (a retry's `REFUSED`
 * / `NEVER_SENT` puts it back to unresolved) and the person is told the same —
 * `UNCONFIRMED`, check the list — never "nothing changed".
 */
export async function runSubmitDemand(form: FormData): Promise<DemandFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: await missingSessionReason() };
  if (!verifyCsrf(session, form).ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  // Bound to this session: an id this server never issued, another person's, or
  // one from an earlier login is refused before anything is sent.
  if (!isBoundSubmissionId(submissionId, session)) {
    return { kind: 'REFUSED', reason: 'SUBMISSION' };
  }

  const values = demandFormValues(form);

  // Until when this request may be sent under its key: the stamp the page signed.
  const replay = form.get(REPLAY_FIELD);
  const terms = demandStampTerms(session, replay, submissionId);
  if (terms === null || typeof replay !== 'string') {
    return { kind: 'REFUSED', reason: 'SUBMISSION' };
  }
  if (terms.expired) return { kind: 'EXPIRED', values };

  const parsed = parseDemandForm(values);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId,
      replay,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const reserved = await reserveUnresolved(session, DEMAND_SUBMIT_UNRESOLVED, {
    key: submissionId,
    digest: demandBodyDigest(session, parsed.body),
    ref: replay,
    issuedAt: terms.issuedAt,
    deadline: terms.deadline,
    windowMs: terms.windowMs,
  });
  switch (reserved.kind) {
    case 'UNAVAILABLE':
      return { kind: 'NOT_CHECKED', values };
    case 'CAPACITY':
      return { kind: 'CAPACITY', values };
    case 'EXPIRED':
      return { kind: 'EXPIRED', values };
    case 'HELD':
      return {
        kind: 'HELD',
        reason: reserved.reason === 'RECONCILE_ONLY' ? 'OTHER_REQUEST' : reserved.reason,
        values,
      };
    case 'RESERVED':
      break;
  }
  const { attempt } = reserved;
  /** A refusal of THIS attempt, as said to the person: a retry's earlier attempt stays unconfirmed. */
  const refused = (state: DemandFormState, correlationId: string): DemandFormState =>
    reserved.retry ? { kind: 'UNCONFIRMED', correlationId } : state;

  // Again right before the dispatch: the process may have paused since the
  // reservation. A second guard: procurement-service refuses the same deadline on
  // its own clock (FU-156). A refusal here proves only that THIS attempt did
  // nothing: a retry of an unresolved request stays held, and EXPIRED says so.
  const deadline = reserved.deadline;
  if (deadline === null || Date.now() + MAX_CLOCK_SKEW_MS > deadline) {
    await settleUnresolved(attempt, 'REFUSED');
    return { kind: 'EXPIRED', values };
  }

  let result;
  try {
    result = await submitDemand(session, parsed.body, submissionId, deadline);
  } catch (error) {
    // Anything unexpected after the request may have gone out: unresolved.
    await settleUnresolved(attempt, 'UNRESOLVED');
    throw error;
  }

  if (result.kind === 'CREATED') {
    await settleUnresolved(attempt, 'CONFIRMED');
    // Redirect, not state: a refresh must not resubmit, and the page landed on
    // reads the demand again, through the same tenant wall as any read.
    redirect(
      flashHref(
        session,
        `/procurement/demands/${encodeURIComponent(result.data.id)}`,
        result.data.id,
        'submitted',
      ),
    );
  }

  switch (result.kind) {
    case 'INVALID':
      await settleUnresolved(attempt, 'REFUSED');
      return refused(
        {
          kind: 'INVALID',
          submissionId,
          replay,
          values,
          fieldErrors: result.fieldErrors,
          message: result.message,
        },
        result.correlationId,
      );
    case 'FORBIDDEN':
      await settleUnresolved(attempt, 'REFUSED');
      return refused(
        { kind: 'FORBIDDEN', correlationId: result.correlationId },
        result.correlationId,
      );
    case 'NOT_FOUND':
      // The endpoint names no resource to be absent; the shared type is handled, not assumed away.
      await settleUnresolved(attempt, 'REFUSED');
      return refused(
        { kind: 'FAILED', status: 404, correlationId: result.correlationId },
        result.correlationId,
      );
    case 'UNAVAILABLE':
      // EXPIRED already says an earlier send may have registered it: true for a retry too.
      if (result.replayWindowClosed) {
        await settleUnresolved(attempt, 'REFUSED');
        return { kind: 'EXPIRED', values };
      }
      if (result.neverSent) {
        await settleUnresolved(attempt, 'NEVER_SENT');
        return refused(
          { kind: 'FAILED', status: result.status, correlationId: result.correlationId },
          result.correlationId,
        );
      }
      // "Nothing changed" only where the answer proves it; a 5xx may follow the commit.
      if (!provenUnwritten(result.status, result.code)) {
        await settleUnresolved(attempt, 'UNRESOLVED');
        return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
      }
      await settleUnresolved(attempt, 'REFUSED');
      return refused(
        { kind: 'FAILED', status: result.status, correlationId: result.correlationId },
        result.correlationId,
      );
    case 'UNKNOWN_OUTCOME':
      await settleUnresolved(attempt, 'UNRESOLVED');
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
    case 'IN_PROGRESS':
      // The first send of this form is still running: the same values under the
      // same key, after the wait, are answered with its result — never a second demand.
      await settleUnresolved(attempt, 'UNRESOLVED');
      return {
        kind: 'IN_PROGRESS',
        submissionId,
        replay,
        values,
        retryAfterSeconds: result.retryAfterSeconds,
        correlationId: result.correlationId,
      };
  }
}
