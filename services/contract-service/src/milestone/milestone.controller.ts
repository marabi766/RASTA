import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePlatformUserId, zodPipe } from '@rasta/nest-common';
import type { CursorPage } from '../contract/dto';
import { IdempotencyStore, requiredIdempotencyKey } from '../shared/idempotency';
import {
  changeMilestoneSchema,
  planMilestoneSchema,
  type ChangeMilestoneDto,
  type MilestoneView,
  type PlanMilestoneDto,
} from './dto';
import { MilestoneService } from './milestone.service';

/** The route templates the idempotency store keys on: a closed set, never an id. */
export const PLAN_MILESTONE_ENDPOINT = 'POST /v1/contracts/{id}/milestones';
export const CHANGE_MILESTONE_ENDPOINT = 'PATCH /v1/contracts/{id}/milestones/{milestoneId}';

const PARTIES_NOTE =
  'Closed by default (S-02). Read by the same two parties as the contract: the employer’s ' +
  'organization — the roles of CONTRACT_READER_ROLES, and SYSTEM_ADMIN acting for an organization ' +
  'it selected with X-Organization-Id — and the winning contractor’s organization (the CONTRACTOR ' +
  'role, in its own organization). Any other organization, a contract or milestone that does not ' +
  'exist and one of someone else are all 404, never 403 (S-03). AUDITOR and a service token are refused.';

const COMMAND_NOTE =
  'Requires an `Idempotency-Key` (docs/06 § 6.8): without one, or with one outside 8 to 255 ' +
  'characters, 400 VALIDATION_FAILED and nothing is done. The same key with the same body from ' +
  'the same user answers the original response and does nothing again; the same key with ' +
  'another body or user is 409 IDEMPOTENCY_KEY_REUSED; a duplicate that arrives while the first ' +
  'is still being processed waits for its answer and past a few seconds is 409 CONFLICT with ' +
  'Retry-After. The caller must be a signed-in person with a platform user id (403 otherwise); ' +
  'the platform administrator, the oversight role and a service token are refused. Only the ' +
  'employer, with a role CONTRACT_MILESTONE_ROLES names (default ORGANIZATION_ADMIN); the ' +
  'contractor is 403 `EDITOR_NOT_EMPLOYER`. A refusal of a party for want of authority is recorded ' +
  '(CONTRACT_AUTHORITY_REFUSED); when that record cannot be written the answer is 503 and nothing ' +
  'was done. A contract of another organization, or one that does not exist, is 404 — never 403. ' +
  'Refusals carry their closed reason in `details[].code` (docs/06 § 6.7).';

/**
 * The milestone API of a contract (ADR-068 § 9, CON-003 PR 3). HTTP ↔ DTO and nothing else
 * (AGENTS.md A-10); no handler names a role.
 */
@ApiTags('milestones')
@Controller({ path: 'contracts/:id/milestones', version: '1' })
export class MilestoneController {
  constructor(
    private readonly milestones: MilestoneService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List the planned milestones of a contract, by planned day',
    description:
      'The contract’s plan: title, planned day (a date, never an instant), the optional planned ' +
      `share in basis points, and whether a statement already refers to it. ${PARTIES_NOTE}`,
  })
  async list(@Param('id') id: string): Promise<CursorPage<MilestoneView>> {
    return this.milestones.list(id);
  }

  @Get(':milestoneId')
  @ApiOperation({
    summary: 'Read one planned milestone',
    description: `One milestone of the contract. ${PARTIES_NOTE}`,
  })
  async get(
    @Param('id') id: string,
    @Param('milestoneId') milestoneId: string,
  ): Promise<MilestoneView> {
    return this.milestones.get(id, milestoneId);
  }

  @RequirePlatformUserId()
  @Post()
  @HttpCode(201)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 255 characters. Scoped to the organization.',
  })
  @ApiOperation({
    summary: 'Plan a milestone on a signed contract, employer only',
    description:
      'A title, a planned day (`YYYY-MM-DD`) and optionally a planned share in basis points (1 to ' +
      '10000). Only on a SIGNED contract (422 `CONTRACT_NOT_SIGNED`); a contract holds at most ' +
      'CONTRACT_MILESTONE_LIMIT milestones (422 `MILESTONE_LIMIT_REACHED`). No sum of the shares ' +
      'is kept: no document defines one (Q-100). CONTRACT_MILESTONE_PLANNED carries identifiers ' +
      `and instants only. ${COMMAND_NOTE}`,
  })
  async plan(
    @Param('id') id: string,
    @Body(zodPipe(planMilestoneSchema)) dto: PlanMilestoneDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<MilestoneView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const { result } = await this.idempotency.execute<MilestoneView>(
      PLAN_MILESTONE_ENDPOINT,
      key,
      { id, ...dto },
      201,
      (fence) => this.milestones.plan(id, dto, fence),
      (stored) => this.milestones.assertContractVisible(stored.contractId),
    );
    return result;
  }

  @RequirePlatformUserId()
  @Patch(':milestoneId')
  @HttpCode(200)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 255 characters. Scoped to the organization.',
  })
  @ApiOperation({
    summary: 'Change a planned milestone no statement refers to, employer only',
    description:
      'Changes the fields given (`plannedShareBp: null` clears the share); at least one is ' +
      'required. Only while no statement refers to the milestone (422 `MILESTONE_REFERENCED`) and ' +
      'only on a SIGNED contract (422 `CONTRACT_NOT_SIGNED`). A change that changes nothing ' +
      'answers with the milestone as it is and writes nothing. There is no delete (Q-100). ' +
      '`expectedVersion` is optional. ' +
      COMMAND_NOTE,
  })
  async change(
    @Param('id') id: string,
    @Param('milestoneId') milestoneId: string,
    @Body(zodPipe(changeMilestoneSchema)) dto: ChangeMilestoneDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<MilestoneView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const { result } = await this.idempotency.execute<MilestoneView>(
      CHANGE_MILESTONE_ENDPOINT,
      key,
      { id, milestoneId, ...dto },
      200,
      (fence) => this.milestones.change(id, milestoneId, dto, fence),
      (stored) => this.milestones.assertContractVisible(stored.contractId),
    );
    return result;
  }
}
