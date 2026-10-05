import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { SERVICE_NAME } from '../config/env';
import {
  createTenantGuardExtension,
  assertRuntimeRole as assertConnectedRuntimeRole,
} from '@rasta/nest-common';
import { PrismaClient } from '../generated/prisma';

/**
 * Models carrying an `organizationId` and therefore scoped automatically.
 *
 * Listed explicitly, because the two directions of a mistake are not
 * symmetrical: a model wrongly listed produces an immediate, obvious query
 * error, while a model wrongly omitted produces a silent cross-tenant read.
 * In this service that read would be another organization's balances.
 *
 * ## The three models deliberately absent, and why
 *
 * `CommissionRule`, `RewardRule` and `RewardLevel` carry a **nullable**
 * `organizationId` where NULL means "platform-wide" (ADR-023). The guard
 * injects `organizationId = X`, which matches no global rule at all — so a
 * scoped lookup would silently find nothing and every transaction would be
 * charged zero commission. That is a financial defect, not a leak, but the
 * cure cannot be to scope them automatically.
 *
 * Instead their scoping is explicit and written once, in
 * `commission/commission.repository.ts` and `reward/reward.repository.ts`, as
 * `{ OR: [{ organizationId: null }, { organizationId }] }` — and
 * `tenant-isolation.int-spec.ts` proves that organization B cannot read
 * organization A's private rule.
 *
 * `OutboxMessage` and `ProcessedEvent` are platform plumbing written by
 * background workers with no request context, exactly as in every other
 * service.
 */
export const TENANT_SCOPED_MODELS = [
  'LedgerAccount',
  'Journal',
  'LedgerEntry',
  'Wallet',
  'WalletHold',
  'Transaction',
  'TransactionLeg',
  'PaymentIntent',
  'PaymentReconciliationTask',
  'PaymentReconciliationResolution',
  'PaymentReconciliationRequeue',
  'PaymentRefundDecline',
  'Commission',
  'Reward',
  'RewardSourceEvaluation',
  'RewardBalance',
  'Settlement',
  'IdempotencyKey',
] as const;

/**
 * Models that carry an `organization_id` column and are deliberately **not** guarded, each
 * with the reason. Named rather than left out, so `tenant-scope.spec.ts` can hold the
 * guarded list against the Prisma schema exactly: an exemption has to be written down
 * to exist, and one without a reason fails that spec.
 */
export const TENANT_SCOPE_EXEMPTIONS = {
  CommissionRule:
    "organization_id is nullable: a NULL row is a platform-wide rule that every tenant is matched against, and the guard's organization_id = X filter would hide it. Rule matching states the organization itself and is tested in commission.repository.ts.",
  RewardRule:
    "organization_id is nullable: a NULL row is a platform-wide rule that applies to every tenant, which the guard's organization_id = X filter would hide. Matching states the organization itself.",
  RewardLevel:
    "organization_id is nullable: a NULL row is a platform-wide level that applies to every tenant, which the guard's organization_id = X filter would hide. Level lookups state the organization themselves.",
  OutboxMessage:
    'The outbox relay drains this table across every tenant with no request context, and each row names its own organization_id: platform plumbing, filtered by that column rather than by the guard.',
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
          // Every deliberate boundary crossing is recorded. In a financial
          // service the list of them is something an auditor will ask for.
          this.logger.warn(`Unscoped query on ${model}.${operation} — reason: ${reason}`);
        },
      }),
    );
  }

  async onModuleInit(): Promise<void> {
    await this.base.$connect();
    this.logger.log('Database connection established');
  }

  /**
   * Refuses to run as anything but this service's runtime role (D-045): not a
   * superuser, not a migrator, owning nothing and holding no CREATE — what the
   * catalogue says about the role actually connected, so a DATABASE_URL that
   * names an owner is caught even though no *_MIGRATOR variable is set
   * (@rasta/nest-common runtime-role.ts; Codex review of #176).
   *
   * Called first in `AppModule.onModuleInit`. Not in `onModuleInit` here: the
   * integration suites open owner connections through this class on purpose.
   */
  async assertRuntimeRole(): Promise<void> {
    const facts = await assertConnectedRuntimeRole(this.base, {
      service: SERVICE_NAME,
      runtimeVariable: 'DATABASE_URL_ECONOMIC',
    });
    this.logger.log(
      `Connected as ${facts.role}: not a superuser or a migrator, owns nothing, no CREATE`,
    );
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
   * This is the most load-bearing method in the service. Three separate rules
   * depend on it:
   *
   *   - the outbox requires the state change and the outbox insert to share
   *     one transaction, or the platform loses or invents events (ADR-021);
   *   - a journal and the wallet balances it justifies must move together, or
   *     the ledger and the wallet drift (ADR-013);
   *   - settlement is one ACID transaction rather than a saga, precisely so
   *     that a failure leaves nothing to compensate (ADR-031).
   *
   * The timeout is raised above Prisma's 5s default because the settlement
   * path holds row locks on two wallets while it posts a journal, and under
   * the mandated 100-way concurrency test the last writer in the queue waits
   * for the 99 before it. A transaction timing out there would look like a
   * financial failure while being a test-harness artefact.
   */
  transaction<T>(fn: (tx: ExtendedPrismaClient) => Promise<T>): Promise<T> {
    return this.client.$transaction((tx) => fn(tx as ExtendedPrismaClient), {
      maxWait: 30_000,
      timeout: 60_000,
    });
  }
}
