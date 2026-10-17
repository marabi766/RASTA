import { z } from 'zod';

import type { StatementLineRequest } from '@/lib/statement-draft';
import {
  STATEMENT_CODE_TEXT,
  STATEMENT_REFUSAL_FALLBACK,
  STATEMENT_REFUSAL_TEXT,
  lineField,
  type StatementChain,
  type StatementCommand,
  type StatementStepCommand,
} from '@/lib/statement-fields';

import { callGateway, GatewayRequestError } from './gateway';
import { webServerEnv } from './env';
import { utcInstant } from './instant';
import { tokenAuthority, tokenPerson } from './realm-roles';
import type { WebSession } from './session';
import type { ReadResult } from './assets';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';

/**
 * A contract's statements, read and commanded through the gateway (EXP-004,
 * ADR-068 § 5; contract-service CON-003 PRs 4 to 6).
 *
 * ## Who reads
 *
 * contract-service decides. The list is read by the contract's two parties
 * (the employer's configured reader roles and the winning contractor's
 * `CONTRACTOR`); one statement also by an organization a step of its approval
 * chains names, acting with that step's role — **that statement only**, never
 * the contract or its other statements. Everyone else, a statement that does
 * not exist and one of somebody else's contract are all `404`, never `403`,
 * and are rendered as the same absence (S-03).
 *
 * ## Money
 *
 * `grossMinor`, `deductionsMinor`, `netMinor` and every line's and
 * deduction's `amountMinor` stay decimal strings end to end and are only ever
 * formatted, never converted to `number` (CLAUDE.md, ADR-022). The service
 * computes the gross, each deduction and the net once; nothing here adds them.
 *
 * ## Who may command — a copy of contract-service, never a rule of our own
 *
 * The statement view carries no per-caller list of what the caller may do
 * (unlike `OrderView.availableActions`), so the three eligibility helpers below
 * mirror the service's own checks exactly, from the token the service decides
 * on (`tokenAuthority`, `tokenPerson`), and are pinned to its source by
 * `contract-statements.contract.spec.ts`. They choose what to draw; the service
 * decides again on every request. What the view cannot tell — whether this
 * person submitted the statement or decided an earlier step of it (separation
 * of duties, Q-96 (3)): the view never names a person — is left to the
 * service, whose refusal the form says in fixed words.
 */

const minorUnits = z.string().regex(/^\d+$/, 'amount must be whole, non-negative minor units');

const stepSchema = z.object({
  stepOrder: z.number().int(),
  authorityOrganizationId: z.string(),
  authorityRole: z.string(),
  authorityLabel: z.string(),
  decision: z
    .object({
      outcome: z.enum(['APPROVED', 'REJECTED']),
      decidedAt: utcInstant,
    })
    .nullable(),
});

const chainSchema = z.object({
  policyId: z.string(),
  policyVersion: z.number().int(),
  steps: z.array(stepSchema),
});

/** A statement as contract-service's `statementViewSchema` sends it; nothing else is kept. */
export const STATEMENT_SCHEMA = z.object({
  id: z.string(),
  contractId: z.string(),
  organizationId: z.string(),
  contractorOrganizationId: z.string(),
  statementNumber: z.number().int(),
  status: z.string(),
  grossMinor: minorUnits,
  deductionsMinor: minorUnits,
  netMinor: minorUnits,
  lines: z.array(
    z.object({
      lineNumber: z.number().int(),
      description: z.string(),
      amountMinor: minorUnits,
      milestoneId: z.string().nullable(),
    }),
  ),
  deductions: z.array(
    z.object({
      deductionRuleId: z.string(),
      name: z.string(),
      rateBp: z.number().int(),
      base: z.string(),
      amountMinor: minorUnits,
    }),
  ),
  createdAt: utcInstant,
  submittedAt: utcInstant.nullable(),
  approvalChains: z.object({ technical: chainSchema, financial: chainSchema }).nullable(),
  updatedAt: utcInstant,
  version: z.number().int(),
});

export type Statement = z.infer<typeof STATEMENT_SCHEMA>;
export type StatementStep = z.infer<typeof stepSchema>;

