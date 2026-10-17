import { z } from 'zod';

import {
  APPROVAL_REFUSAL_TEXT,
  OPENING_REFUSAL_TEXT,
  OWNER_CODE_TEXT,
  OWNER_REFUSAL_FALLBACK,
  PUBLICATION_REFUSAL_TEXT,
  REASON_FIELD,
  type OwnerCommand,
} from '@/lib/tender-owner-fields';

import { callGateway, GatewayRequestError } from './gateway';
import { webServerEnv, type WebServerEnv } from './env';
import { utcInstant } from './instant';
import { canReadProjects } from './portal-nav';
import { tokenAuthority, tokenPerson } from './realm-roles';
import type { WebSession } from './session';
import type { ReadResult } from './assets';
import type { TenderDetail } from './tenders';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';

/**
 * The owner's side of a tender, read and commanded through the gateway
 * (EXP-004; construction-service CON-002 PRs 7–11, ADR-065, ADR-066, Q-84,
 * Q-91): publishing it through its approval, and opening its bids — two
 * people, a proposal and an opening.
 *
 * ## What is read
 *
 * - `GET /v1/tenders/{id}/approvals?workflowKey=tender.publication` — the
 *   publication's requests, newest first, each with its steps (who decides,
 *   where each stands). The project reader roles, on one's own tender.
 * - `GET /v1/approvals/{id}` — one step, for the version a decision is made
 *   against; only for the step this caller may decide.
 * - `GET /v1/tenders/{id}/bids` — the owner's view of the bids: **before** the
 *   opening how many and when each was received, never who or what; **after**
 *   it every opened bid with its content, read back against audit-service's
 *   receipts. Only for a caller the service would admit as an opener: the
 *   service audits every such read (`bid_access_log`, `BID_ACCESSED`). The
 *   content is shown only as the service returns it, to whom it returns it.
 *
 * ## Who may command — a copy of construction-service, never a rule of our own
 *
 * No owner view carries the caller's available actions, so the helpers below
 * mirror `ProjectAccess` (`assertCanWrite`, `assertIsAuthority`,
 * `assertCanOpenBids`) and the services' checks, from the token the service
 * decides on, and `tender-owner.contract.spec.ts` pins them to the source.
 * They choose what to draw; the service decides again. What the views cannot
 * show is left to the service and said in fixed words when it refuses:
 * whether identity-service holds the person a member with the role **now**,
 * whether they are a member of an organization that bid (`CONFLICT_OF_INTEREST`),
 * and — the tender view does not carry it — whether an opening is proposed,
 * and by whom (`PROPOSAL_REQUIRED`, `SECOND_PERSON_REQUIRED`, `NO_PROPOSAL`).
 */

// -- the views ---------------------------------------------------------------------------

const stepSchema = z.object({
  approvalId: z.string(),
  stepOrder: z.number().int(),
  approvalType: z.string(),
  authorityOrganizationId: z.string(),
  authorityRole: z.string(),
  authorityLabel: z.string(),
  status: z.string(),
  decidedAt: utcInstant.nullable(),
});

export type ApprovalStep = z.infer<typeof stepSchema>;

/** `tenderApprovalRequestViewSchema`, less what no screen reads. */
export const APPROVAL_REQUEST_SCHEMA = z.object({
  id: z.string(),
  tenderId: z.string(),
  workflowKey: z.string(),
  round: z.number().int(),
  tenderVersion: z.number().int(),
  status: z.string(),
  requestedBy: z.string(),
  requestedAt: utcInstant,
  endedAt: utcInstant.nullable(),
  endedReason: z.string().nullable(),
  consumedAt: utcInstant.nullable(),
  steps: z.array(stepSchema),
});

export type ApprovalRequest = z.infer<typeof APPROVAL_REQUEST_SCHEMA>;

const requestPageSchema = z.object({
  items: z.array(APPROVAL_REQUEST_SCHEMA),
  nextCursor: z.string().nullable().default(null),
  hasMore: z.boolean().default(false),
});

/** `approvalViewSchema`, as much as a decision needs. */
export const APPROVAL_SCHEMA = z.object({
  id: z.string(),
  tenderId: z.string().nullable(),
  workflowKey: z.string(),
  status: z.string(),
  authorityOrganizationId: z.string(),
  authorityRole: z.string(),
  version: z.number().int().min(1),
});

