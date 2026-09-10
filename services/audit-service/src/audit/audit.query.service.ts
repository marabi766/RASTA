import { Inject, Injectable } from '@nestjs/common';
import { RastaError } from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import { AuditRepository, type AuditReadScope } from './audit.repository';
import { resolveCallerAuthority, type AuditCallerAuthority } from '../access/access';
import { encodeAuditCursor } from './audit.cursor';
import type { AuditEventDetailQuery, AuditEventQuery } from './audit.query.dto';
import { toAuditEventView, type AuditEventPage, type AuditEventView } from './audit.view';
import { resolveSubtreeTarget } from './audit.scope';
import {
  auditQueriesTotal,
  auditQueryRowsReturned,
  QUERY_ENDPOINTS,
  QUERY_OUTCOMES,
} from '../observability/metrics';
import { LOGGER } from '../tokens';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The audit read model: authority first, then evidence.
 *
 * ## The order of operations is the security property
 *
 * Scope is resolved from the **verified token** before a filter is looked at
 * and before the repository is reached. A caller cannot widen it, because the
 * only two inputs to the decision are the token's roles and the token's active
 * organization; `organizationId` in the query string is a *request* to narrow
 * or to target, never a grant. ADR-053 § 10 traces this to defect D-2, where
 * scope was read from a value the caller chooses.
 *
 * ## What `UNION_ADMIN` receives, and the wording it reconciles
 *
 * ADR-053 § 10 says a union administrator reaches "its own organization and its
 * subtree", and the implementation plan adds that it "must give a target within
 * it". Section 6.4 of the same plan then requires a search **without**
 * `organizationId` to succeed and to contain zero rows of another tenant. Taken
 * together the narrow reading is the only one that satisfies both, so it is the
 * one implemented:
 *
 *   no `organizationId`       the caller's own organization, exactly. Not the
 *                             subtree — the token names one organization, and
 *                             widening a silent default is how a convenience
 *                             becomes a disclosure.
 *   `organizationId` = own    the same, without consulting the projection.
 *   `organizationId` = other  allowed only if the projection proves it is a
 *                             descendant; otherwise `403`.
 *
 * Every one of those resolves to a single organization, so the query this
 * service issues is always `organization_id = $1`. That is stronger than a
 * subtree `IN` list: there is no set to get wrong, and a stale projection can
 * only ever refuse a target, never smuggle one into a result set.
 *
 * ## Where the fail-closed property actually lives
 *
 * The caller's authority over their **own** organization comes from the token
 * and never from the projection, so an empty or lagging projection degrades a
 * union administrator to their own organization — a missing result, never an
 * extra one. The projection is consulted only to *extend* authority beyond the
 * token's organization, and it extends nothing it cannot prove.
 */
