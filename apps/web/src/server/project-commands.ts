import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  BUSINESS_RULE_MESSAGE,
  commandsFrom,
  INVALID_INPUT_MESSAGE,
  KEY_REUSED_MESSAGE,
  PROJECT_422_PATTERNS,
  PROJECT_FIELDS,
  PROJECT_VALIDATION_DETAIL_CODES,
  STALE_MESSAGE,
  STATE_MESSAGE,
  isProjectCommand,
  isProjectWorkflow,
  type CancelField,
  type GrantField,
  type ProjectBody,
  type ProjectCommand,
  type ProjectField,
  type RejectField,
  type UpdateBody,
} from '@/lib/project-commands';

import type { WebServerEnv } from './env';
import { tokenAuthority } from './realm-roles';
import type { WebSession } from './session';
import { signPayload, verifyPayload } from './signed-payload';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';

/**
 * Creating, editing and moving a civil-works project, and an authority's
 * decision on one of its approval steps, through the gateway (EXP-004; ADR-058
 * § 3, ADR-059 § 3).
 *
 * The same split as `asset-lifecycle-commands.ts`: the form's own schema says
 * what a person may type and in what words a mistake is reported;
 * construction-service decides what is true. A rule copied here saves a round
 * trip and is never the enforcement.
 *
 * ## The Idempotency-Key, and the versions
 *
 * `POST /v1/projects` is the only call here that takes an `Idempotency-Key`: the
 * service stores it (`CONSTRUCTION_IDEMPOTENCY_TTL_HOURS`, 24 by default) and
 * answers the same key and body with the first response, while the first is in
 * flight with `409 CONFLICT` and `Retry-After`. So that call alone is keyed, and
 * only it is sent again with the same key. Every other call carries the
 * `expectedVersion` its page was drawn at, from the signed baseline; the first
 * send moves the version, so a second send of the same form is a `409` and not a
 * second write, and no key is sent for them (the controller reads none, the
 * OpenAPI document lists none).
 *
 * ## What a command acts on
 *
 * Not a field of any form. The page signs `{target, project, command, version,
 * status}` for this session (`sealProjectBaseline`) and the action takes the
 * target, the version and the status the person was looking at from that token
 * alone.
 */

// ---------------------------------------------------------------------------
// Who is offered the forms
// ---------------------------------------------------------------------------

/** The oversight role is refused by every route here whatever else its holder has. */
const OVERSIGHT_ROLE = 'AUDITOR';

/** Always accepted by `assertCanWrite`, while acting for an organization (docs/24 Q-69). */
const PLATFORM_ADMINISTRATOR = 'SYSTEM_ADMIN';

/**
 * `ProjectAccess.assertCanWrite`: not `AUDITOR`, one of `SYSTEM_ADMIN` and the
 * configured `CONSTRUCTION_PROJECT_ROLES`, and an organization acted for. The
 * service answers no permission list, and the roles are configuration, so this is
 * the portal's mirror of that rule — `WEB_PROJECT_ROLES`, which must change
 * together with the service's setting, exactly as `canPublish` and the
 * navigation link already rely on it. It chooses which forms are drawn, never
 * whether a write is allowed: the service decides again on every send, and a
 * person it refuses is told so in fixed words.
 *
 * `roles` is the token's own set for an organization it resolves to
 * (`tokenWriteRoles`), null when there is none to read.
 */
export function canWriteProjects(
  roles: readonly string[] | null,
  settings: Pick<WebServerEnv, 'WEB_PROJECT_ROLES'>,
): boolean {
  if (roles === null || roles.includes(OVERSIGHT_ROLE)) return false;
  return [PLATFORM_ADMINISTRATOR, ...settings.WEB_PROJECT_ROLES].some((role) =>
    roles.includes(role),
  );
}

/**
 * The project commands drawn on a project: what its status offers
 * (`commandsFrom`), to a person who may write projects — and not a request for
 * approval while the system is closed for want of a policy, which is said
 * instead of drawn (docs/24 Q-02).
 */
export function offeredCommands(input: {
  readonly status: string;
  readonly canWrite: boolean;
  readonly policyClosed: boolean;
}): readonly ProjectCommand[] {
  if (!input.canWrite) return [];
  return commandsFrom(input.status).filter(
    (command) => !(input.policyClosed && command === 'requestApproval'),
  );
}

/** A step of an approval round, as much as "may this person decide it" needs. */
export interface DecidableStep {
  readonly status: string;
  readonly workflowKey: string;
  readonly authorityOrganizationId: string;
  readonly authorityRole: string;
}

/**
 * `ProjectAccess.assertIsAuthority` of the service: a caller acting for the
 * step's `authorityOrganizationId` **and** holding its `authorityRole` there.
 * No super-role bypass — a platform administrator decides only if the policy
 * named the platform administrator's role. The service answers no list of what
 * a caller may decide, so this is the portal's mirror of that rule (pinned by
 * `project-commands.contract.spec.ts`); it chooses what is drawn, and the
 * service decides again on every send.
 */
