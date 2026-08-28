import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import {
  AllExceptionsFilter,
  AuthGuard,
  AUTH_OPTIONS,
  EventConsumer,
  EXCEPTION_FILTER_LOGGER,
  InternalTokenService,
  OutboxRelay,
  RequestContextMiddleware,
  RolesGuard,
  TokenVerifier,
  toLogContext,
  type AuthGuardOptions,
} from '@rasta/nest-common';
import { createLogger, setLogContextProvider, type Logger } from '@rasta/logging';
import { outboxPendingAgeSeconds, outboxPendingTotal } from '@rasta/observability';
import { PrismaService } from './prisma/prisma.service';
import { PrismaOutboxStore } from './outbox/outbox.store';
import { KafkaEventPublisher } from './outbox/kafka.publisher';
import { LedgerRepository } from './ledger/ledger.repository';
import { LedgerService } from './ledger/ledger.service';
import { LedgerController } from './ledger/ledger.controller';
import { WalletRepository } from './wallet/wallet.repository';
import { WalletService } from './wallet/wallet.service';
import { WalletController } from './wallet/wallet.controller';
import { LedgerBalanceAudit } from './wallet/balance-audit';
import { TransactionRepository } from './transaction/transaction.repository';
import { TransactionService } from './transaction/transaction.service';
import { TransactionController } from './transaction/transaction.controller';
import { CommissionService } from './commission/commission.service';
import { CommissionController } from './commission/commission.controller';
import { RewardService } from './reward/reward.service';
import { RewardController } from './reward/reward.controller';
import { PaymentService } from './payment/payment.service';
import { PaymentController } from './payment/payment.controller';
import { MockPaymentProvider } from './payment/mock.provider';
import { SettlementService } from './settlement/settlement.service';
import { SettlementController } from './settlement/settlement.controller';
import { IdempotencyStore } from './shared/idempotency';
import { SettlementAuthorityConsumer } from './consumers/settlement-authority.consumer';
import { RewardTriggerConsumer } from './consumers/reward-trigger.consumer';
import { transactionsDisputed, transactionsPendingSettlement } from './observability/metrics';
import { HealthController, MetricsController } from './health/health.controller';
import { ENV, LOGGER, PAYMENT_PROVIDER } from './tokens';
import { ECONOMIC_DLQ_TOPIC, loadEconomicEnv, SERVICE_NAME, type EconomicEnv } from './config/env';

/**
 * Topics this service reads, and why they are two subscriptions rather than
 * one.
 *
 * The two consumers do different jobs that fail differently, and docs/07 §
 * 7.10 asks for one consumer group per (service, purpose):
 *
 *   settlement-authority  `rasta.maintenance.v1` — MAINTENANCE_APPROVED, the
 *                         product document's mandatory control before
 *                         settlement. Losing one means a workshop is never
 *                         paid.
 *   reward-trigger        `rasta.fleet.v1` and `rasta.maintenance.v1` — the
 *                         behaviours that earn points. Losing one means a
 *                         missed reward.
 *
 * Sharing a group would put the financial control behind the same lag, the
 * same dead-letter topic and the same offset as the reward stream, so a
 * misconfigured reward rule could delay an approval that authorises money.
 *
 * Both read from the beginning. A financial service that only knows about
 * approvals issued after it was first deployed would silently owe a workshop
 * nothing for every repair approved before that.
 */
const MAINTENANCE_TOPICS = ['rasta.maintenance.v1'];
const REWARD_TRIGGER_TOPICS = ['rasta.fleet.v1', 'rasta.maintenance.v1'];

// A note on the three providers nothing below injects — the two consumers and
// `LedgerBalanceAudit`. Nest instantiates every provider a module declares, so
// their `onModuleInit` runs and they subscribe and start their timer without
// anyone holding a reference. Injecting them into `AppModule` purely to keep
// them alive would be a lie about the dependency.

