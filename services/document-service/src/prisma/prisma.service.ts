import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createTenantGuardExtension } from '@rasta/nest-common';
import { PrismaClient } from '../generated/prisma';

/**
 * Models carrying an `organizationId` and therefore scoped automatically.
 *
 * Listed explicitly, because the two directions of a mistake are not
 * symmetrical: a model wrongly listed produces an immediate, obvious query
 * error, while a model wrongly omitted produces a silent cross-tenant read.
 *
 * ## This list was another service's
 *
 * Until this change it named `Product`, `Offer`, `Order`, `OrderLine`,
 * `Fulfillment`, `Review` and the rest of marketplace-service's schema — not
 * one of which exists in this database. `createTenantGuardExtension` returns
 * the query untouched for any model it does not recognise, so the guard was
 * installed, logged nothing, and scoped **nothing**: every `Document`,
 * `UploadIntent` and `AccessGrant` query ran unfiltered, and every
 * `runUnscoped(...)` in the repository was a comment rather than a crossing.
 *
 * No cross-tenant read was reachable through it — `list` filters by
 * organization in the query itself, and the id lookups hand the row straight
 * to `access.ts`, which answers `404` for a stranger. So this fixes the
 * missing layer, not a live leak. But A-04 asks for the scope to be enforced
 * rather than remembered, and a defence that is inert while looking present is
 * worse than one that is absent: the next query written here would have been
 * checked by nobody.
 *
 * `OutboxMessage` is deliberately absent: the outbox is platform plumbing
 * written by a relay that has no request context, and it carries its own
 * tenant column for filtering. Same exception every other service makes, for
 * the same reason.
 */
export const TENANT_SCOPED_MODELS = ['Document', 'UploadIntent', 'AccessGrant'] as const;

/**
 * Models that carry an organization column and are still not guarded.
 *
 * Named rather than merely left out, so `tenant-scope.spec.ts` can compare the
 * guarded set against the schema exactly instead of allowing any omission. An
 * exemption has to be written down to exist.
 */
export const TENANT_SCOPE_EXEMPT_MODELS = ['OutboxMessage'] as const;

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
  transaction<T>(fn: (tx: ExtendedPrismaClient) => Promise<T>): Promise<T> {
    return this.client.$transaction((tx) => fn(tx as ExtendedPrismaClient));
  }
}
