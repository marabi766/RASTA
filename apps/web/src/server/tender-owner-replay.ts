import { z } from 'zod';

import { DECISION_COMMANDS, OWNER_COMMANDS } from '@/lib/tender-owner-fields';
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
 * something its author never saw. The opening's three commands and the
 * completion of the evaluation carry no body; the stamp binds only the tender
 * and the command. A bid's commands bind the bid: a qualification only that, a
 * score also each criterion's maximum and the revision of the caller's own
 * cell the page read (`expectedRevision`), an award whether its rank needs a
 * justification and — executing an approved request — the justification that
 * request was made with, so the command executed is the one approved.
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
  /** The bid a qualification, a score or an award acts on; null otherwise. */
  bidId: z.string().min(1).max(64).nullable().default(null),
  /** A score's criteria, as the page read them. */
  scoring: z
    .array(
      z.object({
        criterionCode: z.string().min(1).max(64),
        maxScore: z.number().int().min(0),
        passFail: z.boolean(),
        expectedRevision: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(50)
    .nullable()
    .default(null),
  /** An award: whether its rank needs a justification, and the approved request's when it executes. */
  award: z
    .object({
      justificationRequired: z.boolean(),
      execution: z.object({ justification: z.string().max(2000).nullable() }).nullable(),
    })
    .nullable()
    .default(null),
});

type ReplayPayload = z.infer<typeof replaySchema>;

type ReplayEnv = Pick<
  WebServerEnv,
  'WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS' | 'WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS'
>;

export interface OwnerTarget extends OwnerBinding {
  readonly tenderId: string;
}

/**
 * Whether a binding fits its command: a step and its version only for a
 * decision, a version for a publication, a bid for a bid's commands — with
 * its criteria for a score and its award terms for an award — and nothing
 * for the rest.
 */
function fits(
  binding: Pick<
    ReplayPayload,
    'command' | 'approvalId' | 'expectedVersion' | 'bidId' | 'scoring' | 'award'
  >,
): boolean {
  const { command, approvalId, expectedVersion, bidId, scoring, award } = binding;
  const step = approvalId !== null;
  const version = expectedVersion !== null;
  const bid = bidId !== null;
  const scores = scoring !== null;
  const terms = award !== null;
  if (DECISION_COMMANDS.includes(command)) return step && version && !bid && !scores && !terms;
  switch (command) {
    case 'PUBLISH':
      return !step && version && !bid && !scores && !terms;
    case 'QUALIFY':
    case 'DISQUALIFY':
      return !step && !version && bid && !scores && !terms;
    case 'SCORE':
      return !step && !version && bid && scores && !terms;
    case 'AWARD':
      return !step && !version && bid && !scores && terms;
    default:
      return !step && !version && !bid && !scores && !terms;
  }
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
    bidId: target.bidId ?? null,
    scoring: target.scoring ? [...target.scoring] : null,
    award: target.award ?? null,
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

export interface VerifiedOwnerStamp extends ReplayStamp, Required<OwnerBinding> {}

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
    bidId: payload.bidId,
    scoring: payload.scoring,
    award: payload.award,
  };
}
