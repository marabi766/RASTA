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
import { EventPublisher } from './events/publisher';
import { DocumentRepository } from './document/document.repository';
import { DocumentService } from './document/document.service';
import { DocumentController } from './document/document.controller';
import { S3ObjectStorage } from './storage/s3.storage';
import { NoOpMalwareScanner } from './scanning/stub.scanner';
import { HealthController, MetricsController } from './health/health.controller';
import { ENV, LOGGER, MALWARE_SCANNER, OBJECT_STORAGE } from './tokens';
import { loadDocumentEnv, SERVICE_NAME, type DocumentEnv } from './config/env';

/**
 * document-service wiring.
 *
 * ## Two boundaries are bound behind symbols, and both are deliberate
 *
 * `OBJECT_STORAGE` and `MALWARE_SCANNER` are the only two things this service
 * talks to that it does not own. Binding them by symbol rather than by class
 * is what makes ADR-014's "swapping MinIO for S3 is a configuration change"
 * and Q-18's "the stub is replaceable" true in the code rather than in a
 * comment — and it is what lets a test substitute the external system without
 * substituting any of the domain.
 *
 * ## No Kafka consumer is registered, and that is a decision
 *
 * This service consumes nothing. `docs/04` lists no consumed events for it,
 * and none of the services that will reference documents — asset, contract,
 * construction, supplier — publishes anything this one needs to react to: they
 * hold a `documentId` and ask for it when they need it. There is therefore no
 * `processed_event` table either, because an idempotency ledger with no
 * consumer to serve is scaffolding that looks like work (ADR-032).
 */
@Module({
  controllers: [DocumentController, HealthController, MetricsController],
  providers: [
    { provide: ENV, useFactory: () => loadDocumentEnv() },

    {
      provide: LOGGER,
      inject: [ENV],
      useFactory: (env: DocumentEnv): Logger => {
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
      useFactory: (env: DocumentEnv) => new PrismaService(env.DATABASE_URL),
    },

    {
      provide: KafkaEventPublisher,
      inject: [ENV],
      useFactory: (env: DocumentEnv) =>
        new KafkaEventPublisher({
          brokers: brokersOf(env),
          clientId: env.KAFKA_CLIENT_ID,
        }),
    },

    {
      provide: OBJECT_STORAGE,
      inject: [ENV],
      useFactory: (env: DocumentEnv) =>
        new S3ObjectStorage({
          endpoint: env.S3_ENDPOINT,
          region: env.S3_REGION,
          accessKeyId: env.S3_ACCESS_KEY,
          secretAccessKey: env.S3_SECRET_KEY,
          bucket: env.S3_BUCKET_DOCUMENTS,
          forcePathStyle: env.S3_FORCE_PATH_STYLE,
        }),
    },

    {
      // The MVP stub (Q-18). It inspects nothing and records `NOT_SCANNED`,
      // which is the honest verdict for a scanner that does not exist yet.
      // Replacing it with a real engine is this one line.
      provide: MALWARE_SCANNER,
      useClass: NoOpMalwareScanner,
    },

    PrismaOutboxStore,
    EventPublisher,
    DocumentRepository,
    DocumentService,

    {
      provide: InternalTokenService,
      inject: [ENV],
      useFactory: (env: DocumentEnv) =>
        new InternalTokenService(
          env.INTERNAL_TOKEN_SECRET,
          env.INTERNAL_TOKEN_ISSUER,
          env.INTERNAL_TOKEN_TTL_SECONDS,
        ),
    },

    {
      provide: OutboxRelay,
      inject: [PrismaOutboxStore, KafkaEventPublisher, ENV, LOGGER],
      useFactory: (
        store: PrismaOutboxStore,
        publisher: KafkaEventPublisher,
        env: DocumentEnv,
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
      inject: [ENV, InternalTokenService],
      useFactory: (env: DocumentEnv, internalTokens: InternalTokenService): AuthGuardOptions => ({
        serviceName: SERVICE_NAME,
        tokenVerifier: new TokenVerifier({
          jwksUri: env.OIDC_JWKS_URI,
          issuer: env.OIDC_ISSUER_URL,
          audience: env.OIDC_AUDIENCE,
        }),
        internalTokens,
      }),
    },

    // Authenticate, then authorize. Registered globally so an endpoint is
    // closed unless it opts out with @Public (AGENTS.md A-12).
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
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    // Middleware rather than an interceptor: it must wrap the guards too, so
    // the auth guard has a context to record the resolved tenant into.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }

  onModuleInit(): void {
    this.relay.start();

    const sample = async () => {
      try {
        outboxPendingTotal.set({ service: SERVICE_NAME }, await this.store.pendingCount());
        outboxPendingAgeSeconds.set(
          { service: SERVICE_NAME },
          await this.store.oldestPendingAgeSeconds(),
        );
      } catch {
        // Upkeep must never take the service down. The relay's own logging
        // covers a persistent database problem.
      }
    };

    void sample();
    this.gaugeTimer = setInterval(() => void sample(), 30_000);
    this.gaugeTimer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.gaugeTimer) clearInterval(this.gaugeTimer);
    await this.relay.stop();
  }
}

function brokersOf(env: DocumentEnv): string[] {
  return env.KAFKA_BROKERS.split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);
}