export function mayDecide(accessToken: string, step: DecidableStep): boolean {
  if (step.status !== 'PENDING' || !isProjectWorkflow(step.workflowKey)) return false;
  const authority = tokenAuthority(accessToken);
  if (!authority || authority.organizationId === null) return false;
  if (authority.roles.includes(OVERSIGHT_ROLE)) return false;
  return (
    authority.organizationId === step.authorityOrganizationId &&
    authority.roles.includes(step.authorityRole)
  );
}

// ---------------------------------------------------------------------------
// What the service says, in Persian
// ---------------------------------------------------------------------------

function mappingOf<F extends string>(paths: Record<string, F>): FieldMapping<F> {
  return {
    paths,
    patterns: PROJECT_422_PATTERNS,
    byDetailCode: PROJECT_VALIDATION_DETAIL_CODES,
    byCode: {
      OPTIMISTIC_LOCK_FAILED: STALE_MESSAGE,
      IDEMPOTENCY_KEY_REUSED: KEY_REUSED_MESSAGE,
      INVALID_STATE_TRANSITION: STATE_MESSAGE,
      BUSINESS_RULE_VIOLATION: BUSINESS_RULE_MESSAGE,
    },
    // Never the service's own sentence: a text field could echo a stranger's
    // characters, so the list of words stays closed.
    fallback: INVALID_INPUT_MESSAGE,
  };
}

export const CREATE_FIELD_MAPPING = mappingOf<ProjectField>({
  title: 'title',
  operationType: 'operationType',
  locationDescription: 'locationDescription',
  scopeOfWork: 'scopeOfWork',
  estimatedCostMinor: 'estimatedCost',
});
export const UPDATE_FIELD_MAPPING = CREATE_FIELD_MAPPING;
export const CANCEL_FIELD_MAPPING = mappingOf<CancelField>({ reason: 'reason' });
export const NO_FIELD_MAPPING = mappingOf<never>({});
export const GRANT_FIELD_MAPPING = mappingOf<GrantField>({
  decisionNumber: 'decisionNumber',
  conditions: 'conditions',
});
export const REJECT_FIELD_MAPPING = mappingOf<RejectField>({ reason: 'reason' });

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const answerSchema = z.object({ id: z.string().min(1) });
export type WrittenProject = z.infer<typeof answerSchema>;

const projectPath = (projectId: string): string => `/v1/projects/${encodeURIComponent(projectId)}`;

/**
 * `replayDeadline` (ms since the epoch) is sent with the key: construction-service refuses an attempt
 * past it with `409 REPLAY_WINDOW_CLOSED` instead of finding its key expired and creating again.
 */
