import {
  Inject,
  Module,
  type MiddlewareConsumer,
  type NestModule,
  type OnModuleInit,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { hostname } from 'node:os';
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
import { HealthController } from './health/health.controller';
import { NotificationController } from './api/notification.controller';
import { NotificationApiService } from './api/notification.service';
import { PreferencesController } from './preferences/preferences.controller';
import { PreferencesRepository } from './preferences/preferences.repository';
import { PreferencesService } from './preferences/preferences.service';
import { InAppRepository } from './api/in-app.repository';
import { EventPublisher } from './events/publisher';
import { KafkaEventPublisher } from './outbox/kafka.publisher';
import { PrismaOutboxStore } from './outbox/outbox.store';
import { PrismaService } from './prisma/prisma.service';
import { NotificationRepository } from './notification/notification.repository';
import { DispatcherConsumer } from './intake/dispatcher.consumer';
import { ResolutionWorker } from './resolution/resolution.worker';
import { IdentityHttpRecipientAdapter } from './recipients/identity-http.adapter';
import { CachedRecipientPort } from './recipients/cached-recipient.port';
import { RECIPIENT_PORT, type RecipientPort } from './recipients/recipient.port';
import { SUBSCRIBED_TOPICS } from './rules/rules';
import { withAddressScrubbing, type ScrubbedLogger } from './logging/scrub';
import { ENV, LOGGER, MAIL_CHANNEL, SCRUBBED_LOGGER } from './tokens';
import type { MailChannel } from './channels/mail.channel.port';
import { SmtpMailChannel } from './channels/smtp.mail.channel';
import { MailWorker } from './channels/mail.worker';
import { templateReader } from './channels/template.reader';
import { seedEmailTemplates } from './channels/template.seeder';
import {
  brokersOf,
  DISPATCHER_CONSUMER_GROUP,
  loadNotificationEnv,
  NOTIFICATION_DLQ_TOPIC,
  SERVICE_NAME,
  type NotificationEnv,
} from './config/env';

/**
 * notification-service wiring — NTF-001 and NTF-002, the in-app half of ADR-054.
 *
 * ## What is here
 *
 * One consumer group over the two source topics that carry the three
 * supported events, a repository whose two transactions are the whole
 * idempotency story, a resolution worker that calls identity-service on its
 * own clock, the intake/dedupe metrics, and — NTF-002 — the read API over a
 * person's own in-app rows behind the global guards.
 *
 * ## The guards are global, and the health probes are the only exception
 *
 * NTF-002 brings the read API, and with it `AuthGuard` then `RolesGuard`, in
 * that order: authenticate, then authorize. Registered globally so an endpoint
 * is closed unless it says otherwise (AGENTS.md S-02), which is why the two
 * probes carry `@Public` with a stated reason and nothing else does. No route
 * here carries `@AllowService`: a service has no inbox. `InternalTokenService`
 * therefore serves two directions — it mints the `SERVICE` token
 * identity-service verifies, and it lets `AuthGuard` recognise (and refuse) a
 * service token on the inbox.
 *
 * ## The outbox, and why it arrived before the email channel
 *
 * NTF-002's audit events needed it: reading and dismissing a notification are
 * state changes, `AGENTS.md` S-06 requires an audit record for each, and
 * `audit-service` reads nothing but the event log. `ADR-054 § 3` recorded that
 * absence as a deviation from a binding rule rather than a scope decision, so
 * the outbox came with those three events instead of waiting for NTF-004, which
 * will reuse it for `NOTIFICATION_SENT` / `NOTIFICATION_FAILED`.
 *
 * ## `allowAutoTopicCreation: false`, and why a missing topic must be fatal
 *
 * The platform `EventConsumer` hard-codes it. Subscribing to a topic that does
 * not exist therefore fails at startup, which is the only outcome that cannot
 * be mistaken for working.
 */
@Module({
  controllers: [HealthController, NotificationController, PreferencesController],
  providers: [
    { provide: ENV, useFactory: (): NotificationEnv => loadNotificationEnv() },

    {
      provide: LOGGER,
      inject: [ENV],
      useFactory: (env: NotificationEnv): Logger => {
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
    { provide: EXCEPTION_FILTER_LOGGER, inject: [LOGGER], useFactory: (l: Logger): Logger => l },

    // Every message this service composes passes through the address scrubber
    // (ADR-054 § 10, R-5) before it reaches pino.
    {
      provide: SCRUBBED_LOGGER,
      inject: [LOGGER],
      useFactory: (logger: Logger): ScrubbedLogger =>
        withAddressScrubbing({
          info: (message) => logger.info(message),
          warn: (message) => logger.warn(message),
          error: (message) => logger.error(message),
          debug: (message) => logger.debug(message),
        }),
    },

    {
      provide: PrismaService,
      inject: [ENV],
      useFactory: (env: NotificationEnv): PrismaService => new PrismaService(env.DATABASE_URL),
    },

    NotificationRepository,
    EventPublisher,
    InAppRepository,
    NotificationApiService,
    PreferencesRepository,
    PreferencesService,

    /**
     * The mail channel behind its port (ADR-054 § 6, `docs/24` Q-37).
     *
     * `NOTIFICATION_MAIL_ADAPTER` accepts `smtp` alone and refuses boot on
     * anything else, so this factory has one branch today and that enum is
     * where a second one would start.
     *
     * **`deliversToRealRecipients` is a constant `false`, not configuration.**
     * A flag that may hold only one value is a control claiming an effect it
     * does not have — the argument of Q-07, which this service has already
     * applied twice. Making it true is a code change, in review, on the day
     * Q-37 is answered and a provider and sender identity actually exist.
     * Until then nothing here may point at a human.
     */
    {
      provide: MAIL_CHANNEL,
      inject: [ENV],
      useFactory: (env: NotificationEnv): MailChannel =>
        new SmtpMailChannel({
          host: env.NOTIFICATION_SMTP_HOST,
          port: env.NOTIFICATION_SMTP_PORT,
          secure: env.NOTIFICATION_SMTP_SECURE,
          user: env.NOTIFICATION_SMTP_USER || null,
          password: env.NOTIFICATION_SMTP_PASSWORD || null,
          fromAddress: env.NOTIFICATION_MAIL_FROM_ADDRESS,
          fromName: env.NOTIFICATION_MAIL_FROM_NAME,
          timeoutMs: env.NOTIFICATION_SMTP_TIMEOUT_MS,
          deliversToRealRecipients: false,
        }),
    },

    // The outbox, added with NTF-002's audit events. This service consumed for
    // its whole life and produced nothing, so none of this existed until the
    // in-app transitions had to be announced (ADR-054 § 3, AGENTS.md S-06).
    PrismaOutboxStore,
    {
      provide: KafkaEventPublisher,
      inject: [ENV],
      useFactory: (env: NotificationEnv): KafkaEventPublisher =>
        new KafkaEventPublisher({
          brokers: brokersOf(env),
          clientId: `${env.KAFKA_CLIENT_ID}-outbox`,
        }),
    },
    {
      provide: OutboxRelay,
      inject: [PrismaOutboxStore, KafkaEventPublisher, ENV, LOGGER],
      useFactory: (
        store: PrismaOutboxStore,
        publisher: KafkaEventPublisher,
        env: NotificationEnv,
        logger: Logger,
      ): OutboxRelay =>
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
        }),
    },

    {
      provide: InternalTokenService,
      inject: [ENV],
      useFactory: (env: NotificationEnv): InternalTokenService =>
        new InternalTokenService(
          env.INTERNAL_TOKEN_SECRET,
          env.INTERNAL_TOKEN_ISSUER,
          env.INTERNAL_TOKEN_TTL_SECONDS,
        ),
    },

    {
      provide: AUTH_OPTIONS,
      inject: [ENV, InternalTokenService],
      useFactory: (
        env: NotificationEnv,
        internalTokens: InternalTokenService,
      ): AuthGuardOptions => ({
        serviceName: SERVICE_NAME,
        tokenVerifier: new TokenVerifier({
          jwksUri: env.OIDC_JWKS_URI,
          issuer: env.OIDC_ISSUER_URL,
          audience: env.OIDC_AUDIENCE,
        }),
        internalTokens,
      }),
    },

    {
      provide: RECIPIENT_PORT,
      inject: [ENV, InternalTokenService],
      useFactory: (env: NotificationEnv, tokens: InternalTokenService): RecipientPort =>
        new CachedRecipientPort(
          new IdentityHttpRecipientAdapter(
            {
              baseUrl: env.IDENTITY_SERVICE_URL,
              timeoutMs: env.NOTIFICATION_IDENTITY_REQUEST_TIMEOUT_MS,
            },
            tokens,
          ),
          env.NOTIFICATION_RECIPIENT_CACHE_TTL_SECONDS * 1000,
        ),
    },

    {
      provide: DispatcherConsumer,
      inject: [ENV, SCRUBBED_LOGGER, NotificationRepository],
      useFactory: (
        env: NotificationEnv,
        logger: ScrubbedLogger,
        repository: NotificationRepository,
      ): DispatcherConsumer =>
        new DispatcherConsumer(
          (handler) =>
            new EventConsumer(
              {
                brokers: brokersOf(env),
                clientId: env.KAFKA_CLIENT_ID,
                groupId: env.KAFKA_CONSUMER_GROUP ?? DISPATCHER_CONSUMER_GROUP,
                topics: [...SUBSCRIBED_TOPICS],
                // A first deployment must not replay seven days of warnings
                // into people's inboxes. Nothing durable is lost: an active
                // expiry condition is re-published by the next sweep (ADR § 8).
                fromBeginning: false,
                deadLetterTopic: NOTIFICATION_DLQ_TOPIC,
              },
              handler,
              {
                log: (message) => logger.info(message),
                warn: (message) => logger.warn(message),
                error: (message) => logger.error(message),
              },
            ),
          repository,
          env.NOTIFICATION_DEDUPE_RETENTION_DAYS,
          logger,
        ),
    },

    {
      provide: MailWorker,
      inject: [
        ENV,
        SCRUBBED_LOGGER,
        NotificationRepository,
        MAIL_CHANNEL,
        EventPublisher,
        PrismaService,
      ],
      useFactory: (
        env: NotificationEnv,
        logger: ScrubbedLogger,
        repository: NotificationRepository,
        mail: MailChannel,
        publisher: EventPublisher,
        prisma: PrismaService,
      ): MailWorker =>
        new MailWorker(
          repository,
          mail,
          publisher,
          templateReader(prisma),
          {
            pollIntervalMs: env.NOTIFICATION_MAIL_POLL_INTERVAL_MS,
            batchSize: env.NOTIFICATION_MAIL_BATCH_SIZE,
            leaseSeconds: env.NOTIFICATION_MAIL_LEASE_SECONDS,
            backoffMaxSeconds: env.NOTIFICATION_MAIL_BACKOFF_MAX_SECONDS,
            owner: `${SERVICE_NAME}@${hostname()}#${process.pid}`,
          },
          logger,
        ),
    },

    {
      provide: ResolutionWorker,
      inject: [ENV, SCRUBBED_LOGGER, NotificationRepository, RECIPIENT_PORT],
      useFactory: (
        env: NotificationEnv,
        logger: ScrubbedLogger,
        repository: NotificationRepository,
        recipients: RecipientPort,
      ): ResolutionWorker =>
        new ResolutionWorker(
          repository,
          recipients,
          {
            pollIntervalMs: env.NOTIFICATION_RESOLUTION_POLL_INTERVAL_MS,
            batchSize: env.NOTIFICATION_RESOLUTION_BATCH_SIZE,
            leaseSeconds: env.NOTIFICATION_RESOLUTION_LEASE_SECONDS,
            backoffMaxSeconds: env.NOTIFICATION_RESOLUTION_BACKOFF_MAX_SECONDS,
            maxRecipients: env.NOTIFICATION_MAX_RECIPIENTS_PER_INTENT,
            inAppTtlDays: env.NOTIFICATION_IN_APP_TTL_DAYS,
            owner: `${SERVICE_NAME}@${hostname()}#${process.pid}`,
          },
          logger,
        ),
    },

    // Authenticate, then authorize. Global, so an endpoint is closed unless it
    // opts out with `@Public` (AGENTS.md A-12, S-02).
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule, OnModuleInit {
  constructor(
    private readonly dispatcher: DispatcherConsumer,
    private readonly worker: ResolutionWorker,
    private readonly relay: OutboxRelay,
    private readonly mailWorker: MailWorker,
    private readonly prisma: PrismaService,
    @Inject(SCRUBBED_LOGGER) private readonly bootLogger: ScrubbedLogger,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }

  async onModuleInit(): Promise<void> {
    // First, and before anything can try to render: the template catalogue.
    // A published version whose text changed without its number **refuses the
    // boot** rather than sending a message nobody can account for later
    // (`template.seeder.ts`).
    const seeded = await seedEmailTemplates(this.prisma.client);
    this.bootLogger.info(
      `Email templates: ${seeded.published} published, ${seeded.unchanged} already current`,
    );

    await this.dispatcher.start();
    this.worker.start();
    this.mailWorker.start();
    // Started after the consumer and the worker, and deliberately last: the
    // relay only ever drains rows that are already committed, so nothing it
    // publishes depends on either of them being up. If it fails to start, the
    // rows stay in the table and are picked up by the next process — which is
    // the property an outbox exists for.
    this.relay.start();
  }
}
