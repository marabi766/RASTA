import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { zodPipe } from '@rasta/nest-common';
import { PolicyService } from './policy.service';
import {
  createPolicySchema,
  listPoliciesQuerySchema,
  policyRejectionSchema,
  policyTransitionSchema,
  type CreatePolicyDto,
  type ListPoliciesQuery,
  type PolicyRejectionDto,
  type PolicyTransitionDto,
} from './dto';

const WRITERS_NOTE =
  'Q-70 (7), decided 2026-09-26: a UNION_ADMIN writes for its own organization or one beneath it ' +
  '(confirmed with organization-service; an unconfirmable answer refuses, 503), a SYSTEM_ADMIN for ' +
  'any existing organization. An ORGANIZATION_ADMIN never writes its own policy (403). The ' +
  'platform stores the authority it is told and creates none (ADR-023); organization-service ' +
  'approval.* keys are not read (ADR-063).';

const PLATFORM_NOTE =
  'SYSTEM_ADMIN only, for any organization. With CONSTRUCTION_POLICY_FOUR_EYES (default on) the ' +
  'approver must be neither the author nor the submitter (403).';

@ApiTags('approval-policies')
@Controller({ path: 'approval-policies', version: '1' })
export class PolicyController {
  constructor(private readonly policies: PolicyService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Write an approval policy version (DRAFT) for an organization',
    description:
      'Steps are asked strictly in order. A step applies when the project estimate is ≥ ' +
      'minAmountMinor and < maxAmountMinor; a step with neither bound always applies. The ' +
      'authority is an (organization, role) and never the oversight role. A DRAFT governs ' +
      `nothing until a platform administrator approves it. ${WRITERS_NOTE}`,
  })
  async create(@Body(zodPipe(createPolicySchema)) dto: CreatePolicyDto) {
    return this.policies.create(dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List the policies governing, or written by, the organization the request acts for',
  })
  async list(@Query(zodPipe(listPoliciesQuerySchema)) query: ListPoliciesQuery) {
    return this.policies.list(query);
  }

  @Get('pending-platform-approval')
  @ApiOperation({
    summary: "The platform administrator's queue: every organization's policies awaiting approval",
    description: PLATFORM_NOTE.split('.')[0] + '.',
  })
  async platformQueue(@Query(zodPipe(listPoliciesQuerySchema)) query: ListPoliciesQuery) {
    return this.policies.platformQueue(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Read one approval policy with its steps',
    description:
      "Visible to its author organization, to the governed organization's project readers and " +
      'to a platform administrator; anyone else gets 404.',
  })
  async get(@Param('id') id: string) {
    return this.policies.get(id);
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a DRAFT policy for platform approval',
    description:
      'By the organization that wrote it. The hierarchy is confirmed again with ' +
      'organization-service.',
  })
  async submit(
    @Param('id') id: string,
    @Body(zodPipe(policyTransitionSchema)) dto: PolicyTransitionDto,
  ) {
    return this.policies.submit(id, dto);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve a pending policy: it comes into force',
    description:
      'Retires the policy in force for the same organization and workflow in the same ' +
      `transaction. Rounds already open keep the steps they copied. ${PLATFORM_NOTE}`,
  })
  async approve(
    @Param('id') id: string,
    @Body(zodPipe(policyTransitionSchema)) dto: PolicyTransitionDto,
  ) {
    return this.policies.approve(id, dto);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject a pending policy, with a reason',
    description:
      'A rejected policy never governs a project. The reason stays with the policy and is not ' +
      'published on the event. SYSTEM_ADMIN only.',
  })
  async reject(
    @Param('id') id: string,
    @Body(zodPipe(policyRejectionSchema)) dto: PolicyRejectionDto,
  ) {
    return this.policies.reject(id, dto);
  }

  @Post(':id/retire')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Take an ACTIVE policy out of force with no replacement',
    description:
      'By its author organization or a platform administrator. From then on RequestApproval ' +
      'for that workflow is refused: no policy never means "no approval needed" for execution.',
  })
  async retire(
    @Param('id') id: string,
    @Body(zodPipe(policyTransitionSchema)) dto: PolicyTransitionDto,
  ) {
    return this.policies.retire(id, dto);
  }
}
