import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createTenantGuardExtension } from '@rasta/nest-common';
import { PrismaClient } from '../generated/prisma';

/**
 * Models carrying an `organizationId` and therefore scoped automatically
 * (AGENTS.md A-04).
 *
 * Listed explicitly, because the two directions of a mistake are not
 * symmetrical: a model wrongly listed produces an immediate query error, while
 * a model wrongly omitted produces a silent cross-tenant read.
 * `tenant-scope.spec.ts` derives the expected list from `schema.prisma`, so an
 * omission fails a unit test rather than passing review.
 */
export const TENANT_SCOPED_MODELS = [
  'Project',
  'ProjectNeed',
  'IdempotencyKey',
  'ApprovalPolicy',
  'ApprovalPolicyStep',
  'Approval',
  'ProgressReport',
] as const;

/**
 * Models that carry an organization column and are still not guarded.
 *
 * `OutboxMessage` is the platform's standing exception: the outbox is plumbing
 * drained by a relay that has no request context, and it carries its own tenant
 * column for filtering. The same exception every other service makes.
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
          // Every deliberate boundary crossing is recorded with its written
          // reason, so an auditor can enumerate them (ADR-011).
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

  /** Liveness of the database, for the readiness probe. Never throws. */
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
   * The outbox pattern requires the state change and the outbox insert to
   * share one transaction (AGENTS.md A-08, ADR-021).
   */
  transaction<T>(fn: (tx: ExtendedPrismaClient) => Promise<T>): Promise<T> {
    return this.client.$transaction((tx) => fn(tx as ExtendedPrismaClient));
  }
}