const statementPageSchema = z.object({
  items: z.array(STATEMENT_SCHEMA),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export type StatementPage = z.infer<typeof statementPageSchema>;

export const STATEMENTS_PER_PAGE = 20;

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
      // Another organization's statement, or one that does not exist: 404 for
      // both, rendered as the same absence.
      if (error.status === 404) return { kind: 'NOT_FOUND' };
      return { kind: 'UNAVAILABLE', status: error.status, correlationId: error.correlationId };
    }
    throw error;
  }
}

const statementsPath = (contractId: string): string =>
  `/v1/contracts/${encodeURIComponent(contractId)}/statements`;

/** A contract's statements, oldest first (the service orders by `statementNumber`). */
export function fetchStatements(
  session: WebSession,
  contractId: string,
  cursor?: string,
): Promise<ReadResult<StatementPage>> {
  const search = new URLSearchParams({ limit: String(STATEMENTS_PER_PAGE) });
  if (cursor) search.set('cursor', cursor);
  return read(session, `${statementsPath(contractId)}?${search.toString()}`, statementPageSchema);
}

export function fetchStatement(
  session: WebSession,
  contractId: string,
  statementId: string,
): Promise<ReadResult<Statement>> {
  return read(
    session,
    `${statementsPath(contractId)}/${encodeURIComponent(statementId)}`,
    STATEMENT_SCHEMA,
  );
}

// -- who may command -------------------------------------------------------------------

/** contract-service `access.ts`: `SUPER_ROLE`, `CONTRACTOR_ROLE` and the oversight role. */
export const PLATFORM_ADMINISTRATOR = 'SYSTEM_ADMIN';
export const CONTRACTOR_ROLE = 'CONTRACTOR';
export const OVERSIGHT_ROLE = 'AUDITOR';

/**
 * The request context the service decides a statement command on, as the
 * token carries it: the organization the request resolves to (`org_id`), the
 * roles held there plus the global realm roles, the memberships (`org_ids`)
 * and whether it names a platform user. Null fields: not readable — nothing
 * is offered.
 */
export interface StatementCaller {
  readonly organizationId: string | null;
  readonly roles: readonly string[] | null;
  readonly memberships: readonly string[];
  readonly platformUser: boolean;
}

export function statementCallerOf(accessToken: string): StatementCaller {
  const authority = tokenAuthority(accessToken);
  const person = tokenPerson(accessToken);
  return {
    organizationId: authority?.organizationId ?? null,
    roles: authority?.roles ?? null,
    memberships: person?.memberships ?? [],
    platformUser: person?.platformUser ?? false,
  };
}

/**
 * `assertCanCommandStatements` / `assertCanDecideStatements`, and the route's
 * `@RequirePlatformUserId`: a signed-in person with a platform user id, acting
 * for an organization, who is neither the oversight role (refused by
 * `RolesGuard` too — no statement route names it) nor the platform
 * administrator (refused outright: it never drafts, submits or decides for a
 * party). The organization acted for, or null.
 */
function commandingOrganization(caller: StatementCaller): string | null {
  const { roles, organizationId } = caller;
  if (roles === null || organizationId === null || !caller.platformUser) return null;
  if (roles.includes(OVERSIGHT_ROLE) || roles.includes(PLATFORM_ADMINISTRATOR)) return null;
  return organizationId;
}

/** The contract facts a command's eligibility reads. */
export interface StatementContract {
  readonly organizationId: string;
  readonly contractorOrganizationId: string;
  readonly status: string;
}

/**
 * `contractorsContract` + `assertSigned`: the caller acts for the contract's
 * contractor side (`sideOf` — the employer is refused `AUTHOR_NOT_CONTRACTOR`)
 * with the `CONTRACTOR` role, on a `SIGNED` contract.
 */
function contractorMayCommand(caller: StatementCaller, contract: StatementContract): boolean {
  const acting = commandingOrganization(caller);
  if (acting === null) return false;
  const contractorSide =
    contract.organizationId !== acting && contract.contractorOrganizationId === acting;
  return (
    contractorSide && (caller.roles ?? []).includes(CONTRACTOR_ROLE) && contract.status === 'SIGNED'
  );
}

/** Whether the draft form is drawn: the contractor, on a signed contract. */
export function canDraftStatement(caller: StatementCaller, contract: StatementContract): boolean {
  return contractorMayCommand(caller, contract);
}

