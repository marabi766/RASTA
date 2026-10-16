import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowService } from '@rasta/nest-common';
import type { StatementSettlementView } from './dto';
import { SETTLEMENT_READ_CALLER, StatementSettlementService } from './settlement-fact';

/** The route template, for the documentation: a closed set, never an id. */
export const STATEMENT_SETTLEMENT_READ_ENDPOINT = 'GET /v1/internal/statements/{id}';

/**
 * The internal source-of-truth read of a statement (ADR-068 § 6 (2), ADR-061 § 4). See
 * `settlement-fact.ts`. HTTP ↔ DTO only (AGENTS.md A-10).
 */
@ApiTags('contract-internal')
@Controller({ path: 'internal/statements', version: '1' })
export class InternalStatementController {
  constructor(private readonly settlement: StatementSettlementService) {}

  @Get(':id')
  @AllowService(SETTLEMENT_READ_CALLER)
  @ApiOperation({
    summary: 'State a statement as its owner records it, for settlement (internal)',
    description:
      'Reserved for `economic-service`’s service token, signed for the **employer** — the ' +
      'statement’s own organization; every other service and every user token is 403, and so ' +
      'is a token signed for no organization. A statement of any other organization (the ' +
      'contractor’s included) answers 404, exactly as one that does not exist. Returns the ' +
      'stored row, whatever its status: the status, the net (a decimal string of minor units) ' +
      'and its currency, the payer (the employer) and the beneficiary (the winning contractor), ' +
      'and when the financial chain approved it. The reader builds its obligation from this ' +
      'answer — never from STATEMENT_APPROVED, which carries no amount (Q-97 (2)) — and must ' +
      'refuse a statement that is not APPROVED. Nothing is written.',
  })
  get(@Param('id') id: string): Promise<StatementSettlementView> {
    return this.settlement.statementFact(id);
  }
}
