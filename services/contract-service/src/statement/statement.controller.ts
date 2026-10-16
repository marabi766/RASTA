import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePlatformUserId, zodPipe } from '@rasta/nest-common';
import type { CursorPage } from '../contract/dto';
import { IdempotencyStore, requiredIdempotencyKey } from '../shared/idempotency';
import {
  decideStatementSchema,
  draftStatementSchema,
  listStatementsQuerySchema,
  submitStatementSchema,
  type DecideStatementDto,
  type DraftStatementDto,
  type ListStatementsQuery,
  type StatementView,
  type SubmitStatementDto,
} from './dto';
import { StatementDecisionService } from './statement-decision.service';
import { StatementService } from './statement.service';

/** The route templates the idempotency store keys on: a closed set, never an id. */
export const DRAFT_STATEMENT_ENDPOINT = 'POST /v1/contracts/{id}/statements';
export const SUBMIT_STATEMENT_ENDPOINT = 'POST /v1/contracts/{id}/statements/{statementId}/submit';
export const DECIDE_STATEMENT_ENDPOINT =
  'POST /v1/contracts/{id}/statements/{statementId}/decisions';

const PARTIES_NOTE =
  'Closed by default (S-02). Read by the same two parties as the contract: the employer’s ' +
  'organization — the roles of CONTRACT_READER_ROLES, and SYSTEM_ADMIN acting for an organization ' +
  'it selected with X-Organization-Id — and the winning contractor’s organization (the CONTRACTOR ' +
  'role, in its own organization). Any other organization, a contract or statement that does not ' +
  'exist and one of someone else are all 404, never 403 (S-03). AUDITOR and a service token are refused.';

const COMMAND_NOTE =
  'Requires an `Idempotency-Key` (docs/06 § 6.8): without one, or with one outside 8 to 255 ' +
  'characters, 400 VALIDATION_FAILED and nothing is done. The same key with the same body from ' +
  'the same user answers the original response and does nothing again; the same key with ' +
  'another body or user is 409 IDEMPOTENCY_KEY_REUSED; a duplicate that arrives while the first ' +
  'is still being processed waits for its answer and past a few seconds is 409 CONFLICT with ' +
  'Retry-After. The caller must be a signed-in person with a platform user id (403 otherwise); ' +
  'the platform administrator, the oversight role and a service token are refused. Only the ' +
  'winning contractor, with the CONTRACTOR role; the employer is 403 `AUTHOR_NOT_CONTRACTOR`. A ' +
  'refusal of a party for want of authority — and of the platform administrator acting for one — ' +
  'is recorded (CONTRACT_AUTHORITY_REFUSED, action DRAFT_STATEMENT or SUBMIT_STATEMENT); when that ' +
  'record cannot be written the answer is 503 and nothing was done. A contract of another ' +
  'organization, or one that does not exist, is 404 — never 403. Refusals carry their closed ' +
  'reason in `details[].code` (docs/06 § 6.7).';

const DECISION_NOTE =
  'Requires an `Idempotency-Key` (docs/06 § 6.8), with the same replay rules as every command. ' +
  'The caller must be a signed-in person with a platform user id (403 otherwise); the platform ' +
  'administrator, the oversight role and a service token are refused. The caller acts for the ' +
  'organization the named step’s authority is and holds its role: another organization that is a ' +
  'party or is named by another step is 403 `NOT_STEP_AUTHORITY`, a person of that organization ' +
  'without the role 403 INSUFFICIENT_ROLE. Separation of duties (Q-96 (3)), on the stable identity ' +
  '(the token’s issuer and subject): a member of the contractor’s organization is 403 ' +
  '`MEMBER_OF_CONTRACTOR`; the person who submitted the statement is 422 ' +
  '`SUBMITTER_MAY_NOT_DECIDE`; a person who already decided a step of it, in either chain, is 422 ' +
  '`ALREADY_DECIDED_STATEMENT`; a pair that cannot be told apart is 422 `ACTOR_IDENTITY_UNKNOWN`. ' +
  'Each of these refusals is recorded (CONTRACT_AUTHORITY_REFUSED, action APPROVE_STATEMENT or ' +
  'REJECT_STATEMENT, side EMPLOYER, CONTRACTOR or APPROVER); when that record cannot be written ' +
  'the answer is 503 and nothing was done. Any organization that is neither a party nor named by ' +
  'the statement’s chains, and a statement or contract that does not exist, is 404 — never 403. ' +
  'Refusals carry their closed reason in `details[].code` (docs/06 § 6.7).';

