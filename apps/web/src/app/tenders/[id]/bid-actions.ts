'use server';

import { redirect } from 'next/navigation';

import { FLASH_PARAM, REPLAY_FIELD } from '@/lib/form-fields';
import { bidFormValues, parseBid, type BidContent, type BidFormValues } from '@/lib/bid-input';
import { verifyBidStamp } from '@/server/bid-replay';
import { currentSession, missingSessionReason } from '@/server/current-session';
import { verifyCsrf } from '@/server/csrf';
import { mintFlash } from '@/server/flash';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import { bidRequest, issueBidCommand } from '@/server/tender-bids';

import { afterRetry, type BidFormState } from './bid-form-state';

/**
 * The server action behind the bid forms on `/tenders/[id]`.
 *
 * The order of every write in this portal (ADR-059 § 3, § 5): session, CSRF,
 * submission id, the signed replay stamp (`server/bid-replay.ts`), the form,
 * then the gateway — each gate returning before the next runs. The tender is
 * bound by the route, the bid and the revision by the stamp; only the content
 * comes from the form.
 *
 * **Whether the command is allowed is not decided here.** construction-service
 * decides — the bidder's role, the tender's visibility and invitation, the
 * window on its own clock, the organization's standing at supplier-service —
 * and its refusal is said in fixed words; the page only chose what to draw.
 *
 * Once a command is unconfirmed, no answer to a retry but a successful one
 * (which redirects) may claim the first request did not commit.
 */
export async function submitBidCommand(
  tenderId: string,
  previous: BidFormState,
  form: FormData,
): Promise<BidFormState> {
  const state = await attempt(tenderId, form);
  return previous.kind === 'UNCONFIRMED' ? afterRetry(previous, state) : state;
}

async function attempt(tenderId: string, form: FormData): Promise<BidFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: await missingSessionReason() };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  if (!isBoundSubmissionId(submissionId, session)) return { kind: 'REFUSED', reason: 'SUBMISSION' };

  // On every send under this key — the first and each retry — against the
  // deadline and the binding signed when the form was drawn.
  const stamp = verifyBidStamp(session, form.get(REPLAY_FIELD), tenderId, submissionId);
  if (!stamp) return { kind: 'REFUSED', reason: 'REPLAY' };
  const { command } = stamp;

  let values: BidFormValues | null = null;
  let content: BidContent | null = null;
  let rows: readonly number[] = [];
  if (command !== 'WITHDRAW') {
    values = bidFormValues(form);
    const parsed = parseBid(values);
    if (!parsed.ok) {
      return {
        kind: 'INVALID',
        command,
        submissionId,
        values,
        fieldErrors: parsed.fieldErrors,
        message: null,
      };
    }
    content = parsed.content;
    rows = parsed.rows;
  }

  const request = bidRequest(tenderId, stamp, content);
  if (!request) return { kind: 'REFUSED', reason: 'COMMAND' };

  const result = await issueBidCommand(session, tenderId, stamp, request, rows, submissionId);
  switch (result.kind) {
    case 'CREATED':
      return redirect(
        `/tenders/${encodeURIComponent(tenderId)}?view=open&${FLASH_PARAM}=${mintFlash(session, tenderId, command)}`,
      );
    case 'INVALID':
      return {
        kind: 'INVALID',
        command,
        submissionId,
        values,
        fieldErrors: result.fieldErrors,
        message: result.message,
      };
    case 'FORBIDDEN':
      return {
        kind: 'FORBIDDEN',
        correlationId: result.correlationId,
        reasons: result.reasons ?? [],
      };
    case 'NOT_FOUND':
      return { kind: 'NOT_FOUND' };
    case 'IN_PROGRESS':
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe committed, not confirmed: never "nothing changed". What is
      // kept for the retry is what was sent, so the retry is the same request.
      return {
        kind: 'UNCONFIRMED',
        command,
        correlationId: result.correlationId,
        submissionId,
        values,
        replay: { token: stamp.token, until: stamp.until },
      };
  }
}
