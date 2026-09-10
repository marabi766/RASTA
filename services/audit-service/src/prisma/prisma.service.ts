import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma';

/**
 * The audit database client.
 *
 * ## No tenant-guard extension, and the reason is not an oversight
 *
 * Every other service in this repository wraps its client in
 * `createTenantGuardExtension` so a query without an organization scope cannot
 * reach tenant rows (AGENTS.md A-04). audit-service does not, and AUD-002 —
 * which added the read path the guard was being saved for — is where that had
 * to be decided rather than deferred again. Two reasons, and neither is
 * "later":
 *
 *   1. **Both of this service's tenant-less accesses are legitimate.** The
 *      projector consumes every organization's events, and ADR-053 § 5 makes
 *      `organizationId` nullable on purpose for genuinely platform-scoped
 *      actions. A guard would refuse exactly those rows on the way in, and an
 *      audit store that drops evidence because it carries no tenant is worse
 *      than one with no guard. On the way out, `SYSTEM_ADMIN` is defined by
 *      ADR-053 § 10 as the role that may read them.
 *
 *   2. **The read path scopes itself, earlier and more strictly than a guard
 *      could.** `AuditQueryService` resolves scope from the **verified token**
 *      before a filter is looked at, and `AuditRepository` puts
 *      `organization_id = $1` — one value, never a list, never
 *      `OR organization_id IS NULL` — into the `WHERE` of every read a
 *      non-platform caller reaches. A guard checking "was some organization
 *      filter present" would accept a filter the caller supplied; this does
 *      not read the caller's filter as authority at all.
 *
 * Written down here rather than left to be noticed, because "this service has
 * no tenant guard" is otherwise exactly the kind of absence that reads as a bug
 * years later. The tenant isolation it replaces is asserted against real
 * PostgreSQL in `test/tenant-isolation.int-spec.ts`.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  readonly client: PrismaClient;

  constructor(databaseUrl: string) {
    this.client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }

  /**
   * Whether the database is reachable *and this role still holds every
   * privilege both of the service's paths need*.
   *
   * `SELECT 1` would answer the first half only. A connection that can read but
   * has lost INSERT — a botched grant, a role change — is not ready, however
   * healthy it looks, and the failure surfaces only as ingestion silently
   * erroring behind a probe that keeps reporting ready.
   *
   * Since AUD-002 this service both ingests and is read, so readiness asks
   * about both paths rather than about the write alone:
   *
   *   `audit_event`      INSERT — the projector's whole job (AUD-001).
   *                      SELECT — the query API's whole job (AUD-002).
   *
   *   `organization_ref` SELECT — the recursive subtree walk that decides
   *                               `UNION_ADMIN` scope. Without it every union
   *                               administrator is refused their own subtree.
   *                      INSERT — the tenant upsert on ingest and the rows the
   *                               hierarchy projection creates.
   *                      UPDATE — the `ON CONFLICT DO UPDATE` branch of the
   *                               same projection.
   *
   * The check asks the catalogue rather than attempting a write, so a probe
   * never leaves a row behind — which matters more here than elsewhere: a
   * mutating probe against an append-only evidence store would write rows
   * nobody can delete.
   *
   * `has_table_privilege` raises `42P01` when a table is missing, so a database
   * that has not been migrated fails readiness through the `catch` rather than
   * reporting ready with nothing to write into.
   */
  async isHealthy(): Promise<boolean> {
    try {
      const rows = await this.client.$queryRaw<{ ok: boolean }[]>`
        SELECT has_table_privilege(current_user, 'audit_event', 'INSERT')
           AND has_table_privilege(current_user, 'audit_event', 'SELECT')
           AND has_table_privilege(current_user, 'organization_ref', 'SELECT')
           AND has_table_privilege(current_user, 'organization_ref', 'INSERT')
           AND has_table_privilege(current_user, 'organization_ref', 'UPDATE') AS ok
      `;
      return rows[0]?.ok === true;
    } catch {
      return false;
    }
  }
}
