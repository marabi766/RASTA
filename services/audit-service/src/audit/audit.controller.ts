import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Roles, zodPipe } from '@rasta/nest-common';
import { AUDIT_READER_ROLES } from '../access/access';
import { AuditQueryService } from './audit.query.service';
import { AuditVerificationService } from './audit.verification.service';
import { auditEventIdSchema } from './audit.query.dto';
import {
  AuditEventDetailQueryPipe,
  AuditEventQueryPipe,
  AuditVerifyQueryPipe,
} from './audit.query.pipes';
import type { AuditEventDetailQuery, AuditEventQuery, AuditVerifyQuery } from './audit.query.dto';
import type { AuditEventPage, AuditEventView } from './audit.view';
import type { AuditChainVerification } from './audit.verification.view';

/**
 * The read surface of the evidence store — three endpoints, and no fourth.
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
 * **AUD-003 does not change that, and specifically adds no correction route.**
 * ADR-053 § 7 requires a correction to enter through path B
 * (`rasta.audit.trail.v1`), which is AUD-004: this service has no producer, no
 * outbox and no write API, so the only way to record one today would be a
 * direct insert — the thing § 7 exists to forbid. `correctionOf` therefore
 * stays an inert column, and the correction half of AUD-003 is openly pending.
 *
 * ## Route order is load-bearing
 *
 * `verify` is declared **before** `:id`. Nest matches in declaration order, so
 * a static path declared after a parameter of the same depth is unreachable —
 * every request to `/v1/audit-events/verify` would be a lookup for a record
 * whose id happens to be the word "verify", and would answer `404` while
 * looking like the endpoint simply did not work.
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
  constructor(
    private readonly queries: AuditQueryService,
    private readonly verification: AuditVerificationService,
  ) {}

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

  // Declared before `:id`. See the note on route order in the class comment —
  // moving this below the parameterised route makes it unreachable, and the
  // failure looks like a 404 rather than like a routing mistake.
  @Get('verify')
  @ApiOperation({
    summary: 'Recompute a range of one audit hash chain and report the first divergence',
    description:
      'Walks one `(organization, UTC month)` chain — or the platform chain with ' +
      '`scope=PLATFORM` — in chain order and recomputes every link ' +
      '(ADR-053 § 6). `from` and `to` are mandatory and capped by ' +
      '`AUDIT_MAX_QUERY_WINDOW_DAYS`; a window whose contiguous chain walk would ' +
      'exceed `AUDIT_MAX_VERIFICATION_RECORDS` records is refused from row ' +
      'counts, before any record is read. Where a record exists before the ' +
      'window, the first link is checked ' +
      'against it, and `seededFromPredecessor` says whether that happened. ' +
      'Four outcomes: `VALID`, `DIVERGENT` (with `firstDivergence`), `EMPTY`, ' +
      'and `UNVERIFIABLE_LEGACY` for a window containing records written before ' +
      'the chain existed — those are never backfilled and never report valid. ' +
      'A `UNION_ADMIN` may verify their own organization or one the local ' +
      'hierarchy projection proves is beneath it; `scope=PLATFORM` is ' +
      '`SYSTEM_ADMIN` only, and a `SYSTEM_ADMIN` verifying a tenant must name ' +
      'it, because there is no chain that spans tenants. **This detects ' +
      'divergence; it is not a signature and not protection against a database ' +
      'superuser** (`docs/runbooks/audit-chain-divergence.md`).',
  })
  verify(@Query(AuditVerifyQueryPipe) query: AuditVerifyQuery): Promise<AuditChainVerification> {
    return this.verification.verify(query);
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
