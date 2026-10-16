import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePlatformUserId, zodPipe } from '@rasta/nest-common';
import type { CursorPage } from '../contract/dto';
import { IdempotencyStore, requiredIdempotencyKey } from '../shared/idempotency';
import {
  draftStatementSchema,
  listStatementsQuerySchema,
  type DraftStatementDto,
  type ListStatementsQuery,
  type StatementView,
} from './dto';
import { StatementService } from './statement.service';

/** The route template the idempotency store keys on: a closed set, never an id. */
export const DRAFT_STATEMENT_ENDPOINT = 'POST /v1/contracts/{id}/statements';

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
  'is recorded (CONTRACT_AUTHORITY_REFUSED, action DRAFT_STATEMENT); when that record cannot be ' +
  'written the answer is 503 and nothing was done. A contract of another organization, or one ' +
  'that does not exist, is 404 — never 403. Refusals carry their closed reason in ' +
  '`details[].code` (docs/06 § 6.7).';

/**
 * The statement API of a contract (ADR-068 § 5, CON-003 PR 4). HTTP ↔ DTO and nothing else
 * (AGENTS.md A-10); no handler names a role. A statement is drafted and read here; its submission
 * comes with the approval chains and their snapshot at submission (ADR-068 § 5, the next change).
 */
@ApiTags('statements')
@Controller({ path: 'contracts/:id/statements', version: '1' })
export class StatementController {
  constructor(
    private readonly statements: StatementService,
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
    description: `One statement of the contract. ${PARTIES_NOTE}`,
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
      'not a rule the employer keeps in force is 422 `DEDUCTION_NOT_CONFIGURED` (Q-96 (6)); ' +
      'deductions past the gross are 422 `STATEMENT_NET_NEGATIVE`, a gross past the largest bigint ' +
      '422 `STATEMENT_EXCEEDS_LIMIT`. What a statement says never changes once drafted, and it ' +
      'stays a DRAFT: submission opens with the approval chains (ADR-068 § 5). ' +
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
}
