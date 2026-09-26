import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RastaError, zodPipe } from '@rasta/nest-common';
import { z } from 'zod';
import { ProjectService } from './project.service';
import { NeedService } from './need.service';
import {
  cancelProjectSchema,
  createNeedSchema,
  createProjectSchema,
  listNeedsQuerySchema,
  listProjectsQuerySchema,
  submitNeedSchema,
  updateNeedSchema,
  updateProjectSchema,
  withdrawNeedSchema,
  type CancelProjectDto,
  type CreateNeedDto,
  type CreateProjectDto,
  type ListNeedsQuery,
  type ListProjectsQuery,
  type SubmitNeedDto,
  type UpdateNeedDto,
  type UpdateProjectDto,
  type WithdrawNeedDto,
} from './dto';

/** Optional on both create endpoints; bounded so it cannot become a storage vector. */
export const idempotencyKeyHeaderSchema = z.string().trim().min(1).max(255).optional();

/**
 * Reads the optional `Idempotency-Key` header. `@Headers` takes no pipe, so the
 * header is parsed here — still HTTP ↔ DTO, and still a `400` that names it.
 */
export function parseIdempotencyKey(raw: string | undefined): string | undefined {
  const parsed = idempotencyKeyHeaderSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw RastaError.validation([
    {
      path: 'Idempotency-Key',
      code: 'INVALID_HEADER',
      message: 'Idempotency-Key must be 1 to 255 characters',
    },
  ]);
}

const ROLES_NOTE =
  'Allowed roles come from configuration (CONSTRUCTION_PROJECT_ROLES to change, plus ' +
  'CONSTRUCTION_PROJECT_READER_ROLES to read; SYSTEM_ADMIN acting for a selected organization ' +
  'always) — docs/24 Q-69. AUDITOR is always refused.';

const TENANT_NOTE =
  'Only the organization the request acts for: a project of any other organization answers ' +
  '404, never 403, so its existence is not disclosed.';

const VERSION_NOTE =
  '`expectedVersion` must equal the current `version`; otherwise 409 OPTIMISTIC_LOCK_FAILED ' +
  'and nothing changes.';

/**
 * The construction HTTP surface of CON-001 PR 1 (`docs/04` § 4.12, `docs/06`).
 *
 * HTTP ↔ DTO and nothing else (AGENTS.md A-10): authorization, the lifecycle
 * and every write happen in the services.
 *
 * No handler carries `@Roles`: the roles are configuration (Q-69), and a
 * compile-time decorator would disagree with it. `RolesGuard` still refuses
 * `AUDITOR` on every handler here, and `ProjectAccess` refuses every role the
 * configuration did not grant.
 *
 * Commands that act on an existing project answer `200`, not Nest's default
 * `201` for a POST — nothing is created (the `docs/06` precedent).
 */
@ApiTags('projects')
@Controller({ path: 'projects', version: '1' })
export class ProjectController {
  constructor(
    private readonly projects: ProjectService,
    private readonly needs: NeedService,
  ) {}

  // -- project --------------------------------------------------------------

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a project (DRAFT)',
    description:
      'The organization is the one the request acts for; there is no field for it. Fields are ' +
      'the provisional set of docs/24 Q-68 (from docs/03 and docs/05, not the product document). ' +
      'An optional Idempotency-Key makes a retry return the first response. Publishes ' +
      `PROJECT_CREATED in the same transaction. ${ROLES_NOTE}`,
  })
  async create(
    @Body(zodPipe(createProjectSchema)) dto: CreateProjectDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.projects.create(dto, parseIdempotencyKey(idempotencyKey));
  }

  @Get()
  @ApiOperation({
    summary: "List the organization's projects, newest first",
    description: `A summary view without the polygon. ${TENANT_NOTE} ${ROLES_NOTE}`,
  })
  async list(@Query(zodPipe(listProjectsQuerySchema)) query: ListProjectsQuery) {
    return this.projects.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read one project', description: `${TENANT_NOTE} ${ROLES_NOTE}` })
  async get(@Param('id') id: string) {
    return this.projects.get(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit a project while it is DRAFT or CHANGES_REQUESTED',
    description:
      `${VERSION_NOTE} Another state answers 422. \`null\` clears area or estimatedCostMinor. ` +
      'A request that changes nothing commits nothing. Publishes PROJECT_UPDATED with the names ' +
      `of the changed fields only. ${TENANT_NOTE}`,
  })
  async update(@Param('id') id: string, @Body(zodPipe(updateProjectSchema)) dto: UpdateProjectDto) {
    return this.projects.update(id, dto);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a project (terminal)',
    description:
      `${VERSION_NOTE} Allowed from the states CONSTRUCTION_CANCELLABLE_STATES keeps (Q-69); ` +
      'never from IN_PROGRESS or a terminal state (422). The reason is required and kept as ' +
      'statusReason; PROJECT_STATUS_CHANGED does not carry it (no free text on events). No ' +
      'cancellation approval is required in this release (Q-69).',
  })
  async cancel(@Param('id') id: string, @Body(zodPipe(cancelProjectSchema)) dto: CancelProjectDto) {
    return this.projects.cancel(id, dto);
  }

  // -- needs ----------------------------------------------------------------

  @Post(':id/needs')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add a need (DRAFT) to an editable project',
    description:
      'Only while the project is DRAFT or CHANGES_REQUESTED (422 otherwise). Fields are the ' +
      'provisional set of docs/24 Q-68. An optional Idempotency-Key makes a retry return the first ' +
      `response. Publishes PROJECT_NEED_ADDED. ${TENANT_NOTE}`,
  })
  async addNeed(
    @Param('id') id: string,
    @Body(zodPipe(createNeedSchema)) dto: CreateNeedDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.needs.add(id, dto, parseIdempotencyKey(idempotencyKey));
  }

  @Get(':id/needs')
  @ApiOperation({ summary: "List a project's needs, oldest first", description: TENANT_NOTE })
  async listNeeds(
    @Param('id') id: string,
    @Query(zodPipe(listNeedsQuerySchema)) query: ListNeedsQuery,
  ) {
    return this.needs.list(id, query);
  }

  @Patch(':id/needs/:needId')
  @ApiOperation({
    summary: 'Edit a DRAFT need of an editable project',
    description: `${VERSION_NOTE} A submitted need cannot be edited: withdraw it and add a new one. Publishes PROJECT_NEED_UPDATED.`,
  })
  async updateNeed(
    @Param('id') id: string,
    @Param('needId') needId: string,
    @Body(zodPipe(updateNeedSchema)) dto: UpdateNeedDto,
  ) {
    return this.needs.update(id, needId, dto);
  }

  @Post(':id/needs/:needId/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit a need into the project scope (DRAFT → SUBMITTED)',
    description: `${VERSION_NOTE} Publishes PROJECT_NEED_SUBMITTED.`,
  })
  async submitNeed(
    @Param('id') id: string,
    @Param('needId') needId: string,
    @Body(zodPipe(submitNeedSchema)) dto: SubmitNeedDto,
  ) {
    return this.needs.submit(id, needId, dto);
  }

  @Post(':id/needs/:needId/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Withdraw a need (terminal)',
    description:
      `${VERSION_NOTE} The reason is required and kept as withdrawalReason; ` +
      'PROJECT_NEED_WITHDRAWN does not carry it (no free text on events).',
  })
  async withdrawNeed(
    @Param('id') id: string,
    @Param('needId') needId: string,
    @Body(zodPipe(withdrawNeedSchema)) dto: WithdrawNeedDto,
  ) {
    return this.needs.withdraw(id, needId, dto);
  }
}
