import { createHash } from 'node:crypto';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createSystemContext, runWithContext } from '@rasta/nest-common';
import type {
  NotificationRepository,
  SendableDelivery,
} from '../notification/notification.repository';
import { LeaseLostError } from '../notification/notification.repository';
import type { EventPublisher } from '../events/publisher';
import { NOTIFICATION_EVENTS } from '../events/published';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import type { ScrubbedLogger } from '../logging/scrub';
import { SERVICE_NAME } from '../config/env';
import { jitteredDelaySeconds } from '../resolution/backoff';
import {
  notificationDeliveriesTotal,
  notificationMailAttemptsTotal,
  notificationMailDeadTotal,
} from '../observability/metrics';
import type { ContextData } from '../rules/context-sanitiser';
import type { MailChannel } from './mail.channel.port';
import { applyQuietHours } from './quiet-hours';
import { renderEmail, EmailRenderError, FALLBACK_LOCALE, type EmailTemplate } from './email-render';
import type { TemplateReader } from './template.reader';

export interface MailWorkerOptions {
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly leaseSeconds: number;
  /** Ceiling on a single backoff wait, in seconds. */
  readonly backoffMaxSeconds: number;
  readonly owner: string;
}

/** Bounded error classes this worker writes. Never a server's own text. */
export const MAIL_ERROR_CLASSES = {
  RENDER_FAILED: 'RENDER_FAILED',
  TEMPLATE_MISSING: 'TEMPLATE_MISSING',
  NO_ADDRESS: 'NO_ADDRESS',
} as const;

/**
 * Sends the email deliveries the dispatch transaction queued (ADR-054 § 7).
 *
 * Separate from the resolution worker on purpose, and not merely for tidiness:
 * resolution talks to identity and dispatch writes rows, while this talks to a
 * mail server — a remote party with its own latency, its own outages and its
 * own opinion about how fast anybody may send. One worker doing both would
 * make a slow provider into a stalled dispatch queue.
 *
 * ## What one tick does, and what it refuses to do
 *
 * It claims due rows with a durable lease (ADR-050), and for each one:
 *
 *   1. **re-checks the quiet window.** The window was already applied when the
 *      row was written; it is checked again because a row can come due early
 *      after a clock shift, and because a person may have set a window since.
 *      A deferral is not an attempt: nothing is recorded against the delivery
 *      but a new due time.
 *   2. **renders from the stored template version**, not from the code
 *      catalogue. The delivery cites `(templateKey, version)`, and rendering
 *      from anything else would make that citation a lie the moment the
 *      catalogue moved on.
 *   3. **sends, then records.** Never the other way round: a row marked sent
 *      before the send is a message this platform claims to have delivered
 *      without evidence. The cost of this order is stated in `claimSendable` —
 *      a crash between the two sends the message twice.
 *
 * ## What is not built here, and is not claimed
 *
 * ADR § 7 also names a per-channel circuit breaker and an outbound rate limit.
 * Neither is in NTF-004's acceptance criteria and neither is built. The
 * deviation is recorded in the implementation plan § 5 rather than implied by
 * a half-written class.
 */
