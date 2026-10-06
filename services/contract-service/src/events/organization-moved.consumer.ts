import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import {
  EventConsumer,
  UnprocessableEventError,
  kafkaConnection,
  type EventHandler,
  type HandlerOutcome,
} from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import { z } from 'zod';
import { CONTRACT_DEAD_LETTER_TOPIC } from '../config/env';
import { PolicySuspensionService } from '../policy/policy-suspension.service';

/** The consumer group: `<service>.<purpose>` (ADR-061 § 3). */
export const ORGANIZATION_MOVES_CONSUMER = 'contract-service.organization-moves';

/** The one topic it reads. `EventConsumer` also reads its `.retry` twin. */
export const ORGANIZATION_MOVES_TOPICS = ['rasta.organization.v1'] as const;

export const ORGANIZATION_MOVED = 'ORGANIZATION_MOVED';

/**
 * Only the field this service uses. organization-service owns the full schema and this service
 * does not import it (no cross-service imports); an extra field is not this consumer's business.
 */
const movedPayload = z.object({
  organizationId: z.string().min(1),
  /**
   * The hierarchy version the move stamped (D-050), what a signature's recorded version is ordered
   * against. Optional only for an event published before it existed; such a move orders nothing,
   * and the signing window alone bounds what is flagged.
   */
  hierarchyVersion: z.number().int().min(1).optional(),
});

export type EventConsumerFactory = (handler: EventHandler) => EventConsumer;

/**
 * The shared `EventConsumer` for this stream — the only subscription there is. It subscribes each
 * declared topic together with its `.retry` twin (D-039), so a replay from the dead-letter topic
 * reaches `handle` like any delivery; there is no subscription of this service's own for it.
 */
export function organizationMovesConsumerFactory(
  connection: ReturnType<typeof kafkaConnection>,
  logger: Pick<Logger, 'info' | 'warn' | 'error'>,
): EventConsumerFactory {
  return (handler) =>
    new EventConsumer(
      {
        ...connection,
        groupId: ORGANIZATION_MOVES_CONSUMER,
        topics: [...ORGANIZATION_MOVES_TOPICS],
        deadLetterTopic: CONTRACT_DEAD_LETTER_TOPIC,
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
 * Reacts to an organization being moved in the hierarchy (Q-83) — construction-service's consumer,
 * for the signing policies of this service: queues the re-confirmation of every union-written
 * policy that could have been stranded (`PolicySuspensionService.enqueueMove`). **Database work
 * only — no network call** — so the Kafka session never waits on organization-service, however
 * many policies there are, and nothing is skipped for lack of time. The sweeper
 * (`PolicyReconciliationSweeper`) asks the hierarchy and suspends.
 *
 * ## The payload is a trigger, not the state — on every delivery
 *
 * A hierarchy is state. A delivery from the main topic and one from `.retry` (a replay after a
 * dead-letter, `docs/runbooks/replay-dlq.md`) are handled identically, and neither is applied *as
 * written*: the payload names the organization that moved, and the answer to "is it still beneath
 * the union" is always fetched from organization-service when the task runs. A stale, duplicated or
 * out-of-order event therefore cannot suspend a policy whose union governs again, or spare one
 * whose union no longer does — it can only cause a fresh look at the truth. That is also why a
 * forged event is harmless here: it queues a re-check and decides nothing, so this consumer needs
 * no separate "enabled" gate the way a consumer that writes what an event says does.
 *
 * ## Provenance
 *
 * `EventConsumer` refuses, before any handler, an event on `rasta.organization.v1` whose producer
 * is not organization-service (ADR-061 § 2). Nothing is tenant-scoped by the envelope's tenant
 * here: the policies affected belong to other organizations, so each is handled in the tenant it
 * names.
 *
 * ## Idempotency
 *
 * A replay, a `.retry` delivery or a second move while a policy's task is still open coalesces into
 * that task (one open task per policy); one after it is done queues a fresh look. No
 * `processed_event` marker, on purpose: it would make a replay after an outage a no-op. What a task
 * finally does is idempotent too — the ACTIVE|PENDING → SUSPENDED write is conditional (see
 * `PolicySuspensionService`).
 */
export class OrganizationMovedConsumer {
  private consumer?: EventConsumer;

  constructor(
    private readonly consumerFactory: EventConsumerFactory,
    private readonly suspension: PolicySuspensionService,
    private readonly logger: Pick<Logger, 'info' | 'warn' | 'debug'>,
  ) {}

  async start(): Promise<void> {
    this.consumer = this.consumerFactory((envelope) => this.handle(envelope));
    await this.consumer.start();
  }

  async stop(): Promise<void> {
    await this.consumer?.stop();
  }

  /** One event. Public so a test can drive it without a broker. */
  async handle(envelope: EventEnvelope): Promise<HandlerOutcome> {
    if (envelope.eventName !== ORGANIZATION_MOVED) return 'SKIPPED';

    const payload = movedPayload.safeParse(envelope.payload);
    if (!payload.success) {
      // A verdict on the event, not a failure to retry: it can never parse.
      throw new UnprocessableEventError(
        DLQ_REASONS.VALIDATION_FAILED,
        `${envelope.eventName} ${envelope.eventId} names no organizationId`,
      );
    }

    const outcome = await this.suspension.enqueueMove({
      eventId: envelope.eventId,
      movedOrganizationId: payload.data.organizationId,
      // The move's own instant — organization-service's, in the transaction that made the move.
      // Only the bound of the signing window now: the instant is taken before the move commits and
      // orders nothing. The version below does (D-050).
      movedAt: new Date(envelope.occurredAt),
      movedVersion: payload.data.hierarchyVersion ?? null,
      correlationId: envelope.correlationId,
    });
    this.logger.info(
      `${envelope.eventName} ${envelope.eventId}: ${outcome.queued} of ${outcome.candidates} ` +
        'union-written policies queued for re-confirmation',
    );
  }
}
