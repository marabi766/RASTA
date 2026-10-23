'use server';

import { redirect } from 'next/navigation';

import { FLASH_PARAM, REPLAY_FIELD } from '@/lib/form-fields';
import {
  BINDING_FIELD,
  ownerFormContext,
  ownerValuesOf,
  parseOwnerForm,
} from '@/lib/tender-owner-input';
import { UNREPEATABLE_OWNER_COMMANDS, resentOutcome } from '@/lib/tender-owner-fields';
import { currentSession, missingSessionReason } from '@/server/current-session';
import { verifyCsrf } from '@/server/csrf';
import { webServerEnv } from '@/server/env';
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
 * the step and its version, the bid, the revisions a score is about and an
 * award's terms by the stamp; only what the person typed comes from the form —
 * a rejection's reason, a disqualification's, the scores, a new award's
 * justification — read as its DTO reads it (`lib/tender-owner-input.ts`).
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
  // A view-only record is never sent again, whatever the form posts.
  if (previous.kind === 'UNCONFIRMED' && previous.viewOnly) return previous;
  const state = await attempt(tenderId, form, previous.kind === 'UNCONFIRMED');
  return previous.kind === 'UNCONFIRMED' ? afterRetry(previous, state) : state;
}

async function attempt(tenderId: string, form: FormData, resent: boolean): Promise<OwnerFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: await missingSessionReason() };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  if (!isBoundSubmissionId(submissionId, session)) return { kind: 'REFUSED', reason: 'SUBMISSION' };

  const stamp = verifyOwnerStamp(
    session,
    form.get(REPLAY_FIELD),
    tenderId,
    submissionId,
    Date.now(),
    webServerEnv(),
    form.get(BINDING_FIELD),
  );
  if (!stamp) return { kind: 'REFUSED', reason: 'REPLAY' };
  const { command } = stamp;

  const context = ownerFormContext(stamp);
  const parsed = parseOwnerForm(command, ownerValuesOf(command, form, context), context);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      command,
      submissionId,
      values: parsed.values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }
  const { values } = parsed;

  const request = ownerRequest(tenderId, stamp, parsed.input);
  if (!request) return { kind: 'REFUSED', reason: 'COMMAND' };

  const result = await issueOwnerCommand(session, tenderId, stamp, request, submissionId);
  switch (result.kind) {
    case 'CREATED': {
      // A re-send's answer may be the first send's, replayed under its key: the flash says so.
      const outcome = outcomeOf(command, result.data);
      const done = resent ? resentOutcome(outcome) : outcome;
      return redirect(
        `/tenders/${encodeURIComponent(tenderId)}?view=own&${FLASH_PARAM}=${mintFlash(session, tenderId, done)}`,
      );
    }
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
        command,
        correlationId: result.correlationId,
        reasons: result.reasons ?? [],
      };
    case 'NOT_FOUND':
      return { kind: 'NOT_FOUND' };
    case 'IN_PROGRESS':
    case 'UNKNOWN_OUTCOME':
      if (UNREPEATABLE_OWNER_COMMANDS.includes(command)) {
        return {
          kind: 'UNCONFIRMED',
          command,
          correlationId: result.correlationId,
          submissionId,
          values: null,
          replay: null,
          viewOnly: true,
          unrepeatable: true,
        };
      }
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