@Module({
  controllers: [
    WalletController,
    LedgerController,
    TransactionController,
    SettlementController,
    CommissionController,
    RewardController,
    PaymentController,
    HealthController,
    MetricsController,
  ],
  providers: [
    { provide: ENV, useFactory: () => loadEconomicEnv() },

    {
      provide: LOGGER,
      inject: [ENV],
      useFactory: (env: EconomicEnv): Logger => {
        const logger = createLogger({
          serviceName: SERVICE_NAME,
          serviceVersion: env.SERVICE_VERSION,
          environment: env.NODE_ENV,
          level: env.LOG_LEVEL,
          pretty: env.NODE_ENV === 'development',
        });
        setLogContextProvider(() => toLogContext());
        return logger;
      },
    },
    { provide: EXCEPTION_FILTER_LOGGER, inject: [LOGGER], useFactory: (l: Logger) => l },

    {
      provide: PrismaService,
      inject: [ENV],
      useFactory: (env: EconomicEnv) => new PrismaService(env.DATABASE_URL),
    },

    {
      provide: KafkaEventPublisher,
      inject: [ENV],
      useFactory: (env: EconomicEnv) =>
        new KafkaEventPublisher({
          brokers: brokersOf(env),
          clientId: env.KAFKA_CLIENT_ID,
        }),
    },

    PrismaOutboxStore,
    IdempotencyStore,

    LedgerRepository,
    LedgerService,
    WalletRepository,
    WalletService,
    TransactionRepository,
    TransactionService,
    CommissionService,
    RewardService,
    PaymentService,
    SettlementService,
    LedgerBalanceAudit,

    /**
     * The payment provider (ADR-024).
     *
     * Bound to a token rather than to a class, so the domain knows only the
     * interface. Adding a real provider is a new class and one more branch
     * here — the ledger, the wallet and the transaction lifecycle do not
     * change. `ECONOMIC_PAYMENT_PROVIDER` is validated to `mock` at boot, so
     * an environment that expected a real provider fails loudly rather than
     * falling back to a simulation.
     */
    {
      provide: PAYMENT_PROVIDER,
      inject: [ENV],
      useFactory: (env: EconomicEnv) =>
        new MockPaymentProvider(env.ECONOMIC_MOCK_PAYMENT_LATENCY_MS),
    },

    {
      provide: SettlementAuthorityConsumer,
      inject: [ENV, LOGGER, PrismaService, TransactionService],
      useFactory: (
        env: EconomicEnv,
        logger: Logger,
        prisma: PrismaService,
        transactions: TransactionService,
      ) =>
        new SettlementAuthorityConsumer(
          (handler) =>
            new EventConsumer(
              {
                brokers: brokersOf(env),
                clientId: `${env.KAFKA_CLIENT_ID}-settlement-authority`,
                groupId: 'economic-service.settlement-authority',
                topics: MAINTENANCE_TOPICS,
                deadLetterTopic: ECONOMIC_DLQ_TOPIC,
                fromBeginning: true,
              },
              handler,
              {
                log: (m) => logger.info(m),
                warn: (m) => logger.warn(m),
                error: (m, trace) => logger.error({ err: trace }, m),
              },
            ),
          prisma,
          transactions,
        ),
    },

    {
      provide: RewardTriggerConsumer,
      inject: [ENV, LOGGER, PrismaService, RewardService],
      useFactory: (
        env: EconomicEnv,
        logger: Logger,
        prisma: PrismaService,
        rewards: RewardService,
      ) =>
        new RewardTriggerConsumer(
          (handler) =>
            new EventConsumer(
              {
                brokers: brokersOf(env),
                clientId: `${env.KAFKA_CLIENT_ID}-reward-trigger`,
                groupId: 'economic-service.reward-trigger',
                topics: REWARD_TRIGGER_TOPICS,
                deadLetterTopic: ECONOMIC_DLQ_TOPIC,
                fromBeginning: true,
              },
              handler,
              {
                log: (m) => logger.info(m),
                warn: (m) => logger.warn(m),
                error: (m, trace) => logger.error({ err: trace }, m),
              },
            ),
          prisma,
          rewards,
        ),
    },

    {
      provide: OutboxRelay,
      inject: [PrismaOutboxStore, KafkaEventPublisher, ENV, LOGGER],
      useFactory: (
        store: PrismaOutboxStore,
        publisher: KafkaEventPublisher,
        env: EconomicEnv,
        logger: Logger,
      ) =>
        new OutboxRelay({
          store,
          publisher,
          pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
          batchSize: env.OUTBOX_BATCH_SIZE,
          logger,
          onBatchPublished: (count) => outboxPendingTotal.dec({ service: SERVICE_NAME }, count),
        }),
    },

    {
      provide: AUTH_OPTIONS,
      inject: [ENV],
      useFactory: (env: EconomicEnv): AuthGuardOptions => ({
        serviceName: SERVICE_NAME,
        tokenVerifier: new TokenVerifier({
          jwksUri: env.OIDC_JWKS_URI,
          issuer: env.OIDC_ISSUER_URL,
          audience: env.OIDC_AUDIENCE,
        }),
        internalTokens: new InternalTokenService(
          env.INTERNAL_TOKEN_SECRET,
          env.INTERNAL_TOKEN_ISSUER,
          env.INTERNAL_TOKEN_TTL_SECONDS,
        ),
      }),
    },

    // Authenticate, then authorize. Registered globally so an endpoint is
    // closed unless it opts out with @Public (AGENTS.md A-12, S-02). In this
    // service nothing opts out except the probes.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule, OnModuleInit, OnApplicationShutdown {
  private gaugeTimer?: NodeJS.Timeout;

  constructor(
    private readonly relay: OutboxRelay,
    private readonly store: PrismaOutboxStore,
    private readonly ledger: LedgerService,
    private readonly wallets: WalletService,
    private readonly transactions: TransactionRepository,
    private readonly idempotency: IdempotencyStore,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    // Middleware rather than an interceptor: it must wrap the guards too, so
    // the auth guard has a context to record the resolved tenant into.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }

  async onModuleInit(): Promise<void> {
    // The platform's own accounts, before the first request needs one.
    // Creating them lazily inside a money-moving transaction would put an
    // account insert — and a possible unique-constraint race — on the
    // settlement path.
    await this.ledger.ensurePlatformAccounts('IRR');

    this.relay.start();

    const sample = async () => {
      try {
        outboxPendingTotal.set({ service: SERVICE_NAME }, await this.store.pendingCount());
        outboxPendingAgeSeconds.set(
          { service: SERVICE_NAME },
          await this.store.oldestPendingAgeSeconds(),
        );
        // These gauges span tenants by design — they are operational figures
        // no tenant ever sees, and none of them is a sum of money.
        transactionsPendingSettlement.set(
          { service: SERVICE_NAME },
          await this.transactions.countByStatus('PENDING_SETTLEMENT'),
        );
        transactionsDisputed.set(
          { service: SERVICE_NAME },
          await this.transactions.countByStatus('DISPUTED'),
        );
        await this.wallets.sampleGauges();
        await this.idempotency.purgeExpired();
      } catch {
        // Metrics and upkeep must never take the service down.
      }
    };

    this.gaugeTimer = setInterval(() => void sample(), 15_000);
    this.gaugeTimer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    // Let an in-flight batch finish so it is not republished on restart.
    await this.relay.stop();
    if (this.gaugeTimer) clearInterval(this.gaugeTimer);
  }
}

function brokersOf(env: EconomicEnv): string[] {
  return env.KAFKA_BROKERS.split(',').map((broker) => broker.trim());
}
