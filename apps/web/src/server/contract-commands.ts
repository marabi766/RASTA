import { z } from 'zod';

import {
  CONTRACT_CODE_TEXT,
  CONTRACT_FIELDS,
  CONTRACT_REFUSAL_FALLBACK,
  CONTRACT_REFUSAL_TEXT,
  type ContractCommand,
  type ContractField,
  type ContractSide,
} from '@/lib/contract-command-fields';
import type {
  AmendmentInput,
  CancelInput,
  CommandInput,
  MilestoneInput,
} from '@/lib/contract-command-input';

import { callGateway, GatewayRequestError } from './gateway';
import {
  AMENDMENT_SCHEMA,
  CONTRACT_DETAIL_SCHEMA,
  MILESTONE_SCHEMA,
  type Amendment,
  type ContractDetail,
  type Milestone,
} from './contracts';
import {
  CONTRACTOR_ROLE,
  OVERSIGHT_ROLE,
  PLATFORM_ADMINISTRATOR,
  statementCallerOf,
  type StatementCaller,
} from './contract-statements';
import { webServerEnv, type WebServerEnv } from './env';
import type { WebSession } from './session';
import type { ReadResult } from './assets';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';

/**
 * The contract's own commands, through the gateway (EXP-004; contract-service
 * CON-003 PRs 2–3, ADR-068 § 7, § 9): accepting the draft for one's side
 * (`…/sign`), cancelling a draft (`…/cancel`), proposing and signing an
 * amendment (`…/amendments`, `…/amendments/{id}/sign`), and planning and
 * changing a milestone (`…/milestones`, `PATCH …/milestones/{id}`).
 *
 * ## Who may command — a copy of contract-service, never a rule of our own
 *
 * No view carries a per-caller list of what the caller may do, so the
 * eligibility helpers below mirror the service's own checks, in its order,
 * from the token the service decides on (`statementCallerOf`), and are pinned
 * to its source by `contract-commands.contract.spec.ts`. They choose what to
 * draw; the service decides again on every request.
 *
 * - **Configured roles** (`CONTRACT_CANCEL_ROLES`, `CONTRACT_AMENDMENT_ROLES`,
 *   `CONTRACT_MILESTONE_ROLES`) and the cancel and amendment reason lists are
 *   mirrored by `WEB_CONTRACT_*` settings, as `WEB_CONTRACT_READER_ROLES`
 *   mirrors the readers (`server/env.ts`).
 * - **Who signs for the employer** is not configuration: it is the
 *   `contract.signature` policy in force for the employer's organization. The
 *   page reads it (`fetchSigningPolicy`) — the employer's contract readers may
 *   (`PolicyAccess.canSeePolicy`) — and draws the form only when a step of it
 *   names the employer's organization and a role the caller holds
 *   (`signingRoleUnder`). Unread, nothing is drawn: never a guess.
 * - **What the views cannot tell** is left to the service, whose refusal the
 *   form says in fixed words: whether this person already signed the other
 *   side (`SAME_PERSON_BOTH_SIDES` — a view never names a signer), whether the
 *   union that wrote the policy still governs the employer
 *   (`POLICY_AUTHOR_NOT_GOVERNING`), and whether the contract already holds as
 *   many milestones as the service allows (`MILESTONE_LIMIT_REACHED`).
 *
 * ## The answers
 *
 * Each command's answer must show what the command did — the side signed, the
 * cancellation, the amendment or milestone as it was sent — to be confirmed;
 * anything else, a 5xx included, is an unknown outcome, never "nothing
 * changed" (`server/write.ts`).
 */

export type ContractCaller = StatementCaller;

/** The request context the service decides on, from the token (`statementCallerOf`). */
export const contractCallerOf = statementCallerOf;

/** contract-service `policy.state-machine.ts`: `SIGNATURE_WORKFLOW`. */
export const SIGNATURE_WORKFLOW = 'contract.signature';

type RoleEnv = Pick<
  WebServerEnv,
  | 'WEB_CONTRACT_CANCEL_ROLES'
  | 'WEB_CONTRACT_AMENDMENT_ROLES'
  | 'WEB_CONTRACT_MILESTONE_ROLES'
  | 'WEB_CONTRACT_CANCEL_AFTER_SIGNATURE'
>;

// -- the signing policy -----------------------------------------------------------------

const policySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  workflowKey: z.string(),
  status: z.string(),
  steps: z.array(z.object({ authorityOrganizationId: z.string(), authorityRole: z.string() })),
});

/** The parts of a `contract.signature` policy the signing check reads. */
export type SigningPolicy = z.infer<typeof policySchema>;

