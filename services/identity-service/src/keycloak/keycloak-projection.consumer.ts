import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import type { EventEnvelope } from '@rasta/contracts';
import type { EventConsumer, EventHandler, HandlerOutcome } from '@rasta/nest-common';
import { IDENTITY_EVENTS } from '../identity/events';
import { KeycloakProjector } from './keycloak.projector';

/**
 * The durable half of the Keycloak projection (ADR-060 § 5).
 *
 * Every membership change projects the user straight after it commits, but
 * that write can fail after the change is already durable. The change also
 * enqueued one of these events in the same transaction, so consuming them and
 * projecting the named user again closes the gap: the projection lands once
 * Keycloak is reachable, however long the outage was.
 *
 * **Idempotent by construction.** The projector rebuilds all four attributes
 * from the database every time, so a redelivery, a replay, or an event
 * arriving after a later change all write the current truth — never the state
 * the event describes. That is also why there is no `processed_event` ledger
 * here: there is nothing to deduplicate.
 */
export const REPROJECTED_EVENTS = [
  IDENTITY_EVENTS.USER_ACTIVATED,
  IDENTITY_EVENTS.MEMBERSHIP_CREATED,
  IDENTITY_EVENTS.ROLE_ASSIGNED,
  IDENTITY_EVENTS.ROLE_REVOKED,
  IDENTITY_EVENTS.MEMBERSHIP_REVOKED,
  IDENTITY_EVENTS.MEMBERSHIP_EXPIRED,
] as readonly string[];

/** Every one of the events above names the user it changed. */
const namesUser = z.object({ userId: z.string().min(1) });

export type EventConsumerFactory = (handler: EventHandler) => EventConsumer;

@Injectable()
export class KeycloakProjectionConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KeycloakProjectionConsumer.name);
  private consumer?: EventConsumer;

  constructor(
    /** Null when Keycloak sync is off: there is nothing to project into. */
    private readonly consumerFactory: EventConsumerFactory | null,
    private readonly projector: KeycloakProjector,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.consumerFactory) {
      this.logger.warn('Keycloak re-projection consumer disabled — Keycloak sync is off');
      return;
    }
    this.consumer = this.consumerFactory((envelope) => this.handle(envelope));
    await this.consumer.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer?.stop();
  }

  /**
   * Projects the user an event names.
   *
   * A projection that fails throws, so the consumer retries it and, past its
   * limit, dead-letters it where an operator sees it — the reconcile command is
   * the sweep for anything that ends up there.
   */
  async handle(envelope: EventEnvelope): Promise<HandlerOutcome> {
    if (!REPROJECTED_EVENTS.includes(envelope.eventName)) return 'SKIPPED';

    const parsed = namesUser.safeParse(envelope.payload);
    if (!parsed.success) {
      // The producer is this service, and publish-time validation requires the
      // field; a payload without it is a defect a retry cannot fix.
      this.logger.warn(`${envelope.eventName} ${envelope.eventId} names no user; not projected`);
      return 'SKIPPED';
    }

    await this.projector.project(parsed.data.userId, 'event');
  }
}