@Injectable()
export class MailWorker implements OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly repository: NotificationRepository,
    private readonly mail: MailChannel,
    private readonly publisher: EventPublisher,
    private readonly readTemplate: TemplateReader,
    private readonly options: MailWorkerOptions,
    private readonly logger: ScrubbedLogger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tickGuarded(), this.options.pollIntervalMs);
    this.timer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // A batch mid-flight finishes. Abandoning it would leave a row `SENDING`
    // with a live lease, which nobody may touch until that lease expires.
    await this.inFlight;
  }

  isRunning(): boolean {
    return this.timer !== undefined && !this.stopped;
  }

  private tickGuarded(): Promise<void> {
    if (this.inFlight || this.stopped) return Promise.resolve();
    const run = this.tick()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.logger.error(`Mail tick failed: ${describe(error)}`);
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    this.inFlight = run;
    return run;
  }

  /** One batch. Exposed so the suites can drive it instead of the timer. */
  async tick(): Promise<number> {
    const claimed = await this.repository.claimSendable(
      this.options.owner,
      this.options.batchSize,
      this.options.leaseSeconds,
    );

    for (const delivery of claimed) {
      await runWithContext(
        createSystemContext({
          correlationId: delivery.correlationId,
          organizationId: delivery.organizationId,
          callerService: SERVICE_NAME,
        }),
        async () => this.sendOne(delivery),
      );
    }

    return claimed.length;
  }

  async sendOne(delivery: SendableDelivery): Promise<void> {
    const now = new Date();

    // 1 — is this person asleep?
    const window = await this.repository.quietWindowFor(delivery.organizationId, delivery.userId);
    const quiet = applyQuietHours(now, delivery.severity, window);
    if (quiet.deferred && quiet.scheduledFor) {
      await this.repository.releaseUntil(delivery, quiet.scheduledFor, quiet.scheduledFor);
      this.logger.info(
        `Delivery ${delivery.id} waits until ${quiet.scheduledFor.toISOString()}: quiet hours`,
      );
      return;
    }

    // 2 — what exactly are we sending?
    let template: EmailTemplate;
    try {
      template = await this.loadTemplate(delivery);
    } catch (error) {
      // No published version under this key and version, in the recipient's
      // locale or the fallback. Permanent: a retry reads the same table.
      this.logger.error(`Delivery ${delivery.id} has no template: ${describe(error)}`);
      await this.fail(delivery, now, MAIL_ERROR_CLASSES.TEMPLATE_MISSING, 'PERMANENT_FAILURE');
      return;
    }

    if (!delivery.email) {
      // Suppressed at dispatch when the snapshot was empty, so reaching here
      // means the snapshot was lost between then and now. Permanent: retrying
      // re-reads the same empty column.
      await this.fail(delivery, now, MAIL_ERROR_CLASSES.NO_ADDRESS, 'PERMANENT_FAILURE');
      return;
    }

    let rendered;
    try {
      rendered = renderEmail(template, (delivery.contextData ?? {}) as ContextData, {
        timezone: delivery.timezone,
        locale: delivery.locale,
      });
    } catch (error) {
      // A template that cannot render will not render on the next attempt
      // either. Permanent, and attributable to the template rather than to the
      // event that produced the intent (ADR-054 § 9).
      this.logger.error(
        `Delivery ${delivery.id} cannot render ${delivery.templateKey}: ${describe(error)}`,
      );
      await this.fail(delivery, now, MAIL_ERROR_CLASSES.RENDER_FAILED, 'PERMANENT_FAILURE');
      return;
    }

    // 3 — send, then record.
    const startedAt = new Date();
    const result = await this.mail.send({
      to: delivery.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    const finishedAt = new Date();

    notificationMailAttemptsTotal.inc({ outcome: result.outcome });

    if (result.outcome === 'SENT') {
      await this.settle(delivery, {
        outcome: 'SUCCESS',
        errorClass: null,
        startedAt,
        finishedAt,
        renderedHash: hashOf(rendered.subject, rendered.text),
        nextAttemptAt: null,
        publish: (tx) =>
          this.publisher.enqueue(tx, {
            eventName: NOTIFICATION_EVENTS.NOTIFICATION_SENT,
            aggregateId: delivery.id,
            organizationId: delivery.organizationId,
            payload: {
              deliveryId: delivery.id,
              intentId: delivery.intentId,
              channel: 'EMAIL',
              templateKey: delivery.templateKey,
              templateVersion: delivery.templateVersion,
              attemptNo: delivery.attemptCount + 1,
              renderedHash: hashOf(rendered.subject, rendered.text),
              organizationId: delivery.organizationId,
              userId: delivery.userId,
              occurredAt: finishedAt.toISOString(),
            },
          }),
      });
      return;
    }

    const isLast = delivery.attemptCount + 1 >= delivery.maxAttempts;
    const terminal = result.outcome === 'PERMANENT_FAILURE' || isLast;
    const nextAttemptAt = terminal
      ? null
      : new Date(
          Date.now() +
            jitteredDelaySeconds(delivery.attemptCount, this.options.backoffMaxSeconds) * 1000,
        );

    await this.settle(delivery, {
      outcome: result.outcome === 'PERMANENT_FAILURE' ? 'PERMANENT_FAILURE' : 'TRANSIENT_FAILURE',
      errorClass: result.failureReason,
      startedAt,
      finishedAt,
      nextAttemptAt,
      // Published once, at the end. A mail server that is briefly away would
      // otherwise fill the audit log with events about a message that arrives
      // five minutes later.
      publish: terminal
        ? (tx) =>
            this.publisher.enqueue(tx, {
              eventName: NOTIFICATION_EVENTS.NOTIFICATION_FAILED,
              aggregateId: delivery.id,
              organizationId: delivery.organizationId,
              payload: {
                deliveryId: delivery.id,
                intentId: delivery.intentId,
                channel: 'EMAIL',
                templateKey: delivery.templateKey,
                attempts: delivery.attemptCount + 1,
                errorClass: result.failureReason,
                finalStatus: result.outcome === 'PERMANENT_FAILURE' ? 'FAILED' : 'DEAD',
                organizationId: delivery.organizationId,
                userId: delivery.userId,
                occurredAt: finishedAt.toISOString(),
              },
            })
        : undefined,
    });
  }

  /**
   * The stored version, turned back into something the renderer accepts.
   *
   * Exact locale, then `fa-IR`, then a permanent failure — never a
   * half-translated message (ADR § 10.4).
   */
  private async loadTemplate(delivery: SendableDelivery): Promise<EmailTemplate> {
    const found = await this.readTemplate(
      delivery.templateKey,
      delivery.templateVersion,
      delivery.locale,
    );
    if (found) return found;

    const fallback = await this.readTemplate(
      delivery.templateKey,
      delivery.templateVersion,
      FALLBACK_LOCALE,
    );
    if (fallback) return fallback;

    throw new EmailRenderError(
      delivery.templateKey,
      'NO_TEMPLATE_FOR_LOCALE',
      `${delivery.locale} and ${FALLBACK_LOCALE} both missing at version ${delivery.templateVersion}`,
    );
  }

  private async fail(
    delivery: SendableDelivery,
    startedAt: Date,
    errorClass: string,
    outcome: 'PERMANENT_FAILURE',
  ): Promise<void> {
    const finishedAt = new Date();
    notificationMailAttemptsTotal.inc({ outcome: 'PERMANENT_FAILURE' });
    await this.settle(delivery, {
      outcome,
      errorClass,
      startedAt,
      finishedAt,
      nextAttemptAt: null,
      publish: (tx) =>
        this.publisher.enqueue(tx, {
          eventName: NOTIFICATION_EVENTS.NOTIFICATION_FAILED,
          aggregateId: delivery.id,
          organizationId: delivery.organizationId,
          payload: {
            deliveryId: delivery.id,
            intentId: delivery.intentId,
            channel: 'EMAIL',
            templateKey: delivery.templateKey,
            attempts: delivery.attemptCount + 1,
            errorClass,
            finalStatus: 'FAILED',
            organizationId: delivery.organizationId,
            userId: delivery.userId,
            occurredAt: finishedAt.toISOString(),
          },
        }),
    });
  }

  private async settle(
    delivery: SendableDelivery,
    input: {
      outcome: 'SUCCESS' | 'TRANSIENT_FAILURE' | 'PERMANENT_FAILURE';
      errorClass: string | null;
      startedAt: Date;
      finishedAt: Date;
      renderedHash?: string;
      nextAttemptAt: Date | null;
      publish?: (tx: ExtendedPrismaClient) => Promise<unknown>;
    },
  ): Promise<void> {
    try {
      const reported = await this.repository.settleAttempt({ delivery, ...input });

      if (reported === 'SENT') {
        notificationDeliveriesTotal.inc({ channel: 'EMAIL', status: 'SENT' });
        this.logger.info(`Delivery ${delivery.id} sent on attempt ${delivery.attemptCount + 1}`);
        return;
      }
      if (reported === 'RETRY') {
        this.logger.warn(
          `Delivery ${delivery.id} attempt ${delivery.attemptCount + 1} failed ` +
            `(${input.errorClass}); retry at ${input.nextAttemptAt?.toISOString() ?? 'unset'}`,
        );
        return;
      }

      notificationDeliveriesTotal.inc({ channel: 'EMAIL', status: reported });
      if (reported === 'DEAD') {
        // The signal an operator is alerted on. A dead delivery is a person
        // who was meant to be told something and was not.
        notificationMailDeadTotal.inc({ error_class: input.errorClass ?? 'UNKNOWN' });
      }
      this.logger.error(
        `Delivery ${delivery.id} is ${reported} after ${delivery.attemptCount + 1} attempts ` +
          `(${input.errorClass})`,
      );
    } catch (error) {
      if (error instanceof LeaseLostError) {
        // Another worker took the row over while this one was talking to the
        // mail server. Its attempt is not recorded, deliberately: an attempt
        // written by a worker that no longer owns the row is a second opinion
        // in an append-only table.
        this.logger.warn(`Delivery ${delivery.id} lease was taken over before its attempt landed`);
        return;
      }
      throw error;
    }
  }
}

/**
 * What was sent, as a fingerprint.
 *
 * The subject and the plain-text body, separated by a byte neither can
 * contain, so a subject ending where a body begins cannot collide with the
 * other way round. The HTML part is not hashed: it is the same content in a
 * wrapper this repository generates, and including it would make the hash
 * change when the stylesheet did.
 */
function hashOf(subject: string, text: string): string {
  return createHash('sha256').update(subject).update(' ').update(text).digest('hex');
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
