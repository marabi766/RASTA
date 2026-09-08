import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma';

/**
 * The audit database client.
 *
 * ## No tenant-guard extension, and the reason is not an oversight
 *
 * Every other service in this repository wraps its client in
 * `createTenantGuardExtension` so a query without an organization scope cannot
 * reach tenant rows (AGENTS.md A-04). audit-service does not, for two reasons
 * that both stop being true at AUD-002:
 *
 *   1. **There is no read path.** AUD-001 exposes no endpoint that returns an
 *      audit row — the only routes are the health probes. A guard exists to
 *      stop tenant A reading tenant B's data through a query; there is no
 *      query.
 *
 *   2. **The writer is legitimately cross-tenant, and legitimately
 *      tenant-less.** The projector consumes every organization's events, and
 *      ADR-053 § 5 makes `organizationId` nullable on purpose for genuinely
 *      platform-scoped actions. A guard would refuse exactly those rows, and
 *      an audit store that drops evidence because it carries no tenant is
 *      worse than one with no guard.
 *
 * The guard belongs with AUD-002's query API, in the same change that adds the
 * first endpoint able to return a row. Written down here rather than left to be
 * noticed, because "this service has no tenant guard" is otherwise exactly the
 * kind of absence that reads as a bug years later.
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
   * Whether the database is reachable *and this role can still write*.
   *
   * `SELECT 1` would answer the first half only. The projector's whole job is
   * to insert, and a connection that can read but has lost INSERT — a botched
   * grant, a role change — is not ready, however healthy it looks. The check
   * asks the catalogue rather than attempting a write, so a probe never leaves
   * a row behind.
   */
  async isHealthy(): Promise<boolean> {
    try {
      const rows = await this.client.$queryRaw<{ ok: boolean }[]>`
        SELECT has_table_privilege(current_user, 'audit_event', 'INSERT') AS ok
      `;
      return rows[0]?.ok === true;
    } catch {
      return false;
    }
  }
}