@Injectable()
export class AuditQueryService {
  constructor(
    private readonly repository: AuditRepository,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async search(query: AuditEventQuery): Promise<AuditEventPage> {
    const authority = resolveCallerAuthority();
    const scope = await this.resolveScope(authority, query.organizationId);

    const page = await this.repository.search(scope, {
      from: query.from,
      to: query.to,
      actorId: query.actorId,
      actorType: query.actorType,
      action: query.action,
      resourceType: query.resourceType,
      resourceId: query.resourceId,
      correlationId: query.correlationId,
      outcome: query.outcome,
      limit: query.limit,
      cursor: query.cursor,
    });

    const items = page.rows.map(toAuditEventView);
    const last = page.rows.at(-1);

    this.record(QUERY_ENDPOINTS.SEARCH, authority, QUERY_OUTCOMES.OK, {
      returned: items.length,
      windowDays: windowDaysOf(query.from, query.to),
      hasMore: page.hasMore,
    });
    auditQueryRowsReturned.observe({ endpoint: QUERY_ENDPOINTS.SEARCH }, items.length);

    return {
      items,
      // Minted only when another page exists. A cursor handed out at the end of
      // a result set invites a client to loop forever on an empty page.
      nextCursor:
        page.hasMore && last
          ? encodeAuditCursor({ occurredAt: last.occurredAt, id: last.id })
          : null,
      hasMore: page.hasMore,
    };
  }

  /**
   * One record, or a `404` that is indistinguishable from an unknown id.
   *
   * Both "no such record" and "a record another tenant owns" end here, and both
   * answer the same way. A `403` for the second would confirm the record exists
   * — which is precisely the fact a caller outside its tenant must not learn
   * (`docs/06` § 6.7, ADR-011).
   */
  async findOne(id: string, query: AuditEventDetailQuery): Promise<AuditEventView> {
    const authority = resolveCallerAuthority();
    const scope = await this.resolveScope(authority, query.organizationId);

    const row = await this.repository.findById(scope, id, { from: query.from, to: query.to });

    if (!row) {
      this.record(QUERY_ENDPOINTS.DETAIL, authority, QUERY_OUTCOMES.NOT_FOUND, {
        returned: 0,
        windowDays: windowDaysOf(query.from, query.to),
        hasMore: false,
      });
      // No identifier in the message. `RastaError.notFound` keeps the id in
      // `internalContext`, which the exception filter logs and never serialises.
      throw RastaError.notFound('AuditEvent', id);
    }

    this.record(QUERY_ENDPOINTS.DETAIL, authority, QUERY_OUTCOMES.OK, {
      returned: 1,
      windowDays: windowDaysOf(query.from, query.to),
      hasMore: false,
    });

    return toAuditEventView(row);
  }

  /**
   * Turns the caller's authority and their requested target into the one
   * organization bound — or into a refusal.
   */
  private async resolveScope(
    authority: AuditCallerAuthority,
    requestedOrganizationId: string | undefined,
  ): Promise<AuditReadScope> {
    if (authority.kind === 'PLATFORM') {
      // Optional, and exact when present. Absent means every tenant *and* the
      // platform-scoped rows, which is the only place in this service where a
      // result may contain `organization_id IS NULL`.
      return { kind: 'PLATFORM', organizationId: requestedOrganizationId };
    }

    // The subtree rule lives in `audit.scope.ts` because the verification
    // endpoint (AUD-003) has to make the identical decision, and an
    // authorization rule with two copies is a rule with two chances to drift.
    const organizationId = await resolveSubtreeTarget(
      this.repository,
      authority,
      requestedOrganizationId,
    );
    return { kind: 'ORGANIZATION', organizationId };
  }

  /**
   * The one place a query is written down.
   *
   * ## Nothing that could identify a subject leaves this method
   *
   * Not an actor, not a resource, not a correlation id, not an organization,
   * not a token. ADR-053 § 13 draws the line for metrics, and `AGENTS.md` S-09
   * draws it for logs: a log aggregator has none of the audit store's access
   * controls, so "who searched for whom" written into it would be a second,
   * unprotected copy of the sensitive half of the question.
   *
   * What is recorded is shape — endpoint, how wide the caller's authority was,
   * the outcome, how many rows and how many days. Enough to see a scraper, and
   * not enough to be one.
   */
  private record(
    endpoint: (typeof QUERY_ENDPOINTS)[keyof typeof QUERY_ENDPOINTS],
    authority: AuditCallerAuthority,
    outcome: (typeof QUERY_OUTCOMES)[keyof typeof QUERY_OUTCOMES],
    detail: { returned: number; windowDays: number; hasMore: boolean },
  ): void {
    const scope = authority.kind === 'PLATFORM' ? 'platform' : 'subtree';
    auditQueriesTotal.inc({ endpoint, scope, outcome });
    this.logger.info(
      `audit query ${endpoint} scope=${scope} outcome=${outcome} ` +
        `rows=${detail.returned} windowDays=${detail.windowDays.toFixed(2)} ` +
        `hasMore=${detail.hasMore}`,
    );
  }
}

function windowDaysOf(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MILLISECONDS_PER_DAY;
}
