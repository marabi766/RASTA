import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { EventEnvelope } from '@rasta/contracts';
import type { EventConsumer, EventDelivery, HandlerOutcome } from '@rasta/nest-common';
// Type-only: this provider is built by an explicit `useFactory` in
// `app.module.ts`, so no constructor parameter doubles as an injection token.
import type { NotificationRepository } from '../notification/notification.repository';
import type { ScrubbedLogger } from '../logging/scrub';
import { decideIntake, PoisonEventError, type IntakeDecision } from './intake';
import {
  notificationContextKeysDroppedTotal,
  notificationDedupedTotal,
  notificationDiscardedTotal,
  notificationIntentsTotal,
  notificationPoisonEventsTotal,
  DISCARD_REASONS,
} from '../observability/metrics';

/** Builds the platform consumer this dispatcher runs on. */
export type ConsumerFactory = (
  handler: (envelope: EventEnvelope, delivery: EventDelivery) => Promise<HandlerOutcome>,
) => EventConsumer;

/**
 * The `notification-service.dispatcher` group: envelope in, intent out.
 *
 * ## The consumer's job ends at the commit
 *
 * Recipient resolution is a REST call to another service, and it fails on
 * its own schedule. Doing it here would block the partition on identity's
 * availability — every event behind this one waits, lag grows, and the
 * retry ladder of the shared consumer dead-letters a perfectly good event
 * because somebody else was slow. So the consumer writes the intent
 * `PENDING` and stops; `ResolutionWorker` does the rest on its own clock
 * (ADR-054 § 1, § 9 invariant 1).
 *
 * ## What throws and what does not
 *
 *   IGNORED     an event name no rule claims — returns `SKIPPED`, writes
 *               nothing, and is not counted as anything.
 *   POISON      thrown. The shared consumer retries three times and then
 *               dead-letters, which for a deterministic refusal is 1.5 s of
 *               wasted patience and the correct destination.
 *   database    thrown, so nothing is marked processed — the retry is real.
 */
@Injectable()
export class DispatcherConsumer implements OnModuleDestroy {
  private consumer?: EventConsumer;

  constructor(
    private readonly createConsumer: ConsumerFactory,
    private readonly repository: NotificationRepository,
    private readonly dedupeRetentionDays: number,
    private readonly logger: ScrubbedLogger,
  ) {}

  async start(): Promise<void> {
    this.consumer = this.createConsumer((envelope, delivery) => this.handle(envelope, delivery));
    await this.consumer.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer?.stop();
  }

  /** For the readiness probe. Delegated to the consumer's own flag, which is set only after `run()`. */
  isRunning(): boolean {
    return this.consumer?.isRunning() ?? false;
  }

  async handle(envelope: EventEnvelope, delivery: EventDelivery): Promise<HandlerOutcome> {
    let decision: IntakeDecision;
    try {
      decision = decideIntake(envelope, delivery);
    } catch (error) {
      if (error instanceof PoisonEventError) {
        notificationPoisonEventsTotal.inc({ reason: error.reason });
        // Identifiers and the reason only; the payload is what was refused.
        this.logger.error(
          `Refusing ${envelope.eventName} ${envelope.eventId} from ${delivery.topic}: ${error.message}`,
        );
      }
      throw error;
    }

    if (decision.kind === 'IGNORED') return 'SKIPPED';

    const { intent, rule } = decision;
    if (intent.droppedContextKeys.length > 0) {
      notificationContextKeysDroppedTotal.inc(
        { rule_key: rule.ruleKey },
        intent.droppedContextKeys.length,
      );
    }

    const outcome = await this.repository.ingest(intent, this.dedupeRetentionDays);

    switch (outcome.kind) {
      case 'CREATED':
        notificationIntentsTotal.inc({ event_name: envelope.eventName, rule_key: rule.ruleKey });
        this.logger.info(
          `Intent ${intent.id} for ${envelope.eventName} ${envelope.eventId} (${rule.ruleKey}) is pending resolution`,
        );
        return undefined;
      case 'DEDUPED':
        notificationDedupedTotal.inc({ rule_key: rule.ruleKey });
        this.logger.debug(
          `${envelope.eventName} ${envelope.eventId} repeats a fact already notified (${rule.ruleKey}, seen ${outcome.seenCount}x)`,
        );
        return 'SKIPPED';
      case 'DISCARDED_STALE':
        notificationDiscardedTotal.inc({ reason: DISCARD_REASONS.STALE_STREAM_SEQ });
        this.logger.warn(
          `${envelope.eventName} ${envelope.eventId} is older than an intent already recorded for its subject; discarded`,
        );
        return 'SKIPPED';
      case 'DUPLICATE_EVENT':
        this.logger.debug(`${envelope.eventName} ${envelope.eventId} was already processed`);
        return 'SKIPPED';
    }
  }
}