export type Approval = z.infer<typeof APPROVAL_SCHEMA>;

const minorUnits = z.string().regex(/^\d+$/, 'whole, non-negative minor units');

const openedBidSchema = z.object({
  bidId: z.string(),
  tenderId: z.string(),
  bidderOrganizationId: z.string(),
  status: z.string(),
  revision: z.number().int(),
  receivedAt: utcInstant,
  content: z.object({
    priceMinor: minorUnits,
    answers: z.array(z.object({ criterionCode: z.string(), response: z.string() })),
    note: z.string().optional(),
  }),
});

export type OpenedBid = z.infer<typeof openedBidSchema>;

/** `tenderBidsViewSchema`: before the opening a count and times; after it, the bids. */
export const OWNER_BIDS_SCHEMA = z.object({
  tenderId: z.string(),
  opened: z.boolean(),
  bidCount: z.number().int().min(0),
  receivedAt: z.array(utcInstant),
  bids: z.array(openedBidSchema),
});

export type OwnerBids = z.infer<typeof OWNER_BIDS_SCHEMA>;

/** A publication's command answers either the tender (published) or its request (202). */
const tenderAnswerSchema = z.object({
  id: z.string(),
  status: z.string(),
  version: z.number().int(),
});

const openedAnswerSchema = z.object({
  tenderId: z.string(),
  status: z.string(),
  openedAt: utcInstant,
  bidCount: z.number().int(),
  alreadyOpened: z.boolean(),
});

const proposalAnswerSchema = z.object({
  tenderId: z.string(),
  proposedBy: z.string(),
  alreadyProposed: z.boolean(),
});

const withdrawnAnswerSchema = z.object({ tenderId: z.string(), withdrawnProposal: z.string() });

// -- reads -------------------------------------------------------------------------------

async function read<S extends z.ZodTypeAny>(
  session: WebSession,
  path: string,
  schema: S,
): Promise<ReadResult<z.infer<S>>> {
  try {
    const response = await callGateway<unknown>({
      baseUrl: webServerEnv().API_GATEWAY_URL,
      path,
      accessToken: session.accessToken,
    });
    const parsed = schema.safeParse(response.data);
    if (!parsed.success) return { kind: 'MALFORMED', correlationId: response.correlationId };
    return { kind: 'OK', data: parsed.data };
  } catch (error) {
    if (error instanceof GatewayRequestError) {
      if (error.status === 403) return { kind: 'FORBIDDEN' };
      if (error.status === 404) return { kind: 'NOT_FOUND' };
      return { kind: 'UNAVAILABLE', status: error.status, correlationId: error.correlationId };
    }
    throw error;
  }
}

const tenderPath = (tenderId: string): string => `/v1/tenders/${encodeURIComponent(tenderId)}`;

export const PUBLICATION_WORKFLOW = 'tender.publication';

/** The newest publication request of the tender, or null when none was ever made. */
export async function fetchPublicationRequest(
  session: WebSession,
  tenderId: string,
): Promise<ReadResult<ApprovalRequest | null>> {
  const search = new URLSearchParams({ workflowKey: PUBLICATION_WORKFLOW, limit: '1' });
  const page = await read(
    session,
    `${tenderPath(tenderId)}/approvals?${search}`,
    requestPageSchema,
  );
  if (page.kind !== 'OK') return page;
  const [latest] = page.data.items;
  if (latest && (latest.tenderId !== tenderId || latest.workflowKey !== PUBLICATION_WORKFLOW)) {
    return { kind: 'MALFORMED', correlationId: '' };
  }
  return { kind: 'OK', data: latest ?? null };
}

export function fetchApproval(
  session: WebSession,
  approvalId: string,
): Promise<ReadResult<Approval>> {
  return read(session, `/v1/approvals/${encodeURIComponent(approvalId)}`, APPROVAL_SCHEMA);
}

export function fetchOwnerBids(
  session: WebSession,
  tenderId: string,
): Promise<ReadResult<OwnerBids>> {
  return read(session, `${tenderPath(tenderId)}/bids`, OWNER_BIDS_SCHEMA);
}

