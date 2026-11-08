import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  INVALID_INPUT_MESSAGE,
  PROJECT_VALIDATION_DETAIL_CODES,
  STALE_MESSAGE,
} from '@/lib/project-commands';
import {
  NEED_BUSINESS_RULE_MESSAGE,
  NEED_FIELDS,
  NEED_KEY_REUSED_MESSAGE,
  NEED_422_PATTERNS,
  NEED_STATE_MESSAGE,
  canAddNeed,
  isNeedCommand,
  needCommandsFrom,
  type AddNeedBody,
  type NeedCommand,
  type NeedField,
  type UpdateNeedBody,
  type WithdrawNeedField,
} from '@/lib/project-need-commands';

import { ReleaseScope } from './release-scope';
import { replayStamps } from './replay-stamp';
import type { WebSession } from './session';
import { signPayload, verifyPayload } from './signed-payload';
import { requestDigest } from './unresolved-request';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';

/**
 * Adding, editing, submitting and withdrawing a project's needs through the
 * gateway (EXP-004; construction-service `project.controller.ts`, `need.service.ts`).
 *
 * The same split as `project-commands.ts`: the form's own schema says what a
 * person may type and in what words a mistake is reported; construction-service
 * decides what is true. A rule copied here saves a round trip and is never the
 * enforcement — in particular the service **locks the project** and refuses a need
 * command once the project is no longer editable, which is the server-side
 * re-check of everything the page used to decide whether to draw a form.
 *
 * ## The Idempotency-Key, and the versions
 *
 * `POST /v1/projects/{id}/needs` is the only call here that takes an
 * `Idempotency-Key`: the service stores it, bound to the caller and the project,
 * and answers the same key and body with the first response (`409 CONFLICT` with
 * `Retry-After` while the first is in flight). Every add also carries the signed
 * stamp's deadline as `Idempotency-Replay-Deadline` (#615, D-065): the service
 * compares it with the clock that expires its key and refuses a later execution
 * with `409 REPLAY_WINDOW_CLOSED` before it writes, so a form posted again after
 * the key is gone — its portal record settled or not, the process paused or not —
 * is refused by the owner of the key, not by a portal clock. The portal still
 * never resends an unresolved add for the person (`project-need-create`:
 * `retry: false`). Every other call carries the `expectedVersion` its page was
 * drawn at, from the signed baseline; the first send moves the version, so a
 * second send of the same form is a `409` and not a second write, and no key is
 * sent for them (the controller reads none, the OpenAPI document lists none).
 *
 * ## The editing episode (the parent fence)
 *
 * A need belongs to the project's editing episode the page was drawn in. A
 * request for approval and its answer move the **project's** version and leave
 * every need's version alone, so a need's own version cannot tell an old episode
 * from a new one. Every one of the four commands therefore carries
 * `expectedProjectVersion` — the project version the page read, signed into the
 * add's stamp and into each baseline, never a field of a form — and
 * construction-service compares it under the project's row lock before anything
 * else (`409 OPTIMISTIC_LOCK_FAILED`). A form from an earlier episode cannot act
 * in a later one.
 *
 * ## What a command acts on
 *
 * Not a field of any form. The page signs `{need, project, command, version,
 * status}` for this session (`sealNeedBaseline`) and the action takes the need,
 * its version and the status the person was looking at from that token alone.
 */

// ---------------------------------------------------------------------------
// Who is offered the forms
// ---------------------------------------------------------------------------

/**
 * The commands drawn for one need: what its status and its project's offer
 * (`needCommandsFrom`), to a person who may write projects (`canWriteProjects`
 * — `assertCanWrite` is the one rule for every project and need command).
 */
export function offeredNeedCommands(input: {
  readonly projectStatus: string;
  readonly needStatus: string;
  readonly canWrite: boolean;
}): readonly NeedCommand[] {
  if (!input.canWrite) return [];
  return needCommandsFrom(input.projectStatus, input.needStatus);
}

