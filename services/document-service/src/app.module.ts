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
import {
  outboxAckFencedTotal,
  outboxClaimAttemptsTotal,
  outboxLeaseReclaimedTotal,
  outboxLeasesActive,
  outboxPendingAgeSeconds,
  outboxPendingTotal,
} from '@rasta/observability';
import { PrismaService } from './prisma/prisma.service';
import { PrismaOutboxStore } from './outbox/outbox.store';
import { KafkaEventPublisher } from './outbox/kafka.publisher';
import { EventPublisher } from './events/publisher';
import { DocumentRepository } from './document/document.repository';
import { DocumentService } from './document/document.service';
import { DocumentController } from './document/document.controller';
import { S3ObjectStorage } from './storage/s3.storage';
import { NoOpMalwareScanner } from './scanning/stub.scanner';
import { ClamAvMalwareScanner } from './scanning/clamav/clamav.scanner';
import { ScanRepository } from './scanning/scan.repository';
import { ScanWorker } from './scanning/scan.worker';
import type { MalwareScanner } from './scanning/scanner.port';
import { HealthController, MetricsController } from './health/health.controller';
import { ENV, LOGGER, MALWARE_SCANNER, OBJECT_STORAGE } from './tokens';
import { clamdAddress, loadDocumentEnv, SERVICE_NAME, type DocumentEnv } from './config/env';

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
      /**
       * The scanner (ADR-049, closing Q-18).
       *
       * Q-18 asked which provider, and the answer is self-hosted ClamAV. The
       * port did what it was built for: closing the question was adding a
       * class and choosing it here, with nothing in the domain changing.
       *
       * `disabled` binds the no-op stub, which inspects nothing and records
       * `NOT_SCANNED` — a development setting for working on upload and
       * metadata without a scanner running. It is not a bypass: `NOT_SCANNED`
       * is refused by `canDownload` exactly as it always was, so a deployment
       * configured this way hands back nothing. `documentEnvSchema` refuses it
       * in production regardless, because discovering that from a support
       * ticket is worse than discovering it from a failed boot.
       */
      provide: MALWARE_SCANNER,
      inject: [ENV],
      useFactory: (env: DocumentEnv): MalwareScanner => {
        if (env.DOCUMENT_SCANNER_DRIVER === 'disabled') {
          return new NoOpMalwareScanner();
        }

        return new ClamAvMalwareScanner({
          address: clamdAddress(env),
          timeoutMs: env.DOCUMENT_SCAN_TIMEOUT_MS,
          chunkBytes: env.DOCUMENT_SCAN_CHUNK_BYTES,
          maxBytes: env.DOCUMENT_SCAN_MAX_BYTES,
          signatureMaxAgeSeconds: env.DOCUMENT_SCAN_SIGNATURE_MAX_AGE_HOURS * 3600,
          versionCacheSeconds: env.DOCUMENT_SCAN_VERSION_CACHE_SECONDS,
        });
      },
    },

    ScanRepository,
    ScanWorker,

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
          leaseSeconds: env.OUTBOX_CLAIM_LEASE_SECONDS,
          backoff: {
            baseSeconds: env.OUTBOX_CLAIM_BACKOFF_SECONDS,
            maxSeconds: env.OUTBOX_CLAIM_BACKOFF_MAX_SECONDS,
          },
          shutdownGraceSeconds: env.OUTBOX_SHUTDOWN_GRACE_SECONDS,
          logger,
          // Counters only. Both outbox gauges are sampled from the database
          // below, never maintained by inc/dec — an arithmetic gauge drifts on
          // every restart and every missed error path (ADR-050).
          onFenced: (count) => outboxAckFencedTotal.inc({ service: SERVICE_NAME }, count),
          onReclaimed: (count) => outboxLeaseReclaimedTotal.inc({ service: SERVICE_NAME }, count),
          onClaimAttempt: (count) => outboxClaimAttemptsTotal.inc({ service: SERVICE_NAME }, count),
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
    private readonly scanWorker: ScanWorker,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    // Middleware rather than an interceptor: it must wrap the guards too, so
    // the auth guard has a context to record the resolved tenant into.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }

  onModuleInit(): void {
    this.relay.start();
    // Started here rather than lazily on the first document, so a scanner that
    // is unreachable shows up in the metrics of an idle deployment instead of
    // waiting for a user to upload something to discover it (ADR-049).
    this.scanWorker.start();

    const sample = async () => {
      try {
        outboxPendingTotal.set({ service: SERVICE_NAME }, await this.store.pendingCount());
        outboxLeasesActive.set({ service: SERVICE_NAME }, await this.store.activeLeaseCount());
        outboxPendingAgeSeconds.set(
          { service: SERVICE_NAME },
          await this.store.oldestPendingAgeSeconds(),
        );
      } catch {
        // Upkeep must never take the service down. The relay's own logging
        // covers a persistent database problem.
      }
      // Its own call, and it swallows its own failures: a scanner that is down
      // must not stop the outbox gauges from being reported, which is exactly
      // when somebody is looking at them.
      await this.scanWorker.sampleGauges();
    };

    void sample();
    this.gaugeTimer = setInterval(() => void sample(), 30_000);
    this.gaugeTimer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.gaugeTimer) clearInterval(this.gaugeTimer);
    // The worker first: it releases the claims it has not started, so a rolling
    // deploy does not park those documents until their leases expire.
    await this.scanWorker.stop();
    await this.relay.stop();
  }
}

function brokersOf(env: DocumentEnv): string[] {
  return env.KAFKA_BROKERS.split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);
}