// -- who may command ---------------------------------------------------------------------

/** construction-service `access.ts`. */
export const PLATFORM_ADMINISTRATOR = 'SYSTEM_ADMIN';
export const CONTRACTOR_ROLE = 'CONTRACTOR';
export const OVERSIGHT_ROLE = 'AUDITOR';
/** `BID_EXCLUDED_ROLES`: never open or read a bid, whenever present. */
export const BID_EXCLUDED_ROLES: readonly string[] = [
  PLATFORM_ADMINISTRATOR,
  CONTRACTOR_ROLE,
  OVERSIGHT_ROLE,
];

/** What the owner's checks read from the token. Null fields: not readable — nothing is offered. */
export interface OwnerCaller {
  readonly organizationId: string | null;
  readonly roles: readonly string[] | null;
  /** `rasta_uid`, which `@RequirePlatformUserId` demands on publishing and on the opening. */
  readonly platformUser: boolean;
  /** `AuthGuard`'s `userId` — what a request's `requestedBy` names. */
  readonly actorId: string | null;
}

export function ownerCallerOf(accessToken: string): OwnerCaller {
  const authority = tokenAuthority(accessToken);
  const person = tokenPerson(accessToken);
  return {
    organizationId: authority?.organizationId ?? null,
    roles: authority?.roles ?? null,
    platformUser: person?.platformUser ?? false,
    actorId: person?.actorId ?? null,
  };
}

type RoleSettings = Pick<
  WebServerEnv,
  'WEB_PROJECT_ROLES' | 'WEB_PROJECT_READER_ROLES' | 'WEB_TENDER_OPEN_ROLES'
>;

/**
 * `assertCanWrite` (`assert(writers)`: not `AUDITOR`, one of `SYSTEM_ADMIN` and
 * `CONSTRUCTION_PROJECT_ROLES`, an organization acted for) and the publish
 * route's `@RequirePlatformUserId`, on the owner's own tender — the owner's door
 * answers no other.
 */
export function canPublish(caller: OwnerCaller, settings: RoleSettings): boolean {
  const { roles } = caller;
  if (roles === null || caller.organizationId === null || !caller.platformUser) return false;
  if (roles.includes(OVERSIGHT_ROLE)) return false;
  const writers = [PLATFORM_ADMINISTRATOR, ...settings.WEB_PROJECT_ROLES];
  return writers.some((role) => roles.includes(role));
}

/**
 * `assertCanOpenBids` (`assertOwnerBidSide(bidOpeners)`): none of
 * `BID_EXCLUDED_ROLES` whenever present, one of the opening roles
 * (`CONSTRUCTION_TENDER_OPEN_ROLES`, else the project roles, less the excluded
 * ones), an organization acted for; and the routes' `@RequirePlatformUserId`.
 */
export function canOpenBids(caller: OwnerCaller, settings: RoleSettings): boolean {
  const { roles } = caller;
  if (roles === null || caller.organizationId === null || !caller.platformUser) return false;
  if (BID_EXCLUDED_ROLES.some((role) => roles.includes(role))) return false;
  const openers = (
    settings.WEB_TENDER_OPEN_ROLES.length > 0
      ? settings.WEB_TENDER_OPEN_ROLES
      : settings.WEB_PROJECT_ROLES
  ).filter((role) => !BID_EXCLUDED_ROLES.includes(role));
  return openers.some((role) => roles.includes(role));
}

/**
 * The step of the publication request this caller is the authority of, or
 * null — `assertIsAuthority` and `TenderApprovalService.decide`, as far as the
 * views show: a request still `PENDING` and asked on the tender's version now
 * (a request the tender has moved past is ended `STALE` by any decision), its
 * `PENDING` step, the caller acting for the step's organization with its exact
 * role (no override; `SYSTEM_ADMIN` only if the policy named it), not
 * `AUDITOR`. Who made the request does not matter here: only a grant is
 * refused to them (`mayGrant`). Live membership is identity-service's to say.
 */
