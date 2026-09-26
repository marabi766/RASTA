import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { zodPipe } from '@rasta/nest-common';
import { ApprovalService } from './approval.service';
import { decisionSchema, inboxQuerySchema, type DecisionDto, type InboxQuery } from './dto';

/**
 * The authority's side of an approval (Q-70). HTTP ↔ DTO only.
 */
@ApiTags('approvals')
@Controller({ path: 'approvals', version: '1' })
export class ApprovalController {
  constructor(private readonly approvals: ApprovalService) {}

  @Get()
  @ApiOperation({
    summary: "The authority's inbox",
    description:
      'Approval steps addressed to the organization the request acts for and to one of the ' +
      "caller's roles there. PENDING by default.",
  })
  async inbox(@Query(zodPipe(inboxQuerySchema)) query: InboxQuery) {
    return this.approvals.inbox(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Read one approval',
    description:
      "Its project's readers, or its authority. Anyone else gets 404, so its existence is not " +
      'disclosed.',
  })
  async get(@Param('id') id: string) {
    return this.approvals.get(id);
  }

  @Post(':id/decision')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Grant or reject a PENDING approval step',
    description:
      'Only a caller acting for the step’s authorityOrganizationId and holding its authorityRole ' +
      'there may decide — SYSTEM_ADMIN included only if the policy named it. The last grant of a ' +
      'round approves the project (or completes it, for project.completion); a rejection ends the ' +
      'round and sends an execution request back to CHANGES_REQUESTED. A rejection states its ' +
      'reason. Nothing is ever approved by a timeout or by default.',
  })
  async decide(@Param('id') id: string, @Body(zodPipe(decisionSchema)) dto: DecisionDto) {
    return this.approvals.decide(id, dto);
  }
}
