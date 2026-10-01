import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { zodPipe } from '@rasta/nest-common';
import { parseIdempotencyKey } from '../project/project.controller';
import { CriteriaService } from './criteria.service';
import {
  createCriteriaTemplateSchema,
  listCriteriaTemplatesQuerySchema,
  setCriteriaSchema,
  type CreateCriteriaTemplateDto,
  type ListCriteriaTemplatesQuery,
  type SetCriteriaDto,
} from './criteria.dto';

const ROLES_NOTE =
  'Owner side. Allowed roles are the project roles from configuration ' +
  '(CONSTRUCTION_PROJECT_ROLES to change, plus CONSTRUCTION_PROJECT_READER_ROLES to read; ' +
  'SYSTEM_ADMIN acting for a selected organization always) — docs/24 Q-69, Q-84. AUDITOR is ' +
  'always refused.';

const TENANT_NOTE =
  'Only the organization the request acts for: a template or tender of any other organization ' +
  'answers 404, never 403, so its existence is not disclosed.';

/**
 * Evaluation criteria (ADR-067 § 1). HTTP ↔ DTO and nothing else (AGENTS.md
 * A-10); the freeze after publication, the version check and the tenant scope
 * are in the service and the database.
 */
@ApiTags('criteria')
@Controller({ version: '1' })
export class CriteriaController {
  constructor(private readonly criteria: CriteriaService) {}

  @Post('criteria-templates')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Write a criteria template (the next version of its label)',
    description:
      'A template is never edited: the same label again is version + 1. Weights are in basis ' +
      'points and sum to at most 10000 here (a published tender needs exactly 10000). The platform ' +
      'ships no template. An optional Idempotency-Key makes a retry return the first response. ' +
      `Publishes CRITERIA_TEMPLATE_CREATED (counts only). ${ROLES_NOTE}`,
  })
  async createTemplate(
    @Body(zodPipe(createCriteriaTemplateSchema)) dto: CreateCriteriaTemplateDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.criteria.createTemplate(dto, parseIdempotencyKey(idempotencyKey));
  }

  @Get('criteria-templates')
  @ApiOperation({
    summary: "List the organization's criteria templates, newest first",
    description: `${TENANT_NOTE} ${ROLES_NOTE}`,
  })
  async listTemplates(
    @Query(zodPipe(listCriteriaTemplatesQuerySchema)) query: ListCriteriaTemplatesQuery,
  ) {
    return this.criteria.listTemplates(query);
  }

  @Get('criteria-templates/:id')
  @ApiOperation({
    summary: 'Read one criteria template',
    description: `${TENANT_NOTE} ${ROLES_NOTE}`,
  })
  async getTemplate(@Param('id') id: string) {
    return this.criteria.getTemplate(id);
  }

  @Put('tenders/:id/criteria')
  @ApiOperation({
    summary: "Replace a DRAFT tender's evaluation criteria",
    description:
      'Give either `templateId` (copied, and remembered as provenance) or `criteria` (written out). ' +
      "`expectedVersion` must equal the tender's current `version`; otherwise 409 " +
      'OPTIMISTIC_LOCK_FAILED. The list replaces the whole set. Any state but DRAFT answers 422: ' +
      'the criteria freeze at publication (threat C3), enforced by the database as well. Weights ' +
      'may sum to less than 10000 while drafting; publishing needs exactly 10000. Publishes ' +
      `TENDER_CRITERIA_SET (counts and weights only). ${TENANT_NOTE}`,
  })
  async setCriteria(
    @Param('id') id: string,
    @Body(zodPipe(setCriteriaSchema)) dto: SetCriteriaDto,
  ) {
    return this.criteria.setCriteria(id, dto);
  }

  @Get('tenders/:id/criteria')
  @ApiOperation({
    summary: "Read a tender's criteria",
    description: `\`complete\` says whether the weights sum to exactly 10000. ${TENANT_NOTE} ${ROLES_NOTE}`,
  })
  async getCriteria(@Param('id') id: string) {
    return this.criteria.getCriteria(id);
  }
}
