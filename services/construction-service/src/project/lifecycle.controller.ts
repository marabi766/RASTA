import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { zodPipe } from '@rasta/nest-common';
import { ApprovalService } from '../approval/approval.service';
import {
  projectApprovalsQuerySchema,
  projectCommandSchema,
  type ProjectApprovalsQuery,
  type ProjectCommandDto,
} from '../approval/dto';
import { ProgressService } from '../progress/progress.service';
import {
  createProgressSchema,
  listProgressQuerySchema,
  progressTransitionSchema,
  type CreateProgressDto,
  type ListProgressQuery,
  type ProgressTransitionDto,
} from '../progress/dto';
import { ExecutionService } from './execution.service';

/**
 * The project lifecycle beyond drafting (CON-001 PR 2): approval, start,
 * progress, completion. HTTP ↔ DTO only; the same configured project roles as
 * `ProjectController` apply (Q-69).
 */
@ApiTags('projects')
@Controller({ path: 'projects', version: '1' })
export class ProjectLifecycleController {
  constructor(
    private readonly approvals: ApprovalService,
    private readonly execution: ExecutionService,
    private readonly progress: ProgressService,
  ) {}

  @Post(':id/approvals')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request approval (DRAFT | CHANGES_REQUESTED → PENDING_APPROVAL)',
    description:
      'Copies the steps of the active project.execution policy that apply to the estimate into a ' +
      'new round and asks the first. Refused (422) with no active policy or no applicable step — ' +
      'the platform never approves by default — and without the preconditions ' +
      'CONSTRUCTION_APPROVAL_MIN_SUBMITTED_NEEDS and CONSTRUCTION_APPROVAL_REQUIRES_ESTIMATE ' +
      '(Q-68). Publishes PROJECT_STATUS_CHANGED and APPROVAL_REQUESTED.',
  })
  async requestApproval(
    @Param('id') id: string,
    @Body(zodPipe(projectCommandSchema)) dto: ProjectCommandDto,
  ) {
    return this.approvals.request(id, dto);
  }

  @Get(':id/approvals')
  @ApiOperation({ summary: "A project's approvals, in round and step order" })
  async listApprovals(
    @Param('id') id: string,
    @Query(zodPipe(projectApprovalsQuerySchema)) query: ProjectApprovalsQuery,
  ) {
    return this.approvals.listForProject(id, query);
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start execution (APPROVED → IN_PROGRESS)',
    description:
      'PROJECT_STARTED carries contractId null until the contract boundary exists (CON-003). ' +
      'Refused when CONSTRUCTION_START_REQUIRES_CONTRACT is true (Q-71).',
  })
  async start(
    @Param('id') id: string,
    @Body(zodPipe(projectCommandSchema)) dto: ProjectCommandDto,
  ) {
    return this.execution.start(id, dto);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete execution',
    description:
      'Requires the latest submitted progress report at 100%. If project.completion steps are ' +
      'configured and apply, opens that round and the project completes on its last grant; ' +
      'otherwise completes now (Q-71).',
  })
  async complete(
    @Param('id') id: string,
    @Body(zodPipe(projectCommandSchema)) dto: ProjectCommandDto,
  ) {
    return this.execution.complete(id, dto);
  }

  @Post(':id/progress')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Draft a progress report (project IN_PROGRESS)',
    description:
      'Progress in basis points (10000 = 100%). Publishes PROJECT_PROGRESS_REPORT_DRAFTED.',
  })
  async draftProgress(
    @Param('id') id: string,
    @Body(zodPipe(createProgressSchema)) dto: CreateProgressDto,
  ) {
    return this.progress.draft(id, dto);
  }

  @Get(':id/progress')
  @ApiOperation({ summary: "A project's progress reports, newest first" })
  async listProgress(
    @Param('id') id: string,
    @Query(zodPipe(listProgressQuerySchema)) query: ListProgressQuery,
  ) {
    return this.progress.list(id, query);
  }

  @Post(':id/progress/:reportId/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit a draft progress report (immutable afterwards)',
    description:
      'May not report less than the last submitted report unless ' +
      'CONSTRUCTION_PROGRESS_ALLOW_DECREASE is true (Q-72). Publishes PROJECT_PROGRESS_UPDATED.',
  })
  async submitProgress(
    @Param('id') id: string,
    @Param('reportId') reportId: string,
    @Body(zodPipe(progressTransitionSchema)) dto: ProgressTransitionDto,
  ) {
    return this.progress.submit(id, reportId, dto);
  }

  @Post(':id/progress/:reportId/discard')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Discard a draft progress report' })
  async discardProgress(
    @Param('id') id: string,
    @Param('reportId') reportId: string,
    @Body(zodPipe(progressTransitionSchema)) dto: ProgressTransitionDto,
  ) {
    return this.progress.discard(id, reportId, dto);
  }
}
