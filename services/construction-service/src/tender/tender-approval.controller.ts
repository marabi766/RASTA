import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { zodPipe } from '@rasta/nest-common';
import { TenderApprovalService } from './tender-approval.service';
import {
  listTenderApprovalsQuerySchema,
  type ListTenderApprovalsQuery,
} from './tender-approval.dto';

/**
 * The owner's read of the approval requests of its own tender (CON-002 PR 11). HTTP ↔ DTO and nothing else
 * (AGENTS.md A-10). Opening a request is the command (`publish`, `award`, `cancel`); deciding one is the
 * authority's, on `POST /v1/approvals/{id}/decision`.
 */
@ApiTags('tenders')
@Controller({ version: '1' })
export class TenderApprovalController {
  constructor(private readonly approvals: TenderApprovalService) {}

  @Get('tenders/:id/approvals')
  @ApiOperation({
    summary: "List a tender's approval requests, newest first",
    description:
      'The requests of the three gates (`tender.publication`, `tender.award`, `tender.cancellation`) ' +
      'on one of the caller’s own tenders, with their steps and where each stands (PENDING, APPROVED, ' +
      'REJECTED, STALE, CONSUMED). An award request is shown by status and steps only: the bid it ' +
      'names is read by its authority. Owner side: the project reader roles; a tender of another ' +
      'organization answers 404, never 403, so its existence is not disclosed.',
  })
  async list(
    @Param('id') id: string,
    @Query(zodPipe(listTenderApprovalsQuerySchema)) query: ListTenderApprovalsQuery,
  ) {
    return this.approvals.listForTender(id, query);
  }
}
