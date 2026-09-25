import { Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import {
  createSystemContext,
  runWithContext,
  runUnscoped,
  UnprocessableEventError,
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
import { rewardsSkippedTotal, sourceVerificationsTotal } from '../observability/metrics';
import { SERVICE_NAME } from '../config/env';
import {
  confirmCompletion,
  confirmUsage,
  rewardSubject,
  type Verdict,
} from '../provenance/confirm';
import type { SourceFacts } from '../provenance/source-facts.client';

/**
 * Turns behaviour into points (docs/10 § 10.8, ADR-033).
 *
 * Two triggers, both with real producers and exact contracts:
 * `USAGE_RECORDED` from fleet-service ("ثبت منظم کارکرد") and
 * `MAINTENANCE_COMPLETED` from maintenance-service ("انجام سرویس در موعد").
 *
 * ## The reward decision is not made here
 *
 * This class establishes the subject, the source reference and the facts, and
 * hands them to `RewardService`. **Which rules apply, how many points, and
 * whether any rial value attaches are all configuration** (ADR-023). Nothing
 * in this file may decide that a usage record is worth ten points, because
 * that number is not the platform's to invent.
 *
 * With no rule configured, nothing is granted and nothing fails. That is the
 * MVP's real state.
 *
 * ## Nothing is taken from the event (ADR-061 § 4)
 *
 * A rule can be monetised, so a reward is money, and the event is only its
 * publisher's claim. The broker does not yet authenticate publishers, so a
 * forged `USAGE_RECORDED` could name any user in `actor` and any organization
 * in the payload. So the event says only *which* record to look at. The
 * record itself is read from the service that owns it, over authenticated REST
 * with the event's organization signed into the token, and:
 *
 *   - **the organization** is the record's own;
 *   - **the subject** is the user the owner recorded as having done it:
 *     `recordedBy` on a usage record, `completedBy` on a maintenance request.
 *     Never `envelope.actor`;
 *   - **the fields a rule's condition reads**, and the instant it is evaluated
 *     at, are the owner's values, under the names the event uses, so existing
 *     rules read the same fields.
 *
 * The owner answering "no such record in that organization", or a record for
 * another asset, or a repair that was never completed, is a refusal:
 * dead-lettered as `SOURCE_UNCONFIRMED`, and nothing granted. An owner that
 * cannot be asked is retried and then dead-lettered as `UPSTREAM_UNAVAILABLE`.
 * A reward is never granted on the event's word alone.
 *
 * `USAGE_RECORDED` carries a `driverId`, but that is a fleet aggregate id, not
 * a platform user id. Crediting it would credit a subject that does not exist
 * in identity-service. And a record written by no user (`SYSTEM`: an import, a
 * job) has nobody to reward: `rewards_skipped_total{reason="no_actor"}`.
 *
 * ## Only when a rule could pay
 *
 * The owner is asked only if an active rule exists for the trigger and the
 * claimed organization. With none, nothing can be granted whatever the fact
 * says, and usage recording, the busiest write path on the platform, costs
 * no round trip. A forged organization gains nothing from this: with no rule,
 * nothing is granted; with one, the owner is asked and refutes it.
 *
 * ## Idempotency, twice over
 *
 * `processed_event` handles a replayed envelope. Separately, `(rule_id,
 * source_reference)` is unique on `reward`, so the same usage record cannot
 * earn twice even under a new event id. That is an anti-fraud control as much
 * as an idempotency one (docs/10 § 10.9).
 *
 * ## A grant that fails does not stall the partition
 *
 * A reward is not the reason these events exist. If *granting* throws (a
 * database blip, a misconfigured rule), the consumer records the event as
 * processed anyway and logs it, rather than retrying forever. That tolerance
 * covers the grant only. Confirming the fact is not a grant, and an
 * unconfirmed fact is never granted.
 */
export class RewardTriggerConsumer implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RewardTriggerConsumer.name);
  private readonly consumer: EventConsumer;

  static readonly CONSUMER_NAME = 'economic-service.reward-trigger';

  constructor(
    build: (handler: (envelope: EventEnvelope) => Promise<HandlerOutcome>) => EventConsumer,
    private readonly prisma: PrismaService,
    private readonly rewards: RewardService,
    private readonly sources: SourceFacts,
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
    const claim = this.extract(envelope);
    if (!claim) return 'SKIPPED';

    const context = createSystemContext({
      correlationId: envelope.correlationId,
      organizationId: claim.organizationId,
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

      if (!(await this.rewards.hasActiveRules(claim.organizationId, envelope.eventName))) {
        rewardsSkippedTotal.inc({ service: SERVICE_NAME, reason: 'no_rule' });
        await this.markProcessed(envelope.eventId);
        return undefined;
      }

      // Throws on an owner that cannot be asked: retried, never granted.
      const fact = await this.confirmedFact(envelope.eventName, claim);

      if (!fact.subject) {
        rewardsSkippedTotal.inc({ service: SERVICE_NAME, reason: 'no_actor' });
        this.logger.debug(
          `${envelope.eventName} ${claim.sourceReference} was recorded by no user; no reward subject`,
        );
        await this.markProcessed(envelope.eventId);
        return 'SKIPPED';
      }

      const subject = fact.subject;
      const grantContext = createSystemContext({
        correlationId: envelope.correlationId,
        organizationId: fact.organizationId,
        userId: subject,
        callerService: SERVICE_NAME,
      });

      try {
        const outcomes = await runWithContext(grantContext, () =>
          this.rewards.grantFor({
            organizationId: fact.organizationId,
            userId: subject,
            triggerEvent: envelope.eventName,
            sourceReference: claim.sourceReference,
            occurredAt: fact.occurredAt,
            payload: fact.payload,
          }),
        );

        const granted = outcomes.filter((outcome) => outcome.kind === 'GRANTED').length;
        if (granted > 0) {
          this.logger.log(
            `Granted ${granted} reward(s) for ${envelope.eventName} ${claim.sourceReference}`,
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

      await this.markProcessed(envelope.eventId);
      return undefined;
    });
  }

  /**
   * The fact as its owner records it, or a refusal that dead-letters the event.
   */
  private async confirmedFact(eventName: string, claim: Claim): Promise<ConfirmedFact> {
    if (eventName === CONSUMED_EVENTS.USAGE_RECORDED) {
      const fact = await this.sources.usageRecord(claim.organizationId, claim.sourceReference);
      const record = this.judge(eventName, claim, fact, confirmUsage(claim, fact));
      return {
        organizationId: record.organizationId,
        subject: rewardSubject(record.recordedBy),
        occurredAt: new Date(record.recordedAt),
        // The event's own field names, so a rule written against the event
        // reads the same fields here.
        payload: {
          usageRecordId: record.id,
          assetId: record.assetId,
          organizationId: record.organizationId,
          driverId: record.driverId,
          assignmentId: record.assignmentId,
          periodStart: record.periodStart,
          periodEnd: record.periodEnd,
          hours: record.hours,
          kilometres: record.kilometres,
          hourMeter: record.hourMeter,
          odometer: record.odometer,
          source: record.source,
        },
      };
    }

    const fact = await this.sources.maintenanceRequest(claim.organizationId, claim.sourceReference);
    const request = this.judge(eventName, claim, fact, confirmCompletion(claim, fact));
    return {
      organizationId: request.organizationId,
      subject: rewardSubject(request.completedBy),
      // The completion the owner recorded. `confirmCompletion` refuses a fact
      // without one, so the fallback is never taken.
      occurredAt: new Date(request.completedAt ?? Number.NaN),
      payload: {
        requestId: request.id,
        assetId: request.assetId,
        organizationId: request.organizationId,
        type: request.type,
        scheduleId: request.scheduleId,
        completedAt: request.completedAt,
        downtimeMinutes: request.downtimeMinutes,
        totalCostMinor: request.totalCostMinor,
        currency: request.currency,
      },
    };
  }

  /** Counts the verdict, dead-letters a refusal, and returns the confirmed fact. */
  private judge<T>(eventName: string, claim: Claim, fact: T | null, verdict: Verdict): T {
    const outcome = verdict.confirmed ? 'confirmed' : verdict.mismatch;
    sourceVerificationsTotal.inc({ service: SERVICE_NAME, consumer: 'reward_trigger', outcome });
    if (!verdict.confirmed || fact === null) {
      throw new UnprocessableEventError(
        DLQ_REASONS.SOURCE_UNCONFIRMED,
        `The owner does not confirm ${eventName} for ${claim.sourceReference}: ${outcome}`,
      );
    }
    return fact;
  }

  private async markProcessed(eventId: string): Promise<void> {
    await runUnscoped('the processed-event ledger is platform plumbing with no tenant column', () =>
      this.prisma.client.processedEvent.create({
        data: { eventId, consumerName: RewardTriggerConsumer.CONSUMER_NAME },
      }),
    );
  }

  /**
   * Which record the event points at: the claim that is checked, and nothing
   * more.
   *
   * `sourceReference` is the aggregate that caused the reward (the usage
   * record, the maintenance request), and it is half of the uniqueness
   * constraint that stops the same fact earning twice. Using the *event* id
   * instead would let a re-emitted event earn again, which is precisely the
   * fraud vector docs/10 § 10.9 names.
   */
  private extract(envelope: EventEnvelope): Claim | null {
    switch (envelope.eventName) {
      case CONSUMED_EVENTS.USAGE_RECORDED: {
        const payload = usageRecordedSchema.parse(envelope.payload);
        return {
          organizationId: payload.organizationId,
          assetId: payload.assetId,
          sourceReference: payload.usageRecordId,
        };
      }
      case CONSUMED_EVENTS.MAINTENANCE_COMPLETED: {
        const payload = maintenanceCompletedSchema.parse(envelope.payload);
        return {
          organizationId: payload.organizationId,
          assetId: payload.assetId,
          sourceReference: payload.requestId,
        };
      }
      default:
        return null;
    }
  }
}

interface Claim {
  organizationId: string;
  assetId: string;
  sourceReference: string;
}

interface ConfirmedFact {
  organizationId: string;
  /** `null` when the owner recorded no user: there is nobody to reward. */
  subject: string | null;
  occurredAt: Date;
  payload: Record<string, unknown>;
}