export const createProject = (
  session: WebSession,
  body: ProjectBody,
  submissionId: string,
  replayDeadline: number,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<WrittenProject, ProjectField>> =>
  writeThroughGateway(session, {
    path: '/v1/projects',
    body,
    submissionId,
    replayDeadline,
    schema: answerSchema,
    mapping: CREATE_FIELD_MAPPING,
    fetchImpl,
  });

export const updateProject = (
  session: WebSession,
  projectId: string,
  body: UpdateBody,
  expectedVersion: number,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<WrittenProject, ProjectField>> =>
  writeThroughGateway(session, {
    path: projectPath(projectId),
    method: 'PATCH',
    body: { ...body, expectedVersion },
    // Fenced by the version, not by a key (stated at the call since the key became required).
    idempotency: 'NONE',
    schema: answerSchema,
    mapping: UPDATE_FIELD_MAPPING,
    fetchImpl,
  });

function postCommand<F extends string, B extends object>(
  session: WebSession,
  path: string,
  body: B,
  expectedVersion: number,
  mapping: FieldMapping<F>,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<WrittenProject, F>> {
  return writeThroughGateway(session, {
    path,
    // The version the page was drawn at: construction-service applies the
    // command to that version only, so a stale page — or a second send of this
    // one — cannot write.
    body: { ...body, expectedVersion },
    idempotency: 'NONE',
    schema: answerSchema,
    mapping,
    fetchImpl,
  });
}

export const requestApproval = (
  session: WebSession,
  projectId: string,
  expectedVersion: number,
  fetchImpl?: typeof fetch,
) =>
  postCommand(
    session,
    `${projectPath(projectId)}/approvals`,
    {},
    expectedVersion,
    NO_FIELD_MAPPING,
    fetchImpl,
  );

export const startProject = (
  session: WebSession,
  projectId: string,
  expectedVersion: number,
  fetchImpl?: typeof fetch,
) =>
  postCommand(
    session,
    `${projectPath(projectId)}/start`,
    {},
    expectedVersion,
    NO_FIELD_MAPPING,
    fetchImpl,
  );

export const completeProject = (
  session: WebSession,
  projectId: string,
  expectedVersion: number,
  fetchImpl?: typeof fetch,
) =>
  postCommand(
    session,
    `${projectPath(projectId)}/complete`,
    {},
    expectedVersion,
    NO_FIELD_MAPPING,
    fetchImpl,
  );

export const cancelProject = (
  session: WebSession,
  projectId: string,
  body: { readonly reason: string },
  expectedVersion: number,
  fetchImpl?: typeof fetch,
) =>
  postCommand(
    session,
    `${projectPath(projectId)}/cancel`,
    body,
    expectedVersion,
    CANCEL_FIELD_MAPPING,
    fetchImpl,
  );

const approvalPath = (approvalId: string): string =>
  `/v1/approvals/${encodeURIComponent(approvalId)}/decision`;

export const grantApproval = (
  session: WebSession,
  approvalId: string,
  body: { readonly decisionNumber?: string; readonly conditions?: string },
  expectedVersion: number,
  fetchImpl?: typeof fetch,
) =>
  postCommand(
    session,
    approvalPath(approvalId),
    { ...body, decision: 'GRANT' },
    expectedVersion,
    GRANT_FIELD_MAPPING,
    fetchImpl,
  );

export const rejectApproval = (
  session: WebSession,
  approvalId: string,
  body: { readonly reason: string },
  expectedVersion: number,
  fetchImpl?: typeof fetch,
) =>
  postCommand(
    session,
    approvalPath(approvalId),
    { ...body, decision: 'REJECT' },
    expectedVersion,
    REJECT_FIELD_MAPPING,
    fetchImpl,
  );

// ---------------------------------------------------------------------------
// What a command was drawn from
// ---------------------------------------------------------------------------

const BASELINE_PURPOSE = 'project-baseline';

/**
 * Half an hour: a decision about a project is read and thought about before it
 * is sent, but a page left open for a morning is not what the person decided
 * on. The service compares the version again on every send, so this bounds how
 * stale a *confirmation* can be, not how stale a write can be.
 */
const BASELINE_TTL_SECONDS = 30 * 60;

/**
 * A short, unkeyed digest of one field of the edit form. The baseline records
 * which fields still hold the value the page was drawn with, without carrying
 * the text: a signed token may not exceed 4096 characters, and a scope of work
 * alone may be 5000. Not a secret and not a MAC — the signature is the MAC.
 */
export function fieldDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url').slice(0, 22);
}

const baselineSchema = z.object({
  /** The project, or for a decision the approval step. */
  targetId: z.string().min(1).max(200),
  /** The project the command is about; for a decision, the project of the step. */
  projectId: z.string().min(1).max(200),
  command: z.string().refine(isProjectCommand),
  version: z.number().int().min(1),
  /** The status the page showed: a project's, or the step's. */
  status: z.string().min(1).max(40),
  /** Digests of the edit form's fields as drawn; null for every other command. */
  digests: z.record(z.string(), z.string().max(40)).nullable(),
});

export interface ProjectBaseline {
  readonly targetId: string;
  readonly projectId: string;
  readonly command: ProjectCommand;
  readonly version: number;
  readonly status: string;
  readonly digests: Readonly<Record<string, string>> | null;
}

/** The digests of an edit form's fields, as the page drew them. */
export function editDigests(
  values: Readonly<Record<ProjectField, string>>,
): Record<ProjectField, string> {
  return Object.fromEntries(
    PROJECT_FIELDS.map((field) => [field, fieldDigest(values[field])]),
  ) as Record<ProjectField, string>;
}

/** The fields whose submitted text still has the digest the page was drawn with. */
export function unchangedFields(
  baseline: ProjectBaseline,
  values: Readonly<Record<ProjectField, string>>,
): ReadonlySet<ProjectField> {
  const unchanged = new Set<ProjectField>();
  for (const field of PROJECT_FIELDS) {
    if (baseline.digests?.[field] === fieldDigest(values[field])) unchanged.add(field);
  }
  return unchanged;
}

/**
 * The target a command is for, the command, the version and status as the page
 * showed them, signed for this session. Bound to the **command** as well as the
 * target, so the token minted beside "cancel" cannot be posted to the form that
 * merely starts the project.
 */
export function sealProjectBaseline(session: WebSession, baseline: ProjectBaseline): string {
  return signPayload(session, BASELINE_PURPOSE, { ...baseline }, BASELINE_TTL_SECONDS);
}

/**
 * The baseline, if `token` is one this session was given for `command`;
 * otherwise `null` — one answer for forged, somebody else's, expired, minted for
 * another command, and from an earlier login.
 */
export function openProjectBaseline(
  session: WebSession,
  token: unknown,
  command: ProjectCommand,
): ProjectBaseline | null {
  const payload = verifyPayload(session, BASELINE_PURPOSE, token, baselineSchema);
  if (!payload || payload.command !== command) return null;
  return { ...payload, command };
}
