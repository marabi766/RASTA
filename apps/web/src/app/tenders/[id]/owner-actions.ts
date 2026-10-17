'use server';

import { redirect } from 'next/navigation';

import { FLASH_PARAM, REPLAY_FIELD } from '@/lib/form-fields';
import { parseRejectReason } from '@/lib/tender-owner-input';
import { REASON_FIELD } from '@/lib/tender-owner-fields';
import { currentSession, missingSessionReason } from '@/server/current-session';
import { verifyCsrf } from '@/server/csrf';
import { mintFlash } from '@/server/flash';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import { issueOwnerCommand, outcomeOf, ownerRequest } from '@/server/tender-owner';
import { verifyOwnerStamp } from '@/server/tender-owner-replay';

import { afterRetry, type OwnerFormState } from './owner-form-state';

/**
 * The server action behind the owner's forms on `/tenders/[id]`.
 *
 * The order of every write in this portal (ADR-059 § 3, § 5): session, CSRF,
 * submission id, the signed replay stamp (`server/tender-owner-replay.ts`),
 * the form, then the gateway. The tender is bound by the route; the command,
 * the step and the version by the stamp; only a rejection's reason comes from
 * the form.
 *
 * **Whether the command is allowed is not decided here.** construction-service
 * decides — the owner's roles, the approval gate and its authority, identity
 * now, separation of duties, the two people of an opening, conflicts of
 * interest — and its refusal is said in fixed words.
 */
export async function submitOwnerCommand(
  tenderId: string,
  previous: OwnerFormState,
  form: FormData,
): Promise<OwnerFormState> {
  const state = await attempt(tenderId, form);
  return previous.kind === 'UNCONFIRMED' ? afterRetry(previous, state) : state;
}

async function attempt(tenderId: string, form: FormData): Promise<OwnerFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: await missingSessionReason() };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  if (!isBoundSubmissionId(submissionId, session)) return { kind: 'REFUSED', reason: 'SUBMISSION' };

  const stamp = verifyOwnerStamp(session, form.get(REPLAY_FIELD), tenderId, submissionId);
  if (!stamp) return { kind: 'REFUSED', reason: 'REPLAY' };
  const { command } = stamp;

  let reason: string | null = null;
  if (command === 'REJECT') {
    const raw = form.get(REASON_FIELD);
    const parsed = parseRejectReason(typeof raw === 'string' ? raw : '');
    if (!parsed.ok) {
      return {
        kind: 'INVALID',
        command,
        submissionId,
        reason: typeof raw === 'string' ? raw : '',
        fieldErrors: { [REASON_FIELD]: parsed.message },
        message: null,
      };
    }
    reason = parsed.reason;
  }

  const request = ownerRequest(tenderId, stamp, reason);
  if (!request) return { kind: 'REFUSED', reason: 'COMMAND' };

  const result = await issueOwnerCommand(session, tenderId, stamp, request, submissionId);
  switch (result.kind) {
    case 'CREATED':
      return redirect(
        `/tenders/${encodeURIComponent(tenderId)}?view=own&${FLASH_PARAM}=${mintFlash(session, tenderId, outcomeOf(command, result.data))}`,
      );
    case 'INVALID':
      return {
        kind: 'INVALID',
        command,
        submissionId,
        reason,
        fieldErrors: result.fieldErrors,
        message: result.message,
      };
    case 'FORBIDDEN':
      return {
        kind: 'FORBIDDEN',
        command,
        correlationId: result.correlationId,
        reasons: result.reasons ?? [],
      };
    case 'NOT_FOUND':
      return { kind: 'NOT_FOUND' };
    case 'IN_PROGRESS':
    case 'UNKNOWN_OUTCOME':
      return {
        kind: 'UNCONFIRMED',
        command,
        correlationId: result.correlationId,
        submissionId,
        reason,
        replay: { token: stamp.token, until: stamp.until },
      };
  }
}
