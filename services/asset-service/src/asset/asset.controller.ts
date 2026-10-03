import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, zodPipe } from '@rasta/nest-common';
import { ApiQueryFromSchema } from '../openapi/query-parameters';
import {
  ACTIVATE_ASSET_BODY_SCHEMA,
  CHANGE_STATUS_BODY_SCHEMA,
  DECOMMISSION_BODY_SCHEMA,
} from '../openapi/lifecycle-bodies';
import { UPDATE_ASSET_BODY_SCHEMA } from '../openapi/update-asset-body';
import { AssetService } from './asset.service';
import { IdempotencyStore, requiredIdempotencyKey } from './idempotency';
import { InsuranceService } from '../insurance/insurance.service';
import { ClaimService } from '../insurance/claim.service';
import {
  activateAssetSchema,
  attachDocumentSchema,
  changeStatusSchema,
  createAssetSchema,
  createInspectionSchema,
  createPolicySchema,
  decideClaimSchema,
  decommissionSchema,
  listAssetsQuerySchema,
  nearbyQuerySchema,
  recordClaimSettlementSchema,
  recordLocationSchema,
  reviewClaimSchema,
  submitClaimSchema,
  timelineQuerySchema,
  transferAssetSchema,
  updateAssetSchema,
  type ActivateAssetDto,
  type AttachDocumentDto,
  type ChangeStatusDto,
  type AssetView,
  type CreateAssetDto,
  type CreateInspectionDto,
  type CreatePolicyDto,
  type DecideClaimDto,
  type DecommissionDto,
  type ListAssetsQuery,
  type NearbyQuery,
  type RecordClaimSettlementDto,
  type RecordLocationDto,
  type ReviewClaimDto,
  type SubmitClaimDto,
  type TimelineQuery,
  type TransferAssetDto,
  type UpdateAssetDto,
} from './dto';

/** The route template an Idempotency-Key is stored under (#169). */
export const CREATE_ASSET_ENDPOINT = 'POST /v1/assets';

/**
 * HTTP surface for assets.
 *
 * Controllers bind the route, validate the payload and delegate. Every
 * decision that depends on *which* asset is being touched lives in the
 * service, because only the service knows the asset's state (AGENTS.md A-10).
 *
 * Note what is absent: no endpoint sets ASSIGNED or IN_MAINTENANCE. Those
 * states are owned by fleet-service and maintenance-service and arrive as
 * events. Offering them here would let two services disagree about whether a
 * machine is in the workshop.
 */
