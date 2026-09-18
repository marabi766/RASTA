import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createTenantGuardExtension } from '@rasta/nest-common';
import { PrismaClient } from '../generated/prisma';

/**
 * Models carrying an `organizationId` and therefore scoped automatically
 * (AGENTS.md A-04).
 *
 * Listed explicitly, because the two directions of a mistake are not
 * symmetrical: a model wrongly listed produces an immediate, obvious query
 * error, while a model wrongly omitted produces a silent cross-tenant read.
 * `tenant-scope.spec.ts` compares this list against the schema so an omission
 * fails a test rather than passing review.
 *
 * Every domain model carries the column, including the children —
 * `RecipientResolution`, `DeliveryAttempt`, `InAppNotification` — that could
 * have reached it through a join. The column is denormalised precisely so the
 * guard can see it: a guard that has to join is a guard that does not run on
 * a `findMany`.
 */
export const TENANT_SCOPED_MODELS = [
  'NotificationIntent',
  'NotificationDedupe',
  'RecipientResolution',
  'NotificationDelivery',
  'DeliveryAttempt',
  'InAppNotification',
] as const;

/**
 * Models that carry no organization column and are therefore not guarded.
 *
 * Named rather than merely left out, so the spec can compare the guarded set
 * against the schema exactly. `ProcessedEvent` is keyed by
 * `(eventId, consumerName)` alone: an idempotency marker for a message, not a
 * tenant row.
 */
export const TENANT_SCOPE_EXEMPT_MODELS = ['ProcessedEvent'] as const;

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
          // reason, so an auditor can enumerate them without reading the whole
          // codebase (ADR-011).
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
   * Whether the database is reachable and migrated, for the readiness probe.
   *
   * `has_table_privilege` raises when the table is missing, so a database that
   * has not been migrated fails readiness through the `catch` rather than
   * reporting ready with nothing to write into. Asked of the catalogue rather
   * than by attempting a write, so a probe never leaves a row behind.
   */
  async isHealthy(): Promise<boolean> {
    try {
      const rows = await this.base.$queryRaw<{ ok: boolean }[]>`
        SELECT has_table_privilege(current_user, 'notification_intent', 'INSERT')
           AND has_table_privilege(current_user, 'in_app_notification', 'SELECT') AS ok
      `;
      return rows[0]?.ok === true;
    } catch {
      return false;
    }
  }

  /**
   * Runs `fn` inside a transaction.
   *
   * The consumer's write — idempotency marker, dedupe decision, intent — and
   * the worker's write — fenced claim, snapshot, deliveries, in-app rows — are
   * each one transaction, which is the whole reason a duplicate has no second
   * effect (AGENTS.md A-09).
   */
  transaction<T>(
    fn: (tx: ExtendedPrismaClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T> {
    return this.client.$transaction((tx) => fn(tx as ExtendedPrismaClient), options);
  }
}
