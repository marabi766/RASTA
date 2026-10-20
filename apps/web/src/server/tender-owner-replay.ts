import { createHash } from 'node:crypto';

import { z } from 'zod';

import { DECISION_COMMANDS, OWNER_COMMANDS } from '@/lib/tender-owner-fields';
import type { OwnerSubmission, ReplayStamp } from '@/lib/unresolved-tender-command';

import { bidReplayWindowSeconds } from './bid-replay';
import { webServerEnv, type WebServerEnv } from './env';
import { signPayload, verifyPayload } from './signed-payload';
import type { WebSession } from './session';
import { mintSubmissionId } from './submission';
import type { AwardTerms, OwnerBinding } from './tender-owner';

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
 * and the command. A bid's commands bind the bid.
 *
 * ## A bound body travels beside the stamp, not in it (PR 346 review 1, finding 1)
 *
 * A score is bound to every criterion's maximum and the revision of the
 * caller's own cell the page read (`expectedRevision`), and an award to
 * whether its rank needs a justification and — executing an approved request —
 * the justification that request was made with. Fifty criteria, or a
 * justification of 2000 Persian characters, would make a stamp longer than a
 * signed payload may be (`signed-payload.ts`), and the form would be refused
 * forever. So the stamp signs only a **digest** of that body (`bindingDigest`,
 * SHA-256), and the form posts the body itself (`BINDING_FIELD`, written by
 * this server when it drew the form): the action takes the body only if its
 * digest is the signed one, so nothing in it can be changed, and the stamp
 * stays a few hundred characters whatever the body holds.
 */

export { BINDING_FIELD } from '@/lib/tender-owner-input';

/** `MAX_CRITERIA`: a tender has at most 50 criteria. */
const MAX_BOUND_CRITERIA = 50;

const boundBodySchema = z
  .object({
    scoring: z
      .array(
        z
          .object({
            criterionCode: z.string().min(1).max(64),
            maxScore: z.number().int().min(0),
            passFail: z.boolean(),
            expectedRevision: z.number().int().min(0),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_BOUND_CRITERIA)
      .nullable(),
    award: z
      .object({
        justificationRequired: z.boolean().nullable(),
        execution: z
          .object({ justification: z.string().max(2000).nullable() })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

type BoundBody = z.infer<typeof boundBodySchema>;

const digestOf = (text: string): string => createHash('sha256').update(text).digest('base64url');

/** The body a binding binds beside the stamp, as the text the form posts; null when there is none. */
export function ownerBindingText(target: Pick<OwnerBinding, 'scoring' | 'award'>): string | null {
  const scoring = target.scoring ?? null;
  const award = target.award ?? null;
  if (scoring === null && award === null) return null;
  const body: BoundBody = {
    scoring: scoring
      ? scoring.map(({ criterionCode, maxScore, passFail, expectedRevision }) => ({
          criterionCode,
          maxScore,
          passFail,
          expectedRevision,
        }))
      : null,
    award: award
      ? {
          justificationRequired: award.justificationRequired,
          execution: award.execution ? { justification: award.execution.justification } : null,
        }
      : null,
  };
  return JSON.stringify(body);
}

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
  /** SHA-256 (base64url) of the bound body the form posts beside the stamp; null when it has none. */
  bindingDigest: z.string().length(43).nullable().default(null),
  /** Which body is bound: a score's criteria, or an award's terms. */
  bound: z.enum(['SCORING', 'AWARD']).nullable().default(null),
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
  binding: Pick<OwnerBinding, 'command' | 'approvalId' | 'expectedVersion'> & {
    readonly bidId: string | null;
    readonly scores: boolean;
    readonly terms: boolean;
  },
): boolean {
  const { command, approvalId, expectedVersion, bidId, scores, terms } = binding;
  const step = approvalId !== null;
  const version = expectedVersion !== null;
  const bid = bidId !== null;
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
  const bound = ownerBindingText(target);
  const payload: ReplayPayload = {
    tenderId: target.tenderId,
    approvalId: target.approvalId,
    command: target.command,
    expectedVersion: target.expectedVersion,
    bidId: target.bidId ?? null,
    bindingDigest: bound === null ? null : digestOf(bound),
    bound: target.scoring ? 'SCORING' : target.award ? 'AWARD' : null,
    submissionId,
    issuedAt: now,
    until,
  };
  return { token: signPayload(session, PURPOSE, payload, window, now), until };
}

/** A fresh submission id for one owner form on `target`, with its stamp and the body it binds. */
export function mintOwnerSubmission(
  session: WebSession,
  target: OwnerTarget,
  now: number = Date.now(),
): OwnerSubmission {
  const id = mintSubmissionId(session);
  const binding = ownerBindingText(target);
  return {
    id,
    replay: mintOwnerStamp(session, target, id, now),
    ...(binding !== null ? { binding } : {}),
  };
}

export interface VerifiedOwnerStamp extends ReplayStamp, Required<OwnerBinding> {}

/**
 * The stamp, only if this server issued it to this login, for this tender and
 * this submission id, its binding fits its command, the body posted beside it
 * (`posted`) is the one whose digest it signed, its signed expiry has not
 * passed and it is still inside the window as configured now; otherwise null.
 */
export function verifyOwnerStamp(
  session: WebSession,
  token: unknown,
  tenderId: string,
  submissionId: string,
  now: number = Date.now(),
  env: ReplayEnv = webServerEnv(),
  posted: unknown = null,
): VerifiedOwnerStamp | null {
  const payload = verifyPayload(session, PURPOSE, token, replaySchema, now);
  if (
    payload === null ||
    typeof token !== 'string' ||
    payload.tenderId !== tenderId ||
    payload.submissionId !== submissionId
  ) {
    return null;
  }
  let body: BoundBody = { scoring: null, award: null };
  // A stamp that binds no body takes none: whatever is posted beside it is somebody else's.
  if (payload.bindingDigest === null && posted !== null && posted !== '') return null;
  if (payload.bindingDigest !== null) {
    if (typeof posted !== 'string' || digestOf(posted) !== payload.bindingDigest) return null;
    let json: unknown;
    try {
      json = JSON.parse(posted);
    } catch {
      return null;
    }
    const parsed = boundBodySchema.safeParse(json);
    if (!parsed.success) return null;
    body = parsed.data;
  }
  const scores = body.scoring !== null;
  const terms = body.award !== null;
  if (
    (payload.bound === 'SCORING') !== scores ||
    (payload.bound === 'AWARD') !== terms ||
    !fits({ ...payload, scores, terms })
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
    scoring: body.scoring,
    award: body.award as AwardTerms | null,
  };
}