export function decidableStep(
  caller: OwnerCaller,
  request: ApprovalRequest | null,
  tenderVersion: number,
): ApprovalStep | null {
  const { roles, organizationId } = caller;
  if (request === null || request.status !== 'PENDING') return null;
  if (request.tenderVersion !== tenderVersion) return null;
  if (roles === null || organizationId === null) return null;
  if (roles.includes(OVERSIGHT_ROLE)) return null;
  const step = request.steps.find((candidate) => candidate.status === 'PENDING');
  if (!step) return null;
  if (step.authorityOrganizationId !== organizationId) return null;
  return roles.includes(step.authorityRole) ? step : null;
}

/**
 * Whether the authority may also grant: `assertDistinctActors`, applied by the
 * service to a `GRANT` only — the person who made the request never approves
 * it, and may still reject it. A caller whose identity the token does not name
 * cannot be told apart from the requester, so is not offered the grant.
 */
export function mayGrant(caller: OwnerCaller, request: ApprovalRequest): boolean {
  return caller.actorId !== null && request.requestedBy !== caller.actorId;
}

/** What the page may draw for the owner, and why nothing when it has a reason to say. */
export type OwnerOffer =
  | { readonly command: 'PUBLISH'; readonly expectedVersion: number; readonly execute: boolean }
  | {
      readonly command: 'GRANT' | 'REJECT';
      readonly approvalId: string;
      readonly expectedVersion: number;
    }
  | { readonly command: 'PROPOSE_OPENING' | 'OPEN_BIDS' | 'WITHDRAW_PROPOSAL' };

export type OwnerNote =
  /** A request is being decided, and not by this person. */
  | 'PUBLICATION_PENDING'
  /** This person made the request: the grant is someone else's, a rejection may be theirs. */
  | 'OWN_REQUEST'
  /** The newest request was asked on an earlier version: a new request ends it and asks again. */
  | 'REQUEST_BEHIND'
  /** The publication's requests could not be read: what to offer is unknown. */
  | 'REQUESTS_UNREAD'
  /** The decidable step could not be read for its version. */
  | 'STEP_UNREAD'
  /** Published and past the deadline: the sweeper closes it, no person does. */
  | 'AWAITING_CLOSE'
  | null;

export interface OwnerState {
  readonly tender: Pick<TenderDetail, 'status' | 'version' | 'bidClosingAt'>;
  readonly publication: ReadResult<ApprovalRequest | null> | null;
  /** The step this caller may decide, read for its version; null when there is none to read. */
  readonly step: ReadResult<Approval> | null;
}

/**
 * The owner's offers, the checks in the services' order:
 *
 * - **publish** a `DRAFT` (`assertTenderTransition` to `PUBLISHED`), unless its
 *   newest request is still `PENDING` on the tender's version now — sending it
 *   again would only find that request. A pending request on an earlier version
 *   does not hold it back: the gate ends that request and opens a new one
 *   (`TenderApprovalGate.resolve`). Approved on this very version, the same
 *   command executes;
 * - **decide** the pending step the caller is the authority of: reject always,
 *   grant only if they did not make the request;
 * - **open**, in two persons, a `CLOSED` tender: propose, open, withdraw one's
 *   own proposal. Which of the three applies the views do not say (whether a
 *   proposal stands, and whose), so all three are drawn and the service refuses
 *   the wrong one in fixed words.
 */