/** Whether the submit form is drawn: the contractor, on a signed contract, for a `DRAFT`. */
export function canSubmitStatement(
  caller: StatementCaller,
  contract: StatementContract,
  statement: Pick<Statement, 'status'>,
): boolean {
  return contractorMayCommand(caller, contract) && statement.status === 'DRAFT';
}

/** `openChain`: the chain a status leaves open, or none. */
export function openChain(status: string): StatementChain | null {
  if (status === 'SUBMITTED') return 'TECHNICAL';
  if (status === 'TECHNICALLY_APPROVED') return 'FINANCIAL';
  return null;
}

export interface DecidableStep {
  readonly chain: StatementChain;
  readonly stepOrder: number;
  readonly step: StatementStep;
}

/** The next undecided step of the open chain, in step order — the one `judgeStep` admits. */
export function nextStep(
  statement: Pick<Statement, 'status' | 'approvalChains'>,
): DecidableStep | null {
  const chain = openChain(statement.status);
  if (chain === null || statement.approvalChains === null) return null;
  const steps = (
    chain === 'TECHNICAL' ? statement.approvalChains.technical : statement.approvalChains.financial
  ).steps;
  const next = steps
    .filter((step) => step.decision === null)
    .sort((a, b) => a.stepOrder - b.stepOrder)[0];
  return next ? { chain, stepOrder: next.stepOrder, step: next } : null;
}

/**
 * The step this caller may decide on this statement, or null — the
 * `StatementDecisionService.decide` checks the view can show, in its order:
 *
 * 1. the caller commands at all (`assertCanDecideStatements`, platform user);
 * 2. it is a party or an organization the chains name, else `404`;
 * 3. acting for anyone but the contractor, it is not also a member of the
 *    contractor's organization (`MEMBER_OF_CONTRACTOR`);
 * 4. the contract is `SIGNED`, when the caller can read the contract — an
 *    approver who is not a party cannot, and then the service alone checks it;
 * 5. the step is the open chain's next (`judgeStep`);
 * 6. its authority is the organization acted for (`NOT_STEP_AUTHORITY`) and
 *    the caller holds its role, exactly (`holdsRole` — no override).
 *
 * Not checkable here, and left to the service: whether this person submitted
 * the statement or decided a step of it already (`SUBMITTER_MAY_NOT_DECIDE`,
 * `ALREADY_DECIDED_STATEMENT`) — the view never names a person.
 */
export function decidableStepFor(
  caller: StatementCaller,
  statement: Pick<
    Statement,
    'status' | 'approvalChains' | 'organizationId' | 'contractorOrganizationId'
  >,
  contract: StatementContract | null,
): DecidableStep | null {
  const acting = commandingOrganization(caller);
  if (acting === null) return null;
  const party =
    statement.organizationId === acting || statement.contractorOrganizationId === acting;
  const chains = statement.approvalChains;
  const named =
    chains !== null &&
    [...chains.technical.steps, ...chains.financial.steps].some(
      (step) => step.authorityOrganizationId === acting,
    );
  if (!party && !named) return null;
  const contractorSide =
    statement.organizationId !== acting && statement.contractorOrganizationId === acting;
  if (!contractorSide && caller.memberships.includes(statement.contractorOrganizationId)) {
    return null;
  }
  if (contract !== null && contract.status !== 'SIGNED') return null;
  const next = nextStep(statement);
  if (next === null) return null;
  if (next.step.authorityOrganizationId !== acting) return null;
  if (!(caller.roles ?? []).includes(next.step.authorityRole)) return null;
  return next;
}

// -- the requests ----------------------------------------------------------------------

/**
 * What a submit or decision sends, built from the replay stamp the page
 * signed — the statement, the step and the version it showed — and nothing the
 * browser posts, so every send under one key is the same body.
 */
export interface StepBinding {
  readonly command: StatementStepCommand;
  readonly expectedVersion: number;
  readonly chain: StatementChain | null;
  readonly stepOrder: number | null;
}

export type StepRequestBody =
  | { readonly expectedVersion: number }
  | {
      readonly chain: StatementChain;
      readonly stepOrder: number;
      readonly decision: 'APPROVE' | 'REJECT';
      readonly expectedVersion: number;
    };

