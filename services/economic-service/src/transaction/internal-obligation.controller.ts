import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowService } from '@rasta/nest-common';
import {
  STATEMENT_OBLIGATION_READ_CALLER,
  StatementObligationService,
  type StatementObligationView,
} from './statement-obligation';

/** The route template, for the documentation: a closed set, never an id. */
export const STATEMENT_OBLIGATION_READ_ENDPOINT =
  'GET /v1/internal/obligations/by-source/STATEMENT/{statementId}';

/**
 * The internal source-of-truth read of a contract statement's obligation
 * (ADR-068 § 6 (3), ADR-061 § 4). See `statement-obligation.ts`. HTTP ↔ DTO
 * only (AGENTS.md A-10).
 *
 * `STATEMENT` is a literal segment, not a parameter: one source type, one
 * reader. Another owner that needs the same question asked of its own source
 * gets its own route and its own caller.
 */
@ApiTags('economic-internal')
@Controller({ path: 'internal/obligations', version: '1' })
export class InternalObligationController {
  constructor(private readonly obligations: StatementObligationService) {}

  @Get('by-source/STATEMENT/:statementId')
  @AllowService(STATEMENT_OBLIGATION_READ_CALLER)
  @ApiOperation({
    summary: 'State a contract statement’s obligation as economic-service records it (internal)',
    description:
      'Reserved for `contract-service`’s service token, sent in `X-Internal-Token` with no ' +
      '`Authorization` header and signed for the **payer** — the employer, the statement’s own ' +
      'organization; every other service and every user token is 403, and so is a token signed ' +
      'for no organization. The obligation of any other payer (the beneficiary’s view of what ' +
      'it is owed included) answers 404, exactly as a statement with no obligation. Returns the ' +
      'stored row, whatever its status: the obligation id, the statement id, the status, the ' +
      'amount the payer owes (the statement’s whole net, a decimal string of minor units) and its ' +
      'currency, the payer and the beneficiary, and — once settled — the settlement, when it ' +
      'settled and the amount it took. `fullySettled` is true only when that whole amount was ' +
      'settled; the reader marks the statement SETTLED on nothing else (ADR-068 § 6 (3), I5). ' +
      'Nothing is written.',
  })
  get(@Param('statementId') statementId: string): Promise<StatementObligationView> {
    return this.obligations.statementObligation(statementId);
  }
}
