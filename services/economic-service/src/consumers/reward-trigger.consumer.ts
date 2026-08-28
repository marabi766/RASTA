import { Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { EventEnvelope } from '@rasta/contracts';
import {
  createSystemContext,
  runWithContext,
  runUnscoped,
  type EventConsumer,
  type HandlerOutcome,
} from '@rasta/nest-common';
import { PrismaService } from '../prisma/prisma.service';
import { RewardService } from '../reward/reward.service';
import {
  CONSUMED_EVENTS,
  maintenanceCompletedSchema,
  usageRecordedSchema,
} from '../events/consumed';
import { rewardsSkippedTotal } from '../observability/metrics';
import { SERVICE_NAME } from '../config/env';

/**
 * Turns behaviour into points (docs/10 § 10.8, ADR-033).
 *
 * Two triggers, both with real producers and exact contracts:
 * `USAGE_RECORDED` from fleet-service ("ثبت منظم کارکرد") and
 * `MAINTENANCE_COMPLETED` from maintenance-service ("انجام سرویس در موعد").
 *
 * ## The reward decision is not made here
 *
 * This class extracts the subject, the source reference and the payload, and
 * hands them to `RewardService`. **Which rules apply, how many points, and
 * whether any rial value attaches are all configuration** (ADR-023) — nothing
 * in this file may decide that a usage record is worth ten points, because
 * that number is not the platform's to invent.
 *
 * With no rule configured, nothing is granted and nothing fails. That is the
 * MVP's real state.
 *
 * ## Why a reward needs a person
 *
 * The subject is the envelope's `actor` — the user whose behaviour it was. An
 * event with no user actor grants nothing, counted as
 * `rewards_skipped_total{reason="no_actor"}`. `USAGE_RECORDED` carries a
 * `driverId`, but that is a fleet aggregate id rather than a platform user id,
 * and treating one as the other would credit points to a subject that does not
 * exist in identity-service.
 *
 * ## Idempotency, twice over
 *
 * `processed_event` in the same transaction as the effect handles a replayed
 * envelope. Separately, `(rule_id, source_reference)` is unique on `reward`,
 * so the same usage record cannot earn twice even under a new event id — which
 * is an anti-fraud control as much as an idempotency one (docs/10 § 10.9).
 *
 * ## A grant that fails does not stall the partition
 *
 * A reward is not the reason these events exist. If granting throws — a
 * database blip, a misconfigured rule — the consumer records the event as
 * processed anyway and logs it, rather than retrying forever on a topic whose
 * primary consumers are elsewhere. The alternative is a stuck partition on
 * `rasta.fleet.v1` because a reward rule was wrong, which would be a far worse
 * outcome than a missed point.
 */
export class RewardTriggerConsumer implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RewardTriggerConsumer.name);
  private readonly consumer: EventConsumer;

  static readonly CONSUMER_NAME = 'economic-service.reward-trigger';

  constructor(
    build: (handler: (envelope: EventEnvelope) => Promise<HandlerOutcome>) => EventConsumer,
    private readonly prisma: PrismaService,
    private readonly rewards: RewardService,
  ) {
    this.consumer = build((envelope) => this.handle(envelope));
  }

  async onModuleInit(): Promise<void> {
    await this.consumer.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer.stop();
  }

  async handle(envelope: EventEnvelope): Promise<HandlerOutcome> {
    const trigger = this.extract(envelope);
    if (!trigger) return 'SKIPPED';

    const actor = envelope.actor?.type === 'USER' ? envelope.actor.id : null;
    if (!actor) {
      rewardsSkippedTotal.inc({ service: SERVICE_NAME, reason: 'no_actor' });
      this.logger.debug(
        `${envelope.eventName} ${envelope.eventId} has no user actor; no reward subject`,
      );
      return 'SKIPPED';
    }

    const context = createSystemContext({
      correlationId: envelope.correlationId,
      organizationId: trigger.organizationId,
      userId: actor,
      callerService: SERVICE_NAME,
    });

    return runWithContext(context, async () => {
      const seen = await runUnscoped(
        'the processed-event ledger is platform plumbing with no tenant column',
        () =>
          this.prisma.client.processedEvent.findUnique({
            where: {
              eventId_consumerName: {
                eventId: envelope.eventId,
                consumerName: RewardTriggerConsumer.CONSUMER_NAME,
              },
            },
          }),
      );
      if (seen) {
        this.logger.debug(`Event ${envelope.eventId} already processed; no second grant`);
        return 'SKIPPED';
      }

      try {
        const outcomes = await this.rewards.grantFor({
          organizationId: trigger.organizationId,
          userId: actor,
          triggerEvent: envelope.eventName,
          sourceReference: trigger.sourceReference,
          occurredAt: new Date(envelope.occurredAt),
          payload: trigger.payload,
        });

        const granted = outcomes.filter((outcome) => outcome.kind === 'GRANTED').length;
        if (granted > 0) {
          this.logger.log(
            `Granted ${granted} reward(s) for ${envelope.eventName} ${trigger.sourceReference}`,
          );
        }
      } catch (error) {
        // Deliberately swallowed after being recorded. See the class comment:
        // a reward rule must not stall a partition that fleet-service and
        // maintenance-service's other consumers depend on.
        this.logger.error(
          `Reward evaluation failed for ${envelope.eventName} ${envelope.eventId}`,
          error instanceof Error ? error.stack : String(error),
        );
        rewardsSkippedTotal.inc({ service: SERVICE_NAME, reason: 'evaluation_failed' });
      }

      await runUnscoped(
        'the processed-event ledger is platform plumbing with no tenant column',
        () =>
          this.prisma.client.processedEvent.create({
            data: {
              eventId: envelope.eventId,
              consumerName: RewardTriggerConsumer.CONSUMER_NAME,
            },
          }),
      );

      return undefined;
    });
  }

  /**
   * The subject, the source and the payload for one trigger.
   *
   * `sourceReference` is the aggregate that caused the reward — the usage
   * record, the maintenance request — and it is half of the uniqueness
   * constraint that stops the same fact earning twice. Using the *event* id
   * instead would let a re-emitted event earn again, which is precisely the
   * fraud vector docs/10 § 10.9 names.
   */
  private extract(
    envelope: EventEnvelope,
  ): { organizationId: string; sourceReference: string; payload: Record<string, unknown> } | null {
    switch (envelope.eventName) {
      case CONSUMED_EVENTS.USAGE_RECORDED: {
        const payload = usageRecordedSchema.parse(envelope.payload);
        return {
          organizationId: payload.organizationId,
          sourceReference: payload.usageRecordId,
          payload: payload as Record<string, unknown>,
        };
      }
      case CONSUMED_EVENTS.MAINTENANCE_COMPLETED: {
        const payload = maintenanceCompletedSchema.parse(envelope.payload);
        return {
          organizationId: payload.organizationId,
          sourceReference: payload.requestId,
          payload: payload as Record<string, unknown>,
        };
      }
      default:
        return null;
    }
  }
}
