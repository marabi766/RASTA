import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import {
  UnprocessableEventError,
  type EventConsumer,
  type EventHandler,
  type HandlerOutcome,
} from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import { z } from 'zod';
import { PolicySuspensionService } from '../approval/policy-suspension.service';

/** The consumer group: `<service>.<purpose>` (ADR-061 § 3). */
export const ORGANIZATION_MOVES_CONSUMER = 'construction-service.organization-moves';

/** The one topic it reads. `EventConsumer` also reads its `.retry` twin. */
export const ORGANIZATION_MOVES_TOPICS = ['rasta.organization.v1'] as const;

/** Where a refused event goes: this service's own dead-letter topic. */
export const CONSTRUCTION_DEAD_LETTER_TOPIC = 'rasta.construction.v1.dlq';

export const ORGANIZATION_MOVED = 'ORGANIZATION_MOVED';

/**
 * Only the field this service uses. organization-service owns the full schema
 * and this service does not import it (no cross-service imports); an extra
 * field is not this consumer's business.
 */
const movedPayload = z.object({ organizationId: z.string().min(1) });

export type EventConsumerFactory = (handler: EventHandler) => EventConsumer;

/**
 * Reacts to an organization being moved in the hierarchy (Q-83): asks whether
 * each union-written approval policy in force is still governed by its union,
 * and suspends the ones that are not (`PolicySuspensionService`).
 *
 * ## The payload is a trigger, not the state — on every delivery
 *
 * A hierarchy is state. A delivery from the main topic and one from `.retry`
 * (a replay after a dead-letter, `docs/runbooks/replay-dlq.md`) are handled
 * identically, and neither is applied *as written*: the payload names the
 * organization that moved, and the answer to "is it still beneath the union" is
 * always fetched from organization-service now. A stale, duplicated or
 * out-of-order event therefore cannot suspend a policy whose union governs
 * again, or spare one whose union no longer does — it can only cause a fresh
 * look at the truth. That is also why a forged event is harmless here: it
 * triggers a re-check and decides nothing, so this consumer needs no separate
 * "enabled" gate the way a consumer that writes what an event says does.
 *
 * ## Provenance
 *
 * `EventConsumer` refuses, before any handler, an event on
 * `rasta.organization.v1` whose producer is not organization-service
 * (ADR-061 § 2). Nothing is tenant-scoped by the envelope's tenant here: the
 * policies affected belong to other organizations, so each is handled in the
 * tenant it names.
 *
 * ## Idempotency
 *
 * By the conditional ACTIVE → SUSPENDED write, not by a `processed_event`
 * marker (see `PolicySuspensionService`): redelivery finds nothing in force to
 * suspend and does nothing, and a replay still gets a fresh answer.
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

    const outcome = await this.suspension.reconfirmAll({
      eventId: envelope.eventId,
      movedOrganizationId: payload.data.organizationId,
      correlationId: envelope.correlationId,
      callerService: envelope.producer,
    });
    this.logger.info(
      `${envelope.eventName} ${envelope.eventId}: ${outcome.checked} union-written ` +
        `policies re-confirmed, ${outcome.suspended.length} suspended`,
    );
  }
}