/** Whether the add form is drawn: an editable project and a person who may write projects. */
export function mayAddNeed(input: {
  readonly projectStatus: string;
  readonly canWrite: boolean;
}): boolean {
  return input.canWrite && canAddNeed(input.projectStatus);
}

// ---------------------------------------------------------------------------
// What the service says, in Persian
// ---------------------------------------------------------------------------

function mappingOf<F extends string>(paths: Record<string, F>): FieldMapping<F> {
  return {
    paths,
    patterns: NEED_422_PATTERNS,
    byDetailCode: PROJECT_VALIDATION_DETAIL_CODES,
    byCode: {
      OPTIMISTIC_LOCK_FAILED: STALE_MESSAGE,
      IDEMPOTENCY_KEY_REUSED: NEED_KEY_REUSED_MESSAGE,
      INVALID_STATE_TRANSITION: NEED_STATE_MESSAGE,
      BUSINESS_RULE_VIOLATION: NEED_BUSINESS_RULE_MESSAGE,
    },
    // Never the service's own sentence: a text field could echo a stranger's
    // characters, so the list of words stays closed.
    fallback: INVALID_INPUT_MESSAGE,
  };
}

export const NEED_FIELD_MAPPING = mappingOf<NeedField>({
  title: 'title',
  description: 'description',
  quantity: 'quantity',
  unit: 'unit',
  estimatedCostMinor: 'estimatedCost',
});
export const NO_NEED_FIELD_MAPPING = mappingOf<never>({});
export const WITHDRAW_NEED_FIELD_MAPPING = mappingOf<WithdrawNeedField>({ reason: 'reason' });

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const answerSchema = z.object({ id: z.string().min(1) });
export type WrittenNeed = z.infer<typeof answerSchema>;

/** Exactly the two fence fields, after the body's own: a body key can never stand in for one. */
const fenceFields = (fence: NeedFence): NeedFence => ({
  expectedVersion: fence.expectedVersion,
  expectedProjectVersion: fence.expectedProjectVersion,
});

const needsPath = (projectId: string): string =>
  `/v1/projects/${encodeURIComponent(projectId)}/needs`;
const needPath = (projectId: string, needId: string): string =>
  `${needsPath(projectId)}/${encodeURIComponent(needId)}`;

/** The editing episode a command was drawn in: the project's version, as the page read it. */
export interface ParentFence {
  readonly expectedProjectVersion: number;
}

/** What an existing need's command is fenced by: its own version and its project's. */
export interface NeedFence extends ParentFence {
  readonly expectedVersion: number;
}

/** The fence a baseline signs, as the request carries it. */
export function fenceOf(baseline: NeedBaseline): NeedFence {
  return { expectedVersion: baseline.version, expectedProjectVersion: baseline.projectVersion };
}

/** The add as it is sent — and digested: the parent fence is part of the canonical body. */
export type AddNeedRequest = AddNeedBody & ParentFence;

export function addNeedRequest(body: AddNeedBody, expectedProjectVersion: number): AddNeedRequest {
  return { ...body, expectedProjectVersion };
}

/**
 * Adding a need. The submission id is the `Idempotency-Key` and `replayDeadline` (ms since the epoch,
 * from the signed stamp) its `Idempotency-Replay-Deadline`: construction-service refuses an execution
 * past it on its own clock (`409 REPLAY_WINDOW_CLOSED`). Required here, so an add cannot leave without one.
 */
