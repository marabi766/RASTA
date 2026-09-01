import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, zodPipe } from '@rasta/nest-common';
import { ApiQueryFromSchema } from '../openapi/query-parameters';
import { AssetService } from './asset.service';
import { InsuranceService } from '../insurance/insurance.service';
import {
  activateAssetSchema,
  attachDocumentSchema,
  changeStatusSchema,
  createAssetSchema,
  createInspectionSchema,
  createPolicySchema,
  decommissionSchema,
  listAssetsQuerySchema,
  nearbyQuerySchema,
  recordLocationSchema,
  timelineQuerySchema,
  transferAssetSchema,
  updateAssetSchema,
  type ActivateAssetDto,
  type AttachDocumentDto,
  type ChangeStatusDto,
  type CreateAssetDto,
  type CreateInspectionDto,
  type CreatePolicyDto,
  type DecommissionDto,
  type ListAssetsQuery,
  type NearbyQuery,
  type RecordLocationDto,
  type TimelineQuery,
  type TransferAssetDto,
  type UpdateAssetDto,
} from './dto';

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

  // ---- Writes -------------------------------------------------------------

  @Post()
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({ summary: 'Register an asset' })
  create(@Body(zodPipe(createAssetSchema)) dto: CreateAssetDto) {
    return this.assets.create(dto);
  }

  @Patch(':id')
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({ summary: 'Update an asset' })
  update(@Param('id') id: string, @Body(zodPipe(updateAssetSchema)) dto: UpdateAssetDto) {
    return this.assets.update(id, dto);
  }

  @Post(':id/activate')
  @HttpCode(200)
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({ summary: 'Commission the asset; requires a complete dossier' })
  activate(@Param('id') id: string, @Body(zodPipe(activateAssetSchema)) dto: ActivateAssetDto) {
    return this.assets.activate(id, dto);
  }

  @Post(':id/status')
  @HttpCode(200)
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({ summary: 'Change operational status' })
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
  @ApiOperation({ summary: 'Retire the asset permanently' })
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
}
