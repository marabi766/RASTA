import { z } from 'zod';

import { OWNER_COMMANDS } from '@/lib/tender-owner-fields';
import type { OwnerSubmission, ReplayStamp } from '@/lib/unresolved-tender-command';

import { bidReplayWindowSeconds } from './bid-replay';
import { webServerEnv, type WebServerEnv } from './env';
import { signPayload, verifyPayload } from './signed-payload';
import type { WebSession } from './session';
import { mintSubmissionId } from './submission';
import type { OwnerBinding } from './tender-owner';

/**
 * Until when an owner's tender command may be sent again under its original
 * key, and **what** it acts on — signed by this server when the page drew the
 * form (`server/bid-replay.ts`'s construction, on the same window: both are
 * construction-service's commands under `CONSTRUCTION_IDEMPOTENCY_TTL_HOURS`).
 *
 * It binds the tender, the command and, for a publication, the tender version
 * the page read, or for a decision the step and its version: the action builds
 * the body from the stamp alone, so a form drawn before the tender or the step
 * moved is refused by the service (`409`) rather than publishing or deciding
 * something its author never saw. The opening's three commands carry no body;
 * the stamp binds only the tender and the command.
 */

const PURPOSE = 'tender-owner-replay';

const replaySchema = z.object({
  tenderId: z.string().min(1).max(200),
  /** The step a decision decides; null otherwise. */
  approvalId: z.string().min(1).max(200).nullable(),
  submissionId: z.string().min(1).max(200),
  command: z.enum(OWNER_COMMANDS),
  issuedAt: z.number().int().nonnegative(),
  until: z.number().int(),
  /** The tender's version for a publication, the step's for a decision; null for the opening. */
  expectedVersion: z.number().int().min(1).nullable(),
});

type ReplayPayload = z.infer<typeof replaySchema>;

type ReplayEnv = Pick<
  WebServerEnv,
  'WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS' | 'WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS'
>;

export interface OwnerTarget extends OwnerBinding {
  readonly tenderId: string;
}

/** Whether a binding fits its command: a step only for a decision, a version for both. */
function fits(binding: Pick<ReplayPayload, 'command' | 'approvalId' | 'expectedVersion'>): boolean {
  const decision = binding.command === 'GRANT' || binding.command === 'REJECT';
  if (decision) return binding.approvalId !== null && binding.expectedVersion !== null;
  if (binding.command === 'PUBLISH') {
    return binding.approvalId === null && binding.expectedVersion !== null;
  }
  return binding.approvalId === null && binding.expectedVersion === null;
}

export function mintOwnerStamp(
  session: WebSession,
  target: OwnerTarget,
  submissionId: string,
  now: number = Date.now(),
  env: ReplayEnv = webServerEnv(),
): ReplayStamp {
  const window = bidReplayWindowSeconds(env);
  const until = (Math.floor(now / 1000) + window) * 1000;
  const payload: ReplayPayload = {
    tenderId: target.tenderId,
    approvalId: target.approvalId,
    command: target.command,
    expectedVersion: target.expectedVersion,
    submissionId,
    issuedAt: now,
    until,
  };
  return { token: signPayload(session, PURPOSE, payload, window, now), until };
}

/** A fresh submission id for one owner form on `target`, with its stamp. */
export function mintOwnerSubmission(
  session: WebSession,
  target: OwnerTarget,
  now: number = Date.now(),
): OwnerSubmission {
  const id = mintSubmissionId(session);
  return { id, replay: mintOwnerStamp(session, target, id, now) };
}

export interface VerifiedOwnerStamp extends ReplayStamp, OwnerBinding {}

/**
 * The stamp, only if this server issued it to this login, for this tender and
 * this submission id, its binding fits its command, its signed expiry has not
 * passed and it is still inside the window as configured now; otherwise null.
 */
export function verifyOwnerStamp(
  session: WebSession,
  token: unknown,
  tenderId: string,
  submissionId: string,
  now: number = Date.now(),
  env: ReplayEnv = webServerEnv(),
): VerifiedOwnerStamp | null {
  const payload = verifyPayload(session, PURPOSE, token, replaySchema, now);
  if (
    payload === null ||
    typeof token !== 'string' ||
    payload.tenderId !== tenderId ||
    payload.submissionId !== submissionId ||
    !fits(payload)
  ) {
    return null;
  }
  const current = payload.issuedAt + bidReplayWindowSeconds(env) * 1000;
  if (now > current) return null;
  return {
    token,
    until: Math.min(payload.until, current),
    command: payload.command,
    approvalId: payload.approvalId,
    expectedVersion: payload.expectedVersion,
  };
}
