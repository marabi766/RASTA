import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createTenantGuardExtension } from '@rasta/nest-common';
import { PrismaClient } from '../generated/prisma';

/**
 * Models in this service that carry an `organizationId` and must therefore be
 * tenant-scoped automatically.
 *
 * Listed explicitly, because the two directions of a mistake are not
 * symmetrical: a model wrongly listed produces an immediate, obvious query
 * error, while a model wrongly omitted produces a silent cross-tenant read.
 * Explicit listing makes the safe direction the default.
 *
 * `User` is absent on purpose — identity spans organizations, and a user is
 * reached through their memberships (see prisma/schema.prisma).
 * `Role`, `Permission` and `OrganizationRef` are platform-wide reference data.
 */
export const TENANT_SCOPED_MODELS = ['Membership', 'IdempotencyKey'] as const;

/**
 * Models that carry an `organization_id` column and are deliberately **not** guarded, each
 * with the reason. Named rather than left out, so `tenant-scope.spec.ts` can hold the
 * guarded list against the Prisma schema exactly: an exemption has to be written down
 * to exist, and one without a reason fails that spec.
 */
export const TENANT_SCOPE_EXEMPTIONS = {
  OutboxMessage:
    'The outbox relay drains this table across every tenant with no request context, and each row names its own organization_id: platform plumbing, filtered by that column rather than by the guard.',
  SecurityEventOutbox:
    'Refusals awaiting delivery to the audit trail (ADR-053 § 4): written by the exception filter in its own short transaction and drained across tenants by a second relay; every row names its own organization_id explicitly.',
} as const satisfies Readonly<Record<string, string>>;

export type ExtendedPrismaClient = ReturnType<PrismaService['buildClient']>;

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly base: PrismaClient;

  /** The client every repository uses. Tenant scoping is already applied. */
  readonly client: ExtendedPrismaClient;

  constructor(databaseUrl: string) {
    this.base = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
    this.client = this.buildClient();
  }

  private buildClient() {
    return this.base.$extends(
      createTenantGuardExtension({
        scopedModels: TENANT_SCOPED_MODELS,
        onUnscopedQuery: ({ model, operation, reason }) => {
          // Every deliberate boundary crossing is recorded, so an auditor can
          // enumerate them without reading the whole codebase.
          this.logger.warn(`Unscoped query on ${model}.${operation} — reason: ${reason}`);
        },
      }),
    );
  }

  async onModuleInit(): Promise<void> {
    await this.base.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.base.$disconnect();
  }

  /**
   * Liveness of the database dependency, for the readiness probe.
   * Returns false rather than throwing: an unhealthy dependency is a reported
   * state, not an exception.
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.base.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Runs `fn` inside a transaction.
   *
   * Exposed deliberately: the outbox pattern requires the state change and the
   * outbox insert to share one transaction, and that is the whole reason the
   * platform does not lose or invent events (ADR-021).
   */
  transaction<T>(
    fn: (tx: ExtendedPrismaClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T> {
    return this.client.$transaction((tx) => fn(tx as ExtendedPrismaClient), options);
  }
}
