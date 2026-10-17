import { z } from 'zod';

import {
  STATEMENT_CHAINS,
  STATEMENT_COMMANDS,
  type StatementCommand,
} from '@/lib/statement-fields';
import type { ReplayStamp, StatementSubmission } from '@/lib/unresolved-statement';

import type { StepBinding } from './contract-statements';
import { webServerEnv, type WebServerEnv } from './env';
import { signPayload, verifyPayload } from './signed-payload';
import type { WebSession } from './session';
import { mintSubmissionId } from './submission';

/**
 * Until when a statement command may be sent again under its original key,
 * and **what** it sends — decided by this server, from a stamp it signed when
 * the page drew the form (`server/dispute-replay.ts` is the original; same
 * construction, same reasons).
 *
 * ## Until when
 *
 * contract-service answers the same key with its stored response only while
 * its idempotency record lives (`CONTRACT_IDEMPOTENCY_TTL_HOURS`, from the
 * response); past that the same request runs **as new** — and a draft run
 * again is a second statement. The stamp's signed expiry is that retention
 * (`WEB_CONTRACT_IDEMPOTENCY_TTL_HOURS`, mirroring it) less a margin
 * (`WEB_CONTRACT_REPLAY_MARGIN_SECONDS`), counted from when the page drew the
 * form — before the first send could leave. It is accepted only while that and
 * issuance plus the window **as configured now** both hold, so a retention
 * shortened later shortens every stamp already out.
 *
 * ## What
 *
 * A submit or a decision is bound to **the statement, the step and the
 * version the page showed**: the action builds the body from the verified
 * stamp — `expectedVersion`, and for a decision the `chain` and `stepOrder`
 * and which decision — never from the posted form, so the first send and every
 * retry under the key are the same body, and a form drawn before the statement
 * moved is refused by the service (`409 OPTIMISTIC_LOCK_FAILED`) instead of
 * deciding a step its author never saw. A draft's lines are typed, so its
 * stamp binds the contract and the command only; the unconfirmed view re-sends
 * the lines it kept (`lib/unresolved-statement.ts`).
 *
 * Bound to this login (`signed-payload.ts`); readable, not secret, not a
 * credential for anything.
 */

const PURPOSE = 'statement-replay';

const replaySchema = z.object({
  contractId: z.string().min(1).max(200),
  /** Null for a draft: there is no statement yet. */
  statementId: z.string().min(1).max(200).nullable(),
  submissionId: z.string().min(1).max(200),
  command: z.enum(STATEMENT_COMMANDS),
  /** When the page signed it, milliseconds since the epoch, server clock. */
  issuedAt: z.number().int().nonnegative(),
  /** The signed expiry again, in milliseconds, for the browser to draw the right controls. */
  until: z.number().int(),
  /** The statement's `version` the page showed; null for a draft. */
  expectedVersion: z.number().int().min(1).nullable(),
  /** The step a decision decides; null otherwise. */
  chain: z.enum(STATEMENT_CHAINS).nullable(),
  stepOrder: z.number().int().min(1).nullable(),
});

type ReplayPayload = z.infer<typeof replaySchema>;

/** What a stamp is for: the draft of a contract, or one command on one statement. */
export type StatementTarget =
  | { readonly command: 'DRAFT'; readonly contractId: string }
  | ({ readonly contractId: string; readonly statementId: string } & StepBinding);

type ReplayEnv = Pick<
  WebServerEnv,
  'WEB_CONTRACT_IDEMPOTENCY_TTL_HOURS' | 'WEB_CONTRACT_REPLAY_MARGIN_SECONDS'
>;

/** Seconds from the page being drawn until the same request may no longer be sent. */
export function statementReplayWindowSeconds(env: ReplayEnv = webServerEnv()): number {
  return env.WEB_CONTRACT_IDEMPOTENCY_TTL_HOURS * 60 * 60 - env.WEB_CONTRACT_REPLAY_MARGIN_SECONDS;
}

function bindingOf(
  target: StatementTarget,
): Omit<ReplayPayload, 'submissionId' | 'issuedAt' | 'until'> {
  if (target.command === 'DRAFT') {
    return {
      contractId: target.contractId,
      statementId: null,
      command: 'DRAFT',
      expectedVersion: null,
      chain: null,
      stepOrder: null,
    };
  }
  return {
    contractId: target.contractId,
    statementId: target.statementId,
    command: target.command,
    expectedVersion: target.expectedVersion,
    chain: target.chain,
    stepOrder: target.stepOrder,
  };
}

/** The stamp for `submissionId` on `target`, from `now`. */
export function mintStatementStamp(
  session: WebSession,
  target: StatementTarget,
  submissionId: string,
  now: number = Date.now(),
  env: ReplayEnv = webServerEnv(),
): ReplayStamp {
  const window = statementReplayWindowSeconds(env);
  const until = (Math.floor(now / 1000) + window) * 1000;
  return {
    token: signPayload(
      session,
      PURPOSE,
      { ...bindingOf(target), submissionId, issuedAt: now, until },
      window,
      now,
    ),
    until,
  };
}

/** A fresh submission id for one statement form on `target`, with its stamp. */
export function mintStatementSubmission(
  session: WebSession,
  target: StatementTarget,
  now: number = Date.now(),
): StatementSubmission {
  const id = mintSubmissionId(session);
  return { id, replay: mintStatementStamp(session, target, id, now) };
}

/** A stamp the action verified, with what it binds the request to. */
export interface VerifiedStatementStamp extends ReplayStamp {
  readonly command: StatementCommand;
  readonly statementId: string | null;
  readonly expectedVersion: number | null;
  readonly chain: ReplayPayload['chain'];
  readonly stepOrder: number | null;
}

/**
 * The stamp, only if this server issued it to this login, for this contract,
 * this statement (null for a draft) and this submission id, its signed expiry
 * has not passed and it is still inside the window as configured now;
 * otherwise null — one answer for every way it can be wrong.
 */
export function verifyStatementStamp(
  session: WebSession,
  token: unknown,
  contractId: string,
  statementId: string | null,
  submissionId: string,
  now: number = Date.now(),
  env: ReplayEnv = webServerEnv(),
): VerifiedStatementStamp | null {
  const payload = verifyPayload(session, PURPOSE, token, replaySchema, now);
  if (
    payload === null ||
    typeof token !== 'string' ||
    payload.contractId !== contractId ||
    payload.statementId !== statementId ||
    payload.submissionId !== submissionId ||
    (payload.command === 'DRAFT') !== (statementId === null)
  ) {
    return null;
  }
  const current = payload.issuedAt + statementReplayWindowSeconds(env) * 1000;
  if (now > current) return null;
  return {
    token,
    until: Math.min(payload.until, current),
    command: payload.command,
    statementId: payload.statementId,
    expectedVersion: payload.expectedVersion,
    chain: payload.chain,
    stepOrder: payload.stepOrder,
  };
}
