import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Roles, zodPipe } from '@rasta/nest-common';
import { AUDIT_READER_ROLES } from '../access/access';
import { AuditQueryService } from './audit.query.service';
import { auditEventIdSchema } from './audit.query.dto';
import { AuditEventDetailQueryPipe, AuditEventQueryPipe } from './audit.query.pipes';
import type { AuditEventDetailQuery, AuditEventQuery } from './audit.query.dto';
import type { AuditEventPage, AuditEventView } from './audit.view';

/**
 * The read surface of the evidence store — two endpoints, and no third.
 *
 * ## There is no write endpoint, and its absence is the contract
 *
 * `docs/04` § 4.15 is explicit: "writing is from Kafka only". So there is no
 * `POST /v1/audit-events`, no export route yet, and no correction route yet.
 * A caller that posts here gets a `404` from the router, which is a structural
 * proof rather than a promise — `test/authorization.int-spec.ts` asserts it,
 * because "we did not add one" is a fact that stops being true the first time
 * somebody adds one for a migration script.
 *
 * ## `@Roles` names exactly two roles
 *
 * `SYSTEM_ADMIN` and `UNION_ADMIN` (ADR-053 § 10). `AUDITOR` is absent, and so
 * is `ORGANIZATION_ADMIN`; everything unlisted is closed by default because
 * `AuthGuard` and `RolesGuard` are registered globally (AGENTS.md S-02). The
 * service refuses `AUDITOR` twice more — at the gateway prefix and in
 * `assertNotAuditor()` — so a mistake in this decorator is caught rather than
 * shipped.
 *
 * ## No business logic here
 *
 * A pipe validates, a service authorises and reads, a mapper serialises
 * (AGENTS.md A-10). The controller's whole job is HTTP to DTO, which is why
 * both handlers are one line.
 */
@ApiTags('audit-events')
@Controller({ path: 'audit-events', version: '1' })
@Roles(...AUDIT_READER_ROLES)
export class AuditController {
  constructor(private readonly queries: AuditQueryService) {}

  @Get()
  @ApiOperation({
    summary: 'Search audit records within the caller’s authorised scope',
    description:
      '`from` and `to` are mandatory and the window is capped by ' +
      '`AUDIT_MAX_QUERY_WINDOW_DAYS` (default 90); a wider one is refused with ' +
      '`400 VALIDATION_FAILED` naming the configured limit, before any query runs. ' +
      'Ordered by `occurredAt` descending with `id` as a deterministic tie-breaker, ' +
      'paged by an opaque cursor that carries a position and no scope. ' +
      'A `SYSTEM_ADMIN` may omit `organizationId` and then sees every tenant plus ' +
      'platform-scoped records; a `UNION_ADMIN` who omits it sees their own ' +
      'organization only, and may name any organization the local hierarchy ' +
      'projection proves is beneath theirs. Records with no organization are never ' +
      'returned to a tenant-scoped caller.',
  })
  search(@Query(AuditEventQueryPipe) query: AuditEventQuery): Promise<AuditEventPage> {
    return this.queries.search(query);
  }

  @Get(':id')
  @ApiParam({
    name: 'id',
    description:
      'The audit record’s own identifier — a ULID this service minted, not the ' +
      'source event id. Bounded to the identifier alphabet, so an obviously ' +
      'impossible value costs a `400` rather than an index lookup.',
    schema: { type: 'string', maxLength: 64, pattern: '^[0-9A-Za-z_-]+$' },
  })
  @ApiOperation({
    summary: 'Read one audit record in full',
    description:
      '`from` and `to` are mandatory here too. `audit_event` is partitioned by ' +
      '`occurredAt` and its identity is `(occurredAt, id)`, so a lookup by id alone ' +
      'would scan every partition; the window lets the planner prune to the ones ' +
      'that can hold the record. A record outside the caller’s authorised scope ' +
      'answers `404`, exactly as an unknown id does, so its existence is never ' +
      'disclosed.',
  })
  findOne(
    @Param('id', zodPipe(auditEventIdSchema)) id: string,
    @Query(AuditEventDetailQueryPipe) query: AuditEventDetailQuery,
  ): Promise<AuditEventView> {
    return this.queries.findOne(id, query);
  }
}
