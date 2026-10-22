import { Body, Controller, Get, Headers, HttpCode, Post } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePlatformUserId, zodPipe } from '@rasta/nest-common';
import { IdempotencyStore, requiredIdempotencyKey } from '../shared/idempotency';
import {
  recordAggregationSettingSchema,
  type AggregationSettingView,
  type RecordAggregationSettingDto,
} from './dto';
import { AggregationSettingService } from './setting.service';

export const RECORD_SETTING_ENDPOINT = 'POST /v1/aggregation-settings';

const SETTING_NOTE =
  'Closed by default (S-02). One setting for the whole organization, every product (Q-119 (3)). ' +
  'The buyer’s own organization only: the organization the request acts for. AUDITOR, the ' +
  'platform administrator (SYSTEM_ADMIN, whatever organization it selected — the operator does ' +
  'not write a tenant’s business configuration, Q-119 (2)) and a service token are refused (403) ' +
  'before anything is read.';

@ApiTags('aggregation-settings')
@Controller({ path: 'aggregation-settings', version: '1' })
export class AggregationSettingController {
  constructor(
    private readonly settings: AggregationSettingService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The caller organization’s aggregation settings in force for its next windows',
    description:
      'The current setting version, or the environment defaults of Q-10 (settingVersion and ' +
      'recordedAt null) if the organization has recorded none. A window keeps the settings it ' +
      'opened with; this is what the next one takes. The caller holds a role ' +
      'PROCUREMENT_AGGREGATION_SETTING_ROLES (default ORGANIZATION_ADMIN) or ' +
      `PROCUREMENT_DEMAND_ROLES names in the organization. ${SETTING_NOTE}`,
  })
  async current(): Promise<AggregationSettingView> {
    return this.settings.current();
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
    summary: 'Record a new version of the caller organization’s aggregation settings',
    description:
      'Appends the next version (versions are never edited; the next one replaces it). It ' +
      'applies to windows opened afterwards only: an OPEN window keeps its snapshot. ' +
      '`expectedCurrentVersion` is the version the caller saw in force (null: none); any other ' +
      'current version — another person recorded one meanwhile — is 409 OPTIMISTIC_LOCK_FAILED ' +
      'and nothing is written. windowHours 1 to 8760; minQuantity 0 to 2147483647 (a threshold ' +
      'above the most a window can hold would never be reached); shortfallPolicy EXTEND, REFER or ' +
      'CLOSE — otherwise 400 VALIDATION_FAILED. AGGREGATION_SETTING_CHANGED, the audit record, ' +
      'is written in the same transaction. The caller holds a role ' +
      'PROCUREMENT_AGGREGATION_SETTING_ROLES names (default ORGANIZATION_ADMIN); any other role is ' +
      `403 INSUFFICIENT_ROLE. ${SETTING_NOTE} Requires an \`Idempotency-Key\` (docs/06 § 6.8): ` +
      'the same key with the same body from the same user answers the original response and ' +
      'records nothing again; the same key with another body or user is 409 ' +
      'IDEMPOTENCY_KEY_REUSED.',
  })
  async record(
    @Body(zodPipe(recordAggregationSettingSchema)) dto: RecordAggregationSettingDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<AggregationSettingView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const { result } = await this.idempotency.execute<AggregationSettingView>(
      RECORD_SETTING_ENDPOINT,
      key,
      dto,
      201,
      (fence) => this.settings.record(dto, fence),
      async () => this.settings.assertMayRecord(),
    );
    return result;
  }
}
