'use server';

import { redirect } from 'next/navigation';

import { SLOT_OF, slotHasSubject, type ContractCommand } from '@/lib/contract-command-fields';
import { commandFormValues, parseCommandInput } from '@/lib/contract-command-input';
import { FLASH_PARAM, REPLAY_FIELD } from '@/lib/form-fields';
import type { ContractScope } from '@/lib/unresolved-contract-command';
import { verifyContractStamp } from '@/server/contract-command-replay';
import { commandRequest, issueContractCommand } from '@/server/contract-commands';
import { currentSession, missingSessionReason } from '@/server/current-session';
import { verifyCsrf } from '@/server/csrf';
import { mintFlash } from '@/server/flash';
import type { WebSession } from '@/server/session';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';

import { afterRetry, type ContractFormState } from './contract-form-state';
import { pageContext } from '@/server/page-context';
import { withContext } from '@/lib/page-context';

/**
 * The server action behind the contract command forms on `/contracts/[id]`:
 * signing and cancelling the contract, proposing and signing an amendment,
 * planning and changing a milestone.
 *
 * The order of every write in this portal (ADR-059 § 3, § 5): session, CSRF,
 * submission id, the signed replay stamp (`server/contract-command-replay.ts`),
 * the form, then the gateway — each gate returning before the next runs. The
 * contract, the object, the version and the side are bound, not posted; only
 * what a person types is read from the form.
 *
 * **Whether the command is allowed is not decided here.** contract-service
 * decides — roles, side, state, the signing policy, separation of duties — and
 * its refusal is said in fixed words; the page only chose what to draw.
 *
 * Once a command is unconfirmed, no answer to a retry but a successful one
 * (which redirects) may claim the first request did not commit.
 */

/** Back to the contract, with a confirmation this session earned for it — never a typed flag. */
function toContract(session: WebSession, contractId: string, command: ContractCommand): never {
  redirect(
    withContext(
      pageContext(session),
      `/contracts/${encodeURIComponent(contractId)}?${FLASH_PARAM}=${mintFlash(session, contractId, command)}`,
    ),
  );
}

/** The scope as the client passed it, only if it is one this page draws; null otherwise. */
function knownScope(scope: ContractScope): ContractScope | null {
  const known =
    typeof scope === 'object' &&
    scope !== null &&
    typeof scope.contractId === 'string' &&
    scope.contractId.length > 0 &&
    Object.values(SLOT_OF).includes(scope.slot) &&
    slotHasSubject(scope.slot) === (typeof scope.subjectId === 'string');
  return known
    ? { contractId: scope.contractId, slot: scope.slot, subjectId: scope.subjectId }
    : null;
}

async function attempt(posted: ContractScope, form: FormData): Promise<ContractFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: await missingSessionReason() };

  // A slot that is not one this page draws is refused unsent; the stamp then
  // binds the one it is.
  const scope = knownScope(posted);
  if (!scope) return { kind: 'REFUSED', reason: 'COMMAND' };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  if (!isBoundSubmissionId(submissionId, session)) return { kind: 'REFUSED', reason: 'SUBMISSION' };

  // On every send under this key — the first and each retry — against the
  // deadline and the binding signed when the form was drawn.
  const stamp = verifyContractStamp(session, form.get(REPLAY_FIELD), scope, submissionId);
  if (!stamp) return { kind: 'REFUSED', reason: 'REPLAY' };

  const { command } = stamp;
  const values = commandFormValues(form, command);
  const parsed = parseCommandInput(command, values);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      command,
      submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: parsed.message,
    };
  }
  const binding = {
    command,
    subjectId: scope.subjectId,
    expectedVersion: stamp.expectedVersion,
    side: stamp.side,
  };
  const request = commandRequest(scope.contractId, binding, parsed.input);
  if (!request) return { kind: 'REFUSED', reason: 'COMMAND' };

  const result = await issueContractCommand(
    session,
    request,
    scope.contractId,
    binding,
    parsed.input,
    submissionId,
  );
  switch (result.kind) {
    case 'CREATED':
      return toContract(session, scope.contractId, command);
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
        input: parsed.input,
        replay: { token: stamp.token, until: stamp.until },
      };
  }
}

/**
 * One command on one slot of `contractId` — which command, the stamp says; a
 * stamp of another slot or object is refused unsent.
 */
export async function submitContractCommand(
  scope: ContractScope,
  previous: ContractFormState,
  form: FormData,
): Promise<ContractFormState> {
  const state = await attempt(scope, form);
  return previous.kind === 'UNCONFIRMED' ? afterRetry(previous, state) : state;
}