export function ownerOffers(
  caller: OwnerCaller,
  state: OwnerState,
  settings: RoleSettings,
  now: number,
): { readonly offers: readonly OwnerOffer[]; readonly notes: readonly OwnerNote[] } {
  const offers: OwnerOffer[] = [];
  const notes: OwnerNote[] = [];
  const { tender, publication, step } = state;

  if (tender.status === 'DRAFT' && canPublish(caller, settings)) {
    if (publication === null || publication.kind !== 'OK') {
      notes.push('REQUESTS_UNREAD');
    } else {
      const latest = publication.data;
      if (latest?.status === 'PENDING' && latest.tenderVersion === tender.version) {
        notes.push(latest.requestedBy === caller.actorId ? 'OWN_REQUEST' : 'PUBLICATION_PENDING');
      } else {
        if (latest?.status === 'PENDING') notes.push('REQUEST_BEHIND');
        offers.push({
          command: 'PUBLISH',
          expectedVersion: tender.version,
          execute: latest?.status === 'APPROVED' && latest.tenderVersion === tender.version,
        });
      }
    }
  }

  if (tender.status === 'DRAFT' && publication?.kind === 'OK') {
    const request = publication.data;
    const decidable = decidableStep(caller, request, tender.version);
    if (request !== null && decidable) {
      if (step?.kind === 'OK' && step.data.id === decidable.approvalId) {
        const commands = mayGrant(caller, request)
          ? (['GRANT', 'REJECT'] as const)
          : (['REJECT'] as const);
        for (const command of commands) {
          offers.push({
            command,
            approvalId: decidable.approvalId,
            expectedVersion: step.data.version,
          });
        }
      } else {
        notes.push('STEP_UNREAD');
      }
    }
  }

  if (tender.status === 'PUBLISHED' && tender.bidClosingAt !== null) {
    if (now >= Date.parse(tender.bidClosingAt)) notes.push('AWAITING_CLOSE');
  }

  if (tender.status === 'CLOSED' && canOpenBids(caller, settings)) {
    for (const command of ['PROPOSE_OPENING', 'OPEN_BIDS', 'WITHDRAW_PROPOSAL'] as const) {
      offers.push({ command });
    }
  }

  return { offers, notes };
}

/**
 * An opener who may not read the tender itself (PR 345 review 1, finding 4):
 * `GET /v1/tenders/:id` is `assertCanRead` (the project roles, the project
 * reader roles, `SYSTEM_ADMIN`), while the opening and `GET …/bids` are
 * `assertCanOpenBids` alone — so a configured opening role (say
 * `FLEET_MANAGER` in `CONSTRUCTION_TENDER_OPEN_ROLES`) opens bids on a tender
 * whose details it is refused. Such a caller's page reads only the bids.
 */
export function isOpeningOnly(caller: OwnerCaller, settings: RoleSettings): boolean {
  return (
    caller.roles !== null &&
    canOpenBids(caller, settings) &&
    !canReadProjects(caller.roles, settings)
  );
}

/**
 * The opening-only caller's offers: the opening's three while the bids are not
 * opened. Whether the tender is closed yet is not something it may read — the
 * service refuses the opening of one that is not (`NOT_CLOSED`) in fixed words.
 */
export function openingOnlyOffers(
  caller: OwnerCaller,
  bids: ReadResult<OwnerBids>,
  settings: RoleSettings,
): readonly OwnerOffer[] {
  if (!canOpenBids(caller, settings) || bids.kind !== 'OK' || bids.data.opened) return [];
  return [
    { command: 'PROPOSE_OPENING' },
    { command: 'OPEN_BIDS' },
    { command: 'WITHDRAW_PROPOSAL' },
  ];
}

/** Whether the owner's bids view is asked for: an opener, on a tender that has had bids. */
export function readsOwnerBids(
  caller: OwnerCaller,
  status: string,
  settings: RoleSettings,
): boolean {
  return status !== 'DRAFT' && status !== 'CANCELLED' && canOpenBids(caller, settings);
}

// -- the requests ------------------------------------------------------------------------

/** What a command acts on, from the verified stamp — never from the posted form. */
export interface OwnerBinding {
  readonly command: OwnerCommand;
  readonly approvalId: string | null;
  readonly expectedVersion: number | null;
}

export interface OwnerRequest {
  readonly path: string;
  readonly body: unknown;
}

/** The request of a command, or null when the binding cannot make one. */
export function ownerRequest(
  tenderId: string,
  binding: OwnerBinding,
  reason: string | null,
): OwnerRequest | null {
  const base = tenderPath(tenderId);
  switch (binding.command) {
    case 'PUBLISH':
      if (binding.approvalId !== null || binding.expectedVersion === null) return null;
      return { path: `${base}/publish`, body: { expectedVersion: binding.expectedVersion } };
    case 'GRANT':
    case 'REJECT': {
      if (binding.approvalId === null || binding.expectedVersion === null) return null;
      if ((binding.command === 'REJECT') !== (reason !== null)) return null;
      return {
        path: `/v1/approvals/${encodeURIComponent(binding.approvalId)}/decision`,
        body: {
          expectedVersion: binding.expectedVersion,
          decision: binding.command,
          ...(reason !== null ? { reason } : {}),
        },
      };
    }
    default:
      if (binding.approvalId !== null || binding.expectedVersion !== null) return null;
      return {
        path:
          binding.command === 'OPEN_BIDS'
            ? `${base}/open-bids`
            : binding.command === 'PROPOSE_OPENING'
              ? `${base}/open-bids/proposal`
              : `${base}/open-bids/proposal/withdraw`,
        body: {},
      };
  }
}

