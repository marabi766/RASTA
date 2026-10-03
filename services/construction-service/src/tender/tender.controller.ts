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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePlatformUserId, zodPipe } from '@rasta/nest-common';
import { parseIdempotencyKey } from '../project/project.controller';
import { TenderService } from './tender.service';
import { GATED_NOTE, answerGated } from './gated-response';
import {
  cancelTenderSchema,
  createTenderSchema,
  listTendersQuerySchema,
  updateTenderSchema,
  type CancelTenderDto,
  type CreateTenderDto,
  type ListTendersQuery,
  type UpdateTenderDto,
} from './dto';

const ROLES_NOTE =
  'Owner side. Allowed roles are the project roles from configuration ' +
  '(CONSTRUCTION_PROJECT_ROLES to change, plus CONSTRUCTION_PROJECT_READER_ROLES to read; ' +
  'SYSTEM_ADMIN acting for a selected organization always) — docs/24 Q-69. AUDITOR is always ' +
  'refused.';

const TENANT_NOTE =
  'Only the organization the request acts for: a tender of any other organization answers ' +
  '404, never 403, so its existence is not disclosed.';

const VERSION_NOTE =
  '`expectedVersion` must equal the current `version`; otherwise 409 OPTIMISTIC_LOCK_FAILED ' +
  'and nothing changes.';

/**
 * The tender HTTP surface of CON-002 PR 2 (`docs/04` § 4.12, ADR-065).
 *
 * HTTP ↔ DTO and nothing else (AGENTS.md A-10). No handler carries `@Roles`:
 * the roles are configuration (Q-69), and `ProjectAccess` refuses every role
 * the configuration did not grant; `RolesGuard` still refuses `AUDITOR`.
 * Publication, bidding and everything after it arrive with the later steps.
 */
@ApiTags('tenders')
@Controller({ version: '1' })
export class TenderController {
  constructor(private readonly tenders: TenderService) {}

  @Post('projects/:id/tenders')
  @RequirePlatformUserId()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a tender (DRAFT) under an APPROVED project',
    description:
      'Only under a project that is APPROVED (422 otherwise); creating takes the project lock, so ' +
      'it serialises with cancelling the project. The nature and visibility are chosen by the ' +
      'owner and never defaulted; both, and the bidding window, are required before publishing. ' +
      'Times are UTC with a trailing Z. An optional Idempotency-Key makes a retry return the ' +
      `first response. Publishes TENDER_CREATED. ${ROLES_NOTE}`,
  })
  async create(
    @Param('id') projectId: string,
    @Body(zodPipe(createTenderSchema)) dto: CreateTenderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.tenders.create(projectId, dto, parseIdempotencyKey(idempotencyKey));
  }

  @Get('tenders')
  @ApiOperation({
    summary: "List the organization's tenders, newest first",
    description: `A summary view without the scope of work. ${TENANT_NOTE} ${ROLES_NOTE}`,
  })
  async list(@Query(zodPipe(listTendersQuerySchema)) query: ListTendersQuery) {
    return this.tenders.list(query);
  }

  @Get('tenders/:id')
  @ApiOperation({ summary: 'Read one tender', description: `${TENANT_NOTE} ${ROLES_NOTE}` })
  async get(@Param('id') id: string) {
    return this.tenders.get(id);
  }

  @Patch('tenders/:id')
  @ApiOperation({
    summary: 'Edit a DRAFT tender',
    description:
      `${VERSION_NOTE} Another state answers 422. \`null\` clears the nature, the visibility, or ` +
      '(both together) the bidding window. A request that changes nothing commits nothing. ' +
      `Publishes TENDER_UPDATED with the names of the changed fields only. ${TENANT_NOTE}`,
  })
  async update(@Param('id') id: string, @Body(zodPipe(updateTenderSchema)) dto: UpdateTenderDto) {
    return this.tenders.update(id, dto);
  }

  @Post('tenders/:id/cancel')
  @RequirePlatformUserId()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a tender (terminal)',
    description:
      `${VERSION_NOTE} Cancellable from every live state (DRAFT, PUBLISHED, CLOSED, EVALUATING, ` +
      'EVALUATED); a DRAFT too — every cancellation needs an approval policy (Q-84). The reason is ' +
      'required and kept as statusReason; TENDER_CANCELLED carries only the closed code ' +
      '(`reasonCode`: OWNER_REQUEST by default, or NO_QUALIFIED_BID for an EVALUATING tender in which ' +
      'no bid was qualified — 422 REASON_CODE_NOT_APPLICABLE otherwise; no free text on events). ' +
      `${GATED_NOTE} The request is bound to the tender, its version, the reason and its code.`,
  })
  async cancel(
    @Param('id') id: string,
    @Body(zodPipe(cancelTenderSchema)) dto: CancelTenderDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return answerGated(response, await this.tenders.cancel(id, dto));
  }
}