/**
 * The statement API of a contract (ADR-068 § 5, CON-003 PR 4 to 6). HTTP ↔ DTO and nothing else
 * (AGENTS.md A-10); no handler names a role. A statement is drafted, submitted — with the snapshot
 * of both approval chains — decided step by step, and read here.
 */
@ApiTags('statements')
@Controller({ path: 'contracts/:id/statements', version: '1' })
export class StatementController {
  constructor(
    private readonly statements: StatementService,
    private readonly decisions: StatementDecisionService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List the statements of a contract, oldest first',
    description:
      'Every statement of the contract with its lines, its deductions and the gross, deductions ' +
      `and net in minor units as decimal strings; when it was submitted, never by whom. ${PARTIES_NOTE}`,
  })
  async list(
    @Param('id') id: string,
    @Query(zodPipe(listStatementsQuerySchema)) query: ListStatementsQuery,
  ): Promise<CursorPage<StatementView>> {
    return this.statements.list(id, query);
  }

  @Get(':statementId')
  @ApiOperation({
    summary: 'Read one statement',
    description:
      `One statement of the contract, each step of its approval chains with its decision. ${PARTIES_NOTE} ` +
      'Also read by an organization a step of its approval chains names, acting with that step’s ' +
      'role (CON-003 PR 6) — this statement only, never the contract or its other statements.',
  })
  async get(
    @Param('id') id: string,
    @Param('statementId') statementId: string,
  ): Promise<StatementView> {
    return this.statements.get(id, statementId);
  }

  @RequirePlatformUserId()
  @Post()
  @HttpCode(201)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 255 characters. Scoped to the organization.',
  })
  @ApiOperation({
    summary: 'Draft a statement of a signed contract, contractor only',
    description:
      'Lines (a description and a positive amount each) and, optionally, the deductions the ' +
      'employer has configured that it applies. The service numbers it (1, 2, 3 … per contract) ' +
      'and computes, once, the gross (the sum of the lines), each deduction (its configured rate ' +
      'of the gross, rounded half up) and the net (gross less deductions); none of these is taken ' +
      'from the request. Only on a SIGNED contract (422 `CONTRACT_NOT_SIGNED`); a deduction that is ' +
      'not a rule the employer keeps in force is 422 `DEDUCTION_NOT_CONFIGURED` (Q-96 (6)); a line ' +
      'against a milestone that is not one of this contract is 422 `MILESTONE_NOT_OF_CONTRACT`; ' +
      'deductions past the gross are 422 `STATEMENT_NET_NEGATIVE`, a gross past the largest bigint ' +
      '422 `STATEMENT_EXCEEDS_LIMIT`. What a statement says never changes once drafted. ' +
      `STATEMENT_DRAFTED carries identifiers and instants only — no amount. ${COMMAND_NOTE}`,
  })
  async draft(
    @Param('id') id: string,
    @Body(zodPipe(draftStatementSchema)) dto: DraftStatementDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<StatementView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const { result } = await this.idempotency.execute<StatementView>(
      DRAFT_STATEMENT_ENDPOINT,
      key,
      { id, ...dto },
      201,
      (fence) => this.statements.draft(id, dto, fence),
      (stored) => this.statements.assertContractVisible(stored.contractId),
    );
    return result;
  }

  @RequirePlatformUserId()
  @Post(':statementId/submit')
  @HttpCode(200)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 255 characters. Scoped to the organization.',
  })
  @ApiOperation({
    summary: 'Submit a draft statement for approval, contractor only',
    description:
      '`DRAFT → SUBMITTED`, with both approval chains snapshotted in the same transaction ' +
      '(ADR-068 § 5): each is the policy the employer has in force for ' +
      '`contract.statement.technical` and `contract.statement.financial`, reduced to the steps ' +
      'that apply to the statement’s gross (a step’s minAmountMinor inclusive, maxAmountMinor ' +
      'exclusive). A policy changed later never changes them. No policy in force is 422 ' +
      '`TECHNICAL_POLICY_REQUIRED` / `FINANCIAL_POLICY_REQUIRED`, no step that applies 422 ' +
      '`TECHNICAL_STEP_NOT_APPLICABLE` / `FINANCIAL_STEP_NOT_APPLICABLE`, a step that applies and ' +
      'names the contractor’s own organization 422 `APPROVAL_STEP_NAMES_CONTRACTOR` — the platform ' +
      'never approves by default. A union-written policy whose union organization-service no ' +
      'longer places above the employer is 422 `POLICY_AUTHOR_NOT_GOVERNING` (503/504 when it ' +
      'cannot answer: nothing is submitted); a policy put in force or retired at the same moment ' +
      'is 409 CONFLICT (retry). Records who submitted it with their stable identity (the token’s ' +
      'issuer and subject), which the approvals keep out of both chains (Q-96 (3)); a token without ' +
      'one is 422 `ACTOR_IDENTITY_UNKNOWN`. The milestones its lines refer to are marked referenced ' +
      'and can no longer be changed (Q-100 (4)). A statement that is not a draft is 422 ' +
      '`STATEMENT_NOT_DRAFT`, a contract that is not signed 422 `CONTRACT_NOT_SIGNED`; ' +
      '`expectedVersion` is optional. STATEMENT_SUBMITTED carries identifiers, versions and ' +
      `instants only — no amount (Q-97 (2)). ${COMMAND_NOTE}`,
  })
  async submit(
    @Param('id') id: string,
    @Param('statementId') statementId: string,
    @Body(zodPipe(submitStatementSchema)) dto: SubmitStatementDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<StatementView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const { result } = await this.idempotency.execute<StatementView>(
      SUBMIT_STATEMENT_ENDPOINT,
      key,
      { id, statementId, ...dto },
      200,
      (fence) => this.statements.submit(id, statementId, dto, fence),
      (stored) => this.statements.assertContractVisible(stored.contractId),
    );
    return result;
  }

  @RequirePlatformUserId()
  @Post(':statementId/decisions')
  @HttpCode(200)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 255 characters. Scoped to the organization.',
  })
  @ApiOperation({
    summary: 'Approve or reject a step of a submitted statement’s approval chain',
    description:
      'The step’s authority decides the named step (`chain`, `stepOrder`) of the chains snapshotted ' +
      'at submission (ADR-068 § 5): the technical chain while the statement is SUBMITTED, the ' +
      'financial one once it is TECHNICALLY_APPROVED (422 `CHAIN_NOT_OPEN`), each chain in its ' +
      'step order (422 `STEP_NOT_NEXT`). Approving the technical chain’s last step makes it ' +
      'TECHNICALLY_APPROVED; approving the financial chain’s last step makes it APPROVED — immutable ' +
      '— and adds its gross to the contract’s approved total, which never passes the price plus ' +
      'the effective amendments (422 `APPROVED_TOTAL_EXCEEDS_CAP`, nothing written; Q-96 (5)). A ' +
      'rejection at any step makes it REJECTED, final for its number (Q-96 (7)). A step decided ' +
      'already — by someone else, or at the same moment — is 409 `STEP_DECIDED`; a draft 422 ' +
      '`STATEMENT_NOT_SUBMITTED`; an approved or rejected statement 422 `STATEMENT_DECIDED`; a step ' +
      'its chains do not have 422 `STEP_NOT_IN_CHAIN`; a contract that is not signed 422 ' +
      '`CONTRACT_NOT_SIGNED`. No timer and no default: a step waits for its authority (ADR-043). ' +
      'STATEMENT_DECISION_RECORDED, and STATEMENT_TECHNICALLY_APPROVED, STATEMENT_APPROVED or ' +
      'STATEMENT_REJECTED with a transition, carry identifiers and instants only — no amount ' +
      `(Q-97 (2)); approval moves no money (ADR-068 § 6). ${DECISION_NOTE}`,
  })
  async decide(
    @Param('id') id: string,
    @Param('statementId') statementId: string,
    @Body(zodPipe(decideStatementSchema)) dto: DecideStatementDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<StatementView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const { result } = await this.idempotency.execute<StatementView>(
      DECIDE_STATEMENT_ENDPOINT,
      key,
      { id, statementId, ...dto },
      200,
      (fence) => this.decisions.decide(id, statementId, dto, fence),
      (stored) => this.statements.assertStatementVisible(stored.contractId, stored.id),
    );
    return result;
  }
}