@ApiTags('assets')
@Controller({ path: 'assets', version: '1' })
export class AssetController {
  constructor(
    private readonly assets: AssetService,
    private readonly insurance: InsuranceService,
    private readonly claims: ClaimService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  // ---- Reads --------------------------------------------------------------

  @Get()
  @ApiOperation({ summary: 'List assets in the requesting organization' })
  list(@Query(zodPipe(listAssetsQuerySchema)) query: ListAssetsQuery) {
    return this.assets.list(query);
  }

  @Get('nearby')
  @ApiOperation({ summary: 'Assets within a radius, nearest first' })
  @ApiQueryFromSchema(nearbyQuerySchema)
  nearby(@Query(zodPipe(nearbyQuerySchema)) query: NearbyQuery) {
    return this.assets.nearby(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one asset' })
  get(@Param('id') id: string) {
    return this.assets.get(id);
  }

  @Get(':id/dossier')
  @ApiOperation({
    summary: 'The electronic dossier — identity, compliance, costs and recent activity',
  })
  dossier(@Param('id') id: string) {
    return this.assets.dossier(id);
  }

  @Get(':id/timeline')
  @ApiOperation({ summary: 'Full history, newest first' })
  timeline(@Param('id') id: string, @Query(zodPipe(timelineQuerySchema)) query: TimelineQuery) {
    return this.assets.timeline(id, query);
  }

  @Get(':id/insurance-policies')
  @ApiOperation({ summary: 'Insurance policies on this asset' })
  policies(@Param('id') id: string) {
    return this.insurance.listPolicies(id);
  }

  @Get(':id/inspections')
  @ApiOperation({ summary: 'Technical inspections on this asset' })
  inspections(@Param('id') id: string) {
    return this.insurance.listInspections(id);
  }

  @Get(':id/insurance-claims')
  @ApiOperation({ summary: 'Insurance claims on this asset, newest incident first' })
  claimList(@Param('id') id: string) {
    return this.claims.listClaims(id);
  }

  @Get(':id/insurance-claims/:claimId')
  @ApiOperation({ summary: 'One claim, with the history of every status it has been in' })
  claim(@Param('id') id: string, @Param('claimId') claimId: string) {
    return this.claims.getClaim(id, claimId);
  }

  // ---- Writes -------------------------------------------------------------

  @Post()
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Register an asset',
    description:
      'Requires an `Idempotency-Key` (#169): without one, or with one outside 8 to 255 ' +
      'characters, 400 VALIDATION_FAILED and nothing is registered. The same key with the ' +
      'same body from the same user answers the original 201 — the same asset id — without ' +
      'registering or publishing anything again, for 24 hours by default; the same key with a ' +
      'different body or from another user answers 409 IDEMPOTENCY_KEY_REUSED; a duplicate ' +
      'that arrives while the first is still being processed waits for its answer, and past ' +
      'a few seconds answers 409 CONFLICT with Retry-After.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      '8 to 255 characters. Scoped to the organization: the same key in two organizations ' +
      'is two requests.',
  })
  async create(
    @Body(zodPipe(createAssetSchema)) dto: CreateAssetDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<AssetView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const { result } = await this.idempotency.execute<AssetView>(
      CREATE_ASSET_ENDPOINT,
      key,
      dto,
      201,
      (fence) => this.assets.create(dto, fence),
    );
    return result;
  }

  @Patch(':id')
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Update an asset',
    description:
      '`expectedVersion` is **required**: the `version` the caller read. The update applies only ' +
      'to that version (`UPDATE … WHERE version = ?`); if the asset has changed since, the ' +
      'answer is `409 OPTIMISTIC_LOCK_FAILED` and nothing is written, so an edit made from an ' +
      'old screen cannot restore values somebody else has since changed. A body without it is ' +
      '`400`: a caller that does not know the version cannot know what it overwrites. ' +
      'Only fields whose value differs from the stored one are written and listed in ' +
      '`ASSET_UPDATED.changedFields`; an update that changes nothing writes nothing, publishes ' +
      'nothing and answers with the asset as it is. `null` clears an optional field. ' +
      'Returns 404 for an asset in another organization — never 403 — whatever version is sent.',
  })
  @ApiBody({ schema: UPDATE_ASSET_BODY_SCHEMA })
  update(@Param('id') id: string, @Body(zodPipe(updateAssetSchema)) dto: UpdateAssetDto) {
    return this.assets.update(id, dto);
  }

  @Post(':id/activate')
  @HttpCode(200)
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Commission the asset; requires a complete dossier',
    description:
      'REGISTERED → ACTIVE. `expectedVersion` is **required**: the `version` the caller read. ' +
      'The command applies only to that version; if the asset has changed since — including by ' +
      'this same command having already been applied — the answer is `409 OPTIMISTIC_LOCK_FAILED` ' +
      'and nothing is written or published. A body without it is `400`. Returns 404 for an asset ' +
      'in another organization — never 403 — whatever version is sent.',
  })
  @ApiBody({ schema: ACTIVATE_ASSET_BODY_SCHEMA })
  activate(@Param('id') id: string, @Body(zodPipe(activateAssetSchema)) dto: ActivateAssetDto) {
    return this.assets.activate(id, dto);
  }

  @Post(':id/status')
  @HttpCode(200)
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Change operational status',
    description:
      'Moves the asset to ACTIVE, IDLE or OUT_OF_SERVICE where the lifecycle allows it, with a ' +
      'reason that is recorded on the event and the timeline. `expectedVersion` is **required**: ' +
      'the `version` the caller read. The command applies only to that version; if the asset has ' +
      'changed since — including by this same command having already been applied — the answer ' +
      'is `409 OPTIMISTIC_LOCK_FAILED` and nothing is written or published. A body without it is ' +
      '`400`. Returns 404 for an asset in another organization — never 403 — whatever version ' +
      'is sent.',
  })
  @ApiBody({ schema: CHANGE_STATUS_BODY_SCHEMA })
  changeStatus(@Param('id') id: string, @Body(zodPipe(changeStatusSchema)) dto: ChangeStatusDto) {
    return this.assets.changeStatus(id, dto);
  }

  @Post(':id/transfer')
  @HttpCode(200)
  // Transferring ownership moves an asset out of the organization entirely,
  // so it sits above a fleet manager.
  @Roles('ORGANIZATION_ADMIN', 'UNION_ADMIN')
  @ApiOperation({ summary: 'Transfer ownership; identity and history are preserved' })
  transfer(@Param('id') id: string, @Body(zodPipe(transferAssetSchema)) dto: TransferAssetDto) {
    return this.assets.transfer(id, dto);
  }

  @Post(':id/decommission')
  @HttpCode(200)
  @Roles('ORGANIZATION_ADMIN', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Retire the asset permanently',
    description:
      'Terminal: a decommissioned asset keeps its row and can never change status again. ' +
      '`expectedVersion` is **required**: the `version` the caller read. The command applies ' +
      'only to that version; if the asset has changed since — including by this same command ' +
      'having already been applied — the answer is `409 OPTIMISTIC_LOCK_FAILED` and nothing is ' +
      'written or published. A body without it is `400`. Returns 404 for an asset in another ' +
      'organization — never 403 — whatever version is sent.',
  })
  @ApiBody({ schema: DECOMMISSION_BODY_SCHEMA })
  decommission(@Param('id') id: string, @Body(zodPipe(decommissionSchema)) dto: DecommissionDto) {
    return this.assets.decommission(id, dto);
  }

  @Post(':id/locations')
  // An operator in the field is exactly who should be recording position.
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'OPERATOR', 'DRIVER', 'UNION_ADMIN')
  @ApiOperation({ summary: 'Record the current location' })
  recordLocation(
    @Param('id') id: string,
    @Body(zodPipe(recordLocationSchema)) dto: RecordLocationDto,
  ) {
    return this.assets.recordLocation(id, dto);
  }

  @Post(':id/documents')
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({ summary: 'Attach a document held by document-service' })
  attachDocument(
    @Param('id') id: string,
    @Body(zodPipe(attachDocumentSchema)) dto: AttachDocumentDto,
  ) {
    return this.assets.attachDocument(id, dto);
  }

  @Post(':id/insurance-policies')
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({ summary: 'Record an insurance policy' })
  recordPolicy(@Param('id') id: string, @Body(zodPipe(createPolicySchema)) dto: CreatePolicyDto) {
    return this.insurance.recordPolicy(id, dto);
  }

  @Post(':id/inspections')
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({ summary: 'Record a technical inspection' })
  recordInspection(
    @Param('id') id: string,
    @Body(zodPipe(createInspectionSchema)) dto: CreateInspectionDto,
  ) {
    return this.insurance.recordInspection(id, dto);
  }

  // ---- Claims -------------------------------------------------------------
  //
  // Filing and reviewing a claim sit with the same roles that record the
  // policy. Deciding it, and recording that it was settled, do not carry a
  // static @Roles: the deciding authority is configuration
  // (INSURANCE_CLAIM_DECISION_ROLES, docs/24 Q-59), and ClaimService enforces
  // it before reading the claim. A static list here would either duplicate
  // that configuration or contradict it.

  @Post(':id/insurance-claims')
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({ summary: 'File a claim against one of this asset’s policies' })
  submitClaim(@Param('id') id: string, @Body(zodPipe(submitClaimSchema)) dto: SubmitClaimDto) {
    return this.claims.submitClaim(id, dto);
  }

  @Post(':id/insurance-claims/:claimId/review')
  @HttpCode(200)
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({ summary: 'Take the claim under review' })
  reviewClaim(
    @Param('id') id: string,
    @Param('claimId') claimId: string,
    @Body(zodPipe(reviewClaimSchema)) dto: ReviewClaimDto,
  ) {
    return this.claims.startReview(id, claimId, dto);
  }

  @Post(':id/insurance-claims/:claimId/decision')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve or reject the claim — the configured deciding roles only (Q-59)',
  })
  decideClaim(
    @Param('id') id: string,
    @Param('claimId') claimId: string,
    @Body(zodPipe(decideClaimSchema)) dto: DecideClaimDto,
  ) {
    return this.claims.decide(id, claimId, dto);
  }

  @Post(':id/insurance-claims/:claimId/settlement')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Record that an approved claim was settled elsewhere. No money moves here (ADR-046).',
  })
  recordClaimSettlement(
    @Param('id') id: string,
    @Param('claimId') claimId: string,
    @Body(zodPipe(recordClaimSettlementSchema)) dto: RecordClaimSettlementDto,
  ) {
    return this.claims.recordSettlement(id, claimId, dto);
  }
}