/** The body of a step command, or null when the binding cannot carry one. */
export function stepRequestBody(binding: StepBinding): StepRequestBody | null {
  if (binding.command === 'SUBMIT') {
    return binding.chain === null && binding.stepOrder === null
      ? { expectedVersion: binding.expectedVersion }
      : null;
  }
  if (binding.chain === null || binding.stepOrder === null) return null;
  return {
    chain: binding.chain,
    stepOrder: binding.stepOrder,
    decision: binding.command,
    expectedVersion: binding.expectedVersion,
  };
}

// -- the commands ----------------------------------------------------------------------

/**
 * How a refusal is said: by its closed reason, then its platform code, then
 * one fixed sentence — the service's own words never reach the page.
 */
export function statementFieldMapping(rows: readonly number[] = []): FieldMapping<string> {
  const paths: Record<string, string> = {};
  rows.forEach((row, index) => {
    paths[`lines.${index}.description`] = lineField(row, 'description');
    paths[`lines.${index}.amountMinor`] = lineField(row, 'amount');
    paths[`lines.${index}.milestoneId`] = lineField(row, 'milestoneId');
  });
  return {
    paths,
    byDetailCode: STATEMENT_REFUSAL_TEXT,
    byCode: STATEMENT_CODE_TEXT,
    fallback: STATEMENT_REFUSAL_FALLBACK,
  };
}

/** The answer each command must show to be confirmed; anything else is unconfirmed. */
function answerSchema(
  contractId: string,
  command: StatementCommand,
  statementId: string | null,
  step: { chain: StatementChain; stepOrder: number } | null,
) {
  return STATEMENT_SCHEMA.refine((answer) => {
    if (answer.contractId !== contractId) return false;
    if (command === 'DRAFT') return answer.status === 'DRAFT';
    if (answer.id !== statementId) return false;
    if (command === 'SUBMIT') return answer.status === 'SUBMITTED';
    if (step === null || answer.approvalChains === null) return false;
    const chain =
      step.chain === 'TECHNICAL'
        ? answer.approvalChains.technical
        : answer.approvalChains.financial;
    const decided = chain.steps.find((candidate) => candidate.stepOrder === step.stepOrder);
    const outcome = command === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    return decided?.decision?.outcome === outcome;
  });
}

export type StatementCommandResult = Exclude<
  WriteResult<Statement, string>,
  { kind: 'UNAVAILABLE' }
>;

/** Every `UNAVAILABLE` — a 5xx, a status with no problem body — is unconfirmed, as for every write. */
function confirmedOrUnknown(result: WriteResult<Statement, string>): StatementCommandResult {
  if (result.kind === 'UNAVAILABLE') {
    return { kind: 'UNKNOWN_OUTCOME', correlationId: result.correlationId };
  }
  return result;
}

/** `POST /v1/contracts/{id}/statements` with the parsed lines and no deduction. */
export async function issueDraftStatement(
  session: WebSession,
  contractId: string,
  lines: readonly StatementLineRequest[],
  rows: readonly number[],
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<StatementCommandResult> {
  return confirmedOrUnknown(
    await writeThroughGateway(session, {
      path: statementsPath(contractId),
      body: { lines },
      submissionId,
      schema: answerSchema(contractId, 'DRAFT', null, null),
      mapping: statementFieldMapping(rows),
      fetchImpl,
    }),
  );
}

const STEP_PATHS: Readonly<Record<StatementStepCommand, string>> = {
  SUBMIT: 'submit',
  APPROVE: 'decisions',
  REJECT: 'decisions',
};

/** `…/submit` or `…/decisions`, with the body the stamp binds. */
export async function issueStepCommand(
  session: WebSession,
  contractId: string,
  statementId: string,
  command: StatementStepCommand,
  body: StepRequestBody,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<StatementCommandResult> {
  const step = 'chain' in body ? { chain: body.chain, stepOrder: body.stepOrder } : null;
  return confirmedOrUnknown(
    await writeThroughGateway(session, {
      path: `${statementsPath(contractId)}/${encodeURIComponent(statementId)}/${STEP_PATHS[command]}`,
      body,
      submissionId,
      schema: answerSchema(contractId, command, statementId, step),
      mapping: statementFieldMapping(),
      fetchImpl,
    }),
  );
}

/** Exposed so a test can prove every command has a path. */
export const STATEMENT_STEP_PATHS = STEP_PATHS;