export const addNeed = (
  session: WebSession,
  projectId: string,
  body: AddNeedRequest,
  submissionId: string,
  replayDeadline: number,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<WrittenNeed, NeedField>> =>
  writeThroughGateway(session, {
    path: needsPath(projectId),
    body,
    submissionId,
    replayDeadline,
    schema: answerSchema,
    mapping: NEED_FIELD_MAPPING,
    fetchImpl,
  });

export const updateNeed = (
  session: WebSession,
  projectId: string,
  needId: string,
  body: UpdateNeedBody,
  fence: NeedFence,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<WrittenNeed, NeedField>> =>
  writeThroughGateway(session, {
    path: needPath(projectId, needId),
    method: 'PATCH',
    body: { ...body, ...fenceFields(fence) },
    schema: answerSchema,
    mapping: NEED_FIELD_MAPPING,
    idempotency: 'NONE',
    fetchImpl,
  });

export const submitNeed = (
  session: WebSession,
  projectId: string,
  needId: string,
  fence: NeedFence,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<WrittenNeed, never>> =>
  writeThroughGateway(session, {
    path: `${needPath(projectId, needId)}/submit`,
    body: fenceFields(fence),
    schema: answerSchema,
    mapping: NO_NEED_FIELD_MAPPING,
    idempotency: 'NONE',
    fetchImpl,
  });

export const withdrawNeed = (
  session: WebSession,
  projectId: string,
  needId: string,
  body: { readonly reason: string },
  fence: NeedFence,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<WrittenNeed, WithdrawNeedField>> =>
  writeThroughGateway(session, {
    path: `${needPath(projectId, needId)}/withdraw`,
    body: { ...body, ...fenceFields(fence) },
    schema: answerSchema,
    mapping: WITHDRAW_NEED_FIELD_MAPPING,
    idempotency: 'NONE',
    fetchImpl,
  });

// ---------------------------------------------------------------------------
// What a command was drawn from
// ---------------------------------------------------------------------------

const BASELINE_PURPOSE = 'project-need-baseline';

/**
 * Half an hour, as for a project's own commands: a decision about a need is read
 * and thought about before it is sent, but a page left open for a morning is not
 * what the person decided on. The service compares the version again on every
 * send, so this bounds how stale a *confirmation* can be, not how stale a write
 * can be.
 */
const BASELINE_TTL_SECONDS = 30 * 60;

/**
 * A short, unkeyed digest of one field of the edit form. The baseline records
 * which fields still hold the value the page was drawn with, without carrying
 * the text: a signed token may not exceed 4096 characters, and a description alone
 * may be 2000. Not a secret and not a MAC — the signature is the MAC.
 */
export function needFieldDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url').slice(0, 22);
}

const baselineSchema = z.object({
  /** The need. */
  needId: z.string().min(1).max(200),
  /** The project it belongs to, as the page showed it. */
  projectId: z.string().min(1).max(200),
  command: z.string().refine(isNeedCommand),
  version: z.number().int().min(1),
  /**
   * The project's version when the page was drawn: the editing episode this command belongs to.
   * Required — a baseline signed before it was carried opens as nothing (fail closed).
   */
  projectVersion: z.number().int().min(1).max(2_147_483_647),
  /** The need's status as the page showed it. */
  status: z.string().min(1).max(40),
  /** Digests of the edit form's fields as drawn; null for every other command. */
  digests: z.record(z.string(), z.string().max(40)).nullable(),
});

export interface NeedBaseline {
  readonly needId: string;
  readonly projectId: string;
  readonly command: NeedCommand;
  readonly version: number;
  readonly projectVersion: number;
  readonly status: string;
  readonly digests: Readonly<Record<string, string>> | null;
}

/** The digests of an edit form's fields, as the page drew them. */
export function needEditDigests(
  values: Readonly<Record<NeedField, string>>,
): Record<NeedField, string> {
  return Object.fromEntries(
    NEED_FIELDS.map((field) => [field, needFieldDigest(values[field])]),
  ) as Record<NeedField, string>;
}

/** The fields whose submitted text still has the digest the page was drawn with. */
export function unchangedNeedFields(
  baseline: NeedBaseline,
  values: Readonly<Record<NeedField, string>>,
): ReadonlySet<NeedField> {
  const unchanged = new Set<NeedField>();
  for (const field of NEED_FIELDS) {
    if (baseline.digests?.[field] === needFieldDigest(values[field])) unchanged.add(field);
  }
  return unchanged;
}

/**
 * The need a command is for, the command, the version and status as the page
 * showed them, signed for this session. Bound to the **command** as well as the
 * need, so the token minted beside "withdraw" cannot be posted to the form that
 * merely submits the need.
 */
export function sealNeedBaseline(session: WebSession, baseline: NeedBaseline): string {
  return signPayload(session, BASELINE_PURPOSE, { ...baseline }, BASELINE_TTL_SECONDS);
}

/**
 * The baseline, if `token` is one this session was given for `command`;
 * otherwise `null` — one answer for forged, somebody else's, expired, minted for
 * another command, and from an earlier login.
 */
export function openNeedBaseline(
  session: WebSession,
  token: unknown,
  command: NeedCommand,
): NeedBaseline | null {
  const payload = verifyPayload(session, BASELINE_PURPOSE, token, baselineSchema);
  if (!payload || payload.command !== command) return null;
  return { ...payload, command };
}

// ---------------------------------------------------------------------------
// Adding: the stamp and the unresolved request
// ---------------------------------------------------------------------------

const ADD_STAMPS = replayStamps('project-need-create-replay');

/** The add stamp for `submissionId`, signed for that project at `projectVersion` (as `mintCreateStamp`). */
export function mintNeedStamp(
  session: WebSession,
  submissionId: string,
  projectId: string,
  projectVersion: number,
  now?: number,
): string {
  return ADD_STAMPS.mint(session, submissionId, projectId, now, undefined, projectVersion);
}

/**
 * A fresh submission id for a project's add form, with its stamp — signed for that project at the
 * version the page read (the editing episode the add belongs to).
 */
export function mintNeedSubmission(
  session: WebSession,
  projectId: string,
  projectVersion: number,
  now?: number,
): { readonly id: string; readonly replay: string } {
  return ADD_STAMPS.mintSubmission(session, projectId, now, undefined, projectVersion);
}

/** What an add stamp says: its time terms and the project version it was drawn at. */
export interface NeedStampTerms {
  readonly issuedAt: number;
  readonly deadline: number;
  readonly windowMs: number;
  readonly projectVersion: number;
}

/**
 * What a stamp this login holds for this project says about the add: when it was issued, its effective
 * deadline (the signed one or the current configuration's, whichever is earlier), the window, and the
 * project version it was drawn at. Null for a stamp that is not ours, not for this submission id or
 * project, or that names no project version (fail closed: such a stamp cannot be fenced).
 */
export function needStampTerms(
  session: WebSession,
  token: unknown,
  submissionId: string,
  projectId: string,
  now?: number,
): NeedStampTerms | null {
  const terms = ADD_STAMPS.terms(session, token, submissionId, projectId, now);
  if (terms === null || terms.version === null) return null;
  return {
    issuedAt: terms.issuedAt,
    deadline: terms.deadline,
    windowMs: terms.windowMs,
    projectVersion: terms.version,
  };
}

/** `OK` while the add may still be sent, `EXPIRED` past its window, `null` for a stamp that is not this project's. */
export function checkNeedStamp(
  session: WebSession,
  token: unknown,
  submissionId: string,
  projectId: string,
  now: number = Date.now(),
): 'OK' | 'EXPIRED' | null {
  const terms = needStampTerms(session, token, submissionId, projectId, now);
  if (terms === null) return null;
  return now > terms.deadline ? 'EXPIRED' : 'OK';
}

/** Where a project's unresolved add is kept (`server/unresolved-request.ts`); the organization comes from the login. */
export function needCreateScope(projectId: string): {
  readonly purpose: 'project-need-create';
  readonly target: string;
} {
  return { purpose: 'project-need-create', target: projectId };
}

/** What a project's add release acts on (`settleRelease`); made here, in `server/`, only. */
export function needCreateRelease(projectId: string): ReleaseScope {
  return ReleaseScope.of(needCreateScope(projectId));
}

/** The digest the unresolved add carries: of the body as it is sent. */
export function needBodyDigest(session: WebSession, body: unknown): string {
  return requestDigest(session, 'project-need-create', body);
}
