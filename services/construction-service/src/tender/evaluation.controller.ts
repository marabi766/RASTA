import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditorSelfService, zodPipe } from '@rasta/nest-common';
import { EvaluationService } from './evaluation.service';
import {
  qualifyBidSchema,
  recuseSchema,
  scoreBidSchema,
  type QualifyBidDto,
  type RecuseDto,
  type ScoreBidDto,
} from './evaluation.dto';

const EVALUATOR_NOTE =
  'Owner side: the roles of CONSTRUCTION_TENDER_EVALUATE_ROLES, by default the tender owner’s role set ' +
  '(CONSTRUCTION_PROJECT_ROLES) — ADR-067 § 4. SYSTEM_ADMIN, AUDITOR and CONTRACTOR (each refused ' +
  'whenever present, whatever other role the user holds) and a service token are refused. The caller is ' +
  'judged on identity-service as of now (it cannot be reached: 502/504, nothing is done): a member of ' +
  'any organization that bid on the tender is refused 403 `CONFLICT_OF_INTEREST` before anything is ' +
  'said about the tender; with CONSTRUCTION_COI_RULES naming EVALUATOR_NOT_TENDER_AUTHOR, so is the ' +
  'user who created or published it (403 `EVALUATOR_IS_TENDER_AUTHOR`). The routes name no role at the ' +
  'guard: the service decides, **ownership first** — a tender that is missing, or not the caller’s ' +
  'organization’s, answers 404 (never 403) and is **not** logged — then the roles and the conflict rules. ' +
  'On the caller’s own tender every refusal is audited, whatever role the caller holds (AUDITOR and ' +
  'SYSTEM_ADMIN included): a REFUSED row in the bid access log with its closed code, and BID_ACCESSED, ' +
  'before the 403.';

/**
 * Why the evaluation routes let the oversight role past the global guard: the guard refuses an
 * AUDITOR on any handler that does not name it, **before** the service runs, which would leave no
 * audit row for the refusal. Here the service refuses it itself (`assertCanEvaluate`: never AUDITOR)
 * and audits the refusal on the caller's own tender; this grants the AUDITOR nothing.
 */
const REFUSED_AND_AUDITED_BY_THE_SERVICE =
  'the service refuses AUDITOR itself and audits the refusal on the owner’s own tender (ADR-067 § 4); no data is served';

/**
 * The owner's evaluators at work on the opened bids of a tender (ADR-067 § 2, § 4). HTTP ↔ DTO and
 * nothing else (AGENTS.md A-10).
 */
@ApiTags('evaluation')
@Controller({ version: '1' })
export class EvaluationController {
  constructor(private readonly evaluation: EvaluationService) {}