const policyPageSchema = z.object({
  items: z.array(policySchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

/** The service's page ceiling (`MAX_PAGE_SIZE`): one page holds every policy of a slot. */
const POLICIES_PER_PAGE = 200;

/**
 * The `contract.signature` policy in force for `employerId`: `OK` with it, or
 * with `null` when none is in force — then nobody signs for the employer
 * (`SIGNATURE_POLICY_REQUIRED`). The list also returns policies the
 * organization **wrote** for others, so it is filtered to the one that governs
 * it. Anything but a clean answer is not an answer: no form is drawn on it.
 */
export async function fetchSigningPolicy(
  session: WebSession,
  employerId: string,
): Promise<ReadResult<SigningPolicy | null>> {
  const search = new URLSearchParams({
    workflowKey: SIGNATURE_WORKFLOW,
    status: 'ACTIVE',
    limit: String(POLICIES_PER_PAGE),
  });
  try {
    const response = await callGateway<unknown>({
      baseUrl: webServerEnv().API_GATEWAY_URL,
      path: `/v1/contract-approval-policies?${search.toString()}`,
      accessToken: session.accessToken,
    });
    const parsed = policyPageSchema.safeParse(response.data);
    if (!parsed.success) return { kind: 'MALFORMED', correlationId: response.correlationId };
    const governing = parsed.data.items.find(
      (policy) =>
        policy.organizationId === employerId &&
        policy.workflowKey === SIGNATURE_WORKFLOW &&
        policy.status === 'ACTIVE',
    );
    if (governing) return { kind: 'OK', data: governing };
    // Not on a page that has more: unknown, not absent.
    if (parsed.data.hasMore) return { kind: 'MALFORMED', correlationId: response.correlationId };
    return { kind: 'OK', data: null };
  } catch (error) {
    if (error instanceof GatewayRequestError) {
      if (error.status === 403) return { kind: 'FORBIDDEN' };
      if (error.status === 404) return { kind: 'NOT_FOUND' };
      return { kind: 'UNAVAILABLE', status: error.status, correlationId: error.correlationId };
    }
    throw error;
  }
}

/**
 * `signingRoleUnder`: the role a step of the policy names, for the governed
 * organization itself, that the caller holds — or null.
 */
export function signingRoleUnder(
  policy: Pick<SigningPolicy, 'organizationId' | 'steps'>,
  roles: readonly string[],
): string | null {
  return (
    policy.steps.find(
      (step) =>
        step.authorityOrganizationId === policy.organizationId &&
        roles.includes(step.authorityRole),
    )?.authorityRole ?? null
  );
}

// -- who may command -------------------------------------------------------------------

/**
 * `assertCanCommand` / `assertCanCommandAmendments`, and the routes'
 * `@RequirePlatformUserId`: a signed-in person with a platform user id, acting
 * for an organization, who is neither the oversight role (refused by
 * `RolesGuard` too) nor the platform administrator (refused outright: it never
 * signs, cancels, amends or plans for a party). The organization acted for, or
 * null.
 */
function commandingOrganization(caller: ContractCaller): string | null {
  const { roles, organizationId } = caller;
  if (roles === null || organizationId === null || !caller.platformUser) return null;
  if (roles.includes(OVERSIGHT_ROLE) || roles.includes(PLATFORM_ADMINISTRATOR)) return null;
  return organizationId;
}

/** The contract facts a command's eligibility reads. */
export type CommandContract = Pick<
  ContractDetail,
  | 'organizationId'
  | 'contractorOrganizationId'
  | 'status'
  | 'employerSignedAt'
  | 'contractorSignedAt'
>;

/** `sideOf`: which party the organization is, or null. */
export function sideOf(
  contract: Pick<CommandContract, 'organizationId' | 'contractorOrganizationId'>,
  organizationId: string,
): ContractSide | null {
  if (contract.organizationId === organizationId) return 'EMPLOYER';
  if (contract.contractorOrganizationId === organizationId) return 'CONTRACTOR';
  return null;
}

/** `isMemberOfBothParties`: on the memberships the token signs, never the tenant selected. */
function memberOfBothParties(
  caller: ContractCaller,
  contract: Pick<CommandContract, 'organizationId' | 'contractorOrganizationId'>,
): boolean {
  return (
    caller.memberships.includes(contract.organizationId) &&
    caller.memberships.includes(contract.contractorOrganizationId)
  );
}

function holdsAny(caller: ContractCaller, roles: readonly string[]): boolean {
  return roles.some((role) => (caller.roles ?? []).includes(role));
}

/**
 * What the page knows of who signs for the employer: the policy in force (or
 * none), or `UNREAD` when it could not be read — then no employer signature is
 * offered.
 */
export type SigningAuthorityView = { readonly policy: SigningPolicy | null } | 'UNREAD';

/** Whether the caller's side would be accepted a new signature, as the views can tell. */
function maySignFor(
  caller: ContractCaller,
  side: ContractSide,
  authority: SigningAuthorityView,
): boolean {
  if (side === 'CONTRACTOR') return holdsAny(caller, [CONTRACTOR_ROLE]);
  if (authority === 'UNREAD' || authority.policy === null) return false;
  return signingRoleUnder(authority.policy, caller.roles ?? []) !== null;
}

/**
 * The side this caller may sign the contract for, or null — `ContractService.sign`
 * in its order: the caller commands; is a party (`404` otherwise); is not a
 * member of both parties (`MEMBER_OF_BOTH_PARTIES`); its side has not signed
 * (`SIDE_ALREADY_SIGNED` — or "the same person again", which changes nothing);
 * the contractor holds `CONTRACTOR`; the contract is a `DRAFT`
 * (`CONTRACT_NOT_DRAFT`); the employer holds a role the signing policy in force
 * names (`SIGNATURE_POLICY_REQUIRED`, `INSUFFICIENT_ROLE`).
 */
export function signableSide(
  caller: ContractCaller,
  contract: CommandContract,
  authority: SigningAuthorityView,
): ContractSide | null {
  const acting = commandingOrganization(caller);
  if (acting === null) return null;
  const side = sideOf(contract, acting);
  if (side === null || memberOfBothParties(caller, contract)) return null;
  const signedAt = side === 'EMPLOYER' ? contract.employerSignedAt : contract.contractorSignedAt;
  if (signedAt !== null || contract.status !== 'DRAFT') return null;
  return maySignFor(caller, side, authority) ? side : null;
}

/**
 * Whether the cancel form is drawn — `ContractService.cancel`: the caller
 * commands; is the employer (`assertMayCancel`) with a role
 * `CONTRACT_CANCEL_ROLES` names; the contract is a `DRAFT`; and no side has
 * signed it unless `CONTRACT_CANCEL_AFTER_SIGNATURE` (`SIGNATURE_RECORDED`).
 */
export function canCancelContract(
  caller: ContractCaller,
  contract: CommandContract,
  env: RoleEnv = webServerEnv(),
): boolean {
  const acting = commandingOrganization(caller);
  if (acting === null || sideOf(contract, acting) !== 'EMPLOYER') return false;
  if (!holdsAny(caller, env.WEB_CONTRACT_CANCEL_ROLES) || contract.status !== 'DRAFT') return false;
  const signed = contract.employerSignedAt !== null || contract.contractorSignedAt !== null;
  return !signed || env.WEB_CONTRACT_CANCEL_AFTER_SIGNATURE;
}

/**
 * Whether the proposal form is drawn — `AmendmentService.propose`: the caller
 * commands; is the employer (`PROPOSER_NOT_EMPLOYER`) with a role
 * `CONTRACT_AMENDMENT_ROLES` names; the contract is `SIGNED`
 * (`CONTRACT_NOT_SIGNED`).
 */
export function canProposeAmendment(
  caller: ContractCaller,
  contract: CommandContract,
  env: RoleEnv = webServerEnv(),
): boolean {
  const acting = commandingOrganization(caller);
  return (
    acting !== null &&
    sideOf(contract, acting) === 'EMPLOYER' &&
    holdsAny(caller, env.WEB_CONTRACT_AMENDMENT_ROLES) &&
    contract.status === 'SIGNED'
  );
}

/**
 * The side this caller may sign `amendment` for, or null — `AmendmentService.sign`
 * in its order: the caller commands; is a party; is not a member of both
 * parties; its side has not signed the amendment; the contractor holds
 * `CONTRACTOR`; the amendment is `PROPOSED` (`AMENDMENT_NOT_PROPOSED`); the
 * contract is `SIGNED`; the employer holds a role the signing policy in force
 * names — the same machinery as the contract's own signature.
 */
export function amendmentSignableSide(
  caller: ContractCaller,
  contract: CommandContract,
  amendment: Pick<Amendment, 'status' | 'employerSignedAt' | 'contractorSignedAt'>,
  authority: SigningAuthorityView,
): ContractSide | null {
  const acting = commandingOrganization(caller);
  if (acting === null) return null;
  const side = sideOf(contract, acting);
  if (side === null || memberOfBothParties(caller, contract)) return null;
  const signedAt = side === 'EMPLOYER' ? amendment.employerSignedAt : amendment.contractorSignedAt;
  if (signedAt !== null || amendment.status !== 'PROPOSED' || contract.status !== 'SIGNED') {
    return null;
  }
  return maySignFor(caller, side, authority) ? side : null;
}

/**
 * Whether the plan form is drawn — `MilestoneService.plan`: the caller
 * commands; is the employer (`EDITOR_NOT_EMPLOYER`) with a role
 * `CONTRACT_MILESTONE_ROLES` names; the contract is `SIGNED`.
 */
export function canPlanMilestone(
  caller: ContractCaller,
  contract: CommandContract,
  env: RoleEnv = webServerEnv(),
): boolean {
  const acting = commandingOrganization(caller);
  return (
    acting !== null &&
    sideOf(contract, acting) === 'EMPLOYER' &&
    holdsAny(caller, env.WEB_CONTRACT_MILESTONE_ROLES) &&
    contract.status === 'SIGNED'
  );
}

/**
 * Whether `milestone`'s change form is drawn — `MilestoneService.change`: as
 * planning, and no statement refers to it (`MILESTONE_REFERENCED`).
 */
export function canChangeMilestone(
  caller: ContractCaller,
  contract: CommandContract,
  milestone: Pick<Milestone, 'referenced'>,
  env: RoleEnv = webServerEnv(),
): boolean {
  return canPlanMilestone(caller, contract, env) && !milestone.referenced;
}

/** Whether a signature might be offered at all — the policy is read only then. */
export function mightSignAsEmployer(caller: ContractCaller, contract: CommandContract): boolean {
  const acting = commandingOrganization(caller);
  return (
    acting !== null &&
    sideOf(contract, acting) === 'EMPLOYER' &&
    !memberOfBothParties(caller, contract)
  );
}

// -- the requests ----------------------------------------------------------------------

/** What the stamp binds a request to (`server/contract-command-replay.ts`). */
export interface CommandBinding {
  readonly command: ContractCommand;
  readonly subjectId: string | null;
  readonly expectedVersion: number | null;
  readonly side: ContractSide | null;
}

export interface CommandRequest {
  readonly method: 'POST' | 'PATCH';
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
}

const contractPath = (contractId: string): string =>
  `/v1/contracts/${encodeURIComponent(contractId)}`;

/**
 * The request a command sends: its route, and its body from the stamp's
 * binding and what was typed — or null when the two cannot make one (a
 * signature without a side, a change without its milestone, a typed body of
 * another command). Nothing in it comes from the browser but the typed input.
 */
export function commandRequest(
  contractId: string,
  binding: CommandBinding,
  input: CommandInput,
): CommandRequest | null {
  const { command, subjectId, expectedVersion, side } = binding;
  const base = contractPath(contractId);
  const versioned = expectedVersion === null ? null : { expectedVersion };
  switch (command) {
    case 'SIGN':
      if (side === null || versioned === null || subjectId !== null || input !== null) return null;
      return { method: 'POST', path: `${base}/sign`, body: versioned };
    case 'CANCEL': {
      if (versioned === null || subjectId !== null || input === null || side !== null) return null;
      const cancel = input as CancelInput;
      if (typeof cancel.reasonCode !== 'string' || 'deltaMinor' in input || 'title' in input) {
        return null;
      }
      return {
        method: 'POST',
        path: `${base}/cancel`,
        body: {
          reasonCode: cancel.reasonCode,
          ...(cancel.note !== undefined ? { note: cancel.note } : {}),
          ...versioned,
        },
      };
    }
    case 'PROPOSE_AMENDMENT': {
      if (versioned === null || subjectId !== null || input === null || side !== null) return null;
      if (!('deltaMinor' in input)) return null;
      const amendment = input as AmendmentInput;
      return {
        method: 'POST',
        path: `${base}/amendments`,
        body: {
          deltaMinor: amendment.deltaMinor,
          reasonCode: amendment.reasonCode,
          reasonText: amendment.reasonText,
          ...versioned,
        },
      };
    }
    case 'SIGN_AMENDMENT':
      if (side === null || versioned === null || subjectId === null || input !== null) return null;
      return {
        method: 'POST',
        path: `${base}/amendments/${encodeURIComponent(subjectId)}/sign`,
        body: versioned,
      };
    case 'PLAN_MILESTONE': {
      // The DTO takes no version: a new milestone has none to compare.
      if (expectedVersion !== null || subjectId !== null || input === null || side !== null) {
        return null;
      }
      if (!('plannedDate' in input)) return null;
      const milestone = input as MilestoneInput;
      return {
        method: 'POST',
        path: `${base}/milestones`,
        body: {
          title: milestone.title,
          plannedDate: milestone.plannedDate,
          ...(milestone.plannedShareBp !== null
            ? { plannedShareBp: milestone.plannedShareBp }
            : {}),
        },
      };
    }
    case 'CHANGE_MILESTONE': {
      if (versioned === null || subjectId === null || input === null || side !== null) return null;
      if (!('plannedDate' in input)) return null;
      const milestone = input as MilestoneInput;
      return {
        method: 'PATCH',
        path: `${base}/milestones/${encodeURIComponent(subjectId)}`,
        // Every field, as the form showed it: one that did not change changes nothing.
        body: {
          title: milestone.title,
          plannedDate: milestone.plannedDate,
          plannedShareBp: milestone.plannedShareBp,
          ...versioned,
        },
      };
    }
  }
}

// -- the commands ----------------------------------------------------------------------

/** A refusal said by its closed reason, then its platform code, then one fixed sentence. */
export const CONTRACT_FIELD_MAPPING: FieldMapping<ContractField> = {
  paths: Object.fromEntries(CONTRACT_FIELDS.map((field) => [field, field])) as Record<
    string,
    ContractField
  >,
  byDetailCode: CONTRACT_REFUSAL_TEXT,
  byCode: CONTRACT_CODE_TEXT,
  fallback: CONTRACT_REFUSAL_FALLBACK,
};

function signedFor(
  answer: Pick<ContractDetail, 'employerSignedAt' | 'contractorSignedAt'>,
  side: ContractSide | null,
): boolean {
  if (side === 'EMPLOYER') return answer.employerSignedAt !== null;
  if (side === 'CONTRACTOR') return answer.contractorSignedAt !== null;
  return false;
}

function sameMilestone(answer: Milestone, input: MilestoneInput): boolean {
  return (
    answer.title === input.title &&
    answer.plannedDate.slice(0, 10) === input.plannedDate &&
    answer.plannedShareBp === input.plannedShareBp
  );
}

/** The answer each command must show to be confirmed; anything else is unconfirmed. */
function answerSchema(contractId: string, binding: CommandBinding, input: CommandInput) {
  const { command, subjectId, side } = binding;
  switch (command) {
    case 'SIGN':
      return CONTRACT_DETAIL_SCHEMA.refine(
        (answer) => answer.id === contractId && signedFor(answer, side),
      );
    case 'CANCEL':
      return CONTRACT_DETAIL_SCHEMA.refine(
        (answer) =>
          answer.id === contractId &&
          answer.status === 'CANCELLED' &&
          answer.cancelReasonCode === (input as CancelInput | null)?.reasonCode,
      );
    case 'PROPOSE_AMENDMENT':
      return AMENDMENT_SCHEMA.refine((answer) => {
        const sent = input as AmendmentInput | null;
        return (
          sent !== null &&
          answer.contractId === contractId &&
          answer.deltaMinor === sent.deltaMinor &&
          answer.reasonCode === sent.reasonCode &&
          answer.reasonText === sent.reasonText
        );
      });
    case 'SIGN_AMENDMENT':
      return AMENDMENT_SCHEMA.refine(
        (answer) =>
          answer.contractId === contractId && answer.id === subjectId && signedFor(answer, side),
      );
    case 'PLAN_MILESTONE':
    case 'CHANGE_MILESTONE':
      return MILESTONE_SCHEMA.refine((answer) => {
        const sent = input as MilestoneInput | null;
        return (
          sent !== null &&
          answer.contractId === contractId &&
          (command === 'PLAN_MILESTONE' || answer.id === subjectId) &&
          sameMilestone(answer, sent)
        );
      });
  }
}

export type ContractCommandResult = Exclude<
  WriteResult<{ readonly id: string }, ContractField>,
  { kind: 'UNAVAILABLE' }
>;

/**
 * Sends the command. Every `UNAVAILABLE` — a 5xx, a status with no problem
 * body — is unconfirmed, as for every write.
 */
export async function issueContractCommand(
  session: WebSession,
  request: CommandRequest,
  contractId: string,
  binding: CommandBinding,
  input: CommandInput,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<ContractCommandResult> {
  const result = await writeThroughGateway(session, {
    method: request.method,
    path: request.path,
    body: request.body,
    submissionId,
    schema: answerSchema(contractId, binding, input),
    mapping: CONTRACT_FIELD_MAPPING,
    fetchImpl,
  });
  if (result.kind === 'UNAVAILABLE') {
    return { kind: 'UNKNOWN_OUTCOME', correlationId: result.correlationId };
  }
  return result;
}
