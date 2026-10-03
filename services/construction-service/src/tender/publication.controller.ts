import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePlatformUserId, zodPipe } from '@rasta/nest-common';
import { PublicationService } from './publication.service';
import { GATED_NOTE, answerGated } from './gated-response';
import {
  inviteBidderSchema,
  listInvitationsQuerySchema,
  publishTenderSchema,
  type InviteBidderDto,
  type ListInvitationsQuery,
  type PublishTenderDto,
} from './publication.dto';

const ROLES_NOTE =
  'Owner side. Allowed roles are the project roles from configuration ' +
  '(CONSTRUCTION_PROJECT_ROLES to change, plus CONSTRUCTION_PROJECT_READER_ROLES to read; ' +
  'SYSTEM_ADMIN acting for a selected organization always) — docs/24 Q-69, Q-84. AUDITOR is ' +
  'always refused.';

const TENANT_NOTE =
  'Only the organization the request acts for: a tender of any other organization answers ' +
  '404, never 403, so its existence is not disclosed.';

/**
 * Publishing a tender and inviting bidders (ADR-065). HTTP ↔ DTO and nothing
 * else (AGENTS.md A-10); every rule is in `PublicationService`, and the freeze
 * of the criteria that follows is the database's.
 */
@ApiTags('tenders')
@Controller({ version: '1' })
export class PublicationController {
  constructor(private readonly publication: PublicationService) {}

  @Post('tenders/:id/publish')
  @RequirePlatformUserId()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publish a tender (DRAFT → PUBLISHED)',
    description:
      "`expectedVersion` must equal the tender's current `version`; otherwise 409 " +
      'OPTIMISTIC_LOCK_FAILED. Refused with 422 (BUSINESS_RULE_VIOLATION), naming every reason ' +
      'in the message, unless: the procurement nature and the visibility are chosen (never ' +
      'defaulted, Q-03); the bidding window is set, at least ' +
      'CONSTRUCTION_TENDER_MIN_BIDDING_PERIOD_SECONDS long (default 0) and not already closed by the ' +
      'database clock; the criteria exist and their weights sum to exactly 10000 basis points; ' +
      'a RESTRICTED tender has at least one invitation. The criteria are frozen from this moment. ' +
      "Makes the tender's key pair, wrapping its private half with the key-encryption key " +
      '(ADR-066); without one configured nothing is published and the answer is 503. Publishes ' +
      `TENDER_PUBLISHED. ${GATED_NOTE} The request is bound to the tender and its version; a ` +
      'publication that could not succeed (any reason above) is never asked for. ' +
      `${TENANT_NOTE} ${ROLES_NOTE}`,
  })
  async publish(
    @Param('id') id: string,
    @Body(zodPipe(publishTenderSchema)) dto: PublishTenderDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return answerGated(response, await this.publication.publish(id, dto));
  }

  @Post('tenders/:id/invitations')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Invite an organization to a RESTRICTED tender',
    description:
      'While the tender is a DRAFT or PUBLISHED, and only when its visibility is RESTRICTED (422 ' +
      'otherwise). The owner cannot invite itself (422); the same organization twice is 409 ' +
      'ALREADY_EXISTS. The invited organization must exist: it is confirmed with ' +
      'organization-service (422 INVITED_ORGANIZATION_NOT_FOUND if not; 503/504 if it cannot be ' +
      'confirmed — nothing is invited unconfirmed). Eligibility to bid (qualified, not suspended) is ' +
      'not judged here but at bid time. ' +
      `Publishes TENDER_BIDDER_INVITED. ${TENANT_NOTE} ${ROLES_NOTE}`,
  })
  async invite(@Param('id') id: string, @Body(zodPipe(inviteBidderSchema)) dto: InviteBidderDto) {
    return this.publication.invite(id, dto);
  }

  @Get('tenders/:id/invitations')
  @ApiOperation({
    summary: "List a tender's invitations, oldest first",
    description: `${TENANT_NOTE} ${ROLES_NOTE}`,
  })
  async listInvitations(
    @Param('id') id: string,
    @Query(zodPipe(listInvitationsQuerySchema)) query: ListInvitationsQuery,
  ) {
    return this.publication.listInvitations(id, query);
  }
}
