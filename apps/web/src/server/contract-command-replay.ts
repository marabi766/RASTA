import { z } from 'zod';

import {
  CONTRACT_COMMANDS,
  CONTRACT_SIDES,
  SLOT_OF,
  slotHasSubject,
  type ContractCommand,
  type ContractSide,
} from '@/lib/contract-command-fields';
import type {
  ContractScope,
  ContractSubmission,
  ReplayStamp,
} from '@/lib/unresolved-contract-command';

import { webServerEnv, type WebServerEnv } from './env';
import { signPayload, verifyPayload } from './signed-payload';
import type { WebSession } from './session';
import { mintSubmissionId } from './submission';

/**
 * Until when a contract command may be sent again under its original key, and
 * **what** it acts on — decided by this server, from a stamp it signed when the
 * page drew the form (`server/statement-replay.ts`'s construction, for the
 * commands of `server/contract-commands.ts`).
 *
 * ## Until when
 *
 * contract-service answers the same key with its stored response only while
 * its idempotency record lives (`CONTRACT_IDEMPOTENCY_TTL_HOURS`); past that the
 * same request runs **as new** — and an amendment or a milestone run again is a
 * second one. The stamp's signed expiry is that retention
 * (`WEB_CONTRACT_IDEMPOTENCY_TTL_HOURS`) less `WEB_CONTRACT_REPLAY_MARGIN_SECONDS`,
 * counted from when the page drew the form, and it is accepted only while that
 * and issuance plus the window **as configured now** both hold.
 *
 * ## What
 *
 * A command is bound to **the object, the version and the side the page
 * showed**: the contract and its `version` (a signature, a cancellation, an
 * amendment's proposal), the amendment and its `version` (its signature), the
 * milestone and its `version` (a change) — and for a signature, the side it was
 * drawn for, which is what its answer must show signed. The action builds
 * `expectedVersion` from the verified stamp, never from the posted form, so the
 * first send and every retry under the key carry the same body, and a form
 * drawn before the object moved is refused by the service (`409
 * OPTIMISTIC_LOCK_FAILED`) instead of acting on a state its author never saw. A
 * new milestone has no version to bind (the DTO takes none). What a person
 * types is not in the stamp; the unconfirmed view re-sends what it kept
 * (`lib/unresolved-contract-command.ts`).
 *
 * Bound to this login (`signed-payload.ts`); readable, not secret, not a
 * credential for anything.
 */

const PURPOSE = 'contract-command-replay';

const replaySchema = z.object({
  contractId: z.string().min(1).max(200),
  /** The amendment or milestone the command acts on; null for the contract's own and for a new one. */
  subjectId: z.string().min(1).max(200).nullable(),
  submissionId: z.string().min(1).max(200),
  command: z.enum(CONTRACT_COMMANDS),
  /** When the page signed it, milliseconds since the epoch, server clock. */
  issuedAt: z.number().int().nonnegative(),
  /** The signed expiry again, in milliseconds, for the browser to draw the right controls. */
  until: z.number().int(),
  /** The `version` of what the command acts on, as the page showed it; null for a new milestone. */
  expectedVersion: z.number().int().min(1).nullable(),
  /** The side a signature is for; null for every other command. */
  side: z.enum(CONTRACT_SIDES).nullable(),
});

type ReplayPayload = z.infer<typeof replaySchema>;

/** What a stamp is for: one command on one object of one contract. */
export interface ContractTarget {
  readonly command: ContractCommand;
  readonly contractId: string;
  readonly subjectId: string | null;
  readonly expectedVersion: number | null;
  readonly side: ContractSide | null;
}

type ReplayEnv = Pick<
  WebServerEnv,
  'WEB_CONTRACT_IDEMPOTENCY_TTL_HOURS' | 'WEB_CONTRACT_REPLAY_MARGIN_SECONDS'
>;

/** Seconds from the page being drawn until the same request may no longer be sent. */
export function contractReplayWindowSeconds(env: ReplayEnv = webServerEnv()): number {
  return env.WEB_CONTRACT_IDEMPOTENCY_TTL_HOURS * 60 * 60 - env.WEB_CONTRACT_REPLAY_MARGIN_SECONDS;
}

/** The slot a target's outcome is held in (`lib/unresolved-contract-command.ts`). */
export function scopeOfTarget(
  target: Pick<ContractTarget, 'command' | 'contractId' | 'subjectId'>,
): ContractScope {
  return {
    contractId: target.contractId,
    slot: SLOT_OF[target.command],
    subjectId: target.subjectId,
  };
}

/** The stamp for `submissionId` on `target`, from `now`. */
export function mintContractStamp(
  session: WebSession,
  target: ContractTarget,
  submissionId: string,
  now: number = Date.now(),
  env: ReplayEnv = webServerEnv(),
): ReplayStamp {
  const window = contractReplayWindowSeconds(env);
  const until = (Math.floor(now / 1000) + window) * 1000;
  const payload: ReplayPayload = {
    contractId: target.contractId,
    subjectId: target.subjectId,
    submissionId,
    command: target.command,
    issuedAt: now,
    until,
    expectedVersion: target.expectedVersion,
    side: target.side,
  };
  return { token: signPayload(session, PURPOSE, payload, window, now), until };
}

/** A fresh submission id for one contract form on `target`, with its stamp. */
export function mintContractSubmission(
  session: WebSession,
  target: ContractTarget,
  now: number = Date.now(),
): ContractSubmission {
  const id = mintSubmissionId(session);
  return { id, replay: mintContractStamp(session, target, id, now) };
}

/** A stamp the action verified, with what it binds the request to. */
export interface VerifiedContractStamp extends ReplayStamp {
  readonly command: ContractCommand;
  readonly expectedVersion: number | null;
  readonly side: ContractSide | null;
}

/**
 * The stamp, only if this server issued it to this login, for this contract,
 * this slot and object, and this submission id, its signed expiry has not
 * passed and it is still inside the window as configured now; otherwise null —
 * one answer for every way it can be wrong.
 */
export function verifyContractStamp(
  session: WebSession,
  token: unknown,
  scope: ContractScope,
  submissionId: string,
  now: number = Date.now(),
  env: ReplayEnv = webServerEnv(),
): VerifiedContractStamp | null {
  const payload = verifyPayload(session, PURPOSE, token, replaySchema, now);
  if (
    payload === null ||
    typeof token !== 'string' ||
    payload.contractId !== scope.contractId ||
    payload.subjectId !== scope.subjectId ||
    payload.submissionId !== submissionId ||
    SLOT_OF[payload.command] !== scope.slot ||
    slotHasSubject(scope.slot) !== (scope.subjectId !== null)
  ) {
    return null;
  }
  const current = payload.issuedAt + contractReplayWindowSeconds(env) * 1000;
  if (now > current) return null;
  return {
    token,
    until: Math.min(payload.until, current),
    command: payload.command,
    expectedVersion: payload.expectedVersion,
    side: payload.side,
  };
}