  @AuditorSelfService(REFUSED_AND_AUDITED_BY_THE_SERVICE)
  @Post('tenders/:id/bids/:bidId/qualification')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Qualify or disqualify an opened bid (OPENED → QUALIFIED | DISQUALIFIED)',
    description:
      'One decision per bid, final: the same decision again answers it with `alreadyDecided: true` and ' +
      'writes nothing, another is 422 `BID_ALREADY_DECIDED`. A disqualification needs a closed ' +
      '`reasonCode` and the reason in words (kept in the database, never on the event nor shown to the ' +
      'bidder). A qualification asks supplier-service for the contractor’s standing now (Q-85), outside ' +
      'any lock, failing closed: not eligible is 422 `BIDDER_NOT_ELIGIBLE` (disqualify it instead), ' +
      'unreachable is 503/504. Only while the tender is EVALUATING (422 `NOT_EVALUATING`) and only an ' +
      'OPENED bid (422 `BID_NOT_OPENED`); not for an evaluator who stood down from it (403 `RECUSED`). ' +
      'Publishes BID_QUALIFIED or BID_DISQUALIFIED in the same transaction. ' +
      EVALUATOR_NOTE,
  })
  async qualify(
    @Param('id') id: string,
    @Param('bidId') bidId: string,
    @Body(zodPipe(qualifyBidSchema)) dto: QualifyBidDto,
  ) {
    return this.evaluation.qualify(id, bidId, dto);
  }

  @AuditorSelfService(REFUSED_AND_AUDITED_BY_THE_SERVICE)
  @Post('tenders/:id/bids/:bidId/recusal')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Stand down from a bid (the caller, final)',
    description:
      'The caller takes no further part in this bid: their scores for it leave the matrix, they may not ' +
      'score or decide on it again, and their place is free for another evaluator. A closed ' +
      '`reasonCode`; no prose is kept. Standing down again answers the first with `alreadyRecused: ' +
      'true`. Only while the tender is EVALUATING, and from an OPENED or QUALIFIED bid (422 ' +
      '`BID_NOT_EVALUABLE`). Publishes BID_EVALUATOR_RECUSED. ' +
      EVALUATOR_NOTE,
  })
  async recuse(
    @Param('id') id: string,
    @Param('bidId') bidId: string,
    @Body(zodPipe(recuseSchema)) dto: RecuseDto,
  ) {
    return this.evaluation.recuse(id, bidId, dto);
  }

  @AuditorSelfService(REFUSED_AND_AUDITED_BY_THE_SERVICE)
  @Post('tenders/:id/bids/:bidId/scores')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Score a qualified bid against the tender’s frozen criteria',
    description:
      'Each score is an integer, the points × 100, from 0 to the criterion’s `maxScore` × 100 (a ' +
      'PASS_FAIL criterion: 0 or `maxScore` × 100; 422 `SCORE_OUT_OF_RANGE`); a criterion the tender ' +
      'does not have is 422 `UNKNOWN_CRITERION`. A cell is revised by appending: every score is a new ' +
      'revision and the earlier ones are kept; a score equal to the one standing writes nothing ' +
      '(`unchanged`). Only a QUALIFIED bid (422 `BID_NOT_QUALIFIED`), only while the tender is ' +
      'EVALUATING, and at most CONSTRUCTION_EVALUATION_MAX_EVALUATORS evaluators per bid (default 1; ' +
      '422 `EVALUATOR_LIMIT`). Publishes BID_SCORED (a count and a digest, never the scores). ' +
      EVALUATOR_NOTE,
  })
  async score(
    @Param('id') id: string,
    @Param('bidId') bidId: string,
    @Body(zodPipe(scoreBidSchema)) dto: ScoreBidDto,
  ) {
    return this.evaluation.score(id, bidId, dto);
  }

  @AuditorSelfService(REFUSED_AND_AUDITED_BY_THE_SERVICE)
  @Post('tenders/:id/evaluate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete the evaluation (EVALUATING → EVALUATED)',
    description:
      'Allowed when at least one bid is QUALIFIED, every QUALIFIED bid has been scored in full by at ' +
      'least CONSTRUCTION_EVALUATION_MIN_EVALUATORS evaluators (default 1) and no opened bid is left ' +
      'undecided: otherwise 422 `EVALUATION_INCOMPLETE`. No qualified bid is 422 `NO_QUALIFIED_BID` — ' +
      'the tender can then only be cancelled. The matrix is frozen from here on; BIDS_EVALUATED carries ' +
      'a count and a digest of it, no score and no winner. Completing again answers the same view with ' +
      '`alreadyEvaluated: true` and writes nothing. ' +
      EVALUATOR_NOTE,
  })
  async evaluate(@Param('id') id: string) {
    return this.evaluation.evaluate(id);
  }

  @AuditorSelfService(REFUSED_AND_AUDITED_BY_THE_SERVICE)
  @Get('tenders/:id/evaluation')
  @ApiOperation({
    summary: 'The evaluation matrix and the ranking',
    description:
      'Every bid with its decision, each evaluator’s cells (the latest revision) and totals, the ' +
      'evaluators who stood down, and the rank: 1 + the number of bids with a strictly higher mean ' +
      'total, equal bids sharing a rank — a tie makes no winner, and the first rank is not an award. ' +
      'Totals are `Σ weightBp × scoreScaled` as strings (bigint; nothing is rounded). Before the ' +
      'opening there is nothing to read: 422 `NOT_OPENED`. Each read is audited per bid ' +
      '(READ_EVALUATION). ' +
      EVALUATOR_NOTE,
  })
  async matrix(@Param('id') id: string) {
    return this.evaluation.getMatrix(id);
  }
}
