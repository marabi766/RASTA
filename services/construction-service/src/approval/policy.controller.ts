import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { zodPipe } from '@rasta/nest-common';
import { PolicyService } from './policy.service';
import {
  createPolicySchema,
  listPoliciesQuerySchema,
  policyTransitionSchema,
  type CreatePolicyDto,
  type ListPoliciesQuery,
  type PolicyTransitionDto,
} from './dto';

const SETTERS_NOTE =
  'Written by the roles in CONSTRUCTION_POLICY_SETTER_ROLES (default SYSTEM_ADMIN, UNION_ADMIN — ' +
  'the Q-64 answer), for the organization the request acts for only. The platform stores the ' +
  'authority it is told and creates none (ADR-023); organization-service approval.* keys are not ' +
  'read (ADR-063).';

/**
 * Approval policies — configuration as data (ADR-023, ADR-063, Q-70).
 * HTTP ↔ DTO only; every rule is in `PolicyService` and `ProjectAccess`.
 */
@ApiTags('approval-policies')
@Controller({ path: 'approval-policies', version: '1' })
export class PolicyController {
  constructor(private readonly policies: PolicyService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create an approval policy version (DRAFT)',
    description:
      'Steps are asked strictly in order. A step applies when the project estimate is ≥ ' +
      'minAmountMinor and < maxAmountMinor; a step with neither bound always applies. The ' +
      `authority is an (organization, role) and never the oversight role. ${SETTERS_NOTE}`,
  })
  async create(@Body(zodPipe(createPolicySchema)) dto: CreatePolicyDto) {
    return this.policies.create(dto);
  }

  @Get()
  @ApiOperation({ summary: "List the organization's approval policies, newest first" })
  async list(@Query(zodPipe(listPoliciesQuerySchema)) query: ListPoliciesQuery) {
    return this.policies.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read one approval policy with its steps' })
  async get(@Param('id') id: string) {
    return this.policies.get(id);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Put a DRAFT policy in force',
    description:
      'Retires the policy in force for the same workflow in the same transaction. Rounds ' +
      `already open keep the steps they copied. ${SETTERS_NOTE}`,
  })
  async activate(
    @Param('id') id: string,
    @Body(zodPipe(policyTransitionSchema)) dto: PolicyTransitionDto,
  ) {
    return this.policies.activate(id, dto);
  }

  @Post(':id/retire')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Take an ACTIVE policy out of force with no replacement',
    description:
      'From then on RequestApproval for that workflow is refused: no policy never means "no ' +
      'approval needed" for execution.',
  })
  async retire(
    @Param('id') id: string,
    @Body(zodPipe(policyTransitionSchema)) dto: PolicyTransitionDto,
  ) {
    return this.policies.retire(id, dto);
  }
}
