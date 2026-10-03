import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowService, AuditorSelfService, zodPipe } from '@rasta/nest-common';
import { AwardService } from './award.service';
import { awardTenderSchema, type AwardTenderDto } from './award.dto';

/** The one service that reads an award: it drafts the contract from it (CON-003; `TENDER_AWARDED` carries no amount). */
export const AWARD_READ_CALLER = 'contract-service';

const AWARDER_NOTE =
  'Owner side: the roles of CONSTRUCTION_TENDER_AWARD_ROLES, by default the tender owner’s role set ' +
  '(CONSTRUCTION_PROJECT_ROLES) — ADR-067 § 3. SYSTEM_ADMIN, AUDITOR and CONTRACTOR (each refused ' +
  'whenever present, whatever other role the user holds) and a service token are refused. The caller is ' +
  'judged on identity-service as of now (it cannot be reached: 502/504, nothing is done): a member of ' +
  'any organization that bid on the tender is refused 403 `CONFLICT_OF_INTEREST` before anything is ' +
  'said about the tender; with CONSTRUCTION_COI_RULES naming AWARDER_NOT_EVALUATOR, so is anyone who ' +
  'took part in the evaluation (403 `AWARDER_IS_EVALUATOR`; 422 `ACTOR_IDENTITY_UNKNOWN` when the ' +
  'records cannot show they are two people). The route names no role at the guard: the service ' +
  'decides, **ownership first** — a tender that is missing, or not the caller’s organization’s, ' +
  'answers 404 (never 403) and is **not** logged — then the roles and the conflict rules. On the ' +
  'caller’s own tender every refusal is audited (a REFUSED row in the bid access log with its closed ' +
  'code, and BID_ACCESSED).';

/**
 * Why the award route lets the oversight role past the global guard: the guard refuses an AUDITOR on
 * any handler that does not name it, **before** the service runs, which would leave no audit row for
 * the refusal. Here the service refuses it itself (`assertCanAward`: never AUDITOR) and audits the
 * refusal on the owner's own tender; this grants the AUDITOR nothing.
 */
const REFUSED_AND_AUDITED_BY_THE_SERVICE =
  'the service refuses AUDITOR itself and audits the refusal on the owner’s own tender (ADR-067 § 4); no data is served';

/**
 * The owner's person awarding an evaluated tender (ADR-067 § 3). HTTP ↔ DTO and nothing else
 * (AGENTS.md A-10).
 */
@ApiTags('award')
@Controller({ version: '1' })
export class AwardController {
  constructor(private readonly awards: AwardService) {}

  @AuditorSelfService(REFUSED_AND_AUDITED_BY_THE_SERVICE)
  @Post('tenders/:id/award')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Award an evaluated tender to one of its qualified bids (EVALUATED → AWARDED)',
    description:
      'A person chooses; the platform ranks and shows, it never picks (ADR-067 § 3). The body names ' +
      'a QUALIFIED bid of the tender (422 `BID_NOT_QUALIFIED`; 404 for a bid that is not the ' +
      'tender’s). Any choice but the single first rank of the frozen matrix — another rank, or a ' +
      'member of a tie — needs `justification` (422 `JUSTIFICATION_REQUIRED`). Only an EVALUATED ' +
      'tender (422 `NOT_EVALUATED`). The winner’s standing is asked of supplier-service **now**, ' +
      'authoritatively and failing closed: not eligible is 422 `WINNER_NOT_ELIGIBLE` (the tender ' +
      'stays EVALUATED and the owner may name another qualified bid — nothing falls back to the ' +
      'next rank by itself, Q-93), unreachable is 503/504. The winner’s price is read from its ' +
      'sealed content against audit-service’s receipts (422 `INTEGRITY`; 503/504 when audit-service ' +
      'or the key is not there) and audited as a read of a bid. In one transaction under the ' +
      'tender’s lock: the award, the tender AWARDED, the winning bid AWARDED, every other ' +
      'qualified bid NOT_AWARDED, TENDER_AWARDED, one BID_NOT_AWARDED per bid that lost. Two awards ' +
      'at once are one award and a 409; the same award again answers itself with ' +
      '`alreadyAwarded: true` and writes nothing, another bid on an awarded tender is 409. ' +
      '**The approval gate fails closed (Q-84):** with no active `tender.award` approval policy the ' +
      'answer is 422 naming APPROVAL_POLICY_REQUIRED, and while the approval round is not wired ' +
      '(CON-002 PR 11) even a policy in force is 422 naming APPROVAL_REQUIRED — so until then this ' +
      'endpoint awards nothing. ' +
      AWARDER_NOTE,
  })
  async award(@Param('id') id: string, @Body(zodPipe(awardTenderSchema)) dto: AwardTenderDto) {
    return this.awards.award(id, dto);
  }

  @AllowService(AWARD_READ_CALLER)
  @AuditorSelfService(REFUSED_AND_AUDITED_BY_THE_SERVICE)
  @Get('tenders/:id/award')
  @ApiOperation({
    summary: 'The award of a tender, with the winner’s price',
    description:
      'The stored award: the winning bid and contractor, `amountMinor` (the winner’s price, a decimal ' +
      'string; **it is not on the TENDER_AWARDED event**, which is readable by every service), the ' +
      'rank in the frozen matrix and whether it is shared, the justification, the matrix digest and ' +
      'when and by whom. Callers: the owner’s authorised person (the award roles, with the same ' +
      'exclusions, the live-identity check and the conflict rule as for awarding), or ' +
      '`contract-service` (CON-003) with an internal token signed for the owner’s organization — ' +
      'no other service, no user of another organization, and no token signed for no tenant. A ' +
      'tender that is missing, or another organization’s, is 404 (never 403) and not logged; a ' +
      'tender not yet awarded is 404. Each read is audited like a read of a bid (READ_AWARD; a ' +
      'service caller is recorded as `service:<name>`). `alreadyAwarded` is always `true` here. ' +
      AWARDER_NOTE,
  })
  async read(@Param('id') id: string) {
    return this.awards.getAward(id);
  }
}