/** Every closed reason the owner's commands can name, in fixed words; one table for all areas. */
const OWNER_REFUSAL_TEXT: Readonly<Record<string, string>> = {
  ...PUBLICATION_REFUSAL_TEXT,
  ...OPENING_REFUSAL_TEXT,
  ...APPROVAL_REFUSAL_TEXT,
};

export const OWNER_FIELD_MAPPING: FieldMapping<string> = {
  paths: { reason: REASON_FIELD },
  byDetailCode: OWNER_REFUSAL_TEXT,
  byCode: OWNER_CODE_TEXT,
  fallback: OWNER_REFUSAL_FALLBACK,
};

/** What a confirmed command came to, for the flash. */
export type OwnerOutcome =
  | 'PUBLISHED'
  | 'REQUESTED'
  | 'GRANT'
  | 'REJECT'
  | 'PROPOSE_OPENING'
  | 'OPEN_BIDS'
  | 'WITHDRAW_PROPOSAL';

/** The answer each command must show to be confirmed; anything else is unconfirmed. */
function answerSchema(tenderId: string, binding: OwnerBinding) {
  switch (binding.command) {
    case 'PUBLISH':
      return z.union([
        tenderAnswerSchema.refine(
          (tender) => tender.id === tenderId && tender.status === 'PUBLISHED',
        ),
        APPROVAL_REQUEST_SCHEMA.refine(
          (request) =>
            request.tenderId === tenderId &&
            request.workflowKey === PUBLICATION_WORKFLOW &&
            request.tenderVersion === binding.expectedVersion &&
            request.status === 'PENDING',
        ),
      ]);
    case 'GRANT':
    case 'REJECT':
      return APPROVAL_SCHEMA.refine(
        (approval) =>
          approval.id === binding.approvalId &&
          approval.tenderId === tenderId &&
          approval.status === (binding.command === 'GRANT' ? 'GRANTED' : 'REJECTED'),
      );
    case 'PROPOSE_OPENING':
      return proposalAnswerSchema.refine((answer) => answer.tenderId === tenderId);
    case 'OPEN_BIDS':
      return openedAnswerSchema.refine(
        (answer) => answer.tenderId === tenderId && answer.status !== 'CLOSED',
      );
    case 'WITHDRAW_PROPOSAL':
      return withdrawnAnswerSchema.refine((answer) => answer.tenderId === tenderId);
  }
}

export type OwnerCommandResult = Exclude<WriteResult<unknown, string>, { kind: 'UNAVAILABLE' }>;

/**
 * Sends one command, with an `Idempotency-Key` — the gateway requires one on
 * every unsafe call under `/v1/tenders`. None of these commands is replayed by
 * it in the service: a publication and a decision are bound to the version the
 * page read (`409` once it moved), and the opening's three are idempotent there
 * (`alreadyProposed`, `alreadyOpened`, `NO_PROPOSAL`). Every `UNAVAILABLE` is
 * unconfirmed.
 */
export async function issueOwnerCommand(
  session: WebSession,
  tenderId: string,
  binding: OwnerBinding,
  request: OwnerRequest,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<OwnerCommandResult> {
  const result = await writeThroughGateway(session, {
    path: request.path,
    body: request.body,
    submissionId,
    schema: answerSchema(tenderId, binding),
    mapping: OWNER_FIELD_MAPPING,
    fetchImpl,
  });
  if (result.kind === 'UNAVAILABLE') {
    return { kind: 'UNKNOWN_OUTCOME', correlationId: result.correlationId };
  }
  return result;
}

/** What a confirmed answer means for the flash. */
export function outcomeOf(command: OwnerCommand, answer: unknown): OwnerOutcome {
  if (command !== 'PUBLISH') return command;
  return (answer as { status?: unknown }).status === 'PUBLISHED' ? 'PUBLISHED' : 'REQUESTED';
}
