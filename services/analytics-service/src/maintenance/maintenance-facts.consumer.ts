import type { EventEnvelope } from '@rasta/contracts';
import {
  EventConsumer,
  UnprocessableEventError,
  createSystemContext,
  runWithContext,
  type EventHandler,
  type HandlerOutcome,
  type kafkaConnection,
} from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import { ANALYTICS_DEAD_LETTER_TOPIC, SERVICE_NAME } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { MaintenanceFactRepository } from './maintenance-fact.repository';
import {
  MAINTENANCE_COMPLETED,
  MAINTENANCE_FACTS_CONSUMER,
  MAINTENANCE_TOPIC,
  contradictionError,
  contradictions,
  toMaintenanceFact,
} from './maintenance-fact';
import {
  PROJECTION_OUTCOMES,
  factsProjectedTotal,
  type ProjectionOutcome,
} from '../observability/metrics';

export type EventConsumerFactory = (handler: EventHandler) => EventConsumer;

/** The metric label of every event this projection does not read. */
const OTHER_EVENT = 'OTHER';

/**
 * The shared `EventConsumer` for this projection: its own group, the maintenance topic with
 * its `.retry` twin (D-039), this service's dead-letter topic, and the full history the
 * broker still holds (a new read model starts from the beginning, docs/07 § 7.10 — seven
 * days of it, docs/07 § 7.2).
 */
export function maintenanceFactsConsumerFactory(
  connection: ReturnType<typeof kafkaConnection>,
  logger: Pick<Logger, 'info' | 'warn' | 'error'>,
): EventConsumerFactory {
  return (handler) =>
    new EventConsumer(
      {
        ...connection,
        // A constant, never `KAFKA_CONSUMER_GROUP`: this name is also the marker's key.
        groupId: MAINTENANCE_FACTS_CONSUMER,
        topics: [MAINTENANCE_TOPIC],
        deadLetterTopic: ANALYTICS_DEAD_LETTER_TOPIC,
        fromBeginning: true,
      },
      handler,
      {
        log: (m) => logger.info(m),
        warn: (m) => logger.warn(m),
        error: (m, trace) => logger.error({ err: trace }, m),
      },
    );
}

/**
 * Projects `MAINTENANCE_COMPLETED` into `fact_maintenance` (ADR-071 § 2, RUN-001 PR 1).
 *
 * ## Event-driven and nothing else
 *
 * The fact is what the event states. No owner is asked (A-13 is for a financial effect,
 * which a read model never has — ADR-071 § 1), and no other service's database is read.
 *
 * ## Idempotent twice over
 *
 *   1. **The same event again** (at-least-once delivery, a DLQ replay): the marker
 *      `(eventId, analytics-service.maintenance-facts)` is already there — `SKIPPED`.
 *   2. **Another event for the same completion** (a republished event): the fact
 *      `(organization, request)` is already there. The same statement is `SKIPPED` (its
 *      marker is kept, so it is not compared again); a statement that differs in any field
 *      is dead-lettered as `BUSINESS_RULE_VIOLATION` with no marker and nothing written — the
 *      first fact stands and a human decides (a replay of the contradiction stays possible).
 *
 * ## Tenant-safe
 *
 * The tenant is the envelope's (`requireEnvelopeTenant`): no tenant, or a payload organization
 * that is not the envelope's, is `VALIDATION_FAILED` before anything is written. The fact is
 * then written under a system context of that tenant, so the tenant guard scopes the writes.
 */
export class MaintenanceFactsConsumer {
  private consumer?: EventConsumer;

  constructor(
    private readonly createConsumer: EventConsumerFactory,
    private readonly prisma: PrismaService,
    private readonly facts: MaintenanceFactRepository,
    private readonly logger: Pick<Logger, 'info' | 'warn' | 'debug'>,
  ) {}

  async start(): Promise<void> {
    this.consumer = this.createConsumer((envelope) => this.handle(envelope));
    await this.consumer.start();
  }

  /** Stopped in Nest's destroy phase; an event in flight is abandoned uncommitted and redelivered. */
  async stop(): Promise<void> {
    await this.consumer?.stop();
  }

  isRunning(): boolean {
    return this.consumer?.isRunning() ?? false;
  }

  /** One event. Public so a test can drive it without a broker. */
  async handle(envelope: EventEnvelope): Promise<HandlerOutcome> {
    const fact = toMaintenanceFact(envelope);
    if (!fact) {
      // A fixed label, never the event's own name: what arrives on a topic is the publisher's
      // choice, and a label must stay a closed set (docs/13).
      this.count(OTHER_EVENT, PROJECTION_OUTCOMES.SKIPPED);
      return 'SKIPPED';
    }

    // A consumer has no request: the system context carries the envelope's tenant and
    // correlation id, so the guard scopes the writes and the log joins the producer's trace.
    const context = createSystemContext({
      correlationId: envelope.correlationId,
      organizationId: fact.organizationId,
      callerService: SERVICE_NAME,
    });

    return runWithContext(context, async () => {
      try {
        const outcome = await this.prisma.transaction(async (tx) => {
          const result = await this.facts.record(tx, MAINTENANCE_FACTS_CONSUMER, fact);
          if (result.kind !== 'FACT_HELD') return result.kind;
          const differing = contradictions(result.held, fact);
          // Thrown inside the transaction: its rollback takes this event's marker with it.
          if (differing.length > 0) throw contradictionError(envelope, result.held, differing);
          return 'SAME_FACT' as const;
        });

        if (outcome === 'APPLIED') {
          this.count(MAINTENANCE_COMPLETED, PROJECTION_OUTCOMES.APPLIED);
          this.logger.info(
            `Projected ${MAINTENANCE_COMPLETED} ${envelope.eventId} (request ${fact.requestId})`,
          );
          return undefined;
        }
        this.count(MAINTENANCE_COMPLETED, PROJECTION_OUTCOMES.DUPLICATE);
        this.logger.debug(
          `${MAINTENANCE_COMPLETED} ${envelope.eventId}: request ${fact.requestId} already projected; no second effect`,
        );
        return 'SKIPPED';
      } catch (error) {
        if (error instanceof UnprocessableEventError) {
          this.count(MAINTENANCE_COMPLETED, PROJECTION_OUTCOMES.CONFLICT);
          this.logger.warn(error.message);
        }
        throw error;
      }
    });
  }

  private count(event: string, outcome: ProjectionOutcome): void {
    factsProjectedTotal.inc({ consumer: MAINTENANCE_FACTS_CONSUMER, event, outcome });
  }
}
