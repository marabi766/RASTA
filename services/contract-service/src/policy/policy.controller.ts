import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePlatformUserId, zodPipe } from '@rasta/nest-common';
import { IdempotencyStore, requiredIdempotencyKey } from '../shared/idempotency';
import { CREATE_POLICY_ENDPOINT, PolicyService } from './policy.service';
import {
  createPolicySchema,
  listPoliciesQuerySchema,
  policyRejectionSchema,
  policyTransitionSchema,
  type CreatePolicyDto,
  type ListPoliciesQuery,
  type PolicyRejectionDto,
  type PolicyTransitionDto,
  type PolicyView,
} from './dto';

const WRITERS_NOTE =
  'Q-70 (7), decided 2026-09-26: a UNION_ADMIN writes for its own organization or one beneath it ' +
  '(confirmed with organization-service; an unconfirmable answer refuses, 503), a SYSTEM_ADMIN for ' +
  'any existing organization. An ORGANIZATION_ADMIN never writes its own policy (403). The ' +
  'platform stores the authority it is told and creates none (ADR-023).';

const PLATFORM_NOTE =
  'SYSTEM_ADMIN only, for any organization. With CONTRACT_POLICY_FOUR_EYES (default on) the ' +
  'approver must be neither the author nor the submitter (403).';

/**
 * The approval policies a contract's employer is governed by (ADR-068 § 5): who may accept a
 * contract for it. HTTP ↔ DTO and nothing else (AGENTS.md A-10).
 */
@ApiTags('approval-policies')
@Controller({ path: 'approval-policies', version: '1' })
export class PolicyController {
  constructor(
    private readonly policies: PolicyService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  @Post()
  @RequirePlatformUserId()
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 255 characters. Scoped to the organization the request acts for.',
  })
  @ApiOperation({
    summary: 'Write an approval policy version (DRAFT) for an organization',
    description:
      'For `contract.signature`, each step names a role of the governed organization itself that ' +
      'may accept a contract for it (alternatives: any one of them may sign); another ' +
      'organization’s role is 422 `AUTHORITY_NOT_GOVERNED_ORGANIZATION`. The authority is never ' +
      'the oversight role or the platform operator. A DRAFT governs nothing until a platform ' +
      `administrator approves it. Requires an Idempotency-Key. ${WRITERS_NOTE}`,
  })
  async create(
    @Body(zodPipe(createPolicySchema)) dto: CreatePolicyDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<PolicyView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const { result } = await this.idempotency.execute<PolicyView>(
      CREATE_POLICY_ENDPOINT,
      key,
      dto,
      201,
      (fence) => this.policies.create(dto, fence),
      (stored) => this.policies.assertVisible(stored.id),
    );
    return result;
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
    description: 'SYSTEM_ADMIN only.',
  })
  async platformQueue(@Query(zodPipe(listPoliciesQuerySchema)) query: ListPoliciesQuery) {
    return this.policies.platformQueue(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Read one approval policy with its steps',
    description:
      "Visible to its author organization, to the governed organization's contract readers and " +
      'to a platform administrator; anyone else gets 404.',
  })
  async get(@Param('id') id: string) {
    return this.policies.get(id);
  }

  @Post(':id/submit')
  @RequirePlatformUserId()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a DRAFT policy for platform approval',
    description:
      'By the organization that wrote it. The hierarchy is confirmed again with organization-service.',
  })
  async submit(
    @Param('id') id: string,
    @Body(zodPipe(policyTransitionSchema)) dto: PolicyTransitionDto,
  ) {
    return this.policies.submit(id, dto);
  }

  @Post(':id/approve')
  @RequirePlatformUserId()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve a pending policy: it comes into force',
    description:
      'Retires the policy in force for the same organization and workflow in the same ' +
      `transaction. Signatures already recorded keep the policy they were made under. ${PLATFORM_NOTE}`,
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
      'A rejected policy never governs anything. The reason stays with the policy and is not ' +
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
      'By its author organization or a platform administrator. From then on the employer’s side ' +
      'of its contracts cannot be signed (422 SIGNATURE_POLICY_REQUIRED): no policy never means ' +
      '"anyone may sign".',
  })
  async retire(
    @Param('id') id: string,
    @Body(zodPipe(policyTransitionSchema)) dto: PolicyTransitionDto,
  ) {
    return this.policies.retire(id, dto);
  }
}
