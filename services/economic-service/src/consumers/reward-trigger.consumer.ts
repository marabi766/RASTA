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
  confirmTenant,
  confirmUsage,
  rewardSubject,
  type Mismatch,
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
 * ## The owner is asked even when no rule could pay
 *
 * Until PR #110 round 2 the owner was skipped when no rule was active, to
 * spare usage recording, the busiest write path on the platform, a round trip.
 * That was harmless while nothing was written for such a fact. It stopped
 * being harmless once every evaluation, `NO_RULE` included, became a permanent
 * row: a forged event could then plant one for a real fact ahead of the
 * genuine event and suppress its reward, or plant rows for facts that do not
 * exist. So no evaluation row is written from an unconfirmed event, and the
 * extra call is the price.
 *
 * ## The cutover
 *
 * A fact that occurred before `reward_evaluation_cutover` and has no
 * evaluation row may have been consumed before evaluations were recorded,
 * leaving only an event id behind. It is dead-lettered `BACKFILL_REQUIRED`,
 * never evaluated as new: only an authorised backfill may decide it (ADR-061
 * § 4.2).
 *
 * The migration does not set it. The operator records it once every consumer
 * of the old binary has been stopped, so no fact consumed without an
 * evaluation can fall after it, and it can never move backward (a trigger in
 * the database refuses that, and any delete). Until it is recorded this
 * consumer evaluates nothing (docs/runbooks/reward-evaluation-cutover.md).
 *
 * ## Idempotency, three times over
 *
 * `processed_event` handles a replayed envelope. `(rule_id, source_reference)`
 * is unique on `reward`, so one rule cannot pay the same usage record twice.
 * And `reward_source_evaluation` records that a fact has been evaluated at
 * all, paid or not, so the same fact re-emitted under a new event id is never
 * evaluated again, even after a rule that did not exist the first time is
 * activated with a `validFrom` over it (PR #110 review #1). Those are
 * anti-fraud controls as much as idempotency ones (docs/10 § 10.9).
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

    // Before the rule lookup, the owner and any token: the envelope's tenant
    // and the payload's organization are one, or the event is refused
    // (ADR-061 § 5). Every context below is that one tenant.
    const tenancy = confirmTenant(envelope.tenantId, claim.organizationId);
    if (!tenancy.confirmed) this.refuse(envelope.eventName, claim, tenancy.mismatch);

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

      // One evaluation per fact, whatever event id carries it (PR #110 review
      // #1). Only the event that holds an event-origin evaluation may resume
      // it; a backfilled row, or another event's, is final. Checked here to
      // spare the owner a round trip; the claim below is what decides.
      const prior = await this.evaluationOf(envelope.eventName, claim);
      if (prior && !resumes(prior, envelope)) return this.alreadyEvaluated(envelope, claim);

      // The owner first, always — even when no rule could pay (round 2 #4).
      // An evaluation row is permanent: one written from an unverified event
      // would let a forged event suppress a genuine one's reward, and plant
      // rows for facts that do not exist. Throws on a refusal (dead-lettered)
      // and on an owner that cannot be asked (retried, never granted).
      const fact = await this.confirmedFact(envelope.eventName, claim);

      const evaluation = prior ?? (await this.evaluateFirst(envelope, claim, fact));
      if (!evaluation) return this.alreadyEvaluated(envelope, claim);

      if (evaluation.outcome !== 'EVALUATED' || !fact.subject) {
        // A first NO_RULE or NO_SUBJECT evaluation committed together with its
        // processed_event. Reaching here with a prior row means a resumed one,
        // which has nothing left to do but say so.
        if (prior) await this.markProcessed(envelope.eventId);
        return evaluation.outcome === 'NO_SUBJECT' ? 'SKIPPED' : undefined;
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
            // The rules the claim recorded, and no others: a redelivery after
            // a crash decides exactly what the first delivery would have
            // (round 2 #2).
            onlyRuleIds: evaluation.ruleIds,
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
    if (!verdict.confirmed || fact === null) {
      this.refuse(eventName, claim, verdict.confirmed ? 'not_found' : verdict.mismatch);
    }
    sourceVerificationsTotal.inc({
      service: SERVICE_NAME,
      consumer: 'reward_trigger',
      outcome: 'confirmed',
    });
    return fact;
  }

  /** Counts the refusal and dead-letters the event as `SOURCE_UNCONFIRMED`. */
  private refuse(eventName: string, claim: Claim, mismatch: Mismatch): never {
    sourceVerificationsTotal.inc({
      service: SERVICE_NAME,
      consumer: 'reward_trigger',
      outcome: mismatch,
    });
    throw new UnprocessableEventError(
      DLQ_REASONS.SOURCE_UNCONFIRMED,
      `The owner does not confirm ${eventName} for ${claim.sourceReference}: ${mismatch}`,
    );
  }

  private async markProcessed(
    eventId: string,
    client: Pick<PrismaService['client'], 'processedEvent'> = this.prisma.client,
  ): Promise<void> {
    await runUnscoped('the processed-event ledger is platform plumbing with no tenant column', () =>
      client.processedEvent.create({
        data: { eventId, consumerName: RewardTriggerConsumer.CONSUMER_NAME },
      }),
    );
  }

  // --------------------------------------------------------------------------
  // One evaluation per source fact (PR #110 review #1, round 2)
  //
  // `processed_event` stops the same envelope twice, and `(rule_id,
  // source_reference)` stops one rule paying one fact twice. Neither stopped a
  // fact that was consumed while no rule could pay, or before a second rule
  // existed, from being re-emitted under a new event id after a rule was
  // activated with a `validFrom` over the fact: it would then pay. The
  // evaluation row records the first event that decided the fact, whether or
  // not anything was paid, and the rules it found applicable. Only that event,
  // redelivered, may finish it, which is what a crash between the claim and
  // the grants needs — and it finishes it with those rules, not today's.
  // --------------------------------------------------------------------------

  private evaluationOf(triggerEvent: string, claim: Claim) {
    return this.prisma.client.rewardSourceEvaluation.findUnique({
      where: {
        organizationId_triggerEvent_sourceReference: {
          organizationId: claim.organizationId,
          triggerEvent,
          sourceReference: claim.sourceReference,
        },
      },
    });
  }

  /**
   * The first evaluation of a confirmed fact: refused before the cutover,
   * otherwise claimed. Null when another event claimed it first.
   */
  private async evaluateFirst(
    envelope: EventEnvelope,
    claim: Claim,
    fact: ConfirmedFact,
  ): Promise<Evaluation | null> {
    // Round 2 #3. Before the cutover a fact may have been consumed with no
    // rule and left nothing behind but an event id, so "no evaluation row"
    // does not mean "never evaluated". Evaluating it as new is exactly the
    // replay review #1 closed; only an authorised backfill may decide it.
    const cutoverAt = await this.cutoverAt();
    if (fact.occurredAt.getTime() < cutoverAt.getTime()) {
      rewardsSkippedTotal.inc({ service: SERVICE_NAME, reason: 'before_cutover' });
      throw new UnprocessableEventError(
        DLQ_REASONS.BACKFILL_REQUIRED,
        `${envelope.eventName} ${claim.sourceReference} occurred at ` +
          `${fact.occurredAt.toISOString()}, before the reward evaluation cutover ` +
          `${cutoverAt.toISOString()}, and was never evaluated; only an authorised backfill may`,
      );
    }

    const ruleIds = fact.subject
      ? await this.rewards.applicableRuleIds(
          fact.organizationId,
          envelope.eventName,
          fact.occurredAt,
        )
      : [];
    const outcome: EvaluationOutcome = !fact.subject
      ? 'NO_SUBJECT'
      : ruleIds.length === 0
        ? 'NO_RULE'
        : 'EVALUATED';

    if (outcome === 'EVALUATED') {
      // Committed on its own, before any grant: the grants run in their own
      // transactions (RewardService.grantFor), and a crash between them is
      // what the recorded rule ids are for.
      const held = await this.claimEvaluation(
        this.prisma.client,
        envelope,
        claim,
        outcome,
        ruleIds,
      );
      // The holder's outcome and rules, not `ruleIds` (round 3 #3).
      return held?.evaluation ?? null;
    }

    if (outcome === 'NO_SUBJECT') {
      rewardsSkippedTotal.inc({ service: SERVICE_NAME, reason: 'no_actor' });
      this.logger.debug(
        `${envelope.eventName} ${claim.sourceReference} was recorded by no user; no reward subject`,
      );
    } else {
      rewardsSkippedTotal.inc({ service: SERVICE_NAME, reason: 'no_rule' });
    }

    // Nothing to grant: the claim and processed_event commit together.
    // Recorded even though nothing could pay: a rule activated later, even
    // one backdated over this fact, must not pay it when the same fact is
    // re-emitted under a new event id. That is a retroactive grant, and one
    // belongs to an authorised backfill, not to a replay.
    return this.prisma.transaction(async (tx) => {
      const held = await this.claimEvaluation(tx, envelope, claim, outcome, []);
      if (!held) return null;
      // Only the delivery that wrote the row marks the event: a concurrent
      // delivery of the same event that wrote it first commits its own
      // processed_event, or, if it found rules, still has grants to run.
      if (held.inserted) await this.markProcessed(envelope.eventId, tx);
      return held.evaluation;
    });
  }

  /**
   * The fact's evaluation as the database holds it, when this event holds it;
   * null when another event or a backfill does.
   *
   * Always the persisted row, never the caller's own lookup (round 3 #3): two
   * deliveries of the same event can each find the fact unevaluated, compute
   * their rules at different instants, and both reach the insert. The one
   * that loses must decide with the winner's rules, or a rule activated
   * between the two lookups would pay although the durable snapshot does not
   * name it.
   */
  private async claimEvaluation(
    client: Pick<PrismaService['client'], 'rewardSourceEvaluation'>,
    envelope: EventEnvelope,
    claim: Claim,
    outcome: EvaluationOutcome,
    ruleIds: readonly string[],
  ): Promise<{ inserted: boolean; evaluation: Evaluation } | null> {
    // `ON CONFLICT DO NOTHING`: two events for one fact racing here are
    // decided by the primary key, and the loser's transaction survives.
    const { count } = await client.rewardSourceEvaluation.createMany({
      data: [
        {
          organizationId: claim.organizationId,
          triggerEvent: envelope.eventName,
          sourceReference: claim.sourceReference,
          origin: 'EVENT',
          eventId: envelope.eventId,
          outcome,
          ruleIds: [...ruleIds],
        },
      ],
      skipDuplicates: true,
    });
    const holder = await client.rewardSourceEvaluation.findUnique({
      where: {
        organizationId_triggerEvent_sourceReference: {
          organizationId: claim.organizationId,
          triggerEvent: envelope.eventName,
          sourceReference: claim.sourceReference,
        },
      },
    });
    if (holder === null || !resumes(holder, envelope)) return null;
    return {
      inserted: count === 1,
      evaluation: { outcome: holder.outcome, ruleIds: holder.ruleIds },
    };
  }

  /**
   * The platform-wide cutover the operator recorded once the old reward
   * consumers were drained (round 3 #1; docs/runbooks/reward-evaluation-cutover.md).
   * Fails closed while it is missing.
   */
  private async cutoverAt(): Promise<Date> {
    const row = await runUnscoped('the evaluation cutover is one platform-wide row', () =>
      this.prisma.client.rewardEvaluationCutover.findUnique({ where: { singleton: true } }),
    );
    if (!row) {
      // Retried, then dead-lettered: evaluating without a cutover would
      // reopen the replay it exists to close.
      throw new Error('reward_evaluation_cutover has no row; refusing to evaluate reward triggers');
    }
    return row.cutoverAt;
  }

  private async alreadyEvaluated(envelope: EventEnvelope, claim: Claim): Promise<'SKIPPED'> {
    rewardsSkippedTotal.inc({ service: SERVICE_NAME, reason: 'already_evaluated' });
    this.logger.warn(
      `${envelope.eventName} ${envelope.eventId} names ${claim.sourceReference}, which another ` +
        'event or a backfill already evaluated; nothing granted',
    );
    await this.markProcessed(envelope.eventId);
    return 'SKIPPED';
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

/** What the first evaluation of a fact found; kept for the audit trail. */
type EvaluationOutcome = 'NO_RULE' | 'NO_SUBJECT' | 'EVALUATED';

/** What a fact's evaluation decided: its outcome, and the rules that may pay. */
interface Evaluation {
  outcome: string;
  ruleIds: readonly string[];
}

/**
 * Whether this envelope holds the evaluation and may finish it. A backfilled
 * row has no event id, so no envelope ever does (PR #110 round 2 #1).
 */
function resumes(
  evaluation: { origin: string; eventId: string | null },
  envelope: EventEnvelope,
): boolean {
  return evaluation.origin === 'EVENT' && evaluation.eventId === envelope.eventId;
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
