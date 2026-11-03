import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowService } from '@rasta/nest-common';
import {
  COMPLETION_READ_CALLER,
  ProjectCompletionService,
  type ProjectCompletionFact,
} from './completion-fact';

@ApiTags('construction-internal')
@Controller({ path: 'internal/projects', version: '1' })
export class InternalProjectController {
  constructor(private readonly completion: ProjectCompletionService) {}

  @Get(':id/completion')
  @AllowService(COMPLETION_READ_CALLER)
  @ApiOperation({
    summary: 'Read the project completion source fact (internal, D-081)',
    description:
      'Only contract-service with a SERVICE token in X-Internal-Token, signed for the project owner. ' +
      'Every user and every other service is refused (403); a missing signed tenant or a conflicting ' +
      'X-Organization-Id is 403. Missing and other-tenant projects answer the same 404. ' +
      'Returns ids, status, version and, only for COMPLETED, completedAt and completedBy from the ' +
      'stored status transition. Every other status has null completion fields and proves no ' +
      'completion. Covers configured project.completion approvals and the interim 100% progress ' +
      'path. Consumers must compare the project, tenant, status and completion metadata with the ' +
      'event before acting; projectId and version identify the source fact. No money or project ' +
      'content is returned. This read writes nothing. The gateway does not route /v1/internal/.',
  })
  get(@Param('id') id: string): Promise<ProjectCompletionFact> {
    return this.completion.fact(id);
  }
}
