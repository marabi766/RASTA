import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AllowService, zodPipe } from '@rasta/nest-common';
import { auditEventIdSchema } from './audit.query.dto';
import {
  AUDIT_TARGET_LOOKUP_CALLER,
  AuditTargetLookupService,
  auditTargetLookupQuerySchema,
  type AuditTargetLookupQuery,
  type AuditTargetView,
} from './audit.lookup';

/**
 * The internal correction-target lookup (AUD-003 correction). See `audit.lookup.ts`.
 *
 * Under `/v1/internal/…`, a first path segment the gateway routes nowhere, so it
 * is unreachable from outside the cluster by construction; `@AllowService`
 * and `assertTargetLookupCaller` close it inside. HTTP to DTO only.
 */
@ApiTags('audit-internal')
@Controller({ path: 'internal/audit-events', version: '1' })
export class AuditInternalController {
  constructor(private readonly lookups: AuditTargetLookupService) {}

  @Get(':id')
  @AllowService(AUDIT_TARGET_LOOKUP_CALLER)
  @ApiParam({
    name: 'id',
    description: 'The audit record’s own identifier.',
    schema: { type: 'string', maxLength: 64, pattern: '^[0-9A-Za-z_-]+$' },
  })
  @ApiOperation({
    summary: 'Prove a correction target exists, and name its scope (internal)',
    description:
      'Reserved for `identity-service`’s service token; every other service and every ' +
      'user token is refused. `occurredAt` is mandatory and must equal the target’s ' +
      'own instant, so the read touches exactly one partition. Returns only the id, ' +
      'the organization (`null` for a platform-scoped record) and the instant. A ' +
      'missing record and a mismatched instant both answer `404`.',
  })
  lookup(
    @Param('id', zodPipe(auditEventIdSchema)) id: string,
    @Query(zodPipe(auditTargetLookupQuerySchema)) query: AuditTargetLookupQuery,
  ): Promise<AuditTargetView> {
    return this.lookups.lookup(id, query.occurredAt);
  }
}
